/**
 * 🆕 ФОРМА СТВОРЕННЯ ЗАДАЧІ — чисті правила (варіант А, рішення Романа 26.10.2026: «роби А»).
 *
 * Тут лише рішення «чого бракує», «які швидкі дати» і «хто в списку виконавців у якому порядку».
 * `TaskCreateDialog.tsx` їх малює, а гейти виконують ці функції напряму — правило в одному місці.
 *
 * 🔴 ЧОМУ «ЧОГО БРАКУЄ» — СПИСОК СЛІВ, А НЕ ПРАПОРЕЦЬ. 26.10.2026 Роман тиснув «Створити задачу» на
 * стратегічній без результату, і нічого не відбувалось: кнопка була неактивна, але виглядала активною
 * і не казала чому. Тепер кнопка блідне, а поруч написано, чого саме бракує.
 *
 * Модуль без імпортів — його імпортує Node у гейтах.
 */

/** Що з форми потрібно правилу «чого бракує». */
export interface MissingInput {
  title: string;
  strategic: boolean;
  goalResult: string;
  assigneeId: number | "";
  assigneeUserId: number | "";
}

/**
 * Чого бракує, щоб створити задачу — словами, у тому порядку, в якому людина заповнює форму.
 * - назва — завжди;
 * - результат — для стратегічної задачі (рішення 23.10.2026);
 * - «кому ставите» — коли задачу ставлять зі «Спільних» (там виконавець обовʼязковий, себе не підставляємо).
 * Порожній масив — можна створювати. Тримає `#2390`.
 */
export function formMissing(f: MissingInput, o: { sharedIntent: boolean }): string[] {
  const m: string[] = [];
  if (!f.title.trim()) m.push("опис задачі");
  if (f.strategic && !f.goalResult.trim()) m.push("результат стратегічної задачі");
  if (o.sharedIntent && f.assigneeId === "" && f.assigneeUserId === "") m.push("кому ставите");
  return m;
}

/**
 * Швидкі дати дедлайну від київського «сьогодні» (`YYYY-MM-DD`):
 * - «Сьогодні», «Завтра»;
 * - «Пʼятниця» — найближча пʼятниця ПІСЛЯ сьогодні (у пʼятницю й вихідні — наступного тижня);
 * - «Наст. тиждень» — понеділок наступного тижня.
 * Рахується по самій даті (полудень UTC), тож пояс браузера межі не зсуває. Тримає `#2391`.
 */
export function quickDates(today: string): { label: string; date: string }[] {
  const base = Date.parse(`${today}T12:00:00Z`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const day = 86_400_000;
  const dow = new Date(base).getUTCDay(); // 0 — неділя … 5 — пʼятниця
  const toFriday = ((5 - dow + 7) % 7) || 7;
  const toMonday = ((1 - dow + 7) % 7) || 7;
  return [
    { label: "Сьогодні", date: today },
    { label: "Завтра", date: iso(base + day) },
    { label: "Пʼятниця", date: iso(base + toFriday * day) },
    { label: "Наст. тиждень", date: iso(base + toMonday * day) },
  ];
}

/** Людина у виборі виконавця: менеджер із CRM або акаунт (HR, бухгалтерія — кого немає в CRM). */
export interface PickPerson { kind: "manager" | "account"; id: number; name: string }

/**
 * Список виконавців для вибору з пошуком: групи менеджерів у тому порядку, що дає `teamGroups`
 * (моя команда першою), потім акаунти. Пошук — без регістру, по частині імені. Порожні групи
 * зникають. Тримає `#2392`.
 */
export function pickGroups(
  managerGroups: readonly [string, readonly { id: number; name: string }[]][],
  accounts: readonly { id: number; name: string }[],
  query: string,
): [string, PickPerson[]][] {
  const q = query.trim().toLowerCase();
  const hit = (name: string) => !q || name.toLowerCase().includes(q);
  const out: [string, PickPerson[]][] = managerGroups.map(([title, ms]) =>
    [title, ms.filter((m) => hit(m.name)).map((m) => ({ kind: "manager" as const, id: m.id, name: m.name }))]);
  out.push(["Акаунти (HR, бухгалтерія — кого немає в CRM)",
    accounts.filter((a) => hit(a.name)).map((a) => ({ kind: "account" as const, id: a.id, name: a.name }))]);
  return out.filter(([, ps]) => ps.length > 0);
}

/** Підпис групи керівників у виборі виконавця (9377). */
export const LEADERS_TITLE = "👔 Керівники";

/**
 * Ролі акаунтів, що входять у «Керівники» (9377, Роман 17.11.2026: «тімліди, Сергій, я, Даша і т.д.»):
 * адмін, КВП, СЕО, операційний директор. Бухгалтерія, HR, фінансист, менеджер — ні.
 */
export const LEADER_ROLES: readonly string[] = ["admin", "kvp", "ceo", "opdir"];

type LeadMgr = { id: number; name: string; isTeamLead?: boolean };
type LeadAcc = { id: number; name: string; managerId: number | null; role?: string | null };

/**
 * 👔 СПОЧАТКУ КЕРІВНИКИ, ПОТІМ УСІ ІНШІ (9377; Роман 17.11.2026: «щоб при виборі всіх були спочатку керівники,
 * а потім тільки менеджери і інші»). Керівник — менеджер із роллю «Тимлид» у Kommo (`isTeamLead`) або людина,
 * чий акаунт має роль із `LEADER_ROLES` (менеджер, привʼязаний до такого акаунта, теж керівник). Керівники —
 * одна група першою, за абеткою; з команд і з «Акаунтів» вони прибрані, щоб нікого не було двічі. Далі —
 * команди в порядку `teamGroups` (моя перша), далі акаунти. Пошук — по всіх групах; порожні зникають.
 * Тримає `#7880`.
 */
export function pickGroupsLeadersFirst(
  managerGroups: readonly [string, readonly { id: number; name: string }[]][],
  managers: readonly LeadMgr[],
  accounts: readonly LeadAcc[],
  query: string,
): [string, PickPerson[]][] {
  const leadRole = (r: string | null | undefined) => r != null && LEADER_ROLES.includes(r);
  const leadMgr = new Set<number>(managers.filter((m) => m.isTeamLead === true).map((m) => m.id));
  for (const a of accounts) if (a.managerId != null && leadRole(a.role)) leadMgr.add(a.managerId);
  const mgrById = new Map(managers.map((m) => [m.id, m] as const));
  const plain = accounts.filter((a) => a.managerId == null);
  const leaders: PickPerson[] = [
    ...[...leadMgr].filter((id) => mgrById.has(id)).map((id) => ({ kind: "manager" as const, id, name: mgrById.get(id)!.name })),
    ...plain.filter((a) => leadRole(a.role)).map((a) => ({ kind: "account" as const, id: a.id, name: a.name })),
  ].sort((x, y) => x.name.localeCompare(y.name, "uk"));
  const q = query.trim().toLowerCase();
  const head: [string, PickPerson[]][] = [[LEADERS_TITLE, leaders.filter((p) => !q || p.name.toLowerCase().includes(q))]];
  const rest = pickGroups(
    managerGroups.map(([t, ms]) => [t, ms.filter((m) => !leadMgr.has(m.id))] as [string, { id: number; name: string }[]]),
    plain.filter((a) => !leadRole(a.role)),
    query,
  );
  return [...head, ...rest].filter(([, ps]) => ps.length > 0);
}

/**
 * 📅 ДЕДЛАЙН ЗА ЗАМОВЧУВАННЯМ для задачі зі «Спільних» (9377: «Enter — задача створена з дедлайном»):
 * «Завтра» від київського сьогодні, та сама дата, що в швидкій кнопці. Людина може змінити пігулкою
 * «Дедлайн» до створення. Тримає `#7881`.
 */
export function defaultSharedDeadline(today: string): string {
  return quickDates(today).find((q) => q.label === "Завтра")!.date;
}

/**
 * ⏎ ЗВИЧАЙНИЙ ENTER СТВОРЮЄ ЗАДАЧУ — лише в діалозі «Спільна задача» (9377). Shift+Enter — новий рядок;
 * під час набору через IME Enter підтверджує символ, а не форму. У звичайній «+ Додати» Enter лишається
 * новим рядком (довгі описи), створює там Ctrl/⌘+Enter, як і раніше. Тримає `#7882`.
 */
export function plainEnterSubmits(
  e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean; isComposing?: boolean },
  o: { sharedIntent: boolean },
): boolean {
  return o.sharedIntent && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
}
