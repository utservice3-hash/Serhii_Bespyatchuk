import { pool } from "../db/pool.js";
import { kommoGet } from "../kommo/client.js";

/**
 * Одноразовий добір поля «Мінусова угода» (Kommo 2098529 = «Мінус») для вже наявних
 * `deals` + перезнак price за правилом власника: знак дає ПОЛЕ, не слово в назві.
 *
 * ІДЕМПОТЕНТНО (через ABS): повторний прогін не перевертає знак удруге.
 *   • is_minus=true  → price = -ABS(price)
 *   • is_minus=false → price = +ABS(price)  (в т.ч. фліпає назад «name-мінус», що НЕ поле)
 *
 * Джоба-синк (`syncKommo`) робить те саме на кожному проході; цей скрипт лише
 * підтягує історію одразу, не чекаючи, поки синк торкнеться кожної угоди.
 */

const FIELD_MINUS = 2098529;
const ENUM_MINUS = 6345149; // enum_id значення «Мінус»

async function fetchMinusIds(): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; page <= 40; page++) {
    const data = await kommoGet<{ _embedded?: { leads?: { id: number }[] } }>(
      `/api/v4/leads?filter[custom_fields_values][${FIELD_MINUS}][]=${ENUM_MINUS}&limit=250&page=${page}`
    ).catch(() => null);
    const leads = data?._embedded?.leads ?? [];
    if (!leads.length) break;
    for (const l of leads) ids.push(l.id);
    if (leads.length < 250) break;
  }
  return ids;
}

export async function backfillMinusFlag(): Promise<void> {
  const minusIds = await fetchMinusIds();
  const before = await pool.query<{ neg: string; pos: string; s: string }>(
    `SELECT COUNT(*) FILTER (WHERE price < 0) neg, COUNT(*) FILTER (WHERE price > 0) pos,
            COALESCE(SUM(price),0) s FROM deals`
  );
  // 1) поле=«Мінус» → is_minus=true, price=-ABS (ідемпотентно).
  const toMinus = await pool.query(
    `UPDATE deals SET is_minus = true, price = -ABS(price) WHERE kommo_id = ANY($1)`,
    [minusIds]
  );
  // 2) решта → is_minus=false; фліпаємо назад лише хибно-відʼємні (напр. «name-мінус»,
  //    що поле НЕ підтверджує) — price=+ABS. Позитивні лишаються без запису.
  const toPlus = await pool.query(
    `UPDATE deals SET is_minus = false, price = ABS(price)
      WHERE price < 0 AND kommo_id <> ALL($1)`,
    [minusIds]
  );
  // додатково: is_minus=false там, де воно ще не проставлене (default вже false, тож no-op).
  const after = await pool.query<{ neg: string; pos: string; s: string }>(
    `SELECT COUNT(*) FILTER (WHERE price < 0) neg, COUNT(*) FILTER (WHERE price > 0) pos,
            COALESCE(SUM(price),0) s FROM deals`
  );
  const b = before.rows[0], a = after.rows[0];
  console.log(
    `Minus backfill: Kommo «Мінус»=${minusIds.length}; set is_minus=true+neg=${toMinus.rowCount}, ` +
    `flip wrongly-neg→pos=${toPlus.rowCount}. Σprice ${Number(b.s).toLocaleString()} → ${Number(a.s).toLocaleString()} ` +
    `(neg ${b.neg}→${a.neg}, pos ${b.pos}→${a.pos}).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillMinusFlag()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
