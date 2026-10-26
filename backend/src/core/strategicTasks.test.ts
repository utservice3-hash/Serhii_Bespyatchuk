import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skipReason } from "../db/scratchDb.js";

/**
 * #2383 — СТРАТЕГІЧНІ ЗАДАЧІ НА РОУТІ, проти бази з нуля (наступник `#2382`: 26.10.2026 Роман — «всі можуть
 * ставити стратегічні задачі будь хто», «виконавець підзадачі бачить ціль — так»). Без ліміту, підзадачі
 * будь-кому, закриває «Приймає», статуси як у звичайних. Обробники `/tasks` кличуться в процесі з мок-
 * `req`/`res` — без сервера, на проді нічого не створюється.
 * 🧨 Червоніє, якщо: менеджер не зможе поставити стратегічну; вона створиться без результату; виконавець
 * підзадачі не побачить цілі (у списку чи в історії) або сторонній побачить; виконавець підзадачі зможе
 * ЗМІНИТИ ціль; підзадачу привʼяжуть до звичайної задачі чи сторонній до чужої цілі; підзадача зникне зі
 * списку виконавця (звʼязок через `parent_id`); виконавець закриє стратегічну; видалення цілі
 * потягне за собою підзадачі.
 */
test("#2383 СТРАТЕГІЧНІ НА РОУТІ: ставить будь-хто, з результатом; виконавець підзадачі бачить ціль, сторонній — ні; закриває «Приймає»; ціль не забирає підзадач", async (t) => {
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
    await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (40,'Виконавець',7,true),(50,'Виконавець підзадачі',7,true),(60,'Сторонній',7,true)`);
    await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id,team_id,full_name) VALUES
        (1,'owner@uts.ua','x','admin',NULL,NULL,'Власник'),
        (4,'exec@uts.ua','x','manager',40,7,NULL),
        (5,'other@uts.ua','x','manager',50,7,NULL),
        (6,'admin2@uts.ua','x','admin',NULL,NULL,'Інший адмін'),
        (8,'stranger@uts.ua','x','manager',60,7,NULL)`);

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
      stranger: { userId: 8, role: "manager", roleKey: "manager", managerId: 60, teamId: 7 },
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

    // ── 1. Хто ставить: будь-хто (26.10.2026) ──
    const goalBody = { title: "Вивести РПК на 3 млн", strategic: true, goalResult: "Гроші РПК за грудень ≥ 3 млн", assigneeId: 40 };
    const byMgr = await call("POST", "/", "exec", { body: { ...goalBody, title: "Ціль менеджера" } });
    assert.equal(byMgr.code, 201, `🔴 менеджер не може поставити стратегічну: ${JSON.stringify(byMgr.payload)}`);
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

    // ── 3b. Виконавець підзадачі бачить ціль (список і історія), сторонній — ні; змінити ціль не може ──
    const seenByContributor = (await listOf("other")).find((r) => r.id === goal);
    assert.ok(seenByContributor, "🔴 виконавець підзадачі не бачить цілі у своєму списку");
    assert.equal((await call("GET", "/:id/history", "other", { params: { id: String(goal) } })).code, 200,
      "🔴 виконавець підзадачі не може відкрити картку цілі (історія)");
    assert.equal((await listOf("stranger")).some((r) => r.id === goal), false, "🔴 сторонній бачить чужу стратегічну ціль");
    assert.notEqual((await call("GET", "/:id/history", "stranger", { params: { id: String(goal) } })).code, 200,
      "🔴 сторонній відкрив картку чужої цілі");
    assert.equal((await patch("other", goal, { title: "перейменував" })).code, 403, "🔴 виконавець підзадачі змінив саму ціль");

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

/**
 * #2384 — ВИКОНАВЕЦЬ ПІДЗАДАЧІ БАЧИТЬ ЦІЛЬ, АЛЕ НЕ ЗМІНЮЄ (Роман 26.10.2026). Чисте правило `canSeeTask` в обидва
 * боки: менеджер чи акаунт із підзадачею — бачить; без підзадачі — ні; змінювати (`canTouchTask`) — ні.
 * 🧨 Червоніє, якщо прибрати `iContribute`, якщо його отримає будь-хто без підзадачі, або якщо він
 * розповзеться на право змінювати.
 */
test("#2384 ВИДИМІСТЬ ЦІЛІ: виконавець підзадачі (менеджер чи акаунт) бачить ціль, без підзадачі — ні, змінювати — ні", async () => {
  const { canSeeTask, canTouchTask } = await import("./taskVisibility.js");
  const goal = { assigneeId: 40, assigneeUserId: null, createdBy: 1, assigneeTeamId: 7, reviewerId: null,
    subtaskManagerIds: [50], subtaskUserIds: [9] };
  const mgr = (managerId: number, userId: number) => ({ role: "manager", userId, managerId, teamId: 9, adminScope: false });
  assert.equal(canSeeTask(mgr(50, 5), goal), true, "🔴 менеджер із підзадачею не бачить цілі");
  assert.equal(canSeeTask(mgr(70, 9), goal), true, "🔴 акаунт із підзадачею не бачить цілі");
  assert.equal(canSeeTask(mgr(60, 8), goal), false, "🔴 сторонній без підзадачі бачить ціль");
  assert.equal(canSeeTask(mgr(50, 5), { ...goal, subtaskManagerIds: [], subtaskUserIds: [] }), false,
    "🔴 ціль видно й без підзадач — правило ширше, ніж рішення");
  assert.equal(canSeeTask({ role: "manager", userId: 99, managerId: -1, teamId: null, adminScope: false },
    { ...goal, subtaskManagerIds: [-1] }), false, "🔴 «нема менеджера» (-1) збіглося з підзадачею");
  assert.equal(canTouchTask(mgr(50, 5), goal), false, "🔴 виконавець підзадачі може змінювати ціль");
});

const focusSpec = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/tasksFocus.ts", import.meta.url).href.replace("/dist/", "/src/"));

/**
 * #2385 — ПРОГРЕС І КОЛІР ЦІЛІ (Роман 23–26.10.2026). Прогрес = виконані / усі видимі підзадачі. Колір:
 * прострочена → `late`; усі підзадачі виконані → `ready` (чекає закриття «Приймає»); прогрес відстає від
 * часу більше ніж на чверть → `warn`; інакше `ok` (зокрема без дедлайну чи без підзадач).
 * 🧨 Червоніє, якщо зарахувати невиконані, якщо прострочена ціль стане зеленою, якщо поріг «відстає»
 * зсунеться (обидва боки межі), або якщо ціль без підзадач лякатиме жовтим.
 */
test("#2385 ЦІЛЬ: прогрес за виконаними підзадачами; колір — прострочено / усе виконано / відстає / вчасно, межа з обох боків", async () => {
  const F = (await import(focusSpec)) as {
    goalProgress: (s: { status: string }[]) => { done: number; total: number };
    goalState: (g: { status: string; deadline?: string | null; start?: string | null }, s: { status: string }[], today: string) => string;
  };
  const subs = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ status: i < done ? "done" : "in_progress" }));
  assert.deepEqual(F.goalProgress(subs(2, 5)), { done: 2, total: 5 }, "🔴 прогрес рахує не виконані");
  assert.deepEqual(F.goalProgress([]), { done: 0, total: 0 });
  const g = { status: "in_progress", start: "2026-10-01", deadline: "2026-10-31" };
  assert.equal(F.goalState(g, subs(1, 4), "2026-11-01"), "late", "🔴 прострочена ціль не червона");
  assert.equal(F.goalState({ ...g, status: "done" }, subs(1, 4), "2026-11-01"), "ready", "🔴 закрита ціль після дедлайну — «прострочена»");
  assert.equal(F.goalState(g, subs(4, 4), "2026-10-20"), "ready", "🔴 усі підзадачі виконані, а ціль не «чекає закриття»");
  // 2026-10-19: минуло 18/30 = 60% строку. 30% виконано — відстає на 30 пунктів (> 25) → warn; 40% — на 20 → ok.
  assert.equal(F.goalState(g, subs(3, 10), "2026-10-19"), "warn", "🔴 відставання на 30 пунктів не помічено");
  assert.equal(F.goalState(g, subs(4, 10), "2026-10-19"), "ok", "🔴 відставання на 20 пунктів уже лякає жовтим");
  assert.equal(F.goalState(g, [], "2026-10-30"), "ok", "🔴 ціль без підзадач лякає жовтим");
  assert.equal(F.goalState({ status: "in_progress", start: "2026-10-01", deadline: null }, subs(0, 3), "2026-12-01"), "ok",
    "🔴 ціль без дедлайну стала простроченою");
});

/**
 * #2386 — ЕКРАН СТРАТЕГІЧНИХ: блок угорі з тієї ж вибірки, що список; активні цілі не в групах і не в
 * лічильниках; прогрес — з УСІХ видимих задач (не з вкладки); «+ Підзадача» відкриває форму з ціллю;
 * у старому дизайні цілі першими; форма шле `strategic`/`goalResult`/`goalId`.
 * 🧨 Червоніє, якщо цілі потраплять у звичайні групи (і в «Активні»), прогрес рахуватиметься з вкладки,
 * «+ Підзадача» відкриє порожню форму, стара таблиця перестане ставити цілі першими, або форма не
 * передасть поля стратегічної.
 */
test("#2386 ЕКРАН СТРАТЕГІЧНИХ: блок угорі з тієї ж вибірки, цілі не в лічильниках, прогрес з усіх задач, «+ Підзадача» з ціллю, стара таблиця — цілі першими", () => {
  const code = (...p: string[]) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", ...p), "utf8")
    .replace(/^\s*\/\/.*$/gm, " ").replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ").replace(/\s+/g, " ");
  const sec = code("pages", "dashboard", "sections", "TasksSection.tsx");
  assert.match(sec, /const goals = base\.filter\(activeGoal\)/, "🔴 цілі беруться не з тієї ж вибірки, що список");
  assert.match(sec, /const rows = base\.filter\(\(t\) => t\.taskType !== "kpi_period" && !activeGoal\(t\)\);/, "🔴 активні цілі потрапили в групи й лічильники");
  assert.match(sec, /subsOf=\{\(goalId\) => tasks\.filter\(\(t\) => t\.goalId === goalId\)\}/, "🔴 прогрес цілі рахується не з усіх видимих задач");
  assert.match(sec, /setTaskForm\(\{ \.\.\.emptyTaskForm, goalId \}\);/, "🔴 «+ Підзадача» відкриває форму без цілі");
  assert.match(sec, /r\.task\.pinned \|\| \(r\.task\.taskType === "strategic" && r\.task\.status !== "done"\)/, "🔴 стара таблиця не ставить цілі першими");
  const view = code("pages", "dashboard", "sections", "TasksFocusView.tsx");
  assert.match(view, /\{goalsOpen && goals\.map\(goalCard\)\}/, "🔴 блок стратегічних не згортається або не малюється");
  assert.match(view, /onClick=\{\(\) => onOpen\(t\.goalId!\)\}/, "🔴 мітка «🎯 → ціль» не відкриває ціль");
  const dash = code("pages", "Dashboard.tsx");
  assert.match(dash, /strategic: taskForm\.strategic, goalResult: taskForm\.goalResult,/, "🔴 форма не передає поля стратегічної");
});
