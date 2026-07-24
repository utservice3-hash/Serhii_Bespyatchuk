// Одноразовий ідемпотентний імпорт історії «Статистик» із гугл-таблиці (CSV) у stats_series.
//   node dist/scripts/importStatsHistory.js --file=/path/stats_history_import.csv [--dry-run]
//
// Правила (рішення власника, Фаза 1):
//  • Усі рядки → source='sheet'.
//  • CRM-able метрики: точки period_date >= ШОВ (2026-07-01) НЕ імпортуємо — їх переписує
//    CRM live (routes/statisticsSeries). manual/finance/hr/tenders/lgintl/budgets — імпортуємо все.
//  • Мапінг team_lead → scope_key: живі команди → team_id (текст); історичні (Шевчук — окрема
//    серія, бо перетинається з «самостійні»; Мельник/Федоровський/Корнийчук/Єрмоченко — без команд)
//    → сама назва (текстовий ключ, CRM не продовжує).
//  • Ідемпотентний ON CONFLICT (metric,scope_type,scope_key,granularity,period_date,source).

import fs from "node:fs";
import { pool } from "../db/pool.js";
import { parseCsv } from "../utils/csv.js";

const SEAM = "2026-07-01"; // шов sheet→crm

// CRM-able набір: для цих метрик точки >= SEAM пропускаємо (CRM їх рахує live).
// Тримати синхронно з live-обчислювачами у Фазі 2 (спільне джерело правди перенесемо туди).
const CRM_ABLE: Record<string, Set<string>> = {
  sales: new Set(["revenue_success", "avg_check", "calls", "cars_success", "cars_delivered", "payment_received", "managers_count", "cash_deals_sum"]),
  marketing: new Set(["ad_leads", "ad_offtarget_leads", "ad_new_revenue", "ad_new_paid_cars", "ad_avg_check", "lg_transfers", "lg_new_revenue", "lg_new_clients", "lg_avg_check", "revenue_all_clients"]),
  logistics: new Set(["repeat_clients_sum", "repeat_clients_cars", "repeat_clients_active", "repeat_avg_check", "cars_delivered_all"]),
  intl: new Set(["intl_delivered_sum", "intl_delivered_cars", "intl_avg_check", "intl_new_sum", "intl_new_cars", "intl_new_avg_check", "intl_repeat_sum", "intl_repeat_cars", "intl_repeat_avg_check"]),
  // tenders/lgintl/finance/hr + marketing-бюджети → import all (manual/depstats/воронка закрита)
};
const isCrmAble = (block: string, metric: string) => CRM_ABLE[block]?.has(metric) ?? false;

// team_lead (scope_name у CSV) → {key, name}. Живі команди — team_id; історичні — назва.
const TEAM_LEAD_MAP: Record<string, { key: string; name: string }> = {
  "Яцик": { key: "5", name: "Яцик" },
  "Дмитрук": { key: "6", name: "Дмитрук" },
  "Шаврова": { key: "14", name: "Шаврова" },
  "Безпамятний": { key: "13", name: "Безпамятний" },
  "Михальчевська": { key: "15", name: "Михальчевська" },
  "самостійні": { key: "36283", name: "Самостійні" },   // жива команда 36283 (Шевчук Назар) → CRM продовжує
  "Шевчук": { key: "Шевчук", name: "Шевчук" },           // окрема історична серія (перетин дат із «самостійні») → без CRM
};
// Історичні тімліди без команд — ключ = назва, без CRM-продовження.
function scopeForTeamLead(raw: string): { key: string; name: string } {
  return TEAM_LEAD_MAP[raw] ?? { key: raw, name: raw };
}
function scopeFor(scopeType: string, raw: string): { key: string; name: string } {
  if (scopeType === "company") return { key: "company", name: raw };       // UTS
  if (scopeType === "team_lead") return scopeForTeamLead(raw);
  return { key: raw, name: raw };                                          // unit — назва як ключ
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith("--file="));
  const file = fileArg ? fileArg.split("=")[1] : null;
  const dryRun = process.argv.includes("--dry-run");
  if (!file) { console.error("Вкажи --file=шлях.csv"); process.exit(1); }

  const text = fs.readFileSync(file, "utf-8");
  const rows = parseCsv(text).filter((r) => r.length && r.some((c) => c.trim() !== ""));
  const header = rows.shift()!;
  const col = (name: string) => header.indexOf(name);
  const ci = { block: col("block"), metric: col("metric_key"), st: col("scope_type"), sn: col("scope_name"), g: col("granularity"), d: col("period_date"), v: col("value") };
  if (Object.values(ci).some((i) => i < 0)) { console.error("CSV: бракує колонок", header); process.exit(1); }

  let valid = 0, invalid = 0, imported = 0, skippedSeam = 0;
  const byBlock: Record<string, number> = {};
  const skipByBlock: Record<string, number> = {};
  const batch: { block: string; metric: string; st: string; key: string; name: string; g: string; d: string; v: number }[] = [];

  for (const r of rows) {
    const block = r[ci.block]?.trim(), metric = r[ci.metric]?.trim(), st = r[ci.st]?.trim();
    const sn = r[ci.sn]?.trim(), g = r[ci.g]?.trim(), d = r[ci.d]?.trim(), vRaw = r[ci.v]?.trim();
    const v = Number(vRaw);
    if (!block || !metric || !st || !sn || !g || !d || vRaw === "" || Number.isNaN(v) || (g !== "month" && g !== "week")) { invalid++; continue; }
    valid++;
    if (isCrmAble(block, metric) && d >= SEAM) { skippedSeam++; skipByBlock[block] = (skipByBlock[block] ?? 0) + 1; continue; }
    const sc = scopeFor(st, sn);
    imported++; byBlock[block] = (byBlock[block] ?? 0) + 1;
    batch.push({ block, metric, st, key: sc.key, name: sc.name, g, d, v });
  }

  console.log(`CSV: валідних ${valid}, невалідних ${invalid}`);
  console.log(`ІМПОРТ (sheet): ${imported} · СКІП (CRM-able ≥${SEAM}): ${skippedSeam} · Σ=${imported + skippedSeam}`);
  console.log("по блоках (імпорт · скіп-шов):");
  for (const b of Object.keys(byBlock).sort((a, z) => byBlock[z] - byBlock[a]))
    console.log(`  ${b}: ${byBlock[b]} · скіп ${skipByBlock[b] ?? 0}`);

  if (dryRun) { console.log("DRY-RUN — у БД не писали."); await pool.end(); return; }

  // Ідемпотентний upsert батчами по 1000.
  let written = 0;
  for (let i = 0; i < batch.length; i += 1000) {
    const chunk = batch.slice(i, i + 1000);
    const vals: unknown[] = [];
    const tuples = chunk.map((x, j) => {
      const o = j * 9;
      vals.push(x.block, x.metric, x.st, x.key, x.name, x.g, x.d, x.v, "sheet");
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`;
    });
    const res = await pool.query(
      `INSERT INTO stats_series (block, metric_key, scope_type, scope_key, scope_name, granularity, period_date, value, source)
       VALUES ${tuples.join(",")}
       ON CONFLICT (metric_key, scope_type, scope_key, granularity, period_date, source)
       DO UPDATE SET value = EXCLUDED.value, scope_name = EXCLUDED.scope_name, block = EXCLUDED.block`,
      vals
    );
    written += res.rowCount ?? 0;
  }
  const total = (await pool.query(`SELECT COUNT(*)::int c FROM stats_series WHERE source='sheet'`)).rows[0].c;
  console.log(`Записано (insert+update): ${written}. Усього sheet-рядків у таблиці: ${total}.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
