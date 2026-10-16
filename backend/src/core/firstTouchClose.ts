/**
 * ❌ «ЗАКРИТИ УГОДУ В KOMMO» З КАРТКИ «ПЕРШОГО ДОТИКУ» (TOP Weekly 08.10: Олександр — «чи можна провалити угоду звідси»,
 * Роман — «можна»; рішення Романа 16.10.2026 по п.1–5). Щоб тімлід не шукав угоду в CRM.
 *
 *  1. Хто: тімлід (своя команда), адмін, КВП. Менеджеру — ні.
 *  2. Причини — ті самі з Kommo (поле «Причина отказа»), найчастіші зверху; AI підставляє, людина підтверджує.
 *  3. Дві угоди — закривається угода повного циклу; кваліфікація лише тоді, коли іншої немає.
 *  4. Угоду, що вже пішла далеко (від «Умови узгоджені»), з картки НЕ закриваємо — це вже не провал першої розмови.
 *  5. «Повернути» — на той самий етап і воронку, з тим самим записом «хто й коли».
 *
 * Модуль чистий (без `pool` і мережі): правила, вибір угоди, тексти й тіла запитів. Запис у Kommo й журнал — у роуті.
 */
import { REJECT_FIELD } from "./carrierClose.js";

export const FC_PIPELINE = 8921932;
export const QUALIFICATION_PIPELINE = 8921928;
export const LOST = 143;
export const WON = 142;

/**
 * Етапи повного циклу, з яких угоду МОЖНА закрити з картки — до «Умови узгоджені» (порядок заміряно в Kommo 16.10.2026,
 * GET /leads/pipelines/8921932). Від «Умови узгоджені» клієнт уже погодився: кнопка неактивна з поясненням.
 */
export const FC_EARLY_STAGES: ReadonlyMap<number, string> = new Map([
  [69693664, "Неразобранное"],
  [108361876, "Повернуто АІ Відділ якості (на допрацювання)"],
  [69693668, "Взято на прорахунок"],
  [69693672, "Пропозицію зроблено"],
  [69716252, "Відкладений запит"],
]);

/**
 * Причини з Kommo (поле 2097265, заміряно 16.10.2026), упорядковані за частотою в повному циклі за 90 днів.
 * «Видалено за рішенням зустрічі 27.08.2026» — службова, у списку її немає.
 */
export const CLOSE_REASONS: readonly { id: number; label: string }[] = [
  { id: 6343065, label: "Відмова ОПР: не актуально" },
  { id: 6343067, label: "Немає зв'язку" },
  { id: 6340819, label: "Відмова ОПР: дорого" },
  { id: 6345091, label: "Разова поїздка" },
  { id: 6343071, label: "Не зійшлись по ціні" },
  { id: 6343075, label: "Відміна замовлення замовником" },
  { id: 6343043, label: "Перевізник" },
  { id: 6340789, label: "Дубль" },
  { id: 6340787, label: "Нецільове звернення" },
  { id: 6344679, label: "Є інші угоди в роботі" },
  { id: 6340785, label: "Чорний список" },
  { id: 6340817, label: "Відмова секретаря" },
  { id: 6344165, label: "Море/авиа" },
];
export const reasonLabel = (id: number): string | null => CLOSE_REASONS.find((r) => r.id === id)?.label ?? null;

export interface DealState { kommoId: number; pipelineId: number | null; statusId: number | null }

/** Чи можна закрити ЦЮ угоду з картки, і якщо ні — чому (текст для людини). */
export function closeAllowed(d: DealState): { ok: true; stage: string } | { ok: false; why: string } {
  if (d.statusId === LOST) return { ok: false, why: "угоду вже закрито як не реалізовану" };
  if (d.statusId === WON) return { ok: false, why: "угода успішна — закривати нема чого" };
  if (d.pipelineId === FC_PIPELINE) {
    const stage = d.statusId == null ? null : FC_EARLY_STAGES.get(d.statusId);
    return stage ? { ok: true, stage } : { ok: false, why: "угода вже пішла далі «Відкладеного запиту» — з картки її не закриваємо" };
  }
  if (d.pipelineId === QUALIFICATION_PIPELINE) return { ok: true, stage: "кваліфікація" };
  return { ok: false, why: "угода не з повного циклу й не з кваліфікації" };
}

/**
 * Яку угоду розмови закривати (рішення 16.10, п.3): повний цикл першим; кваліфікацію — лише коли угоди повного циклу
 * немає. Інші воронки — ніколи. `null` — закривати нема що.
 */
export function closeTarget(deals: readonly DealState[]): DealState | null {
  return deals.find((d) => d.pipelineId === FC_PIPELINE)
    ?? deals.find((d) => d.pipelineId === QUALIFICATION_PIPELINE)
    ?? null;
}

/**
 * Підказка причини від AI (рішення 16.10, п.2): лише коли розмова сама каже, що сталось. Людина однаково підтверджує.
 *   втрачений лід, «вже знайшли» / «не зараз», відмова після ціни без «дорого» → «Відмова ОПР: не актуально»;
 *   заперечення «дорого» чи відмова після ціни через ціну → «Відмова ОПР: дорого»; інакше — `null`, обирає людина.
 */
export function suggestReason(x: {
  conversationType: string | null;
  objection: { present: boolean; type: string } | null;
  decision: { value: string } | null;
}): number | null {
  const objType = x.objection?.present ? x.objection.type : null;
  if (objType === "price") return 6340819;
  if (x.conversationType === "lead_lost") return 6343065;
  if (objType === "competitor" || objType === "not_now") return 6343065;
  if (x.decision?.value === "declined") return 6343065;
  return null;
}

/** Тіло PATCH /api/v4/leads: «Закрито і не реалізовано» у ТІЙ САМІЙ воронці + причина. */
export function closeDealPayload(d: { kommoId: number; pipelineId: number }, reasonId: number): unknown[] {
  return [{ id: d.kommoId, pipeline_id: d.pipelineId, status_id: LOST,
    custom_fields_values: [{ field_id: REJECT_FIELD, values: [{ enum_id: reasonId }] }] }];
}

/** Повернути: попередні воронка й етап, причину знято. */
export function revertDealPayload(d: { kommoId: number; prevPipelineId: number; prevStatusId: number }): unknown[] {
  return [{ id: d.kommoId, pipeline_id: d.prevPipelineId, status_id: d.prevStatusId,
    custom_fields_values: [{ field_id: REJECT_FIELD, values: null }] }];
}

const kyiv = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Примітка в угоді: хто закрив (технічний користувач API в історії Kommo — не людина), причина, яка розмова. */
export const closeNote = (who: string, reason: string, calledAt: string): string =>
  `Закрито з дашборда («Перший дотик · AI»): ${who}. Причина: «${reason}». Розмова від ${kyiv(calledAt)}. `
  + "Помилка — «Повернути» в картці розмови на дашборді.";
export const revertNote = (who: string): string =>
  `Повернуто з дашборда («Перший дотик · AI»): ${who} — угоду відкрито на попередньому етапі, причину знято.`;

/** Результат задачі робота, яку гасимо разом з угодою (Kommo деякі типи задач без результату не закриває). */
export const CLOSE_TASK_TEXT = "Угоду закрито з дашборда («Перший дотик · AI») як не реалізовану.";

/** Хто може закривати й повертати (рішення 16.10, п.1). Скоуп тімліда — окремо, через `missedScopeFor`. */
export const canCloseDeal = (roleKey: string | null | undefined): boolean =>
  roleKey === "team_lead" || roleKey === "admin" || roleKey === "kvp";
