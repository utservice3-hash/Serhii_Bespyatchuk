import { pool } from "../db/pool.js";
import { upsertLeadgenTouch, reclassifyAdChannel } from "./syncKommo.js";

/**
 * Одноразовий бекфіл персистентного лідоген-сліду. Засіває `leadgen_touch` з
 * поточного `leadgen_registry` + `lead_transfer_events` (спільне ядро —
 * `upsertLeadgenTouch`, тож логіка не дублюється), потім переклассифіковує
 * зачеплені угоди (`reclassifyAdChannel`). Глибина = наскільки сягає реєстр
 * (~5 тижнів) + історія transfer_events; глибше не чіпаємо (табл. deals не
 * ріжемо). Ідемпотентно — можна ганяти повторно (append-only + детермінований
 * reclassify).
 *
 *   node dist/jobs/backfillLeadgenTouch.js
 */
export async function backfillLeadgenTouch(): Promise<void> {
  const before = await pool.query<{ n: string }>(`SELECT COUNT(*) n FROM leadgen_touch`);
  const touched = await upsertLeadgenTouch();
  const after = await pool.query<{ n: string }>(`SELECT COUNT(*) n FROM leadgen_touch`);
  const reclassified = await reclassifyAdChannel();
  console.log(
    `backfillLeadgenTouch: leadgen_touch ${before.rows[0].n} → ${after.rows[0].n} ` +
      `(+${touched} новий слід); reclassify оновив ${reclassified} угод.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillLeadgenTouch()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
