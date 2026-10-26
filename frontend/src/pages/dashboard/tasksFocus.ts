/**
 * 🎯 НОВИЙ ЕКРАН ЗАДАЧНИКА «ЩО ГОРИТЬ» — чисті правила без React (задачі №6379 і №5998,
 * рішення Романа 20.10.2026: варіант Б, без цілі тижня, галочка ставить «Готово», новий дизайн
 * за замовчуванням із кнопкою повернення до старого, вибір — у браузері).
 *
 * Тут лише рішення «до якої групи належить задача», «що таке цей тиждень» і «який дизайн
 * показати». `TasksFocusView.tsx` їх малює, а гейти `#1960`–`#1964` виконують ці функції
 * напряму — правило існує в одному місці, тож показ і перевірка не розходяться.
 *
 * 🔴 ЛІЧИЛЬНИК — ЦЕ ДОВЖИНА ГРУПИ, А НЕ ОКРЕМИЙ ПІДРАХУНОК. Вимога №5998 «цифри збігаються зі
 * списком» тримається побудовою: число в плитці береться з тих самих масивів, що малюються
 * рядками. Другий підрахунок поруч розійшовся б зі списком при першій же правці фільтра.
 *
 * Модуль без імпортів — його імпортує Node у гейтах, а там відносні шляхи без розширення
 * не розвʼязуються.
 */

/** Групи активних задач за терміном. Порядок масиву — порядок на екрані. */
export type FocusBucket = "late" | "today" | "week" | "later" | "none";
export const FOCUS_BUCKETS: { key: FocusBucket; label: string }[] = [
  { key: "late", label: "Прострочені" },
  { key: "today", label: "Сьогодні" },
  { key: "week", label: "До кінця тижня" },
  { key: "later", label: "Пізніше" },
  { key: "none", label: "Без дедлайну" },
];

/** Що з задачі потрібно правилам. `deadline` і `doneAt` — київські дати `YYYY-MM-DD`. */
export interface FocusTask {
  status: string;
  deadline?: string | null;
  doneAt?: string | null;
}

/** Сьогоднішня дата за Києвом (`YYYY-MM-DD`), а не за часовим поясом браузера чи UTC. */
export function kyivDate(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
}

/**
 * Понеділок і неділя тижня, якому належить календарна дата. Рахується по самій даті (полудень
 * UTC як якір), тож перехід на літній час і пояс браузера межу не зсувають.
 */
export function weekOf(day: string): { start: string; end: string } {
  const d = new Date(`${day}T12:00:00Z`);
  const fromMonday = (d.getUTCDay() + 6) % 7;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const start = d.getTime() - fromMonday * 86_400_000;
  return { start: iso(start), end: iso(start + 6 * 86_400_000) };
}

/**
 * Група активної задачі. Дедлайн — останній день, коли її ще можна зробити вчасно, тож
 * «прострочена» — лише коли цей день уже минув (дедлайн сьогодні — це «Сьогодні»).
 * «До кінця тижня» — до неділі включно.
 */
export function bucketOf(t: FocusTask, today: string): FocusBucket {
  if (!t.deadline) return "none";
  if (t.deadline < today) return "late";
  if (t.deadline === today) return "today";
  if (t.deadline <= weekOf(today).end) return "week";
  return "later";
}

/** Виконана в поточному київському тижні (пн–нд). Без дати виконання — ні: «не знаємо коли». */
export function doneThisWeek(t: FocusTask, today: string): boolean {
  if (t.status !== "done" || !t.doneAt) return false;
  const w = weekOf(today);
  return t.doneAt >= w.start && t.doneAt <= w.end;
}

export type FocusGroups<T> = Record<FocusBucket, T[]> & {
  /** Виконані цього тижня — для плитки «Виконано цього тижня» й однойменної групи. */
  doneWeek: T[];
  /** Виконані раніше або невідомо коли — групою внизу, згорнутою. */
  doneEarlier: T[];
};

/**
 * Розкласти задачі по групах. Кожна задача потрапляє рівно в одну групу.
 * Активні — за дедлайном (найближчий зверху), виконані цього тижня — найсвіжіші зверху.
 */
export function focusGroups<T extends FocusTask>(tasks: T[], today: string): FocusGroups<T> {
  const g: FocusGroups<T> = { late: [], today: [], week: [], later: [], none: [], doneWeek: [], doneEarlier: [] };
  for (const t of tasks) {
    if (t.status === "done") (doneThisWeek(t, today) ? g.doneWeek : g.doneEarlier).push(t);
    else g[bucketOf(t, today)].push(t);
  }
  const byDeadline = (a: T, b: T) => (a.deadline ?? "").localeCompare(b.deadline ?? "");
  for (const b of FOCUS_BUCKETS) g[b.key].sort(byDeadline);
  g.doneWeek.sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return g;
}

/**
 * Числа для плиток — ЛИШЕ з довжин груп. «Активні» — сума всіх груп активних, тож плитка й
 * заголовки під нею не можуть розійтись. Тримає `#1961`.
 */
export function focusCounts<T extends FocusTask>(g: FocusGroups<T>): {
  active: number; late: number; thisWeek: number; review: number; doneWeek: number;
} {
  const active = FOCUS_BUCKETS.reduce((n, b) => n + g[b.key].length, 0);
  const review = FOCUS_BUCKETS.reduce((n, b) => n + g[b.key].filter((t) => t.status === "ready_for_approval").length, 0);
  return { active, late: g.late.length, thisWeek: g.today.length + g.week.length, review, doneWeek: g.doneWeek.length };
}

/** Плитка-фільтр: яку частину списку лишити. `null` — усе. */
export type FocusChip = "late" | "thisWeek" | "review" | "doneWeek";
export function chipKeeps(chip: FocusChip | null, bucket: FocusBucket | "doneWeek" | "doneEarlier", status: string): boolean {
  if (chip == null) return true;
  if (chip === "late") return bucket === "late";
  if (chip === "thisWeek") return bucket === "today" || bucket === "week";
  if (chip === "doneWeek") return bucket === "doneWeek";
  return status === "ready_for_approval" && bucket !== "doneWeek" && bucket !== "doneEarlier";
}

// ── 🔀 ДИЗАЙН: НОВИЙ ЧИ СТАРИЙ (вибір у браузері, рішення Романа 20.10.2026) ──

export type TasksDesign = "new" | "old";
export const TASKS_DESIGN_KEY = "uts.tasks.design";

/**
 * Який дизайн показати. За замовчуванням — новий; старий — лише якщо людина сама його обрала.
 * 🔴 Сховище браузера МОЖЕ КИНУТИ (приватне вікно, заблоковані дані сайту) — тоді екран
 * мусить показати дизайн за замовчуванням, а не впасти білим. Тримає `#1964`.
 */
export function readDesign(store: Pick<Storage, "getItem"> | null | undefined): TasksDesign {
  try {
    return store?.getItem(TASKS_DESIGN_KEY) === "old" ? "old" : "new";
  } catch {
    return "new";
  }
}

/** Запамʼятати вибір. Не вдалось записати — вибір діє до перезавантаження, і це не помилка. */
export function writeDesign(store: Pick<Storage, "setItem"> | null | undefined, v: TasksDesign): void {
  try {
    store?.setItem(TASKS_DESIGN_KEY, v);
  } catch {
    /* сховище недоступне — лишаємо вибір у памʼяті сторінки */
  }
}

/** Сховище браузера або `null`: сам доступ до `window.localStorage` теж може кинути. */
export function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

// ── 🎯 СТРАТЕГІЧНІ ЦІЛІ (рішення Романа 23–26.10.2026) ──

/** Прогрес цілі — за ПІДЗАДАЧАМИ, які бачить глядач (межа видимості тримається побудовою: чужих тут немає). */
export function goalProgress(subs: readonly FocusTask[]): { done: number; total: number } {
  return { done: subs.filter((s) => s.status === "done").length, total: subs.length };
}

/**
 * Стан цілі для кольору рамки:
 * - `late` — дедлайн минув, а ціль не закрита;
 * - `ready` — ціль закрита, або всі підзадачі виконані й вона чекає закриття «Приймає»;
 * - `warn` — прогрес відстає від часу більше ніж на чверть (минуло 60% строку, а виконано 30%);
 * - `ok` — інакше, зокрема без дедлайну чи без підзадач (нема з чим порівнювати — не лякаємо).
 * `start` — день постановки цілі (київська дата). Тримає `#2385`.
 */
export type GoalState = "ok" | "warn" | "late" | "ready";
export function goalState(goal: { status: string; deadline?: string | null; start?: string | null },
  subs: readonly FocusTask[], today: string): GoalState {
  // Закрита ціль — зелена, хоч би які підзадачі лишились: її прийняв «Приймає».
  if (goal.status === "done") return "ready";
  if (goal.deadline && goal.deadline < today) return "late";
  const { done, total } = goalProgress(subs);
  if (total > 0 && done === total) return "ready";
  if (!goal.deadline || !goal.start || total === 0 || goal.deadline <= goal.start) return "ok";
  const day = (d: string) => Date.parse(`${d}T12:00:00Z`) / 86_400_000;
  const elapsed = Math.min(1, Math.max(0, (day(today) - day(goal.start)) / (day(goal.deadline) - day(goal.start))));
  return done / total < elapsed - 0.25 ? "warn" : "ok";
}

/** Блок «🎯 Стратегічні» згорнуто? Вибір — у браузері, як і дизайн. Зламане сховище — розгорнуто. */
export const GOALS_OPEN_KEY = "uts.tasks.goalsOpen";
export function readGoalsOpen(store: Pick<Storage, "getItem"> | null | undefined): boolean {
  try { return store?.getItem(GOALS_OPEN_KEY) !== "0"; } catch { return true; }
}
export function writeGoalsOpen(store: Pick<Storage, "setItem"> | null | undefined, open: boolean): void {
  try { store?.setItem(GOALS_OPEN_KEY, open ? "1" : "0"); } catch { /* сховище недоступне */ }
}
