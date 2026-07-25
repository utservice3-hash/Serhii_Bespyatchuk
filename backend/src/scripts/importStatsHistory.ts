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
import { STATS_SEAM as SEAM, isCrmAble, scopeFor } from "../statistics/seriesCatalog.js";

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
  type Row = { block: string; metric: string; st: string; key: string; name: string; g: string; d: string; v: number };
  // Дедуп по УНІКАЛЬНОМУ ключу (Map keep-last) — щоб ON CONFLICT не бачив дубль у батчі.
  const batchMap = new Map<string, Row>();
  const prevPeriod = new Map<string, string>(); // остання period_date по серії (для правила A1)
  let a1skips = 0, dupSkips = 0;

  for (const r of rows) {
    const block = r[ci.block]?.trim(), metric = r[ci.metric]?.trim(), st = r[ci.st]?.trim();
    const sn = r[ci.sn]?.trim(), g = r[ci.g]?.trim(), d = r[ci.d]?.trim(), vRaw = r[ci.v]?.trim();
    const v = Number(vRaw);
    if (!block || !metric || !st || !sn || !g || !d || vRaw === "" || Number.isNaN(v) || (g !== "month" && g !== "week")) { invalid++; continue; }
    valid++;
    if (isCrmAble(block, metric) && d >= SEAM) { skippedSeam++; skipByBlock[block] = (skipByBlock[block] ?? 0) + 1; continue; }
    const sc = scopeFor(st, sn);
    const seriesKey = `${block}|${metric}|${sc.key}|${g}`;
    // A1 (задокументована аномалія, як backfillStatistics §6): finance/month рядок «2025-12-01»,
    // чий попередній період у цій серії — 2024, насправді зміщений 2024-грудень → пропуск.
    if (block === "finance" && g === "month" && d === "2025-12-01" && (prevPeriod.get(seriesKey) ?? "").startsWith("2024")) {
      a1skips++; prevPeriod.set(seriesKey, d); continue;
    }
    prevPeriod.set(seriesKey, d);
    const uk = `${metric}|${st}|${sc.key}|${g}|${d}`;
    if (batchMap.has(uk)) { dupSkips++; console.warn(`  ⚠️ дубль ключа ${uk} — keep-last`); }
    batchMap.set(uk, { block, metric, st, key: sc.key, name: sc.name, g, d, v });
  }
  const batch = [...batchMap.values()];
  for (const x of batch) byBlock[x.block] = (byBlock[x.block] ?? 0) + 1;
  imported = batch.length;
  if (a1skips || dupSkips) console.log(`Аномалії: A1-skip=${a1skips} (finance 2025-12 зміщений) · дубль-ключів keep-last=${dupSkips}`);

  console.log(`CSV: валідних ${valid}, невалідних ${invalid}`);
  console.log(`ІМПОРТ (sheet, унікальні): ${imported} · СКІП (CRM-able ≥${SEAM}): ${skippedSeam} · A1-аномалія: ${a1skips} · дубль: ${dupSkips} · Σ=${imported + skippedSeam + a1skips + dupSkips}`);
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
