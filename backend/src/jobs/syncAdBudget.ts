import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { parseCsv } from "../utils/csv.js";

/** "4 839" / "3 029.97" → 4839 / 3029.97 (space thousands, dot decimal). */
function num(s: string | undefined): number {
  if (!s) return 0;
  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

interface DayRow {
  day: string; // YYYY-MM-DD
  budgetPlan: number;
  budgetFact: number;
  conversions: number;
  clicks: number;
}

/**
 * The daily table rows carry a YYYYMMDD key in column 1. Columns (0-indexed):
 * 1 dateKey, 3 Budget (Plan), 4 Cost (Fact), 5 Clicks, 10 Conversions all.
 */
function parseRow(cells: string[]): DayRow | null {
  const key = cells[1]?.trim();
  if (!key || !/^\d{8}$/.test(key)) return null;
  const day = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
  return {
    day,
    budgetPlan: num(cells[3]),
    budgetFact: num(cells[4]),
    clicks: num(cells[5]),
    conversions: num(cells[10]),
  };
}

/** Pull the Google Ads budget sheet and upsert one row per day. */
export async function syncAdBudget(): Promise<void> {
  const res = await fetch(config.adBudgetSheetUrl);
  if (!res.ok) throw new Error(`Failed to fetch ad budget sheet: ${res.status}`);
  const csvText = await res.text();
  const rows = parseCsv(csvText).map(parseRow).filter((r): r is DayRow => r !== null);
  if (rows.length === 0) {
    console.warn("syncAdBudget: no daily rows parsed — sheet layout may have changed.");
    return;
  }
  for (const r of rows) {
    await pool.query(
      `INSERT INTO ad_budget_daily (day, budget_plan, budget_fact, conversions, clicks, synced_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (day) DO UPDATE SET
         budget_plan = EXCLUDED.budget_plan,
         budget_fact = EXCLUDED.budget_fact,
         conversions = EXCLUDED.conversions,
         clicks = EXCLUDED.clicks,
         synced_at = now()`,
      [r.day, r.budgetPlan, r.budgetFact, r.conversions, r.clicks]
    );
  }
  console.log(`Ad budget synced: ${rows.length} day rows.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncAdBudget()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
