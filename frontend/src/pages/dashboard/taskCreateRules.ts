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
 * 👔 КЕРІВНИКИ ЗВЕРХУ (9377, Юлія 16.11.2026: «щоб поставити задачу Андрію, Дарині, Василю… треба гортати
 * весь список з 60 людей»). Керівник — активний менеджер з роллю «Тимлид» у Kommo (`isTeamLead`), тож склад
 * блоку — дзеркало CRM, руками його ніхто не веде. Себе не показуємо. Людина лишається і у своїй команді:
 * блок — ярлик угорі, а не переїзд. Немає жодного керівника — групи немає (а не порожній заголовок).
 * Тримає `#7880`.
 */
export function withLeaders<G extends readonly [string, readonly { id: number; name: string }[]]>(
  groups: readonly G[],
  options: readonly { id: number; name: string; isTeamLead?: boolean }[],
  selfId: number | null = null,
): [string, { id: number; name: string }[]][] {
  const leaders = leadersOf(options, selfId);
  const rest = groups.map(([t, ps]) => [t, [...ps]] as [string, { id: number; name: string }[]]);
  return leaders.length ? [[LEADERS_TITLE, leaders], ...rest] : rest;
}

/** Керівники для ряду кнопок і для групи — за абеткою, без мене, без дублів. Тримає `#7880`. */
export function leadersOf(options: readonly { id: number; name: string; isTeamLead?: boolean }[], selfId: number | null = null): { id: number; name: string }[] {
  const byId = new Map<number, { id: number; name: string }>();
  for (const m of options) if (m.isTeamLead === true && m.id !== selfId && !byId.has(m.id)) byId.set(m.id, { id: m.id, name: m.name });
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "uk"));
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
