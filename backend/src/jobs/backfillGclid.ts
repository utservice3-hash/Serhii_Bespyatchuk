import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractGclid } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * 📈 Разове донаповнення `deals.gclid` (Kommo 482023) для угод, синхронізованих до появи колонки
 * (27.10.2026, офлайн-конверсії Google Ads). Форми uts.ua пишуть gclid лише з 23.10.2026, тож раніше
 * шукати нема чого — це і є дефолтна межа. Той самий прийом, що `backfillWebTags`: id пачками по 250,
 * одним UPDATE на пачку, під `withHeavyJobLock`, щоб синк не бився з нами за ліміт Kommo.
 *
 *   node dist/jobs/backfillGclid.js                     # угоди, створені з 2026-10-23
 *   node dist/jobs/backfillGclid.js --from=2026-10-01   # інша межа
 */
export async function backfillGclid(opts: { from?: string } = {}): Promise<{ processed: number; updated: number }> {
  const from = opts.from ?? "2026-10-23";
  let processed = 0, updated = 0;
  await withHeavyJobLock("backfill", async () => {
    const idsRes = await pool.query<{ kommo_id: string }>(
      `SELECT kommo_id AS kommo_id FROM deals
        WHERE (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $1::date
        ORDER BY kommo_id`, [from]);
    const ids = idsRes.rows.map((r) => Number(r.kommo_id));
    console.log(`backfillGclid: ${ids.length} угод, створених з ${from}.`);
    for (let i = 0; i < ids.length; i += 250) {
      const deals = await fetchLeadsByIds(ids.slice(i, i + 250));
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const deal of deals) {
        const g = extractGclid(deal);
        if (!g) continue;
        values.push(deal.id, g);
        tuples.push(`($${values.length - 1}::bigint, $${values.length}::text)`);
      }
      if (tuples.length) {
        await pool.query(
          `UPDATE deals AS d SET gclid = v.gclid
             FROM (VALUES ${tuples.join(",")}) AS v(kommo_id, gclid)
            WHERE d.kommo_id = v.kommo_id`, values);
        updated += tuples.length;
      }
      processed += Math.min(250, ids.length - i);
      console.log(`  …${processed}/${ids.length} (з gclid ${updated})`);
    }
  });
  console.log(`backfillGclid готово: переглянуто ${processed}, з gclid ${updated}.`);
  return { processed, updated };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const from = process.argv.find((a) => a.startsWith("--from="))?.slice(7);
  backfillGclid({ from })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
