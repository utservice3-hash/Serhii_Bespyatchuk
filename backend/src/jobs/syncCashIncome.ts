// «Успішні угоди з готівковою оплатою» (sales.cash_deals_amount) → auto.
// Готівкові угоди: price (бюджет) СИЛЬНО занижує реальний дохід (звірка червень
// 2026: price 556k vs приход 1.33млн ≈ лист 1.5млн). Тому сума = ПРИХОД
// («Розрахунок приходів», `extractIncomeAmount`), а не бюджет — та сама логіка,
// що в syncReceivables.insertCashReceivables.
//
// Легке навантаження на Kommo: лише готівкові 142-угоди поточного міс+тижня
// (~400 угод = ~2 батч-запити). Раз на 3 год + старт. payment_type для 2026
// заповнений повністю, тож фетчимо тільки приход.

import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractIncomeAmount } from "../kommo/client.js";
import { canonTeamLead, SALES_TEAM_LEAD, SALES_FALLBACK_LEAD, STATS_AUTO_FROM } from "../statistics/catalog.js";

const FULL_CYCLE = [8921932, 155304];
const SALES_TEAM_IDS = Object.keys(SALES_TEAM_LEAD).map(Number);
const CASH_SQL = "d.payment_type ILIKE '%нал%' AND d.payment_type NOT ILIKE '%безнал%'";
const RECENT_DAYS = 40;

export interface CashStatus { lastRunAt: string | null; lastError: string | null; monthCash: number | null; running: boolean; }
const status: CashStatus = { lastRunAt: null, lastError: null, monthCash: null, running: false };
export function getCashIncomeStatus(): CashStatus { return { ...status }; }

let running = false;
const teamLeadOf = (teamId: number | null) =>
  teamId != null && SALES_TEAM_LEAD[teamId] ? canonTeamLead(SALES_TEAM_LEAD[teamId]) : SALES_FALLBACK_LEAD;

export async function syncCashIncome(): Promise<void> {
  if (running) { console.warn("syncCashIncome: previous run in progress — skip."); return; }
  running = true; status.running = true;
  const startedAt = new Date();
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("syncCashIncome timeout 120s")), 120_000)),
    ]);
    status.lastError = null;
  } catch (err) {
    status.lastError = (err as Error).message;
    console.error("syncCashIncome failed:", err);
  } finally {
    running = false; status.running = false; status.lastRunAt = startedAt.toISOString();
  }
}

async function run(): Promise<void> {
  // Готівкові 142-угоди повного циклу, закриті за останні ~40 днів, з бакетами.
  const res = await pool.query<{ kommo_id: string; team_id: number | null; month_b: string; week_b: string }>(
    `SELECT d.kommo_id, m.team_id,
            to_char(date_trunc('month', (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS month_b,
            to_char(date_trunc('week',  (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS week_b
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE d.pipeline_id = ANY($1) AND d.status_id = 142 AND d.closed_at_kommo IS NOT NULL
        AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= (CURRENT_DATE - $3::int)
        AND ${CASH_SQL}
        AND (m.team_id IS NULL OR m.team_id = ANY($2))`,
    [FULL_CYCLE, SALES_TEAM_IDS, RECENT_DAYS]
  );
  if (res.rowCount === 0) { status.monthCash = 0; return; }

  // Приход по кожній угоді (батчами по 250).
  const ids = res.rows.map((r) => Number(r.kommo_id));
  const income = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 250) {
    const leads = await fetchLeadsByIds(ids.slice(i, i + 250));
    for (const l of leads) { const inc = extractIncomeAmount(l); if (inc != null) income.set(l.id, inc); }
  }

  // Агрегуємо приход по (period_type, bucket, team_lead).
  const agg = new Map<string, number>();
  const add = (pt: string, bucket: string, lead: string, v: number) => {
    if (bucket < STATS_AUTO_FROM) return;
    agg.set(`${pt}|${bucket}|${lead}`, (agg.get(`${pt}|${bucket}|${lead}`) ?? 0) + v);
  };
  for (const r of res.rows) {
    const inc = income.get(Number(r.kommo_id));
    if (inc == null) continue;
    const lead = teamLeadOf(r.team_id);
    add("month", r.month_b, lead, inc);
    add("week", r.week_b, lead, inc);
  }

  const rows = [...agg.entries()];
  if (rows.length) {
    const vals: unknown[] = [];
    const tuples = rows.map(([k, value], j) => {
      const [pt, ps, lead] = k.split("|");
      const b = j * 4;
      vals.push(pt, ps, lead, Math.round(value));
      return `('sales',$${b + 1},$${b + 2},$${b + 3},'cash_deals_amount',$${b + 4},'auto')`;
    }).join(",");
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source)
       VALUES ${tuples}
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = 'auto', updated_at = now()`,
      vals
    );
  }
  // моніторинг: сума приходу поточного місяця
  const curMonth = new Date().toISOString().slice(0, 7) + "-01";
  status.monthCash = [...agg.entries()].filter(([k]) => k.startsWith(`month|${curMonth}|`)).reduce((s, [, v]) => s + v, 0);
  console.log(`syncCashIncome: upserted ${rows.length} cash-income values (month ${Math.round(status.monthCash)}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncCashIncome().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
