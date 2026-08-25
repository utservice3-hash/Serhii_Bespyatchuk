import { pool } from "../db/pool.js";
import {
  fetchLeadsByIds, extractCarrierPayType, extractCarrierPayment, LEADS_BY_IDS_MAX,
} from "../kommo/client.js";
import { withHeavyJobLock } from "./jobLock.js";

/**
 * 🚚 РАЗОВИЙ БЕКФІЛ ВИПЛАТ ПЕРЕВІЗНИКУ для угод, що ВЖЕ в дебіторці.
 *
 * 🔴 ЧОМУ ТІЛЬКИ ЦІ УГОДИ, А НЕ ВСЯ БАЗА. Поле показується на ОДНОМУ екрані —
 * у розкритті рахунка. Тягнути 146 тис. угод заради 279 означало б випалити
 * compute-квоту Neon рівно так, як це вже сталося на бекфілі КРОКУ 1.4.
 * Решта наповниться сама: `syncKommo` пише ці колонки щопрохід, а угода, що
 * потрапляє в дебіторку, за визначенням активна й у вікні синку.
 *
 * 📐 Заміряно 25.08.2026 перед написанням: 279 угод за рахунками дебіторки, з
 * них 223 Kommo рухав за останні 30 днів. Тобто це **2 батчі** й дві хвилини,
 * а не «важкий бекфіл».
 *
 * 🔒 Під `withHeavyJobLock`: `UPDATE` по `deals` конкурує з `syncKommo`, який
 * бере ті самі рядки. Міграція `client_key_raw` свого часу впала з дедлоком
 * саме тому, що йшла повз замок.
 *
 *   node dist/jobs/backfillCarrierPayment.js            # сухий прогін
 *   node dist/jobs/backfillCarrierPayment.js --write    # із записом
 */
export async function backfillCarrierPayment(opts: { write?: boolean } = {}): Promise<{
  scanned: number; withType: number; updated: number;
}> {
  // 🔴 № УГОДИ БЕРЕМО З ЯДРА, А НЕ ВЛАСНИМ SQL.
  //
  // Перша редакція витягала id з `service_url` виразом «прибрати всі нецифри»,
  // тоді як `loadInvoiceFacts` бере «усе після останнього слеша». Два різні
  // вирази одного правила розійшлися б на першому ж посиланні, де цифри є і
  // в шляху, — і кожна половина виглядала б правдоподібно. Той самий клас, що
  // чипи «новий/постійний», які збігалися одна з одною, а не з правилом.
  const { loadInvoiceFacts } = await import("../core/receivablesFacts.js");
  const keys = (await pool.query<{ client_key: string }>(
    `SELECT DISTINCT client_key FROM receivable_invoices`
  )).rows.map((r) => r.client_key);
  const facts = await loadInvoiceFacts(pool, keys);
  const ids = [...new Set(facts.filter((f) => f.dealId != null && f.dealFound).map((f) => f.dealId!))];
  console.log(`backfillCarrierPayment: ${ids.length} угод, батчів ${Math.ceil(ids.length / LEADS_BY_IDS_MAX)}`
    + `, режим ${opts.write ? "ЗАПИС" : "сухий прогін"}`);

  let withType = 0, updated = 0;
  for (let i = 0; i < ids.length; i += LEADS_BY_IDS_MAX) {
    // 🔴 Дрібнимо ЗАВЖДИ: `fetchLeadsByIds` має стелю 250 і тепер кидає на
    // довшому списку. До сторожа він тихо віддавав перші 250 — на цьому самому
    // наборі (279) я вже одного разу порахував частки по обрізаній вибірці.
    const deals = await fetchLeadsByIds(ids.slice(i, i + LEADS_BY_IDS_MAX));
    for (const deal of deals) {
      const type = extractCarrierPayType(deal);
      if (type == null) continue;
      withType++;
      if (!opts.write) continue;
      const res = await pool.query(
        `UPDATE deals SET carrier_pay_type = $1, carrier_pay_amount = $2 WHERE kommo_id = $3`,
        [type, extractCarrierPayment(deal), deal.id]
      );
      updated += res.rowCount ?? 0;
    }
  }
  console.log(`backfillCarrierPayment: угод ${ids.length}, з умовами виплати ${withType}, оновлено ${updated}`);
  // ⚠️ ПОРОЖНІЙ РЕЗУЛЬТАТ — ПРОВАЛ, А НЕ УСПІХ. Заміряно: тип заповнений у 195
  // із 279. Нуль означає, що екстрактор читає не те поле, а не що даних немає.
  if (ids.length > 0 && withType === 0) {
    throw new Error("backfillCarrierPayment: жодної угоди з умовами виплати — "
      + "перевірте id полів, бо заміряно 195 із 279");
  }
  return { scanned: ids.length, withType, updated };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  withHeavyJobLock("backfillCarrierPayment", () => backfillCarrierPayment({ write }))
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
