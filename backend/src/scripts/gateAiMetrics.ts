import { pool } from "../db/pool.js";
import { signToken } from "../auth/auth.js";
import { METRICS, FORBIDDEN_TABLES, CONFIG_TABLES, getMetric } from "../ai/metricTools.js";
import { getSettings } from "../routes/settings.js";

/**
 * ГЕЙТ БІЛОГО СПИСКУ МЕТРИК AI (READ-ONLY). Запускати НА СЕРВЕРІ:
 *   node dist/scripts/gateAiMetrics.js [YYYY-MM]        # за замовчуванням минулий місяць
 *   API_BASE=http://127.1.9.113:3000 node dist/scripts/gateAiMetrics.js 2026-06
 *
 * Три перевірки, кожна — окремий клас поломки:
 *
 *  1) БЕЗПЕКА. Білий список — це наша межа доступу для `get_metric` (роль
 *     `ai_readonly` захищає лише `query_db`). Тому перехоплюємо ВЕСЬ SQL, який
 *     кожна метрика реально шле в БД, і падаємо, якщо там зʼявиться persona-таблиця
 *     (`users`, `one_on_ones`, `bank_accounts`, `tasks`, …) — хоч прямо, хоч через
 *     JOIN. Перевірка рантаймова саме тому, що JOIN статично не видно.
 *
 *  2) ПАРИТЕТ. `get_metric` і ендпоінт дашборду за той самий період мають дати
 *     ІДЕНТИЧНІ цифри — не «близько». Це не разова звірка: гейт має ганятись і далі,
 *     бо його завдання — ловити МАЙБУТНЄ розповзання ядра й AI (хтось поміняє роут,
 *     хтось — метрику, і AI тихо почне відповідати іншою цифрою).
 *
 *  3) Σ-ІНВАРІАНТ. Σ(менеджери) == Σ(команди) == відділ на виводі інструмента.
 *     Якщо він тримається, розрізи AI можна класти поруч із дашбордними.
 *
 * Жодного write. Exit 1 при будь-якому порушенні.
 */

const ym = process.argv[2] ?? (() => {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
const from = `${ym}-01`;
const to = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3000";

let failed = false;
const fail = (msg: string) => { failed = true; console.log(`  ❌ ${msg}`); };
const ok = (msg: string) => console.log(`  ✅ ${msg}`);

console.log(`ГЕЙТ AI-МЕТРИК · період ${from} … ${to} · API ${API_BASE}`);
console.log(`метрик у білому списку: ${METRICS.length}\n`);

// ──────────────────────────── 1) БЕЗПЕКА ────────────────────────────
/**
 * Перехоплення `pool.query`: збираємо текст КОЖНОГО запиту, який шле метрика.
 * Ловимо заборонену таблицю як ІДЕНТИФІКАТОР (межі слова), щоб `tasks` не збігся
 * з `subtasks`, а `users` — з `users_view`.
 */
async function gateSecurity(): Promise<void> {
  console.log("1) БЕЗПЕКА — жодна функція ядра не читає персональні дані");
  // Трасуємо САМЕ функцію ядра (`def.run`), а не `getMetric`: інакше в трасу
  // потрапляє `getSettings()` самого диспетчера і кожна метрика хибно світиться
  // читанням `app_settings`. Скоуп і adSources готуємо ДО встановлення перехоплювача.
  const { adSources } = await getSettings();
  const scope = { from, to, managerId: null, teamId: null };
  const origQuery = pool.query.bind(pool) as typeof pool.query;
  const rxBad = new RegExp(`(?<![a-z0-9_])(${FORBIDDEN_TABLES.join("|")})(?![a-z0-9_])`, "i");
  const rxCfg = new RegExp(`(?<![a-z0-9_])(${CONFIG_TABLES.join("|")})(?![a-z0-9_])`, "i");
  let seen: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: unknown[]) => {
    const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
    seen.push(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origQuery as any)(...args);
  };
  const offenders: string[] = [], cfg: string[] = [];
  let traced = 0;
  for (const m of METRICS) {
    seen = [];
    try { await m.run(scope, { from, to }, adSources); traced++; }
    catch (e) { console.log(`  ⚠️ ${m.name} кинула помилку (${e instanceof Error ? e.message : e}) — SQL до неї все одно перевірено`); }
    const bad = seen.map((s) => s.match(rxBad)?.[1]).find(Boolean);
    if (bad) offenders.push(`${m.name} (${m.source}) → ${bad}`);
    const c = seen.map((s) => s.match(rxCfg)?.[1]).find(Boolean);
    if (c) cfg.push(`${m.name} → ${c}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = origQuery;
  if (offenders.length) offenders.forEach((o) => fail(`персональна таблиця: ${o}`));
  else ok(`${traced}/${METRICS.length} метрик протрасовано — жодного звернення до ${FORBIDDEN_TABLES.join("/")}`);
  // Конфіг має читати ЛИШЕ диспетчер. Якщо його читає ядро — це не діра, але
  // означає, що трасування безпеки більше не показує чисту межу; хочемо знати.
  if (cfg.length) cfg.forEach((c) => fail(`конфіг читає ЯДРО, а не диспетчер: ${c}`));
  else ok(`конфіг (${CONFIG_TABLES.join("/")}) читає лише диспетчер — межа чиста`);
}

// ──────────────────────────── 2) ПАРИТЕТ ────────────────────────────
interface Pair { metric: string; field: string; pick: (d: unknown) => number; from: (o: Record<string, unknown>) => number }
const n = (v: unknown) => Number(v ?? 0);
const agg = (k: "revenue" | "deals") => (d: unknown) => n((d as Record<string, unknown>)[k]);

const PAIRS: Pair[] = [
  { metric: "received_money",  field: "closedRevenue",   pick: agg("revenue"), from: (o) => n(o.closedRevenue) },
  { metric: "received_money",  field: "closedDeals",     pick: agg("deals"),   from: (o) => n(o.closedDeals) },
  { metric: "success_money",   field: "successRevenue",  pick: agg("revenue"), from: (o) => n(o.successRevenue) },
  { metric: "success_money",   field: "successDeals",    pick: agg("deals"),   from: (o) => n(o.successDeals) },
  { metric: "paid_only_money", field: "paymentRevenue",  pick: agg("revenue"), from: (o) => n(o.paymentRevenue) },
  { metric: "paid_only_money", field: "paymentDeals",    pick: agg("deals"),   from: (o) => n(o.paymentDeals) },
  { metric: "expected_money",  field: "expectedPayments.revenue", pick: agg("revenue"),
    from: (o) => n((o.expectedPayments as Record<string, unknown>)?.revenue) },
  { metric: "expected_money",  field: "expectedPayments.deals",   pick: agg("deals"),
    from: (o) => n((o.expectedPayments as Record<string, unknown>)?.deals) },
  { metric: "awaiting_now_snapshot", field: "awaitingNow.revenue", pick: agg("revenue"),
    from: (o) => n((o.awaitingNow as Record<string, unknown>)?.revenue) },
  { metric: "success_money",   field: "dispatchedCount", pick: agg("deals"),   from: (o) => n(o.dispatchedCount) },
];

async function gateParity(): Promise<void> {
  console.log("\n2) ПАРИТЕТ — get_metric == ендпоінт дашборду (ідентично, не «близько»)");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  let ov: Record<string, unknown>;
  try {
    const res = await fetch(`${API_BASE}/api/dashboard/overview?from=${from}&to=${to}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { fail(`/overview повернув ${res.status} — паритет не перевірено`); return; }
    ov = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    fail(`/overview недоступний (${e instanceof Error ? e.message : e}) — паритет НЕ перевірено`);
    return;
  }
  const cache = new Map<string, unknown>();
  for (const p of PAIRS) {
    if (!cache.has(p.metric)) {
      const r = await getMetric(p.metric, { from, to });
      if (!r.ok) { fail(`${p.metric}: ${r.error}`); continue; }
      cache.set(p.metric, r.data);
    }
    const mine = p.pick(cache.get(p.metric));
    const theirs = p.from(ov);
    if (mine !== theirs) fail(`${p.metric} → ${p.field}: інструмент ${mine} ≠ дашборд ${theirs}`);
    else ok(`${p.metric} → ${p.field}: ${mine}`);
  }
}

// ──────────────────────────── 3) Σ-ІНВАРІАНТ ────────────────────────────
async function gateSigma(): Promise<void> {
  console.log("\n3) Σ-ІНВАРІАНТ — Σ(менеджери) == Σ(команди) == відділ");
  const [tot, byMgr, byTeam] = await Promise.all([
    getMetric("received_money", { from, to }),
    getMetric("received_by_manager", { from, to }),
    getMetric("received_by_team", { from, to }),
  ]);
  if (!tot.ok || !byMgr.ok || !byTeam.ok) { fail("не вдалось отримати всі три зрізи"); return; }
  const sum = (rows: unknown, k: "revenue" | "deals") =>
    (rows as Record<string, unknown>[]).reduce((s, r) => s + n(r[k]), 0);
  const t = tot.data as Record<string, unknown>;
  for (const k of ["revenue", "deals"] as const) {
    const dep = n(t[k]), m = sum(byMgr.data, k), tm = sum(byTeam.data, k);
    // Менеджери/команди рахуються лише по угодах з відповідальним; відділ бере всі.
    // Розбіжність допустима ЛИШЕ як «відділ ≥ розрізи», і про неї треба знати.
    if (m !== tm) fail(`${k}: Σ(менеджери)=${m} ≠ Σ(команди)=${tm}`);
    else if (m !== dep) console.log(`  ⚠️ ${k}: Σ(розрізи)=${m}, відділ=${dep} — різниця ${dep - m} (угоди без менеджера)`);
    else ok(`${k}: ${dep} — збігається на всіх трьох рівнях`);
  }
}

await gateSecurity();
await gateParity();
await gateSigma();
console.log(failed ? "\n❌ ГЕЙТ ПРОВАЛЕНО" : "\n✅ ГЕЙТ ЗЕЛЕНИЙ");
await pool.end();
process.exit(failed ? 1 : 0);
