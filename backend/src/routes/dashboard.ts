import { Router } from "express";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { requireAuth } from "../auth/middleware.js";

/** Direct link to a deal (lead) card in Kommo/amoCRM. */
const kommoLeadUrl = (kommoId: number) => `${config.kommo.baseUrl.replace(/\/$/, "")}/leads/detail/${kommoId}`;

/**
 * «Очікування оплати» = deals from "Виставлено рахунок" through the pre-payment
 * stages (Авто працює → Перевезення завершено → Очікуємо оплату), not yet won.
 * ⚠️ In this account "Виставлення рахунку" (status 100274340) maps to funnel_stage
 * 'approved' (coarse mapping) — so filtering by 'invoiced' alone returns 0. This
 * matches the CRM board and the existing КВП "expected" figure.
 */
const EXPECTED_STAGES =
  "(psm.funnel_stage IN ('approved','invoiced') OR d.status_id IN (69716300, 98470988, 10937178))";
import { getSettings } from "./settings.js";
import { syncKommo } from "../jobs/syncKommo.js";
import { syncStageEvents } from "../jobs/syncStageEvents.js";
import { syncReceivables } from "../jobs/syncReceivables.js";

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

  // Conversion by acquisition channel (leads created in period). A lead counts
  // as "converted" when its CLIENT reaches a paid deal in the full-cycle funnel
  // — matched by client_key. This is essential for "leadgen": those leads live
  // in the Продзвін/Реактивація pipelines whose statuses never map to 'paid',
  // so a same-deal check always yielded 0. "ad" deals are in the full-cycle
  // funnel themselves, so the same client_key match works for them too.
  const scopeConds = paidConds.filter((c) => !c.includes("funnel_stage"));

  // "Конверсія реклами" = full-cycle deals whose «Источник клиента» is in the
  // configured ad-source list (SAME definition as the KPI «прийняв рекламу»),
  // that reached payment — same-deal. Джерело з САМОЇ угоди, не з історії
  // (раніше lead_channel='ad' → неузгодженість із «прийняв рекламу»).
  const { adSources } = await getSettings();
  const adConvParams = [...params, adSources];
  const adSrcIdx = adConvParams.length;
  const adConvRes = await pool.query<{ ad_leads: string; ad_paid: string }>(
    `SELECT COUNT(*) FILTER (WHERE d.client_source = ANY($${adSrcIdx})) AS ad_leads,
            COUNT(*) FILTER (WHERE d.client_source = ANY($${adSrcIdx}) AND psm.funnel_stage = 'paid') AS ad_paid
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.pipeline_id = ANY(ARRAY[8921932, 155304])${scopeConds.length ? " AND " + scopeConds.join(" AND ") : ""}`,
    adConvParams
  );
  const adLeadsCnt = Number(adConvRes.rows[0]?.ad_leads ?? 0);
  const adPaidCnt = Number(adConvRes.rows[0]?.ad_paid ?? 0);
  const adConversion = { leads: adLeadsCnt, paid: adPaidCnt, conversion: adLeadsCnt > 0 ? Math.round((adPaidCnt / adLeadsCnt) * 100) : 0 };

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
  // Full (un-prorated) plan for the anchor month — so the gauge can show the
  // whole monthly target next to the period-prorated one.
  const planMonthTotal = Math.round(
    planMonthsRes.rows
      .filter((r) => r.mon.slice(0, 7) === anchorMonth)
      .reduce((s, r) => s + Number(r.plan), 0)
  );

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

  // Deals currently awaiting payment (invoice issued → pre-payment stages) —
  // a snapshot of the pipeline, grouped by team. See EXPECTED_STAGES.
  const pendScope: string[] = [EXPECTED_STAGES];
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
  // Where those created deals are now — breakdown by current funnel stage (for
  // the "Створені угоди" drill-down: скільки угод на якому етапі).
  const createdByStageRes = await pool.query<{ stage: string | null; c: string; amount: string }>(
    `SELECT psm.funnel_stage AS stage, COUNT(*) AS c, COALESCE(SUM(d.price),0) AS amount
     FROM deals d JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${cfScope.join(" AND ")}
     GROUP BY psm.funnel_stage`,
    cfParams
  );
  const STAGE_ORDER = ["lead_taken", "quote_requested", "approved", "invoiced", "paid"];
  const STAGE_LBL: Record<string, string> = {
    lead_taken: "Взято в роботу", quote_requested: "Отримано заявку на прорахунок",
    approved: "Договір/заявку погоджено", invoiced: "Виставлено рахунок", paid: "Оплачено / успішно",
  };
  const createdByStage = [
    ...STAGE_ORDER.map((st) => {
      const r = createdByStageRes.rows.find((x) => x.stage === st);
      return { stage: st, label: STAGE_LBL[st], deals: Number(r?.c ?? 0), amount: Number(r?.amount ?? 0) };
    }),
    (() => {
      const other = createdByStageRes.rows.filter((x) => !x.stage || !STAGE_ORDER.includes(x.stage));
      return { stage: "other", label: "Інші етапи", deals: other.reduce((s, x) => s + Number(x.c), 0), amount: other.reduce((s, x) => s + Number(x.amount), 0) };
    })(),
  ].filter((s) => s.deals > 0);

  // Carried-over deals: the fixed start-of-month snapshot for the viewed month.
  const carryMonth = (from ? from.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const carryoverRes = await pool.query<{ amount: string; deals: string }>(
    `SELECT amount, deals FROM monthly_carryover WHERE month = $1`,
    [carryMonth]
  );
  const carryover = carryoverRes.rows[0]
    ? { amount: Number(carryoverRes.rows[0].amount), deals: Number(carryoverRes.rows[0].deals) }
    : null;

  // Repeat clients active in the period (for the "Постійні клієнти" drill-down):
  // their in-period order count and revenue. "Repeat" = first-ever paid before
  // the period (or 2+ lifetime when no date range), matching the KPI logic.
  const repeatListRes = await pool.query<{ name: string; orders: string; revenue: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key
     )
     SELECT COALESCE(MAX(d.client_name), 'Клієнт') AS name,
            COUNT(*) AS orders,
            COALESCE(SUM(d.price), 0) AS revenue
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     ${paidWhere}
       AND ${from ? `f.first_paid < $${params.length + 1}::date` : `f.cnt >= 2`}
     GROUP BY d.client_key
     ORDER BY revenue DESC
     LIMIT 300`,
    from ? [...params, from] : params
  );
  const repeatClientsList = repeatListRes.rows.map((r) => ({
    clientName: r.name,
    orders: Number(r.orders),
    revenue: Number(r.revenue),
  }));

  // New clients (first-ever paid in the period) split by acquisition channel:
  // ad (context/target), leadgen, or other (manually-created / previously
  // unseen client). For the "Нові клієнти" drill-down.
  const newBySourceRes = await pool.query<{ ch: string; clients: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key
     )
     SELECT COALESCE(d.lead_channel, 'other') AS ch, COUNT(DISTINCT d.client_key) AS clients
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     ${paidWhere}
       AND ${from ? `f.first_paid >= $${params.length + 1}::date` : `f.cnt = 1`}
     GROUP BY 1`,
    from ? [...params, from] : params
  );
  const newClientsBySource = { ad: 0, leadgen: 0, other: 0 } as { ad: number; leadgen: number; other: number };
  for (const r of newBySourceRes.rows) {
    if (r.ch === "ad" || r.ch === "leadgen") newClientsBySource[r.ch] = Number(r.clients);
    else newClientsBySource.other += Number(r.clients);
  }

  // New clients list (name + orders + revenue in the period) for the "Виручка
  // від нових клієнтів" drill-down — same cohort as newClientsBySource.
  const newListRes = await pool.query<{ name: string; orders: string; revenue: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key
     )
     SELECT COALESCE(MAX(d.client_name), 'Клієнт') AS name,
            COUNT(*) AS orders,
            COALESCE(SUM(d.price), 0) AS revenue
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     ${paidWhere}
       AND ${from ? `f.first_paid >= $${params.length + 1}::date` : `f.cnt = 1`}
     GROUP BY d.client_key
     ORDER BY revenue DESC
     LIMIT 300`,
    from ? [...params, from] : params
  );
  const newClientsList = newListRes.rows.map((r) => ({
    clientName: r.name,
    orders: Number(r.orders),
    revenue: Number(r.revenue),
  }));

  const newRow = newRepeat.rows.find((r) => r.bucket === "new");
  const repeatRow = newRepeat.rows.find((r) => r.bucket === "repeat");

  // Передані заявки: lead-gen qualification leads handed to a SALES manager
  // (entity_responsible_changed on a Кваліфікація lead) in the period, by team.
  //
  // Two corrections vs. the old logic:
  //  1) Exclude lead-gen teams themselves — a "передача" is lead-gen → sales, so
  //     leads whose owner sits in a lead-gen team (name містить «лідоген») are
  //     round-robin within lead-gen, not a real handover to a manager.
  //  2) "Успішно" is measured CROSS-PIPELINE by client: the transferred lead
  //     itself stays in Кваліфікація (never reaches 'paid'), so counting the
  //     team's own won deals is the wrong population (gave conversion >100%).
  //     A transferred lead counts as успішна коли його КЛІЄНТ (client_key)
  //     дійшов до виграної угоди повного циклу — same logic as lead-quality.
  const trParams: unknown[] = [];
  const trConds: string[] = ["t.name NOT ILIKE '%лідоген%'"];
  if (managerId) { trParams.push(managerId); trConds.push(`d.manager_id = $${trParams.length}`); }
  if (teamId) { trParams.push(teamId); trConds.push(`m.team_id = $${trParams.length}`); }
  if (from) { trParams.push(from); trConds.push(`(lte.changed_at AT TIME ZONE 'Europe/Kyiv')::date >= $${trParams.length}`); }
  if (to) { trParams.push(to); trConds.push(`(lte.changed_at AT TIME ZONE 'Europe/Kyiv')::date <= $${trParams.length}`); }
  const trWhere = trConds.join(" AND ");
  // Counts: transferred leads and, of them, how many whose client won a full-cycle deal.
  const transferredRes = await pool.query<{ team_id: number; team_name: string; transferred: string; success: string }>(
    `WITH won_clients AS (
       SELECT DISTINCT d.client_key FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.pipeline_id IN (8921932, 155304) AND d.client_key IS NOT NULL
         AND (d.status_id = 142 OR psm.funnel_stage = 'paid')
     ),
     tl AS (
       SELECT DISTINCT lte.kommo_id, d.client_key, t.id AS team_id, t.name AS team_name
       FROM lead_transfer_events lte
       JOIN deals d ON d.kommo_id = lte.kommo_id
       JOIN managers m ON m.id = d.manager_id
       JOIN teams t ON t.id = m.team_id
       WHERE ${trWhere}
     )
     SELECT team_id, team_name,
            COUNT(*) AS transferred,
            COUNT(*) FILTER (WHERE client_key IN (SELECT client_key FROM won_clients)) AS success
     FROM tl GROUP BY team_id, team_name`, trParams);
  // Revenue of the won full-cycle deals for the DISTINCT converted clients per team.
  const transferRevRes = await pool.query<{ team_id: number; revenue: string }>(
    `WITH won AS (
       SELECT d.client_key, SUM(d.price) AS rev FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.pipeline_id IN (8921932, 155304) AND d.client_key IS NOT NULL
         AND (d.status_id = 142 OR psm.funnel_stage = 'paid')
       GROUP BY d.client_key
     ),
     tlc AS (
       SELECT DISTINCT d.client_key, t.id AS team_id
       FROM lead_transfer_events lte
       JOIN deals d ON d.kommo_id = lte.kommo_id
       JOIN managers m ON m.id = d.manager_id
       JOIN teams t ON t.id = m.team_id
       WHERE ${trWhere} AND d.client_key IS NOT NULL
     )
     SELECT tlc.team_id, COALESCE(SUM(won.rev), 0) AS revenue
     FROM tlc JOIN won ON won.client_key = tlc.client_key
     GROUP BY tlc.team_id`, trParams);
  const trMap = new Map<number, { teamId: number; teamName: string; transferred: number; success: number; successRevenue: number }>();
  const trGet = (id: number, name: string) => {
    let e = trMap.get(id);
    if (!e) { e = { teamId: id, teamName: name, transferred: 0, success: 0, successRevenue: 0 }; trMap.set(id, e); }
    return e;
  };
  for (const r of transferredRes.rows) { const e = trGet(r.team_id, r.team_name); e.transferred += Number(r.transferred); e.success += Number(r.success); }
  for (const r of transferRevRes.rows) { const e = trMap.get(r.team_id); if (e) e.successRevenue += Number(r.revenue); }
  const transferred = {
    total: [...trMap.values()].reduce((s, e) => s + e.transferred, 0),
    success: [...trMap.values()].reduce((s, e) => s + e.success, 0),
    byTeam: [...trMap.values()].filter((e) => e.transferred > 0 || e.success > 0).sort((a, b) => b.transferred - a.transferred),
  };

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
            COUNT(*) FILTER (WHERE d.client_source = ANY($2)) AS ad_leads,
            COUNT(*) FILTER (WHERE d.client_source = ANY($2) AND psm.funnel_stage = 'paid') AS ad_paid,
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
    [monthAnchor, adSources]
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

  // Current-month projection (independent of the selected period): extrapolate
  // the success-money FLOW linearly by working days elapsed, then add the
  // payment-received SNAPSHOT (already "in hand") — "за темпом вийде ₴X".
  const nowK = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const mStartP = nowK.slice(0, 7) + "-01";
  const projParams: unknown[] = [mStartP, nowK];
  const projConds = [
    "psm.funnel_stage = 'paid'", "d.status_id = 142", "d.closed_at_kommo IS NOT NULL",
    `(d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2`,
  ];
  if (managerId) { projParams.push(managerId); projConds.push(`d.manager_id = $${projParams.length}`); }
  if (teamId) { projParams.push(teamId); projConds.push(`m.team_id = $${projParams.length}`); }
  const successMTDRes = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(d.price), 0) AS s FROM deals d JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${projConds.join(" AND ")}`,
    projParams
  );
  const successMTD = Number(successMTDRes.rows[0]?.s ?? 0);
  const mS = new Date(mStartP + "T00:00:00");
  const mE = new Date(mS.getFullYear(), mS.getMonth() + 1, 0);
  const tD = new Date(nowK + "T00:00:00");
  const totalWdP = workingDays(mS, mE);
  const elapsedWdP = workingDays(mS, tD < mE ? tD : mE);
  const monthFactP = Math.round(successMTD + paymentRevenue);
  const projected = elapsedWdP > 0 ? Math.round(successMTD * (totalWdP / elapsedWdP) + paymentRevenue) : monthFactP;
  const projection = {
    monthFact: monthFactP,
    projected,
    plan: planMonthTotal,
    projectedPct: planMonthTotal > 0 ? Math.round((projected / planMonthTotal) * 100) : null,
    elapsedWorkingDays: elapsedWdP,
    totalWorkingDays: totalWdP,
  };

  res.json({
    plan: planTotal,
    planMonthTotal,
    projection,
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
    createdByStage,
    carryover,
    repeatClientsList,
    newClientsList,
    newClientsBySource,
    transferred,
    adConversion,
    // Конверсія лідгену = передана заявка (прорахунок) → успішно реалізовано.
    leadgenConversion: {
      leads: transferred.total,
      paid: transferred.success,
      conversion: transferred.total > 0 ? Math.round((transferred.success / transferred.total) * 100) : 0,
    },
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
  // Source conversion is about the FULL-CYCLE sales funnel only: every deal
  // created in the period there is either "ad" (contextual/google-utm) or
  // "other" = created manually by a manager. Leadgen leads live in their own
  // pipelines and have a dedicated "Конверсія лідогену" card, so they are not
  // part of this table.
  conditions.push(`d.pipeline_id = ANY(ARRAY[8921932, 155304])`);
  const where = `WHERE ${conditions.join(" AND ")}`;

  // «Реклама» = угоди повного циклу з рекламним «Источник клиента» (той самий
  // перелік adSources, що й «прийняв рекламу») — не lead_channel='ad'.
  const { adSources } = await getSettings();
  params.push(adSources);
  const adCase = `CASE WHEN d.client_source = ANY($${params.length}) THEN 'ad' ELSE 'other' END`;

  // "paid" = leads whose CLIENT reached a paid full-cycle deal (client_key
  // match). "paid_amount" is the lead's own paid value.
  const result = await pool.query<{
    lead_channel: string | null;
    leads: string;
    paid: string;
    paid_amount: string;
  }>(
    `WITH paid_clients AS (
       SELECT DISTINCT d.client_key
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     )
     SELECT ${adCase} AS lead_channel,
            COUNT(*) AS leads,
            COUNT(*) FILTER (WHERE d.client_key IN (SELECT client_key FROM paid_clients)) AS paid,
            COALESCE(SUM(d.price) FILTER (WHERE psm.funnel_stage = 'paid'), 0) AS paid_amount
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm
       ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
     GROUP BY ${adCase}`,
    params
  );

  const labels: Record<string, string> = {
    ad: "Таргет / реклама (контекст)",
    other: "Створені вручну (інше)",
  };

  const channels = ["ad", "other"].map((ch) => {
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
            date_trunc('week', d.created_at_kommo AT TIME ZONE 'Europe/Kyiv') AS week_start,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = ANY($1)
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
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

  // «Очікування» = live snapshot of in-progress money (invoice issued → awaiting
  // payment) per manager — see EXPECTED_STAGES.
  const expRes = await pool.query<{ manager_id: number; s: string }>(
    `SELECT d.manager_id, COALESCE(SUM(d.price),0) AS s FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE d.manager_id = ANY($1) AND ${EXPECTED_STAGES}
      GROUP BY d.manager_id`,
    [managerIds]
  );
  const expByMgr = new Map(expRes.rows.map((x) => [x.manager_id, Number(x.s)]));

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
    return { id: m.id, name: m.name, weeks, totals, forecast, expected: expByMgr.get(m.id) ?? 0 };
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
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
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
    `SELECT date_trunc('day', d.created_at_kommo AT TIME ZONE 'Europe/Kyiv') AS day,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
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
    `SELECT date_trunc('month', d.created_at_kommo AT TIME ZONE 'Europe/Kyiv') AS month,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date - interval '11 months'
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
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
  // Each client is counted ONCE and attributed to a single PRIMARY manager (the
  // one with the most paid orders for that client), so a client handled by two
  // managers no longer shows as two rows. Windows/totals are per client_key.
  const result = await pool.query<{
    manager_id: number;
    manager_name: string;
    client_key: string;
    client_name: string;
    p_recent: string; // paid in last `recentMonths`
    p_prior: string; // paid in prior `recentMonths`–`sleepingMonths`
    total_paid: string; // all-time paid orders
    last_paid: string;
  }>(
    `WITH scoped AS (
       SELECT d.client_key, d.manager_id, m.name AS manager_name,
              d.client_name, d.created_at_kommo
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       ${where}
         AND psm.funnel_stage = 'paid'
     ),
     primary_mgr AS (
       SELECT client_key, manager_id, manager_name FROM (
         SELECT client_key, manager_id, manager_name,
                ROW_NUMBER() OVER (
                  PARTITION BY client_key
                  ORDER BY COUNT(*) DESC, MAX(created_at_kommo) DESC
                ) AS rn
         FROM scoped GROUP BY client_key, manager_id, manager_name
       ) z WHERE rn = 1
     ),
     agg AS (
       SELECT client_key,
              (array_agg(client_name ORDER BY created_at_kommo DESC))[1] AS client_name,
              COUNT(*) FILTER (
                WHERE created_at_kommo >= $1::date - interval '${recentMonths} months'
                  AND created_at_kommo < $1::date
              ) AS p_recent,
              COUNT(*) FILTER (
                WHERE created_at_kommo >= $1::date - interval '${sleepingMonths} months'
                  AND created_at_kommo < $1::date - interval '${recentMonths} months'
              ) AS p_prior,
              COUNT(*) AS total_paid,
              MAX(created_at_kommo) AS last_paid
       FROM scoped GROUP BY client_key
     )
     SELECT pm.manager_id, pm.manager_name, a.client_key, a.client_name,
            a.p_recent, a.p_prior, a.total_paid, a.last_paid
     FROM agg a JOIN primary_mgr pm ON pm.client_key = a.client_key`,
    params
  );

  type Client = {
    clientKey: string;
    clientName: string;
    isCompany: boolean; // company (name key) vs фізособа (phone key)
    identifier: string | null; // phone identifier for individuals
    orders: number;
    totalPaid: number;
    lastPaid: string;
  };
  const isPhoneKey = (k: string) => /^\d{9,}$/.test(k);
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
    const individual = isPhoneKey(row.client_key);
    const client: Client = {
      clientKey: row.client_key,
      clientName: row.client_name,
      isCompany: !individual,
      identifier: individual ? row.client_key : null,
      orders: totalPaid,
      totalPaid,
      lastPaid: row.last_paid,
    };

    // "Постійний клієнт" = ordered `threshold`+ times AND is still ACTIVE
    // (ordered within the last `sleepingMonths`, i.e. recent OR prior window),
    // OR currently sits in receivables (has open invoices → active client).
    // A client who ordered 2+ times back in 2023 and went quiet is NOT a
    // regular anymore — they fall through to sleeping/lost for reactivation.
    const inReceivables = receivableKeys.has(row.client_key);
    const isActive = recent >= 1 || prior >= 1 || inReceivables;
    if (totalPaid >= threshold && isActive) {
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

/**
 * Per-invoice breakdown behind a client's receivable balance (the "выгрузка"
 * detail): every unpaid invoice with its number, date, amount and service link.
 * Role-scoped like /receivables — a manager only sees their own clients.
 */
dashboardRouter.get("/receivables/invoices", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });

  const conds = ["ri.client_key = $1"];
  const params: unknown[] = [clientKey];
  if (auth.role === "manager") { params.push(auth.managerId); conds.push(`ri.manager_id = $${params.length}`); }
  else if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`m.team_id = $${params.length}`); }

  const r = await pool.query<{ invoice_no: string | null; invoice_date: string | null; amount: string; service_url: string | null; note: string | null }>(
    `SELECT ri.invoice_no, to_char(ri.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            ri.amount, ri.service_url, ri.note
     FROM receivable_invoices ri
     LEFT JOIN managers m ON m.id = ri.manager_id
     WHERE ${conds.join(" AND ")}
     ORDER BY ri.invoice_date DESC NULLS LAST, ri.amount DESC`,
    params
  );
  res.json({
    invoices: r.rows.map((x) => ({
      invoiceNo: x.invoice_no,
      invoiceDate: x.invoice_date,
      amount: Number(x.amount),
      serviceUrl: x.service_url,
      note: x.note,
    })),
  });
});

// Team ranking: per-team revenue (success+payment), deals, avg check,
// conversion and receivables for the selected period.
dashboardRouter.get("/teams", async (req, res) => {
  // Team ranking compares teams — a manager must never see other teams.
  if (req.auth!.role === "manager") return res.status(403).json({ error: "Forbidden" });
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

  // Per-manager breakdown for the team drill-down: revenue (success+payment),
  // deals, the month's plan and receivables — one row per active manager.
  const planMonth = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const mSuccess = await pool.query<{ id: number; name: string; tid: number; rev: string; deals: string }>(
    `SELECT m.id, m.name, m.team_id AS tid, COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${sucCond.join(" AND ")} GROUP BY m.id, m.name, m.team_id`,
    sp
  );
  const mPay = await pool.query<{ id: number; name: string; tid: number; rev: string; deals: string }>(
    `SELECT m.id, m.name, m.team_id AS tid, COALESCE(SUM(d.price),0) AS rev, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     WHERE d.status_id IN (69716460, 60412544) GROUP BY m.id, m.name, m.team_id`
  );
  const mPlan = await pool.query<{ id: number; name: string; tid: number; plan: string }>(
    `SELECT m.id, m.name, m.team_id AS tid, SUM(p.planned_value) AS plan
     FROM plans p JOIN managers m ON m.id = p.manager_id AND m.is_active
     WHERE p.metric = 'payment_amount' AND p.plan_date = $1 GROUP BY m.id, m.name, m.team_id`,
    [planMonth]
  );
  const mRecv = await pool.query<{ id: number; debt: string }>(
    `SELECT r.manager_id AS id, COALESCE(SUM(r.amount),0) AS debt FROM receivables r GROUP BY r.manager_id`
  );
  type MgrRow = { id: number; name: string; teamId: number; revenue: number; deals: number; plan: number; receivables: number };
  const mmap = new Map<number, MgrRow>();
  const mget = (id: number, tid: number | null, name: string): MgrRow => {
    let e = mmap.get(id);
    if (!e) { e = { id, name, teamId: tid ?? 0, revenue: 0, deals: 0, plan: 0, receivables: 0 }; mmap.set(id, e); }
    if (name) e.name = name;
    if (tid) e.teamId = tid;
    return e;
  };
  for (const r of mSuccess.rows) { const e = mget(r.id, r.tid, r.name); e.revenue += Number(r.rev); e.deals += Number(r.deals); }
  for (const r of mPay.rows) { const e = mget(r.id, r.tid, r.name); e.revenue += Number(r.rev); e.deals += Number(r.deals); }
  for (const r of mPlan.rows) { mget(r.id, r.tid, r.name).plan += Number(r.plan); }
  for (const r of mRecv.rows) { const e = mmap.get(r.id); if (e) e.receivables += Number(r.debt); }

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
    // Drop teams with no activity in the period (they leak in via the payment /
    // receivables snapshots) — they showed up as empty rows like "7 —".
    .filter((e) => e.revenue > 0 || e.deals > 0 || e.leads > 0 || e.receivables > 0)
    .map((e) => ({
      teamId: e.teamId,
      teamName: e.teamName,
      revenue: e.revenue,
      deals: e.deals,
      avgCheck: e.deals > 0 ? Math.round(e.revenue / e.deals) : 0,
      conversion: e.leads > 0 ? Math.round((e.paid / e.leads) * 100) : 0,
      receivables: e.receivables,
      managers: [...mmap.values()]
        .filter((m) => m.teamId === e.teamId && (m.revenue > 0 || m.deals > 0 || m.plan > 0 || m.receivables > 0))
        .map((m) => ({
          id: m.id,
          name: m.name,
          revenue: m.revenue,
          deals: m.deals,
          avgCheck: m.deals > 0 ? Math.round(m.revenue / m.deals) : 0,
          plan: m.plan,
          planPct: m.plan > 0 ? Math.round((m.revenue / m.plan) * 100) : 0,
          receivables: m.receivables,
        }))
        .sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);
  res.json({ teams });
});

// All regular clients across teams (2+ lifetime paid orders), with lifetime
// order count + revenue, sorted for the "усі постійні клієнти" drill-down.
dashboardRouter.get("/regular-clients", async (req, res) => {
  const auth = req.auth!;
  if (auth.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const params: unknown[] = [];
  const conds = ["psm.funnel_stage = 'paid'", "d.client_key IS NOT NULL"];
  if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`m.team_id = $${params.length}`); }
  else if (req.query.teamId) { params.push(Number(req.query.teamId)); conds.push(`m.team_id = $${params.length}`); }
  // "Постійний" = 2+ paid orders AND still active (ordered within the sleeping
  // window) — a client who stopped ordering >6 міс тому is not a current
  // regular. Grouping is by client_key, so each client appears ONCE (no
  // per-manager duplication). Type is derived from the key: a numeric key is a
  // phone (фізособа, identified by phone); anything else is a named company.
  const settings = await getSettings();
  const activeMonths = settings.sleepingWindowMonths;
  const r = await pool.query<{ client_key: string; name: string; orders: string; revenue: string; last_paid: string | null }>(
    `SELECT d.client_key,
            COALESCE((array_agg(d.client_name ORDER BY d.created_at_kommo DESC))[1], 'Клієнт') AS name,
            COUNT(*) AS orders,
            COALESCE(SUM(d.price), 0) AS revenue,
            MAX(d.closed_at_kommo) AS last_paid
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${conds.join(" AND ")}
     GROUP BY d.client_key
     HAVING COUNT(*) >= 2
        AND MAX(d.created_at_kommo) >= now() - interval '${activeMonths} months'
     ORDER BY revenue DESC
     LIMIT 500`,
    params
  );
  const isPhoneKey = (k: string) => /^\d{9,}$/.test(k);
  res.json({
    clients: r.rows.map((x) => {
      const individual = isPhoneKey(x.client_key);
      return {
        clientName: x.name,
        isCompany: !individual,
        identifier: individual ? x.client_key : null,
        orders: Number(x.orders),
        revenue: Number(x.revenue),
        lastPaid: x.last_paid,
      };
    }),
  });
});

/**
 * Reactivation candidates for the task planner: former good clients (2+ paid
 * lifetime) who went quiet (last order older than the active window) and are NOT
 * current debtors — grouped by their primary manager, best clients first. The
 * team lead picks whom to assign for reactivation.
 */
dashboardRouter.get("/reactivation-candidates", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") return res.status(403).json({ error: "Forbidden" });
  const teamId: number | null = auth.role === "team_lead" ? (auth.teamId ?? null) : (req.query.teamId ? Number(req.query.teamId) : null);
  const activeMonths = (await getSettings()).sleepingWindowMonths;

  const params: unknown[] = [];
  let teamAnd = "";
  if (teamId != null) { params.push(teamId); teamAnd = `AND m.team_id = $${params.length}`; }

  const r = await pool.query<{ manager_id: number; manager_name: string; client_key: string; name: string; orders: string; revenue: string; last_paid: string; last_activity: string | null; category: string; payment_type: string | null }>(
    `WITH scoped AS (
       SELECT d.client_key, d.manager_id, d.client_name, d.created_at_kommo, d.price, d.payment_type
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.client_key IS NOT NULL AND psm.funnel_stage = 'paid' ${teamAnd}
     ),
     agg AS (
       SELECT client_key,
              (array_agg(client_name ORDER BY created_at_kommo DESC))[1] AS name,
              COUNT(*) AS orders, COALESCE(SUM(price),0) AS revenue, MAX(created_at_kommo) AS last_paid,
              (array_agg(payment_type ORDER BY created_at_kommo DESC))[1] AS payment_type
       FROM scoped GROUP BY client_key
     ),
     primary_mgr AS (
       SELECT client_key, manager_id FROM (
         SELECT client_key, manager_id,
                ROW_NUMBER() OVER (PARTITION BY client_key ORDER BY COUNT(*) DESC, MAX(created_at_kommo) DESC) AS rn
         FROM scoped GROUP BY client_key, manager_id
       ) z WHERE rn = 1
     )
     SELECT pm.manager_id, mm.name AS manager_name, a.client_key, a.name, a.orders, a.revenue, a.last_paid,
            a.payment_type,
            (SELECT MAX(last_activity_at) FROM deals dd WHERE dd.client_key = a.client_key) AS last_activity,
            CASE WHEN a.orders = 1 THEN 'oneshot_bg' ELSE 'lapsed' END AS category
     FROM agg a
     JOIN primary_mgr pm ON pm.client_key = a.client_key
     JOIN managers mm ON mm.id = pm.manager_id
     -- ЛИШЕ компанії (ключ по назві). Фізосіб (ключ по телефону) не пропонуємо.
     WHERE a.client_key !~ '^\\d{9,}$'
       AND a.client_key NOT IN (SELECT client_key FROM receivables WHERE client_key IS NOT NULL)
       AND (
         -- давні хороші клієнти (3+ перевезень), що замовкли
         (a.orders >= 3 AND a.last_paid < now() - interval '${activeMonths} months')
         -- або компанія з 1 перевезенням, оплаченим БЕЗНАЛОМ (форма расчета б/г)
         OR (a.orders = 1 AND a.payment_type ILIKE 'безнал%')
       )
     ORDER BY a.revenue DESC`,
    params
  );

  const byMgr = new Map<number, { managerId: number; managerName: string; clients: unknown[] }>();
  for (const x of r.rows) {
    if (!byMgr.has(x.manager_id)) byMgr.set(x.manager_id, { managerId: x.manager_id, managerName: x.manager_name, clients: [] });
    byMgr.get(x.manager_id)!.clients.push({
      clientKey: x.client_key,
      clientName: x.name,
      isCompany: true,
      identifier: null,
      orders: Number(x.orders),
      revenue: Number(x.revenue),
      lastPaid: x.last_paid,
      lastActivity: x.last_activity,
      category: x.category, // 'lapsed' | 'oneshot_bg'
      paymentType: x.payment_type, // «форма расчета» для oneshot: Безнал с/без НДС
    });
  }
  res.json({ managers: Array.from(byMgr.values()) });
});

/**
 * «Очікування» — deals currently sitting at the "Виставлено рахунок" (invoiced)
 * stage: bills issued, payment expected (not yet «Оплата отримана»/won). A live
 * snapshot per manager. Role-scoped. Used in the Managers and Report tabs.
 */
dashboardRouter.get("/expected-deals", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") { teamId = auth.teamId; }

  const conds = [EXPECTED_STAGES];
  const params: unknown[] = [];
  if (managerId) { params.push(managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }

  const r = await pool.query<{ kommo_id: string; manager_id: number; manager_name: string; client_name: string | null; price: string; created_at_kommo: string; invoiced_at: string | null }>(
    `SELECT d.kommo_id, d.manager_id, m.name AS manager_name, d.client_name, d.price, d.created_at_kommo,
            (SELECT MAX(changed_at) FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id AND e.funnel_stage = 'invoiced') AS invoiced_at
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE ${conds.join(" AND ")}
      ORDER BY d.price DESC`,
    params
  );
  const deals = r.rows.map((x) => ({
    kommoId: Number(x.kommo_id),
    managerId: x.manager_id,
    managerName: x.manager_name,
    clientName: x.client_name,
    amount: Number(x.price),
    createdAt: x.created_at_kommo,
    invoicedAt: x.invoiced_at,
  }));
  res.json({ deals, total: deals.reduce((s, d) => s + d.amount, 0) });
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

// Manual "Оновити дебіторку зараз": re-pull the receivables Google Sheet on
// demand so a payment removed from the file (invoice paid) drops off the
// dashboard immediately instead of waiting for the 30-min cron.
dashboardRouter.post("/sync-receivables", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  try {
    await syncReceivables();
    res.json({ ok: true });
  } catch (err) {
    console.error("Manual receivables sync failed:", err);
    res.status(502).json({ error: "Не вдалося оновити дебіторку" });
  }
});

/**
 * Detailed report for a manager (own data) or a team-lead (their team, summed
 * with a per-manager breakdown). Same money logic as the overview, plus a
 * day/week/month time breakdown. Admin can target any team/manager via query.
 */
dashboardRouter.get("/report", async (req, res) => {
  const auth = req.auth!;
  const g = String(req.query.granularity);
  const granularity = g === "day" || g === "month" ? g : "week";
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    teamId = auth.teamId;
    // Team-lead can drill into one of their managers; both filters apply, so a
    // manager outside the team yields nothing (safe).
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    teamId = req.query.teamId ? Number(req.query.teamId) : null;
  }
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

  const scopeSql = (params: unknown[]) => {
    const c: string[] = [];
    if (managerId) { params.push(managerId); c.push(`d.manager_id = $${params.length}`); }
    if (teamId) { params.push(teamId); c.push(`m.team_id = $${params.length}`); }
    return c;
  };
  const dateSql = (col: string, params: unknown[]) => {
    const c: string[] = [];
    if (from) { params.push(from); c.push(`(d.${col} ${KYIV})::date >= $${params.length}`); }
    if (to) { params.push(to); c.push(`(d.${col} ${KYIV})::date <= $${params.length}`); }
    return c;
  };

  // Success (status 142, closed in period) revenue + deals per time bucket.
  const p1: unknown[] = [];
  const succWhere = ["psm.funnel_stage = 'paid'", "d.status_id = 142", "d.closed_at_kommo IS NOT NULL",
    ...scopeSql(p1), ...dateSql("closed_at_kommo", p1)].join(" AND ");
  const succPeriod = await pool.query<{ bucket: string; revenue: string; deals: string }>(
    `SELECT to_char(date_trunc('${granularity}', (d.closed_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket,
            COALESCE(SUM(d.price), 0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${succWhere} GROUP BY 1 ORDER BY 1`, p1);

  // Created full-cycle deals per bucket (by create date).
  const p2: unknown[] = [[8921932, 155304]];
  const createdWhere = ["d.pipeline_id = ANY($1)", ...scopeSql(p2), ...dateSql("created_at_kommo", p2)].join(" AND ");
  const createdPeriod = await pool.query<{ bucket: string; c: string }>(
    `SELECT to_char(date_trunc('${granularity}', (d.created_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket, COUNT(*) AS c
     FROM deals d JOIN managers m ON m.id = d.manager_id WHERE ${createdWhere} GROUP BY 1`, p2);

  const byPeriodMap = new Map<string, { period: string; revenue: number; deals: number; created: number }>();
  const bp = (b: string) => {
    let e = byPeriodMap.get(b);
    if (!e) { e = { period: b, revenue: 0, deals: 0, created: 0 }; byPeriodMap.set(b, e); }
    return e;
  };
  for (const r of succPeriod.rows) { const e = bp(r.bucket); e.revenue += Number(r.revenue); e.deals += Number(r.deals); }
  for (const r of createdPeriod.rows) bp(r.bucket).created += Number(r.c);
  const byPeriod = [...byPeriodMap.values()]
    .sort((a, b) => (a.period < b.period ? -1 : 1))
    .map((e) => ({ ...e, avgCheck: e.deals > 0 ? Math.round(e.revenue / e.deals) : 0 }));

  // Summary totals (period): success + payment snapshot, created, new/repeat, receivables.
  const succTotal = await pool.query<{ revenue: string; deals: string }>(
    `SELECT COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${succWhere}`, p1);
  const p3: unknown[] = [[69716460, 60412544]];
  const payWhere = ["d.status_id = ANY($1)", ...scopeSql(p3)].join(" AND ");
  const payTotal = await pool.query<{ revenue: string; deals: string }>(
    `SELECT COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id WHERE ${payWhere}`, p3);
  const createdTotal = byPeriod.reduce((s, e) => s + e.created, 0);

  const p4: unknown[] = [];
  const nrScope = scopeSql(p4);
  const nrDate = dateSql("created_at_kommo", p4);
  const nrWhere = ["psm.funnel_stage = 'paid'", ...nrScope, ...nrDate].join(" AND ");
  const fromIdx = from ? (p4.push(from), p4.length) : null;
  const newRepeat = await pool.query<{ bucket: string; clients: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL GROUP BY d.client_key
     )
     SELECT CASE WHEN ${fromIdx ? `f.first_paid >= $${fromIdx}::date` : `f.cnt = 1`} THEN 'new' ELSE 'repeat' END AS bucket,
            COUNT(DISTINCT d.client_key) AS clients
     FROM deals d JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     WHERE ${nrWhere} GROUP BY 1`, p4);
  const newClients = Number(newRepeat.rows.find((r) => r.bucket === "new")?.clients ?? 0);
  const repeatClients = Number(newRepeat.rows.find((r) => r.bucket === "repeat")?.clients ?? 0);

  const p5: unknown[] = [];
  const recvC: string[] = ["r.manager_id IS NOT NULL"];
  if (managerId) { p5.push(managerId); recvC.push(`r.manager_id = $${p5.length}`); }
  if (teamId) { p5.push(teamId); recvC.push(`m.team_id = $${p5.length}`); }
  const recvTotal = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(r.amount),0) AS total FROM receivables r JOIN managers m ON m.id = r.manager_id
     WHERE ${recvC.join(" AND ")}`, p5);

  const successRevenue = Number(succTotal.rows[0]?.revenue ?? 0);
  const successDeals = Number(succTotal.rows[0]?.deals ?? 0);
  const paymentRevenue = Number(payTotal.rows[0]?.revenue ?? 0);
  const paymentDeals = Number(payTotal.rows[0]?.deals ?? 0);
  const revenue = successRevenue + paymentRevenue;
  const deals = successDeals + paymentDeals;
  // Full per-manager scorecard (the metrics from the manual Excel report).
  const DISPATCH = "(psm.funnel_stage IN ('invoiced','paid') OR d.status_id IN (69716300, 98470988, 10937178))";
  const { adSources: reportAdSources } = await getSettings();
  const actP: unknown[] = [[8921932, 155304]];
  const actConds = ["d.pipeline_id = ANY($1)", ...scopeSql(actP), ...dateSql("created_at_kommo", actP)];
  actP.push(reportAdSources);
  const actAdIdx = actP.length;
  const actByMgr = await pool.query<{ id: number; name: string; ad_leads: string; quotes: string; dispatched: string; dispatched_sum: string; success: string; success_sum: string }>(
    `SELECT m.id, m.name,
       COUNT(*) FILTER (WHERE d.client_source = ANY($${actAdIdx})) AS ad_leads,
       COUNT(*) FILTER (WHERE psm.funnel_stage IN ('quote_requested','approved','invoiced','paid')) AS quotes,
       COUNT(*) FILTER (WHERE ${DISPATCH}) AS dispatched,
       COALESCE(SUM(d.price) FILTER (WHERE ${DISPATCH}), 0) AS dispatched_sum
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${actConds.join(" AND ")}
     GROUP BY m.id, m.name`, actP);

  // Success (142, closed in period) per manager.
  const scP: unknown[] = [];
  const scConds = ["psm.funnel_stage = 'paid'", "d.status_id = 142", "d.closed_at_kommo IS NOT NULL", ...scopeSql(scP), ...dateSql("closed_at_kommo", scP)];
  const succByMgr = await pool.query<{ id: number; name: string; revenue: string; deals: string }>(
    `SELECT m.id, m.name, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${scConds.join(" AND ")} GROUP BY m.id, m.name`, scP);

  // Payment-received snapshot (₴) per manager.
  const prP: unknown[] = [[69716460, 60412544]];
  const prScope = scopeSql(prP);
  const payByMgr = await pool.query<{ id: number; s: string }>(
    `SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s
     FROM deals d JOIN managers m ON m.id = d.manager_id
     WHERE d.status_id = ANY($1) ${prScope.length ? "AND " + prScope.join(" AND ") : ""}
     GROUP BY d.manager_id`, prP);

  // «Очікування» per manager — invoiced-stage snapshot (bills awaiting payment).
  const expP: unknown[] = [];
  const expScope = scopeSql(expP);
  const expByMgr = await pool.query<{ id: number; s: string }>(
    `SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s
     FROM deals d JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${EXPECTED_STAGES} ${expScope.length ? "AND " + expScope.join(" AND ") : ""}
     GROUP BY d.manager_id`, expP);

  // Передані заявки per manager (period) — з «Реєстру» лідоген-бота: один лід =
  // один вхід у «Нова заявка від лідогенератора», DISTINCT lead_id за період.
  // (Раніше lead_transfer_events рахував зміни відповідального → завищення в рази.)
  const trP: unknown[] = [];
  const trScope = scopeSql(trP);
  const trDate: string[] = [];
  if (from) { trP.push(from); trDate.push(`(lr.transferred_at ${KYIV})::date >= $${trP.length}`); }
  if (to) { trP.push(to); trDate.push(`(lr.transferred_at ${KYIV})::date <= $${trP.length}`); }
  const trConds = [...trScope, ...trDate];
  const transfByMgr = await pool.query<{ id: number; c: string }>(
    `SELECT d.manager_id AS id, COUNT(DISTINCT lr.lead_id) AS c
     FROM leadgen_registry lr JOIN deals d ON d.kommo_id = lr.lead_id JOIN managers m ON m.id = d.manager_id
     ${trConds.length ? "WHERE " + trConds.join(" AND ") : ""}
     GROUP BY d.manager_id`, trP);

  // Перенесені (carryover) per manager for the report month.
  const coMonth = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const coP: unknown[] = [coMonth];
  const coScope: string[] = [];
  if (managerId) { coP.push(managerId); coScope.push(`cm.manager_id = $${coP.length}`); }
  if (teamId) { coP.push(teamId); coScope.push(`m.team_id = $${coP.length}`); }
  const carryByMgr = await pool.query<{ id: number; amount: string; deals: string }>(
    `SELECT cm.manager_id AS id, cm.amount, cm.deals
     FROM monthly_carryover_mgr cm JOIN managers m ON m.id = cm.manager_id
     WHERE cm.month = $1 ${coScope.length ? "AND " + coScope.join(" AND ") : ""}`, coP);

  type Score = {
    managerId: number; name: string;
    adLeads: number; quotes: number; dispatched: number; dispatchedSum: number;
    successRevenue: number; successDeals: number; paymentReceived: number;
    transfers: number; carryover: number; carryoverDeals: number; plan: number; expected: number;
  };
  const scoreMap = new Map<number, Score>();
  const sc = (id: number, name = ""): Score => {
    let e = scoreMap.get(id);
    if (!e) { e = { managerId: id, name, adLeads: 0, quotes: 0, dispatched: 0, dispatchedSum: 0, successRevenue: 0, successDeals: 0, paymentReceived: 0, transfers: 0, carryover: 0, carryoverDeals: 0, plan: 0, expected: 0 }; scoreMap.set(id, e); }
    if (name) e.name = name;
    return e;
  };
  for (const r of actByMgr.rows) { const e = sc(r.id, r.name); e.adLeads = Number(r.ad_leads); e.quotes = Number(r.quotes); e.dispatched = Number(r.dispatched); e.dispatchedSum = Number(r.dispatched_sum); }
  for (const r of succByMgr.rows) { const e = sc(r.id, r.name); e.successRevenue = Number(r.revenue); e.successDeals = Number(r.deals); }
  for (const r of payByMgr.rows) sc(r.id).paymentReceived = Number(r.s);
  for (const r of expByMgr.rows) sc(r.id).expected = Number(r.s);
  for (const r of transfByMgr.rows) sc(r.id).transfers = Number(r.c);
  for (const r of carryByMgr.rows) { const e = sc(r.id); e.carryover = Number(r.amount); e.carryoverDeals = Number(r.deals); }
  // Monthly payment_amount plan per manager (for the План/Факт drill-down).
  const planMonthR = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const planScoreP: unknown[] = [planMonthR];
  const planScoreC = ["p.plan_date = $1", "p.metric = 'payment_amount'"];
  if (teamId) { planScoreP.push(teamId); planScoreC.push(`m.team_id = $${planScoreP.length}`); }
  const planByMgr = await pool.query<{ id: number; plan: string }>(
    `SELECT p.manager_id AS id, SUM(p.planned_value) AS plan
     FROM plans p JOIN managers m ON m.id = p.manager_id
     WHERE ${planScoreC.join(" AND ")} GROUP BY p.manager_id`,
    planScoreP
  );
  for (const r of planByMgr.rows) sc(r.id).plan = Number(r.plan);
  const sumK = (k: keyof Score) => [...scoreMap.values()].reduce((s, e) => s + (e[k] as number), 0);

  const summary = {
    successRevenue, successDeals, paymentRevenue, paymentDeals,
    revenue, deals,
    avgCheck: deals > 0 ? Math.round(revenue / deals) : 0,
    createdDeals: createdTotal,
    newClients, repeatClients,
    receivables: Number(recvTotal.rows[0]?.total ?? 0),
    adLeads: sumK("adLeads"), quotes: sumK("quotes"),
    dispatched: sumK("dispatched"), dispatchedSum: sumK("dispatchedSum"),
    transfers: sumK("transfers"),
    carryover: sumK("carryover"), carryoverDeals: sumK("carryoverDeals"),
    expected: sumK("expected"),
  };

  const byManager = managerId
    ? []
    : [...scoreMap.values()]
        .filter((e) => e.successRevenue > 0 || e.dispatched > 0 || e.quotes > 0 || e.paymentReceived > 0 || e.transfers > 0)
        .map((e) => ({ ...e, avgCheck: e.successDeals > 0 ? Math.round(e.successRevenue / e.successDeals) : 0 }))
        .sort((a, b) => b.successRevenue - a.successRevenue);

  res.json({ granularity, scope: managerId ? "manager" : "team", summary, byPeriod, byManager });
});

/**
 * Client-funnel report (auto version of the managers' manual "воронка клієнтів"
 * sheet). For deals created in the period (full-cycle pipeline), counts how many
 * reached each stage — Взято в роботу → Запит на прорахунок → Погоджено →
 * Рахунок → Оплата — split by client type (Нові / Постійні / Від лідогенератора),
 * per manager and summed for the team. Cumulative by creation cohort: a deal
 * counts toward every stage up to and including the deepest it has reached.
 */
const FUNNEL_ORDER = ["lead_taken", "quote_requested", "approved", "invoiced", "paid"];
const FUNNEL_LABELS: Record<string, string> = {
  lead_taken: "Взято в роботу лідів",
  quote_requested: "Отримано заявку на прорахунок",
  approved: "Договір/заявку погоджено",
  invoiced: "Виставлено рахунок",
  paid: "Оплата отримана",
};

/** Working days (Mon–Fri) in [start, end] inclusive. */
function workingDays(start: Date, end: Date): number {
  let n = 0;
  const d = new Date(start);
  while (d <= end) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}
dashboardRouter.get("/funnel-report", async (req, res) => {
  const auth = req.auth!;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    teamId = auth.teamId;
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    teamId = req.query.teamId ? Number(req.query.teamId) : null;
  }
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

  const params: unknown[] = [[8921932, 155304]];
  const conds = ["d.pipeline_id = ANY($1)"];
  if (managerId) { params.push(managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }
  if (from) { params.push(from); conds.push(`(d.created_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (to) { params.push(to); conds.push(`(d.created_at_kommo ${KYIV})::date <= $${params.length}`); }

  const rows = await pool.query<{ manager_id: number; name: string; stage: string; bucket: string; c: string }>(
    `WITH firsts AS (
       SELECT d.client_key, COUNT(*) AS cnt
       FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL GROUP BY d.client_key
     )
     SELECT m.id AS manager_id, m.name,
            psm.funnel_stage AS stage,
            CASE WHEN d.lead_channel = 'leadgen' THEN 'leadgen'
                 WHEN COALESCE(f.cnt, 0) >= 2 THEN 'regular' ELSE 'new' END AS bucket,
            COUNT(*) AS c
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     LEFT JOIN firsts f ON f.client_key = d.client_key
     WHERE ${conds.join(" AND ")}
     GROUP BY m.id, m.name, psm.funnel_stage, bucket`,
    params
  );

  type Buckets = { new: number; regular: number; leadgen: number; total: number };
  const emptyStage = (): Buckets => ({ new: 0, regular: 0, leadgen: 0, total: 0 });
  const buildStages = (raw: { stage: string; bucket: string; c: number }[]) => {
    const reached = FUNNEL_ORDER.map(() => emptyStage());
    for (const r of raw) {
      const idx = FUNNEL_ORDER.indexOf(r.stage);
      if (idx < 0) continue;
      const b = r.bucket as "new" | "regular" | "leadgen";
      for (let i = 0; i <= idx; i++) {
        reached[i][b] += r.c;
        reached[i].total += r.c;
      }
    }
    return FUNNEL_ORDER.map((stage, i) => ({ stage, label: FUNNEL_LABELS[stage], ...reached[i] }));
  };

  const allRaw = rows.rows.map((r) => ({ stage: r.stage, bucket: r.bucket, c: Number(r.c) }));
  const stages = buildStages(allRaw);

  const byMgrMap = new Map<number, { managerId: number; name: string; raw: { stage: string; bucket: string; c: number }[] }>();
  for (const r of rows.rows) {
    let e = byMgrMap.get(r.manager_id);
    if (!e) { e = { managerId: r.manager_id, name: r.name, raw: [] }; byMgrMap.set(r.manager_id, e); }
    e.raw.push({ stage: r.stage, bucket: r.bucket, c: Number(r.c) });
  }
  const byManager = managerId
    ? []
    : [...byMgrMap.values()]
        .map((e) => ({ managerId: e.managerId, name: e.name, stages: buildStages(e.raw) }))
        .filter((e) => e.stages[0].total > 0)
        .sort((a, b) => b.stages[FUNNEL_ORDER.length - 1].total - a.stages[FUNNEL_ORDER.length - 1].total);

  // Plan overlay: the month's plan per stage (funnel_plans), prorated to date by
  // working days, so "план на сьогодні"/"відставання"/"темп" can be shown.
  const planMonthDate = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const planParams: unknown[] = [planMonthDate];
  const planConds: string[] = ["fp.month = $1"];
  if (managerId) { planParams.push(managerId); planConds.push(`fp.manager_id = $${planParams.length}`); }
  if (teamId) { planParams.push(teamId); planConds.push(`m.team_id = $${planParams.length}`); }
  const planRows = await pool.query<{ manager_id: number; stage: string; planned: string }>(
    `SELECT fp.manager_id, fp.stage, fp.planned_value AS planned
     FROM funnel_plans fp JOIN managers m ON m.id = fp.manager_id
     WHERE ${planConds.join(" AND ")}`,
    planParams
  );
  const mStart = new Date(planMonthDate + "T00:00:00");
  const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const toDate = to ? new Date(to + "T00:00:00") : today;
  const elapsedEnd = toDate < today ? toDate : today;
  const totalWd = workingDays(mStart, mEnd);
  const elapsedWd = elapsedEnd >= mStart ? workingDays(mStart, elapsedEnd < mEnd ? elapsedEnd : mEnd) : 0;
  const proratio = totalWd > 0 ? elapsedWd / totalWd : 0;

  const overallPlan: Record<string, number> = {};
  const mgrPlan = new Map<number, Record<string, number>>();
  for (const r of planRows.rows) {
    const p = Number(r.planned);
    overallPlan[r.stage] = (overallPlan[r.stage] ?? 0) + p;
    let mp = mgrPlan.get(r.manager_id);
    if (!mp) { mp = {}; mgrPlan.set(r.manager_id, mp); }
    mp[r.stage] = (mp[r.stage] ?? 0) + p;
  }
  const enrich = <T extends { stage: string }>(arr: T[], plan: Record<string, number>) =>
    arr.map((s) => {
      const pm = plan[s.stage] ?? 0;
      return { ...s, planMonth: pm, planToDate: Math.round(pm * proratio) };
    });

  res.json({
    scope: managerId ? "manager" : "team",
    month: planMonthDate,
    workingDays: { total: totalWd, elapsed: elapsedWd },
    stages: enrich(stages, overallPlan),
    byManager: byManager.map((m) => ({ ...m, stages: enrich(m.stages, mgrPlan.get(m.managerId) ?? {}) })),
  });
});

/**
 * Weekly funnel matrix ("Звіт по воронці клієнтів") — the operational report the
 * team-lead reviews Mon/Thu. Unlike /funnel-report (a creation cohort), FACT here
 * counts STAGE-ENTRY events (deal_stage_events): how many deals entered each stage
 * within each week of the month, regardless of when the deal was created — so
 * "Отримано заявку" can exceed "Взято в роботу" in a given week. Plan comes from
 * funnel_plans, prorated across weeks by working days. Returns overall + per manager.
 */
dashboardRouter.get("/funnel-weekly", async (req, res) => {
  const auth = req.auth!;
  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    teamId = auth.teamId;
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    teamId = req.query.teamId ? Number(req.query.teamId) : null;
  }
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Month is taken from ?month=YYYY-MM (or the `to` filter, or current month).
  const monthQ = (req.query.month as string) || (req.query.to as string) || new Date().toISOString().slice(0, 7);
  const planMonthDate = monthQ.slice(0, 7) + "-01";
  const mStart = new Date(planMonthDate + "T00:00:00");
  const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const factUpper = today < mEnd ? today : mEnd; // cap facts at today for the current month

  // Split the month into Mon–Sun weeks clipped to the month boundaries.
  const weeks: { label: string; from: string; to: string; monday: string; wd: number }[] = [];
  let cur = new Date(mStart);
  while (cur <= mEnd) {
    const daysToSun = (7 - cur.getDay()) % 7;
    let wEnd = new Date(cur); wEnd.setDate(cur.getDate() + daysToSun);
    if (wEnd > mEnd) wEnd = new Date(mEnd);
    const mon = new Date(cur); mon.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
    weeks.push({ label: `ТИЖДЕНЬ ${weeks.length + 1}`, from: fmt(cur), to: fmt(wEnd), monday: fmt(mon), wd: workingDays(cur, wEnd) });
    cur = new Date(wEnd); cur.setDate(wEnd.getDate() + 1);
  }
  const totalWd = workingDays(mStart, mEnd);
  const elapsedEnd = factUpper >= mStart ? factUpper : mStart;
  const elapsedWd = factUpper >= mStart ? workingDays(mStart, elapsedEnd) : 0;
  const proratio = totalWd > 0 ? elapsedWd / totalWd : 0;

  // Unified 4-stage funnel (РНК = РПК = Самостійний). Stages are resolved from
  // the LIVE pipeline_stage_map (so newly-mapped statuses count immediately) and
  // grouped: "Взято в роботу" = усе до «Авто працює» (lead_taken + quote +
  // approved, крім avto); "Авто працює" = avto-статуси; далі рахунок і оплата.
  const AVTO = "dse.status_id IN (69716300, 98470988, 10937178)";
  const WK_STAGE_CASE = `CASE
    WHEN ${AVTO} THEN 'avto'
    WHEN psm.funnel_stage IN ('lead_taken','quote_requested','approved') THEN 'taken'
    WHEN psm.funnel_stage = 'invoiced' THEN 'invoiced'
    WHEN psm.funnel_stage = 'paid' THEN 'paid' END`;

  // FACT: distinct deals that entered each grouped stage, per manager, per ISO-week.
  const fParams: unknown[] = [[8921932, 155304], fmt(mStart), fmt(factUpper)];
  const fConds = [
    "d.pipeline_id = ANY($1)",
    "psm.funnel_stage IS NOT NULL",
    `(dse.changed_at ${KYIV})::date BETWEEN $2 AND $3`,
  ];
  if (managerId) { fParams.push(managerId); fConds.push(`d.manager_id = $${fParams.length}`); }
  if (teamId) { fParams.push(teamId); fConds.push(`m.team_id = $${fParams.length}`); }
  const factRows = await pool.query<{ manager_id: number; name: string; stage: string; wk: string; c: string }>(
    `SELECT d.manager_id, m.name, ${WK_STAGE_CASE} AS stage,
            to_char(date_trunc('week', (dse.changed_at ${KYIV})), 'YYYY-MM-DD') AS wk,
            COUNT(DISTINCT dse.kommo_id) AS c
     FROM deal_stage_events dse
     JOIN deals d ON d.kommo_id = dse.kommo_id
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
     WHERE ${fConds.join(" AND ")}
     GROUP BY d.manager_id, m.name, ${WK_STAGE_CASE}, wk`,
    fParams
  );

  // PLAN: monthly funnel plan per stage (funnel_plans).
  const pParams: unknown[] = [planMonthDate];
  const pConds = ["fp.month = $1"];
  if (managerId) { pParams.push(managerId); pConds.push(`fp.manager_id = $${pParams.length}`); }
  if (teamId) { pParams.push(teamId); pConds.push(`m.team_id = $${pParams.length}`); }
  const planRows = await pool.query<{ manager_id: number; stage: string; planned: string }>(
    `SELECT fp.manager_id, fp.stage, fp.planned_value AS planned
     FROM funnel_plans fp JOIN managers m ON m.id = fp.manager_id
     WHERE ${pConds.join(" AND ")}`,
    pParams
  );

  // MONEY per manager (live sums, so they follow the deal's current budget):
  //  • carryover = deals still "Авто працює"/in progress (not paid) that were
  //    created BEFORE the 1st of this month — "перенесені з минулого місяця".
  //  • expected  = ALL deals in progress not yet paid — expected payments this month.
  //  • received  = paid: "Оплата отримана" snapshot (69716460/60412544) +
  //    "Успішна угода" (142) closed within the month.
  const IN_PROGRESS =
    "(psm.funnel_stage IN ('approved','invoiced') OR d.status_id IN (69716300, 98470988, 10937178))";
  const mParams: unknown[] = [[8921932, 155304], fmt(mStart), fmt(mStart), fmt(factUpper)];
  const mConds = ["d.pipeline_id = ANY($1)"];
  if (managerId) { mParams.push(managerId); mConds.push(`d.manager_id = $${mParams.length}`); }
  if (teamId) { mParams.push(teamId); mConds.push(`m.team_id = $${mParams.length}`); }
  const moneyRows = await pool.query<{ manager_id: number; carryover: string; expected: string; received: string }>(
    `SELECT d.manager_id,
       COALESCE(SUM(d.price) FILTER (WHERE ${IN_PROGRESS} AND (d.created_at_kommo ${KYIV})::date < $2), 0) AS carryover,
       COALESCE(SUM(d.price) FILTER (WHERE ${IN_PROGRESS}), 0) AS expected,
       COALESCE(SUM(d.price) FILTER (WHERE d.status_id IN (69716460, 60412544)), 0)
       + COALESCE(SUM(d.price) FILTER (WHERE d.status_id = 142 AND (d.closed_at_kommo ${KYIV})::date BETWEEN $3 AND $4), 0) AS received
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${mConds.join(" AND ")}
     GROUP BY d.manager_id`,
    mParams
  );
  type MoneyWeek = { plan: number; fact: number };
  type Money = {
    carryover: number; expected: number; received: number;
    planMonth: number; weeks: MoneyWeek[]; daily: { date: string; v: number }[];
  };
  const emptyMoney = (): Money => ({
    carryover: 0, expected: 0, received: 0, planMonth: 0,
    weeks: weeks.map(() => ({ plan: 0, fact: 0 })), daily: [],
  });
  const overallMoney = emptyMoney();
  const mgrMoney = new Map<number, Money>();
  const moneyOf = (id: number): Money => {
    let m = mgrMoney.get(id);
    if (!m) { m = emptyMoney(); mgrMoney.set(id, m); }
    return m;
  };
  for (const r of moneyRows.rows) {
    const m = moneyOf(r.manager_id);
    m.carryover = Number(r.carryover); m.expected = Number(r.expected); m.received = Number(r.received);
    overallMoney.carryover += m.carryover;
    overallMoney.expected += m.expected;
    overallMoney.received += m.received;
  }

  // Місячний план виручки (plans.payment_amount) → пропорційно на тижні за
  // робочими днями; факт по тижнях/днях = «Успішно» (142), закриті в тижні/дні
  // (снапшот «оплата отримана» по тижнях не ділиться — він у місячному received).
  const rpParams: unknown[] = [planMonthDate];
  const rpConds = ["p.plan_date = $1", "p.metric = 'payment_amount'"];
  if (managerId) { rpParams.push(managerId); rpConds.push(`p.manager_id = $${rpParams.length}`); }
  if (teamId) { rpParams.push(teamId); rpConds.push(`m.team_id = $${rpParams.length}`); }
  const revPlanRows = await pool.query<{ manager_id: number; v: string }>(
    `SELECT p.manager_id, SUM(p.planned_value) AS v
       FROM plans p JOIN managers m ON m.id = p.manager_id
      WHERE ${rpConds.join(" AND ")} GROUP BY p.manager_id`,
    rpParams
  );
  for (const r of revPlanRows.rows) {
    const v = Number(r.v);
    moneyOf(r.manager_id).planMonth = v;
    overallMoney.planMonth += v;
  }
  for (const m of [overallMoney, ...mgrMoney.values()]) {
    m.weeks = weeks.map((w) => ({ plan: Math.round(m.planMonth * (totalWd > 0 ? w.wd / totalWd : 0)), fact: 0 }));
  }

  const rdParams: unknown[] = [[8921932, 155304], fmt(mStart), fmt(mEnd)];
  const rdConds = [
    "d.pipeline_id = ANY($1)", "d.status_id = 142",
    `(d.closed_at_kommo ${KYIV})::date BETWEEN $2 AND $3`,
  ];
  if (managerId) { rdParams.push(managerId); rdConds.push(`d.manager_id = $${rdParams.length}`); }
  if (teamId) { rdParams.push(teamId); rdConds.push(`m.team_id = $${rdParams.length}`); }
  const revDaily = await pool.query<{ manager_id: number; day: string; v: string }>(
    `SELECT d.manager_id, to_char((d.closed_at_kommo ${KYIV})::date, 'YYYY-MM-DD') AS day, SUM(d.price) AS v
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE ${rdConds.join(" AND ")} GROUP BY d.manager_id, day ORDER BY day`,
    rdParams
  );
  const overallDaily = new Map<string, number>();
  for (const r of revDaily.rows) {
    const v = Number(r.v);
    overallDaily.set(r.day, (overallDaily.get(r.day) ?? 0) + v);
    const wi = weeks.findIndex((w) => r.day >= w.from && r.day <= w.to);
    if (wi >= 0) {
      moneyOf(r.manager_id).weeks[wi].fact += v;
      overallMoney.weeks[wi].fact += v;
    }
  }
  overallMoney.daily = [...overallDaily.entries()].map(([date, v]) => ({ date, v }));

  // Aggregate facts: overall + per manager, keyed stage → mondayWeek → count.
  type WkMap = Record<string, Record<string, number>>;
  const overallFacts: WkMap = {};
  const mgrFacts = new Map<number, { name: string; facts: WkMap }>();
  for (const r of factRows.rows) {
    const c = Number(r.c);
    (overallFacts[r.stage] ??= {})[r.wk] = ((overallFacts[r.stage] ??= {})[r.wk] ?? 0) + c;
    let e = mgrFacts.get(r.manager_id);
    if (!e) { e = { name: r.name, facts: {} }; mgrFacts.set(r.manager_id, e); }
    (e.facts[r.stage] ??= {})[r.wk] = ((e.facts[r.stage] ??= {})[r.wk] ?? 0) + c;
  }
  const overallPlan: Record<string, number> = {};
  const mgrPlan = new Map<number, Record<string, number>>();
  const mgrName = new Map<number, string>();
  for (const r of planRows.rows) {
    const p = Number(r.planned);
    overallPlan[r.stage] = (overallPlan[r.stage] ?? 0) + p;
    let mp = mgrPlan.get(r.manager_id);
    if (!mp) { mp = {}; mgrPlan.set(r.manager_id, mp); }
    mp[r.stage] = (mp[r.stage] ?? 0) + p;
  }
  for (const [id, e] of mgrFacts) mgrName.set(id, e.name);

  const WK_STAGES = ["taken", "avto", "invoiced", "paid"];
  const WK_LABELS: Record<string, string> = {
    taken: "Взято в роботу ліди",
    avto: "Авто працює (ліди в роботі)",
    invoiced: "Виставлено рахунок",
    paid: "Оплата отримана",
  };
  const buildStages = (facts: WkMap, plan: Record<string, number>) =>
    WK_STAGES.map((stage) => {
      const pm = plan[stage] ?? 0;
      const wkOut = weeks.map((w) => ({
        plan: Math.round(pm * (totalWd > 0 ? w.wd / totalWd : 0)),
        fact: facts[stage]?.[w.monday] ?? 0,
      }));
      const factToday = wkOut.reduce((a, w) => a + w.fact, 0);
      return {
        stage,
        label: WK_LABELS[stage],
        planMonth: pm,
        planToday: Math.round(pm * proratio),
        factToday,
        weeks: wkOut,
      };
    });

  const managerIds = new Set<number>([...mgrFacts.keys(), ...mgrPlan.keys(), ...mgrMoney.keys()]);
  // Names for managers that appear only in the plan (no facts yet) need a lookup.
  const missingNames = [...managerIds].filter((id) => !mgrName.has(id));
  if (missingNames.length) {
    const nr = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM managers WHERE id = ANY($1)`,
      [missingNames]
    );
    for (const r of nr.rows) mgrName.set(r.id, r.name);
  }
  const byManager = managerId
    ? []
    : [...managerIds]
        .map((id) => ({ managerId: id, name: mgrName.get(id) ?? `#${id}`, stages: buildStages(mgrFacts.get(id)?.facts ?? {}, mgrPlan.get(id) ?? {}), money: mgrMoney.get(id) ?? emptyMoney() }))
        .sort((a, b) => {
          if (b.money.received !== a.money.received) return b.money.received - a.money.received;
          const pa = a.stages.reduce((s, x) => s + x.factToday, 0);
          const pb = b.stages.reduce((s, x) => s + x.factToday, 0);
          if (pb !== pa) return pb - pa;
          return a.name.localeCompare(b.name, "uk");
        });

  res.json({
    scope: managerId ? "manager" : "team",
    month: planMonthDate,
    today: fmt(today),
    workingDays: { total: totalWd, elapsed: elapsedWd },
    weeks: weeks.map((w) => ({ label: w.label, from: w.from, to: w.to })),
    overall: { name: "ЗАГАЛЬНИЙ", stages: buildStages(overallFacts, overallPlan), money: overallMoney },
    byManager,
  });
});

/**
 * A single manager's daily productivity for the picked day: leads taken,
 * dispatched ("Авто працює"), payments received (count + ₴), the pro-rated
 * daily plan, plus a 14-day payment-sum trend. Manager sees themselves; a
 * team-lead any manager in their team; admin/КВП anyone.
 */
dashboardRouter.get("/daily", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });

  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const day = (req.query.date as string) || new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const AVTO = "dse.status_id IN (69716300, 98470988, 10937178)";
  const GROUP_CASE = `CASE
    WHEN ${AVTO} THEN 'avto'
    WHEN psm.funnel_stage IN ('lead_taken','quote_requested','approved') THEN 'taken'
    WHEN psm.funnel_stage = 'invoiced' THEN 'invoiced'
    WHEN psm.funnel_stage = 'paid' THEN 'paid' END`;

  // Distinct deals entering each grouped stage on the day.
  const grpRes = await pool.query<{ g: string; c: string }>(
    `SELECT ${GROUP_CASE} AS g, COUNT(DISTINCT dse.kommo_id) AS c
     FROM deal_stage_events dse
     JOIN deals d ON d.kommo_id = dse.kommo_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
     WHERE d.manager_id = $1 AND (dse.changed_at ${KYIV})::date = $2
     GROUP BY 1`,
    [managerId, day]
  );
  const grp = (g: string) => Number(grpRes.rows.find((r) => r.g === g)?.c ?? 0);

  // Payment sum on the day (distinct paid-stage entries).
  const paidSumRes = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(x.price), 0) AS s FROM (
       SELECT DISTINCT dse.kommo_id, d.price
       FROM deal_stage_events dse
       JOIN deals d ON d.kommo_id = dse.kommo_id
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
       WHERE d.manager_id = $1 AND psm.funnel_stage = 'paid' AND (dse.changed_at ${KYIV})::date = $2
     ) x`,
    [managerId, day]
  );

  // 14-day payment-sum trend (ending on the picked day).
  const from14 = new Date(day + "T00:00:00"); from14.setDate(from14.getDate() - 13);
  const fmtd = (d: Date) => d.toLocaleDateString("en-CA");
  const trendRes = await pool.query<{ day: string; s: string }>(
    `SELECT day, SUM(price) AS s FROM (
       SELECT DISTINCT (dse.changed_at ${KYIV})::date AS day, dse.kommo_id, d.price
       FROM deal_stage_events dse
       JOIN deals d ON d.kommo_id = dse.kommo_id
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
       WHERE d.manager_id = $1 AND psm.funnel_stage = 'paid'
         AND (dse.changed_at ${KYIV})::date BETWEEN $2 AND $3
     ) x GROUP BY day`,
    [managerId, fmtd(from14), day]
  );
  const trendMap = new Map(trendRes.rows.map((r) => [String(r.day).slice(0, 10), Number(r.s)]));
  const trend: { day: string; amount: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(from14); d.setDate(from14.getDate() + i);
    trend.push({ day: fmtd(d), amount: trendMap.get(fmtd(d)) ?? 0 });
  }

  // Per-day plan = month's payment_amount plan / working days in the month.
  const monthStart = new Date(day + "T00:00:00"); monthStart.setDate(1);
  const planRes = await pool.query<{ p: string }>(
    `SELECT COALESCE(SUM(planned_value), 0) AS p FROM plans
     WHERE manager_id = $1 AND metric = 'payment_amount' AND plan_date = $2`,
    [managerId, fmtd(monthStart)]
  );
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const totalWd = workingDays(monthStart, monthEnd);
  const monthPlan = Number(planRes.rows[0]?.p ?? 0);
  const planDay = totalWd > 0 ? Math.round(monthPlan / totalWd) : 0;
  const paidSum = Number(paidSumRes.rows[0]?.s ?? 0);

  const nameRes = await pool.query<{ name: string; team: string | null }>(
    `SELECT m.name, t.name AS team FROM managers m LEFT JOIN teams t ON t.id = m.team_id WHERE m.id = $1`,
    [managerId]
  );
  res.json({
    date: day,
    managerName: nameRes.rows[0]?.name ?? "",
    teamName: nameRes.rows[0]?.team ?? null,
    taken: grp("taken"),
    avto: grp("avto"),
    paidCount: grp("paid"),
    paidSum,
    planDay,
    planPct: planDay > 0 ? Math.round((paidSum / planDay) * 100) : null,
    trend,
  });
});

/**
 * "Застряглі угоди" — active full-cycle deals that haven't moved to a new stage
 * for ≥ minDays (default 7). Days-in-stage = now − last stage-change event (or
 * creation if no events). Excludes closed deals (paid/won/lost). Role-scoped.
 */
dashboardRouter.get("/stuck-deals", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") { teamId = auth.teamId; managerId = req.query.managerId ? Number(req.query.managerId) : null; }
  const minDays = Math.max(1, Number(req.query.minDays) || 7);
  const AVTO = "d.status_id IN (69716300, 98470988, 10937178)";

  // "Stuck" = no REAL (human) activity inside the deal for a while. We use
  // deals.last_activity_at — the latest call/text/manual note made by an actual
  // user (created_by <> 0), synced from Kommo notes. This is independent of
  // Salesbot: automation bumping the lead's updated_at never resets the timer.
  // Fallback to created_at only (never updated_at) keeps it Salesbot-proof for
  // deals that simply have no human activity yet. Stage-aware threshold:
  // money-in-progress (Авто працює / Рахунок) is stuck after minDays; the early
  // "Взято в роботу" churns naturally, so it needs 3×.
  const minDaysEarly = minDays * 3;
  const ACT = "COALESCE(d.last_activity_at, d.created_at_kommo)";
  const params: unknown[] = [[8921932, 155304], minDays, minDaysEarly];
  const conds = [
    "d.pipeline_id = ANY($1)",
    "psm.funnel_stage <> 'paid'",            // active only (paid/won excluded; lost 143 unmapped → excluded by join)
    `now() - ${ACT} >=
       (CASE WHEN (${AVTO} OR psm.funnel_stage = 'invoiced') THEN $2 ELSE $3 END || ' days')::interval`,
    // Only deals still relevant this half-year — старі покинуті ліди (роками в
    // «Взято в роботу») це не «застрягли», це мертві, тому їх не показуємо.
    "d.created_at_kommo >= now() - interval '180 days'",
    // Money stages (Авто працює / Рахунок) завжди важливі. А рання стадія
    // рахується «застряглою» лише якщо угоду ВЖЕ вели (була активність) і вона
    // затихла — «взяті, але жодного разу не опрацьовані» ліди це не «застрягли»,
    // а нерозібрані (інша проблема), тому їх сюди не тягнемо.
    `(${AVTO} OR psm.funnel_stage = 'invoiced' OR d.last_activity_at IS NOT NULL)`,
  ];
  if (managerId) { params.push(managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }

  const r = await pool.query<{ kommo_id: string; name: string; client: string | null; manager: string; price: string; stage: string; days: string }>(
    `SELECT d.kommo_id, d.name, d.client_name AS client, m.name AS manager, d.price,
            CASE WHEN ${AVTO} THEN 'Авто працює'
                 WHEN psm.funnel_stage IN ('lead_taken','quote_requested','approved') THEN 'Взято в роботу'
                 WHEN psm.funnel_stage = 'invoiced' THEN 'Виставлено рахунок' END AS stage,
            EXTRACT(DAY FROM now() - ${ACT})::int AS days
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${conds.join(" AND ")}
     ORDER BY days DESC
     LIMIT 50`,
    params
  );
  res.json({
    minDays,
    deals: r.rows.map((x) => ({
      kommoId: Number(x.kommo_id),
      crmUrl: kommoLeadUrl(Number(x.kommo_id)),
      name: x.name,
      client: x.client,
      manager: x.manager,
      price: Number(x.price),
      stage: x.stage,
      days: Number(x.days),
    })),
  });
});

/**
 * Data-quality control (ТЗ §7) — surfaces records that silently distort every
 * other metric: deals with no manager, no amount, an unmapped status, negative
 * amounts that aren't real "minus" deals, and probable duplicates. Admin/lead.
 */
dashboardRouter.get("/data-quality", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Доступ лише для тімліда/адміна" });
  }
  const teamAnd = auth.role === "team_lead" && auth.teamId ? `AND m.team_id = ${auth.teamId}` : "";
  const FC = "d.pipeline_id IN (8921932, 155304)";
  const AVTO = "d.status_id IN (69716300, 98470988, 10937178)";
  const MONEY = `(${AVTO} OR psm.funnel_stage IN ('invoiced','paid'))`;
  const ACTIVE = "psm.funnel_stage <> 'paid'";
  const recent = "d.created_at_kommo >= now() - interval '180 days'";

  const sample = (rows: { kommo_id: string; name: string | null; manager: string | null; extra?: string | null }[]) =>
    rows.map((x) => ({ kommoId: Number(x.kommo_id), name: x.name, manager: x.manager, extra: x.extra ?? null }));

  // 1) Full-cycle deals with no manager assigned.
  const noManager = await pool.query<{ kommo_id: string; name: string; manager: null; extra: string }>(
    `SELECT d.kommo_id, d.name, NULL::text AS manager, to_char(d.created_at_kommo,'YYYY-MM-DD') AS extra
       FROM deals d WHERE ${FC} AND d.manager_id IS NULL AND ${recent}
       ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 2) Money-stage deals with no amount (price ≤ 0), excluding real "minus" deals.
  const noAmount = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `SELECT d.kommo_id, d.name, m.name AS manager, psm.funnel_stage AS extra
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE ${FC} AND ${MONEY} AND ${ACTIVE} AND COALESCE(d.price,0) <= 0
        AND (d.name IS NULL OR d.name NOT ILIKE '%мінус%') AND ${recent} ${teamAnd}
      ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 3) Full-cycle deals whose (pipeline,status) is not mapped → invisible to funnel analytics.
  const unmapped = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `SELECT d.kommo_id, d.name, m.name AS manager, d.status_id::text AS extra
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
       LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE ${FC} AND psm.funnel_stage IS NULL AND ${recent}
      ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 4) Negative price without the "minus" marker → likely a data-entry error.
  const negatives = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `SELECT d.kommo_id, d.name, m.name AS manager, d.price::text AS extra
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${FC} AND d.price < 0 AND (d.name IS NULL OR d.name NOT ILIKE '%мінус%') AND ${recent}
      ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 5) Probable duplicates — same client with 2+ active full-cycle deals.
  const duplicates = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `WITH dup AS (
        SELECT client_key FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${FC} AND ${ACTIVE} AND d.client_key IS NOT NULL AND ${recent}
        GROUP BY client_key HAVING COUNT(*) >= 2)
     SELECT d.kommo_id, d.name, m.name AS manager, d.client_name AS extra
       FROM deals d JOIN dup ON dup.client_key = d.client_key
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${FC} AND ${ACTIVE} ${teamAnd}
      ORDER BY d.client_key, d.created_at_kommo DESC LIMIT 120`);

  res.json({
    checks: [
      { key: "noManager", label: "Угоди без менеджера", count: noManager.rowCount ?? 0, sample: sample(noManager.rows) },
      { key: "noAmount", label: "Угоди без суми (грошові етапи)", count: noAmount.rowCount ?? 0, sample: sample(noAmount.rows) },
      { key: "unmapped", label: "Угоди без статусу (не змаплено)", count: unmapped.rowCount ?? 0, sample: sample(unmapped.rows) },
      { key: "negatives", label: "Відʼємна сума без позначки «мінус»", count: negatives.rowCount ?? 0, sample: sample(negatives.rows) },
      { key: "duplicates", label: "Можливі дублі (клієнт з 2+ активними угодами)", count: duplicates.rowCount ?? 0, sample: sample(duplicates.rows) },
    ],
  });
});

/**
 * Lead quality for the КВП report — target vs non-target leads created in the
 * period (Kyiv dates, both ends inclusive):
 *   target      = full-cycle pipeline 8921932 (a real transport deal was opened)
 *   non-target  = Кваліфікація 8921928 closed as lost (status 143) — rejected.
 * Both counts come from our synced `deals` (syncKommo pulls all pipelines).
 */
dashboardRouter.get("/lead-quality", async (req, res) => {
  const auth = req.auth!;
  // Company-wide lead-quality is a КВП/lead metric — managers never see it.
  if (auth.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  const teamId = auth.role === "team_lead" ? auth.teamId ?? null : (req.query.teamId ? Number(req.query.teamId) : null);
  const dateScope = (alias: string, params: unknown[]) => {
    const c: string[] = [];
    if (from) { params.push(from); c.push(`(${alias}.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`); }
    if (to) { params.push(to); c.push(`(${alias}.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`); }
    return c;
  };
  const teamJoin = teamId ? "JOIN managers m ON m.id = d.manager_id" : "";
  const countFor = async (extra: string): Promise<number> => {
    const params: unknown[] = [];
    const conds = [extra, ...dateScope("d", params)];
    if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM deals d ${teamJoin} WHERE ${conds.join(" AND ")}`,
      params
    );
    return Number(r.rows[0]?.n ?? 0);
  };
  const adParams: unknown[] = [];
  const adConds: string[] = [];
  if (from) { adParams.push(from); adConds.push(`day >= $${adParams.length}`); }
  if (to) { adParams.push(to); adConds.push(`day <= $${adParams.length}`); }
  const adWhere = adConds.length ? `WHERE ${adConds.join(" AND ")}` : "";
  const [targetLeads, nonTargetLeads, adRes] = await Promise.all([
    countFor("d.pipeline_id = 8921932"),
    countFor("d.pipeline_id = 8921928 AND d.status_id = 143"),
    pool.query<{ plan: string; fact: string; conv: string }>(
      `SELECT COALESCE(SUM(budget_plan),0) AS plan, COALESCE(SUM(budget_fact),0) AS fact,
              COALESCE(SUM(conversions),0) AS conv
         FROM ad_budget_daily ${adWhere}`,
      adParams
    ),
  ]);
  res.json({
    targetLeads,
    nonTargetLeads,
    adBudgetPlan: Math.round(Number(adRes.rows[0]?.plan ?? 0)),
    adBudgetFact: Math.round(Number(adRes.rows[0]?.fact ?? 0)),
    adBudgetLeads: Number(adRes.rows[0]?.conv ?? 0),
  });
});

/**
 * Plan grid for the plan editor — every active manager (grouped by team) with
 * their monthly payment_amount plan for the chosen month, plus the calendar so
 * the frontend can decompose the plan by week (fixed 7-day blocks) and per
 * working day. Team-lead sees only their team; admin sees all (optional teamId).
 */
dashboardRouter.get("/plans-grid", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Доступ лише для тімліда/адміна" });
  }
  const monthStr = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const planDate = `${monthStr}-01`;
  let teamId: number | null = auth.role === "team_lead" ? auth.teamId ?? null : (req.query.teamId ? Number(req.query.teamId) : null);

  const params: unknown[] = [planDate];
  let teamCond = "";
  if (teamId != null) { params.push(teamId); teamCond = `AND m.team_id = $${params.length}`; }

  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null; plan: string }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name, COALESCE(p.planned_value, 0) AS plan
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN plans p ON p.manager_id = m.id AND p.metric = 'payment_amount' AND p.plan_date = $1
      WHERE m.is_active ${teamCond}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );

  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, mo - 1, d).getDay();
    if (dow !== 0 && dow !== 6) workingDays++;
  }
  const weekStarts = [1, 8, 15, 22, 29].filter((s) => s <= daysInMonth);
  const weeks = weekStarts.map((s, i) => {
    const end = Math.min(s + 6, daysInMonth);
    return { label: `Тиждень ${i + 1}`, from: s, to: end, days: end - s + 1 };
  });

  // Per-manager money for the month (teamId is a validated number → safe to inline):
  //  fact = «Успішно» (142, закрито в місяці) + «Оплата отримана» (снапшот);
  //  carryover = перенесені з мин. міс. (monthly_carryover_mgr);
  //  expected = очікувані кошти = снапшот угод з етапу «Виставлено рахунок» (invoiced).
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const teamAnd = teamId != null ? `AND m.team_id = ${teamId}` : "";
  const [succ, pay, exp, carry] = await Promise.all([
    pool.query<{ id: string; s: string }>(
      `SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage='paid' AND d.status_id=142 AND d.closed_at_kommo IS NOT NULL
          AND (d.closed_at_kommo ${KYIV})::date BETWEEN $1 AND $2 ${teamAnd}
        GROUP BY d.manager_id`, [planDate, monthEnd]),
    pool.query<{ id: string; s: string }>(
      `SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
        WHERE d.status_id IN (69716460,60412544) ${teamAnd}
        GROUP BY d.manager_id`),
    pool.query<{ id: string; s: string }>(
      `SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${EXPECTED_STAGES} ${teamAnd}
        GROUP BY d.manager_id`),
    pool.query<{ id: string; amount: string }>(
      `SELECT cm.manager_id AS id, cm.amount FROM monthly_carryover_mgr cm
         JOIN managers m ON m.id = cm.manager_id
        WHERE cm.month = $1 ${teamAnd}`, [planDate]),
  ]);
  const numMap = (rows: { id: string; s: string }[]) => new Map(rows.map((x) => [Number(x.id), Number(x.s)]));
  const succM = numMap(succ.rows), payM = numMap(pay.rows), expM = numMap(exp.rows);
  const carryM = new Map(carry.rows.map((x) => [Number(x.id), Number(x.amount)]));

  const teamsMap = new Map<number, { teamId: number; teamName: string; teamPlan: number; teamFact: number; teamCarryover: number; teamExpected: number; managers: { managerId: number; name: string; plan: number; fact: number; carryover: number; expected: number }[] }>();
  let totalPlan = 0, totalFact = 0, totalCarryover = 0, totalExpected = 0;
  for (const row of r.rows) {
    const tid = row.team_id ?? 0;
    if (!teamsMap.has(tid)) teamsMap.set(tid, { teamId: tid, teamName: row.team_name ?? "Без команди", teamPlan: 0, teamFact: 0, teamCarryover: 0, teamExpected: 0, managers: [] });
    const plan = Number(row.plan);
    const fact = (succM.get(row.id) ?? 0) + (payM.get(row.id) ?? 0);
    const carryover = carryM.get(row.id) ?? 0;
    const expected = expM.get(row.id) ?? 0;
    const t = teamsMap.get(tid)!;
    t.managers.push({ managerId: row.id, name: row.name, plan, fact, carryover, expected });
    t.teamPlan += plan; t.teamFact += fact; t.teamCarryover += carryover; t.teamExpected += expected;
    totalPlan += plan; totalFact += fact; totalCarryover += carryover; totalExpected += expected;
  }

  res.json({
    month: monthStr,
    daysInMonth,
    workingDays,
    weeks,
    teams: Array.from(teamsMap.values()),
    totalPlan, totalFact, totalCarryover, totalExpected,
  });
});

/**
 * Repeat-client revenue plan grid. Each month a team lead sets, per manager, a
 * revenue target that must be earned FROM regular (repeat) clients; the fact is
 * auto-filled from CRM (received money whose client has 2+ lifetime paid orders)
 * and the frontend decomposes the remaining target across the month's weeks.
 * Team-lead sees only their team; admin sees all (optional teamId).
 */
dashboardRouter.get("/repeat-plans-grid", async (req, res) => {
  const auth = req.auth!;
  const monthStr = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const planDate = `${monthStr}-01`;
  // Managers see only their own row (they propose their clients' plans); team
  // leads see their team; admin sees all (optional teamId).
  const teamId: number | null = auth.role === "manager" ? (auth.teamId ?? null)
    : auth.role === "team_lead" ? (auth.teamId ?? null)
    : (req.query.teamId ? Number(req.query.teamId) : null);
  const managerFilter: number | null = auth.role === "manager" ? (auth.managerId ?? null) : null;
  // includeInactive=1 → also show regulars who stopped ordering long ago
  // (замовклі) for reactivation planning; default shows only active regulars.
  const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";

  const params: unknown[] = [planDate];
  let teamCond = "";
  if (teamId != null) { params.push(teamId); teamCond = `AND m.team_id = $${params.length}`; }
  if (managerFilter != null) { params.push(managerFilter); teamCond += ` AND m.id = $${params.length}`; }

  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null; plan: string }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name, COALESCE(p.planned_value, 0) AS plan
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN plans p ON p.manager_id = m.id AND p.metric = 'repeat_payment_amount' AND p.plan_date = $1
      WHERE m.is_active ${teamCond}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );

  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, mo - 1, d).getDay();
    if (dow !== 0 && dow !== 6) workingDays++;
  }
  const weekStarts = [1, 8, 15, 22, 29].filter((s) => s <= daysInMonth);
  const weeks = weekStarts.map((s, i) => {
    const end = Math.min(s + 6, daysInMonth);
    return { label: `Тиждень ${i + 1}`, from: s, to: end, days: end - s + 1 };
  });

  // Fact = received money (успішно 142 закрито в місяці + оплата снапшот) whose
  // client is a REPEAT client (2+ lifetime paid orders) — «заробіток по постійних».
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const teamAnd = teamId != null ? `AND m.team_id = ${teamId}` : "";
  const REPEAT_CTE = `WITH repeat_clients AS (
       SELECT d.client_key FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key HAVING COUNT(*) >= 2
     )`;
  const [succ, pay] = await Promise.all([
    pool.query<{ id: string; s: string }>(
      `${REPEAT_CTE}
       SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage='paid' AND d.status_id=142 AND d.closed_at_kommo IS NOT NULL
          AND d.client_key IN (SELECT client_key FROM repeat_clients)
          AND (d.closed_at_kommo ${KYIV})::date BETWEEN $1 AND $2 ${teamAnd}
        GROUP BY d.manager_id`, [planDate, monthEnd]),
    pool.query<{ id: string; s: string }>(
      `${REPEAT_CTE}
       SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
        WHERE d.status_id IN (69716460,60412544)
          AND d.client_key IN (SELECT client_key FROM repeat_clients) ${teamAnd}
        GROUP BY d.manager_id`),
  ]);
  const numMap = (rows: { id: string; s: string }[]) => new Map(rows.map((x) => [Number(x.id), Number(x.s)]));
  const succM = numMap(succ.rows), payM = numMap(pay.rows);

  // Each manager's active regular clients (2+ lifetime paid AND ordered within
  // the active window), attributed to a single PRIMARY manager (most paid) so a
  // client shows under exactly one manager — same identity rule as /loyalty.
  const activeMonths = (await getSettings()).sleepingWindowMonths;
  const clientsRes = await pool.query<{ manager_id: number; client_key: string; name: string; orders: string; revenue: string; last_paid: string }>(
    `WITH scoped AS (
       SELECT d.client_key, d.manager_id, d.client_name, d.created_at_kommo, d.price
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.client_key IS NOT NULL AND psm.funnel_stage = 'paid' ${teamAnd}
     ),
     agg AS (
       SELECT client_key,
              (array_agg(client_name ORDER BY created_at_kommo DESC))[1] AS name,
              COUNT(*) AS orders, COALESCE(SUM(price),0) AS revenue,
              MAX(created_at_kommo) AS last_paid
       FROM scoped GROUP BY client_key
     ),
     primary_mgr AS (
       SELECT client_key, manager_id FROM (
         SELECT client_key, manager_id,
                ROW_NUMBER() OVER (PARTITION BY client_key ORDER BY COUNT(*) DESC, MAX(created_at_kommo) DESC) AS rn
         FROM scoped GROUP BY client_key, manager_id
       ) z WHERE rn = 1
     )
     SELECT pm.manager_id, a.client_key, a.name, a.orders, a.revenue, a.last_paid
     FROM agg a JOIN primary_mgr pm ON pm.client_key = a.client_key
     WHERE a.orders >= 2 ${includeInactive ? "" : `AND a.last_paid >= now() - interval '${activeMonths} months'`}
     ORDER BY a.revenue DESC`
  );
  const isPhoneKey = (k: string) => /^\d{9,}$/.test(k);
  const clientKeys = clientsRes.rows.map((c) => c.client_key);

  // Per-client month plan + metadata (team-lead editable), and auto fact:
  //  weekFact = «Успішно» (142) closed in that week; monthFact = Σ weekFact +
  //  «Оплата отримана» снапшот для клієнта (снапшот недатований → лише в місяць).
  const [plansRes, factRes, snapRes, actRes] = await Promise.all([
    clientKeys.length ? pool.query<{ client_key: string; plan: string; forecast: string | null; realization_pct: string | null; international: boolean | null; we_do: boolean | null; call_link: string | null; comment: string | null; status: string }>(
      `SELECT client_key, plan, forecast, realization_pct, international, we_do, call_link, comment, status
         FROM repeat_client_plans WHERE month = $1 AND client_key = ANY($2)`, [planDate, clientKeys]) : { rows: [] as never[] },
    clientKeys.length ? pool.query<{ client_key: string; cday: number; s: string }>(
      `SELECT d.client_key, EXTRACT(DAY FROM (d.closed_at_kommo ${KYIV}))::int AS cday, COALESCE(SUM(d.price),0) AS s
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage='paid' AND d.status_id=142 AND d.closed_at_kommo IS NOT NULL
          AND (d.closed_at_kommo ${KYIV})::date BETWEEN $1 AND $2 AND d.client_key = ANY($3)
        GROUP BY d.client_key, cday`, [planDate, monthEnd, clientKeys]) : { rows: [] as never[] },
    clientKeys.length ? pool.query<{ client_key: string; s: string }>(
      `SELECT d.client_key, COALESCE(SUM(d.price),0) AS s FROM deals d
        WHERE d.status_id IN (69716460,60412544) AND d.client_key = ANY($1)
        GROUP BY d.client_key`, [clientKeys]) : { rows: [] as never[] },
    // Last real human activity (call/note from syncDealActivity) per client.
    clientKeys.length ? pool.query<{ client_key: string; la: string | null }>(
      `SELECT client_key, MAX(last_activity_at) AS la FROM deals
        WHERE client_key = ANY($1) GROUP BY client_key`, [clientKeys]) : { rows: [] as never[] },
  ]);
  const planByKey = new Map(plansRes.rows.map((p) => [p.client_key, p]));
  const snapByKey = new Map(snapRes.rows.map((x) => [x.client_key, Number(x.s)]));
  const actByKey = new Map((actRes.rows as { client_key: string; la: string | null }[]).map((x) => [x.client_key, x.la]));
  const weekIdxOfDay = (day: number) => { for (let i = 0; i < weeks.length; i++) if (day >= weeks[i].from && day <= weeks[i].to) return i; return weeks.length - 1; };
  const weekFactByKey = new Map<string, number[]>();
  for (const f of factRes.rows) {
    const arr = weekFactByKey.get(f.client_key) ?? weeks.map(() => 0);
    arr[weekIdxOfDay(Number(f.cday))] += Number(f.s);
    weekFactByKey.set(f.client_key, arr);
  }

  type RepeatClient = {
    clientKey: string; clientName: string; isCompany: boolean; identifier: string | null;
    orders: number; revenue: number; lastPaid: string; lastActivity: string | null; inactive: boolean;
    plan: number; fact: number; weekFact: number[]; status: string;
    forecast: string | null; realizationPct: number | null; international: boolean | null;
    weDo: boolean | null; callLink: string | null; comment: string | null;
  };
  const activeCutoffMs = Date.now() - activeMonths * 30 * 24 * 3600 * 1000;
  const clientsByMgr = new Map<number, RepeatClient[]>();
  for (const c of clientsRes.rows) {
    const individual = isPhoneKey(c.client_key);
    const weekFact = weekFactByKey.get(c.client_key) ?? weeks.map(() => 0);
    const p = planByKey.get(c.client_key);
    const list = clientsByMgr.get(c.manager_id) ?? [];
    list.push({
      clientKey: c.client_key,
      clientName: c.name,
      isCompany: !individual,
      identifier: individual ? c.client_key : null,
      orders: Number(c.orders),
      revenue: Number(c.revenue),
      lastPaid: c.last_paid,
      lastActivity: actByKey.get(c.client_key) ?? null,
      inactive: c.last_paid ? new Date(c.last_paid).getTime() < activeCutoffMs : true,
      plan: p ? Number(p.plan) : 0,
      fact: weekFact.reduce((s, v) => s + v, 0) + (snapByKey.get(c.client_key) ?? 0),
      weekFact,
      status: p?.status ?? "none",
      forecast: p?.forecast ?? null,
      realizationPct: p?.realization_pct != null ? Number(p.realization_pct) : null,
      international: p?.international ?? null,
      weDo: p?.we_do ?? null,
      callLink: p?.call_link ?? null,
      comment: p?.comment ?? null,
    });
    clientsByMgr.set(c.manager_id, list);
  }

  const teamsMap = new Map<number, { teamId: number; teamName: string; teamPlan: number; teamFact: number; managers: { managerId: number; name: string; plan: number; fact: number; clients: RepeatClient[] }[] }>();
  let totalPlan = 0, totalFact = 0;
  for (const row of r.rows) {
    const tid = row.team_id ?? 0;
    if (!teamsMap.has(tid)) teamsMap.set(tid, { teamId: tid, teamName: row.team_name ?? "Без команди", teamPlan: 0, teamFact: 0, managers: [] });
    const plan = Number(row.plan);
    const fact = (succM.get(row.id) ?? 0) + (payM.get(row.id) ?? 0);
    const t = teamsMap.get(tid)!;
    t.managers.push({ managerId: row.id, name: row.name, plan, fact, clients: clientsByMgr.get(row.id) ?? [] });
    t.teamPlan += plan; t.teamFact += fact;
    totalPlan += plan; totalFact += fact;
  }

  res.json({
    month: monthStr,
    daysInMonth,
    workingDays,
    weeks,
    teams: Array.from(teamsMap.values()),
    totalPlan, totalFact,
  });
});

/**
 * Save a per-client repeat-plan row (monthly plan + metadata from the КВП sheet:
 * forecast volume, realization %, international y/n, we-do y/n, call link,
 * comment). Admin/team-lead; a team-lead may edit only their own team's clients.
 * The frontend sends the FULL row so the upsert never nulls untouched fields.
 */
dashboardRouter.post("/repeat-client-plan", async (req, res) => {
  const auth = req.auth!;
  const b = req.body ?? {};
  const clientKey = String(b.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const month = ((b.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const managerId = b.managerId != null ? Number(b.managerId) : null;
  // Scope: a manager may edit only their own clients (and their submission needs
  // approval); a team lead only their team; admin anyone.
  if (auth.role === "manager") {
    if (managerId !== auth.managerId) return res.status(403).json({ error: "Лише свої клієнти" });
  } else if (auth.role === "team_lead") {
    if (managerId != null) {
      const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
      if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
    }
  } else if (auth.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  // Manager submission → pending (awaits team-lead approval); team-lead/admin → approved.
  const status = auth.role === "manager" ? "pending" : "approved";
  const num = (v: unknown) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v));
  await pool.query(
    `INSERT INTO repeat_client_plans
       (client_key, month, manager_id, plan, forecast, realization_pct, international, we_do, call_link, comment, status, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (client_key, month) DO UPDATE SET
       manager_id = EXCLUDED.manager_id, plan = EXCLUDED.plan, forecast = EXCLUDED.forecast,
       realization_pct = EXCLUDED.realization_pct, international = EXCLUDED.international, we_do = EXCLUDED.we_do,
       call_link = EXCLUDED.call_link, comment = EXCLUDED.comment, status = EXCLUDED.status,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, month, managerId, num(b.plan) ?? 0, str(b.forecast), num(b.realizationPct), bool(b.international), bool(b.weDo), str(b.callLink), str(b.comment), status, auth.userId]
  );
  res.json({ ok: true, status });
});

/** Team-lead/admin approves (or rejects) a manager-submitted client plan. */
dashboardRouter.post("/repeat-client-plan/approve", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") return res.status(403).json({ error: "Forbidden" });
  const b = req.body ?? {};
  const clientKey = String(b.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const month = ((b.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const status = b.status === "pending" ? "pending" : "approved";
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(
      `SELECT m.team_id FROM repeat_client_plans p LEFT JOIN managers m ON m.id = p.manager_id WHERE p.client_key = $1 AND p.month = $2`,
      [clientKey, month]
    );
    if (chk.rows[0] && chk.rows[0].team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  await pool.query(
    `UPDATE repeat_client_plans SET status = $3, approved_by = $4, approved_at = now()
     WHERE client_key = $1 AND month = $2`,
    [clientKey, month, status, auth.userId]
  );
  res.json({ ok: true, status });
});

/** Read a manager's monthly funnel plan (for the plan editor). Admin/team-lead
 *  only; a team-lead may read only their own team's managers. */
dashboardRouter.get("/funnel-plan", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") return res.status(403).json({ error: "Forbidden" });
  const managerId = Number(req.query.managerId);
  const month = ((req.query.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const r = await pool.query<{ stage: string; planned_value: string }>(
    `SELECT stage, planned_value FROM funnel_plans WHERE manager_id = $1 AND month = $2`,
    [managerId, month]
  );
  const plans: Record<string, number> = {};
  for (const row of r.rows) plans[row.stage] = Number(row.planned_value);
  res.json({ managerId, month, plans });
});

/** Set a manager's monthly funnel plan (team-lead / admin). */
dashboardRouter.post("/funnel-plan", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const managerId = Number(req.body?.managerId);
  const monthRaw = String(req.body?.month ?? "").slice(0, 7);
  const plans = req.body?.plans as Record<string, number> | undefined;
  if (!managerId || !/^\d{4}-\d{2}$/.test(monthRaw) || !plans) {
    return res.status(400).json({ error: "managerId, month (YYYY-MM) та plans обовʼязкові" });
  }
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const month = monthRaw + "-01";
  for (const stage of FUNNEL_ORDER) {
    const value = Number(plans[stage] ?? 0);
    await pool.query(
      `INSERT INTO funnel_plans (manager_id, month, stage, planned_value, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (manager_id, month, stage) DO UPDATE SET
         planned_value = EXCLUDED.planned_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [managerId, month, stage, value, auth.userId]
    );
  }
  res.json({ ok: true });
});
