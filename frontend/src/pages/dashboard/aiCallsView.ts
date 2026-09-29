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
  not_queued: { label: "Ще не в черзі", tone: "muted", hint: "Джоба бере угоди, створені з 20.09.2026 і не старші за 30 днів, щогодини о :45; найновіші — першими. Раніші угоди не аналізуються." },
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

export type AiFilter = "all" | "done" | "broken" | "price" | "objection" | "noDeadline" | "notDone";
export const FILTERS: readonly { key: AiFilter; label: string }[] = [
  { key: "all", label: "Усі" },
  { key: "done", label: "Проаналізовано" },
  { key: "broken", label: "Не передзвонив" },
  { key: "price", label: "Обговорили ціну" },
  { key: "objection", label: "Є заперечення" },
  { key: "noDeadline", label: "Обіцянка без строку" },
  { key: "notDone", label: "Ще не проаналізовано" },
];

export interface FilterableRow {
  state: AiCallState;
  promiseState?: PromiseStateT | null;
  priceDiscussed: boolean | null;
  objections: number;
  promises: number;
  promisesWithDeadline: number;
}

export function matchesFilter(r: FilterableRow, f: AiFilter): boolean {
  if (f === "done") return r.state === "done";
  if (f === "broken") return r.promiseState === "broken";
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

/**
 * Дата старту аналізу — дзеркало `FIRST_TOUCH_RULE.startDate` у ядрі (рішення власника 28.09.2026).
 * Що вони збігаються, стереже гейт `#786`.
 */
export const AI_START_DATE = "2026-09-20";

/** Типовий період — вікно, яке бере джоба: від пізнішого з дати старту й «сьогодні − 29 днів». */
export function aiDefaultPeriod(today: string): PeriodState {
  const rolling = addDays(today, -29);
  const from = rolling > AI_START_DATE ? rolling : AI_START_DATE;
  return { mode: "range", anchor: today, focusDay: today, rangeFrom: from, rangeTo: today };
}

/**
 * Чи остання помилка джоби АКТУАЛЬНА. `job_runs` свідомо не стирає помилку на успіху (історія збоїв не
 * зникає), тож помилка, після якої вже були успішні запуски, — минуле, а не стан. Червоним — лише
 * помилка без пізнішого успіху. Невідомий час помилки — актуальна (невідоме не ховаємо).
 */
export function jobErrorIsCurrent(job: { lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null } | null): boolean {
  if (!job?.lastError) return false;
  if (!job.lastSuccessAt || !job.lastErrorAt) return true;
  return Date.parse(job.lastErrorAt) > Date.parse(job.lastSuccessAt);
}

/**
 * 🔗 ПРЯМЕ ПОСИЛАННЯ НА КАРТКУ ДЗВІНКА — `/ai-calls?call=<uniqueid>` (прохання Романа 29.09.2026: картку
 * можна переслати колезі). Той самий прийом, що `?id=` у задачнику (`taskDeepLink.ts`). Ідентифікатор
 * Ringostat — літери, цифри, `.`, `_`, `-`; сміття → `null`, а не запит із ним на сервер.
 */
export function parseCallParam(search: string): string | null {
  const raw = new URLSearchParams(search).get("call")?.trim() ?? "";
  return /^[\w.-]{1,100}$/.test(raw) ? raw : null;
}

/** Адреса з `?call=` (або без нього) — решта параметрів і шлях лишаються як були. */
export function withCallParam(href: string, uniqueid: string | null): string {
  const u = new URL(href);
  if (uniqueid) u.searchParams.set("call", uniqueid); else u.searchParams.delete("call");
  return u.pathname + u.search + u.hash;
}

export type DrawerTab = "analysis" | "transcript";

/**
 * Вкладки картки. «Розшифровка» є лише тоді, коли сервер віддав текст: ролі без права (усі, крім
 * адміна й КВП) отримують `transcriptHidden`, і вкладки для них немає зовсім — а не порожня.
 */
export function drawerTabs(transcriptHidden: boolean, turns: number | null): DrawerTab[] {
  return !transcriptHidden && turns != null && turns > 0 ? ["analysis", "transcript"] : ["analysis"];
}

/** Мітка обіцянок у шапці картки: «обіцянки: 1 з 2 зі строком» / «обіцянок немає». */
export function promisesLabel(promises: number, withDeadline: number): string {
  return promises === 0 ? "обіцянок немає" : `обіцянки: ${String(withDeadline)} з ${String(promises)} зі строком`;
}

/** Стан обіцянки менеджера — дзеркало `PromiseState` у `core/callAiPromise.ts`. */
export type PromiseStateT = "kept_talk" | "kept_attempt_only" | "client_called" | "pending" | "broken" | "unverifiable";
export type PipelineGroupT = "full" | "qualification" | "other";

/**
 * Підписи станів обіцянки (П6-Б, рішення Романа 29.09.2026). «Не перевіряється» — обіцянка в месенджер:
 * Ringostat Viber/Telegram не бачить, тож прапорця на ній немає.
 */
export const PROMISE_UI: Readonly<Record<PromiseStateT, { label: string; tone: Tone; hint: string }>> = {
  broken: { label: "Не передзвонив", tone: "bad", hint: "Термін минув, а на номер не було жодного нашого вихідного — ні від менеджера, ні від колег." },
  pending: { label: "Чекає строку", tone: "wait", hint: "Термін ще не минув, нашого дзвінка ще не було." },
  kept_attempt_only: { label: "Лише спроби", tone: "warn", hint: "До терміну ми дзвонили, але розмови не було." },
  client_called: { label: "Клієнт подзвонив сам", tone: "wait", hint: "До терміну клієнт подзвонив нам і поговорив; нашого вихідного не було." },
  kept_talk: { label: "Передзвонив", tone: "ok", hint: "До терміну був наш вихідний із розмовою (колега теж рахується)." },
  unverifiable: { label: "Не перевіряється", tone: "muted", hint: "Обіцянка в месенджер або інша дія — Ringostat цього не бачить, прапорця немає." },
};

export const GROUP_LABEL: Readonly<Record<PipelineGroupT, string>> = { full: "Повний цикл", qualification: "Кваліфікація", other: "Інші воронки" };

export interface ListFilter { group: PipelineGroupT | "all"; teamId: number | null; managerId: number | null; showNonTarget: boolean }
export interface ListFilterRow { pipelineGroup: PipelineGroupT; teamId: number | null; managerId: number | null; nonTarget: boolean }

/**
 * Фільтри списку, окрім кнопок стану (П8-Б): воронка, команда, менеджер; нецільові («Дубль», «Перевізник»)
 * сховані за замовчуванням, а їх кількість видно в перемикачі — «прибрано: N», а не мовчки.
 */
export function applyListFilter<T extends ListFilterRow>(rows: readonly T[], f: ListFilter): T[] {
  return rows.filter((r) => (f.group === "all" || r.pipelineGroup === f.group)
    && (f.teamId == null || r.teamId === f.teamId)
    && (f.managerId == null || r.managerId === f.managerId)
    && (f.showNonTarget || !r.nonTarget));
}

/** Людський підпис терміну обіцянки в картці. */
export function deadlineBasisLabel(basis: string): string {
  return basis === "minutes" ? "як пообіцяв" : basis === "day" ? "до кінця названого дня"
    : basis === "conditional_next_workday" ? "умовна — до кінця наступного робочого дня" : "часу не названо — 20 хв";
}
