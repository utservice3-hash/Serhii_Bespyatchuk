import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { partsStateOf } from "./finance.js";

/**
 * 🧾 Розпис плану (задача 7832; TOP Weekly 02.11.2026 — Сергій: «суму плану розбити на частини, з чого вона
 * складається»; демо затвердила Тетяна 04.11). Гейти `#3620`–`#3620d`.
 */
const SRC = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");

/**
 * #3620 — СТАН РОЗПИСУ. Сервер (`partsStateOf`) і вікно на фронті (`partsDraftSum`, транспільоване) кажуть те саме по обидва
 * боки межі: Σ = плану — «ok»; менше — «under» з залишком; більше — «over»; розпису немає — «none»; розпис без плану —
 * «noplan». Копійки не дають хибного «не розписано»; вікно читає «1 234,5»; рядок із текстом без суми й сума ≤ 0 — «bad».
 * 🧨 Червоніє, якщо «ok» стане «≥ плану», копійки зламають рівність чи фронт і сервер розійдуться.
 */
test("#3620 СТАН РОЗПИСУ: ok / under / over / none / noplan однаково на сервері й у вікні, копійки й «1 234,5»", async () => {
  const p = (...a: number[]) => a.map((amount) => ({ amount, note: "" }));
  assert.deepEqual(partsStateOf(17000, p(11000, 1000, 5000)), { sum: 17000, left: 0, state: "ok" }, "🔴 Σ = плану — не «ok»");
  assert.deepEqual(partsStateOf(17000, p(11000, 1000, 3500)), { sum: 15500, left: 1500, state: "under" }, "🔴 менше плану");
  assert.deepEqual(partsStateOf(17000, p(11000, 7000)), { sum: 18000, left: -1000, state: "over" }, "🔴 більше плану стало «ok»");
  assert.deepEqual(partsStateOf(17000, []), { sum: 0, left: 17000, state: "none" }, "🔴 без розпису");
  assert.deepEqual(partsStateOf(null, p(500)), { sum: 500, left: null, state: "noplan" }, "🔴 розпис без плану");
  assert.equal(partsStateOf(0.3, p(0.1, 0.2)).state, "ok", "🔴 копійки (0,1 + 0,2) дали хибне «не розписано»");
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE("pages/dashboard/sections/financeView.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { partsDraftSum } = await import(`data:text/javascript,${encodeURIComponent(js)}`) as {
    partsDraftSum: (plan: number | null, rows: { amount: string; note: string }[]) => { sum: number; left: number | null; bad: number[]; state: string };
  };
  const d = (...a: string[]) => a.map((amount) => ({ amount, note: "" }));
  const cases: [number | null, string[], number[]][] = [[17000, ["11000", "1000", "5000"], [11000, 1000, 5000]], [17000, ["11000", "1000", "3500"], [11000, 1000, 3500]],
    [17000, ["11000", "7000"], [11000, 7000]], [17000, [""], []], [null, ["500"], [500]], [0.3, ["0,1", "0,2"], [0.1, 0.2]]];
  for (const [plan, draft, nums] of cases) {
    const f = partsDraftSum(plan, d(...draft)), b = partsStateOf(plan, p(...nums));
    assert.deepEqual([f.sum, f.left, f.state], [b.sum, b.left, b.state], `🔴 вікно й сервер розійшлись: план ${plan}, рядки ${draft.join(" + ")}`);
  }
  assert.equal(partsDraftSum(1234.5, d("1 234,5")).state, "ok", "🔴 «1 234,5» не прочитано");
  assert.deepEqual(partsDraftSum(1000, [{ amount: "", note: "сервер" }, { amount: "0", note: "" }, { amount: "-5", note: "" }, { amount: "abc", note: "" }, { amount: "", note: "" }]).bad,
    [0, 1, 2, 3], "🔴 рядок без суми / нуль / мінус / не число не позначено, або порожній рядок позначено");
  assert.match(FE("pages/dashboard/sections/FinanceSection.tsx"), /const st = partsDraftSum\(it\.plan, rows\);/, "🔴 вікно не користується partsDraftSum — гейт перевіряє не те, що показується");
});

async function scratchDb(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  // Кластер уже піднятий: впало підключення чи схема — зупинити його, інакше тест висить вічно на живому postgres.
  try {
    await c.connect();
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  } catch (e) { await c.end().catch(() => undefined); scratch.dispose(); throw e; }
  return { c, dispose: async () => { await c.end(); scratch.dispose(); } };
}
async function seed(c: import("pg").Client): Promise<{ ai: number; srv: number; gone: number }> {
  await c.query(`INSERT INTO users (id, email, password_hash, role, is_active, full_name) VALUES (8, 'fin@test', 'x', 'admin', true, 'Тетяна'), (50, 'adm@test', 'x', 'admin', true, 'Роман')`);
  const r = (await c.query(`INSERT INTO fin_resps (name) VALUES ('Фін. менеджер') RETURNING id`)).rows[0].id;
  const g = (await c.query(`INSERT INTO fin_groups (resp_id, name) VALUES ($1, 'Програми і підписки') RETURNING id`, [r])).rows[0].id;
  const ai = (await c.query(`INSERT INTO fin_items (group_id, name) VALUES ($1, 'AI витрати') RETURNING id`, [g])).rows[0].id;
  const srv = (await c.query(`INSERT INTO fin_items (group_id, name) VALUES ($1, 'Бухгалтерський сервер') RETURNING id`, [g])).rows[0].id;
  const gone = (await c.query(`INSERT INTO fin_items (group_id, name, deleted_at) VALUES ($1, 'Стара стаття', now()) RETURNING id`, [g])).rows[0].id;
  await c.query(`INSERT INTO fin_values (item_id, month, plan) VALUES ($1, '2026-11-01', 17000), ($2, '2026-11-01', 6000), ($1, '2026-10-01', 16000)`, [ai, srv]);
  return { ai, srv, gone };
}

/**
 * #3620b — ЖИВИЙ SQL: РОЗПИС ЗБЕРІГАЄТЬСЯ ЦІЛИМ СПИСКОМ І НЕ ЧІПАЄ ПЛАН. Після збереження «План/факт» віддає рядки й стан
 * («under» із залишком, потім «ok»); `fin_values.plan` той самий; повністю порожній рядок відкидається; рядок із текстом без
 * суми чи сума ≤ 0 — 400 і НІЧОГО не записано (старий розпис цілий); те саме вдруге — «змін немає»; порожній список —
 * розпис прибрано; видалена стаття — 404; кожна зміна — у журнал статті. «Взяти з минулого місяця» віддає розпис жовтня.
 * 🧨 Червоніє, якщо розпис змінить план, збереже половину списку при помилці чи журнал промовчить.
 */
test("#3620b ЖИВИЙ SQL: розпис — цілим списком, план той самий, помилка — нічого не записано, журнал є, минулий місяць віддається", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { savePlanParts, prevPlanParts, loadMonth } = await import("./finance.js");
  const db = c as unknown as import("./finance.js").Db;
  const plan = async (id: number) => (await c.query(`SELECT plan::float8 AS p FROM fin_values WHERE item_id = $1 AND month = '2026-11-01'`, [id])).rows[0]?.p;
  const rowOf = async (id: number) => (await loadMonth(db, "2026-11")).tree.flatMap((r) => r.groups.flatMap((g) => g.items)).find((i) => i.id === id)!;
  try {
    const { ai, srv, gone } = await seed(c);
    const r1 = await savePlanParts(db, 8, ai, "2026-11", [{ amount: "11000", note: "Claude — Роман" }, { amount: "", note: "" }, { amount: "1 000", note: " Claude — Сергій " }, { amount: "3500", note: "ElevenLabs" }]);
    assert.deepEqual(r1.parts, [{ amount: 11000, note: "Claude — Роман" }, { amount: 1000, note: "Claude — Сергій" }, { amount: 3500, note: "ElevenLabs" }], "🔴 рядки збережено не так (порожній не відкинуто чи пробіли лишились)");
    let it = await rowOf(ai);
    assert.deepEqual([it.parts.length, it.partsState, it.partsLeft, it.plan], [3, "under", 1500, 17000], "🔴 «План/факт» не віддає розпис чи стан");
    assert.equal(await plan(ai), 17000, "🔴 розпис змінив суму плану");
    await assert.rejects(savePlanParts(db, 8, ai, "2026-11", [{ amount: "16000", note: "усе" }, { amount: "", note: "без суми" }]), (e: any) => e?.status === 400, "🔴 рядок без суми пройшов");
    await assert.rejects(savePlanParts(db, 8, ai, "2026-11", [{ amount: "0", note: "нуль" }]), (e: any) => e?.status === 400, "🔴 нульова сума пройшла");
    assert.equal((await rowOf(ai)).parts.length, 3, "🔴 помилка зберегла половину списку чи стерла старий розпис");
    await savePlanParts(db, 50, ai, "2026-11", [...r1.parts.map((x) => ({ amount: String(x.amount), note: x.note })), { amount: "1500", note: "Google Cloud" }]);
    it = await rowOf(ai);
    assert.deepEqual([it.parts.length, it.partsState, it.partsLeft], [4, "ok", 0], "🔴 повний розпис не став «ok»");
    assert.deepEqual(await savePlanParts(db, 50, ai, "2026-11", it.parts.map((x) => ({ amount: String(x.amount), note: x.note }))).then((x) => x.changed), false, "🔴 той самий розпис — «змінено»");
    await savePlanParts(db, 8, srv, "2026-11", [{ amount: "9000", note: "сервер" }]);
    await savePlanParts(db, 8, srv, "2026-11", []);
    assert.deepEqual([(await rowOf(srv)).parts.length, (await rowOf(srv)).partsState], [0, "none"], "🔴 порожній список не прибрав розпис");
    await assert.rejects(savePlanParts(db, 8, gone, "2026-11", [{ amount: "1", note: "x" }]), (e: any) => e?.status === 404, "🔴 розпис видаленої статті");
    const logs = (await c.query(`SELECT what FROM fin_log WHERE target_id = $1 AND what LIKE 'Розпис плану%' ORDER BY id`, [ai])).rows.map((x) => x.what);
    assert.equal(logs.length, 2, "🔴 журнал: два збереження — не два записи (чи «змін немає» теж записалось)");
    assert.match(logs[0], /^Розпис плану 11\.2026: 3 рядк\. на 15[\s ]500/, "🔴 журнал не каже, скільки й на яку суму");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM fin_log WHERE target_id = $1 AND what LIKE 'Розпис плану 11.2026 прибрано'`, [srv])).rows[0].n, 1, "🔴 прибраний розпис не в журналі");
    await c.query(`INSERT INTO fin_plan_parts (item_id, month, pos, amount, note) VALUES ($1, '2026-10-01', 1, 11000, 'Claude — Роман'), ($1, '2026-10-01', 2, 5000, 'ElevenLabs')`, [ai]);
    assert.deepEqual(await prevPlanParts(db, ai, "2026-11"), { month: "2026-10-01", parts: [{ amount: 11000, note: "Claude — Роман" }, { amount: 5000, note: "ElevenLabs" }] }, "🔴 розпис минулого місяця");
    assert.deepEqual((await prevPlanParts(db, srv, "2026-11")).parts, [], "🔴 чужий розпис підставився");
  } finally { await s.dispose(); }
});

/**
 * #3620c — ЖИВИЙ SQL: ПОГОДЖЕНИЙ МІСЯЦЬ ЗАМИКАЄ Й РОЗПИС. Ядро відповідає 409 і нічого не пише; другий рубіж — тригер:
 * пряма вставка, зміна, видалення й TRUNCATE розпису погодженого місяця падають `fin_plan_locked`, а розпис, зроблений
 * до погодження, лишається цілим. Сусідній непогоджений місяць — пишеться.
 * 🧨 Червоніє, якщо розпис затвердженого плану можна змінити роутом чи скриптом.
 */
test("#3620c ЖИВИЙ SQL: погоджений місяць — розпис 409 у ядрі й fin_plan_locked у БД, старий розпис цілий, сусідній місяць пишеться", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { savePlanParts } = await import("./finance.js");
  const db = c as unknown as import("./finance.js").Db;
  try {
    const { ai, srv } = await seed(c);
    await savePlanParts(db, 8, ai, "2026-11", [{ amount: "11000", note: "Claude" }]);
    await c.query(`INSERT INTO fin_plan_approvals (month, approved_by) VALUES ('2026-11-01', 50)`);
    await assert.rejects(savePlanParts(db, 8, ai, "2026-11", [{ amount: "17000", note: "усе" }]), (e: any) => e?.status === 409, "🔴 ядро змінило розпис погодженого місяця");
    await assert.rejects(savePlanParts(db, 8, srv, "2026-11", [{ amount: "6000", note: "сервер" }]), (e: any) => e?.status === 409, "🔴 ядро додало розпис у погоджений місяць");
    const locked = (e: any) => /fin_plan_locked/.test(e?.message ?? "");
    await assert.rejects(c.query(`INSERT INTO fin_plan_parts (item_id, month, pos, amount) VALUES ($1, '2026-11-01', 9, 1)`, [srv]), locked, "🔴 БД: вставка в погоджений місяць");
    await assert.rejects(c.query(`UPDATE fin_plan_parts SET amount = 1 WHERE item_id = $1`, [ai]), locked, "🔴 БД: зміна розпису погодженого місяця");
    await assert.rejects(c.query(`DELETE FROM fin_plan_parts WHERE item_id = $1`, [ai]), locked, "🔴 БД: видалення розпису погодженого місяця");
    await assert.rejects(c.query(`TRUNCATE fin_plan_parts`), (e: any) => /fin_approval_locked/.test(e?.message ?? ""), "🔴 БД: TRUNCATE розпису");
    assert.deepEqual((await c.query(`SELECT amount::float8 AS a, note FROM fin_plan_parts WHERE item_id = $1`, [ai])).rows, [{ a: 11000, note: "Claude" }], "🔴 розпис до погодження змінився");
    assert.equal((await savePlanParts(db, 8, ai, "2026-12", [{ amount: "100", note: "грудень" }])).changed, true, "🔴 непогоджений сусідній місяць не пишеться");
  } finally { await s.dispose(); }
});

/**
 * #3620d — МЕЖА РОЗПИСУ. Запис (`PUT /plan-parts`) — ПЕРШИМ оператором `canEdit` (право `edit_finance`), читання минулого
 * місяця — `onlyFinance`; обидва роути є в матриці доступу (запис — deny-only); вікно на фронті читає лише свої два виклики,
 * а «розписати» показується лише з правом і в непогодженому місяці.
 * 🧨 Червоніє, якщо запис відкриється без права, роут випаде з матриці чи кнопка «розписати» зʼявиться без права.
 */
test("#3620d МЕЖА РОЗПИСУ: запис — canEdit першим, читання — onlyFinance, обидва роути в матриці, «розписати» лише з правом", () => {
  const r = SRC("routes/finance.ts");
  assert.match(r, /financeRouter\.put\("\/plan-parts", async \(req, res\) => \{\s*try \{\s*canEdit\(req\);/, "🔴 запис розпису не починається з canEdit");
  assert.match(r, /financeRouter\.get\("\/plan-parts\/prev", async \(req, res\) => \{\s*try \{ onlyFinance\(req\);/, "🔴 розпис минулого місяця без межі «Фінансів»");
  const m = SRC("auth/accessMatrix.ts");
  assert.match(m, /method: "PUT", path: "\/api\/finance\/plan-parts", cls: "deny-only",\s*allow: \[\], deny: \["hr", "team_lead", "manager"\]/, "🔴 запис розпису не в матриці");
  assert.match(m, /method: "GET", path: "\/api\/finance\/plan-parts\/prev\?itemId=1&m=2026-11", cls: "GET",\s*allow: \["admin", "ceo", "opdir", "kvp", "financier"\]/, "🔴 читання розпису не в матриці");
  const fe = FE("pages/dashboard/sections/FinanceSection.tsx");
  assert.match(fe, /if \(!n\) return canEdit && !locked && it\.plan != null \? <button/, "🔴 «розписати» видно без права чи в погодженому місяці");
  assert.match(fe, /const ro = locked \|\| !canEdit;/, "🔴 вікно розпису редаговане без права чи в погодженому місяці");
});
