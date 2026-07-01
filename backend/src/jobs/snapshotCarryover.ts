import { pool } from "../db/pool.js";

const FULL_CYCLE = [8921932, 155304];
const PAYMENT_RECEIVED = [69716460, 60412544];

/**
 * Snapshots the value of deals still IN PROGRESS at the start of the current
 * month — "Умови узгоджені" (approved) → "Виставлено рахунок" (invoiced) →
 * "Оплата отримана" (payment received), but NOT yet closed as "Успішна угода"
 * (142 accumulates forever, so it's excluded). This is the "carried over from
 * last month" figure, fixed once per month: ON CONFLICT DO NOTHING keeps the
 * first capture so a mid-month re-run never changes it.
 */
export async function snapshotCarryover(): Promise<void> {
  const r = await pool.query(
    `INSERT INTO monthly_carryover (month, amount, deals)
     SELECT date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv'))::date,
            COALESCE(SUM(d.price), 0), COUNT(*)
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.pipeline_id = ANY($1)
       AND (psm.funnel_stage IN ('approved', 'invoiced') OR d.status_id = ANY($2))
     ON CONFLICT (month) DO NOTHING`,
    [FULL_CYCLE, PAYMENT_RECEIVED]
  );
  console.log(
    `Carryover snapshot: ${r.rowCount ? "captured for current month" : "already captured this month"}.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  snapshotCarryover()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
