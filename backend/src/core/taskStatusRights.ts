/**
 * ✅ ХТО МОЖЕ РУХАТИ СТАТУС ЗАДАЧІ І ХТО ЇЇ ЗАКРИВАЄ. Одне місце на весь проєкт.
 *
 * Правило Сергія: задачу закриває той, хто її ПРИЙМАЄ. Виконавець доводить її
 * максимум до «Готово на затвердження», «Приймає» перевіряє і ставить «Готово»
 * або повертає в роботу.
 *
 * 🔴 ЧОМУ ОКРЕМЕ ПОЛЕ, А НЕ «АВТОР». Автор часто не той, хто ставив ТЗ: задачі
 * 4172/4310/4312 створив Роман за ТЗ Юлії. Тому «Приймає» (`tasks.reviewer_id`) —
 * окреме поле; порожнє означає «приймає автор» (`effectiveReviewer`), і саме так
 * виконано міграцію «для наявних задач Приймає = автор» — БЕЗ переписування
 * жодного рядка.
 *
 * 🔴 ПРАВИЛО ЧИТАЮТЬ ДВА МІСЦЯ, І ВОНИ МУСЯТЬ ЗБІГАТИСЬ: `PATCH /tasks/:id`
 * (відмовляє) і `GET /tasks` (віддає права кожного рядка, за якими фронт малює
 * меню). Фронт прав НЕ рахує — лише дзеркалить. Дві копії правила розійшлися б
 * так само, як розійшлися копії межі видимості 14.09 (`taskVisibility.ts`).
 *
 * ⚠️ ДІЄ ЛИШЕ НА ЗВИЧАЙНІ ЗАДАЧІ (`REVIEWED_TASK_TYPES`). KPI закриває джоба,
 * клієнта реактивації — менеджер чекбоксом, 1×1 — свій замок, заявку на ліміт —
 * фінанси. Розповзтись на них означало б, що менеджер більше не може відмітити
 * клієнта в пачці реактивації. Рішення Романа 30.09.2026: решту «залишити як є».
 */
import { canSeeTask, isPersonalTask, type TaskViewer, type TaskOwnerRow } from "./taskVisibility.js";

/** Типи задач, де «Готово» ставить лише той, хто приймає. */
export const REVIEWED_TASK_TYPES: ReadonlySet<string> = new Set(["simple"]);

/** Задача в частині «хто рухає статус» — власність + приймаючий + тип. */
export interface StatusRightsRow extends TaskOwnerRow {
  /** `tasks.reviewer_id` як є: `null` означає «приймає автор». */
  reviewerId: number | null;
  taskType: string;
}

/**
 * Роль людини в задачі на момент зміни статусу — пишеться в історію
 * (`task_status_log.actor_role`), щоб «хто прийняв» не залежав від того, кого
 * пізніше призначать приймати.
 *
 * Порядок має значення: одна людина буває кількома ролями одразу, і перемагає
 * перша за списком: адмін → «Приймає» → виконавець → автор → тімлід.
 *
 * 🔴 ВИКОНАВЕЦЬ ПЕРЕД АВТОРОМ — СВІДОМО. Автор, який сам собі виконавець, а
 * приймати призначив іншого, — це саме випадок 4172/4310/4312 (Роман написав
 * задачу за ТЗ Юлії й виконує її). ТЗ: «якщо автор, виконавець і Приймає — одна
 * людина, вона може ставити done»; тобто коли «Приймає» інший — не може. Автор
 * «перемагав» би виконавця, і правило не діяло б саме там, заради чого його писали.
 */
export type StatusActor = "admin" | "reviewer" | "author" | "executor" | "team_lead";

export interface StatusRights {
  /** Може поставити БУДЬ-ЯКИЙ статус, крім, можливо, `done`. */
  canChange: boolean;
  /** Може поставити `done`. Завжди ⊆ `canChange`. */
  canDone: boolean;
  actor: StatusActor | null;
}

/** «Приймає» з урахуванням замовчування: порожнє поле — це автор. */
export function effectiveReviewer(t: Pick<StatusRightsRow, "reviewerId" | "createdBy">): number | null {
  return t.reviewerId ?? t.createdBy;
}

/** Чи є людина виконавцем — менеджером із CRM або акаунтом. */
function isExecutor(v: TaskViewer, t: TaskOwnerRow): boolean {
  return (t.assigneeId != null && t.assigneeId === v.managerId)
    || (t.assigneeUserId != null && t.assigneeUserId === v.userId);
}

/** Найсильніша роль глядача в задачі, або `null`, якщо він до неї непричетний. */
export function statusActor(v: TaskViewer, t: StatusRightsRow): StatusActor | null {
  if (v.adminScope) return "admin";
  // Поза звичайними задачами «Приймає» не діє: там приймає автор, як і було.
  // Інакше видача обіцяла б права, яких PATCH (межа `canTouchTask`) не дає.
  const reviewer = REVIEWED_TASK_TYPES.has(t.taskType) ? effectiveReviewer(t) : t.createdBy;
  if (reviewer === v.userId) return "reviewer";
  if (isExecutor(v, t)) return "executor";
  if (t.createdBy === v.userId) return "author";
  // Тімлід команди виконавця — рішення Романа 30.09.2026: рухає, як виконавець,
  // але не закриває. Особиста задача підлеглого йому не відкривається взагалі.
  if (v.role === "team_lead" && !isPersonalTask(t)
    && t.assigneeTeamId != null && t.assigneeTeamId === v.teamId) return "team_lead";
  return null;
}

/**
 * Права глядача на статус цієї задачі.
 *
 * | хто                        | рухає | закриває (`done`) |
 * |----------------------------|:-----:|:-----------------:|
 * | адмін (`admin_scope`)      |  ✅   |        ✅         |
 * | «Приймає»; автор-не-виконавець |  ✅   |        ✅         |
 * | виконавець (навіть якщо він автор), тімлід команди |  ✅   |        ❌         |
 * | решта                      |  ❌   |        ❌         |
 *
 * 🔒 Хто задачі не БАЧИТЬ, той її й не рухає — права рахуються лише поверх
 * `canSeeTask`, тож «рухаю навпомацки» неможливе за побудовою (тримає `#1080d`).
 *
 * Для типів поза `REVIEWED_TASK_TYPES` закривати може кожен причетний — тобто
 * поведінка, що була до цього правила.
 *
 * ⚠️ І ТАК САМО — ДЛЯ ЗАДАЧІ, ЯКУ НІХТО НЕ ПРИЙМАЄ (немає ні автора, ні «Приймає»).
 * Це задачі, які ставить СИСТЕМА з `task_type='simple'` і `created_by = NULL`:
 * пропущені дзвінки, чергування, дедлайни дебіторки, звірка даних, нагадування 1×1.
 * Без цього винятку їх закривав би лише адмін — менеджер відпрацював дзвінок і не
 * може його закрити. Тримає `#1080c`.
 */
export function statusRights(v: TaskViewer, t: StatusRightsRow): StatusRights {
  const none: StatusRights = { canChange: false, canDone: false, actor: null };
  if (!canSeeTask(v, t)) return none;
  const actor = statusActor(v, t);
  if (actor === null) return none;
  const closes = actor === "admin" || actor === "reviewer" || actor === "author"
    || !REVIEWED_TASK_TYPES.has(t.taskType)
    || effectiveReviewer(t) === null;
  return { canChange: true, canDone: closes, actor };
}

/**
 * Хто може ПЕРЕПРИЗНАЧИТИ «Приймає»: автор, поточний «Приймає» і адмін
 * (рішення Романа 30.09.2026). Виконавець — ні: інакше він призначив би
 * приймати себе і закрив би задачу сам, тобто правило вище стало б декоративним.
 */
export function canChangeReviewer(v: TaskViewer, t: StatusRightsRow): boolean {
  if (!canSeeTask(v, t)) return false;
  return v.adminScope || t.createdBy === v.userId || effectiveReviewer(t) === v.userId;
}
