// Звірка кандидатів auto (leadgen/marketing/logistics) з листом (imported у
// statistics_values), помісячно 2026. Нічого не пише — лише друкує дельти, щоб
// вирішити, які метрики вмикати auto. Запуск вручну.

import { pool } from "../db/pool.js";
import { computeDeptAuto } from "../statistics/computeAuto.js";

async function main() {
  const auto = await computeDeptAuto("2026-01-01");
  // sheet (imported) значення department-level: для marketing/logistics team_lead=NULL
  const sheet = await pool.query<{ department: string; period_start: string; metric_key: string; value: string }>(
    `SELECT department, to_char(period_start,'YYYY-MM-DD') AS period_start, metric_key, value
       FROM statistics_values
      WHERE period_type='month' AND source='imported' AND team_lead IS NULL
        AND department IN ('marketing','logistics') AND period_start >= '2026-01-01'`);
  const sheetMap = new Map<string, number>();
  for (const r of sheet.rows) sheetMap.set(`${r.department}|month|${r.period_start}|${r.metric_key}`, Number(r.value));

  const metrics = [
    "marketing|ad_leads", "marketing|non_target_leads", "marketing|ad_budget_total",
    "logistics|machines_dispatched_total", "logistics|repeat_revenue", "logistics|repeat_machines",
  ];
  const months = ["2026-01-01","2026-02-01","2026-03-01","2026-04-01","2026-05-01","2026-06-01"];
  console.log("| Метрика | Місяць | CRM | Лист | Δ% |");
  console.log("|---|---|---:|---:|---:|");
  const summary: Record<string, number[]> = {};
  for (const dm of metrics) {
    const [dept, metric] = dm.split("|");
    for (const mo of months) {
      const c = auto.get(`${dept}|month|${mo}|${metric}`) ?? 0;
      const s = sheetMap.get(`${dept}|month|${mo}|${metric}`) ?? 0;
      if (c === 0 && s === 0) continue;
      const pct = s !== 0 ? ((c - s) / s) * 100 : (c !== 0 ? 100 : 0);
      (summary[dm] ??= []).push(Math.abs(pct));
      console.log(`| ${dm} | ${mo} | ${Math.round(c).toLocaleString("uk-UA")} | ${Math.round(s).toLocaleString("uk-UA")} | ${pct.toFixed(1)}% |`);
    }
  }
  console.log("\n=== СЕРЕДНЯ |Δ%| по метриці (менше — точніше) ===");
  for (const [dm, arr] of Object.entries(summary)) {
    const avg = arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
    console.log(`  ${dm}: ${avg.toFixed(1)}%  (міс: ${arr.length})`);
  }
}
main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
