import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, needsApi, API_BASE } from "../testMode.js";

/**
 * ⚠️ Імпорти ЛІНИВІ: `db/pool.js` → `config.js` кидає на відсутньому DATABASE_URL ще
 * НА ІМПОРТІ, раніше за skip. Виняток — чисті дані з `metricTools.js` (каталог), які
 * config не тягнуть... тягнуть через ядро, тому теж ліниві.
 */
const load = async () => ({
  ...(await import("./metricTools.js")),
  pool: (await import("../db/pool.js")).pool,
  signToken: (await import("../auth/auth.js")).signToken,
  getSettings: (await import("../routes/settings.js")).getSettings,
});

/**
 * ГЕЙТИ БІЛОГО СПИСКУ МЕТРИК — тепер частина ОДНОГО набору (`node --test dist/`),
 * а не окремий скрипт: два паралельні механізми через місяць розходяться, і ніхто
 * не знає, що саме зелене. Логіка та сама, змінилась лише точка входу.
 *
 *   npm test                              # безпека + Σ (потрібен DATABASE_URL)
 *   npm run test:prod                     # + паритет проти живого /api/dashboard/overview
 */

/** Місяць-еталон: завершений, дані не пливуть. */
const YM = process.env.TEST_MONTH ?? "2026-06";
const from = `${YM}-01`;
const to = new Date(Date.UTC(+YM.slice(0, 4), +YM.slice(5, 7), 0)).toISOString().slice(0, 10);
const n = (v: unknown) => Number(v ?? 0);

/**
 * #6 БЕЗПЕКА — ОКРЕМЕ ТВЕРДЖЕННЯ НА КОЖНУ ТАБЛИЦЮ.
 *
 * Раніше це був один assert на всі таблиці одразу: він казав «щось відкрилось», але не
 * ЩО САМЕ, і перше ж порушення ховало решту. Тепер `users`, `one_on_ones`,
 * `bank_accounts`, `tasks` і конфіг перевіряються окремо — падає рівно той рядок,
 * який відкрився, і одразу видно, яку метрику дивитись.
 *
 * Трасуємо САМЕ функцію ядра (`m.run`), а не `getMetric`: інакше в трасу потрапляє
 * `getSettings()` диспетчера і кожна метрика хибно світиться читанням `app_settings`.
 */
async function traceMetrics(): Promise<Map<string, string[]>> {
  const { METRICS, pool, getSettings } = await load();
  const { adSources } = await getSettings();
  const scope = { from, to, managerId: null, teamId: null };
  const orig = pool.query.bind(pool) as typeof pool.query;
  const byMetric = new Map<string, string[]>();
  let seen: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: unknown[]) => {
    const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
    seen.push(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as any)(...args);
  };
  try {
    for (const m of METRICS) {
      seen = [];
      try { await m.run(scope, { from, to }, adSources); } catch { /* SQL до падіння теж рахується */ }
      byMetric.set(`${m.name} (${m.source})`, seen);
    }
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = orig;
  }
  return byMetric;
}

let traced: Map<string, string[]> | null = null;
const getTrace = async () => (traced ??= await traceMetrics());

const offendersFor = (trace: Map<string, string[]>, table: string): string[] => {
  const rx = new RegExp(`(?<![a-z0-9_])${table}(?![a-z0-9_])`, "i");
  return [...trace.entries()].filter(([, sqls]) => sqls.some((s) => rx.test(s))).map(([name]) => name);
};

for (const table of ["users", "access_audit", "bank_accounts", "one_on_ones",
                     "one_on_one_forms", "tracker_devices", "tracker_intervals", "tasks"]) {
  test(`#6 БЕЗПЕКА · «${table}» не читає ЖОДНА метрика`, needsDb(), async () => {
    const trace = await getTrace();
    assert.ok(trace.size > 0, "жодної метрики не протрасовано — тест нічого не довів");
    assert.deepEqual(offendersFor(trace, table), [],
      `🔴 «${table}» читається метриками: ${offendersFor(trace, table).join(", ")}`);
  });
}

test("#6 КОНФІГ: app_settings читає лише диспетчер, не ядро", needsDb(), async () => {
  const trace = await getTrace();
  assert.ok(trace.size > 0, "жодної метрики не протрасовано");
  assert.deepEqual(offendersFor(trace, "app_settings"), [],
    "конфіг має читати диспетчер (getSettings), а не функції ядра");
});

test("#6 ПОКРИТТЯ: протрасовано ВСІ метрики білого списку", needsDb(), async () => {
  const { METRICS } = await load();
  const trace = await getTrace();
  assert.equal(trace.size, METRICS.length,
    `протрасовано ${trace.size} із ${METRICS.length} — решта могла лишитись неперевіреною`);
  const silent = [...trace.entries()].filter(([, sqls]) => sqls.length === 0).map(([n]) => n);
  assert.deepEqual(silent, [], `метрики не зробили ЖОДНОГО запиту — підозра на заглушку: ${silent.join(", ")}`);
});

test("ПАРИТЕТ: get_metric == /api/dashboard/overview, ідентично", needsApi(), async () => {
  const { getMetric, signToken } = await load();
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const res = await fetch(`${API_BASE}/api/dashboard/overview?from=${from}&to=${to}`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, "/overview недоступний — паритет НЕ перевірено");
  const ov = (await res.json()) as Record<string, unknown>;

  const pick = async (metric: string) => {
    const r = await getMetric(metric, { from, to });
    assert.ok(r.ok, `${metric}: ${r.ok ? "" : r.error}`);
    return r.ok ? (r.data as Record<string, unknown>) : {};
  };
  const received = await pick("received_money");
  const success = await pick("success_money");
  const paidOnly = await pick("paid_only_money");
  const expected = await pick("expected_money");

  const pairs: [string, number, number][] = [
    ["received.revenue → closedRevenue", n(received.revenue), n(ov.closedRevenue)],
    ["received.deals → closedDeals", n(received.deals), n(ov.closedDeals)],
    ["success.revenue → successRevenue", n(success.revenue), n(ov.successRevenue)],
    ["success.deals → successDeals", n(success.deals), n(ov.successDeals)],
    ["paidOnly.revenue → paymentRevenue", n(paidOnly.revenue), n(ov.paymentRevenue)],
    ["paidOnly.deals → paymentDeals", n(paidOnly.deals), n(ov.paymentDeals)],
    ["expected.revenue → expectedPayments.revenue", n(expected.revenue), n((ov.expectedPayments as Record<string, unknown>)?.revenue)],
    ["expected.deals → expectedPayments.deals", n(expected.deals), n((ov.expectedPayments as Record<string, unknown>)?.deals)],
    ["success.deals → dispatchedCount", n(success.deals), n(ov.dispatchedCount)],
  ];
  for (const [label, mine, theirs] of pairs) {
    assert.equal(mine, theirs, `${label}: інструмент ${mine} ≠ дашборд ${theirs}`);
  }
});

test("Σ-ІНВАРІАНТ: Σ(менеджери) == Σ(команди)", needsDb(), async () => {
  const { getMetric } = await load();
  const [tot, byMgr, byTeam] = await Promise.all([
    getMetric("received_money", { from, to }),
    getMetric("received_by_manager", { from, to }),
    getMetric("received_by_team", { from, to }),
  ]);
  assert.ok(tot.ok && byMgr.ok && byTeam.ok, "не вдалось отримати всі три зрізи");
  const sum = (rows: unknown, k: "revenue" | "deals") =>
    (rows as Record<string, unknown>[]).reduce((s, r) => s + n(r[k]), 0);
  const t = (tot as { data: Record<string, unknown> }).data;
  for (const k of ["revenue", "deals"] as const) {
    const m = sum((byMgr as { data: unknown }).data, k);
    const tm = sum((byTeam as { data: unknown }).data, k);
    assert.equal(m, tm, `${k}: Σ(менеджери)=${m} ≠ Σ(команди)=${tm}`);
    // Відділ може бути ≥ розрізів (угоди без відповідального) — це відомо й допустимо,
    // але розбіжність має бути саме в цей бік, не навпаки.
    assert.ok(n(t[k]) >= m, `${k}: відділ ${n(t[k])} менший за Σ розрізів ${m} — так бути не може`);
  }
});

test("КАТАЛОГ: імена унікальні, кожна метрика має джерело й опис", needsDb(), async () => {
  const { METRICS } = await load();
  const names = METRICS.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, "дублікати імен метрик");
  for (const m of METRICS) {
    assert.match(m.source, /^core\.(money|metrics|plans)\./, `${m.name}: source має вказувати на ядро`);
    assert.ok(m.desc.length > 10, `${m.name}: порожній опис`);
  }
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});
