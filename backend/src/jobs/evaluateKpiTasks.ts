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
  for (const t of daily.rows) try {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*) c FROM deals
       WHERE manager_id = $1 AND lead_channel = $3
         AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date = $2::date`,
      [t.assignee_id, t.plan_date, channelOf(t.metric)]
    );
    const actual = Number(r.rows[0].c);
    const target = Number(t.target_value);
    await pool.query(markDone, [actual, actual >= target, `Факт: ${actual} / ціль ${target}`, t.id]);
  } catch (err) { console.error(`evaluateKpiTasks: daily task ${t.id} failed:`, err); }

  // 2) Count parents — total accepted ads / leadgen over the whole period.
  const parents = await pool.query<{ id: number; assignee_id: number; metric: string; target_value: string; period_start: string; period_end: string }>(
    `SELECT id, assignee_id, metric, target_value, period_start, period_end FROM tasks
     WHERE auto AND task_type IN ('weekly_kpi','monthly_kpi') AND metric IN ('ads_count','leadgen_count') AND status <> 'done'`
  );
  for (const t of parents.rows) try {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*) c FROM deals
       WHERE manager_id = $1 AND lead_channel = $4
         AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date`,
      [t.assignee_id, t.period_start, t.period_end, channelOf(t.metric)]
    );
    const actual = Number(r.rows[0].c);
    const target = Number(t.target_value);
    await pool.query(markDone, [actual, actual >= target, `Факт: ${actual} / ціль ${target}`, t.id]);
  } catch (err) { console.error(`evaluateKpiTasks: parent task ${t.id} failed:`, err); }

  // 3) avg_check / conversion period aggregates.
  const aggs = await pool.query<{ id: number; assignee_id: number; metric: string; target_value: string; period_start: string; period_end: string }>(
    `SELECT id, assignee_id, metric, target_value, period_start, period_end FROM tasks
     WHERE auto AND task_type IN ('weekly_kpi','monthly_kpi')
       AND metric IN ('avg_check','conversion') AND status <> 'done'`
  );
  for (const t of aggs.rows) try {
    let actual = 0;
    if (t.metric === "avg_check") {
      const r = await pool.query<{ v: string }>(
        `SELECT COALESCE(AVG(d.price), 0) v FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
         WHERE psm.funnel_stage = 'paid' AND d.manager_id = $1
           AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date`,
        [t.assignee_id, t.period_start, t.period_end]
      );
      actual = Math.round(Number(r.rows[0].v));
    } else {
      const r = await pool.query<{ paid: string; total: string }>(
        `SELECT COUNT(*) FILTER (WHERE psm.funnel_stage = 'paid') paid, COUNT(*) total FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
         WHERE d.manager_id = $1
           AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2::date AND $3::date`,
        [t.assignee_id, t.period_start, t.period_end]
      );
      const total = Number(r.rows[0].total);
      actual = total > 0 ? Math.round((Number(r.rows[0].paid) / total) * 100) : 0;
    }
    const target = Number(t.target_value);
    const suffix = t.metric === "conversion" ? "%" : "₴";
    await pool.query(markDone, [actual, actual >= target, `Факт: ${actual}${suffix} / ціль ${target}${suffix}`, t.id]);
  } catch (err) { console.error(`evaluateKpiTasks: aggregate task ${t.id} failed:`, err); }

  // 4) Composite daily tasks (metrics_json bundle: sum/ads/leadgen/avg/conv for
  //    one day). Fill each metric's actual/done; the task is done when ALL met.
  //    Window: last 14 days INCLUDING today (live intraday fact) and including
  //    manually-closed tasks — their facts keep refreshing, status never reverts.
  const composite = await pool.query<{ id: number; assignee_id: number; plan_date: string; metrics_json: { metric: string; target: number }[] }>(
    `SELECT id, assignee_id, to_char(plan_date, 'YYYY-MM-DD') AS plan_date, metrics_json FROM tasks
     WHERE auto AND task_type = 'daily_kpi' AND metrics_json IS NOT NULL
       AND plan_date BETWEEN (now() AT TIME ZONE 'Europe/Kyiv')::date - 14 AND (now() AT TIME ZONE 'Europe/Kyiv')::date`
  );
  for (const t of composite.rows) try {
    if (!Array.isArray(t.metrics_json)) continue;
    const out: { metric: string; target: number; actual: number; done: boolean }[] = [];
    for (const m of t.metrics_json) {
      let actual = 0;
      if (m.metric === "ads_count" || m.metric === "leadgen_count") {
        const r = await pool.query<{ c: string }>(
          `SELECT COUNT(*) c FROM deals WHERE manager_id = $1 AND lead_channel = $3
             AND (created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date = $2::date`,
          [t.assignee_id, t.plan_date, channelOf(m.metric)]
        );
        actual = Number(r.rows[0].c);
      } else if (m.metric === "avg_check") {
        const r = await pool.query<{ v: string }>(
          `SELECT COALESCE(AVG(d.price),0) v FROM deals d
             JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
             WHERE psm.funnel_stage = 'paid' AND d.manager_id = $1
               AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date = $2::date`,
          [t.assignee_id, t.plan_date]
        );
        actual = Math.round(Number(r.rows[0].v));
      } else if (m.metric === "conversion") {
        const r = await pool.query<{ paid: string; total: string }>(
          `SELECT COUNT(*) FILTER (WHERE psm.funnel_stage='paid') paid, COUNT(*) total FROM deals d
             JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
             WHERE d.manager_id = $1 AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date = $2::date`,
          [t.assignee_id, t.plan_date]
        );
        const total = Number(r.rows[0].total);
        actual = total > 0 ? Math.round((Number(r.rows[0].paid) / total) * 100) : 0;
      } else if (m.metric === "payment_amount") {
        const r = await pool.query<{ v: string }>(
          `SELECT COALESCE(SUM(d.price),0) v FROM deals d
             JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
             WHERE psm.funnel_stage = 'paid' AND d.manager_id = $1
               AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date = $2::date`,
          [t.assignee_id, t.plan_date]
        );
        actual = Math.round(Number(r.rows[0].v));
      } else if (m.metric === "dispatch_count") {
        // Cars placed = the manager's deals that ENTERED an "Авто працює" stage
        // that day (stage-entry events; distinct deals to avoid re-entries).
        const r = await pool.query<{ c: string }>(
          `SELECT COUNT(DISTINCT dse.kommo_id) c FROM deal_stage_events dse
             JOIN deals d ON d.kommo_id = dse.kommo_id
             WHERE d.manager_id = $1 AND dse.status_id IN (69716300, 98470988, 10937178)
               AND (dse.changed_at AT TIME ZONE 'Europe/Kyiv')::date = $2::date`,
          [t.assignee_id, t.plan_date]
        );
        actual = Number(r.rows[0].c);
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
  } catch (err) { console.error(`evaluateKpiTasks: composite task ${t.id} failed:`, err); }

  // 5) Динамічна декомпозиція «Суми»: залишок МІСЯЧНОГО плану виручки
  //    (plans.payment_amount) перерозподіляється на майбутні робочі дні місяця.
  //    Недовиконав сьогодні → завтрашні цілі payment_amount у майбутніх
  //    daily_kpi-задачах зростають; перевиконав → зменшуються (мін. 0).
  //    Минулі дні не чіпаємо — історія ✅/❌ лишається чесною.
  let retargeted = 0;
  try {
    const mgrs = await pool.query<{ assignee_id: number }>(
      `SELECT DISTINCT assignee_id FROM tasks
        WHERE auto AND task_type = 'daily_kpi' AND metrics_json IS NOT NULL
          AND assignee_id IS NOT NULL
          AND plan_date > (now() AT TIME ZONE 'Europe/Kyiv')::date
          AND date_trunc('month', plan_date) = date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date)
          AND metrics_json::text LIKE '%payment_amount%'`
    );
    // Майбутні робочі дні (Пн–Пт) від завтра до кінця місяця — Київ.
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    let futureWorkdays = 0;
    for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); d <= monthEnd; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0 && d.getDay() !== 6) futureWorkdays++;
    }
    for (const { assignee_id } of mgrs.rows) {
      try {
        const planR = await pool.query<{ v: string }>(
          `SELECT COALESCE(SUM(planned_value),0) v FROM plans
            WHERE manager_id = $1 AND metric = 'payment_amount'
              AND plan_date = date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date)::date`,
          [assignee_id]
        );
        const plan = Number(planR.rows[0]?.v ?? 0);
        if (!plan || !futureWorkdays) continue;
        // Факт = отримані кошти місяця (успішно 142 закрито в міс + оплата снапшот).
        const factR = await pool.query<{ v: string }>(
          `SELECT COALESCE(SUM(d.price) FILTER (WHERE d.status_id IN (69716460, 60412544)), 0)
                + COALESCE(SUM(d.price) FILTER (WHERE d.status_id = 142
                    AND (d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date)::date), 0) AS v
             FROM deals d
            WHERE d.manager_id = $1 AND d.pipeline_id IN (8921932, 155304)`,
          [assignee_id]
        );
        const fact = Number(factR.rows[0]?.v ?? 0);
        const perDay = Math.max(0, Math.round((plan - fact) / futureWorkdays));
        const future = await pool.query<{ id: number; metrics_json: { metric: string; target: number }[] }>(
          `SELECT id, metrics_json FROM tasks
            WHERE auto AND task_type = 'daily_kpi' AND assignee_id = $1 AND metrics_json IS NOT NULL
              AND plan_date > (now() AT TIME ZONE 'Europe/Kyiv')::date
              AND date_trunc('month', plan_date) = date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date)`,
          [assignee_id]
        );
        for (const t of future.rows) {
          if (!Array.isArray(t.metrics_json)) continue;
          const cur = t.metrics_json.find((m) => m.metric === "payment_amount");
          if (!cur || cur.target === perDay) continue;
          const next = t.metrics_json.map((m) => (m.metric === "payment_amount" ? { ...m, target: perDay } : m));
          await pool.query(`UPDATE tasks SET metrics_json = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(next), t.id]);
          retargeted++;
        }
      } catch (err) { console.error(`evaluateKpiTasks: retarget manager ${assignee_id} failed:`, err); }
    }
  } catch (err) { console.error("evaluateKpiTasks: retarget step failed:", err); }

  console.log(`KPI tasks evaluated: ${daily.rowCount} daily, ${parents.rowCount} ads, ${aggs.rowCount} aggregate, ${composite.rowCount} composite, ${retargeted} sum-retargeted.`);
}

if (process.argv[1]?.endsWith("evaluateKpiTasks.js")) {
  evaluateKpiTasks()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
