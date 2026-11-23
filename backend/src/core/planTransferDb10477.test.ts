import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { skipReason } from "../db/scratchDb.js";

/**
 * 🔁 ПЕРЕДАЧА ПЛАНУ НА ЖИВОМУ SQL (задача 10477). Чисті правила тримають `#4030`-`#4033`; тут - те, чого вони не бачать:
 * самі запити й транзакція. SQL у шаблонних рядках не типізується, тож без прогону на справжньому Postgres помилка в
 * назві колонки дожила б до першого кліку КВП. Кластер тимчасовий, прод не чіпається.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const FC = 8921932, NOV = "2026-11-01", OCT = "2026-10-01";
let dispose: (() => Promise<void>) | null = null;
after(async () => { if (dispose) await dispose(); });

test("#4036 ЖИВИЙ SQL: план того, хто пішов, - у пулі; передача не міняє Σ планів; зняття зменшує її рівно на пул; жовтень ділиться як раніше", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  // ⚠️ `DATABASE_URL` - ДО імпорту ядра: `db/pool` читає конфіг на імпорті.
  process.env.DATABASE_URL = scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  dispose = async () => { const { pool } = await import("../db/pool.js"); await pool.end(); await c.end(); scratch.dispose(); };
  await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
  await c.query(`INSERT INTO teams (id, name) VALUES (13, 'Команда'), (6, 'Інша') ON CONFLICT (id) DO NOTHING`);
  await c.query(`INSERT INTO managers (id, name, team_id, is_active) VALUES
    (1, 'Перший', 13, true), (2, 'Друга', 13, true), (3, 'Третій', 13, true),
    (8, 'Чужий', 6, true), (9, 'Пішов', 13, false), (10, 'Пішла', 13, false) ON CONFLICT (id) DO NOTHING`);
  for (const mo of [NOV, OCT]) {
    await c.query(`INSERT INTO plans (manager_id, metric, plan_date, planned_value) VALUES
      (1, 'payment_amount', $1, 40000), (2, 'payment_amount', $1, 55000), (3, 'payment_amount', $1, 30000),
      (8, 'payment_amount', $1, 70000), (9, 'payment_amount', $1, 30000), (10, 'payment_amount', $1, 20000)`, [mo]);
  }
  // Факт того, хто пішов, за листопад - 8 400: потрібен для режиму «тільки залишок».
  await c.query(`INSERT INTO pipeline_stage_map (pipeline_id, status_id, funnel_stage) VALUES (${FC}, 142, 'paid') ON CONFLICT DO NOTHING`);
  await c.query(
    `INSERT INTO deals (kommo_id, name, manager_id, pipeline_id, status_id, price, created_at_kommo, closed_at_kommo)
     VALUES (501, 'угода 501', 9, ${FC}, 142, 8400, '2026-11-07 12:00+02', '2026-11-10 12:00+02')`);
  const [plans, tr, sql] = await Promise.all([import("./plans.js"), import("./planTransfer.js"), import("./teamAt.js")]);
  await sql.refreshTeamMoves(c);
  const sumNov = async () => Number((await c.query<{ s: string }>(
    `SELECT COALESCE(SUM(planned_value),0) s FROM plans p JOIN managers m ON m.id = p.manager_id WHERE p.plan_date = $1 AND m.team_id = 13`, [NOV])).rows[0].s);
  const planOf = async (id: number) => Number((await c.query<{ v: string }>(
    `SELECT planned_value v FROM plans WHERE manager_id = $1 AND plan_date = $2 AND metric = 'payment_amount'`, [id, NOV])).rows[0].v);
  const onScreens = async () => { const mp = await plans.managerPlan({ month: NOV, teamId: 13 });
    return mp.rows.reduce((a, r) => a + r.plan, 0) + (mp.orphanPlanByTeam.get(13) ?? 0); };

  // ── Межа з обох боків: жовтень ділить план тих, хто пішов, порівну; листопад кладе його в пул ──
  const oct = await plans.managerPlan({ month: OCT, teamId: 13 });
  assert.deepEqual(oct.rows.map((r) => r.sharePlan), [16667, 16667, 16666], "🔴 жовтень перестав ділити план тих, хто пішов, - закритий місяць зрушив заднім числом");
  assert.equal(oct.orphanPlanByTeam.size, 0);
  const nov = await plans.managerPlan({ month: NOV, teamId: 13 });
  assert.deepEqual(nov.rows.map((r) => [r.managerId, r.plan, r.sharePlan]), [[1, 40000, 0], [2, 55000, 0], [3, 30000, 0]], "🔴 у листопаді чужий план знову ліг на менеджерів");
  assert.equal(nov.orphanPlanByTeam.get(13), 50000, "🔴 план тих, хто пішов, не в пулі");
  assert.equal(await onScreens(), 175000);
  assert.equal(await sumNov(), 175000);
  assert.equal(Math.round(await plans.proratedGonePlan(NOV, "2026-11-30", 13)), 50000, "🔴 Звіт за повний місяць не додає пул до плану команди");
  assert.equal(Math.round(await plans.proratedGonePlan(OCT, "2026-10-31", 13)), 0, "🔴 у жовтні зʼявився пул, хоча план уже лежить на менеджерах");

  let gone = await tr.gonePlans(NOV, 13);
  assert.deepEqual(gone.map((g) => [g.managerId, g.plan, g.kept, g.pool, g.fact]), [[10, 20000, 0, 20000, 0], [9, 30000, 0, 30000, 8400]]);
  assert.deepEqual(await tr.gonePlans(NOV, 6), [], "у команді без тих, хто пішов, пул порожній");

  // ── Відмови не лишають сліду ──
  const bad = await tr.applyTransfer({ month: NOV, fromManagerId: 9, mode: "all", userId: null, parts: [{ managerId: 1, amount: 10000 }, { managerId: 2, amount: 10000 }] });
  assert.ok(!bad.ok && bad.status === 400, "🔴 передача 20 000 з 30 000 пройшла");
  const alien = await tr.applyTransfer({ month: NOV, fromManagerId: 9, mode: "all", userId: null, parts: [{ managerId: 8, amount: 30000 }] });
  assert.ok(!alien.ok && alien.status === 400, "🔴 план пішов менеджеру іншої команди");
  const active = await tr.applyTransfer({ month: NOV, fromManagerId: 1, mode: "all", userId: null, parts: [{ managerId: 2, amount: 40000 }] });
  assert.ok(!active.ok && active.status === 404, "🔴 план активного менеджера можна «передати» як план того, хто пішов");
  assert.equal(await sumNov(), 175000);
  assert.equal((await c.query(`SELECT 1 FROM plan_transfers`)).rows.length, 0, "🔴 відмова лишила запис у журналі");

  // ── «Тільки залишок»: 30 000 − 8 400 факту = 21 600 передаємо, 8 400 лишається за тим, хто пішов ──
  const ok = await tr.applyTransfer({ month: NOV, fromManagerId: 9, mode: "rest", userId: null, parts: [{ managerId: 1, amount: 11600 }, { managerId: 3, amount: 10000 }] });
  assert.deepEqual(ok, { ok: true, amount: 21600, keep: 8400 });
  assert.deepEqual([await planOf(1), await planOf(2), await planOf(3), await planOf(9)], [51600, 55000, 40000, 8400]);
  assert.equal(await sumNov(), 175000, "🔴 передача змінила суму планів команди");
  assert.equal(await onScreens(), 175000, "🔴 після передачі план команди на екранах зрушив");
  gone = await tr.gonePlans(NOV, 13);
  assert.deepEqual(gone.find((g) => g.managerId === 9), { managerId: 9, name: "Пішов", teamId: 13, plan: 8400, kept: 8400, pool: 0, fact: 8400 },
    "🔴 лишене за людиною досі висить як «не розподілено»");
  const again = await tr.applyTransfer({ month: NOV, fromManagerId: 9, mode: "all", userId: null, parts: [{ managerId: 2, amount: 8400 }] });
  assert.ok(!again.ok, "🔴 той самий план передано вдруге");

  // ── Зняти: єдина дія, що зменшує план команди, і рівно на пул ──
  assert.deepEqual(await tr.dropPool({ month: NOV, fromManagerId: 10, userId: null }), { ok: true, amount: 20000, keep: 0 });
  assert.equal(await sumNov(), 155000);
  assert.equal(await onScreens(), 155000);
  const twice = await tr.dropPool({ month: NOV, fromManagerId: 10, userId: null });
  assert.ok(!twice.ok && twice.status === 404, "🔴 той самий план знято вдруге");
  assert.deepEqual((await tr.unassignedByTeam(NOV, 13)).size, 0, "пул порожній: усе передано або знято");

  // ── Журнал: одна дія - один запис, скільки б отримувачів не було ──
  const hist = await tr.transferHistory(NOV, 13);
  assert.deepEqual(hist.map((e) => [e.kind, e.fromManagerId, e.amount, e.keep, e.parts.map((p) => [p.managerId, p.amount])]).sort(),
    [["drop", 10, 20000, 0, []], ["transfer", 9, 21600, 8400, [[1, 11600], [3, 10000]]]].sort());
  assert.deepEqual(await tr.transferHistory(NOV, 6), [], "🔴 журнал однієї команди видно в іншій");
});
