import { pool } from "../db/pool.js";

/**
 * Fills actual_value for auto KPI tasks from CRM data and auto-completes any
 * that reached their target. Three shapes:
 *   - daily_kpi / ads_count    — one task per day; evaluated once the day passed.
 *   - weekly/monthly_kpi ads_count — parent rollup over the whole period.
 *   - weekly/monthly_kpi avg_check | conversion — period aggregate.
 * "Accepted ads" = deals with a Google-tagged channel (lead_channel='ad').
 */
export async function evaluateKpiTasks(): Promise<void> {
  const markDone =
    `UPDATE tasks SET actual_value = $1,
       status = CASE WHEN $2 THEN 'done' ELSE status END,
       comments = $3, updated_at = now()
     WHERE id = $4`;

  // 1) Daily ads_count sub-tasks for days that have already passed.
  const daily = await pool.query<{ id: number; assignee_id: number; target_value: string; plan_date: string }>(
    `SELECT id, assignee_id, target_value, plan_date FROM tasks
     WHERE auto AND task_type = 'daily_kpi' AND metric = 'ads_count'
       AND status <> 'done' AND plan_date <= (now()::date - 1)`
  );
  for (const t of daily.rows) {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*) c FROM deals
       WHERE manager_id = $1 AND lead_channel = 'ad'
         AND created_at_kommo >= $2::date AND created_at_kommo < $2::date + interval '1 day'`,
      [t.assignee_id, t.plan_date]
    );
    const actual = Number(r.rows[0].c);
    const target = Number(t.target_value);
    await pool.query(markDone, [actual, actual >= target, `Факт: ${actual} / ціль ${target}`, t.id]);
  }

  // 2) ads_count parent — total accepted ads over the whole period.
  const parents = await pool.query<{ id: number; assignee_id: number; target_value: string; period_start: string; period_end: string }>(
    `SELECT id, assignee_id, target_value, period_start, period_end FROM tasks
     WHERE auto AND task_type IN ('weekly_kpi','monthly_kpi') AND metric = 'ads_count' AND status <> 'done'`
  );
  for (const t of parents.rows) {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*) c FROM deals
       WHERE manager_id = $1 AND lead_channel = 'ad'
         AND created_at_kommo >= $2::date AND created_at_kommo < $3::date + interval '1 day'`,
      [t.assignee_id, t.period_start, t.period_end]
    );
    const actual = Number(r.rows[0].c);
    const target = Number(t.target_value);
    await pool.query(markDone, [actual, actual >= target, `Факт: ${actual} / ціль ${target}`, t.id]);
  }

  // 3) avg_check / conversion period aggregates.
  const aggs = await pool.query<{ id: number; assignee_id: number; metric: string; target_value: string; period_start: string; period_end: string }>(
    `SELECT id, assignee_id, metric, target_value, period_start, period_end FROM tasks
     WHERE auto AND task_type IN ('weekly_kpi','monthly_kpi')
       AND metric IN ('avg_check','conversion') AND status <> 'done'`
  );
  for (const t of aggs.rows) {
    let actual = 0;
    if (t.metric === "avg_check") {
      const r = await pool.query<{ v: string }>(
        `SELECT COALESCE(AVG(d.price), 0) v FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
         WHERE psm.funnel_stage = 'paid' AND d.manager_id = $1
           AND d.closed_at_kommo >= $2::date AND d.closed_at_kommo < $3::date + interval '1 day'`,
        [t.assignee_id, t.period_start, t.period_end]
      );
      actual = Math.round(Number(r.rows[0].v));
    } else {
      const r = await pool.query<{ paid: string; total: string }>(
        `SELECT COUNT(*) FILTER (WHERE psm.funnel_stage = 'paid') paid, COUNT(*) total FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
         WHERE d.manager_id = $1
           AND d.created_at_kommo >= $2::date AND d.created_at_kommo < $3::date + interval '1 day'`,
        [t.assignee_id, t.period_start, t.period_end]
      );
      const total = Number(r.rows[0].total);
      actual = total > 0 ? Math.round((Number(r.rows[0].paid) / total) * 100) : 0;
    }
    const target = Number(t.target_value);
    const suffix = t.metric === "conversion" ? "%" : "₴";
    await pool.query(markDone, [actual, actual >= target, `Факт: ${actual}${suffix} / ціль ${target}${suffix}`, t.id]);
  }

  console.log(`KPI tasks evaluated: ${daily.rowCount} daily, ${parents.rowCount} ads, ${aggs.rowCount} aggregate.`);
}

if (process.argv[1]?.endsWith("evaluateKpiTasks.js")) {
  evaluateKpiTasks()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
