import { addDays, type PeriodState } from "./periodRules";

/**
 * 🎧 «ПЕРШИЙ ДОТИК · AI» — чисті правила вигляду, без React (їх виконує гейт бекенду `#833`).
 *
 * Стани — ті самі, що в ядрі (`core/callAiScreen.ts`, `AiCallState`). Кожен має СВІЙ підпис: «ще не
 * в черзі», «не ввімкнено», «стеля», «запису немає» — різні причини, і жодна не показується нулем.
 */
export type AiCallState = "not_queued" | "not_enabled" | "queued" | "capped" | "recording_unavailable"
  | "stt_failed" | "no_text" | "llm_pending" | "llm_failed" | "done";

export type Tone = "ok" | "wait" | "warn" | "bad" | "muted";

export const STATE_UI: Readonly<Record<AiCallState, { label: string; tone: Tone; hint: string }>> = {
  done: { label: "Проаналізовано", tone: "ok", hint: "Є розшифровка й витяг моделі." },
  llm_pending: { label: "Аналіз у черзі", tone: "wait", hint: "Розшифровка готова, витяг моделі — наступним тіком (раз на 10 хв)." },
  queued: { label: "У черзі", tone: "wait", hint: "Дзвінок узято в роботу; розпізнається найближчим тіком." },
  not_queued: { label: "Ще не в черзі", tone: "muted", hint: "Джоба бере угоди, створені з 20.09.2026 і не старші за 30 днів, раз на 10 хв; найновіші — першими. Раніші угоди, лідген і повторні контакти не аналізуються." },
  not_enabled: { label: "Не ввімкнено", tone: "muted", hint: "Ключа постачальника на сервері немає — назовні нічого не надсилається." },
  capped: { label: "Стеля місяця", tone: "warn", hint: "Бюджет місяця вичерпано; дзвінок розбереться, щойно з’явиться бюджет (з 1-го числа або після підняття стелі)." },
  recording_unavailable: { label: "Запису немає", tone: "muted", hint: "Ringostat не віддав запис розмови — аналізувати нічого." },
  no_text: { label: "Розмова без тексту", tone: "muted", hint: "Запис розпізнано, але слів у ньому немає (тиша, гудки, автовідповідач) — аналізувати нічого, тож аналіз не запускається." },
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
  { key: "broken", label: "Немає дзвінка в телефонії" },
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
  // 08.10.2026 (Роман): за замовчуванням — ПОТОЧНИЙ МІСЯЦЬ. Діапазон лишається на випадок перемикання в «Період»:
  // останні 30 днів, але не раніше старту аналізу.
  const rolling = addDays(today, -29);
  const from = rolling > AI_START_DATE ? rolling : AI_START_DATE;
  return { mode: "month", anchor: today, focusDay: today, rangeFrom: from, rangeTo: today };
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
export type PromiseStateT = "kept_talk" | "kept_attempt_only" | "kept_offline" | "client_called" | "late" | "pending" | "broken" | "unverifiable";
export type PipelineGroupT = "full" | "qualification" | "other";

/**
 * Підписи станів обіцянки (П6-Б, рішення Романа 29.09.2026). «Не перевіряється» — обіцянка в месенджер:
 * Ringostat Viber/Telegram не бачить, тож прапорця на ній немає.
 *
 * 📞 01.10.2026: «Не передзвонив» → «Немає дзвінка в телефонії», без червоного. Звірка 30 таких розмов з Ringostat
 * напряму: у 25 нашого дзвінка в телефонії немає зовсім, а керівники знайшли передзвони з мобільного чи в месенджер.
 * Система бачить лише Ringostat — тож це стан даних, а не вирок, доки людина не перевірила.
 */
export const PROMISE_UI: Readonly<Record<PromiseStateT, { label: string; tone: Tone; hint: string }>> = {
  broken: { label: "Немає дзвінка в телефонії", tone: "warn", hint: "Термін минув, а в Ringostat немає дзвінка менеджера, що обіцяв (дзвінки колег не рахуються). Передзвін з мобільного, у месенджер чи з іншого номера система не бачить — перевірте й позначте в картці розмови." },
  late: { label: "Запізнився", tone: "warn", hint: "Менеджер, що обіцяв, передзвонив, але пізніше терміну." },
  pending: { label: "Чекає", tone: "wait", hint: "Термін ще не минув, або дзвінки Ringostat за цей час ще не синхронізовано." },
  kept_attempt_only: { label: "Лише спроби", tone: "warn", hint: "До терміну менеджер, що обіцяв, дзвонив, але розмови не було." },
  client_called: { label: "Клієнт подзвонив сам", tone: "wait", hint: "До терміну клієнт подзвонив нам і поговорив; нашого вихідного не було." },
  kept_offline: { label: "Передзвонив поза телефонією", tone: "ok", hint: "Позначено вручну в картці: передзвін з мобільного, у месенджер чи з іншого номера. Рахується виконаним." },
  kept_talk: { label: "Передзвонив", tone: "ok", hint: "До терміну менеджер, що обіцяв, набрав клієнта й поговорив." },
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
    : basis === "conditional_next_workday" ? "умовна — до кінця наступного робочого дня"
    : basis === "client_asked_next_workday" ? "клієнт просив передзвонити — до кінця наступного робочого дня" : "часу не названо — 20 хв";
}

/** Тип розмови — дзеркало `CONVERSATION_TYPES` у `core/callAiProviders.ts` (ТЗ 30.09.2026). */
export type ConversationTypeT = "cargo_request" | "lead_lost" | "call_later" | "carrier" | "vendor" | "job_seeker" | "wrong_number" | "no_dialog" | "other";
export const TYPE_LABEL: Readonly<Record<ConversationTypeT, string>> = {
  cargo_request: "Запит на перевезення",
  lead_lost: "Втрачений лід (запит неактуальний)",
  call_later: "Незручно говорити — просив передзвонити",
  carrier: "Перевізник",
  vendor: "Нам щось продають",
  job_seeker: "Пошук роботи",
  wrong_number: "Помилились номером",
  no_dialog: "Розмови немає",
  other: "Інше",
};

/** Хвилини реакції коротко: «45 хв», «3 год 10 хв», «2 дн 3 год». */
export function fmtMinutes(m: number): string {
  if (m < 60) return `${String(m)} хв`;
  if (m < 1440) return `${String(Math.floor(m / 60))} год${m % 60 ? ` ${String(m % 60)} хв` : ""}`;
  return `${String(Math.floor(m / 1440))} дн${Math.floor((m % 1440) / 60) ? ` ${String(Math.floor((m % 1440) / 60))} год` : ""}`;
}

export type ListTab = "report" | "excluded";
/** Рядок у вкладці: «Звіт» — `inReport`, «Виключені» — решта. Фільтр за типом — лише у «Виключених». */
export function tabRows<T extends { inReport: boolean; conversationType: ConversationTypeT | null }>(rows: readonly T[], tab: ListTab,
  type: ConversationTypeT | "all" = "all"): T[] {
  return rows.filter((r) => (tab === "report" ? r.inReport : !r.inReport) && (tab === "report" || type === "all" || r.conversationType === type));
}

/**
 * Тіло помилки запиту з `responseType: "blob"`: axios кладе серверний JSON `{ error }` у Blob, і `hiringError` його не
 * бачить — на екрані лишалось безлике «Request failed with status code 404». Тут Blob читається й розбирається; що не є
 * JSON з текстом `error`, повертається як було (тоді працює загальний запасний текст).
 */
export async function blobErrorBody(data: unknown): Promise<unknown> {
  if (typeof (data as { text?: unknown } | null)?.text !== "function") return data;
  try {
    const body = JSON.parse(await (data as Blob).text()) as unknown;
    return typeof (body as { error?: unknown } | null)?.error === "string" ? body : data;
  } catch { return data; }
}

/**
 * Репліка, у якій прозвучала цитата з розбору: перша, чий текст містить цитату (без регістру й зайвих пробілів).
 * −1 — цитати немає або вона не знайдена дослівно (тоді в картці не перемотуємо і не підсвічуємо — не вгадуємо).
 */
export function quoteTurnIndex(turns: readonly { text: string }[] | null, quote: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(quote);
  if (!turns || q.length < 3) return -1;
  return turns.findIndex((t) => norm(t.text).includes(q));
}

// ─── Екран D (08.10.2026): чек-лист і черга розбору ─────────────────────────────────────────────────────────────
// Стани пунктів і «потребує розбору» приходять із сервера (`core/firstTouchTeamReport.ts`); тут — лише підписи й
// складання по менеджерах (частки й середні), без жодного другого правила.

export type CheckMarkT = "y" | "n" | "o";
export interface ChecklistT { request: CheckMarkT; price: CheckMarkT; promise: CheckMarkT; objection: CheckMarkT }
export type ReviewReasonT = "noCall" | "late" | "noPrice" | "lost";

export const CHECK_ITEMS: readonly { key: keyof ChecklistT; label: string }[] = [
  { key: "request", label: "Запит" }, { key: "price", label: "Ціна" }, { key: "promise", label: "Обіцянка" }, { key: "objection", label: "Заперечення" },
];
export const CHECK_MARK_UI: Record<CheckMarkT, { label: string; color: string }> = {
  y: { label: "так", color: "#4ade80" }, n: { label: "ні", color: "#f87171" }, o: { label: "не рахується", color: "#d1d5db" },
};
export const REVIEW_REASON_UI: Record<ReviewReasonT, { label: string; tone: Tone }> = {
  noCall: { label: "Немає дзвінка", tone: "bad" },
  late: { label: "Запізнився", tone: "warn" },
  noPrice: { label: "Без ціни", tone: "warn" },
  lost: { label: "Втрачений лід", tone: "muted" },
};
const REASON_ORDER: Record<ReviewReasonT, number> = { noCall: 0, late: 1, noPrice: 2, lost: 3 };

/** «2/3» — виконано з тих, що рахуються; `null` — ще не розібрано. */
export function scoreLabel(s: { yes: number; total: number } | null): string | null {
  return s && s.total > 0 ? `${String(s.yes)}/${String(s.total)}` : null;
}

/** Середній бал по розмовах із балом, у % (ТЗ 08.10.2026: пунктів 2–4, тож «з N» між розмовами не порівнюється); `null` — немає жодної. */
export function avgScorePct(scores: readonly ({ yes: number; total: number } | null)[]): number | null {
  const xs = scores.filter((s): s is { yes: number; total: number } => s != null && s.total > 0).map((s) => s.yes / s.total);
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : null;
}

/** Частка «так» серед «так + ні» по одному пункту; `null` — пункт ніде не рахувався. */
export function markPct(cls: readonly (ChecklistT | null)[], key: keyof ChecklistT): number | null {
  const ms = cls.filter((c): c is ChecklistT => c != null).map((c) => c[key]).filter((m) => m !== "o");
  return ms.length ? Math.round((ms.filter((m) => m === "y").length / ms.length) * 100) : null;
}

export interface ChecklistLine { managerId: number | null; name: string; calls: number; score: number | null;
  request: number | null; price: number | null; promise: number | null; objection: number | null;
  /** Заперечень було / з них опрацьовано. */
  objections: number; objectionsHandled: number;
  /** Успіх угоди: успішних із розібраних. */
  success: number }
/** Рядок на менеджера: розібрані розмови звіту, середній бал і частка по кожному пункту. Найслабші — згори. */
export function managerChecklist<T extends { inReport: boolean; managerId: number | null; managerName: string | null;
  checklist: ChecklistT | null; checkScore: { yes: number; total: number } | null;
  dealOutcome?: { state: string } | null }>(rows: readonly T[]): ChecklistLine[] {
  const by = new Map<string, T[]>();
  for (const r of rows) if (r.inReport && r.checklist) {
    const k = r.managerId == null ? "none" : String(r.managerId);
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()].map((g) => ({
    managerId: g[0].managerId, name: g[0].managerName ?? "Менеджер невідомий", calls: g.length,
    score: avgScorePct(g.map((r) => r.checkScore)),
    request: markPct(g.map((r) => r.checklist), "request"), price: markPct(g.map((r) => r.checklist), "price"),
    promise: markPct(g.map((r) => r.checklist), "promise"), objection: markPct(g.map((r) => r.checklist), "objection"),
    objections: g.filter((r) => r.checklist!.objection !== "o").length, objectionsHandled: g.filter((r) => r.checklist!.objection === "y").length,
    success: g.filter((r) => r.dealOutcome?.state === "success").length,
  })).sort((a, b) => (a.score ?? 99) - (b.score ?? 99) || a.name.localeCompare(b.name, "uk"));
}

/**
 * Сортування блоку менеджерів кліком по назві колонки (прохання Романа 09.10.2026). Перший клік по колонці з
 * цифрами — найслабші згори (блок для того, щоб знайти, хто просідає), повторний — навпаки. «—» (пункт ніде не
 * рахувався) — ЗАВЖДИ внизу, в обидва боки: інакше порожнеча вилазить угору як найгірший результат.
 */
export type MgrSortKey = "name" | "score" | "request" | "price" | "promise" | "objection" | "success";
export interface MgrSort { key: MgrSortKey; dir: "asc" | "desc" }
export const MGR_SORT_DEFAULT: MgrSort = { key: "score", dir: "asc" };
export const MGR_SORT_KEYS: readonly MgrSortKey[] = ["name", "score", "request", "price", "promise", "objection", "success"];
export function nextMgrSort(cur: MgrSort, key: MgrSortKey): MgrSort {
  return cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}
const mgrValue = (l: ChecklistLine, k: Exclude<MgrSortKey, "name">): number | null =>
  k === "objection" ? (l.objections ? l.objectionsHandled / l.objections : null)
    : k === "success" ? (l.calls ? l.success / l.calls : null)
    : l[k];
export function sortManagerLines(lines: readonly ChecklistLine[], s: MgrSort): ChecklistLine[] {
  const sign = s.dir === "asc" ? 1 : -1;
  const byName = (a: ChecklistLine, b: ChecklistLine) => a.name.localeCompare(b.name, "uk");
  if (s.key === "name") return [...lines].sort((a, b) => sign * byName(a, b));
  const k = s.key;
  return [...lines].sort((a, b) => {
    const va = mgrValue(a, k), vb = mgrValue(b, k);
    if (va == null || vb == null) return va == null && vb == null ? byName(a, b) : va == null ? 1 : -1;
    return sign * (va - vb) || (k === "success" ? sign * (a.success - b.success) : 0) || byName(a, b);
  });
}
/** Збережений вибір із браузера; сміття чи порожнеча — порядок за замовчуванням. */
export function parseMgrSort(raw: string | null): MgrSort {
  const [key, dir] = (raw ?? "").split(":");
  return (MGR_SORT_KEYS as readonly string[]).includes(key) && (dir === "asc" || dir === "desc") ? { key: key as MgrSortKey, dir } : MGR_SORT_DEFAULT;
}

/** Черга розбору: лише ті, що потребують розбору (прапорець сервера); спершу «немає дзвінка», далі новіші. */
export function queueRows<T extends { needsReview: boolean; reviewReason: ReviewReasonT | null; calledAt: string }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.needsReview && r.reviewReason)
    .sort((a, b) => REASON_ORDER[a.reviewReason!] - REASON_ORDER[b.reviewReason!] || b.calledAt.localeCompare(a.calledAt));
}

/** Медіана хвилин (реакція по втрачених) — `null`, якщо даних немає. */
export function medianMin(xs: readonly (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

// ─── Плитки (ТЗ «фінальні доробки» 08.10.2026, пункт 3) ─────────────────────────────────────────────────────────
// ОДНЕ правило на плитку: і число, і список після кліку беруть `TILE_MATCH[k]` — тож вони не можуть розійтися.
// Стани й знаменники — від сервера (`checklist`, `flags`, `dealOutcome`); фронт лише рахує.

export type TileKey = "noCall" | "noPrice" | "objNotHandled" | "lost" | "success";
export interface TileRow {
  promiseState: PromiseStateT | null; checklist: ChecklistT | null; conversationType: ConversationTypeT | null;
  dealOutcome: { state: string } | null; flags: { analysed: boolean; priceable: boolean; agreement: boolean; lost: boolean };
}
export const TILE_MATCH: Record<TileKey, (r: TileRow) => boolean> = {
  noCall: (r) => r.flags.agreement && r.promiseState === "broken",
  noPrice: (r) => r.checklist?.price === "n",
  objNotHandled: (r) => r.checklist?.objection === "n",
  lost: (r) => r.flags.lost,
  success: (r) => r.flags.analysed && r.dealOutcome?.state === "success",
};
/** Скільки успіхів треба в КОЖНІЙ групі, щоб показувати відсоток, а не лише «X з N» (рішення Романа 08.10.2026). */
export const SUCCESS_MIN_FOR_PCT = 30;

export interface TileStats {
  noCall: { n: number; of: number }; price: { yes: number; of: number; pct: number | null };
  objection: { handled: number; of: number; pct: number | null }; lost: number; success: { n: number; of: number };
}
export function tileStats(rows: readonly TileRow[]): TileStats {
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
  const priced = rows.filter((r) => r.checklist && r.checklist.price !== "o");
  const objs = rows.filter((r) => r.checklist && r.checklist.objection !== "o");
  const priceYes = priced.filter((r) => r.checklist!.price === "y").length;
  const handled = objs.filter((r) => r.checklist!.objection === "y").length;
  return {
    noCall: { n: rows.filter(TILE_MATCH.noCall).length, of: rows.filter((r) => r.flags.agreement).length },
    price: { yes: priceYes, of: priced.length, pct: pct(priceYes, priced.length) },
    objection: { handled, of: objs.length, pct: pct(handled, objs.length) },
    lost: rows.filter(TILE_MATCH.lost).length,
    success: { n: rows.filter(TILE_MATCH.success).length, of: rows.filter((r) => r.flags.analysed).length },
  };
}

/** «Ціна названа → успіх» і «не названа → успіх»: числами; відсоток — лише коли в обох групах ≥ `SUCCESS_MIN_FOR_PCT`. */
export function priceSuccessSplit(rows: readonly TileRow[]): { named: { n: number; of: number }; notNamed: { n: number; of: number }; enough: boolean } {
  const win = (r: TileRow) => r.dealOutcome?.state === "success";
  const named = rows.filter((r) => r.checklist?.price === "y"), notNamed = rows.filter((r) => r.checklist?.price === "n");
  const a = { n: named.filter(win).length, of: named.length }, b = { n: notNamed.filter(win).length, of: notNamed.length };
  return { named: a, notNamed: b, enough: a.n >= SUCCESS_MIN_FOR_PCT && b.n >= SUCCESS_MIN_FOR_PCT };
}
