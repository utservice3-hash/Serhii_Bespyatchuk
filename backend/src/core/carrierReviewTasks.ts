import type { Db } from "./adCallFacts.js";
import { decisionQueue } from "./carrierDecisions.js";

/**
 * 📋 ЗАДАЧА В ЗАДАЧНИКУ «РОЗІБРАТИ ДЗВІНКИ НА МОБІЛЬНІ» (Роман 30.09.2026: «ні [Telegram], тільки в задачник»;
 * «одна на менеджера на день»).
 *
 * У менеджера — ОДНА відкрита задача, поки в нього є угоди «На перевірці» чи «Помилка» (черга `decisionQueue`, та
 * сама, що вкладка): заголовок і опис несуть поточне число, строк — найраніший кінець робочого дня серед його угод
 * (`reviewDeadline`). Розібрав усе — задача закривається сама з причиною. Не розібрав до строку — задача лишається
 * відкритою й простроченою: так її видно в задачнику, і нову поверх ми не ставимо (інакше прострочку сховала б свіжа).
 * З'явились нові угоди після закриття — нова задача (нового дня — з новою датою).
 *
 * Журнал `carrier_review_tasks` — рядок на задачу; відкрита в менеджера одна (унікальний індекс у БД, не перевірка
 * в коді). Задачу видалили руками — рядок закривається, і наступний прохід поставить нову.
 */

export const REVIEW_TASK_DEPT = "Дзвінки на мобільні";

export function reviewTaskTitle(n: number): string {
  return `📞 Дзвінки на мобільні: розібрати ${String(n)}`;
}
export function reviewTaskDescription(n: number): string {
  return [
    `AI не впевнений — чекає вашого рішення угод: ${String(n)}.`,
    "Де: меню «Продаж» → «Перевізники за розмовою» → вкладка «AI не впевнений».",
    "Відкрийте угоду, послухайте запис і натисніть «Клієнт», «Перевізник» або «Інше».",
    "Задача закриється сама, щойно всі угоди буде розібрано. Створено автоматично.",
  ].join("\n");
}
export const REVIEW_TASK_DONE_REASON = "Закрито автоматично: усі дзвінки на мобільні розібрано.";

export interface ReviewTaskStats { managers: number; created: number; updated: number; closed: number }

const kyivDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

export async function syncCarrierReviewTasks(db: Db, now: Date, launchAt: Date | null): Promise<ReviewTaskStats> {
  const stats: ReviewTaskStats = { managers: 0, created: 0, updated: 0, closed: 0 };
  const { pending } = await decisionQueue(db, now, {}, 30, launchAt ? launchAt.toISOString() : null);
  const byMgr = new Map<number, { n: number; deadline: string | null }>();
  for (const p of pending) {
    if (p.managerId == null) continue;   // угода без відомого менеджера — задачі нікому (видно керівництву у вкладці)
    const x = byMgr.get(p.managerId) ?? { n: 0, deadline: null };
    x.n++;
    if (p.reviewDeadline && (!x.deadline || p.reviewDeadline < x.deadline)) x.deadline = p.reviewDeadline;
    byMgr.set(p.managerId, x);
  }
  stats.managers = byMgr.size;

  // Відкриті задачі; видалену руками — закриваємо в журналі, щоб наступний крок поставив нову.
  const open = new Map((await db.query<{ manager_id: number; task_id: number; status: string | null }>(`
    SELECT r.manager_id, r.task_id, t.status FROM carrier_review_tasks r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.closed_at IS NULL`)).rows.map((x) => [x.manager_id, x]));
  for (const [mgr, o] of open) {
    if (o.status == null || o.status === "done") {
      await db.query("UPDATE carrier_review_tasks SET closed_at = $2 WHERE task_id = $1", [o.task_id, now.toISOString()]);
      open.delete(mgr);
    }
  }

  for (const [mgr, x] of byMgr) {
    const o = open.get(mgr);
    if (o) {
      const upd = await db.query(`UPDATE tasks SET title = $2, description = $3, updated_at = $4
                                   WHERE id = $1 AND (title IS DISTINCT FROM $2 OR description IS DISTINCT FROM $3)`,
        [o.task_id, reviewTaskTitle(x.n), reviewTaskDescription(x.n), now.toISOString()]);
      if (upd.rowCount) stats.updated++;
      continue;
    }
    const m = (await db.query<{ team_name: string | null; active: boolean }>(
      "SELECT t.name AS team_name, m.is_active AS active FROM managers m LEFT JOIN teams t ON t.id = m.team_id WHERE m.id = $1", [mgr])).rows[0];
    if (!m?.active) continue;
    // Задача й рядок журналу — ОДНИМ оператором: задача без рядка журналу дала б дубль на наступному проході, а
    // `BEGIN` на пулі транзакції не гарантує (інше з'єднання). Друга відкрита на менеджера — унікальний індекс.
    await db.query(
      `WITH t AS (
         INSERT INTO tasks (title, description, status, deadline, assignee_id, priority, department, task_type, created_at, updated_at)
         VALUES ($1, $2, 'not_started', $3::date, $4, 'high', $5, 'simple', $6, $6) RETURNING id)
       INSERT INTO carrier_review_tasks (task_id, manager_id, opened_at) SELECT id, $4, $6 FROM t`,
      [reviewTaskTitle(x.n), reviewTaskDescription(x.n), kyivDate(x.deadline ? new Date(x.deadline) : now), mgr,
        m.team_name ?? REVIEW_TASK_DEPT, now.toISOString()]);
    stats.created++;
  }

  // Усе розібрано — закриваємо саму задачу з причиною (як «Пропущені дзвінки»: статус, причина, журнал статусів).
  for (const [mgr, o] of open) {
    if (byMgr.has(mgr)) continue;
    await db.query(`UPDATE tasks SET status = 'done', close_reason = $2, closed_at = $3, updated_at = $3 WHERE id = $1 AND status <> 'done'`,
      [o.task_id, REVIEW_TASK_DONE_REASON, now.toISOString()]);
    await db.query("INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, 'done', NULL)",
      [o.task_id, o.status ?? "not_started"]);
    await db.query("UPDATE carrier_review_tasks SET closed_at = $2 WHERE task_id = $1", [o.task_id, now.toISOString()]);
    stats.closed++;
  }
  return stats;
}
