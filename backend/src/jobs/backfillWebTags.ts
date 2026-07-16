import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractWebTags } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * КРОК 6.1 — one-off backfill of the four web/geo ad-tag columns
 * (`deals.utm_campaign` 481997, `adv_camp` 2098331, `traf_src` 2098327,
 * `traf_type` 2098329) for deals synced before the columns existed. Same
 * pattern as backfillActDates: fetch by id in batches of 250 (OOM-safe), one
 * batched UPDATE per batch.
 *
 * Scoped to the **12-month data horizon** (CLAUDE.md rule) by
 * created_at_kommo (Kyiv). UPDATE-only → light on Neon; still wrapped in
 * withHeavyJobLock so syncKommo skips its pass while this runs (no Kommo
 * request-rate collision).
 *
 *   node dist/jobs/backfillWebTags.js              # 12 months, all deals missing all four tags
 *   node dist/jobs/backfillWebTags.js --all-time   # ignore the 12-month horizon
 */
export async function backfillWebTags(opts: { allTime?: boolean } = {}): Promise<void> {
  await withHeavyJobLock("backfill", async () => {
    const idsRes = await pool.query<{ kommo_id: string }>(
      opts.allTime
        ? `SELECT kommo_id FROM deals
            WHERE utm_campaign IS NULL AND adv_camp IS NULL
              AND traf_src IS NULL AND traf_type IS NULL
            ORDER BY kommo_id`
        : `SELECT kommo_id FROM deals
            WHERE utm_campaign IS NULL AND adv_camp IS NULL
              AND traf_src IS NULL AND traf_type IS NULL
              AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date
                    >= (now() AT TIME ZONE 'Europe/Kyiv')::date - INTERVAL '12 months'
            ORDER BY kommo_id`
    );
    const ids = idsRes.rows.map((r) => Number(r.kommo_id));
    console.log(`backfillWebTags: ${ids.length} deals to process (allTime=${!!opts.allTime}).`);

    let updated = 0, processed = 0;
    for (let i = 0; i < ids.length; i += 250) {
      const batch = ids.slice(i, i + 250);
      const deals = await fetchLeadsByIds(batch);
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const deal of deals) {
        const t = extractWebTags(deal);
        if (t.utmCampaign || t.advCamp || t.trafSrc || t.trafType) {
          const b = values.length;
          values.push(deal.id, t.utmCampaign, t.advCamp, t.trafSrc, t.trafType);
          tuples.push(
            `($${b + 1}::bigint, $${b + 2}::text, $${b + 3}::text, $${b + 4}::text, $${b + 5}::text)`
          );
        }
      }
      if (tuples.length) {
        await pool.query(
          `UPDATE deals d SET utm_campaign = v.utm_campaign, adv_camp = v.adv_camp,
                              traf_src = v.traf_src, traf_type = v.traf_type
             FROM (VALUES ${tuples.join(",")}) AS v(kommo_id, utm_campaign, adv_camp, traf_src, traf_type)
            WHERE d.kommo_id = v.kommo_id`,
          values
        );
        updated += tuples.length;
      }
      processed += batch.length;
      console.log(`  …${processed}/${ids.length} (updated ${updated})`);
    }
    console.log(`backfillWebTags done: processed ${processed}, updated ${updated}.`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allTime = process.argv.includes("--all-time");
  backfillWebTags({ allTime })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
