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
import { normalizeClientName } from "../utils/clientName.js";

export * from "./reactivationRules.js";
import { SLEEPING_DAYS, LOST_DAYS, stateOf, valueScore, type ClientState } from "./reactivationRules.js";
export type { ClientState };
void SLEEPING_DAYS; void LOST_DAYS;

export interface ReactivationScope { managerId?: number; teamId?: number }

export interface TaskRef {
  clientKey: string; id: number; status: string; deadline: string | null;
  closeReason: string | null; createdAt: Date; assignee: string | null;
}

/**
 * Найсвіжіша реактиваційна задача ПО КЛІЄНТУ — з ОБОХ типів:
 *   `reactivation_client` — одна задача = один клієнт (новий екран, Фаза B);
 *   `reactivation`        — стара ПАЧКА з чеклістом, клієнт усередині JSON.
 *
 * 🔴 ПАЧКИ ВРАХОВУЮТЬСЯ ЗА ЗАМІРОМ, НЕ ЗА ПРИПУЩЕННЯМ. Схема обіцяла `clientKey`
 * у чеклісті, але обіцянка схеми — це намір, а не дані. Замір (03.08.2026):
 * 12 задач, 94 елементи, `clientKey` заповнений у 94/94; напряму зіставились 78,
 * решта 16 — старі ключі з ПРОБІЛАМИ (писались до бекфілу нормалізації).
 *
 * 🔴 Нормалізація — ТІЄЮ САМОЮ функцією, що нею користується синк
 * (`normalizeClientName`), а не схожим регекспом у SQL. Регексп «прибрати
 * пробіли» теж відновлював усі 16 — але через півроку він розійшовся б із
 * правилами синку, і ми б цього не помітили. Перевірено ще й на ідемпотентність:
 * на 500 живих ключах функція не змінила ЖОДНОГО.
 */
export async function reactivationTasksByClient(): Promise<Map<string, TaskRef>> {
  const direct = (await pool.query<{ client_key: string; id: number; status: string;
    deadline: string | null; close_reason: string | null; created_at: Date; assignee: string | null }>(
    `SELECT t.client_key, t.id, t.status, to_char(t.deadline,'YYYY-MM-DD') AS deadline,
            t.close_reason, t.created_at, mgr.name AS assignee
       FROM tasks t LEFT JOIN managers mgr ON mgr.id = t.assignee_id
      WHERE t.task_type = 'reactivation_client' AND t.client_key IS NOT NULL`)).rows;

  const bundles = (await pool.query<{ id: number; status: string; deadline: string | null;
    close_reason: string | null; created_at: Date; assignee: string | null; checklist: unknown }>(
    `SELECT t.id, t.status, to_char(t.deadline,'YYYY-MM-DD') AS deadline, t.close_reason,
            t.created_at, mgr.name AS assignee, t.checklist_json AS checklist
       FROM tasks t LEFT JOIN managers mgr ON mgr.id = t.assignee_id
      WHERE t.task_type = 'reactivation' AND jsonb_typeof(t.checklist_json) = 'array'`)).rows;

  const out = new Map<string, TaskRef>();
  const put = (key: string | null, t: Omit<TaskRef, "clientKey">) => {
    if (!key) return;
    const prev = out.get(key);
    if (!prev || prev.createdAt < t.createdAt) out.set(key, { clientKey: key, ...t });
  };
  for (const d of direct) {
    put(normalizeClientName(d.client_key) ?? d.client_key,
      { id: d.id, status: d.status, deadline: d.deadline, closeReason: d.close_reason,
        createdAt: d.created_at, assignee: d.assignee });
  }
  for (const b of bundles) {
    const items = Array.isArray(b.checklist) ? (b.checklist as { clientKey?: string }[]) : [];
    for (const it of items) {
      const raw = (it?.clientKey ?? "").trim();
      if (!raw) continue;
      put(normalizeClientName(raw) ?? raw,
        { id: b.id, status: b.status, deadline: b.deadline, closeReason: b.close_reason,
          createdAt: b.created_at, assignee: b.assignee });
    }
  }
  return out;
}



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
  const taskMap = await reactivationTasksByClient();
  const taskKeys = [...taskMap.keys()];
  const taskDates = taskKeys.map((k) => taskMap.get(k)!.createdAt);
  const p: unknown[] = [GENERIC_CLIENT_KEYS];
  let cond = "";
  if (s.managerId != null) { p.push(s.managerId); cond = `AND mm.id = $${p.length}`; }
  else if (s.teamId != null) { p.push(s.teamId); cond = `AND mm.team_id = $${p.length}`; }
  p.push(taskKeys); const TK = `$${p.length}`;
  p.push(taskDates); const TC = `$${p.length}`;

  const rows = (await pool.query<{
    client_key: string; client_name: string | null; orders: string; revenue: string;
    last_paid: string | null; days_since: string; manager_id: number; manager_name: string;
    seasonal: boolean | null; seasonal_note: string | null;
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
     tasks_in AS (
       SELECT * FROM (SELECT UNNEST($TK::text[]) AS client_key, UNNEST($TC::timestamptz[]) AS created_at) t
     )
     SELECT a.client_key, nm.client_name, a.orders, a.revenue,
            to_char(a.last_paid ${KYIV}, 'YYYY-MM-DD') AS last_paid,
            GREATEST(0, (CURRENT_DATE - (a.last_paid ${KYIV})::date))::int AS days_since,
            COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id, mm.name AS manager_name,
            lo.seasonal, lo.seasonal_note,
            (SELECT COALESCE(SUM(p2.price),0) FROM paid p2
              WHERE p2.client_key = a.client_key AND tk.created_at IS NOT NULL
                AND p2.closed_at_kommo > tk.created_at) AS revenue_after_task
       FROM agg a
       JOIN primary_mgr pm ON pm.client_key = a.client_key
       LEFT JOIN loyalty_overrides lo ON lo.client_key = a.client_key AND NOT lo.hidden
       JOIN managers mm ON mm.id = COALESCE(lo.pinned_manager_id, pm.manager_id) AND mm.is_active
       LEFT JOIN tasks_in tk ON tk.client_key = a.client_key
       LEFT JOIN LATERAL (
         SELECT d2.client_name FROM deals d2
          WHERE d2.client_key = a.client_key AND d2.client_name IS NOT NULL
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
      WHERE COALESCE(lo.hidden, false) = false ${cond}`, p)).rows;

  return rows.map((r) => {
    const tk = taskMap.get(r.client_key);
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
      taskId: tk?.id ?? null,
      taskStatus: tk?.status ?? null,
      taskAssignee: tk?.assignee ?? null,
      taskDeadline: tk?.deadline ?? null,
      closeReason: tk?.closeReason ?? null,
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
  const taskMap = await reactivationTasksByClient();
  const p: unknown[] = [GENERIC_CLIENT_KEYS, days];
  let cond = "";
  if (s.managerId != null) { p.push(s.managerId); cond = `AND mm.id = $${p.length}`; }
  else if (s.teamId != null) { p.push(s.teamId); cond = `AND mm.team_id = $${p.length}`; }
  const keys = [...taskMap.keys()];
  p.push(keys); const TK = `$${p.length}`;
  p.push(keys.map((k) => taskMap.get(k)!.createdAt)); const TC = `$${p.length}`;
  const r = (await pool.query<{ clients: string; revenue: string }>(
    `WITH paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND NOT (d.client_key = ANY($1))
     ),
     task AS (
       SELECT * FROM (SELECT UNNEST($TK::text[]) AS client_key, UNNEST($TC::timestamptz[]) AS created_at) t
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
