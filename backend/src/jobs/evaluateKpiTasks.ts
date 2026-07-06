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

  const channelOf = (metric: string) => (metric === "leadgen_count" ? "leadgen" : "ad");

  // 1) Daily count sub-tasks (ads / leadgen) for days that have already passed.
  const daily = await pool.query<{ id: number; assignee_id: number; metric: string; target_value: string; plan_date: string }>(
    `SELECT id, assignee_id, metric, target_value, plan_date FROM tasks
     WHERE auto AND task_type = 'daily_kpi' AND metric IN ('ads_count','leadgen_count')
       AND status <> 'done' AND plan_date <= (now()::date - 1)`
  );
  for (const t of daily.rows) {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*) c FROM deals
       WHERE manager_id = $1 AND lead_channel = $3
         AND created_at_kommo >= $2::date AND created_at_kommo < $2::date + interval '1 day'`,
      [t.assignee_id, t.plan_date, channelOf(t.metric)]
    );
    const actual = Number(r.rows[0].c);
    const target = Number(t.target_value);
    await pool.query(markDone, [actual, actual >= target, `Факт: ${actual} / ціль ${target}`, t.id]);
  }

  // 2) Count parents — total accepted ads / leadgen over the whole period.
  const parents = await pool.query<{ id: number; assignee_id: number; metric: string; target_value: string; period_start: string; period_end: string }>(
    `SELECT id, assignee_id, metric, target_value, period_start, period_end FROM tasks
     WHERE auto AND task_type IN ('weekly_kpi','monthly_kpi') AND metric IN ('ads_count','leadgen_count') AND status <> 'done'`
  );
  for (const t of parents.rows) {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*) c FROM deals
       WHERE manager_id = $1 AND lead_channel = $4
         AND created_at_kommo >= $2::date AND created_at_kommo < $3::date + interval '1 day'`,
      [t.assignee_id, t.period_start, t.period_end, channelOf(t.metric)]
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

  // 4) Composite daily tasks (metrics_json bundle: sum/ads/leadgen/avg/conv for
  //    one day). Fill each metric's actual/done; the task is done when ALL met.
  const composite = await pool.query<{ id: number; assignee_id: number; plan_date: string; metrics_json: { metric: string; target: number }[] }>(
    `SELECT id, assignee_id, plan_date, metrics_json FROM tasks
     WHERE auto AND task_type = 'daily_kpi' AND metrics_json IS NOT NULL
       AND status <> 'done' AND plan_date <= (now()::date - 1)`
  );
  for (const t of composite.rows) {
    const out: { metric: string; target: number; actual: number; done: boolean }[] = [];
    for (const m of t.metrics_json) {
      let actual = 0;
      if (m.metric === "ads_count" || m.metric === "leadgen_count") {
        const r = await pool.query<{ c: string }>(
          `SELECT COUNT(*) c FROM deals WHERE manager_id = $1 AND lead_channel = $3
             AND created_at_kommo >= $2::date AND created_at_kommo < $2::date + interval '1 day'`,
          [t.assignee_id, t.plan_date, channelOf(m.metric)]
        );
        actual = Number(r.rows[0].c);
      } else if (m.metric === "avg_check") {
        const r = await pool.query<{ v: string }>(
          `SELECT COALESCE(AVG(d.price),0) v FROM deals d
             JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
             WHERE psm.funnel_stage = 'paid' AND d.manager_id = $1
               AND d.closed_at_kommo >= $2::date AND d.closed_at_kommo < $2::date + interval '1 day'`,
          [t.assignee_id, t.plan_date]
        );
        actual = Math.round(Number(r.rows[0].v));
      } else if (m.metric === "conversion") {
        const r = await pool.query<{ paid: string; total: string }>(
          `SELECT COUNT(*) FILTER (WHERE psm.funnel_stage='paid') paid, COUNT(*) total FROM deals d
             JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
             WHERE d.manager_id = $1 AND d.created_at_kommo >= $2::date AND d.created_at_kommo < $2::date + interval '1 day'`,
          [t.assignee_id, t.plan_date]
        );
        const total = Number(r.rows[0].total);
        actual = total > 0 ? Math.round((Number(r.rows[0].paid) / total) * 100) : 0;
      } else if (m.metric === "payment_amount") {
        const r = await pool.query<{ v: string }>(
          `SELECT COALESCE(SUM(d.price),0) v FROM deals d
             JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
             WHERE psm.funnel_stage = 'paid' AND d.manager_id = $1
               AND d.closed_at_kommo >= $2::date AND d.closed_at_kommo < $2::date + interval '1 day'`,
          [t.assignee_id, t.plan_date]
        );
        actual = Math.round(Number(r.rows[0].v));
      }
      out.push({ metric: m.metric, target: m.target, actual, done: actual >= m.target });
    }
    const allDone = out.length > 0 && out.every((x) => x.done);
    await pool.query(
      `UPDATE tasks SET metrics_json = $1,
         status = CASE WHEN $2 THEN 'done' ELSE status END, updated_at = now()
       WHERE id = $3`,
      [JSON.stringify(out), allDone, t.id]
    );
  }

  console.log(`KPI tasks evaluated: ${daily.rowCount} daily, ${parents.rowCount} ads, ${aggs.rowCount} aggregate, ${composite.rowCount} composite.`);
}

if (process.argv[1]?.endsWith("evaluateKpiTasks.js")) {
  evaluateKpiTasks()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
