import { addDays, type PeriodState } from "./periodRules";

/**
 * 🎧 «ПЕРШИЙ ДОТИК · AI» — чисті правила вигляду, без React (їх виконує гейт бекенду `#833`).
 *
 * Стани — ті самі, що в ядрі (`core/callAiScreen.ts`, `AiCallState`). Кожен має СВІЙ підпис: «ще не
 * в черзі», «не ввімкнено», «стеля», «запису немає» — різні причини, і жодна не показується нулем.
 */
export type AiCallState = "not_queued" | "not_enabled" | "queued" | "capped" | "recording_unavailable"
  | "stt_failed" | "llm_pending" | "llm_failed" | "done";

export type Tone = "ok" | "wait" | "warn" | "bad" | "muted";

export const STATE_UI: Readonly<Record<AiCallState, { label: string; tone: Tone; hint: string }>> = {
  done: { label: "Проаналізовано", tone: "ok", hint: "Є розшифровка й витяг моделі." },
  llm_pending: { label: "Аналіз у черзі", tone: "wait", hint: "Розшифровка готова, витяг моделі — наступним тіком (щогодини о :45)." },
  queued: { label: "У черзі", tone: "wait", hint: "Дзвінок узято в роботу; розпізнається найближчим тіком." },
  not_queued: { label: "Ще не в черзі", tone: "muted", hint: "Джоба ще не дійшла до цього дзвінка — вона бере угоди за останні 30 днів щогодини о :45." },
  not_enabled: { label: "Не ввімкнено", tone: "muted", hint: "Ключа постачальника на сервері немає — назовні нічого не надсилається." },
  capped: { label: "Стеля місяця", tone: "warn", hint: "Бюджет місяця вичерпано; дзвінок розбереться, щойно з’явиться бюджет (з 1-го числа або після підняття стелі)." },
  recording_unavailable: { label: "Запису немає", tone: "muted", hint: "Ringostat не віддав запис розмови — аналізувати нічого." },
  stt_failed: { label: "Не розпізнано", tone: "bad", hint: "Сервіс розпізнавання відмовив після всіх спроб; причина — у картці." },
  llm_failed: { label: "Аналіз не вдався", tone: "bad", hint: "Модель повернула непридатну відповідь після всіх спроб; причина — у картці." },
};

export const TONE_COLOR: Readonly<Record<Tone, { bg: string; fg: string }>> = {
  ok: { bg: "var(--ok-bg, #e7f6ec)", fg: "var(--ok-fg, #1d6b3a)" },
  wait: { bg: "var(--info-bg, #e8f0fb)", fg: "var(--info-fg, #2a4f8a)" },
  warn: { bg: "var(--warn-bg, #fff4dc)", fg: "var(--warn-fg, #8a5a00)" },
  bad: { bg: "var(--danger-bg, #fde8e8)", fg: "var(--danger, #b3261e)" },
  muted: { bg: "var(--muted-bg, #f0f1f3)", fg: "var(--text-muted, #5a6676)" },
};

export type AiFilter = "all" | "price" | "objection" | "noDeadline" | "notDone";
export const FILTERS: readonly { key: AiFilter; label: string }[] = [
  { key: "all", label: "Усі" },
  { key: "price", label: "Обговорили ціну" },
  { key: "objection", label: "Є заперечення" },
  { key: "noDeadline", label: "Обіцянка без строку" },
  { key: "notDone", label: "Ще не проаналізовано" },
];

export interface FilterableRow {
  state: AiCallState;
  priceDiscussed: boolean | null;
  objections: number;
  promises: number;
  promisesWithDeadline: number;
}

export function matchesFilter(r: FilterableRow, f: AiFilter): boolean {
  if (f === "price") return r.priceDiscussed === true;
  if (f === "objection") return r.objections > 0;
  if (f === "noDeadline") return r.promises > r.promisesWithDeadline;
  if (f === "notDone") return r.state !== "done";
  return true;
}

/** Хто говорить на каналі. Канал менеджера визначила модель зі змісту; невідомо — чесно «Канал N». */
export function speakerOf(channel: number, managerChannel: number | null): string {
  if (managerChannel == null) return `Канал ${String(channel)}`;
  return channel === managerChannel ? "Менеджер" : "Клієнт";
}

export function mmss(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}

/** «через 3 год 10 хв» між розмовою й нашим наступним вихідним; `null` → «вихідних не було». */
export function afterLabel(fromIso: string, toIso: string | null): string {
  if (!toIso) return "після розмови наших вихідних на цей номер не було";
  const min = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  const span = h > 0 ? `${String(h)} год ${String(m)} хв` : `${String(m)} хв`;
  return `наш наступний вихідний — через ${span}`;
}

/** Типовий період — останні 30 днів: рівно вікно, яке бере джоба. */
export function aiDefaultPeriod(today: string): PeriodState {
  const from = addDays(today, -29);
  return { mode: "range", anchor: today, focusDay: today, rangeFrom: from, rangeTo: today };
}
