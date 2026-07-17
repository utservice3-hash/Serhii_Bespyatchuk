import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractPlannedPaymentDate } from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * Р2 — бекфіл `deals.planned_payment_at` («Запланована дата оплати», Kommo
 * 2097273). Метрика «Сума очікування» — це ЗНІМОК поточної грошової зони
 * (виставлено рахунок → очікуємо оплату), тож ЗА ЗАМОВЧУВАННЯМ бекфілимо лише
 * цю зону (≈255 угод, миттєво). `--all-base` — уся база (для історії; ~123к
 * угод, але поле заповнене лише в зоні, тож ~13% апдейтів; UPDATE-only, легко
 * на Neon). Той самий патерн, що backfillActDates; батчі по 250 (OOM-safe),
 * один батчевий UPDATE на пачку. Обгорнуто withHeavyJobLock — syncKommo скіпає.
 */
// 5 стадій грошової зони (див. core/metrics.ts EXPECT_ZONE — той самий список).
const MONEY_ZONE = [100274340, 69716300, 98470988, 69716304, 69716312, 10937178, 42639144, 42639147, 25044997, 62940068];

export async function backfillPlannedPayment(opts: { allBase?: boolean } = {}): Promise<void> {
  await withHeavyJobLock("backfill", async () => {
    const idsRes = await pool.query<{ kommo_id: string }>(
      opts.allBase
        ? `SELECT kommo_id FROM deals WHERE planned_payment_at IS NULL ORDER BY kommo_id`
        : `SELECT kommo_id FROM deals
            WHERE pipeline_id = ANY(ARRAY[8921932, 155304]) AND status_id = ANY($1)
            ORDER BY kommo_id`,
      opts.allBase ? [] : [MONEY_ZONE]
    );
    const ids = idsRes.rows.map((r) => Number(r.kommo_id));
    console.log(`backfillPlannedPayment: ${ids.length} deals to process (allBase=${!!opts.allBase}).`);

    let updated = 0, processed = 0;
    for (let i = 0; i < ids.length; i += 250) {
      const batch = ids.slice(i, i + 250);
      const deals = await fetchLeadsByIds(batch);
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const deal of deals) {
        const planned = extractPlannedPaymentDate(deal);
        if (planned) {
          const b = values.length;
          values.push(deal.id, planned);
          tuples.push(`($${b + 1}::bigint, $${b + 2}::timestamptz)`);
        }
      }
      if (tuples.length) {
        await pool.query(
          `UPDATE deals d SET planned_payment_at = v.planned_payment_at
             FROM (VALUES ${tuples.join(",")}) AS v(kommo_id, planned_payment_at)
            WHERE d.kommo_id = v.kommo_id`,
          values
        );
        updated += tuples.length;
      }
      processed += batch.length;
      console.log(`  …${processed}/${ids.length} (updated ${updated})`);
    }
    console.log(`backfillPlannedPayment done: processed ${processed}, updated ${updated}.`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const allBase = process.argv.includes("--all-base");
  backfillPlannedPayment({ allBase })
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
