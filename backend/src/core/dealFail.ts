/**
 * ❌ «ПРОВАЛИТИ УГОДУ» З КАРТКИ РОЗМОВИ (ТЗ Юлі 12.10.2026 «Звіт КВП - ядро», розділ 5; коментар Олександра на TOP Weekly
 * 08.10: «а можемо тут її програти?»). Рішення Романа 16.10.2026: натискають менеджер (своя розмова), тімлід (команда),
 * КВП і адмін; причини — УСІ значення поля «Причина отказа» з Kommo.
 *
 * Механізм — той самий, що закриває перевізників (`carrierClose.ts`): угода в Kommo не видаляється, а переходить у
 * «Не реалізовано» (143) своєї ж воронки з причиною в полі `2097265`; у угоду пишеться примітка «хто й чому»; журнал
 * `deal_fail_log` памʼятає, з якого етапу закрито, — «Повернути» ставить угоду рівно туди.
 * Тут — лише чисті правила без імпортів: гейт виконує їх без оточення.
 */

/** Поле «Причина отказа» в Kommo — те саме, що в `carrierClose.REJECT_FIELD`. */
export const FAIL_REASON_FIELD = 2097265;
export const LOST_STATUS = 143;
export const WON_STATUS = 142;

/** Хто може провалити угоду. Скоуп (своя розмова / команда) — окремо, тим самим `missedScopeFor`, що й картка. */
export const FAIL_ROLES: ReadonlySet<string> = new Set(["admin", "kvp", "team_lead", "manager"]);
export const canFailDeal = (roleKey: string | null | undefined): boolean => !!roleKey && FAIL_ROLES.has(roleKey);

/** Закрита угода (успіх або відмова) повторно не «провалюється»: це була б перезапис чужого рішення. */
export const isClosedStatus = (statusId: number | null | undefined): boolean => statusId === WON_STATUS || statusId === LOST_STATUS;

export function failPayload(kommoId: number, pipelineId: number, reasonEnumId: number): unknown[] {
  return [{ id: kommoId, pipeline_id: pipelineId, status_id: LOST_STATUS,
    custom_fields_values: [{ field_id: FAIL_REASON_FIELD, values: [{ enum_id: reasonEnumId }] }] }];
}

/** «Повернути» — на той етап, з якого провалили, і причина знімається. */
export function revertFailPayload(kommoId: number, pipelineId: number, statusId: number): unknown[] {
  return [{ id: kommoId, pipeline_id: pipelineId, status_id: statusId,
    custom_fields_values: [{ field_id: FAIL_REASON_FIELD, values: null }] }];
}

export function failNoteText(who: string, reason: string, comment: string | null): string {
  const c = comment?.trim();
  return `Угоду провалено з дашборда («Перший дотик · AI»): ${who}. Причина: ${reason}.${c ? ` Коментар: ${c}` : ""} `
    + "Помилка — «Повернути» в картці розмови.";
}

export function revertNoteText(who: string): string {
  return `Угоду повернуто з дашборда на попередній етап: ${who}.`;
}

/** Значення причин із відповіді Kommo `GET /leads/custom_fields/{id}` — у порядку `sort`, без порожніх. */
export function reasonsFromField(field: unknown): { id: number; value: string }[] {
  const enums = (field as { enums?: { id?: unknown; value?: unknown; sort?: unknown }[] } | null)?.enums;
  if (!Array.isArray(enums)) return [];
  return enums
    .filter((e) => typeof e.id === "number" && typeof e.value === "string" && e.value.trim() !== "")
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
    .map((e) => ({ id: e.id as number, value: (e.value as string).trim() }));
}
