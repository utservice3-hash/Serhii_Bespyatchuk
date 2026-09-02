/**
 * 👤 ТРИ СТАНИ МЕНЕДЖЕРА — ЄДИНИЙ СЛОВНИК ДЛЯ КОДУ Й ЕКРАНА (рішення власника 01.09.2026).
 *
 * Правило власника дослівно: «якщо менеджер зникає, але є зроблений результат, тоді план
 * його зникає, але результат залишається, там скрізь показується цей менеджер з позначкою
 * як звільнений — це правило застосувати до усього звіту».
 *
 * | стан         | план              | результат            | у списках                    |
 * |--------------|-------------------|----------------------|------------------------------|
 * | АКТИВНИЙ     | узгоджується      | рахується            | скрізь                       |
 * | ЗАВЕРШУЄ     | **немає взагалі** | рахується ПОВНІСТЮ   | лише там, де ЙОГО угоди      |
 * | ЗВІЛЬНЕНИЙ   | немає             | рахується й показується | у робочих списках немає   |
 *
 * 🔴 «ЗАВЕРШУЄ» — це не «трохи звільнений». Це людина, яка фактично не працює, але
 * доводить свої угоди до кінця (Шевчук Назар). Власник 01.09.2026: **«так, нового не
 * бере»** — отже межа проходить не по «видно / не видно», а по ПРИЗНАЧЕННЮ НОВОЇ РОБОТИ.
 *
 * 🔴 ЧОМУ СТАН НЕ МОЖНА БУЛО ПОКЛАСТИ В НАЯВНІ ПРАПОРЦІ — заміряно, не припущено.
 * `managers.is_active` пише `syncKommo` (`INSERT … ON CONFLICT DO UPDATE SET is_active =
 * true`, кожні 30 хв), `users.is_active` пише `provisionUsers` значенням `managers
 * .is_active` у кінці того самого тіка. Замір 01.09.2026: розбіжність між цими двома —
 * **0 рядків із 57 логінів**, а деактивація Шевчука адміном 06.08 11:11 зникла після
 * ≈1 250 проходів синку. Тому стан живе в `manager_work_state`, якої синк не бачить.
 */

export type WorkState = "active" | "finishing" | "dismissed";
/** Те, що адмін може поставити руками. «Активний» не ставиться — він означає ВІДСУТНІСТЬ рядка. */
export type StateOverride = "finishing" | "dismissed";

export const WORK_STATES: readonly WorkState[] = ["active", "finishing", "dismissed"] as const;

/** Позначка біля імені. Порожня для активного: підпис «активний» у кожному рядку — це шум. */
export const STATE_BADGE: Record<WorkState, string> = {
  active: "",
  finishing: "завершує",
  dismissed: "звільнений",
};

export interface StateInput {
  /** Активний за наявною ознакою — тією самою двопрапорцевою (`activeManagerSql`). */
  crmActive: boolean;
  /** Рішення адміна з `manager_work_state`, або `null` — рішення не приймали. */
  override: StateOverride | null;
}

/**
 * 🔴 ПОРЯДОК ГІЛОК — ЧАСТИНА ПРАВИЛА, А НЕ ОПТИМІЗАЦІЯ.
 * Людина, яку прибрали з CRM, — звільнена, хоч би що стояло в накладці: інакше
 * «завершує», поставлене колись, пережило б справжнє звільнення й лишило б людину
 * у списках її угод назавжди.
 */
export function stateOf(i: StateInput): WorkState {
  if (i.override === "dismissed") return "dismissed";
  if (!i.crmActive) return "dismissed";
  if (i.override === "finishing") return "finishing";
  return "active";
}

/** Чи ставимо цій людині план (і чи входить вона у знаменник «менеджерів із планом»). */
export function hasPlan(s: WorkState): boolean {
  return s === "active";
}

/**
 * Чи рахується її результат. **ЗАВЖДИ.** Функція існує не заради `true`, а заради того,
 * щоб місце, яке захоче різати результат станом, мусило спершу її покликати — і стало
 * видно в `grep`. Правило власника: гроші лишаються в сумах команди й компанії.
 */
export function countsResult(_s: WorkState): boolean {
  return true;
}

/** Списки ПРО ЙОГО НАЯВНІ УГОДИ: звіти, його клієнти, фільтри. «Завершує» тут ЛИШАЄТЬСЯ. */
export function inOwnWorkLists(s: WorkState): boolean {
  return s === "active" || s === "finishing";
}

/** Списки ПРИЗНАЧЕННЯ НОВОЇ РОБОТИ: вибір виконавця нової угоди. «Завершує» ЗВІДСИ ЗНИКАЄ. */
export function inNewWorkLists(s: WorkState): boolean {
  return s === "active";
}

/**
 * SQL-вираз стану. `alias` — псевдонім `managers`, `activeExpr` — наявний предикат
 * активності (`activeManagerSql(alias)`), щоб визначення активності лишалось ОДНЕ.
 * `LEFT JOIN`, а не підзапит у `SELECT`: стан потрібен і в `WHERE`, і в `GROUP BY`.
 */
export function stateJoinSql(alias = "m"): string {
  return `LEFT JOIN manager_work_state mws ON mws.manager_id = ${alias}.id`;
}

export function stateSql(alias = "m", activeExpr = "", mws = "mws"): string {
  const active = activeExpr || `${alias}.is_active`;
  return `CASE WHEN ${mws}.state = 'dismissed' THEN 'dismissed'
               WHEN NOT (${active})           THEN 'dismissed'
               WHEN ${mws}.state = 'finishing' THEN 'finishing'
               ELSE 'active' END`;
}

/** «Кому ставимо план» одним предикатом — дзеркало `hasPlan` на боці SQL. */
export function hasPlanSql(alias = "m", activeExpr = "", mws = "mws"): string {
  return `(${stateSql(alias, activeExpr, mws)}) = 'active'`;
}
