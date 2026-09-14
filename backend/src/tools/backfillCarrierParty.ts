/**
 * 🚚 БЕКФІЛ «ХТО ПЕРЕВІЗНИК» ДЛЯ ЗАЯВОК НА ОПЛАТУ (14.09.2026).
 *
 * `syncKommo` пише `carrier_name`/`carrier_edrpou` лише для угод, які Kommo віддає як
 * оновлені після синку. Заявки, що вже закриті, він більше не торкнеться — тож реєстр
 * без цього інструмента показував би «—» у назві перевізника для всієї історії.
 *
 * Що робить: бере угоди воронки «Оплата перевозчикам» за N днів (за замовчуванням 90),
 * у яких назви перевізника ще немає, тягне їх з Kommo по 250 (`fetchLeadsByIds`) і
 * пише РІВНО чотири колонки: перевізник (назва, ЄДРПОУ) і хто подав (вихідна угода, ПІБ).
 * Нічого іншого в угоді не чіпає.
 *
 *   node dist/tools/backfillCarrierParty.js              # звіт: скільки, нічого не пише
 *   node dist/tools/backfillCarrierParty.js --write      # виконати
 *   node dist/tools/backfillCarrierParty.js --days=180   # глибина
 *
 * 📐 Заміряно 14.09: у воронці 16 291 угода, за 90 днів — 3 965 → ~16 запитів по 250.
 */
import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractCarrierName, extractCarrierEdrpou, extractSourceDealId, extractSourceResponsible, LEADS_BY_IDS_MAX } from "../kommo/client.js";
import { PAYMENT_REQUEST_PIPELINE } from "../core/paymentRequests.js";

const write = process.argv.includes("--write");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = daysArg ? Number(daysArg.slice(7)) : 90;

const ids = (await pool.query<{ kommo_id: number }>(
  `SELECT kommo_id FROM deals
    WHERE pipeline_id = $1 AND (carrier_name IS NULL OR source_deal_id IS NULL)
      AND created_at_kommo >= now() - ($2 || ' days')::interval
    ORDER BY kommo_id DESC`, [PAYMENT_REQUEST_PIPELINE, String(days)])).rows.map((r) => Number(r.kommo_id));
console.log(`кандидатів без перевізника або вихідної угоди за ${days} дн.: ${ids.length}${write ? "" : " (сухий прогін, --write щоб записати)"}`);

let filled = 0, empty = 0, touched = 0;
for (let i = 0; i < ids.length; i += LEADS_BY_IDS_MAX) {
  const chunk = ids.slice(i, i + LEADS_BY_IDS_MAX);
  const leads = await fetchLeadsByIds(chunk);
  for (const deal of leads) {
    const name = extractCarrierName(deal);
    const edrpou = extractCarrierEdrpou(deal);
    const srcId = extractSourceDealId(deal);
    const srcResp = extractSourceResponsible(deal);
    if (name == null && edrpou == null && srcId == null && srcResp == null) { empty++; continue; }
    filled++;
    if (write) {
      const r = await pool.query(`UPDATE deals SET carrier_name = $2, carrier_edrpou = $3, source_deal_id = $4, source_responsible = $5 WHERE kommo_id = $1`, [deal.id, name, edrpou, srcId, srcResp]);
      touched += r.rowCount ?? 0;
    }
  }
  console.log(`  ${Math.min(i + LEADS_BY_IDS_MAX, ids.length)} / ${ids.length} · з назвою ${filled} · без ${empty}`);
}
console.log(`підсумок: з перевізником ${filled}, без ${empty}${write ? `, записано ${touched}` : ""}`);
await pool.end();
