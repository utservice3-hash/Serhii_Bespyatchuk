import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractPaymentType } from "../kommo/client.js";

/**
 * One-off backfill of `deals.payment_type` («форма расчета») for historical
 * deals. Fetches deals by id in batches of 250 (never all at once — OOM-safe)
 * and updates only the payment_type column.
 *
 *   node dist/jobs/backfillPaymentType.js            # all deals missing it
 *   node dist/jobs/backfillPaymentType.js --paid     # only paid deals (faster)
 */
export async function backfillPaymentType(opts: { paidOnly?: boolean } = {}): Promise<void> {
  const idsRes = await pool.query<{ kommo_id: string }>(
    opts.paidOnly
      ? `SELECT d.kommo_id FROM deals d
           JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
          WHERE psm.funnel_stage = 'paid' AND d.payment_type IS NULL`
      : `SELECT kommo_id FROM deals WHERE payment_type IS NULL`
  );
  const ids = idsRes.rows.map((r) => Number(r.kommo_id));
  console.log(`backfillPaymentType: ${ids.length} deals to process (paidOnly=${!!opts.paidOnly}).`);

  let updated = 0, processed = 0;
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const deals = await fetchLeadsByIds(batch);
    for (const deal of deals) {
      const pt = extractPaymentType(deal);
      if (pt) {
        await pool.query(`UPDATE deals SET payment_type = $1 WHERE kommo_id = $2`, [pt, deal.id]);
        updated++;
      }
    }
    processed += batch.length;
    if (i % 2500 === 0) console.log(`  …${processed}/${ids.length} (updated ${updated})`);
  }
  console.log(`backfillPaymentType done: processed ${processed}, updated ${updated}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paidOnly = process.argv.includes("--paid");
  backfillPaymentType({ paidOnly })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
