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

test("БЕЗПЕКА: жодна функція ядра не читає персональні дані", needsDb(), async () => {
  const { METRICS, FORBIDDEN_TABLES, CONFIG_TABLES, pool, getSettings } = await load();
  // Трасуємо САМЕ функцію ядра, а не getMetric: інакше в трасу потрапляє
  // getSettings() диспетчера і кожна метрика хибно світиться читанням app_settings.
  const { adSources } = await getSettings();
  const scope = { from, to, managerId: null, teamId: null };
  const orig = pool.query.bind(pool) as typeof pool.query;
  const rxBad = new RegExp(`(?<![a-z0-9_])(${FORBIDDEN_TABLES.join("|")})(?![a-z0-9_])`, "i");
  const rxCfg = new RegExp(`(?<![a-z0-9_])(${CONFIG_TABLES.join("|")})(?![a-z0-9_])`, "i");
  let seen: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: unknown[]) => {
    const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
    seen.push(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as any)(...args);
  };
  const bad: string[] = [], cfg: string[] = [];
  try {
    for (const m of METRICS) {
      seen = [];
      try { await m.run(scope, { from, to }, adSources); } catch { /* SQL до падіння все одно перевірено */ }
      const hitBad = seen.map((s) => s.match(rxBad)?.[1]).find(Boolean);
      if (hitBad) bad.push(`${m.name} (${m.source}) → ${hitBad}`);
      const hitCfg = seen.map((s) => s.match(rxCfg)?.[1]).find(Boolean);
      if (hitCfg) cfg.push(`${m.name} → ${hitCfg}`);
    }
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = orig;
  }
  assert.deepEqual(bad, [], `метрика читає персональні дані: ${bad.join(" · ")}`);
  assert.deepEqual(cfg, [], `конфіг має читати лише диспетчер, а читає ядро: ${cfg.join(" · ")}`);
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
