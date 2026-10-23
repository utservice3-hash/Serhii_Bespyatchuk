import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * #2382 — СТРАТЕГІЧНІ ЗАДАЧІ НА РОУТІ, проти бази з нуля (рішення Романа 23.10.2026: ставить лише власник,
 * без ліміту, підзадачі будь-кому, закриває «Приймає», статуси як у звичайних). Обробники `/tasks`
 * кличуться в процесі з мок-`req`/`res` — без сервера, на проді нічого не створюється.
 * 🧨 Червоніє, якщо: стратегічну зможе поставити не власник (навіть адмін); вона створиться без
 * результату; підзадачу привʼяжуть до звичайної задачі чи сторонній до чужої цілі; підзадача зникне зі
 * списку виконавця (звʼязок через `parent_id`); виконавець закриє стратегічну; видалення цілі
 * потягне за собою підзадачі.
 */
test("#2382 СТРАТЕГІЧНІ НА РОУТІ: лише власник, з результатом; підзадачі видно виконавцю; закриває «Приймає»; ціль не забирає підзадач", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "test";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`INSERT INTO teams (id,name) VALUES (7,'РПК-7')`);
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (40,'Виконавець',7,true),(50,'Сторонній',7,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'owner@uts.ua','x','admin',NULL,NULL,'Власник'),
        (4,'exec@uts.ua','x','manager',40,7,NULL),
        (5,'other@uts.ua','x','manager',50,7,NULL),
        (6,'admin2@uts.ua','x','admin',NULL,NULL,'Інший адмін')`);
    await c.query(`INSERT INTO strategic_creators (user_id) VALUES (1)`);

    const { tasksRouter } = await import("../routes/tasks.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
    const layers = (tasksRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const AUTH: Record<string, unknown> = {
      owner: { userId: 1, role: "admin", roleKey: "admin", managerId: null, teamId: null },
      exec: { userId: 4, role: "manager", roleKey: "manager", managerId: 40, teamId: 7 },
      other: { userId: 5, role: "manager", roleKey: "manager", managerId: 50, teamId: 7 },
      admin2: { userId: 6, role: "admin", roleKey: "admin", managerId: null, teamId: null },
    };
    async function call(method: string, p: string, who: string, o: { params?: Record<string, string>; body?: unknown } = {}) {
      const layer = layers.find((l) => l.route!.path === p && l.route!.methods[method.toLowerCase()]);
      assert.ok(layer, `🔴 роут не знайдено: ${method} ${p}`);
      const handler = layer!.route!.stack[layer!.route!.stack.length - 1].handle as
        (req: unknown, res: unknown, next: (e?: unknown) => void) => Promise<void>;
      let code = 200; let payload: unknown;
      const res = { headersSent: false, status(x: number) { code = x; return res; }, json(b: unknown) { payload = b; return res; },
        send(b: unknown) { payload = b; return res; }, type() { return res; }, setHeader() { /* не потрібно */ } };
      await handler({ auth: AUTH[who], params: o.params ?? {}, body: o.body ?? {}, query: {}, headers: {}, originalUrl: p }, res, (e?: unknown) => { if (e) throw e; });
      return { code, payload: payload as Record<string, unknown> };
    }
    const patch = (who: string, id: number, body: unknown) => call("PATCH", "/:id", who, { params: { id: String(id) }, body });
    type Row = { id: number; taskType: string; goalId: number | null; goalResult: string | null; parentId: number | null };
    const listOf = async (who: string) => ((await call("GET", "/", who)).payload as unknown as { tasks: Row[] }).tasks;

    // ── 1. Хто ставить: лише власник, навіть інший адмін — ні ──
    const goalBody = { title: "Вивести РПК на 3 млн", strategic: true, goalResult: "Гроші РПК за грудень ≥ 3 млн", assigneeId: 40 };
    assert.equal((await call("POST", "/", "admin2", { body: goalBody })).code, 403, "🔴 стратегічну поставив не власник (інший адмін)");
    assert.equal((await call("POST", "/", "exec", { body: goalBody })).code, 403, "🔴 стратегічну поставив менеджер");
    assert.equal((await call("POST", "/", "owner", { body: { ...goalBody, goalResult: "  " } })).code, 400, "🔴 стратегічна створилась без результату");
    assert.equal((await call("POST", "/", "owner", { body: { ...goalBody, assigneeId: undefined, assigneeIds: [40, 50] } })).code, 400,
      "🔴 стратегічна з кількома відповідальними");
    const made = await call("POST", "/", "owner", { body: goalBody });
    assert.equal(made.code, 201, `власник не може поставити стратегічну: ${JSON.stringify(made.payload)}`);
    const goal = (made.payload as unknown as { id: number }).id;
    const g = (await c.query<{ task_type: string; goal_result: string }>(`SELECT task_type, goal_result FROM tasks WHERE id=$1`, [goal])).rows[0];
    assert.deepEqual(g, { task_type: "strategic", goal_result: "Гроші РПК за грудень ≥ 3 млн" });
    assert.equal((await call("POST", "/", "owner", { body: { title: "x", goalResult: "y" } })).code, 400, "🔴 результат у звичайної задачі");

    // ── 2. Підзадачі: будь-кому; додає учасник цілі; лише до стратегічної ──
    const sub = await call("POST", "/", "owner", { body: { title: "Обдзвонити замовклих", goalId: goal, assigneeId: 50 } });
    assert.equal(sub.code, 201, `підзадача не створилась: ${JSON.stringify(sub.payload)}`);
    const subId = (sub.payload as unknown as { id: number }).id;
    assert.equal((await call("POST", "/", "other", { body: { title: "чужа", goalId: goal } })).code, 403,
      "🔴 сторонній (не учасник цілі) додав до неї підзадачу");
    const plain = (await call("POST", "/", "owner", { body: { title: "Звичайна", assigneeId: 40 } })).payload as unknown as { id: number };
    assert.equal((await call("POST", "/", "owner", { body: { title: "z", goalId: plain.id } })).code, 400, "🔴 підзадачу привʼязано до звичайної задачі");
    assert.equal((await patch("owner", goal, { goalId: goal })).code, 400, "🔴 стратегічна стала підзадачею");

    // ── 3. Підзадачу видно виконавцю — звʼязок НЕ через parent_id ──
    const mine = (await listOf("other")).find((r) => r.id === subId);
    assert.ok(mine, "🔴 підзадачі немає у списку її виконавця");
    assert.equal(mine!.goalId, goal, "🔴 у видачі немає goalId");
    assert.equal(mine!.parentId, null, "🔴 підзадача привʼязана через parent_id — список її сховає");
    assert.equal((await listOf("owner")).find((r) => r.id === goal)!.goalResult, "Гроші РПК за грудень ≥ 3 млн");

    // ── 4. Закриває «Приймає» (власник), виконавець — до затвердження ──
    assert.equal((await patch("exec", goal, { status: "in_progress" })).code, 204);
    assert.equal((await patch("exec", goal, { status: "done" })).code, 403, "🔴 виконавець закрив стратегічну");
    assert.equal((await patch("exec", goal, { status: "ready_for_approval" })).code, 204, "🔴 виконавець не може здати на затвердження");
    assert.equal((await patch("owner", goal, { status: "done" })).code, 204, "🔴 «Приймає» (власник) не може закрити стратегічну");
    // 🪞 Звичайна задача — виконавець закриває, як і було.
    assert.equal((await patch("exec", plain.id, { status: "done" })).code, 204, "🔴 виняток стратегічних зачепив звичайні задачі");
    assert.equal((await patch("owner", plain.id, { goalResult: "x" })).code, 400, "🔴 результат записано звичайній задачі");
    assert.equal((await patch("owner", goal, { strategic: false })).code, 400, "🔴 тип змінено PATCH-ем");

    // ── 5. Видалили ціль — підзадача лишилась у виконавця, відкрита, без мітки ──
    await c.query(`DELETE FROM tasks WHERE id=$1`, [goal]);
    const left = (await c.query<{ status: string; goal_id: number | null }>(`SELECT status, goal_id FROM tasks WHERE id=$1`, [subId])).rows[0];
    assert.ok(left, "🔴 видалення цілі забрало підзадачу");
    assert.deepEqual(left, { status: "not_started", goal_id: null });

    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end();
    scratch.dispose();
  }
});
