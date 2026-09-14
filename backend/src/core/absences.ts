/**
 * ВІДСУТНОСТІ (Календар команди) — SQL-цеглинки, спільні для роуту й гейтів.
 *
 * 🔴 ВІДСУТНІСТЬ НАЛЕЖИТЬ АКАУНТУ, А НЕ МЕНЕДЖЕРУ З CRM (рішення власника 09.09.2026,
 * привід — Дарʼя Протас: акаунт «не з CRM», відпустку поставити не могла, бо
 * `team_calendar_absences.manager_id` був NOT NULL і календар знав лише `managers`).
 * Таких акаунтів без запису в `managers` на проді четверо (Сергій, Дарʼя, бухгалтерія,
 * рекрутер) — усі люди, яким відпустка потрібна не менше, ніж менеджерам.
 *
 * Тому ключ — `user_id`, а `manager_id` лишається ПОРУЧ і заповнюється, коли він є:
 * плани (`presentWorkingDaysByManager`) і `/presence` читають саме його, і для CRM-людей
 * нічого не змінюється. CHECK стереже, щоб рядок не лишився без жодного власника.
 *
 * ⚠️ Чому це не файл у `routes/`: ті самі рядки SQL ганяються гейтами на порожньому
 * кластері (`#394*`), і тест мусить читати РІВНО те, що виконує роут, а не свою копію
 * (правило ③ з `.claude/rules/testing.md`: «дві копії, написані в тесті, доводять рівність
 * двох рядків, а не поведінку продакшну»).
 */

/** Імʼя власника відсутності: CRM-менеджер → `managers.name`; ручний акаунт → `users.full_name`;
 *  зовсім нічого → email (невідоме читається як невідоме, не як порожнє). */
export const OWNER_NAME_SQL = "COALESCE(m.name, u.full_name, u.email)";

/**
 * Перелік АКАУНТІВ для селекту «Оберіть співробітника…». Один рядок = один акаунт;
 * команда й `managerId` — з `managers`, якщо акаунт до нього привʼязаний.
 * Активність: акаунт активний І (немає менеджера АБО менеджер активний) — звільнений
 * CRM-менеджер з живим акаунтом у список не потрапляє, як і раніше.
 *
 * Скоуп задає той, хто кличе: `where` — додаткові умови з `$n`-параметрами.
 * Аліаси: `u` = users, `m` = managers, `t` = teams.
 */
export function calendarAccountsSql(where: string[]): string {
  const conds = ["u.is_active", "(m.id IS NULL OR m.is_active)", ...where];
  return `SELECT u.id AS user_id, m.id AS manager_id, ${OWNER_NAME_SQL} AS name,
                 m.team_id, t.name AS team_name
            FROM users u
            LEFT JOIN managers m ON m.id = u.manager_id
            LEFT JOIN teams t ON t.id = m.team_id
           WHERE ${conds.join(" AND ")}
           ORDER BY t.name NULLS LAST, name`;
}

/**
 * Відсутності за вікно [from,to] ($1,$2) з імʼям власника. `scope` — додаткові умови
 * з `$n` (порожній рядок = усе). Джойни LEFT: у рядка може не бути менеджера (ручний
 * акаунт) або не бути акаунта (історичний рядок менеджера без логіна).
 */
export function absencesSql(scope: string): string {
  return `SELECT a.id, a.manager_id, a.user_id, ${OWNER_NAME_SQL} AS owner_name, a.team_id, t.name AS team_name,
                 a.kind, to_char(a.start_date,'YYYY-MM-DD') AS start_date, to_char(a.end_date,'YYYY-MM-DD') AS end_date,
                 a.hours, a.note, a.status, a.created_by, to_char(a.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') AS created_at,
                 a.approved_by, COALESCE(am.name, au.full_name, au.email) AS approver_name,
                 to_char(a.approved_at,'YYYY-MM-DD"T"HH24:MI:SSZ') AS approved_at
            FROM team_calendar_absences a
            LEFT JOIN managers m ON m.id = a.manager_id
            LEFT JOIN users u ON u.id = a.user_id
            LEFT JOIN teams t ON t.id = a.team_id
            LEFT JOIN users au ON au.id = a.approved_by
            LEFT JOIN managers am ON am.id = au.manager_id
           WHERE a.start_date <= $2 AND a.end_date >= $1 ${scope}
           ORDER BY a.start_date, owner_name`;
}

/**
 * «Це моя відсутність» — по БУДЬ-ЯКОМУ з двох ключів. Менеджер із акаунтом має обидва;
 * порівняння лише по `manager_id` зробило б ручні акаунти «нічиїми» для їхніх власників.
 */
export function isMine(row: { manager_id: number | null; user_id: number | null },
  auth: { managerId: number | null; userId: number }): boolean {
  return (row.manager_id != null && row.manager_id === auth.managerId) || row.user_id === auth.userId;
}

/** Умова «власні рядки цього акаунта» для WHERE; `p` — індекси параметрів managerId і userId. */
export function ownScopeSql(alias: string, pManager: number, pUser: number): string {
  return `(${alias}.manager_id = $${pManager} OR ${alias}.user_id = $${pUser})`;
}

/**
 * Власник відсутності, зведений до двох ключів. Роут приймає `userId` (нова форма) або
 * `managerId` (стара збірка у відкритій вкладці) — і виводить пару. Чиста функція над
 * рядками, які роут дістав із БД; гейт ганяє її на всіх чотирьох комбінаціях.
 */
export function resolveOwner(input: {
  byUser: { user_id: number; manager_id: number | null; team_id: number | null } | null;
  byManager: { manager_id: number; user_id: number | null; team_id: number | null } | null;
}): { userId: number | null; managerId: number | null; teamId: number | null } | null {
  if (input.byUser) return { userId: input.byUser.user_id, managerId: input.byUser.manager_id, teamId: input.byUser.team_id };
  if (input.byManager) return { userId: input.byManager.user_id, managerId: input.byManager.manager_id, teamId: input.byManager.team_id };
  return null;
}
