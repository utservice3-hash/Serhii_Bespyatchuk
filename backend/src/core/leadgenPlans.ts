import { pool } from "../db/pool.js";
import { LEADGEN_DASH_TEAM_ID } from "./metrics.js";
import { activeManagerSql } from "./activeManager.js";
import {
  LEADGEN_PLAN_METRICS, personFormationStatus,
  type TeamMember, type ApprovedByMonth, type LeadgenPlanMetric, type LeadgenPlanValues, type LgFormationStatus,
} from "./leadgenPlanRules.js";

/**
 * 📋 ПЛАНИ ЛІДГЕНІВ — УСІ ЗАПИТИ ДО `leadgen_plans` І ДО СКЛАДУ КОМАНДИ «ЛІДОГЕНЕРАЦІЯ».
 *
 * 🔴 ЄДИНИЙ файл коду, що знає таблицю `leadgen_plans` (тримає `#750`): жоден продажний читач
 * планів її не бачить, а цей файл не читає й не пише продажні `plans`/`plan_formation`. Так
 * лідоген-план не може просочитись у Звіт, КВП, картку менеджера, plans-grid чи прогноз
 * за побудовою, а не за уважністю наступного, хто писатиме запит.
 *
 * Правила (хто в ростері, хто подає, як план ділиться на період) — чисті, у `leadgenPlanRules.ts`.
 * Тут — лише SQL і транзакції. Лічильники факту тут НЕ рахуються: їх дає `leadgenStats.ts`
 * тими самими предикатами, що й рядки екрана (рішення 2 — не нові предикати).
 */

/**
 * 👥 Активні учасники команди «Лідогенерація» ЗАРАЗ (поточний склад). «Активний» — за ОБОМА
 * джерелами (`activeManagerSql`): людина, яку вимкнули в Налаштуваннях, з команди на екрані
 * випадає так само, як деактивована в Kommo.
 */
export async function leadgenTeamMembers(): Promise<TeamMember[]> {
  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE m.team_id = $1 AND ${activeManagerSql("m")}
      ORDER BY m.name`, [LEADGEN_DASH_TEAM_ID]);
  return r.rows.map((x) => ({ managerId: x.id, name: x.name, teamId: x.team_id, teamName: x.team_name }));
}

/** Команда людини й чи вона ЗАРАЗ активний учасник «Лідогенерації». `null` — такої людини немає. */
export async function leadgenPlanTarget(managerId: number): Promise<{ teamId: number | null; isMember: boolean } | null> {
  const r = await pool.query<{ team_id: number | null; member: boolean }>(
    `SELECT m.team_id, (m.team_id = $2 AND ${activeManagerSql("m")}) AS member
       FROM managers m WHERE m.id = $1`, [managerId, LEADGEN_DASH_TEAM_ID]);
  if (!r.rows.length) return null;
  return { teamId: r.rows[0].team_id, isMember: r.rows[0].member === true };
}

/** Затверджені плани людей за місяці `[fromMonth … toMonth]` → людина → місяць → метрика → значення. */
export async function approvedLeadgenPlans(managerIds: readonly number[], from: string, to: string): Promise<Map<number, ApprovedByMonth>> {
  const out = new Map<number, ApprovedByMonth>();
  if (!managerIds.length) return out;
  const r = await pool.query<{ manager_id: number; month: string; metric: LeadgenPlanMetric; v: number }>(
    `SELECT manager_id, to_char(month, 'YYYY-MM-DD') AS month, metric, approved_value AS v
       FROM leadgen_plans
      WHERE manager_id = ANY($1) AND approved_value IS NOT NULL
        AND month BETWEEN date_trunc('month', $2::date)::date AND date_trunc('month', $3::date)::date`,
    [managerIds, from, to]);
  for (const x of r.rows) {
    const byMonth = out.get(x.manager_id) ?? new Map();
    const cur = byMonth.get(x.month) ?? {};
    cur[x.metric] = Number(x.v);
    byMonth.set(x.month, cur);
    out.set(x.manager_id, byMonth);
  }
  return out;
}

export interface LeadgenFormationRow {
  managerId: number;
  status: LgFormationStatus;
  proposed: Record<LeadgenPlanMetric, number | null>;
  approved: Record<LeadgenPlanMetric, number | null>;
  comment: string | null; returnComment: string | null;
  submittedBy: string | null; submittedAt: string | null; decidedBy: string | null; decidedAt: string | null;
}

/** Стан формування плану на місяць — по людині (три рядки-метрики зведено в один). */
export async function leadgenFormation(month: string, managerIds: readonly number[]): Promise<Map<number, LeadgenFormationRow>> {
  const out = new Map<number, LeadgenFormationRow>();
  if (!managerIds.length) return out;
  const r = await pool.query<{ manager_id: number; metric: LeadgenPlanMetric; proposed_value: number; approved_value: number | null;
    status: LgFormationStatus; comment: string | null; return_comment: string | null;
    submitted_name: string | null; submitted_at: string | null; decided_name: string | null; decided_at: string | null }>(
    `SELECT lp.manager_id, lp.metric, lp.proposed_value, lp.approved_value, lp.status, lp.comment, lp.return_comment,
            COALESCE(sm.name, su.email) AS submitted_name, to_char(lp.submitted_at, 'YYYY-MM-DD') AS submitted_at,
            COALESCE(dm.name, du.email) AS decided_name, to_char(lp.decided_at, 'YYYY-MM-DD') AS decided_at
       FROM leadgen_plans lp
       LEFT JOIN users su ON su.id = lp.submitted_by LEFT JOIN managers sm ON sm.id = su.manager_id
       LEFT JOIN users du ON du.id = lp.decided_by LEFT JOIN managers dm ON dm.id = du.manager_id
      WHERE lp.month = $1 AND lp.manager_id = ANY($2)`, [month, managerIds]);
  const statuses = new Map<number, LgFormationStatus[]>();
  for (const x of r.rows) {
    const e = out.get(x.manager_id) ?? {
      managerId: x.manager_id, status: "draft" as LgFormationStatus,
      proposed: { leads: null, opr: null, quotes: null }, approved: { leads: null, opr: null, quotes: null },
      comment: null, returnComment: null, submittedBy: null, submittedAt: null, decidedBy: null, decidedAt: null,
    };
    e.proposed[x.metric] = Number(x.proposed_value);
    e.approved[x.metric] = x.approved_value == null ? null : Number(x.approved_value);
    e.comment ??= x.comment; e.returnComment ??= x.return_comment;
    e.submittedBy ??= x.submitted_name; e.submittedAt ??= x.submitted_at;
    e.decidedBy ??= x.decided_name; e.decidedAt ??= x.decided_at;
    statuses.set(x.manager_id, [...(statuses.get(x.manager_id) ?? []), x.status]);
    out.set(x.manager_id, e);
  }
  for (const [id, e] of out) e.status = personFormationStatus(statuses.get(id) ?? []);
  return out;
}

/**
 * ↑ ПОДАННЯ: три рядки однією транзакцією, стан → `submitted`. `approved_value` НЕ чіпається —
 * живим лишається попередній затверджений план, поки новий на розгляді (як `plans` у продажах).
 * Межу (хто кому) перевіряє роут ДО виклику — `leadgenSubmitRefusal`.
 */
export async function submitLeadgenPlan(managerId: number, month: string, values: LeadgenPlanValues,
  comment: string | null, userId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const k of LEADGEN_PLAN_METRICS) {
      await client.query(
        `INSERT INTO leadgen_plans (manager_id, month, metric, proposed_value, status, comment, submitted_by, submitted_at, updated_at)
         VALUES ($1, $2, $3, $4, 'submitted', $5, $6, now(), now())
         ON CONFLICT (manager_id, month, metric) DO UPDATE
            SET proposed_value = EXCLUDED.proposed_value, status = 'submitted', comment = EXCLUDED.comment,
                submitted_by = EXCLUDED.submitted_by, submitted_at = now(), return_comment = NULL, updated_at = now()`,
        [managerId, month, k, values[k], comment, userId]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally {
    client.release();
  }
}

/**
 * ✓ ЗАТВЕРДЖЕННЯ: одна людина або ВСІ подані за місяць (батч, як «Затвердити подані» у продажах).
 * `approved_value = proposed_value` — лише тут план стає живим. Повертає кількість ЛЮДЕЙ.
 */
export async function approveLeadgenPlans(month: string, managerId: number | null, userId: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ manager_id: number }>(
      `UPDATE leadgen_plans
          SET approved_value = proposed_value, status = 'approved', decided_by = $3, decided_at = now(), updated_at = now()
        WHERE month = $1 AND status = 'submitted' AND ($2::int IS NULL OR manager_id = $2::int)
        RETURNING manager_id`, [month, managerId, userId]);
    await client.query("COMMIT");
    return new Set(r.rows.map((x) => x.manager_id)).size;
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally {
    client.release();
  }
}

/** ↩ ПОВЕРНЕННЯ: лише подане; живий (попередній затверджений) план лишається. Повертає к-сть рядків. */
export async function returnLeadgenPlan(month: string, managerId: number, returnComment: string | null, userId: number): Promise<number> {
  const r = await pool.query(
    `UPDATE leadgen_plans
        SET status = 'returned', return_comment = $3, decided_by = $4, decided_at = now(), updated_at = now()
      WHERE month = $1 AND manager_id = $2 AND status = 'submitted'`, [month, managerId, returnComment, userId]);
  return r.rowCount ?? 0;
}
