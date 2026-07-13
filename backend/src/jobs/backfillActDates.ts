import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractUnloadDate, extractLoadDate } from "../kommo/client.js";

/**
 * One-off backfill of `deals.unload_at` («Дата выгрузки (Дата акта)», поле
 * 463253 — фінансовий якір) and `deals.load_at` («Дата загрузки», 473637) for
 * deals synced before the columns existed. Fetches by id in batches of 250
 * (never all at once — OOM-safe); the built-in client throttle keeps the
 * Kommo request rate low.
 *
 *   node dist/jobs/backfillActDates.js                 # all deals missing both dates
 *   node dist/jobs/backfillActDates.js --full-cycle    # only full-cycle pipelines (faster)
 */
export async function backfillActDates(opts: { fullCycleOnly?: boolean } = {}): Promise<void> {
  const idsRes = await pool.query<{ kommo_id: string }>(
    opts.fullCycleOnly
      ? `SELECT kommo_id FROM deals
          WHERE unload_at IS NULL AND load_at IS NULL
            AND pipeline_id IN (8921932, 155304)
          ORDER BY kommo_id`
      : `SELECT kommo_id FROM deals
          WHERE unload_at IS NULL AND load_at IS NULL
          ORDER BY kommo_id`
  );
  const ids = idsRes.rows.map((r) => Number(r.kommo_id));
  console.log(`backfillActDates: ${ids.length} deals to process (fullCycleOnly=${!!opts.fullCycleOnly}).`);

  let updated = 0, processed = 0;
  for (let i = 0; i < ids.length; i += 250) {
    const batch = ids.slice(i, i + 250);
    const deals = await fetchLeadsByIds(batch);
    // Один батчевий UPDATE на пачку: по-рядкові update-и до Neon (~150мс RTT
    // кожен) розтягували бекфіл 87 тис угод на години.
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const deal of deals) {
      const unloadAt = extractUnloadDate(deal);
      const loadAt = extractLoadDate(deal);
      if (unloadAt || loadAt) {
        const b = values.length;
        values.push(deal.id, unloadAt, loadAt);
        tuples.push(`($${b + 1}::bigint, $${b + 2}::timestamptz, $${b + 3}::timestamptz)`);
      }
    }
    if (tuples.length) {
      await pool.query(
        `UPDATE deals d SET unload_at = v.unload_at, load_at = v.load_at
           FROM (VALUES ${tuples.join(",")}) AS v(kommo_id, unload_at, load_at)
          WHERE d.kommo_id = v.kommo_id`,
        values
      );
      updated += tuples.length;
    }
    processed += batch.length;
    console.log(`  …${processed}/${ids.length} (updated ${updated})`);
  }
  console.log(`backfillActDates done: processed ${processed}, updated ${updated}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fullCycleOnly = process.argv.includes("--full-cycle");
  backfillActDates({ fullCycleOnly })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
