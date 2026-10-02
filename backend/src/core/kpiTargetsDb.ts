/**
 * 🎯 ЦІЛІ-ПОКАЗНИКИ ІЗ ЗАДАЧНИКА ЗА ПЕРІОД — читання з БД + чисте накопичення (`kpiTargets.accumulateKpiTargets`).
 *
 * Доти ці два запити жили інлайном у `/report-plan`. Винесено ДОСЛІВНО (02.10.2026), бо тепер ті самі цілі
 * читають і Статистики (плитка «Відправлені авто» з планом KPI `dispatch_count`, рішення Романа 02.10): друга
 * копія SQL розійшлася б зі Звітом на першій правці.
 *
 * Ключ результату — `tasks.assignee_id` (= `managers.id`); значення — метрика → ціль за [from, to]
 * (лічильні складаються з апортуванням по робочих днях перетину, ставкові — MAX).
 *
 * 🔴 `period_kind` ТЯГНЕТЬСЯ, А НЕ ФІЛЬТРУЄТЬСЯ В SQL. Місячні парасольки потрібні, щоб їхні дні лишались
 * ПОКРИТИМИ: інакше прихована денна дитина місячного плану стала б «нічийною», і daily-фолбек повернув би
 * зняту ціль через задні двері. Рішення «яку ціль читати» ухвалює `accumulateKpiTargets`.
 */
import { pool } from "../db/pool.js";
import { accumulateKpiTargets } from "./kpiTargets.js";

export async function loadKpiTargets(from: string, to: string): Promise<Map<number, Record<string, number>>> {
  const umbRows = (await pool.query<{ assignee_id: number; ps: string; pe: string; kind: string | null; metrics_json: { metric: string; target: number | string }[] | null }>(
    `SELECT t.assignee_id, to_char(t.period_start,'YYYY-MM-DD') ps,
            to_char(COALESCE(t.period_end, t.period_start),'YYYY-MM-DD') pe,
            t.period_kind AS kind, t.metrics_json
       FROM tasks t
      WHERE t.auto AND t.task_type = 'kpi_period' AND t.assignee_id IS NOT NULL
        AND t.metrics_json IS NOT NULL
        AND t.period_start <= $2 AND COALESCE(t.period_end, t.period_start) >= $1`, [from, to]
  )).rows;
  const dayRows = (await pool.query<{ assignee_id: number; pd: string; metrics_json: { metric: string; target: number | string }[] | null }>(
    `SELECT t.assignee_id, to_char(t.plan_date,'YYYY-MM-DD') pd, t.metrics_json
       FROM tasks t
      WHERE t.auto AND t.task_type = 'daily_kpi' AND t.assignee_id IS NOT NULL
        AND t.metrics_json IS NOT NULL AND t.plan_date BETWEEN $1 AND $2`, [from, to]
  )).rows;
  return accumulateKpiTargets(
    umbRows.map((u) => ({ assigneeId: u.assignee_id, from: u.ps, to: u.pe, kind: u.kind, metrics: u.metrics_json })),
    dayRows.map((r) => ({ assigneeId: r.assignee_id, day: r.pd, metrics: r.metrics_json })),
    from, to
  );
}
