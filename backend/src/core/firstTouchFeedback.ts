/**
 * 💬 «ЗВОРОТНИЙ ЗВʼЯЗОК» З РОЗМОВИ «ПЕРШОГО ДОТИКУ» (задача 7183, Юля 26.10.2026; рішення Романа 28.10.2026, п.3 «б»).
 * Тімлід бачить, що система помилилась, пише чому — і це йде в розділ «Зворотний звʼязок» (той самий, що читає Роман),
 * з підставленими розмовою, угодою й менеджером, щоб не шукати, про що мова.
 *
 * Модуль чистий: хто може і тіло звернення для `feedbackForm.validateFeedback`. Запис — у роуті.
 */

/** Хто бачить кнопку й пише: тімлід, КВП, адмін. Менеджеру — ні (інакше «система неправа» на кожну розмову без ціни). */
export const canSendCallFeedback = (roleKey: string | null | undefined): boolean =>
  roleKey === "team_lead" || roleKey === "kvp" || roleKey === "admin";

export const CALL_FEEDBACK_SECTION = "Перший дотик · AI";
export const CALL_FEEDBACK_MAX = 2000;

const kyiv = (iso: string) => new Date(iso).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Тіло для `validateFeedback` (вид «Не працює»): текст тімліда — «Що сталося», решта підставляється. */
export function callFeedbackBody(c: { uniqueid: string; calledAt: string; managerName: string | null; kommoIds: readonly number[] }, text: string) {
  const deals = c.kommoIds.length ? `угода ${c.kommoIds.join(", ")}` : "угоду не знайдено";
  return {
    kind: "bug", section: CALL_FEEDBACK_SECTION, impact: "minor",
    fields: {
      where: `Розмова ${kyiv(c.calledAt)}, менеджер ${c.managerName ?? "невідомий"}`,
      steps: "Відкрив розмову в «Першому дотику · AI»",
      expected: "Розбір AI відповідає розмові",
      actual: text.trim().slice(0, CALL_FEEDBACK_MAX),
      example: `${deals} · розмова ${c.uniqueid}`,
    },
  };
}
