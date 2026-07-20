import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractRequestType, extractSalesChannel } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * Блок B — one-off backfill двох логістичних полів:
 *   `deals.request_type`  ← «Тип запиту» (2097965, напрямок Україна/міжнар/переїзд)
 *   `deals.sales_channel` ← «Канал продажу» (2099549, Нові/Постійні/Тендерний)
 * для угод, синкнутих до появи колонок. Патерн — як backfillWebTags: fetch by id
 * батчами по 250 (OOM-safe), один батчевий UPDATE. Обмежено 12-міс горизонтом
 * (CLAUDE.md) за created_at_kommo. UPDATE-only → легко для Neon; під heavy-lock,
 * щоб syncKommo пропускав прохід (без колізії ліміту Kommo).
 *
 *   node dist/jobs/backfillLogisticsFields.js              # 12 місяців
 *   node dist/jobs/backfillLogisticsFields.js --all-time   # уся історія
 */
export async function backfillLogisticsFields(opts: { allTime?: boolean } = {}): Promise<number> {
  return withHeavyJobLock("backfill", async () => {
    const idsRes = await pool.query<{ kommo_id: string }>(
      opts.allTime
        ? `SELECT kommo_id FROM deals ORDER BY kommo_id`
        : `SELECT kommo_id FROM deals
            WHERE (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date
                    >= (now() AT TIME ZONE 'Europe/Kyiv')::date - INTERVAL '12 months'
            ORDER BY kommo_id`
    );
    const ids = idsRes.rows.map((r) => Number(r.kommo_id));
    console.log(`backfillLogisticsFields: ${ids.length} deals (allTime=${!!opts.allTime}).`);

    let updated = 0, processed = 0;
    for (let i = 0; i < ids.length; i += 250) {
      const batch = ids.slice(i, i + 250);
      const deals = await fetchLeadsByIds(batch);
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const deal of deals) {
        const rt = extractRequestType(deal);
        const sc = extractSalesChannel(deal);
        if (rt || sc) {
          const b = values.length;
          values.push(deal.id, rt, sc);
          tuples.push(`($${b + 1}::bigint, $${b + 2}::text, $${b + 3}::text)`);
        }
      }
      if (tuples.length) {
        await pool.query(
          `UPDATE deals d SET request_type = v.request_type, sales_channel = v.sales_channel
             FROM (VALUES ${tuples.join(",")}) AS v(kommo_id, request_type, sales_channel)
            WHERE d.kommo_id = v.kommo_id`,
          values
        );
        updated += tuples.length;
      }
      processed += batch.length;
      console.log(`  …${processed}/${ids.length} (updated ${updated})`);
    }
    console.log(`backfillLogisticsFields done: processed ${processed}, updated ${updated}.`);
    return updated;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allTime = process.argv.includes("--all-time");
  backfillLogisticsFields({ allTime })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
