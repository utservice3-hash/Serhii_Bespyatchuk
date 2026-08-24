import { pool } from "../db/pool.js";
import { getSettings } from "../routes/settings.js";
import * as metrics from "../core/metrics.js";
import * as money from "../core/money.js";

/**
 * ЄДИНЕ ДЖЕРЕЛО ФАКТУ KPI — ТІ САМІ core-функції, що живлять Звіт. Задачник і Звіт
 * більше не розходяться (принцип власника). Визначення (рішення власника):
 *   ads_count      → metrics.adsAcceptedByMgr  (adDealSql: client_source∈adSources
 *                    АБО lead_channel='ad', без реактивації; created у періоді)
 *   leadgen_count  → metrics.createdSplitByManager (lead_channel='leadgen', FC-угоди,
 *                    створені у вікні) — ТЕ САМЕ, що показує Звіт
 *   dispatch_count → metrics.dispatchedByManager (АВТО за load_at — фактична відправка)
 *   avg_check      → money.avgCheckByManager   (success_rev ÷ success_deals, 2600–2900)
 *   payment_amount → money.receivedByMgr        (received = 142∪етап9 — «Отримано»)
 *   conversion     → metrics.conversionByManager (виграно ÷ узяті ліди ad+лідоген;
 *                    постійні без ліда не в знаменнику)
 * Всі scope-aware; для денного факту скоуп = {managerId, from:day, to:day}.
 */
async function factFor(metric: string, managerId: number, day: string, adSources: string[]): Promise<number> {
  const scope: metrics.MetricScope = { managerId, from: day, to: day };
  const pick = <T extends { managerId: number }>(rows: T[]): T | undefined => rows.find((r) => r.managerId === managerId);
  switch (metric) {
    case "ads_count": return pick(await metrics.adsAcceptedByMgr(scope, adSources))?.count ?? 0;
    // 🔀 ЗА КАНАЛОМ, А НЕ ЗА РЕЄСТРОМ (рішення власника 24.08.2026) — і саме ТУТ
    // це критично: факт задачі й факт Звіту задумані як ОДНЕ число, тож означення
    // мусять переїхати разом. Лишити тут реєстр означало б, що задача рахує одне,
    // а екран поруч — інше, і розбіжність нічим не ловилась би. Тримає `#142`.
    case "leadgen_count":
      return pick(await metrics.createdSplitByManager(scope))?.leadgenCount ?? 0;
    case "dispatch_count": return pick(await metrics.dispatchedByManager(scope))?.deals ?? 0;
    case "avg_check": return pick(await money.avgCheckByManager(scope))?.avgCheck ?? 0;
    case "payment_amount": return Math.round(pick(await money.receivedByMgr(scope))?.revenue ?? 0);
    case "conversion": {
      const c = pick(await metrics.conversionByManager(scope));
      return c && c.taken > 0 ? Math.round((c.won / c.taken) * 100) : 0;
    }
    default: return 0;
  }
}

/**
 * Заповнює факт auto-KPI задач із CRM (через core) і авто-закриває виконані.
 * Актуальні задачі — лише composite `daily_kpi` (metrics_json-бандл) + парасолька
 * `kpi_period` (rollup). Легасі weekly_kpi/monthly_kpi і single-metric daily_kpi
 * прибрано (у проді 0 таких рядків; /tasks/plan їх не пише).
 */
export async function evaluateKpiTasks(): Promise<void> {
  const { adSources } = await getSettings();

  // 1) Composite daily tasks (metrics_json bundle). Вікно: останні 14 днів включно
  //    з сьогодні (живий intraday-факт) + вже закриті (факт освіжається, статус не
  //    відкочується). Кожна метрика — з core (factFor); задача done коли ВСІ виконані.
  const composite = await pool.query<{ id: number; assignee_id: number; plan_date: string; metrics_json: { metric: string; target: number }[] }>(
    `SELECT id, assignee_id, to_char(plan_date, 'YYYY-MM-DD') AS plan_date, metrics_json FROM tasks
     WHERE auto AND task_type = 'daily_kpi' AND metrics_json IS NOT NULL AND assignee_id IS NOT NULL
       AND plan_date BETWEEN (now() AT TIME ZONE 'Europe/Kyiv')::date - 14 AND (now() AT TIME ZONE 'Europe/Kyiv')::date`
  );
  for (const t of composite.rows) try {
    if (!Array.isArray(t.metrics_json)) continue;
    const out: { metric: string; target: number; actual: number; done: boolean }[] = [];
    for (const m of t.metrics_json) {
      const actual = await factFor(m.metric, t.assignee_id, t.plan_date, adSources);
      out.push({ metric: m.metric, target: m.target, actual, done: actual >= m.target });
    }
    const allDone = out.length > 0 && out.every((x) => x.done);
    await pool.query(
      `UPDATE tasks SET metrics_json = $1, status = CASE WHEN $2 THEN 'done' ELSE status END, updated_at = now() WHERE id = $3`,
      [JSON.stringify(out), allDone, t.id]
    );
  } catch (err) { console.error(`evaluateKpiTasks: composite task ${t.id} failed:`, err); }

  // 2) Динамічна декомпозиція «Суми»: залишок МІСЯЧНОГО плану виручки
  //    (plans.payment_amount) − ФАКТ (money.receivedByMgr, те саме «Отримано», що Звіт)
  //    перерозподіляється на майбутні робочі дні місяця. Минулі дні не чіпаємо.
  let retargeted = 0;
  try {
    const kyivToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
    const monthStart = kyivToday.slice(0, 7) + "-01";
    const mgrs = await pool.query<{ assignee_id: number }>(
      `SELECT DISTINCT assignee_id FROM tasks
        WHERE auto AND task_type = 'daily_kpi' AND metrics_json IS NOT NULL AND assignee_id IS NOT NULL
          AND plan_date > (now() AT TIME ZONE 'Europe/Kyiv')::date
          AND date_trunc('month', plan_date) = date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv')::date)
          AND metrics_json::text LIKE '%payment_amount%'`
    );
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
            WHERE manager_id = $1 AND metric = 'payment_amount' AND plan_date = $2::date`,
          [assignee_id, monthStart]
        );
        const plan = Number(planR.rows[0]?.v ?? 0);
        if (!plan || !futureWorkdays) continue;
        // Факт = «Отримано» місяця з ЯДРА (money.receivedByMgr) — той самий герой, що Звіт.
        const recv = await money.receivedByMgr({ managerId: assignee_id, from: monthStart, to: kyivToday });
        const fact = recv.find((r) => r.managerId === assignee_id)?.revenue ?? 0;
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

  // 3) Rollup «парасольок» kpi_period: період done, коли ВСІ його дні done.
  await pool.query(
    `UPDATE tasks p SET status = 'done', updated_at = now()
      WHERE p.task_type = 'kpi_period' AND p.status <> 'done'
        AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id AND c.status <> 'done')`
  );

  console.log(`KPI tasks evaluated: ${composite.rowCount} composite (core-facts), ${retargeted} sum-retargeted.`);
}

if (process.argv[1]?.endsWith("evaluateKpiTasks.js")) {
  evaluateKpiTasks()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
