/**
 * ✅ СПОВІЩЕННЯ «ПРИЙМАЄ»: ЗАДАЧА ЧЕКАЄ ТВОГО ПРИЙНЯТТЯ (рішення Романа 30.09.2026).
 *
 * Виконавець доводить задачу до «Готово на затвердження», а закриває її «Приймає»
 * (`backend/src/core/taskStatusRights.ts`). Без сигналу задачі накопичувались би в цьому
 * статусі мовчки: на проді 30.09 таких було 46, і про жодну «Приймає» не отримував звістки.
 *
 * ⚠️ Межа, свідома: дзвонить лише ПЕРЕХІД, побачений між двома опитуваннями відкритої
 * сторінки. Задача, що перейшла, поки дашборд був закритий, лишається під тихим бейджем
 * «є нове»; зведений тост при відкритті власник відхилив (30.09.2026).
 *
 * Модуль чистий і без імпортів — його транспілює й кличе гейт `#1080h`.
 */

export interface AcceptanceTaskLike {
  id: number;
  title: string;
  status: string;
  taskType?: string | null;
  /** «Приймає» з видачі — уже з замовчуванням «автор». */
  reviewerId?: number | null;
  assigneeId?: number | null;
  assigneeUserId?: number | null;
}

export interface AcceptanceViewer { userId: number | null | undefined; managerId: number | null | undefined }

/**
 * Чи дзвонити «Приймає» про цю задачу.
 * · `prevStatus` порожній — першого опитування ще не було (або задача нова): мовчимо,
 *   інакше кожне відкриття сторінки дзвонило б про все, що вже висить.
 * · Я виконавець — мовчимо: хто сам себе приймає, не отримує звістки про власний клік.
 * · Лише звичайні задачі: «Приймає» діє тільки на них.
 */
export function isAcceptanceAlert(t: AcceptanceTaskLike, prevStatus: string | undefined, me: AcceptanceViewer): boolean {
  if (me.userId == null || !prevStatus) return false;
  if (t.status !== "ready_for_approval" || prevStatus === "ready_for_approval") return false;
  if ((t.taskType ?? "simple") !== "simple") return false;
  if (t.reviewerId !== me.userId) return false;
  const iExecute = (me.managerId != null && t.assigneeId === me.managerId)
    || (t.assigneeUserId != null && t.assigneeUserId === me.userId);
  return !iExecute;
}

export function acceptanceAlertText(title: string, executorName?: string | null): string {
  return `✅ Чекає вашого прийняття${executorName ? ` — ${executorName}` : ""}: ${title.slice(0, 90)}`;
}
