/**
 * 🔁 ЯДРО РЕАКТИВАЦІЇ — стани клієнтів і результат повернення.
 *
 * 🔴 СТАН — ПОХІДНА ВІД ДАТ, А НЕ ЗБЕРЕЖЕНЕ ПОЛЕ. Постійний → сплячий (60 дн.) →
 * втрачений (180 дн.) → повернений. Жодного тумблера «зробити сплячим» немає й не
 * буде: збережений стан треба комусь оновлювати, а джоба, що тихо не відпрацювала,
 * лишила б «сплячим» клієнта, який учора замовив. Ми це вже проходили зі знімками
 * у грошах — вони мутували минулі місяці.
 *
 * Руками ставиться РІВНО ОДНЕ — позначка «сезонний»: з дат її вивести неможливо
 * (зерно, опалення, ремонти), тож це рішення людини.
 */
import { pool } from "../db/pool.js";
import { GENERIC_CLIENT_KEYS } from "./metrics.js";

export * from "./reactivationRules.js";
import { SLEEPING_DAYS, LOST_DAYS, stateOf, valueScore, type ClientState } from "./reactivationRules.js";
export type { ClientState };
void SLEEPING_DAYS; void LOST_DAYS;

export interface ReactivationScope { managerId?: number; teamId?: number }

export interface ReactivationClient {
  clientKey: string;
  clientName: string;
  managerId: number;
  managerName: string;
  orders: number;
  lifetimeRevenue: number;
  lastPaid: string | null;
  daysSince: number;
  state: ClientState;
  value: number;
  seasonal: boolean;
  seasonalNote: string | null;
  /** Активна задача реактивації по цьому клієнту, якщо є. */
  taskId: number | null;
  taskStatus: string | null;
  taskAssignee: string | null;
  taskDeadline: string | null;
  closeReason: string | null;
  /** Замовив ПІСЛЯ створення реактиваційної задачі — «повернений». */
  returned: boolean;
  returnedRevenue: number;
}

const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

/**
 * Клієнти з їхнім станом. Беремо ВСІХ, у кого 2+ оплат lifetime (та сама межа
 * «постійного», що на екрані планів — інакше два екрани рахували б різних людей).
 */
export async function clientStates(s: ReactivationScope): Promise<ReactivationClient[]> {
  const p: unknown[] = [GENERIC_CLIENT_KEYS];
  let cond = "";
  if (s.managerId != null) { p.push(s.managerId); cond = `AND mm.id = $${p.length}`; }
  else if (s.teamId != null) { p.push(s.teamId); cond = `AND mm.team_id = $${p.length}`; }

  const rows = (await pool.query<{
    client_key: string; client_name: string | null; orders: string; revenue: string;
    last_paid: string | null; days_since: string; manager_id: number; manager_name: string;
    seasonal: boolean | null; seasonal_note: string | null;
    task_id: number | null; task_status: string | null; task_assignee: string | null;
    task_deadline: string | null; close_reason: string | null; task_created: string | null;
    revenue_after_task: string | null;
  }>(
    `WITH paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
          AND NOT (d.client_key = ANY($1))
     ),
     agg AS (
       SELECT client_key, COUNT(*)::int AS orders, COALESCE(SUM(price),0) AS revenue,
              MAX(closed_at_kommo) AS last_paid
         FROM paid GROUP BY client_key HAVING COUNT(*) >= 2
     ),
     per_cm AS (SELECT client_key, manager_id, COUNT(*) AS n, MAX(closed_at_kommo) AS mx FROM paid GROUP BY 1,2),
     primary_mgr AS (SELECT DISTINCT ON (client_key) client_key, manager_id FROM per_cm ORDER BY client_key, n DESC, mx DESC),
     -- Найсвіжіша реактиваційна задача по клієнту (їх може бути кілька за історію).
     task AS (
       SELECT DISTINCT ON (t.client_key) t.client_key, t.id, t.status, t.deadline, t.close_reason,
              t.created_at, mgr.name AS assignee
         FROM tasks t LEFT JOIN managers mgr ON mgr.id = t.assignee_id
        WHERE t.task_type = 'reactivation_client' AND t.client_key IS NOT NULL
        ORDER BY t.client_key, t.created_at DESC
     )
     SELECT a.client_key, nm.client_name, a.orders, a.revenue,
            to_char(a.last_paid ${KYIV}, 'YYYY-MM-DD') AS last_paid,
            GREATEST(0, (CURRENT_DATE - (a.last_paid ${KYIV})::date))::int AS days_since,
            COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id, mm.name AS manager_name,
            lo.seasonal, lo.seasonal_note,
            tk.id AS task_id, tk.status AS task_status, tk.assignee AS task_assignee,
            to_char(tk.deadline, 'YYYY-MM-DD') AS task_deadline, tk.close_reason,
            to_char(tk.created_at ${KYIV}, 'YYYY-MM-DD') AS task_created,
            (SELECT COALESCE(SUM(p2.price),0) FROM paid p2
              WHERE p2.client_key = a.client_key AND tk.created_at IS NOT NULL
                AND p2.closed_at_kommo > tk.created_at) AS revenue_after_task
       FROM agg a
       JOIN primary_mgr pm ON pm.client_key = a.client_key
       LEFT JOIN loyalty_overrides lo ON lo.client_key = a.client_key AND NOT lo.hidden
       JOIN managers mm ON mm.id = COALESCE(lo.pinned_manager_id, pm.manager_id) AND mm.is_active
       LEFT JOIN task tk ON tk.client_key = a.client_key
       LEFT JOIN LATERAL (
         SELECT d2.client_name FROM deals d2
          WHERE d2.client_key = a.client_key AND d2.client_name IS NOT NULL
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
      WHERE COALESCE(lo.hidden, false) = false ${cond}`, p)).rows;

  return rows.map((r) => {
    const days = Number(r.days_since);
    const revenue = Number(r.revenue);
    const returnedRevenue = Number(r.revenue_after_task ?? 0);
    return {
      clientKey: r.client_key,
      clientName: r.client_name ?? r.client_key,
      managerId: r.manager_id,
      managerName: r.manager_name,
      orders: Number(r.orders),
      lifetimeRevenue: revenue,
      lastPaid: r.last_paid,
      daysSince: days,
      state: stateOf(days),
      value: valueScore(revenue, days),
      seasonal: r.seasonal ?? false,
      seasonalNote: r.seasonal_note,
      taskId: r.task_id,
      taskStatus: r.task_status,
      taskAssignee: r.task_assignee,
      taskDeadline: r.task_deadline,
      closeReason: r.close_reason,
      returned: returnedRevenue > 0,
      returnedRevenue,
    };
  });
}

export interface ReturnedAgg { clients: number; revenue: number }
/**
 * ПЛИТКА «Повернено за N днів». Метрика РЕЗУЛЬТАТУ, тому визначення жорстке:
 * клієнт, у якого була реактиваційна задача, і ПІСЛЯ дати її створення зʼявилась
 * оплата. Не «замовив у періоді» — інакше сюди потрапили б ті, хто й не йшов.
 */
export async function returnedAfterTask(days: number, s: ReactivationScope): Promise<ReturnedAgg> {
  const p: unknown[] = [GENERIC_CLIENT_KEYS, days];
  let cond = "";
  if (s.managerId != null) { p.push(s.managerId); cond = `AND mm.id = $${p.length}`; }
  else if (s.teamId != null) { p.push(s.teamId); cond = `AND mm.team_id = $${p.length}`; }
  const r = (await pool.query<{ clients: string; revenue: string }>(
    `WITH paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND NOT (d.client_key = ANY($1))
     ),
     task AS (
       SELECT DISTINCT ON (t.client_key) t.client_key, t.created_at, t.assignee_id
         FROM tasks t WHERE t.task_type = 'reactivation_client' AND t.client_key IS NOT NULL
        ORDER BY t.client_key, t.created_at DESC
     )
     SELECT COUNT(DISTINCT p2.client_key) AS clients, COALESCE(SUM(p2.price),0) AS revenue
       FROM paid p2
       JOIN task tk ON tk.client_key = p2.client_key
       JOIN managers mm ON mm.id = p2.manager_id
      WHERE p2.closed_at_kommo > tk.created_at
        AND (p2.closed_at_kommo ${KYIV})::date >= CURRENT_DATE - ($2::int || ' days')::interval
        ${cond}`, p)).rows[0];
  return { clients: Number(r?.clients ?? 0), revenue: Number(r?.revenue ?? 0) };
}
