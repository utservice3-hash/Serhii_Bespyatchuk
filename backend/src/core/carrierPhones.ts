import type { Db } from "./adCallFacts.js";
import { CARRIER_REJECT_REASON, LOST_STATUS_ID, NOT_CLIENT_PIPELINES, NAME_DIGITS } from "./carrierHistory.js";
import { CARRIER_STAGE } from "./carrierCallRules.js";
import { LARDI_SIDE, PHONE9 } from "./carrierLardi.js";

/**
 * 📵 НОМЕРИ ПЕРЕВІЗНИКІВ НА ЕКРАНІ КЛІЄНТІВ — задача 7359 (ТЗ Юлії «Контакти клієнтів», етап 1).
 *
 * ТЗ: перевізник — «номер з Lardi чи номер, який уже закривали як „Перевізник“». Три наслідки, усі з ОДНОГО
 * визначення: (1) «Якість даних» показує клієнтів без номера замовника або з номером перевізника; (2) розмова на
 * номер перевізника не рахується розмовою з клієнтом; (3) нічийного клієнта, у якого ВСІ номери перевізницькі,
 * не можна «Взяти в роботу».
 *
 * 🔴 ВИНЯТОК — НОМЕР З УГОДОЮ ЗАМОВНИКА («Успіх» або в роботі) ПЕРЕВІЗНИКОМ НЕ Є (рішення Романа 03.11.2026, «1 так»).
 * Те саме правило, що в `carrierHistory.ts` (перевізник може замовляти), і тими самими межами: воронки перевізника
 * (`NOT_CLIENT_PIPELINES`) і етап фільтра «Дзвінки на мобільні» винятком не є. Номер → угоди — тими самими двома
 * шляхами: назва угоди з цифр номера і телефони контактів угоди.
 * 📐 ЦІНА ВИНЯТКУ, заміряна 03.11.2026 на проді: у клієнтів із 2+ оплатами 1 940 пар «клієнт · номер» з Lardi чи
 * історії, і 1 779 з них — номери, приписані до ВЛАСНИХ угод клієнта в роботі чи в «Успіх». Лишається 30 пар /
 * 18 клієнтів (без винятку було б 476). Розмов за 90 днів на кандидатів 11 713 із 49 961, після винятку — 7 688.
 *
 * 🧊 ДОВІДНИК — ЗНІМОК (`carrier_phones`), а не вираз на льоту: на льоту це 1,8 с на запит, а читають його
 * сотні рядків списку клієнтів на кожному відкритті екрана. Перебудовує джоба `rebuildCarrierPhones` (щогодини + старт). Знімок без
 * історії (правило 17 кореня): номер, який став замовником, перестає бути перевізником і для СТАРИХ дзвінків —
 * і це правильно, бо «чий це номер» — властивість номера, а не дня.
 * ⚠️ Порожній довідник = нічого не виключено (поведінка до задачі). Тому «Якість даних» показує, коли його
 * перебудовано і скільки в ньому номерів: порожньо ≠ «перевізників немає».
 *
 * Номер звіряємо за ОСТАННІМИ 9 ЦИФРАМИ (Lardi пише «+380…», телефонія — «380…»), як у `carrierLardi.ts`.
 * Модуль чистий (без `pool`): SQL-тексти й чисті функції; БД приходить параметром.
 */

/** Звідки номер у довіднику. `historyDeal` — найсвіжіша угода, закрита як «Перевізник». */
export interface CarrierPhoneSource { lardi: boolean; history: boolean; historyDeal: number | null; lardiCompany: string | null }

/** Угоди номера (обидва шляхи) — CTE-тіло з колонками угоди і `p9`. */
const DEAL_PHONES_SQL = `
  SELECT d.kommo_id, d.status_id, d.pipeline_id, d.reject_reason, ${PHONE9("cp.phone")} AS p9
    FROM contact_phones cp JOIN deal_contacts dc ON dc.contact_id = cp.contact_id
    JOIN deals d ON d.kommo_id = dc.deal_kommo_id
  UNION ALL
  SELECT d.kommo_id, d.status_id, d.pipeline_id, d.reject_reason, right(${NAME_DIGITS("d")}, 9)
    FROM deals d WHERE ${NAME_DIGITS("d")} ~ '^380[0-9]{9}$'`;

/** Угода замовника — та сама умова, що виняток у `carrierHistorySql`. `a` — аліас рядка угоди. */
const CLIENT_DEAL_SQL = (a: string): string =>
  `${a}.status_id <> ${String(LOST_STATUS_ID)}
     AND ${a}.pipeline_id <> ALL (ARRAY[${NOT_CLIENT_PIPELINES.join(",")}]::bigint[])
     AND NOT (${a}.pipeline_id = ${String(CARRIER_STAGE.pipelineId)} AND ${a}.status_id = ${String(CARRIER_STAGE.statusId)})`;

/** Рядки довідника: номер (9 цифр) з Lardi-машин або «Перевізник» в історії, мінус номери з угодою замовника. */
export const CARRIER_PHONES_SELECT_SQL = `
  WITH dp AS (${DEAL_PHONES_SQL}),
  lardi AS (SELECT ${PHONE9("p->>'n'")} AS p9, max(NULLIF(o.company, '')) AS company
              FROM lardi_offers o, jsonb_array_elements(o.phones) p WHERE o.side = '${LARDI_SIDE}' GROUP BY 1),
  hist AS (SELECT p9, max(kommo_id) AS deal FROM dp
            WHERE status_id = ${String(LOST_STATUS_ID)} AND reject_reason = '${CARRIER_REJECT_REASON}' GROUP BY p9),
  client AS (SELECT DISTINCT p9 FROM dp WHERE ${CLIENT_DEAL_SQL("dp")})
  SELECT COALESCE(l.p9, h.p9) AS p9, (l.p9 IS NOT NULL) AS via_lardi, (h.p9 IS NOT NULL) AS via_history,
         h.deal AS history_deal, l.company AS lardi_company
    FROM lardi l FULL JOIN hist h ON h.p9 = l.p9
   WHERE length(COALESCE(l.p9, h.p9)) = 9
     AND NOT EXISTS (SELECT 1 FROM client c WHERE c.p9 = COALESCE(l.p9, h.p9))`;

/**
 * Перебудувати довідник повністю. Повертає кількість номерів. `db` — ОДНЕ зʼєднання (не пул): перебудова — одна
 * транзакція, щоб читач не побачив порожнього довідника посередині.
 */
export async function rebuildCarrierPhones(db: Db): Promise<number> {
  await db.query("BEGIN");
  try {
    await db.query("DELETE FROM carrier_phones");
    const r = await db.query(`INSERT INTO carrier_phones (p9, via_lardi, via_history, history_deal, lardi_company)
                              ${CARRIER_PHONES_SELECT_SQL}`);
    await db.query("COMMIT");
    return r.rowCount ?? 0;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

/**
 * SQL-умова «дзвінок НЕ на номер перевізника» для рядка `ringostat_calls` з аліасом `a`. `client_phone` уже
 * нормалізований (`utils/phone.ts`, лише цифри), тож останні 9 цифр — `right(…, 9)`, як `PHONE9` для довідника.
 * Номера немає (NULL) — дзвінок лишається: невідомий номер не доказ перевізника.
 */
export const notCarrierCallSql = (a: string): string =>
  `NOT EXISTS (SELECT 1 FROM carrier_phones cpx WHERE cpx.p9 = right(${a}.client_phone, 9))`;

/** Те саме, навпаки: дзвінок на номер перевізника (для лічильника «не враховано»). */
export const carrierCallSql = (a: string): string =>
  `EXISTS (SELECT 1 FROM carrier_phones cpx WHERE cpx.p9 = right(${a}.client_phone, 9))`;

/**
 * Номери клієнтів: телефони контактів їхніх угод + телефони з КАРТКИ КОМПАНІЇ їхніх угод + сам ключ, якщо це телефон
 * (фізособа). `$1` — масив ключів. По рядку на (клієнт, номер), з позначкою довідника й звідки номер.
 * ☎️ Картка компанії — з 03.11.2026: у частини клієнтів у Kommo немає контактів, телефон лише в полі «Телефон»
 * компанії, і без нього «немає жодного номера» було неправдою дашборду. Номер і в контакті, і в компанії — `contact`.
 */
export const CLIENT_PHONES_SQL = `
  WITH ph AS (
    SELECT d.client_key, cp.phone, 'contact'::text AS src FROM deals d
      JOIN deal_contacts dc ON dc.deal_kommo_id = d.kommo_id JOIN contact_phones cp ON cp.contact_id = dc.contact_id
     WHERE d.client_key = ANY($1)
    UNION
    SELECT d.client_key, unnest(kc.phones), 'company' FROM deals d
      JOIN deal_companies dco ON dco.deal_kommo_id = d.kommo_id JOIN kommo_companies kc ON kc.company_id = dco.company_id
     WHERE d.client_key = ANY($1)
    UNION
    SELECT k, k, 'contact' FROM unnest($1::text[]) k WHERE k ~ '^[0-9]{9,15}$'),
  one AS (SELECT DISTINCT ON (client_key, phone) client_key, phone, src FROM ph ORDER BY client_key, phone, src DESC)
  SELECT one.client_key, one.phone, one.src, c.via_lardi, c.via_history, c.history_deal::text AS history_deal, c.lardi_company
    FROM one LEFT JOIN carrier_phones c ON c.p9 = right(one.phone, 9)
   ORDER BY one.client_key, one.phone`;

/** Звідки номер: контакт угоди (або ключ фізособи) чи картка компанії. */
export type PhoneSource = "contact" | "company";
export interface ClientPhone { phone: string; source: PhoneSource; carrier: CarrierPhoneSource | null }

/** Номери клієнтів пакетом. Клієнт без жодного номера в мапу не потрапляє — `verdictOf([])` = `no_phone`. */
export async function clientPhones(db: Db, keys: readonly string[]): Promise<Map<string, ClientPhone[]>> {
  const out = new Map<string, ClientPhone[]>();
  if (keys.length === 0) return out;
  const r = await db.query<{ client_key: string; phone: string; src: PhoneSource; via_lardi: boolean | null; via_history: boolean | null;
    history_deal: string | null; lardi_company: string | null }>(CLIENT_PHONES_SQL, [keys]);
  for (const x of r.rows) {
    const carrier = x.via_lardi == null ? null : {
      lardi: x.via_lardi, history: Boolean(x.via_history),
      historyDeal: x.history_deal == null ? null : Number(x.history_deal), lardiCompany: x.lardi_company,
    };
    const list = out.get(x.client_key) ?? [];
    list.push({ phone: x.phone, source: x.src, carrier });
    out.set(x.client_key, list);
  }
  return out;
}

/**
 * Стан номерів клієнта — ОДНА функція для «Якості даних» і для «Взяти в роботу»:
 * - `no_phone` — номерів немає зовсім (без номера замовника);
 * - `only_carrier` — номери є, але всі перевізницькі (теж без номера замовника);
 * - `has_carrier` — є номер замовника і є перевізницький;
 * - `ok` — перевізницьких немає.
 */
export type PhoneVerdict = "no_phone" | "only_carrier" | "has_carrier" | "ok";

export function verdictOf(phones: readonly { carrier: unknown }[]): PhoneVerdict {
  if (phones.length === 0) return "no_phone";
  const n = phones.filter((p) => p.carrier != null).length;
  if (n === 0) return "ok";
  return n === phones.length ? "only_carrier" : "has_carrier";
}

/** «Взяти в роботу» заборонено ЛИШЕ коли всі номери перевізницькі; без номерів — можна (ТЗ про це не каже). */
export const claimBlocked = (v: PhoneVerdict): boolean => v === "only_carrier";

export const CLAIM_BLOCKED_ERROR =
  "У клієнта лише номери перевізників (Lardi або закривали як «Перевізник») — взяти в роботу не можна. "
  + "Спершу додайте в Kommo номер замовника.";

/**
 * Скільки клієнтів зі списку мають компанію, чий телефон ще НЕ ПРОЧИТАНО з Kommo (`phones IS NULL`). Ненуль = «немає
 * номера» для них може бути неправдою, і екран мусить це сказати (невідоме — словами, а не порожнім місцем).
 */
export const CLIENTS_WITH_UNREAD_COMPANY_SQL = `
  SELECT COUNT(DISTINCT d.client_key)::int AS n FROM deals d
    JOIN deal_companies dco ON dco.deal_kommo_id = d.kommo_id JOIN kommo_companies kc ON kc.company_id = dco.company_id
   WHERE d.client_key = ANY($1) AND kc.phones IS NULL`;
