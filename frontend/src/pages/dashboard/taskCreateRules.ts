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
