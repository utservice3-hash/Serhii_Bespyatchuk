import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { getSettings } from "./settings.js";
import { syncKommo } from "../jobs/syncKommo.js";
import { syncStageEvents } from "../jobs/syncStageEvents.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/**
 * Returns deal counts/amounts grouped by funnel stage (per pipeline_stage_map)
 * for a given manager or team, scoped by the caller's role.
 */
dashboardRouter.get("/funnel", async (req, res) => {
  const auth = req.auth!;
  const managerIdParam = req.query.managerId ? Number(req.query.managerId) : null;
  const teamIdParam = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  let managerId = managerIdParam;
  let teamId = teamIdParam;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT psm.funnel_stage, COUNT(*) AS deal_count, COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
     GROUP BY psm.funnel_stage`,
    params
  );

  res.json({ stages: result.rows });
});

/**
 * Lead-generation performance per lead generator. Their working pipelines are
 * Продзвін (8921936 / 7337048) and Реактивація (8921948): each deal there is a
 * lead they handled. "Reached payment" means that client later has a paid deal
 * in the sales funnel (matched by client_key). Broken down by client source
 * (Холодна база, Реактивація, Google, …) and optionally date-scoped.
 */
const LEADGEN_PIPELINES = [8921936, 7337048, 8921948];

dashboardRouter.get("/leadgen", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  const conditions: string[] = [`d.pipeline_id = ANY($1)`];
  const params: unknown[] = [LEADGEN_PIPELINES];
  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const result = await pool.query<{
    manager_id: number;
    manager_name: string;
    team_name: string;
    client_source: string;
    leads: string;
    reached_paid: string;
  }>(
    `WITH paid_clients AS (
       SELECT DISTINCT d.client_key
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     )
     SELECT d.manager_id,
            m.name AS manager_name,
            COALESCE(t.name, 'Без команди') AS team_name,
            COALESCE(NULLIF(d.client_source, ''), 'Не вказано') AS client_source,
            COUNT(*) AS leads,
            COUNT(*) FILTER (WHERE d.client_key IN (SELECT client_key FROM paid_clients)) AS reached_paid
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     LEFT JOIN teams t ON t.id = m.team_id
     ${where}
     GROUP BY d.manager_id, m.name, t.name, COALESCE(NULLIF(d.client_source, ''), 'Не вказано')`,
    params
  );

  const byManager = new Map<
    number,
    {
      managerId: number;
      managerName: string;
      teamName: string;
      leads: number;
      reachedPaid: number;
      bySource: { source: string; leads: number; reachedPaid: number; conversion: number }[];
    }
  >();

  for (const row of result.rows) {
    const leads = Number(row.leads);
    const reached = Number(row.reached_paid);
    let entry = byManager.get(row.manager_id);
    if (!entry) {
      entry = {
        managerId: row.manager_id,
        managerName: row.manager_name,
        teamName: row.team_name,
        leads: 0,
        reachedPaid: 0,
        bySource: [],
      };
      byManager.set(row.manager_id, entry);
    }
    entry.leads += leads;
    entry.reachedPaid += reached;
    entry.bySource.push({
      source: row.client_source,
      leads,
      reachedPaid: reached,
      conversion: leads > 0 ? Math.round((reached / leads) * 100) : 0,
    });
  }

  const allGenerators = Array.from(byManager.values())
    .map((g) => ({
      ...g,
      conversion: g.leads > 0 ? Math.round((g.reachedPaid / g.leads) * 100) : 0,
      bySource: g.bySource.sort((a, b) => b.leads - a.leads),
    }))
    .sort((a, b) => b.leads - a.leads);

  // Group by team so lead-gen teams are clearly separated from the commercial
  // department people who merely touched a Продзвін/Реактивація deal.
  const teamsMap = new Map<string, typeof allGenerators>();
  for (const g of allGenerators) {
    if (!teamsMap.has(g.teamName)) teamsMap.set(g.teamName, []);
    teamsMap.get(g.teamName)!.push(g);
  }
  const isLeadgenTeam = (name: string) => /лідоген|лидоген/i.test(name);
  const groups = Array.from(teamsMap.entries())
    .map(([teamName, gens]) => ({
      teamName,
      isLeadgen: isLeadgenTeam(teamName),
      leads: gens.reduce((s, g) => s + g.leads, 0),
      reachedPaid: gens.reduce((s, g) => s + g.reachedPaid, 0),
      generators: gens,
    }))
    .sort((a, b) => Number(b.isLeadgen) - Number(a.isLeadgen) || b.leads - a.leads);

  res.json({ generators: allGenerators, groups });
});

/**
 * Executive summary for the head of sales: revenue by team, the top managers
 * by paid revenue, total outstanding receivables and a new-vs-repeat client
 * split — everything scoped by role/team and the selected date range.
 */
dashboardRouter.get("/overview", async (req, res) => {
  const auth = req.auth!;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  if (auth.role === "team_lead") teamId = auth.teamId;
  const managerId = auth.role === "manager" ? auth.managerId : null;

  const paidConds = ["psm.funnel_stage = 'paid'"];
  const params: unknown[] = [];
  if (managerId) {
    params.push(managerId);
    paidConds.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    paidConds.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    paidConds.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    paidConds.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }
  const paidWhere = `WHERE ${paidConds.join(" AND ")}`;

  // Money filter: paid deals by CLOSE date (revenue is recognised when the deal
  // is won, not when the lead was created).
  const closedConds = ["psm.funnel_stage = 'paid'", "d.closed_at_kommo IS NOT NULL"];
  const closedParams: unknown[] = [];
  if (managerId) {
    closedParams.push(managerId);
    closedConds.push(`d.manager_id = $${closedParams.length}`);
  }
  if (teamId) {
    closedParams.push(teamId);
    closedConds.push(`m.team_id = $${closedParams.length}`);
  }
  if (from) {
    closedParams.push(from);
    closedConds.push(`(d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${closedParams.length}`);
  }
  if (to) {
    closedParams.push(to);
    closedConds.push(`(d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${closedParams.length}`);
  }
  const closedWhere = `WHERE ${closedConds.join(" AND ")}`;

  // "Угоди" = deals that reached the money part of the funnel — from
  // "Виставлено рахунок" (invoiced) through "Успішно реалізовано" (paid) —
  // created within the period.
  const dealConds = paidConds.map((c) =>
    c.includes("funnel_stage") ? "psm.funnel_stage IN ('invoiced','paid')" : c
  );
  const createdLeadsResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${dealConds.join(" AND ")}`,
    params
  );

  // Conversion by acquisition channel (by created date): paid (= dispatched
  // autos) over total leads in the channel. "ad" counts only deals carrying a
  // Google utm tag; "leadgen" = leads worked by the lead-gen department.
  const scopeConds = paidConds.filter((c) => !c.includes("funnel_stage"));
  const scopeWhere = scopeConds.length ? `WHERE ${scopeConds.join(" AND ")}` : "";
  const channelConvRes = await pool.query<{ lead_channel: string; leads: string; paid: string }>(
    `SELECT COALESCE(d.lead_channel, 'other') AS lead_channel,
            COUNT(*) AS leads,
            COUNT(*) FILTER (WHERE psm.funnel_stage = 'paid') AS paid
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${scopeWhere}
     GROUP BY 1`,
    params
  );
  const channelConv = (ch: string) => {
    const r = channelConvRes.rows.find((x) => x.lead_channel === ch);
    const leads = Number(r?.leads ?? 0);
    const paid = Number(r?.paid ?? 0);
    return { leads, paid, conversion: leads > 0 ? Math.round((paid / leads) * 100) : 0 };
  };

  // Received money everywhere = Успішно реалізовано (status 142, by CLOSE date
  // in period) + Оплата отримана (snapshot of the transient stage, no date).
  // The same split shown in the "Отримані кошти" card, applied consistently to
  // team / manager breakdowns and to the monthly fact.
  const PAYMENT_RECEIVED_STATUSES = [69716460, 60412544];
  const paySnapConds: string[] = ["d.status_id = ANY($1)"];
  const paySnapParams: unknown[] = [PAYMENT_RECEIVED_STATUSES];
  if (managerId) { paySnapParams.push(managerId); paySnapConds.push(`d.manager_id = $${paySnapParams.length}`); }
  if (teamId) { paySnapParams.push(teamId); paySnapConds.push(`m.team_id = $${paySnapParams.length}`); }
  const paySnapWhere = `WHERE ${paySnapConds.join(" AND ")}`;

  // Success part (close date), by team / manager.
  const successByTeam = await pool.query<{ team_id: number; team_name: string; revenue: string; deals: string }>(
    `SELECT t.id AS team_id, t.name AS team_name, COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${closedWhere} AND d.status_id = 142
     GROUP BY t.id, t.name`,
    closedParams
  );
  const paymentByTeam = await pool.query<{ team_id: number; team_name: string; revenue: string; deals: string }>(
    `SELECT t.id AS team_id, t.name AS team_name, COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     ${paySnapWhere}
     GROUP BY t.id, t.name`,
    paySnapParams
  );
  const successByMgr = await pool.query<{ manager_id: number; name: string; revenue: string; deals: string }>(
    `SELECT m.id AS manager_id, m.name, COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${closedWhere} AND d.status_id = 142
     GROUP BY m.id, m.name`,
    closedParams
  );
  const paymentByMgr = await pool.query<{ manager_id: number; name: string; revenue: string; deals: string }>(
    `SELECT m.id AS manager_id, m.name, COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     ${paySnapWhere}
     GROUP BY m.id, m.name`,
    paySnapParams
  );

  // Merge success + payment snapshot per key.
  type MoneyRow = { revenue: string; deals: string; team_id?: number; team_name?: string; manager_id?: number; name?: string };
  const mergeRows = (
    rows: MoneyRow[],
    keyOf: (r: MoneyRow) => number,
    nameOf: (r: MoneyRow) => string
  ) => {
    const map = new Map<number, { id: number; name: string; revenue: number; deals: number }>();
    for (const r of rows) {
      const id = keyOf(r);
      const cur = map.get(id) ?? { id, name: nameOf(r), revenue: 0, deals: 0 };
      cur.revenue += Number(r.revenue);
      cur.deals += Number(r.deals);
      map.set(id, cur);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  };
  const byTeam = {
    rows: mergeRows(
      [...successByTeam.rows, ...paymentByTeam.rows],
      (r) => r.team_id!,
      (r) => r.team_name!
    ).map((x) => ({ team_id: x.id, team_name: x.name, revenue: String(x.revenue), deals: String(x.deals) })),
  };
  const topManagers = {
    rows: mergeRows(
      [...successByMgr.rows, ...paymentByMgr.rows],
      (r) => r.manager_id!,
      (r) => r.name!
    )
      .slice(0, 10)
      .map((x) => ({ manager_id: x.id, name: x.name, revenue: String(x.revenue), deals: String(x.deals) })),
  };

  // New vs repeat: a client whose first-ever paid deal falls in the period is
  // "new"; one who paid before the period is "repeat".
  // With a date range, "new" = first-ever paid falls in the period. Without
  // one (all-time view), "new" = one-time buyer, "repeat" = bought 2+ times.
  const newRepeat = await pool.query<{ bucket: string; clients: string; revenue: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key
     )
     SELECT CASE
              WHEN $${params.length + 1}::date IS NOT NULL THEN
                CASE WHEN f.first_paid >= $${params.length + 1}::date THEN 'new' ELSE 'repeat' END
              ELSE CASE WHEN f.cnt = 1 THEN 'new' ELSE 'repeat' END
            END AS bucket,
            COUNT(DISTINCT d.client_key) AS clients,
            COALESCE(SUM(d.price), 0) AS revenue
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     ${paidWhere}
     GROUP BY 1`,
    [...params, from]
  );

  const recvConds: string[] = ["r.manager_id IS NOT NULL"];
  const recvParams: unknown[] = [];
  if (managerId) {
    recvParams.push(managerId);
    recvConds.push(`r.manager_id = $${recvParams.length}`);
  }
  if (teamId) {
    recvParams.push(teamId);
    recvConds.push(`m.team_id = $${recvParams.length}`);
  }
  const receivables = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
     FROM receivables r JOIN managers m ON m.id = r.manager_id
     WHERE ${recvConds.join(" AND ")}`,
    recvParams
  );

  // Plan (monthly payment_amount targets) prorated to the SELECTED period by
  // day-overlap, so the gauge responds to week/month/quarter just like the
  // other stats. Fact = received money for the period (computed below as
  // successRevenue + paymentRevenue, i.e. the same as "Отримані кошти").
  const monthAnchor = to ?? new Date().toISOString().slice(0, 10);
  const planScope: string[] = [];
  const planParams: unknown[] = [];
  if (managerId) { planParams.push(managerId); planScope.push(`p.manager_id = $${planParams.length}`); }
  if (teamId) { planParams.push(teamId); planScope.push(`mp.team_id = $${planParams.length}`); }
  const planMonthsRes = await pool.query<{ mon: string; plan: string }>(
    `SELECT to_char(date_trunc('month', p.plan_date), 'YYYY-MM-DD') AS mon,
            COALESCE(SUM(p.planned_value), 0) AS plan
     FROM plans p JOIN managers mp ON mp.id = p.manager_id
     WHERE p.metric = 'payment_amount'
       ${planScope.length ? "AND " + planScope.join(" AND ") : ""}
     GROUP BY 1`,
    planParams
  );
  // Prorate each month's plan by how many of its days fall inside [from, to].
  const periodFrom = from ? new Date(from + "T00:00:00") : null;
  const periodTo = to ? new Date(to + "T00:00:00") : null;
  const anchorMonth = (to ?? monthAnchor).slice(0, 7);
  let planTotal = 0;
  for (const row of planMonthsRes.rows) {
    const mStart = new Date(row.mon + "T00:00:00");
    const daysInMonth = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0).getDate();
    const planVal = Number(row.plan);
    if (!periodFrom || !periodTo) {
      // No date range (alltime): count only the current anchor month's plan.
      if (row.mon.slice(0, 7) === anchorMonth) planTotal += planVal;
      continue;
    }
    const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
    const ovStart = mStart > periodFrom ? mStart : periodFrom;
    const ovEnd = mEnd < periodTo ? mEnd : periodTo;
    const overlapDays = Math.max(0, Math.round((ovEnd.getTime() - ovStart.getTime()) / 86400000) + 1);
    planTotal += planVal * (overlapDays / daysInMonth);
  }
  planTotal = Math.round(planTotal);

  // Received money has two parts, shown combined with a drill-down split:
  //  1) "Успішно реалізовано" (status 142) — counted by CLOSE date in period.
  //  2) "Оплата отримана" (statuses 69716460 new / 60412544 old) — a SNAPSHOT
  //     of deals currently sitting in that stage (no date filter, per CRM
  //     methodology), scoped only by manager/team.
  const successRes = await pool.query<{ revenue: string; deals: string }>(
    `SELECT COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${closedWhere} AND d.status_id = 142`,
    closedParams
  );

  // Оплата отримана snapshot total (reuses the team/manager scope above).
  const paymentRes = await pool.query<{ revenue: string; deals: string }>(
    `SELECT COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id
     ${paySnapWhere}`,
    paySnapParams
  );

  const successRevenue = Number(successRes.rows[0]?.revenue ?? 0);
  const successDeals = Number(successRes.rows[0]?.deals ?? 0);
  const paymentRevenue = Number(paymentRes.rows[0]?.revenue ?? 0);
  const paymentDeals = Number(paymentRes.rows[0]?.deals ?? 0);
  const closedRes = {
    rows: [{ revenue: String(successRevenue + paymentRevenue), deals: String(successDeals + paymentDeals) }],
  };

  // Deals currently awaiting payment (stage "invoiced" = Виставлено рахунок /
  // Очікуємо оплату) — a snapshot of the pipeline, grouped by team.
  const pendScope: string[] = ["psm.funnel_stage = 'invoiced'"];
  const pendParams: unknown[] = [];
  if (managerId) { pendParams.push(managerId); pendScope.push(`d.manager_id = $${pendParams.length}`); }
  if (teamId) { pendParams.push(teamId); pendScope.push(`m.team_id = $${pendParams.length}`); }
  const pendingRes = await pool.query<{ team_id: number; team_name: string; deals: string; revenue: string }>(
    `SELECT t.id AS team_id, t.name AS team_name, COUNT(*) AS deals, COALESCE(SUM(d.price), 0) AS revenue
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN teams t ON t.id = m.team_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${pendScope.join(" AND ")}
     GROUP BY t.id, t.name ORDER BY revenue DESC`,
    pendParams
  );

  // All deals created in the Full-cycle funnel within the period (by create date).
  const FULL_CYCLE_PIPELINES = [8921932, 155304];
  const cfScope: string[] = ["d.pipeline_id = ANY($1)"];
  const cfParams: unknown[] = [FULL_CYCLE_PIPELINES];
  if (managerId) { cfParams.push(managerId); cfScope.push(`d.manager_id = $${cfParams.length}`); }
  if (teamId) { cfParams.push(teamId); cfScope.push(`m.team_id = $${cfParams.length}`); }
  if (from) { cfParams.push(from); cfScope.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${cfParams.length}`); }
  if (to) { cfParams.push(to); cfScope.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${cfParams.length}`); }
  const createdFullRes = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM deals d JOIN managers m ON m.id = d.manager_id
     WHERE ${cfScope.join(" AND ")}`,
    cfParams
  );

  // Carried-over deals: the fixed start-of-month snapshot for the viewed month.
  const carryMonth = (from ? from.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const carryoverRes = await pool.query<{ amount: string; deals: string }>(
    `SELECT amount, deals FROM monthly_carryover WHERE month = $1`,
    [carryMonth]
  );
  const carryover = carryoverRes.rows[0]
    ? { amount: Number(carryoverRes.rows[0].amount), deals: Number(carryoverRes.rows[0].deals) }
    : null;

  const newRow = newRepeat.rows.find((r) => r.bucket === "new");
  const repeatRow = newRepeat.rows.find((r) => r.bucket === "repeat");

  // Last 3 complete months (deals / paid / revenue) for the drill-down trend.
  const histScope: string[] = [];
  if (managerId) histScope.push(`d.manager_id = ${Number(managerId)}`);
  if (teamId) histScope.push(`m.team_id = ${Number(teamId)}`);
  const histWhere = histScope.length ? "AND " + histScope.join(" AND ") : "";
  const histRes = await pool.query<{
    month: string;
    deals: string;
    paid: string;
    revenue: string;
    ad_leads: string;
    ad_paid: string;
    lg_leads: string;
    lg_paid: string;
    new_clients: string;
    repeat_clients: string;
  }>(
    `WITH firsts AS (
       SELECT d2.client_key, MIN(d2.created_at_kommo) AS first_paid
       FROM deals d2
       JOIN pipeline_stage_map p2 ON p2.pipeline_id = d2.pipeline_id AND p2.status_id = d2.status_id
       WHERE p2.funnel_stage = 'paid' AND d2.client_key IS NOT NULL
       GROUP BY d2.client_key
     )
     SELECT to_char(date_trunc('month', d.created_at_kommo), 'YYYY-MM') AS month,
            COUNT(*) FILTER (WHERE psm.funnel_stage IN ('invoiced','paid')) AS deals,
            COUNT(*) FILTER (WHERE psm.funnel_stage = 'paid') AS paid,
            COALESCE(SUM(d.price) FILTER (WHERE psm.funnel_stage = 'paid'), 0) AS revenue,
            COUNT(*) FILTER (WHERE d.lead_channel = 'ad') AS ad_leads,
            COUNT(*) FILTER (WHERE d.lead_channel = 'ad' AND psm.funnel_stage = 'paid') AS ad_paid,
            COUNT(*) FILTER (WHERE d.lead_channel = 'leadgen') AS lg_leads,
            COUNT(*) FILTER (WHERE d.lead_channel = 'leadgen' AND psm.funnel_stage = 'paid') AS lg_paid,
            COUNT(DISTINCT d.client_key) FILTER (
              WHERE psm.funnel_stage = 'paid'
                AND date_trunc('month', f.first_paid) = date_trunc('month', d.created_at_kommo)) AS new_clients,
            COUNT(DISTINCT d.client_key) FILTER (
              WHERE psm.funnel_stage = 'paid'
                AND date_trunc('month', f.first_paid) < date_trunc('month', d.created_at_kommo)) AS repeat_clients
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     LEFT JOIN firsts f ON f.client_key = d.client_key
     WHERE d.created_at_kommo >= date_trunc('month', $1::date) - interval '2 months'
       AND d.created_at_kommo < date_trunc('month', $1::date) + interval '1 month'
       ${histWhere}
     GROUP BY 1 ORDER BY 1`,
    [monthAnchor]
  );
  const monthlyHistory = histRes.rows.map((r) => {
    const deals = Number(r.deals);
    const paid = Number(r.paid);
    const revenue = Number(r.revenue);
    const adLeads = Number(r.ad_leads);
    const lgLeads = Number(r.lg_leads);
    return {
      month: r.month,
      deals,
      paid,
      revenue,
      conversion: deals > 0 ? Math.round((paid / deals) * 100) : 0,
      avgCheck: paid > 0 ? Math.round(revenue / paid) : 0,
      adConversion: adLeads > 0 ? Math.round((Number(r.ad_paid) / adLeads) * 100) : 0,
      leadgenConversion: lgLeads > 0 ? Math.round((Number(r.lg_paid) / lgLeads) * 100) : 0,
      newClients: Number(r.new_clients),
      repeatClients: Number(r.repeat_clients),
    };
  });

  res.json({
    plan: planTotal,
    fact: successRevenue + paymentRevenue,
    planPct: planTotal > 0 ? Math.round(((successRevenue + paymentRevenue) / planTotal) * 100) : 0,
    closedRevenue: Number(closedRes.rows[0]?.revenue ?? 0),
    closedDeals: Number(closedRes.rows[0]?.deals ?? 0),
    successRevenue,
    successDeals,
    paymentRevenue,
    paymentDeals,
    pendingPayments: {
      deals: pendingRes.rows.reduce((s, r) => s + Number(r.deals), 0),
      revenue: pendingRes.rows.reduce((s, r) => s + Number(r.revenue), 0),
      byTeam: pendingRes.rows.map((r) => ({
        teamId: r.team_id,
        teamName: r.team_name,
        deals: Number(r.deals),
        revenue: Number(r.revenue),
      })),
    },
    createdFullCycle: Number(createdFullRes.rows[0]?.c ?? 0),
    carryover,
    adConversion: channelConv("ad"),
    leadgenConversion: channelConv("leadgen"),
    monthlyHistory,
    byTeam: byTeam.rows.map((r) => ({
      teamId: r.team_id,
      teamName: r.team_name,
      revenue: Number(r.revenue),
      deals: Number(r.deals),
    })),
    topManagers: topManagers.rows.map((r) => ({
      managerId: r.manager_id,
      name: r.name,
      revenue: Number(r.revenue),
      deals: Number(r.deals),
    })),
    receivablesTotal: Number(receivables.rows[0]?.total ?? 0),
    createdLeads: Number(createdLeadsResult.rows[0]?.count ?? 0),
    newClients: Number(newRow?.clients ?? 0),
    newRevenue: Number(newRow?.revenue ?? 0),
    repeatClients: Number(repeatRow?.clients ?? 0),
    repeatRevenue: Number(repeatRow?.revenue ?? 0),
  });
});

/**
 * Conversion split by lead channel — paid ads/targeting vs. the lead-gen
 * department vs. other — so each acquisition source can be tracked
 * separately. Scoped by role/team and optional date range like /funnel.
 */
dashboardRouter.get("/conversion", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query<{
    lead_channel: string | null;
    leads: string;
    paid: string;
    paid_amount: string;
  }>(
    `SELECT COALESCE(d.lead_channel, 'other') AS lead_channel,
            COUNT(*) AS leads,
            COUNT(*) FILTER (WHERE psm.funnel_stage = 'paid') AS paid,
            COALESCE(SUM(d.price) FILTER (WHERE psm.funnel_stage = 'paid'), 0) AS paid_amount
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm
       ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
     GROUP BY COALESCE(d.lead_channel, 'other')`,
    params
  );

  const labels: Record<string, string> = {
    ad: "Таргет / реклама",
    leadgen: "Лідогенерація",
    other: "Інше",
  };

  const channels = ["ad", "leadgen", "other"].map((ch) => {
    const row = result.rows.find((r) => r.lead_channel === ch);
    const leads = Number(row?.leads ?? 0);
    const paid = Number(row?.paid ?? 0);
    return {
      channel: ch,
      label: labels[ch],
      leads,
      paid,
      paidAmount: Number(row?.paid_amount ?? 0),
      conversion: leads > 0 ? Math.round((paid / leads) * 100) : 0,
    };
  });

  res.json({ channels });
});

/**
 * Returns deal counts/amounts per funnel stage, bucketed by day or month,
 * for trend charts (used by the company-wide / head-of-sales overview).
 */
dashboardRouter.get("/timeseries", async (req, res) => {
  const auth = req.auth!;
  const granularity =
    req.query.granularity === "month"
      ? "month"
      : req.query.granularity === "week"
        ? "week"
        : "day";
  const managerIdParam = req.query.managerId ? Number(req.query.managerId) : null;
  const teamIdParam = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  let managerId = managerIdParam;
  let teamId = teamIdParam;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }
  // admin (e.g. head of sales / КВП): no forced scoping, sees everything
  // unless managerId/teamId is explicitly passed as a query param.

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT date_trunc('${granularity}', d.created_at_kommo) AS period,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
     GROUP BY period, psm.funnel_stage
     ORDER BY period`,
    params
  );

  res.json({ points: result.rows });
});

const METRICS = ["lead_taken", "quote_requested", "approved", "invoiced", "paid", "payment_amount"] as const;

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function elapsedDaysInMonth(month: string, today = new Date()): number {
  const total = daysInMonth(month);
  const todayMonth = today.toISOString().slice(0, 7);
  if (month < todayMonth) return total;
  if (month > todayMonth) return 0;
  return today.getDate();
}

type Forecast = {
  plan: number;
  fact: number;
  remaining: number;
  projected: number;
  projectedPct: number;
  status: "no_plan" | "on_track" | "at_risk" | "behind";
};

function buildForecast(plan: number, fact: number, month: string): Forecast {
  if (plan <= 0) {
    return { plan, fact, remaining: 0, projected: fact, projectedPct: 0, status: "no_plan" };
  }
  const total = daysInMonth(month);
  const elapsed = elapsedDaysInMonth(month);
  const projected = elapsed > 0 ? (fact / elapsed) * total : fact;
  const projectedPct = projected / plan;
  const status: Forecast["status"] =
    projectedPct >= 0.97 ? "on_track" : projectedPct >= 0.85 ? "at_risk" : "behind";
  return { plan, fact, remaining: Math.max(plan - fact, 0), projected, projectedPct, status };
}

/**
 * Per-manager plan-vs-fact breakdown for a team, bucketed by week, for a
 * given month. Fact comes from synced Kommo deals; plan comes from the
 * manually-entered `plans` table (targets are a management decision, not
 * CRM data, so that part stays manual).
 */
dashboardRouter.get("/managers", async (req, res) => {
  const auth = req.auth!;
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;

  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") {
    return res.status(403).json({ error: "Forbidden" });
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }
  if (!teamId) {
    return res.status(400).json({ error: "teamId is required" });
  }

  const managersResult = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM managers WHERE team_id = $1 AND is_active = true ORDER BY name`,
    [teamId]
  );
  const managers = managersResult.rows;
  if (managers.length === 0) {
    return res.json({ managers: [] });
  }
  const managerIds = managers.map((m) => m.id);

  const factResult = await pool.query<{
    manager_id: number;
    week_start: string;
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT d.manager_id,
            date_trunc('week', d.created_at_kommo) AS week_start,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = ANY($1)
       AND d.created_at_kommo >= $2::date
       AND d.created_at_kommo < ($2::date + interval '1 month')
     GROUP BY d.manager_id, week_start, psm.funnel_stage`,
    [managerIds, monthStart]
  );

  const planResult = await pool.query<{
    manager_id: number;
    week_start: string;
    metric: string;
    planned_value: string;
  }>(
    `SELECT manager_id,
            date_trunc('week', plan_date) AS week_start,
            metric,
            SUM(planned_value) AS planned_value
     FROM plans
     WHERE manager_id = ANY($1)
       AND plan_date >= $2::date
       AND plan_date < ($2::date + interval '1 month')
     GROUP BY manager_id, week_start, metric`,
    [managerIds, monthStart]
  );

  type WeekRow = { weekStart: string; metric: string; plan: number; fact: number };
  const rowsByManager = new Map<number, WeekRow[]>();

  function getOrInit(managerId: number, weekStart: string, metric: string): WeekRow {
    const rows = rowsByManager.get(managerId) ?? [];
    rowsByManager.set(managerId, rows);
    let row = rows.find((r) => r.weekStart === weekStart && r.metric === metric);
    if (!row) {
      row = { weekStart, metric, plan: 0, fact: 0 };
      rows.push(row);
    }
    return row;
  }

  for (const r of factResult.rows) {
    if (METRICS.includes(r.funnel_stage as (typeof METRICS)[number])) {
      const row = getOrInit(r.manager_id, r.week_start, r.funnel_stage);
      row.fact = Number(r.deal_count);
    }
    const amountRow = getOrInit(r.manager_id, r.week_start, "payment_amount");
    if (r.funnel_stage === "paid") {
      amountRow.fact += Number(r.total_amount);
    }
  }
  for (const r of planResult.rows) {
    const row = getOrInit(r.manager_id, r.week_start, r.metric);
    row.plan = Number(r.planned_value);
  }

  const managersOut = managers.map((m) => {
    const weeks = rowsByManager.get(m.id) ?? [];
    const totals: Record<string, { plan: number; fact: number }> = {};
    for (const metric of METRICS) {
      const matching = weeks.filter((w) => w.metric === metric);
      totals[metric] = {
        plan: matching.reduce((sum, w) => sum + w.plan, 0),
        fact: matching.reduce((sum, w) => sum + w.fact, 0),
      };
    }
    const forecast = buildForecast(
      totals.payment_amount.plan,
      totals.payment_amount.fact,
      month
    );
    return { id: m.id, name: m.name, weeks, totals, forecast };
  });

  res.json({ managers: managersOut });
});

/**
 * Personal "CRM mirror" view for a single manager: month totals + pace
 * forecast, daily breakdown for the selected month, and a 12-month history
 * trend. All fact data comes from synced Kommo deals; only plan targets are
 * manual.
 */
dashboardRouter.get("/personal", async (req, res) => {
  const auth = req.auth!;
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;

  let managerId: number | null;
  if (auth.role === "manager") {
    managerId = auth.managerId;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    if (!managerId) return res.status(400).json({ error: "managerId is required" });
  }
  if (!managerId) return res.status(400).json({ error: "managerId is required" });

  const managerResult = await pool.query<{ id: number; name: string; team_id: number | null }>(
    `SELECT id, name, team_id FROM managers WHERE id = $1`,
    [managerId]
  );
  const manager = managerResult.rows[0];
  if (!manager) return res.status(404).json({ error: "Manager not found" });
  if (auth.role === "team_lead" && manager.team_id !== auth.teamId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const factResult = await pool.query<{
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT psm.funnel_stage, COUNT(*) AS deal_count, COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND d.created_at_kommo >= $2::date
       AND d.created_at_kommo < ($2::date + interval '1 month')
     GROUP BY psm.funnel_stage`,
    [managerId, monthStart]
  );

  const planResult = await pool.query<{ metric: string; planned_value: string }>(
    `SELECT metric, SUM(planned_value) AS planned_value
     FROM plans
     WHERE manager_id = $1
       AND plan_date >= $2::date
       AND plan_date < ($2::date + interval '1 month')
     GROUP BY metric`,
    [managerId, monthStart]
  );

  const totals: Record<string, { plan: number; fact: number }> = {};
  for (const metric of METRICS) totals[metric] = { plan: 0, fact: 0 };
  for (const r of factResult.rows) {
    if (METRICS.includes(r.funnel_stage as (typeof METRICS)[number])) {
      totals[r.funnel_stage].fact = Number(r.deal_count);
    }
    if (r.funnel_stage === "paid") {
      totals.payment_amount.fact += Number(r.total_amount);
    }
  }
  for (const r of planResult.rows) {
    if (totals[r.metric]) totals[r.metric].plan = Number(r.planned_value);
  }

  const dailyResult = await pool.query<{
    day: string;
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT date_trunc('day', d.created_at_kommo) AS day,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND d.created_at_kommo >= $2::date
       AND d.created_at_kommo < ($2::date + interval '1 month')
     GROUP BY day, psm.funnel_stage
     ORDER BY day`,
    [managerId, monthStart]
  );

  const dailyByDate = new Map<string, Record<string, number>>();
  for (const r of dailyResult.rows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    const row = dailyByDate.get(key) ?? {};
    row[r.funnel_stage] = Number(r.deal_count);
    if (r.funnel_stage === "paid") row.payment_amount = Number(r.total_amount);
    dailyByDate.set(key, row);
  }
  const daily = Array.from(dailyByDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, row]) => ({ ...row, date }));

  const historyFactResult = await pool.query<{
    month: string;
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT date_trunc('month', d.created_at_kommo) AS month,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND d.created_at_kommo >= $2::date - interval '11 months'
       AND d.created_at_kommo < ($2::date + interval '1 month')
     GROUP BY month, psm.funnel_stage`,
    [managerId, monthStart]
  );

  const historyPlanResult = await pool.query<{ month: string; metric: string; planned_value: string }>(
    `SELECT date_trunc('month', plan_date) AS month, metric, SUM(planned_value) AS planned_value
     FROM plans
     WHERE manager_id = $1
       AND plan_date >= $2::date - interval '11 months'
       AND plan_date < ($2::date + interval '1 month')
     GROUP BY month, metric`,
    [managerId, monthStart]
  );

  const historyByMonth = new Map<string, { factPaymentAmount: number; factPaid: number; planPaymentAmount: number }>();
  function getHistoryRow(monthKey: string) {
    let row = historyByMonth.get(monthKey);
    if (!row) {
      row = { factPaymentAmount: 0, factPaid: 0, planPaymentAmount: 0 };
      historyByMonth.set(monthKey, row);
    }
    return row;
  }
  for (const r of historyFactResult.rows) {
    const monthKey = new Date(r.month).toISOString().slice(0, 7);
    if (r.funnel_stage === "paid") {
      const row = getHistoryRow(monthKey);
      row.factPaid = Number(r.deal_count);
      row.factPaymentAmount = Number(r.total_amount);
    }
  }
  for (const r of historyPlanResult.rows) {
    if (r.metric === "payment_amount") {
      const monthKey = new Date(r.month).toISOString().slice(0, 7);
      getHistoryRow(monthKey).planPaymentAmount = Number(r.planned_value);
    }
  }
  const history = Array.from(historyByMonth.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([monthKey, row]) => ({ month: monthKey, ...row }));

  const forecast = buildForecast(totals.payment_amount.plan, totals.payment_amount.fact, month);

  res.json({
    manager: { id: manager.id, name: manager.name },
    month,
    daysInMonth: daysInMonth(month),
    daysElapsed: elapsedDaysInMonth(month),
    totals,
    forecast,
    daily,
    history,
  });
});

/**
 * Loyal-client KPI per manager: a client is "loyal" if they have 3+ paid
 * orders in the trailing 3-month window, and "at_risk" if they were loyal
 * in the prior 3-month window but have dropped below that threshold now.
 * Clients are identified by normalized `client_key` (legal-entity prefixes
 * like ТОВ/ФОП stripped) so e.g. "Смартекс" and "ТОВ Смартекс" count as
 * the same client.
 */
dashboardRouter.get("/loyalty", async (req, res) => {
  const auth = req.auth!;
  const asOf = (req.query.asOf as string) ?? new Date().toISOString().slice(0, 10);

  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  const conditions: string[] = ["d.client_key IS NOT NULL"];
  const params: unknown[] = [asOf];

  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // Loyalty rules are admin-configurable; the window values are clamped ints.
  const settings = await getSettings();
  const recentMonths = settings.loyaltyWindowMonths;
  const sleepingMonths = settings.sleepingWindowMonths;
  const threshold = settings.loyaltyThreshold;

  // Aggregate every client's paid-order history (per manager) into time
  // windows so we can both flag regulars and segment everyone else for
  // reactivation work.
  const result = await pool.query<{
    manager_id: number;
    manager_name: string;
    client_key: string;
    client_name: string;
    p_recent: string; // paid in last 2 months
    p_prior: string; // paid in prior 2–6 months
    total_paid: string; // all-time paid orders
    last_paid: string;
  }>(
    `SELECT d.manager_id,
            m.name AS manager_name,
            d.client_key,
            (array_agg(d.client_name ORDER BY d.created_at_kommo DESC))[1] AS client_name,
            COUNT(*) FILTER (
              WHERE d.created_at_kommo >= $1::date - interval '${recentMonths} months'
                AND d.created_at_kommo < $1::date
            ) AS p_recent,
            COUNT(*) FILTER (
              WHERE d.created_at_kommo >= $1::date - interval '${sleepingMonths} months'
                AND d.created_at_kommo < $1::date - interval '${recentMonths} months'
            ) AS p_prior,
            COUNT(*) AS total_paid,
            MAX(d.created_at_kommo) AS last_paid
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
       AND psm.funnel_stage = 'paid'
     GROUP BY d.manager_id, m.name, d.client_key`,
    params
  );

  type Client = {
    clientKey: string;
    clientName: string;
    orders: number;
    totalPaid: number;
    lastPaid: string;
  };
  type Segments = {
    regular: Client[]; // 2+ paid in last 2 months
    occasional: Client[]; // exactly 1 paid in last 2 months
    sleeping: Client[]; // none recent, but bought in prior 2–6 months
    lost: Client[]; // last purchase older than 6 months
  };

  // Clients that currently have outstanding receivables (active debtors) are
  // excluded from the reactivation (sleeping/lost) segments below.
  const recvKeysRes = await pool.query<{ client_key: string }>(
    `SELECT DISTINCT client_key FROM receivables WHERE client_key IS NOT NULL`
  );
  const receivableKeys = new Set(recvKeysRes.rows.map((r) => r.client_key));

  const byManager = new Map<
    number,
    { managerId: number; managerName: string; segments: Segments }
  >();

  for (const row of result.rows) {
    const recent = Number(row.p_recent);
    const prior = Number(row.p_prior);
    let entry = byManager.get(row.manager_id);
    if (!entry) {
      entry = {
        managerId: row.manager_id,
        managerName: row.manager_name,
        segments: { regular: [], occasional: [], sleeping: [], lost: [] },
      };
      byManager.set(row.manager_id, entry);
    }
    const totalPaid = Number(row.total_paid);
    const client: Client = {
      clientKey: row.client_key,
      clientName: row.client_name,
      orders: totalPaid,
      totalPaid,
      lastPaid: row.last_paid,
    };

    // "Постійний клієнт" = ordered 2+ times (lifetime), not within a window.
    // A client who currently sits in receivables (has open invoices) is an
    // ACTIVE client — never put them in the reactivation segments.
    const inReceivables = receivableKeys.has(row.client_key);
    if (totalPaid >= 2) {
      entry.segments.regular.push(client);
    } else if (recent >= 1 || inReceivables) {
      entry.segments.occasional.push(client);
    } else if (prior >= 1) {
      entry.segments.sleeping.push(client);
    } else {
      entry.segments.lost.push(client);
    }
  }

  const sortByLast = (a: Client, b: Client) => (a.lastPaid < b.lastPaid ? 1 : -1);

  const managers = Array.from(byManager.values()).map((entry) => {
    const s = entry.segments;
    for (const list of [s.regular, s.occasional, s.sleeping, s.lost]) list.sort(sortByLast);
    return {
      managerId: entry.managerId,
      managerName: entry.managerName,
      segments: s,
      regularCount: s.regular.length,
      occasionalCount: s.occasional.length,
      sleepingCount: s.sleeping.length,
      lostCount: s.lost.length,
    };
  });

  // Monthly dynamics of repeat-business: paid orders and revenue over the last
  // 12 months for the same scope, so we can see whether the regular-client base
  // is growing or shrinking by both order count and amount.
  const dynConditions = ["psm.funnel_stage = 'paid'"];
  const dynParams: unknown[] = [asOf];
  if (managerId) {
    dynParams.push(managerId);
    dynConditions.push(`d.manager_id = $${dynParams.length}`);
  }
  if (teamId) {
    dynParams.push(teamId);
    dynConditions.push(`m.team_id = $${dynParams.length}`);
  }

  const dynResult = await pool.query<{ month: string; orders: string; amount: string }>(
    `SELECT to_char(date_trunc('month', d.created_at_kommo), 'YYYY-MM') AS month,
            COUNT(*) AS orders,
            COALESCE(SUM(d.price), 0) AS amount
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${dynConditions.join(" AND ")}
       AND d.created_at_kommo >= date_trunc('month', $1::date) - interval '11 months'
       AND d.created_at_kommo < date_trunc('month', $1::date) + interval '1 month'
     GROUP BY 1
     ORDER BY 1`,
    dynParams
  );

  const months = dynResult.rows.map((r) => ({
    month: r.month,
    orders: Number(r.orders),
    amount: Number(r.amount),
  }));

  // Growth compares the last two COMPLETE months — the current calendar month
  // is still partial, so including it would understate the trend.
  const pct = (cur: number, prev: number) =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0;
  const currentMonthKey = asOf.slice(0, 7);
  const complete = months.filter((m) => m.month < currentMonthKey);
  const last = complete[complete.length - 1];
  const prev = complete[complete.length - 2];
  const dynamics = {
    months,
    currentMonth: currentMonthKey,
    deltaOrders: last && prev ? pct(last.orders, prev.orders) : 0,
    deltaAmount: last && prev ? pct(last.amount, prev.amount) : 0,
    latestMonth: last?.month ?? null,
    latestOrders: last?.orders ?? 0,
    latestAmount: last?.amount ?? 0,
  };

  res.json({ asOf, managers, dynamics });
});

/**
 * Outstanding receivables ("Дебіторська заборгованість") synced from the
 * accounting Google Sheet every 30 minutes. Scoped by role like /loyalty:
 * a manager only sees their own clients' balances, a team lead sees their
 * team, admin sees everyone.
 */
dashboardRouter.get("/receivables", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  const conditions: string[] = ["r.manager_id IS NOT NULL"];
  const params: unknown[] = [];

  if (managerId) {
    params.push(managerId);
    conditions.push(`r.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const result = await pool.query<{
    manager_id: number;
    manager_name: string;
    client_key: string;
    client_name: string;
    amount: string;
    limit_days: number | null;
    overdue_days: number | null;
    synced_at: string;
    comment: string | null;
    due_date: string | null;
  }>(
    `SELECT r.manager_id, m.name AS manager_name, r.client_key, r.client_name, r.amount,
            r.limit_days, r.overdue_days, r.synced_at,
            n.comment, to_char(n.due_date, 'YYYY-MM-DD') AS due_date
     FROM receivables r
     JOIN managers m ON m.id = r.manager_id
     LEFT JOIN receivable_notes n ON n.client_key = r.client_key
     ${where}
     ORDER BY r.amount DESC`,
    params
  );

  const byManager = new Map<
    number,
    {
      managerId: number;
      managerName: string;
      clients: {
        clientKey: string;
        clientName: string;
        amount: number;
        limitDays: number | null;
        overdueDays: number | null;
        comment: string | null;
        dueDate: string | null;
      }[];
      total: number;
    }
  >();

  let syncedAt: string | null = null;
  for (const row of result.rows) {
    syncedAt = row.synced_at;
    let entry = byManager.get(row.manager_id);
    if (!entry) {
      entry = { managerId: row.manager_id, managerName: row.manager_name, clients: [], total: 0 };
      byManager.set(row.manager_id, entry);
    }
    const amount = Number(row.amount);
    entry.clients.push({
      clientKey: row.client_key,
      clientName: row.client_name,
      amount,
      limitDays: row.limit_days,
      overdueDays: row.overdue_days,
      comment: row.comment,
      dueDate: row.due_date,
    });
    entry.total += amount;
  }

  res.json({ syncedAt, managers: Array.from(byManager.values()) });
});

// Team ranking: per-team revenue (success+payment), deals, avg check,
// conversion and receivables for the selected period.
dashboardRouter.get("/teams", async (req, res) => {
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  const sucCond = ["psm.funnel_stage = 'paid'", "d.status_id = 142", "d.closed_at_kommo IS NOT NULL"];
  const sp: unknown[] = [];
  if (from) { sp.push(from); sucCond.push(`(d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${sp.length}`); }
  if (to) { sp.push(to); sucCond.push(`(d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${sp.length}`); }
  const success = await pool.query<{ tid: number; tname: string; rev: string; deals: string }>(
    `SELECT t.id AS tid, t.name AS tname, COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${sucCond.join(" AND ")} GROUP BY t.id, t.name`,
    sp
  );
  const pay = await pool.query<{ tid: number; rev: string; deals: string }>(
    `SELECT t.id AS tid, COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     WHERE d.status_id IN (69716460, 60412544) GROUP BY t.id`
  );
  const lc: string[] = [];
  const lp: unknown[] = [];
  if (from) { lp.push(from); lc.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${lp.length}`); }
  if (to) { lp.push(to); lc.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${lp.length}`); }
  const conv = await pool.query<{ tid: number; leads: string; paid: string }>(
    `SELECT t.id AS tid, COUNT(*) AS leads, COUNT(*) FILTER (WHERE psm.funnel_stage='paid') AS paid
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${lc.length ? "WHERE " + lc.join(" AND ") : ""} GROUP BY t.id`,
    lp
  );
  const recv = await pool.query<{ tid: number; debt: string }>(
    `SELECT m.team_id AS tid, COALESCE(SUM(r.amount),0) AS debt
     FROM receivables r JOIN managers m ON m.id = r.manager_id
     WHERE m.team_id IS NOT NULL GROUP BY m.team_id`
  );

  const map = new Map<number, { teamId: number; teamName: string; revenue: number; deals: number; leads: number; paid: number; receivables: number }>();
  const get = (id: number, name?: string) => {
    let e = map.get(id);
    if (!e) { e = { teamId: id, teamName: name ?? "", revenue: 0, deals: 0, leads: 0, paid: 0, receivables: 0 }; map.set(id, e); }
    if (name) e.teamName = name;
    return e;
  };
  for (const r of success.rows) { const e = get(r.tid, r.tname); e.revenue += Number(r.rev); e.deals += Number(r.deals); }
  for (const r of pay.rows) { const e = get(r.tid); e.revenue += Number(r.rev); e.deals += Number(r.deals); }
  for (const r of conv.rows) { const e = get(r.tid); e.leads += Number(r.leads); e.paid += Number(r.paid); }
  for (const r of recv.rows) { const e = get(r.tid); e.receivables += Number(r.debt); }

  const teams = [...map.values()]
    .map((e) => ({
      teamId: e.teamId,
      teamName: e.teamName,
      revenue: e.revenue,
      deals: e.deals,
      avgCheck: e.deals > 0 ? Math.round(e.revenue / e.deals) : 0,
      conversion: e.leads > 0 ? Math.round((e.paid / e.leads) * 100) : 0,
      receivables: e.receivables,
    }))
    .sort((a, b) => b.revenue - a.revenue);
  res.json({ teams });
});

// Team-lead / admin: save a comment + planned payment date for a receivable
// client (keyed by client_key so it survives sheet re-syncs).
dashboardRouter.put("/receivables/note", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const comment = req.body?.comment != null ? String(req.body.comment) : null;
  const dueDate = req.body?.dueDate ? String(req.body.dueDate) : null;
  await pool.query(
    `INSERT INTO receivable_notes (client_key, comment, due_date, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (client_key) DO UPDATE SET
       comment = EXCLUDED.comment, due_date = EXCLUDED.due_date,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, comment, dueDate, auth.userId]
  );
  res.json({ ok: true });
});

// Kommo-sync health for the admin Settings indicator: when the data was last
// refreshed, whether it looks stalled, and the last error if any.
dashboardRouter.get("/sync-status", async (_req, res) => {
  const r = await pool.query<{
    last_success_at: Date | null;
    last_run_started_at: Date | null;
    last_error: string | null;
    last_deal_count: number | null;
    consecutive_failures: number;
  }>(
    `SELECT last_success_at, last_run_started_at, last_error, last_deal_count, consecutive_failures
     FROM sync_state WHERE id = 1`
  );
  const row = r.rows[0];
  const lastSuccessAt = row?.last_success_at ?? null;
  const ageMinutes = lastSuccessAt
    ? Math.round((Date.now() - new Date(lastSuccessAt).getTime()) / 60000)
    : null;
  res.json({
    lastSuccessAt,
    lastRunStartedAt: row?.last_run_started_at ?? null,
    ageMinutes,
    stale: ageMinutes == null || ageMinutes > 15,
    lastDealCount: row?.last_deal_count ?? null,
    consecutiveFailures: row?.consecutive_failures ?? 0,
    lastError: row?.last_error ?? null,
  });
});

// Manual "Синхронізувати зараз": kick a fresh Kommo pull + stage-events pull on
// demand (a safety net over the automatic cron). Fire-and-forget — the jobs'
// own in-process guards prevent overlap; the UI polls /sync-status for progress.
dashboardRouter.post("/sync", (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  void syncKommo()
    .then(() => syncStageEvents())
    .catch((err) => console.error("Manual sync failed:", err));
  res.json({ started: true });
});
