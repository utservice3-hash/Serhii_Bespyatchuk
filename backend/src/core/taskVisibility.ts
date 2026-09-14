/**
 * 👁 МЕЖА ЗАДАЧІ — ХТО ЇЇ БАЧИТЬ І ХТО МОЖЕ ЗМІНИТИ. Одне місце на весь проєкт.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ МОДУЛЬ, А НЕ ДВІ УМОВИ В РОУТІ. Правило існувало ДВІЧІ —
 * умовою SQL у `GET /tasks` і функцією `canTouchTask` у тому ж файлі, — і копії
 * розійшлись. Заміряно 14.09.2026 читанням коду: для РОЛІ МЕНЕДЖЕРА
 * `canTouchTask` пускав автора до задачі, яку він створив комусь іншому
 * (`t.created_by === auth.userId`), а SQL видачі того автора НЕ пускав
 * (`t.assignee_id IS NULL AND t.created_by = …` — лише для БЕЗ виконавця).
 * Наслідок для людини: менеджер ставить задачу колезі, задача зникає з його
 * екрана, але PATCH по ній проходить. Коментар у роуті при цьому стверджував
 * «щоб бачив свої, як canTouchTask» — тобто підпис уже описував намір, якого
 * код не виконував. Той самий клас, що «синхронізовано із Задачником».
 *
 * 🔒 ІНВАРІАНТА, ЯКУ ЦЕЙ МОДУЛЬ РОБИТЬ ПЕРЕВІРНОЮ: **хто може змінити — той
 * мусить бачити** (`canTouch ⊆ canSee`). До правки вона була порушена саме для
 * менеджера-автора; тримає її гейт `#400`.
 *
 * ⚠️ «БАЧИТИ» І «ЗМІНЮВАТИ» НЕ ЗВОДЯТЬСЯ ОДНЕ ДО ОДНОГО, і це свідомо. Роль
 * `company` без права `admin_scope` (HR, бухгалтерія — рішення власника
 * 05.09.2026 «тільки перегляд») бачить УСІ призначені задачі компанії, а
 * змінювати може лише власні. Тому тут дві функції, а не одна: спільне в них —
 * ВИЗНАЧЕННЯ особистої задачі, а не перелік дозволів.
 */

/** Обсяг даних ролі у вигляді, в якому його бачить роут (`auth.role` після scope-клампу). */
export interface TaskViewer {
  /** scope-compat роль: `admin` | `company` | `team_lead` | `manager`. */
  role: string;
  /** `users.id` — саме він, а не `managers.id`: автор задачі це АКАУНТ. */
  userId: number;
  /** `managers.id` або `null`/`-1` (scope-кламп для own-ролі без менеджера). */
  managerId: number | null;
  teamId: number | null;
  /** `isAdminScope(auth)` — право, а не назва ролі (див. `rbac.ts`). */
  adminScope: boolean;
}

/**
 * Задача в частині «хто її власник» — рівно ті поля, від яких залежить межа.
 *
 * `assigneeTeamId` — команда ВИКОНАВЦЯ, і вона одна для обох видів виконавця:
 * менеджера з CRM (`managers.team_id`) або акаунта (`users.manager_id` →
 * `managers.team_id`). SQL віддає її одним `COALESCE`, тож JS і SQL міркують
 * про ту саму величину, а не про дві схожі.
 */
export interface TaskOwnerRow {
  assigneeId: number | null;
  /** Виконавець-АКАУНТ (`users.id`) — для тих, кого немає в CRM (бухгалтерія, HR, рекрутер). */
  assigneeUserId: number | null;
  createdBy: number | null;
  assigneeTeamId: number | null;
}

/**
 * 🔴 ОСОБИСТА ЗАДАЧА — ВИЗНАЧЕННЯ, І ВОНО ТУТ ОДНЕ.
 *
 * Особиста = БЕЗ виконавця взагалі. Приватна творцю, не протікає між акаунтами
 * навіть адміну (правило приватності, `schema.sql` → вью `ai_tasks`).
 *
 * ⚠️ ДО 14.09.2026 «особиста» означала `assignee_id IS NULL`, і на цю інваріанту
 * спиралися ЧОТИРИ місця: умова видачі, `canTouchTask`, вью `ai_tasks` і
 * REVOKE-список `ai_readonly`. Поява виконавця-АКАУНТА (`assignee_user_id`)
 * зробила старе визначення хибним: задача бухгалтеру має `assignee_id IS NULL`
 * і особистою НЕ є. Тому визначення переїхало сюди, а всі читачі — на нього.
 * Гейт `#400e` звіряє, що вью в схемі каже те саме, що ця функція.
 */
export function isPersonalTask(t: TaskOwnerRow): boolean {
  return PERSONAL_COLUMNS.every((c) => t[c.field] === null);
}

/**
 * 🔑 КОЛОНКИ ВЛАСНОСТІ — ЄДИНЕ ДЖЕРЕЛО, З ЯКОГО ВИВОДИТЬСЯ ВСЕ ІНШЕ.
 *
 * Із цього переліку будуються обидва SQL-вирази нижче, його ж читає гейт
 * `#400e`, коли звіряє вью `ai_tasks` у схемі. Сенс не в економії рядків:
 * додати третій вид виконавця й забути один із чотирьох читачів — саме та
 * поломка, яку ми щойно лікували. Тепер «забути» видно, бо перелік один.
 */
export const PERSONAL_COLUMNS: readonly { column: string; field: "assigneeId" | "assigneeUserId" }[] = [
  { column: "assignee_id", field: "assigneeId" },
  { column: "assignee_user_id", field: "assigneeUserId" },
];

/** Те саме визначення для SQL. Псевдонім таблиці задач — `t`. */
export const PERSONAL_TASK_SQL =
  `(${PERSONAL_COLUMNS.map((c) => `t.${c.column} IS NULL`).join(" AND ")})`;
/** Дзеркало: задача з виконавцем будь-якого виду. */
export const ASSIGNED_TASK_SQL =
  `(${PERSONAL_COLUMNS.map((c) => `t.${c.column} IS NOT NULL`).join(" OR ")})`;

/**
 * Джойни, потрібні умові видимості, і вираз «команда виконавця».
 *
 * 🔴 Псевдоніми фіксовані (`m`, `au`, `am`) — умова нижче їх називає. Змінити
 * тут і не змінити там означало б `syntax error` на першому ж запиті, а не тихе
 * розходження: саме тому вони в одному модулі.
 */
export const TASK_OWNER_JOINS = `
     LEFT JOIN managers m ON m.id = t.assignee_id
     LEFT JOIN users au ON au.id = t.assignee_user_id
     LEFT JOIN managers am ON am.id = au.manager_id`;
/** Команда виконавця: менеджера з CRM або акаунта через його менеджера. */
export const ASSIGNEE_TEAM_SQL = "COALESCE(m.team_id, am.team_id)";

/**
 * ✅ ХТО БАЧИТЬ ЗАДАЧУ (дзеркало SQL-умови `visibilityCondSql`).
 *
 * - наскрізний / company: усі ПРИЗНАЧЕНІ + лише ВЛАСНІ особисті;
 * - тімлід: задачі своєї команди + власні + призначені особисто йому;
 * - менеджер: призначені йому (як менеджеру або як акаунту) + створені ним.
 */
export function canSeeTask(v: TaskViewer, t: TaskOwnerRow): boolean {
  const mine = t.createdBy === v.userId;
  const toMyAccount = t.assigneeUserId != null && t.assigneeUserId === v.userId;
  if (v.adminScope || v.role === "company") {
    return !isPersonalTask(t) || mine;
  }
  if (v.role === "team_lead") {
    return (t.assigneeTeamId != null && t.assigneeTeamId === v.teamId) || mine || toMyAccount;
  }
  return (t.assigneeId != null && t.assigneeId === v.managerId) || mine || toMyAccount;
}

/**
 * ✏️ ХТО МОЖЕ ЗМІНИТИ ЗАДАЧУ.
 *
 * ⚠️ Відрізняється від `canSeeTask` РІВНО в одному: роль `company` без
 * `admin_scope` (HR, бухгалтерія) бачить усе призначене, а змінює лише своє.
 * Це поведінка, що вже була в коді до цього модуля (`canTouchTask` перевіряв
 * `isAdminScope`, а не `role`), і вона зберігається байт-у-байт.
 */
export function canTouchTask(v: TaskViewer, t: TaskOwnerRow): boolean {
  const mine = t.createdBy === v.userId;
  const toMyAccount = t.assigneeUserId != null && t.assigneeUserId === v.userId;
  if (v.adminScope) {
    return !isPersonalTask(t) || mine;
  }
  if (v.role === "team_lead") {
    return (t.assigneeTeamId != null && t.assigneeTeamId === v.teamId) || mine || toMyAccount;
  }
  return (t.assigneeId != null && t.assigneeId === v.managerId) || mine || toMyAccount;
}

/**
 * SQL-умова видимості для `GET /tasks` — дзеркало `canSeeTask`.
 *
 * `push` докладає значення в масив параметрів і повертає його НОМЕР (1-based):
 * так умова вбудовується в будь-який запит, не вгадуючи, скільки параметрів
 * стоїть перед нею. Руками нумерувати `$N` заборонено — на цьому вже розійшовся
 * список колонок і значень у `#346`.
 */
export function visibilityCondSql(v: TaskViewer, push: (value: unknown) => number): string {
  if (v.adminScope || v.role === "company") {
    return `(${ASSIGNED_TASK_SQL} OR t.created_by = $${push(v.userId)})`;
  }
  if (v.role === "team_lead") {
    const team = push(v.teamId);
    const me = push(v.userId);
    return `(${ASSIGNEE_TEAM_SQL} = $${team} OR t.created_by = $${me} OR t.assignee_user_id = $${me})`;
  }
  const mgr = push(v.managerId);
  const me = push(v.userId);
  return `(t.assignee_id = $${mgr} OR t.created_by = $${me} OR t.assignee_user_id = $${me})`;
}
