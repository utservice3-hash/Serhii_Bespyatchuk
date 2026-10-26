/**
 * 🧾 ЧИМ ПІДТВЕРДЖЕНО РОБОТУ З КЛІЄНТОМ (задача 6455, правило Сергія 20.10.2026; Роман 23.10.2026).
 *
 * Менеджер працює з клієнтом, якщо за період є хоча б одне:
 *  1. CRM — угода по клієнту в повному циклі (`money.FC_PIPELINES`) на етапі «Виставлення рахунку» або далі
 *     (`money.STAGE_FROM_INVOICE`): за період увійшла в такий етап (у т.ч. стала «Успішною») АБО зараз стоїть на ньому
 *     в роботі (Роман 23.10: «дійшла до рахунку раніше і досі в роботі — це робота»). Програні (143) — ні.
 *  2. Виписка — від клієнта надійшли гроші: код платника (ЄДРПОУ/ІПН із банківських даних) збігся з компанією, привʼязаною
 *     до угод клієнта в Kommo. Добір платежів — ТОЙ САМИЙ, що в звірці оплат (`paymentMatch.invoicePaymentsSql`): Сейф
 *     і особисті картки там не вважаються оплатами клієнтів, тож і тут ні.
 * Розмови, ручні контакти, кроки й задачі роботу НЕ підтверджують (Роман 23.10: «2 так, 3 так»).
 *
 * Це перевірка НАЯВНОСТІ, а не гроші: жодної суми з неї в метрики не йде (сума оплати лише показується як доказ).
 * Правило «без роботи» поверх цих фактів — `repeatScreenRules.workFlags`.
 */
import type { Db } from "./baClaims.js";
import { FC_PIPELINES, STAGE_FROM_INVOICE } from "./money.js";
import { invoicePaymentsSql } from "./paymentMatch.js";
import { stageName } from "./stageNames.js";

/** Угода, що підтверджує роботу: номер, етап (назва), дата входу в етап «від рахунку», чи ще в роботі. */
export interface InvoiceProof { kommoId: number; stage: string; at: string | null; open: boolean }
/** Оплата, що підтверджує роботу. */
export interface PaymentProof { at: string; amount: number }

/** Етапи «від рахунку», на яких угода ще в роботі (усі, крім Успішної): угода, що стоїть тут, — робота триває. */
const OPEN_FROM_INVOICE = STAGE_FROM_INVOICE.filter((s) => s !== 142);

/**
 * Найсвіжіша угода «від рахунку» по кожному клієнту за період [from, to] (YYYY-MM-DD, за Києвом, обидва кінці включно)
 * АБО та, що зараз стоїть на етапі «від рахунку». Перевага — найпізнішій даті входу; відкрита без події в періоді —
 * теж доказ. Клієнта без такої угоди в мапі немає.
 */
export async function invoiceProofByClientKey(db: Db, keys: readonly string[], from: string, to: string): Promise<Map<string, InvoiceProof>> {
  if (!keys.length) return new Map();
  const r = await db.query<{ ck: string; kommo_id: string; pipeline_id: string; status_id: string; at: string | null; open: boolean }>(
    `WITH ev AS (
       SELECT e.kommo_id, MAX(e.changed_at) AS at
         FROM deal_stage_events e
        WHERE e.status_id = ANY($4::bigint[])
          AND (e.changed_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date
        GROUP BY e.kommo_id),
     cand AS (
       SELECT d.client_key AS ck, d.kommo_id, d.pipeline_id, d.status_id,
              GREATEST(ev.at, CASE WHEN d.status_id = 142 AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date
                                   THEN d.closed_at_kommo END) AS at,
              (d.status_id = ANY($5::bigint[])) AS open
         FROM deals d
         LEFT JOIN ev ON ev.kommo_id = d.kommo_id
        WHERE d.client_key = ANY($1::text[]) AND d.pipeline_id = ANY($6::bigint[]) AND d.status_id <> 143
          AND (ev.at IS NOT NULL
               OR d.status_id = ANY($5::bigint[])
               OR (d.status_id = 142 AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date)))
     SELECT DISTINCT ON (ck) ck, kommo_id::text, pipeline_id::text, status_id::text,
            to_char(at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS at, open
       FROM cand
      ORDER BY ck, at DESC NULLS LAST, kommo_id DESC`,
    [keys, from, to, STAGE_FROM_INVOICE, OPEN_FROM_INVOICE, FC_PIPELINES]);
  return new Map(r.rows.map((x) => [x.ck, {
    kommoId: Number(x.kommo_id), stage: stageName(x.pipeline_id, x.status_id), at: x.at, open: x.open,
  }]));
}

/**
 * Найсвіжіша оплата від кожного клієнта за останні `days` днів (той самий добір платежів, що в звірці оплат). Платіж
 * належить клієнту, якщо код платника (лише цифри, без ведучих нулів) = ЄДРПОУ або ІПН компанії, привʼязаної в Kommo
 * до будь-якої угоди клієнта. Платіж, чий код веде до кількох клієнтів, підтверджує роботу з кожним із них.
 */
export async function paymentProofByClientKey(db: Db, keys: readonly string[], days: number): Promise<Map<string, PaymentProof>> {
  if (!keys.length) return new Map();
  const norm = (col: string) => `NULLIF(ltrim(regexp_replace(COALESCE(${col}, ''), '\\D', '', 'g'), '0'), '')`;
  // Від ОПЛАТ до клієнтів, а не навпаки, і коди — прямим порівнянням (є індекс по ЄДРПОУ): функція над стовпцем компаній
  // вимикала індекс і на всіх ключах адміна давала 5–18 с при стелі запиту 20 с. Ведучі нулі — `lpad` до 8 (ЄДРПОУ) і 10 (ІПН).
  const r = await db.query<{ ck: string; at: string; amount: string }>(
    `WITH p AS (${invoicePaymentsSql(2)}),
     pc AS (SELECT p.booked_on, p.amount, ${norm("p.payer_edrpou")} AS code FROM p),
     codes AS (SELECT DISTINCT code FROM pc WHERE code IS NOT NULL),
     cm AS (
       SELECT k.company_id, c.code FROM codes c JOIN kommo_companies k ON k.edrpou IN (c.code, lpad(c.code, 8, '0'))
       UNION
       SELECT k.company_id, c.code FROM codes c JOIN kommo_companies k ON k.ipn IN (c.code, lpad(c.code, 10, '0')))
     SELECT DISTINCT ON (d.client_key) d.client_key AS ck, pc.booked_on AS at, pc.amount::text AS amount
       FROM pc
       JOIN cm ON cm.code = pc.code
       JOIN deal_companies dc ON dc.company_id = cm.company_id
       JOIN deals d ON d.kommo_id = dc.deal_kommo_id
      WHERE d.client_key = ANY($1::text[])
      ORDER BY d.client_key, pc.booked_on DESC, pc.amount DESC`,
    [keys, String(days)]);
  return new Map(r.rows.map((x) => [x.ck, { at: x.at, amount: Math.round(Number(x.amount) * 100) / 100 }]));
}
