/**
 * 🎯 СТРАТЕГІЧНІ ЗАДАЧІ (рішення Романа 23.10.2026).
 *
 * Ціль із результатом одним реченням; підзадачі — звичайні задачі з `goal_id`. Рішення Романа:
 * ставить БУДЬ-ХТО (26.10.2026; спершу 23.10 було «лише власник» — скасовано), ліміту немає,
 * підзадачі — будь-кому, виконавець підзадачі бачить ціль, закриває «Приймає», статуси як у звичайних.
 *
 * 🔴 ЗВʼЯЗОК — `goal_id`, А НЕ `parent_id`. `parent_id` уже тримають денні KPI й пачки
 * реактивації, а список задачника ховає дітей `parent_id`: підзадача зникла б у виконавця.
 */
import type { Pool, PoolClient } from "pg";

export const STRATEGIC_TASK_TYPE = "strategic";

type Db = Pick<Pool | PoolClient, "query">;

/**
 * Перевірка цілі, до якої чіпляють підзадачу. Повертає текст відмови або `null`, якщо можна.
 * Ціль мусить існувати й бути стратегічною (вкладеності глибше одного рівня немає).
 */
export async function goalLinkError(db: Db, goalId: number): Promise<string | null> {
  const r = await db.query<{ task_type: string }>(`SELECT task_type FROM tasks WHERE id = $1`, [goalId]);
  if (!r.rows.length) return "Стратегічну задачу не знайдено";
  if (r.rows[0].task_type !== STRATEGIC_TASK_TYPE) return "Підзадачу можна привʼязати лише до стратегічної задачі";
  return null;
}
