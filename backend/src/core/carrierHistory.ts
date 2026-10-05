import { PAYMENT_REQUEST_PIPELINE } from "./paymentRequests.js";
import { CARRIER_STAGE } from "./carrierCallRules.js";

/**
 * 🚚 «ПЕРЕВІЗНИК» ЗА ІСТОРІЄЮ CRM — ТЗ Юлії 17.09.2026 «автозакриття пропущених», блок 1 (задача 4373;
 * рішення Романа 02.10.2026: робимо без Lardi — біржа не відповідає з 28.09).
 *
 * ТЗ: «якщо по номеру вже є закрита угода з причиною „Перевізник“ — нова угода закривається автоматично з тією ж
 * причиною, задача менеджеру не створюється. Виняток: не закривати, якщо по цьому номеру є угода в „Успіх“ або
 * угода в роботі. Перевізник може подзвонити як замовник».
 *
 * НОМЕР → УГОДИ — двома шляхами, бо телефонія номер у поле контакту не пише, а кладе в НАЗВУ угоди
 * («380686601622»; той самий урок, що в Espo-фільтрі 03.09): (а) назва угоди рівно з цифр номера (індекс
 * `idx_deals_name_phone`), (б) телефони контактів угоди (`contact_phones` → `deal_contacts`).
 *
 * 🔴 ВИНЯТОК «Є УГОДА В УСПІХ АБО В РОБОТІ» — ЛИШЕ ПО УГОДАХ ЗАМОВНИКА. Воронки перевізника (оплата перевізнику
 * 7341740 — 13 тис. «виграних» по 0 ₴; реєстрація перевізників Get_Cargo 13905312; архівна «Адмін» 7491756) —
 * не «перевізник як замовник», а сам перевізник; зарахувати їх винятком означало б не закривати рівно тих, кого
 * треба. Так само не виняток — угода на етапі фільтра «Дзвінки на мобільні» (її створив цей самий дзвінок) і сама
 * угода, яку перевіряємо.
 *
 * Модуль чистий (без `pool`): віддає SQL-вираз, який вставляють у запити сигналу, перерахунку й «Відсіву»; гейти
 * ганяють його на своєму кластері.
 */
export const CARRIER_REJECT_REASON = "Перевізник";
export const LOST_STATUS_ID = 143;
export const NOT_CLIENT_PIPELINES: readonly number[] = [PAYMENT_REQUEST_PIPELINE, 7491756, 13905312];
export const AUTO_CARRIER_TAG = "авто-перевізник";

/** Цифри з назви угоди — той самий вираз, що в індексі `idx_deals_name_phone` (інакше індекс не візьметься). */
export const NAME_DIGITS = (alias: string): string => `regexp_replace(${alias}.name, '\\D', '', 'g')`;

/** Угоди номера: за назвою й за телефонами контактів. `phone` і `self` — SQL-вирази. */
const phoneDeals = (phone: string, a: string): string => `(
    SELECT ${a}d.kommo_id, ${a}d.status_id, ${a}d.pipeline_id, ${a}d.reject_reason FROM deals ${a}d
     WHERE ${NAME_DIGITS(`${a}d`)} = ${phone}
    UNION
    SELECT ${a}d.kommo_id, ${a}d.status_id, ${a}d.pipeline_id, ${a}d.reject_reason
      FROM contact_phones ${a}cp JOIN deal_contacts ${a}dc ON ${a}dc.contact_id = ${a}cp.contact_id
      JOIN deals ${a}d ON ${a}d.kommo_id = ${a}dc.deal_kommo_id
     WHERE ${a}cp.phone = ${phone})`;

/**
 * SQL-вираз: `kommo_id` найсвіжішої угоди номера, закритої як «Перевізник», — або NULL, якщо такої немає АБО по
 * номеру є угода замовника в «Успіх» чи в роботі (виняток ТЗ). `self` — угода, яку перевіряємо (NULL — немає).
 * `a` — префікс аліасів, щоб вираз можна було вкласти в запит із власними `d`/`cp`.
 */
export function carrierHistorySql(phone: string, self = "NULL::bigint", a = "ch_"): string {
  return `(CASE WHEN EXISTS (
      SELECT 1 FROM ${phoneDeals(phone, `${a}x`)} ${a}e
       WHERE ${a}e.kommo_id IS DISTINCT FROM ${self}
         AND ${a}e.status_id <> ${String(LOST_STATUS_ID)}
         AND ${a}e.pipeline_id <> ALL (ARRAY[${NOT_CLIENT_PIPELINES.join(",")}]::bigint[])
         AND NOT (${a}e.pipeline_id = ${String(CARRIER_STAGE.pipelineId)} AND ${a}e.status_id = ${String(CARRIER_STAGE.statusId)}))
    THEN NULL
    ELSE (SELECT max(${a}h.kommo_id) FROM ${phoneDeals(phone, `${a}y`)} ${a}h
           WHERE ${a}h.status_id = ${String(LOST_STATUS_ID)} AND ${a}h.reject_reason = '${CARRIER_REJECT_REASON}'
             AND ${a}h.kommo_id IS DISTINCT FROM ${self})
    END)`;
}

/** Причина закриття задачі «передзвони» на номер перевізника. Префікс — контракт із фронтом (`#462`). */
export const carrierTaskCloseReason = (dealId: number | string): string =>
  `Закрито автоматично: номер у CRM уже закривали як «${CARRIER_REJECT_REASON}» (угода №${String(dealId)}) — передзвонювати не треба. `
  + "Помилка — відкрийте задачу знову.";

/** Примітка в угоду Kommo, закриту за історією. */
export const historyCloseNote = (dealId: number | string): string =>
  `Закрито дашбордом: номер уже закривали як «${CARRIER_REJECT_REASON}» (угода №${String(dealId)}). Тег «${AUTO_CARRIER_TAG}», `
  + "джерело: історія CRM. Помилка — поверніть угоду на етап у вкладці «Перевізники за розмовою».";

/**
 * Шлях до ВІДКРИТИХ задач угод у Kommo. 🔴 `filter[is_completed]=0` — СКАЛЯРОМ: у формі масиву (`[]=0`) Kommo фільтр
 * мовчки ігнорує й віддає й завершені (заміряно в Espo-фільтрі 03.09.2026). Тому споживач ще й перевіряє
 * `is_completed` кожної задачі — другий рубіж.
 */
export function openTasksPath(leadIds: readonly number[]): string {
  const ids = leadIds.map((id) => `filter[entity_id][]=${String(id)}`).join("&");
  return `/api/v4/tasks?filter[entity_type]=leads&filter[is_completed]=0&${ids}&limit=250`;
}

export const closeTasksBody = (taskIds: readonly number[], resultText: string): unknown[] =>
  taskIds.map((id) => ({ id, is_completed: true, result: { text: resultText } }));
