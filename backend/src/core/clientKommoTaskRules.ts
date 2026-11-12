import { kyivLocalToUtc, nextWorkingDay } from "./callAiPromise.js";

/**
 * 📌 ЗАДАЧА КЛІЄНТУ → УГОДА І ЗАДАЧА В KOMMO (задача 8345; рішення Юлі 12.11.2026, слово Романа 12.11.2026).
 *
 * Менеджер ставить «наступний крок» клієнту в «Клієнти та реактивація» — дашборд сам ставить задачу в Kommo:
 *   • у клієнта Є відкрита угода — задача ставиться В НЕЇ, нова угода не створюється;
 *   • відкритої немає — створюється угода на етапі «Клієнти та реактивація» воронки повного циклу (перед «Взято на
 *     прорахунок»): клієнт дав запит — менеджер рухає її далі звичним шляхом, і гроші йдуть у план;
 *   • відповідальний — менеджер З КАРТКИ КЛІЄНТА в дашборді (не з останньої угоди: та могла лишитись на звільненому);
 *     його немає або він неактивний — той, хто поставив задачу; і цей не годиться — задача чекає з названою причиною.
 * У задачник дашборда нічого не дублюється. Модуль ЧИСТИЙ: тут лише рішення й тіла запитів.
 */
export const REACT_PIPELINE_ID = 8921932;
export const REACT_STATUS_ID = 114070576;
export const KOMMO_CLOSED_STATUSES: readonly number[] = [142, 143];
/** Після стількох невдалих спроб задача перестає повторюватись сама й лишається з причиною на екрані. */
export const PUSH_MAX_ATTEMPTS = 5;
/** За один прохід джоби в Kommo йде не більше стількох задач із черги: перенесення старих — порціями, щоб помилку
 *  в тілі запиту було видно на трьох задачах, а не на всіх одразу (тест Юлі — «на 3 клієнтах»). */
export const PUSH_PER_RUN = 3;
/** Година строку задачі за Києвом: Kommo вимагає мить, а крок у дашборді має лише дату. */
export const DUE_TIME_KYIV = "18:00:00";
export const DONE_IN_DASHBOARD_TEXT = "Виконано в дашборді («Клієнти та реактивація»)";

export interface OpenDealCandidate { id: number; statusId: number; createdAt: number; deleted?: boolean }

/** Відкрита угода клієнта: не закрита й не видалена; з кількох — найновіша. `null` — відкритої немає. */
export function pickOpenDeal(deals: readonly OpenDealCandidate[]): number | null {
  const open = deals.filter((d) => !d.deleted && !KOMMO_CLOSED_STATUSES.includes(d.statusId));
  if (!open.length) return null;
  return open.reduce((a, b) => (b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.id > a.id) ? b : a)).id;
}

export interface OwnerCandidate { managerId: number | null; kommoUserId: number | null; active: boolean }
export type OwnerPick = { ok: true; kommoUserId: number; from: "card" | "author" } | { ok: false; error: string };

/** Відповідальний: менеджер картки клієнта; інакше автор задачі; обидва мусять бути активні й мати акаунт Kommo. */
export function pickOwner(card: OwnerCandidate | null, author: OwnerCandidate | null): OwnerPick {
  const good = (c: OwnerCandidate | null): c is OwnerCandidate & { kommoUserId: number } => !!c && c.active && c.kommoUserId != null;
  if (good(card)) return { ok: true, kommoUserId: card.kommoUserId, from: "card" };
  if (good(author)) return { ok: true, kommoUserId: author.kommoUserId, from: "author" };
  return { ok: false, error: "немає активного відповідального з акаунтом Kommo: ні менеджера клієнта, ні автора задачі" };
}

/** Строк задачі в Kommo, unix: дата кроку о 18:00 за Києвом; кроку без дати — кінець наступного робочого дня. */
export function dueUnix(due: string | null, now: Date): number {
  const day = due ?? nextWorkingDay(now);
  return Math.floor(kyivLocalToUtc(day, DUE_TIME_KYIV).getTime() / 1000);
}

export const leadName = (clientName: string | null, clientKey: string): string =>
  `${(clientName ?? "").trim() || clientKey} — клієнти та реактивація`;

export function leadBody(a: { clientName: string | null; clientKey: string; kommoUserId: number; contactIds: readonly number[]; companyId: number | null }) {
  const embedded: { contacts?: { id: number }[]; companies?: { id: number }[] } = {};
  if (a.contactIds.length) embedded.contacts = a.contactIds.map((id) => ({ id }));
  if (a.companyId != null) embedded.companies = [{ id: a.companyId }];
  return [{ name: leadName(a.clientName, a.clientKey), pipeline_id: REACT_PIPELINE_ID, status_id: REACT_STATUS_ID,
    responsible_user_id: a.kommoUserId, _embedded: embedded }];
}

export function taskBody(a: { text: string; due: string | null; leadId: number; kommoUserId: number }, now: Date) {
  return [{ text: a.text, complete_till: dueUnix(a.due, now), entity_id: a.leadId, entity_type: "leads" as const,
    responsible_user_id: a.kommoUserId, task_type_id: 1 }];
}

export const closeTaskBody = (taskId: number) => [{ id: taskId, is_completed: true, result: { text: DONE_IN_DASHBOARD_TEXT } }];
