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

// КРОК 9 Фаза 3: `adDealSql` більше НЕ дублюється тут — єдине джерело `core/metrics.ts`
// (`metrics.adDealSql`). Усі усе ще-інлайнові вжитки (конверсія /conversion,
// /conversion-timeseries, /overview.adConversion, /report.adLeads, /kvp-extra) — це
// свідомо-лишена КОНВЕРСІЯ (КРОК 6, блок В2/В3/В4) + денумератор реклами; логіку не
// чіпаємо, лише централізуємо хелпер.
import { getSettings } from "./settings.js";
import { syncKommo } from "../jobs/syncKommo.js";
import { syncStageEvents } from "../jobs/syncStageEvents.js";
import * as money from "../core/money.js";
import * as metrics from "../core/metrics.js";
import { syncReceivables } from "../jobs/syncReceivables.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/**
 * КРОК 9-conv Фаза 1: агрегує ПОМІСЯЧНИЙ масив конверсії ядра (cohort+period) у
 * період [from,to]. cohort — основне число (стеля ≤100% гарантована ядром);
 * period — вторинний тренд. entered<10 → pct=null (UI показує «—», щоб не плутати
 * «немає реклами» з «нульовою конверсією» — рішення власника).
 */
type ConvMonthly = {
  ym: string; entered: number; mature: boolean;
  wonEventually?: number; wonInMonth?: number; handoffEventually?: number; handoffInMonth?: number;
};
function sumConv(rows: ConvMonthly[], from?: string | null, to?: string | null) {
  const fy = from ? String(from).slice(0, 7) : null;
  const ty = to ? String(to).slice(0, 7) : null;
  const sel = rows.filter((r) => (!fy || r.ym >= fy) && (!ty || r.ym <= ty));
  const s = (k: keyof ConvMonthly) => sel.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const entered = s("entered");
  const pct = (n: number) => (entered >= 10 ? Math.round((n / entered) * 1000) / 10 : null);
  return {
    entered,
    wonCount: s("wonEventually"),      // сира к-ть виграних (для сумісності: adConversion.paid)
    handoffCount: s("handoffEventually"),
    mature: sel.length > 0 && sel[sel.length - 1].mature,
    wonCohort: pct(s("wonEventually")), wonPeriod: pct(s("wonInMonth")),
    handoffCohort: pct(s("handoffEventually")), handoffPeriod: pct(s("handoffInMonth")),
  };
}

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

  // КРОК 9: рероут на канонічне ядро (core/metrics). Той самий предикат/скоуп, що й
  // раніше (усі пайплайни, INNER psm, БЕЗ фільтра is_active) — числа не змінюються.
  // Роут лишає лише мапінг у старі wire-ключі (funnel_stage/deal_count/total_amount).
  const rows = await metrics.funnelByStage({ from, to, managerId, teamId });
  res.json({
    stages: rows.map((r) => ({ funnel_stage: r.stage, deal_count: r.deals, total_amount: r.revenue })),
  });
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
    `SELECT COUNT(*) FILTER (WHERE ${metrics.adDealSql(`$${adSrcIdx}`)}) AS ad_leads,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql(`$${adSrcIdx}`)} AND psm.funnel_stage = 'paid') AS ad_paid
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.pipeline_id = ANY(ARRAY[8921932, 155304])${scopeConds.length ? " AND " + scopeConds.join(" AND ") : ""}`,
    adConvParams
  );
  const adLeadsCnt = Number(adConvRes.rows[0]?.ad_leads ?? 0);
  const adPaidCnt = Number(adConvRes.rows[0]?.ad_paid ?? 0);
  const adConversion = { leads: adLeadsCnt, paid: adPaidCnt, conversion: adLeadsCnt > 0 ? Math.round((adPaidCnt / adLeadsCnt) * 100) : 0 };

  // MASTER_PLAN КРОК 2: гроші анкеряться по ДАТІ ВХОДУ В ЕТАП (deal_stage_events),
  // дедуп по угоді — знімки прибрано (недатований знімок мутував минулі місяці).
  //   received  = «Отримані кошти» = увійшли в етап 9 (Оплата отримана) АБО 10
  //               (Успішна) у періоді, РАЗ (9 і 10 — одні гроші).
  //   success   = лише етап 10 (142) — знаменник avg_check_success_only.
  //   paidOnly  = етап 9 без 142 у періоді → received = success ⊎ paidOnly (disjoint).
  //   expected  = етап 8 «Очікуємо оплату» (НЕ «Виставлення рахунку»!).
  const moneyScope: money.MoneyScope = { from, to, managerId, teamId };
  const [receivedTot, successTot, paidOnlyTot, expectedTot,
         receivedTeamAgg, receivedMgrAgg, expectedTeamAgg, awaitingNow] = await Promise.all([
    money.receivedMoney(moneyScope),
    money.successMoney(moneyScope),
    money.paidOnlyMoney(moneyScope),
    money.expectedMoney(moneyScope),
    money.receivedByTeam(moneyScope),
    money.receivedByMgr(moneyScope),
    money.expectedByTeam(moneyScope),
    money.awaitingNowSnapshot(moneyScope),
  ]);

  // «Отримані кошти» по командах / менеджерах — анкеровані, дедуп (див. moneyScope).
  const byTeam = {
    rows: [...receivedTeamAgg]
      .sort((a, b) => b.revenue - a.revenue)
      .map((x) => ({ team_id: x.teamId, team_name: x.teamName, revenue: String(x.revenue), deals: String(x.deals) })),
  };
  const topManagers = {
    rows: [...receivedMgrAgg]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((x) => ({ manager_id: x.managerId, name: x.name, revenue: String(x.revenue), deals: String(x.deals) })),
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

  // КРОК 9: загальний борг = core/metrics.receivablesTotal (LEFT JOIN — включає
  // неатрибутований борг при адмін-розрізі; скоуп по менеджеру/команді природно
  // виключає null-рядки, тож роль-скоуп не змінюється).
  const receivablesTotalValue = await metrics.receivablesTotal({ managerId, teamId });
  // Готівкова дебіторка з CRM — ОКРЕМА позначка (НЕ в основному тоталі, який 1:1 з таблицею).
  const receivablesCashValue = await metrics.receivablesCash({ managerId, teamId });

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

  // «Отримані кошти» (анкер по даті входу + дедуп): received = success ⊎ paidOnly,
  // тож successRevenue + paymentRevenue === receivedTot.revenue (без подвійного рахунку).
  const successRevenue = successTot.revenue;
  const successDeals = successTot.deals;
  const paymentRevenue = paidOnlyTot.revenue; // «досі в оплаті» (етап 9, ще не 142)
  const paymentDeals = paidOnlyTot.deals;
  const closedRes = {
    rows: [{ revenue: String(receivedTot.revenue), deals: String(receivedTot.deals) }],
  };

  // «Очікування оплат» за ПЕРІОД — анкер по входу в етап 8 «Очікуємо оплату»
  // (НЕ знімок, НЕ «Виставлення рахунку»). Знаменник ОЧІКУВАНОГО чека.
  const pendingRes = {
    rows: [...expectedTeamAgg]
      .sort((a, b) => b.revenue - a.revenue)
      .map((x) => ({ team_id: x.teamId, team_name: x.teamName, deals: String(x.deals), revenue: String(x.revenue) })),
  };

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
  if (from) { trParams.push(from); trConds.push(`(lr.transferred_at AT TIME ZONE 'Europe/Kyiv')::date >= $${trParams.length}`); }
  if (to) { trParams.push(to); trConds.push(`(lr.transferred_at AT TIME ZONE 'Europe/Kyiv')::date <= $${trParams.length}`); }
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
       -- «Реєстр» лідоген-бота — джерело правди для переданих (НЕ lead_transfer_events,
       -- який рахує кожну зміну відповідального і завищує в рази).
       SELECT DISTINCT lr.lead_id AS kommo_id, d.client_key, t.id AS team_id, t.name AS team_name
       FROM leadgen_registry lr
       JOIN deals d ON d.kommo_id = lr.lead_id
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
       FROM leadgen_registry lr
       JOIN deals d ON d.kommo_id = lr.lead_id
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
    dispatched: string;
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
            COUNT(*) FILTER (WHERE psm.funnel_stage IN ('invoiced','paid') OR d.status_id IN (69716300,98470988,10937178)) AS dispatched,
            COUNT(*) FILTER (WHERE psm.funnel_stage = 'paid') AS paid,
            COALESCE(SUM(d.price) FILTER (WHERE psm.funnel_stage = 'paid'), 0) AS revenue,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql("$2")}) AS ad_leads,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql("$2")} AND psm.funnel_stage = 'paid') AS ad_paid,
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
     -- LEFT: немапнуті статуси (АВТО/143) мають рахуватись у created/ad_leads/dispatched
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
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
      // Історія: знімки (оплата/очікувані) не відтворюються заднім числом,
      // тому чисельник — лише «успішно»; знаменник — поставлені машини.
      avgCheck: Number(r.dispatched) > 0 ? Math.round(revenue / Number(r.dispatched)) : 0,
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
  // Анкеровані гроші поточного місяця (незалежно від обраного періоду).
  const projScope: money.MoneyScope = { from: mStartP, to: nowK, managerId, teamId };
  const [succMonth, recvMonth] = await Promise.all([
    money.successMoney(projScope),
    money.receivedMoney(projScope),
  ]);
  const successMTD = succMonth.revenue;
  const paidOnlyMonth = recvMonth.revenue - succMonth.revenue;
  const mS = new Date(mStartP + "T00:00:00");
  const mE = new Date(mS.getFullYear(), mS.getMonth() + 1, 0);
  const tD = new Date(nowK + "T00:00:00");
  const totalWdP = workingDays(mS, mE);
  const elapsedWdP = workingDays(mS, tD < mE ? tD : mE);
  const monthFactP = Math.round(recvMonth.revenue);
  const projected = elapsedWdP > 0 ? Math.round(successMTD * (totalWdP / elapsedWdP) + paidOnlyMonth) : monthFactP;
  const projection = {
    monthFact: monthFactP,
    projected,
    plan: planMonthTotal,
    projectedPct: planMonthTotal > 0 ? Math.round((projected / planMonthTotal) * 100) : null,
    elapsedWorkingDays: elapsedWdP,
    totalWorkingDays: totalWdP,
  };

  // КРОК 9-conv Фаза 1: конверсія — з ЯДРА (core/metrics), стеля ≤100%.
  //   Реклама → conversion_ads (cohort основне, period тренд).
  //   Лідоген → ДВІ окремі: Продзвін + Реактивація (won велике, handoff дрібне).
  // Стару adConversion/leadgenConversion-логіку не видалено (Фаза 3); тут лише
  // перемикаємо, що ВІДДАЄ роут. entered<10 → «—».
  const adsMonthlyOv = await metrics.conversionAdsByMonth({ managerId, teamId }, adSources);
  const pzMonthlyOv = await metrics.conversionProdzvinByMonth({ managerId, teamId });
  const reMonthlyOv = await metrics.conversionReactivationByMonth({ managerId, teamId });
  const adAgg = sumConv(adsMonthlyOv, from, to);
  const pzAgg = sumConv(pzMonthlyOv, from, to);
  const reAgg = sumConv(reMonthlyOv, from, to);
  const adConversionOut = { leads: adAgg.entered, paid: adAgg.wonCount, conversion: adAgg.wonCohort, conversionPeriod: adAgg.wonPeriod, mature: adAgg.mature };
  const prodzvinConversion = { entered: pzAgg.entered, won: pzAgg.wonCohort, wonPeriod: pzAgg.wonPeriod, handoff: pzAgg.handoffCohort, mature: pzAgg.mature };
  const reactivationConversion = { entered: reAgg.entered, won: reAgg.wonCohort, wonPeriod: reAgg.wonPeriod, handoff: reAgg.handoffCohort, mature: reAgg.mature };
  // Спарклайни: adConversion + won-лідоген по місяцях із ядра (перекриваємо старі).
  const adByYm = new Map(adsMonthlyOv.map((r) => [r.ym, r.cohortPct]));
  const pzByYm = new Map(pzMonthlyOv.map((r) => [r.ym, r.wonCohortPct]));
  const reByYm = new Map(reMonthlyOv.map((r) => [r.ym, r.wonCohortPct]));
  for (const h of monthlyHistory) {
    h.adConversion = adByYm.get(h.month) ?? 0;
    (h as Record<string, unknown>).prodzvinWon = pzByYm.get(h.month) ?? 0;
    (h as Record<string, unknown>).reactivationWon = reByYm.get(h.month) ?? 0;
  }

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
    // ДВА середні чеки (складати заборонено): фактичний (received) і очікуваний
    // (етап 8). avgCheckSuccessOnly — лише успіх, для звірки з листом (2600–2900).
    avgCheckSuccessOnly: successDeals > 0 ? Math.round(successRevenue / successDeals) : 0,
    avgCheckReceived: receivedTot.deals > 0 ? Math.round(receivedTot.revenue / receivedTot.deals) : 0,
    avgCheckExpected: expectedTot.deals > 0 ? Math.round(expectedTot.revenue / expectedTot.deals) : 0,
    expectedPayments: { deals: expectedTot.deals, revenue: expectedTot.revenue },
    // Знімок «станом на зараз» (етапи 8+9 зараз) — прогноз, НІКОЛИ не у виручці періоду.
    awaitingNow: { asOf: "now", deals: awaitingNow.deals, revenue: awaitingNow.revenue, byTeam: awaitingNow.byTeam },
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
    // Правило №1 (словник): «Поставлені машини» = угоди, що ПЕРЕЙШЛИ в «Успішно
    // реалізовано» в періоді — той самий якір, що й дохід. Снапшот-проксі видалено.
    dispatchedCount: successDeals,
    createdByStage,
    carryover,
    repeatClientsList,
    newClientsList,
    newClientsBySource,
    transferred,
    // КРОК 9-conv Фаза 1: реклама з ядра (cohort, стеля ≤100%).
    adConversion: adConversionOut,
    // ДВІ лідоген-плитки з ядра (won велике, handoff дрібне; рішення власника).
    prodzvinConversion,
    reactivationConversion,
    // Стара «конверсія лідогену» (передана заявка→успіх) — лишена для Фази 3.
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
    receivablesTotal: receivablesTotalValue,
    receivablesCash: receivablesCashValue,
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
  const adCase = `CASE WHEN ${metrics.adDealSql(`$${params.length}`)} THEN 'ad' ELSE 'other' END`;

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

  // КРОК 9-conv Фаза 1: рядок «ad» — конверсія з ЯДРА (conversion_ads, cohort,
  // стеля ≤100%). Рядок «other» (створені вручну) — на старому (не одна з 3 нових).
  const adAggConv = sumConv(await metrics.conversionAdsByMonth({ managerId, teamId }, adSources), from, to);

  const channels = ["ad", "other"].map((ch) => {
    const row = result.rows.find((r) => r.lead_channel === ch);
    const leads = Number(row?.leads ?? 0);
    const paid = Number(row?.paid ?? 0);
    return {
      channel: ch,
      label: labels[ch],
      leads: ch === "ad" ? adAggConv.entered : leads,
      // ad: paid = сира к-ть виграних когорти (щоб leads/paid узгоджувалось із cohort%).
      paid: ch === "ad" ? adAggConv.wonCount : paid,
      paidAmount: Number(row?.paid_amount ?? 0),
      conversion: ch === "ad" ? adAggConv.wonCohort : (leads > 0 ? Math.round((paid / leads) * 100) : 0),
      conversionPeriod: ch === "ad" ? adAggConv.wonPeriod : undefined,
      mature: ch === "ad" ? adAggConv.mature : undefined,
    };
  });

  res.json({ channels });
});

/**
 * Динаміка конверсії в часі (по днях/тижнях/місяцях) — для графіка тренду в Звіті.
 * Когорта = угоди повного циклу, СТВОРЕНІ у бакеті; «конвертована» = клієнт угоди
 * дійшов до оплаченої угоди повного циклу (крос-пайплайн, як у /conversion).
 * Скоуп: manager/team (роль-обмежений). Опційно розріз реклама vs інше.
 */
dashboardRouter.get("/conversion-timeseries", async (req, res) => {
  const auth = req.auth!;
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const gran = req.query.granularity === "month" ? "month" : req.query.granularity === "day" ? "day" : "week";
  const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth() - 2, 1).toISOString().slice(0, 10);
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") teamId = auth.teamId;

  const { adSources } = await getSettings();
  const params: unknown[] = [from, to, adSources];
  const conds = [
    "d.pipeline_id = ANY(ARRAY[8921932, 155304])",
    `(d.created_at_kommo ${KYIV})::date BETWEEN $1 AND $2`,
  ];
  if (managerId) { params.push(managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }

  const r = await pool.query<{ bucket: string; leads: string; paid: string; ad_leads: string; ad_paid: string }>(
    `WITH paid_clients AS (
       SELECT DISTINCT d.client_key FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     )
     SELECT to_char(date_trunc('${gran}', (d.created_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket,
            COUNT(*) AS leads,
            COUNT(*) FILTER (WHERE d.client_key IN (SELECT client_key FROM paid_clients)) AS paid,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql("$3")}) AS ad_leads,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql("$3")} AND d.client_key IN (SELECT client_key FROM paid_clients)) AS ad_paid
       FROM deals d JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")}
      GROUP BY 1 ORDER BY 1`,
    params
  );
  // КРОК 9-conv Фаза 1: лінія «Конверсія реклами» — з ЯДРА (conversion_ads,
  // помісячний cohort, стеля ≤100%). Кожен бакет мапиться на cohort свого місяця
  // (для day/week — сходинками по місяцю; це чесна помісячна роздільність когорти).
  // Лінія «Загальна конверсія» (points.conversion) — на старому (full-cycle, В4).
  const adsTsByYm = new Map(
    (await metrics.conversionAdsByMonth({ managerId, teamId }, adSources)).map((m) => [m.ym, m.cohortPct])
  );
  const points = r.rows.map((x) => {
    const leads = Number(x.leads), paid = Number(x.paid), adLeads = Number(x.ad_leads), adPaid = Number(x.ad_paid);
    return {
      bucket: x.bucket, leads, paid,
      conversion: leads > 0 ? Math.round((paid / leads) * 100) : 0,
      adLeads, adPaid,
      adConversion: adsTsByYm.get(x.bucket.slice(0, 7)) ?? null,
    };
  });
  res.json({ from, to, granularity: gran, points });
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
  }
  for (const r of planResult.rows) {
    const row = getOrInit(r.manager_id, r.week_start, r.metric);
    row.plan = Number(r.planned_value);
  }
  // КРОК 2: payment_amount ФАКТ = «Отримані кошти» по тижнях (анкер по даті входу в
  // етап 9∪10 + дедуп), а НЕ created-cohort знімок funnel_stage='paid' (той мутував:
  // минулі тижні росли, коли угоди доходили до оплати). Сума тижнів = місячний received.
  const recvWeeks = await money.receivedByManagerWeek(managerIds, monthStart);
  for (const r of recvWeeks) getOrInit(r.managerId, r.weekStart, "payment_amount").fact += r.revenue;

  // «Очікування оплат» = вхід у етап 8 «Очікуємо оплату» в місяці (анкер по даті
  // входу, НЕ знімок і НЕ «Виставлення рахунку»). Core/money.ts.
  const [expY, expM] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(expY, expM, 0)).toISOString().slice(0, 10);
  const expList = await money.expectedByMgr({ teamId, from: monthStart, to: monthEnd });
  const expByMgr = new Map(expList.map((x) => [x.managerId, x.revenue]));

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
  // Ручні правки адміна: прибрати / передати іншому менеджеру / примусово постійний.
  const overrides = await loadLoyaltyOverrides();

  const byManager = new Map<
    number,
    { managerId: number; managerName: string; segments: Segments }
  >();
  const ensureEntry = (id: number, name: string) => {
    let e = byManager.get(id);
    if (!e) { e = { managerId: id, managerName: name, segments: { regular: [], occasional: [], sleeping: [], lost: [] } }; byManager.set(id, e); }
    return e;
  };

  for (const row of result.rows) {
    const ov = overrides.get(row.client_key);
    if (ov?.hidden) continue; // прибраний адміном — не показуємо ніде
    const recent = Number(row.p_recent);
    const prior = Number(row.p_prior);
    // Передача: якщо адмін закріпив клієнта за іншим менеджером — переносимо туди
    // (з можливим переходом в іншу команду). Скоуп: у режимі команди показуємо,
    // лише якщо цільова команда збігається / без фільтра.
    let mgrId = row.manager_id, mgrName = row.manager_name;
    if (ov?.pinnedManagerId) {
      if (teamId && ov.pinnedTeamId && ov.pinnedTeamId !== teamId && row.manager_id !== null) {
        // передано в іншу команду, а зараз дивимось конкретну — пропускаємо, якщо
        // клієнт «пішов» з цієї команди (його вихідний менеджер у цій команді).
      }
      mgrId = ov.pinnedManagerId;
      mgrName = ov.pinnedManagerName ?? row.manager_name;
    }
    const entry = ensureEntry(mgrId, mgrName);
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
    if (ov?.forceRegular || (totalPaid >= threshold && isActive)) {
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

  // КРОК 9: борг рахує core/metrics.receivablesByClient (LEFT JOIN — неатрибутований
  // борг БІЛЬШЕ не ховається; при адмін-розрізі додається група «Без менеджера»,
  // managerId=null — свідома зміна, рішення власника 15.07). Скоуп по менеджеру/
  // команді природно виключає null-рядки. Роут добудовує форму (не метрику): нотатки
  // тімліда (receivable_notes) + syncedAt + групування менеджер→клієнти.
  const rows = await metrics.receivablesByClient({ managerId, teamId });

  const clientKeys = rows.map((r) => r.clientKey).filter((k): k is string => k != null);
  const notesRes = clientKeys.length
    ? await pool.query<{ client_key: string; comment: string | null; due_date: string | null }>(
        `SELECT client_key, comment, to_char(due_date, 'YYYY-MM-DD') AS due_date
           FROM receivable_notes WHERE client_key = ANY($1)`,
        [clientKeys]
      )
    : { rows: [] as { client_key: string; comment: string | null; due_date: string | null }[] };
  const notes = new Map(notesRes.rows.map((n) => [n.client_key, n]));
  const syncRes = await pool.query<{ synced_at: string | null }>(
    `SELECT MAX(synced_at) AS synced_at FROM receivables`
  );
  const syncedAt = syncRes.rows[0]?.synced_at ?? null;

  type Client = {
    clientKey: string | null; clientName: string | null; amount: number;
    limitDays: number | null; overdueDays: number | null; comment: string | null; dueDate: string | null;
  };
  const byManager = new Map<number | null, { managerId: number | null; managerName: string; clients: Client[]; total: number }>();
  for (const r of rows) {
    let entry = byManager.get(r.managerId);
    if (!entry) { entry = { managerId: r.managerId, managerName: r.managerName, clients: [], total: 0 }; byManager.set(r.managerId, entry); }
    const n = r.clientKey ? notes.get(r.clientKey) : undefined;
    entry.clients.push({
      clientKey: r.clientKey, clientName: r.clientName, amount: r.amount,
      limitDays: r.limitDays, overdueDays: r.overdueDays,
      comment: n?.comment ?? null, dueDate: n?.due_date ?? null,
    });
    entry.total += r.amount;
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

  const r = await pool.query<{ invoice_no: string | null; invoice_date: string | null; amount: string; service_url: string | null; note: string | null; due_date: string | null; inv_comment: string | null }>(
    `SELECT ri.invoice_no, to_char(ri.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            ri.amount, ri.service_url, ri.note,
            to_char(nn.due_date, 'YYYY-MM-DD') AS due_date, nn.comment AS inv_comment
     FROM receivable_invoices ri
     LEFT JOIN managers m ON m.id = ri.manager_id
     LEFT JOIN receivable_invoice_notes nn
            ON nn.client_key = ri.client_key AND nn.invoice_no = COALESCE(ri.invoice_no, '')
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
      dueDate: x.due_date,
      comment: x.inv_comment,
    })),
  });
});

/**
 * Дедлайн оплати + коментар до КОНКРЕТНОГО рахунку дебіторки. Менеджер ставить
 * по СВОЇХ клієнтах, тімлід — по команді, адмін — по всіх. Якщо дедлайн минув,
 * а рахунок досі неоплачений — щоденний джоб створює менеджеру задачу
 * «отримати оплату» (див. jobs/receivableDeadlineTasks).
 */
dashboardRouter.put("/receivables/invoice-note", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const invoiceNo = String(req.body?.invoiceNo ?? "").trim();
  if (!clientKey || !invoiceNo) return res.status(400).json({ error: "clientKey та invoiceNo обовʼязкові" });

  // Право редагувати: рахунок має належати менеджеру / команді тімліда.
  const conds = ["ri.client_key = $1", "COALESCE(ri.invoice_no,'') = $2"];
  const p: unknown[] = [clientKey, invoiceNo];
  if (auth.role === "manager") { p.push(auth.managerId); conds.push(`ri.manager_id = $${p.length}`); }
  else if (auth.role === "team_lead") { p.push(auth.teamId); conds.push(`m.team_id = $${p.length}`); }
  const own = await pool.query(
    `SELECT 1 FROM receivable_invoices ri LEFT JOIN managers m ON m.id = ri.manager_id
     WHERE ${conds.join(" AND ")} LIMIT 1`, p);
  if (!own.rowCount) return res.status(403).json({ error: "Немає доступу до цього рахунку" });

  const dueDate = req.body?.dueDate ? String(req.body.dueDate).slice(0, 10) : null;
  const comment = req.body?.comment != null ? String(req.body.comment) : null;
  await pool.query(
    `INSERT INTO receivable_invoice_notes (client_key, invoice_no, due_date, comment, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (client_key, invoice_no) DO UPDATE SET
       due_date = EXCLUDED.due_date, comment = EXCLUDED.comment,
       -- зміна дедлайну знімає анти-дубль, щоб нова прострочка знову створила задачу
       task_created_at = CASE WHEN receivable_invoice_notes.due_date IS DISTINCT FROM EXCLUDED.due_date
                              THEN NULL ELSE receivable_invoice_notes.task_created_at END,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, invoiceNo, dueDate, comment, auth.userId]
  );
  res.json({ ok: true });
});

// ── Реактивація клієнтів (сплячі/втрачені → в роботу менеджеру) ─────────────
/** Роль-скоуп списку реактивації: менеджер — свої, тімлід — команда, адмін — усі. */
dashboardRouter.get("/reactivation", async (req, res) => {
  const auth = req.auth!;
  const conds: string[] = [];
  const params: unknown[] = [];
  if (auth.role === "manager") { params.push(auth.managerId); conds.push(`rc.manager_id = $${params.length}`); }
  else if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`m.team_id = $${params.length}`); }
  else {
    if (req.query.teamId) { params.push(Number(req.query.teamId)); conds.push(`m.team_id = $${params.length}`); }
  }
  if (req.query.managerId) { params.push(Number(req.query.managerId)); conds.push(`rc.manager_id = $${params.length}`); }

  const r = await pool.query<{
    client_key: string; client_name: string; manager_id: number; manager_name: string;
    category: string | null; plan: string; contact1_date: string | null; contact1_result: string | null;
    contact2_date: string | null; contact2_result: string | null; status: string; comment: string | null;
    added_at: string; fact: string; fact_deals: string; last_paid: string | null;
  }>(
    `SELECT rc.client_key, rc.client_name, rc.manager_id, m.name AS manager_name,
            rc.category, rc.plan,
            to_char(rc.contact1_date, 'YYYY-MM-DD') AS contact1_date, rc.contact1_result,
            to_char(rc.contact2_date, 'YYYY-MM-DD') AS contact2_date, rc.contact2_result,
            rc.status, rc.comment, rc.added_at,
            -- Факт = отримані кошти від клієнта ПІСЛЯ взяття в реактивацію:
            -- «Успішно» (142), закриті після added_at + «Оплата отримана» (снапшот).
            COALESCE(f.fact, 0) AS fact, COALESCE(f.fact_deals, 0) AS fact_deals,
            to_char(lp.last_paid, 'YYYY-MM-DD') AS last_paid
     FROM reactivation_clients rc
     JOIN managers m ON m.id = rc.manager_id
     LEFT JOIN LATERAL (
       SELECT SUM(d.price) AS fact, COUNT(*) AS fact_deals
       FROM deals d
       WHERE d.client_key = rc.client_key
         AND ((d.status_id = 142 AND d.closed_at_kommo >= rc.added_at)
              OR d.status_id IN (69716460, 60412544))
     ) f ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(d.created_at_kommo) AS last_paid
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.client_key = rc.client_key AND psm.funnel_stage = 'paid'
     ) lp ON TRUE
     ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
     ORDER BY rc.status = 'in_progress' DESC, rc.added_at DESC`,
    params
  );
  res.json({
    clients: r.rows.map((x) => ({
      clientKey: x.client_key, clientName: x.client_name,
      managerId: x.manager_id, managerName: x.manager_name,
      category: x.category, plan: Number(x.plan),
      contact1Date: x.contact1_date, contact1Result: x.contact1_result,
      contact2Date: x.contact2_date, contact2Result: x.contact2_result,
      status: x.status, comment: x.comment, addedAt: x.added_at,
      fact: Number(x.fact), factDeals: Number(x.fact_deals), lastPaid: x.last_paid,
    })),
  });
});

/** Додати клієнта в реактивацію (тімлід — менеджеру СВОЄЇ команди, адмін — будь-кому). */
dashboardRouter.post("/reactivation", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "team_lead" && auth.role !== "admin") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const clientName = String(req.body?.clientName ?? "").trim();
  const managerId = Number(req.body?.managerId);
  const category = req.body?.category === "lost" ? "lost" : "sleeping";
  if (!clientKey || !clientName || !managerId) {
    return res.status(400).json({ error: "clientKey, clientName і managerId обовʼязкові" });
  }
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Менеджер не з вашої команди" });
  }
  await pool.query(
    `INSERT INTO reactivation_clients (client_key, client_name, manager_id, category, added_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_key) DO UPDATE SET
       manager_id = EXCLUDED.manager_id, category = EXCLUDED.category,
       updated_by = EXCLUDED.added_by, updated_at = now()`,
    [clientKey, clientName, managerId, category, auth.userId]
  );
  res.json({ ok: true });
});

/** Оновити робочі поля реактивації (план, контакти→результати, статус, коментар). */
dashboardRouter.put("/reactivation", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });

  // Право: менеджер — свій клієнт; тімлід — команда; адмін — усі.
  const conds = ["rc.client_key = $1"];
  const p: unknown[] = [clientKey];
  if (auth.role === "manager") { p.push(auth.managerId); conds.push(`rc.manager_id = $${p.length}`); }
  else if (auth.role === "team_lead") { p.push(auth.teamId); conds.push(`m.team_id = $${p.length}`); }
  const own = await pool.query(
    `SELECT 1 FROM reactivation_clients rc JOIN managers m ON m.id = rc.manager_id
     WHERE ${conds.join(" AND ")} LIMIT 1`, p);
  if (!own.rowCount) return res.status(403).json({ error: "Немає доступу до цього клієнта" });

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const b = req.body ?? {};
  if ("plan" in b) set("plan", Number(b.plan) || 0);
  if ("contact1Date" in b) set("contact1_date", b.contact1Date ? String(b.contact1Date).slice(0, 10) : null);
  if ("contact1Result" in b) set("contact1_result", b.contact1Result != null ? String(b.contact1Result) : null);
  if ("contact2Date" in b) set("contact2_date", b.contact2Date ? String(b.contact2Date).slice(0, 10) : null);
  if ("contact2Result" in b) set("contact2_result", b.contact2Result != null ? String(b.contact2Result) : null);
  if ("status" in b && ["in_progress", "reactivated", "refused"].includes(String(b.status))) set("status", String(b.status));
  if ("comment" in b) set("comment", b.comment != null ? String(b.comment) : null);
  if ("managerId" in b && (auth.role === "team_lead" || auth.role === "admin")) {
    const mid = Number(b.managerId);
    if (auth.role === "team_lead") {
      const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [mid]);
      if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Менеджер не з вашої команди" });
    }
    set("manager_id", mid);
  }
  if (!sets.length) return res.status(400).json({ error: "Немає полів для оновлення" });
  set("updated_by", auth.userId);
  vals.push(clientKey);
  await pool.query(
    `UPDATE reactivation_clients SET ${sets.join(", ")}, updated_at = now() WHERE client_key = $${vals.length}`,
    vals
  );
  res.json({ ok: true });
});

/**
 * «Постійні від лідогену» — накопичений ефект лідогенераторів за ВЕСЬ час:
 * клієнти з лідоген-дотиком (угода повного циклу з каналом leadgen), які після
 * першого дотику зробили 2+ оплачені угоди (= стали постійними), і скільки
 * грошей принесли ПІСЛЯ дотику. Безіменні клієнти («Название не указано»)
 * виключені — під одним ключем злипаються сотні різних клієнтів.
 */
dashboardRouter.get("/leadgen-regulars", async (_req, res) => {
  const r = await pool.query<{
    touched: string; paid_once: string; paid_once_sum: string;
    regulars: string; regulars_new: string; regulars_react: string;
    revenue_after: string; revenue_new: string; revenue_react: string;
    lifetime: string; pays_after: string;
  }>(
    `WITH junk AS (
       SELECT DISTINCT client_key FROM deals
       WHERE client_name ILIKE '%название не указано%' OR client_name ILIKE '%назва не вказана%'
     ),
     lg_first AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_lg
       FROM deals d
       WHERE d.pipeline_id IN (8921932, 155304) AND d.lead_channel = 'leadgen'
         AND d.client_key IS NOT NULL
         AND d.client_key NOT IN (SELECT client_key FROM junk)
       GROUP BY d.client_key
     ),
     paid AS (
       SELECT d.client_key, d.created_at_kommo, d.price
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.pipeline_id IN (8921932, 155304) AND psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     ),
     agg AS (
       SELECT lf.client_key,
         COUNT(p.*) FILTER (WHERE p.created_at_kommo < lf.first_lg)  AS before_n,
         COUNT(p.*) FILTER (WHERE p.created_at_kommo >= lf.first_lg) AS after_n,
         COALESCE(SUM(p.price) FILTER (WHERE p.created_at_kommo >= lf.first_lg), 0) AS after_sum,
         COALESCE(SUM(p.price), 0) AS life_sum
       FROM lg_first lf LEFT JOIN paid p ON p.client_key = lf.client_key
       GROUP BY lf.client_key
     )
     SELECT COUNT(*) AS touched,
       COUNT(*) FILTER (WHERE after_n = 1) AS paid_once,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n = 1), 0) AS paid_once_sum,
       COUNT(*) FILTER (WHERE after_n >= 2) AS regulars,
       COUNT(*) FILTER (WHERE after_n >= 2 AND before_n = 0) AS regulars_new,
       COUNT(*) FILTER (WHERE after_n >= 2 AND before_n > 0) AS regulars_react,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n >= 2), 0) AS revenue_after,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n >= 2 AND before_n = 0), 0) AS revenue_new,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n >= 2 AND before_n > 0), 0) AS revenue_react,
       COALESCE(SUM(life_sum) FILTER (WHERE after_n >= 2), 0) AS lifetime,
       COALESCE(SUM(after_n) FILTER (WHERE after_n >= 2), 0) AS pays_after
     FROM agg`
  );
  const x = r.rows[0];
  const regulars = Number(x?.regulars ?? 0);
  const paysAfter = Number(x?.pays_after ?? 0);
  const revenueAfter = Number(x?.revenue_after ?? 0);
  res.json({
    touched: Number(x?.touched ?? 0),
    paidOnce: Number(x?.paid_once ?? 0),
    paidOnceSum: Number(x?.paid_once_sum ?? 0),
    regulars,
    regularsNew: Number(x?.regulars_new ?? 0),
    regularsReact: Number(x?.regulars_react ?? 0),
    revenueAfter,
    revenueNew: Number(x?.revenue_new ?? 0),
    revenueReact: Number(x?.revenue_react ?? 0),
    lifetime: Number(x?.lifetime ?? 0),
    avgPays: regulars > 0 ? Math.round((paysAfter / regulars) * 10) / 10 : 0,
    avgCheck: paysAfter > 0 ? Math.round(revenueAfter / paysAfter) : 0,
  });
});

/** Прибрати клієнта з реактивації (тімлід — своєї команди, адмін — будь-кого). */
dashboardRouter.delete("/reactivation/:clientKey", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "team_lead" && auth.role !== "admin") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const clientKey = String(req.params.clientKey ?? "").trim();
  if (auth.role === "team_lead") {
    const chk = await pool.query(
      `SELECT 1 FROM reactivation_clients rc JOIN managers m ON m.id = rc.manager_id
       WHERE rc.client_key = $1 AND m.team_id = $2`, [clientKey, auth.teamId]);
    if (!chk.rowCount) return res.status(403).json({ error: "Клієнт не у вашій команді" });
  }
  await pool.query(`DELETE FROM reactivation_clients WHERE client_key = $1`, [clientKey]);
  res.json({ ok: true });
});

// Team ranking: per-team revenue (success+payment), deals, avg check,
// conversion and receivables for the selected period.
dashboardRouter.get("/teams", async (req, res) => {
  // Team ranking compares teams — a manager must never see other teams.
  if (req.auth!.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  // КРОК 2: гроші з core/money.ts (анкер по даті входу + дедуп). revenue = received
  // (етап 9∪10); avgCheck — success-only (142). Знімки прибрано.
  const teamScope: money.MoneyScope = { from, to };
  const [recvTeamAgg, sucTeamAgg, recvMgrAgg, sucMgrAgg] = await Promise.all([
    money.receivedByTeam(teamScope),
    money.successByTeam(teamScope),
    money.receivedByMgr(teamScope),
    money.successByMgr(teamScope),
  ]);
  const lc: string[] = [];
  const lp: unknown[] = [];
  if (from) { lp.push(from); lc.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${lp.length}`); }
  if (to) { lp.push(to); lc.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${lp.length}`); }
  // Словник §2: знаменник БЕЗ INNER psm (немапнуті не зникають), база — повний цикл.
  const conv = await pool.query<{ tid: number; leads: string; paid: string }>(
    `SELECT t.id AS tid, COUNT(*) AS leads, COUNT(*) FILTER (WHERE psm.funnel_stage='paid') AS paid
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.pipeline_id IN (8921932,155304) ${lc.length ? "AND " + lc.join(" AND ") : ""} GROUP BY t.id`,
    lp
  );
  // КРОК 9 Фаза 3: борг по командах і менеджерах — з core/metrics.receivablesByManager
  // (єдине джерело; прибрано 2 інлайн SUM(receivables)). Неатрибутований борг (teamId/
  // managerId = null) у /teams НЕ показується — так само, як стара логіка (немає команди
  // → немає рядка), тож числа команд ідентичні; «Без менеджера» видно лише в /overview
  // та /receivables.
  const debtByMgr = await metrics.receivablesByManager({});
  const teamDebt = new Map<number, number>();
  for (const d of debtByMgr) if (d.teamId != null) teamDebt.set(d.teamId, (teamDebt.get(d.teamId) || 0) + d.debt);


  // Per-manager breakdown for the team drill-down: revenue (success+payment),
  // deals, the month's plan and receivables — one row per active manager.
  const planMonth = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const mPlan = await pool.query<{ id: number; name: string; tid: number; plan: string }>(
    `SELECT m.id, m.name, m.team_id AS tid, SUM(p.planned_value) AS plan
     FROM plans p JOIN managers m ON m.id = p.manager_id AND m.is_active
     WHERE p.metric = 'payment_amount' AND p.plan_date = $1 GROUP BY m.id, m.name, m.team_id`,
    [planMonth]
  );
  type MgrRow = { id: number; name: string; teamId: number; revenue: number; deals: number; plan: number; receivables: number; expected: number; dispatched: number; successRev: number };
  const mmap = new Map<number, MgrRow>();
  const mget = (id: number, tid: number | null, name: string): MgrRow => {
    let e = mmap.get(id);
    if (!e) { e = { id, name, teamId: tid ?? 0, revenue: 0, deals: 0, plan: 0, receivables: 0, expected: 0, dispatched: 0, successRev: 0 }; mmap.set(id, e); }
    if (name) e.name = name;
    if (tid) e.teamId = tid;
    return e;
  };
  // revenue/deals = received (анкер+дедуп); dispatched/successRev = success-only (avgCheck).
  for (const r of recvMgrAgg) { const e = mget(r.managerId, r.teamId, r.name); e.revenue += r.revenue; e.deals += r.deals; }
  for (const r of sucMgrAgg) { const e = mget(r.managerId, r.teamId, r.name); e.dispatched += r.deals; e.successRev += r.revenue; }
  for (const r of mPlan.rows) { mget(r.id, r.tid, r.name).plan += Number(r.plan); }
  for (const d of debtByMgr) { if (d.managerId != null) { const e = mmap.get(d.managerId); if (e) e.receivables += d.debt; } }

  const map = new Map<number, { teamId: number; teamName: string; revenue: number; deals: number; leads: number; paid: number; receivables: number; expected: number; dispatched: number; successRev: number }>();
  const get = (id: number, name?: string) => {
    let e = map.get(id);
    if (!e) { e = { teamId: id, teamName: name ?? "", revenue: 0, deals: 0, leads: 0, paid: 0, receivables: 0, expected: 0, dispatched: 0, successRev: 0 }; map.set(id, e); }
    if (name) e.teamName = name;
    return e;
  };
  for (const r of recvTeamAgg) { const e = get(r.teamId, r.teamName); e.revenue += r.revenue; e.deals += r.deals; }
  for (const r of sucTeamAgg) { const e = get(r.teamId, r.teamName); e.dispatched += r.deals; e.successRev += r.revenue; }
  for (const r of conv.rows) { const e = get(r.tid); e.leads += Number(r.leads); e.paid += Number(r.paid); }
  for (const [tid, debt] of teamDebt) { get(tid).receivables += debt; }

  const teams = [...map.values()]
    // Drop teams with no activity in the period (they leak in via the payment /
    // receivables snapshots) — they showed up as empty rows like "7 —".
    .filter((e) => e.revenue > 0 || e.deals > 0 || e.leads > 0 || e.receivables > 0)
    .map((e) => ({
      teamId: e.teamId,
      teamName: e.teamName,
      revenue: e.revenue,
      deals: e.deals,
      // ПРОМТ 0.9: один якір — успішна виручка ÷ машини (без снапшотів).
      avgCheck: e.dispatched > 0 ? Math.round(e.successRev / e.dispatched) : 0,
      conversion: e.leads > 0 ? Math.round((e.paid / e.leads) * 100) : 0,
      receivables: e.receivables,
      managers: [...mmap.values()]
        .filter((m) => m.teamId === e.teamId && (m.revenue > 0 || m.deals > 0 || m.plan > 0 || m.receivables > 0))
        .map((m) => ({
          id: m.id,
          name: m.name,
          revenue: m.revenue,
          deals: m.deals,
          avgCheck: m.dispatched > 0 ? Math.round(m.successRev / m.dispatched) : 0,
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
// ── Ручні правки постійних клієнтів (лише адмін) ───────────────────────────
/** Список активних оверрайдів + довідник менеджерів для UI. */
dashboardRouter.get("/loyalty-overrides", async (req, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  const r = await pool.query<{ client_key: string; client_name: string | null; hidden: boolean; pinned_manager_id: number | null; force_regular: boolean; note: string | null; manager_name: string | null; updated_at: string }>(
    `SELECT o.client_key, o.client_name, o.hidden, o.pinned_manager_id, o.force_regular, o.note,
            m.name AS manager_name, o.updated_at
     FROM loyalty_overrides o LEFT JOIN managers m ON m.id = o.pinned_manager_id
     ORDER BY o.updated_at DESC`
  );
  res.json({
    overrides: r.rows.map((x) => ({
      clientKey: x.client_key, clientName: x.client_name,
      hidden: x.hidden, pinnedManagerId: x.pinned_manager_id, pinnedManagerName: x.manager_name,
      forceRegular: x.force_regular, note: x.note, updatedAt: x.updated_at,
    })),
  });
});

/** Прибрати / передати / додати постійного клієнта (upsert). */
dashboardRouter.post("/loyalty-override", async (req, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const clientName = req.body?.clientName != null ? String(req.body.clientName) : null;
  const hidden = req.body?.hidden === true;
  const forceRegular = req.body?.forceRegular === true;
  const pinnedManagerId = req.body?.pinnedManagerId != null && req.body.pinnedManagerId !== ""
    ? Number(req.body.pinnedManagerId) : null;
  const note = req.body?.note != null ? String(req.body.note) : null;
  await pool.query(
    `INSERT INTO loyalty_overrides (client_key, client_name, hidden, pinned_manager_id, force_regular, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (client_key) DO UPDATE SET
       client_name = COALESCE(EXCLUDED.client_name, loyalty_overrides.client_name),
       hidden = EXCLUDED.hidden, pinned_manager_id = EXCLUDED.pinned_manager_id,
       force_regular = EXCLUDED.force_regular, note = EXCLUDED.note,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, clientName, hidden, pinnedManagerId, forceRegular, note, req.auth!.userId]
  );
  res.json({ ok: true });
});

/** Скасувати ручну правку (повернути авто-логіку). */
dashboardRouter.delete("/loyalty-override/:clientKey", async (req, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  await pool.query(`DELETE FROM loyalty_overrides WHERE client_key = $1`, [String(req.params.clientKey)]);
  res.json({ ok: true });
});

/** Мапа оверрайдів постійних + імена pinned-менеджерів (для застосування). */
async function loadLoyaltyOverrides(): Promise<Map<string, { hidden: boolean; pinnedManagerId: number | null; pinnedManagerName: string | null; pinnedTeamId: number | null; forceRegular: boolean }>> {
  const r = await pool.query<{ client_key: string; hidden: boolean; pinned_manager_id: number | null; force_regular: boolean; manager_name: string | null; team_id: number | null }>(
    `SELECT o.client_key, o.hidden, o.pinned_manager_id, o.force_regular, m.name AS manager_name, m.team_id
     FROM loyalty_overrides o LEFT JOIN managers m ON m.id = o.pinned_manager_id`
  );
  const map = new Map<string, { hidden: boolean; pinnedManagerId: number | null; pinnedManagerName: string | null; pinnedTeamId: number | null; forceRegular: boolean }>();
  for (const x of r.rows) map.set(x.client_key, {
    hidden: x.hidden, pinnedManagerId: x.pinned_manager_id, pinnedManagerName: x.manager_name,
    pinnedTeamId: x.team_id, forceRegular: x.force_regular,
  });
  return map;
}

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
  const ov = await loadLoyaltyOverrides();
  res.json({
    clients: r.rows
      .filter((x) => !ov.get(x.client_key)?.hidden) // прибрані адміном не показуємо
      .map((x) => {
        const individual = isPhoneKey(x.client_key);
        return {
          clientKey: x.client_key,
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
 * Середній час опрацювання заявки: від появи ліда в Кваліфікації (дата створення)
 * до моменту, коли менеджер ВЗЯВ відповідального (перша подія
 * entity_responsible_changed = lead_transfer_events). Розбито за часом ПРИХОДУ
 * заявки (за Києвом): робочий 9–18, вечір 18–21, ніч 21–9, вихідний. Роль-скоуп.
 */
dashboardRouter.get("/response-time", async (req, res) => {
  const auth = req.auth!;
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const from = (req.query.from as string) || new Date().toISOString().slice(0, 8) + "01";
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") teamId = auth.teamId;

  // КРОК 9: рероут на core/metrics.responseTime (означення й числа ідентичні). Роут
  // лишає презентаційну форму: підписи/підказки бакетів + луна from/to у відповіді.
  const rt = await metrics.responseTime({ from, to, managerId, teamId });
  const LABELS: Record<string, { label: string; hint: string }> = {
    work: { label: "🟢 Робочий (9–18)", hint: "Заявки, що надійшли в робочий час пн–пт 9:00–18:00" },
    evening: { label: "🟡 Вечір (18–21)", hint: "Заявки пн–пт 18:00–21:00" },
    night: { label: "🌙 Ніч (21–9)", hint: "Заявки пн–пт 21:00–09:00" },
    weekend: { label: "🔴 Вихідний", hint: "Заявки в суботу/неділю" },
  };
  res.json({
    from, to,
    buckets: rt.buckets.map((b) => ({
      key: b.key, label: LABELS[b.key]?.label ?? b.key, hint: LABELS[b.key]?.hint ?? "",
      count: b.count, avgMin: b.avgMin, medianMin: b.medianMin, immediatePct: b.immediatePct,
    })),
    totalCount: rt.totalCount,
    overallMedianMin: rt.overallMedianMin,
    overallAvgMin: rt.overallAvgMin,
    taken2minPct: rt.taken2minPct,
    taken15minPct: rt.taken15minPct,
    neglectedOver24h: rt.neglectedOver24h,
  });
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
       -- зміна дедлайну знімає анти-дубль авто-задачі «отримати оплату»
       task_created_at = CASE WHEN receivable_notes.due_date IS DISTINCT FROM EXCLUDED.due_date
                              THEN NULL ELSE receivable_notes.task_created_at END,
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

  // КРОК 2: усі гроші звіту — з core/money.ts (анкер по даті входу + дедуп, без знімків).
  const reportScope: money.MoneyScope = { from, to, managerId, teamId };
  // Часовий ряд «Отримані кошти» по бакетах (received = етап 9∪10, дедуп по угоді).
  const recvBuckets = await money.receivedByBucket(reportScope, granularity);

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
  for (const r of recvBuckets) { const e = bp(r.bucket); e.revenue += r.revenue; e.deals += r.deals; }
  for (const r of createdPeriod.rows) bp(r.bucket).created += Number(r.c);
  const byPeriod = [...byPeriodMap.values()]
    .sort((a, b) => (a.period < b.period ? -1 : 1))
    .map((e) => ({ ...e, avgCheck: e.deals > 0 ? Math.round(e.revenue / e.deals) : 0 }));

  // Summary totals (period): received = success ⊎ paidOnly (анкер+дедуп, знімки прибрано).
  const [reportReceived, reportSuccess, reportPaidOnly] = await Promise.all([
    money.receivedMoney(reportScope),
    money.successMoney(reportScope),
    money.paidOnlyMoney(reportScope),
  ]);
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

  // КРОК 9: борг = core/metrics.receivablesTotal (LEFT JOIN — повна сума; скоуп по
  // менеджеру/команді виключає null-рядки, тож роль-скоуп звіту не змінюється).
  const receivablesTotalValue = await metrics.receivablesTotal({ managerId, teamId });

  const successRevenue = reportSuccess.revenue;
  const successDeals = reportSuccess.deals;
  const paymentRevenue = reportPaidOnly.revenue; // «досі в оплаті» (етап 9, ще не 142)
  const paymentDeals = reportPaidOnly.deals;
  const revenue = reportReceived.revenue;
  const deals = reportReceived.deals;
  // Full per-manager scorecard (the metrics from the manual Excel report).
  const { adSources: reportAdSources } = await getSettings();
  const actP: unknown[] = [[8921932, 155304]];
  const actConds = ["d.pipeline_id = ANY($1)", ...scopeSql(actP), ...dateSql("created_at_kommo", actP)];
  actP.push(reportAdSources);
  const actAdIdx = actP.length;
  const actByMgr = await pool.query<{ id: number; name: string; ad_leads: string; quotes: string; success: string; success_sum: string }>(
    `SELECT m.id, m.name,
       COUNT(*) FILTER (WHERE ${metrics.adDealSql(`$${actAdIdx}`)}) AS ad_leads,
       COUNT(*) FILTER (WHERE psm.funnel_stage IN ('quote_requested','approved','invoiced','paid')) AS quotes
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     -- LEFT JOIN: «Прийнято реклами» рахує ВСІ ад-угоди повного циклу незалежно від
     -- поточного етапу (мапиться лише 5 із 15 статусів); quotes/dispatched і далі
     -- фільтрують по funnel_stage, тож null-етап їх природно виключає.
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${actConds.join(" AND ")}
     GROUP BY m.id, m.name`, actP);

  // «Озвучення ціни в перший дотик» — ДЖЕРЕЛО ПРАВДИ = автоматизація AI-
  // транскрибації дзвінка (uts-bot): вона слухає перший дзвінок менеджера з
  // лідом і шле пуш «ціну озвучено». Результат лягає в Google-лист «Перший
  // дотик», який ми синкаємо в `first_touch_analysis` (job syncFirstTouch).
  // Знаменник = усі проаналізовані перші дотики періоду; чисельник = ті, де
  // ціну озвучено. Скоуп по менеджеру/команді — через lead_id → deals.kommo_id
  // (manager_id авторитетний; лист теж має manager/team, але текст ненадійний).
  const ftP: unknown[] = [];
  const ftConds: string[] = [];
  if (from) { ftP.push(from); ftConds.push(`fta.analyzed_at >= $${ftP.length}::date`); }
  if (to) { ftP.push(to); ftConds.push(`fta.analyzed_at <= $${ftP.length}::date`); }
  let ftJoin = "";
  if (managerId) {
    ftP.push(managerId);
    ftJoin = "JOIN deals d ON d.kommo_id = fta.lead_id";
    ftConds.push(`d.manager_id = $${ftP.length}`);
  } else if (teamId) {
    ftP.push(teamId);
    ftJoin = "JOIN deals d ON d.kommo_id = fta.lead_id JOIN managers m ON m.id = d.manager_id";
    ftConds.push(`m.team_id = $${ftP.length}`);
  }
  const ftRes = await pool.query<{ analyzed: string; voiced: string }>(
    `SELECT COUNT(*) AS analyzed, COUNT(*) FILTER (WHERE fta.price_voiced) AS voiced
       FROM first_touch_analysis fta ${ftJoin}
       ${ftConds.length ? "WHERE " + ftConds.join(" AND ") : ""}`,
    ftP
  );
  const adPriceVoiced = Number(ftRes.rows[0]?.voiced ?? 0);
  const adFirstTouchAnalyzed = Number(ftRes.rows[0]?.analyzed ?? 0);

  // Per-manager гроші — анкер+дедуп (core/money.ts). success=142; paidOnly=етап 9
  // без 142; expected=етап 8. Сума менеджерів = received команди (consistency).
  const [succByMgrAgg, paidByMgrAgg, expByMgrAgg] = await Promise.all([
    money.successByMgr(reportScope),
    money.paidOnlyByMgr(reportScope),
    money.expectedByMgr(reportScope),
  ]);

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
  for (const r of actByMgr.rows) { const e = sc(r.id, r.name); e.adLeads = Number(r.ad_leads); e.quotes = Number(r.quotes); }
  for (const r of succByMgrAgg) {
    const e = sc(r.managerId, r.name);
    e.successRevenue = r.revenue; e.successDeals = r.deals;
    // Правило №1: «Поставлені машини» = перейшли в успіх у періоді (= успішні угоди).
    e.dispatched = r.deals; e.dispatchedSum = r.revenue;
  }
  for (const r of paidByMgrAgg) sc(r.managerId).paymentReceived = r.revenue;
  for (const r of expByMgrAgg) sc(r.managerId).expected = r.revenue;
  for (const r of transfByMgr.rows) sc(r.id).transfers = Number(r.c);
  for (const r of carryByMgr.rows) { const e = sc(r.id); e.carryover = Number(r.amount); e.carryoverDeals = Number(r.deals); }
  // Monthly payment_amount plan per manager (for the План/Факт drill-down).
  const planMonthR = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const planScoreP: unknown[] = [planMonthR];
  const planScoreC = ["p.plan_date = $1", "p.metric = 'payment_amount'"];
  // ⚠️ Скоуп на обраного менеджера — інакше план сумується по ВСІЙ команді
  // (навіть коли вибрано одного менеджера) і плитка «Виконання плану» показує
  // командний план замість плану менеджера.
  if (managerId) { planScoreP.push(managerId); planScoreC.push(`p.manager_id = $${planScoreP.length}`); }
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
    // ПРОМТ 0.9: чисельник і знаменник — ОДИН якір (перехід в успіх у періоді).
    // Додавання поточних снапшотів до чисельника мішало якорі (Правило №1.3)
    // і роздувало чек удвічі (5313 замість ~2800 у листі).
    avgCheck: successDeals > 0 ? Math.round(successRevenue / successDeals) : 0,
    createdDeals: createdTotal,
    newClients, repeatClients,
    receivables: receivablesTotalValue,
    adLeads: sumK("adLeads"), quotes: sumK("quotes"),
    adPriceVoiced, // ціну озвучено в перший дотик (AI-транскрибація дзвінка)
    adFirstTouchAnalyzed, // усього проаналізовано перших дотиків (знаменник)
    dispatched: sumK("dispatched"), dispatchedSum: sumK("dispatchedSum"),
    transfers: sumK("transfers"),
    carryover: sumK("carryover"), carryoverDeals: sumK("carryoverDeals"),
    expected: sumK("expected"),
    plan: sumK("plan"), // сума місячних планів виручки в скоупі (для плитки план/факт)
  };

  // КРОК 9-conv Фаза 1: конверсія по менеджеру — з ЯДРА (conversion_ads cohort,
  // стеля ≤100%). Стара формула (successDeals(ВСІ виграші)/adLeads) давала >100%
  // (до 2909% у РПК, бо ділила всі виграші на жменю ad-лідів). entered<10 →
  // cohortPct=null → «—» (нерекламний менеджер, не «0%»). Стару лишено для Фази 3.
  const adConvByMgr = new Map(
    (await metrics.conversionAdsByManager({ teamId, from, to }, reportAdSources)).map((m) => [m.managerId, m])
  );
  const byManager = managerId
    ? []
    : [...scoreMap.values()]
        .filter((e) => e.successRevenue > 0 || e.dispatched > 0 || e.quotes > 0 || e.paymentReceived > 0 || e.transfers > 0)
        .map((e) => {
          const ac = adConvByMgr.get(e.managerId);
          return {
            ...e,
            avgCheck: e.successDeals > 0 ? Math.round(e.successRevenue / e.successDeals) : 0,
            conversion: ac?.cohortPct ?? null,           // null → «—»
            conversionEntered: ac?.entered ?? 0,
            conversionBase: "реклама (cohort)",
          };
        })
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
  // КРОК 9: сегментний розподіл рахує core/metrics.funnelSegmentRows (deal-grain,
  // канонічний prior-paid). 🔴 ЗМІНА проти старого: сегмент був lifetime-ярлик
  // `cnt>=2 → regular` (глобальна мітка клієнта); тепер «постійний» = у клієнта є
  // ПОПЕРЕДНЯ оплачена угода, створена раніше за цю (GLOSSARY §9). Сума по стадії —
  // ТА САМА (INNER psm, та сама когорта створення, лише активні менеджери); зсув лише
  // у розкладі new↔regular. Роут добудовує форму: кумуляція, план, підписи, wire-ключ
  // `regular` (core повертає `repeat`).
  const segRows = (await metrics.funnelSegmentRows({ from, to, managerId, teamId })).map((r) => ({
    manager_id: r.managerId,
    name: r.name,
    stage: r.stage,
    bucket: r.segment === "repeat" ? "regular" : r.segment,
    c: r.count,
  }));

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

  const allRaw = segRows.map((r) => ({ stage: r.stage, bucket: r.bucket, c: r.c }));
  const stages = buildStages(allRaw);

  const byMgrMap = new Map<number, { managerId: number; name: string; raw: { stage: string; bucket: string; c: number }[] }>();
  for (const r of segRows) {
    let e = byMgrMap.get(r.manager_id);
    if (!e) { e = { managerId: r.manager_id, name: r.name, raw: [] }; byMgrMap.set(r.manager_id, e); }
    e.raw.push({ stage: r.stage, bucket: r.bucket, c: r.c });
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

  // Buckets = колонки звіту: тижні (Пн–Нд, кліпнуті до меж місяця) або дні
  // (?granularity=day). `key` — ключ для мапінгу фактів (Пн тижня або сам день).
  const granularity = String(req.query.granularity) === "day" ? "day" : "week";
  const WEEKDAY = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const weeks: { label: string; from: string; to: string; key: string; wd: number }[] = [];
  if (granularity === "week") {
    let cur = new Date(mStart);
    while (cur <= mEnd) {
      const daysToSun = (7 - cur.getDay()) % 7;
      let wEnd = new Date(cur); wEnd.setDate(cur.getDate() + daysToSun);
      if (wEnd > mEnd) wEnd = new Date(mEnd);
      const mon = new Date(cur); mon.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
      weeks.push({ label: `ТИЖДЕНЬ ${weeks.length + 1}`, from: fmt(cur), to: fmt(wEnd), key: fmt(mon), wd: workingDays(cur, wEnd) });
      cur = new Date(wEnd); cur.setDate(wEnd.getDate() + 1);
    }
  } else {
    // Дні: поточний місяць — до сьогодні; минулий — весь місяць (кап через factUpper).
    const dEnd = factUpper < mEnd ? factUpper : mEnd;
    let cur = new Date(mStart);
    while (cur <= dEnd) {
      const iso = fmt(cur);
      const wknd = cur.getDay() === 0 || cur.getDay() === 6;
      weeks.push({ label: `${WEEKDAY[cur.getDay()]} ${String(cur.getDate()).padStart(2, "0")}.${String(cur.getMonth() + 1).padStart(2, "0")}`, from: iso, to: iso, key: iso, wd: wknd ? 0 : 1 });
      cur = new Date(cur); cur.setDate(cur.getDate() + 1);
    }
  }
  const totalWd = workingDays(mStart, mEnd);
  const elapsedEnd = factUpper >= mStart ? factUpper : mStart;
  const elapsedWd = factUpper >= mStart ? workingDays(mStart, elapsedEnd) : 0;
  const proratio = totalWd > 0 ? elapsedWd / totalWd : 0;

  // 5 класичних етапів воронки (як у ручному звіті менеджера): Взято в роботу →
  // Прорахунок → Погоджено → Рахунок → Оплата. Беремо прямо з funnel_stage
  // (LIVE pipeline_stage_map). «Авто працює» тут НЕ окремий етап — авто-статуси
  // мапляться у свій funnel_stage (approved/invoiced), як у ручній воронці.
  // FACT: distinct deals that entered each funnel stage, per manager, per bucket.
  // КРОК 9: рероут на core/metrics.funnelWeeklyByManager (той самий SQL, лише винесений
  // — FACT-числа ідентичні). Форма (тижні/дні, план, гроші) лишається в роуті. Вікно
  // фактів кліпнуте до сьогодні для поточного місяця (fmt(mStart)..fmt(factUpper)).
  const factRows = {
    rows: (await metrics.funnelWeeklyByManager(
      { from: fmt(mStart), to: fmt(factUpper), managerId, teamId, activeOnly: true },
      granularity
    )).map((r) => ({ manager_id: r.managerId, name: r.name, stage: r.stage, wk: r.bucket, c: r.deals })),
  };

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
  const moneyRows = await pool.query<{ manager_id: number; carryover: string; expected: string; received: string; received_deals: string }>(
    `SELECT d.manager_id,
       COALESCE(SUM(d.price) FILTER (WHERE ${IN_PROGRESS} AND (d.created_at_kommo ${KYIV})::date < $2), 0) AS carryover,
       COALESCE(SUM(d.price) FILTER (WHERE ${IN_PROGRESS}), 0) AS expected,
       COALESCE(SUM(d.price) FILTER (WHERE d.status_id IN (69716460, 60412544)), 0)
       + COALESCE(SUM(d.price) FILTER (WHERE d.status_id = 142 AND (d.closed_at_kommo ${KYIV})::date BETWEEN $3 AND $4), 0) AS received,
       COUNT(*) FILTER (WHERE d.status_id IN (69716460, 60412544))
       + COUNT(*) FILTER (WHERE d.status_id = 142 AND (d.closed_at_kommo ${KYIV})::date BETWEEN $3 AND $4) AS received_deals
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${mConds.join(" AND ")}
     GROUP BY d.manager_id`,
    mParams
  );
  type MoneyWeek = { plan: number; fact: number; expected: number };
  type Money = {
    carryover: number; expected: number; received: number; receivedDeals: number;
    planMonth: number; weeks: MoneyWeek[]; daily: { date: string; v: number }[];
  };
  const emptyMoney = (): Money => ({
    carryover: 0, expected: 0, received: 0, receivedDeals: 0, planMonth: 0,
    weeks: weeks.map(() => ({ plan: 0, fact: 0, expected: 0 })), daily: [],
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
    m.receivedDeals = Number(r.received_deals);
    overallMoney.carryover += m.carryover;
    overallMoney.expected += m.expected;
    overallMoney.received += m.received;
    overallMoney.receivedDeals += m.receivedDeals;
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
    m.weeks = weeks.map((w) => ({ plan: Math.round(m.planMonth * (totalWd > 0 ? w.wd / totalWd : 0)), fact: 0, expected: 0 }));
  }

  // Тижневий/денний ФАКТ оплат = сума угод, у яких оплата ВПЕРШЕ надійшла в цьому
  // бакеті (перший вхід у «Успішно» 142 або «Оплата отримана» 69716460/60412544,
  // за подіями). Кожна оплачена угода рахується один раз — у тиждень першої оплати
  // → тижні сумуються в місячний факт (як у ручному звіті менеджера). Це ширше за
  // старе «142 закрито» і ловить снапшот-платників (гроші є, але угоду ще не закрито).
  const paidP: unknown[] = [[8921932, 155304], fmt(mStart), fmt(mEnd)];
  const paidC = ["d.pipeline_id = ANY($1)", `(x.first_paid ${KYIV})::date BETWEEN $2 AND $3`];
  if (managerId) { paidP.push(managerId); paidC.push(`d.manager_id = $${paidP.length}`); }
  if (teamId) { paidP.push(teamId); paidC.push(`m.team_id = $${paidP.length}`); }
  const paidWeekly = await pool.query<{ manager_id: number; day: string; v: string }>(
    `SELECT d.manager_id, to_char((x.first_paid ${KYIV})::date, 'YYYY-MM-DD') AS day, SUM(d.price) AS v
       FROM (SELECT kommo_id, MIN(changed_at) AS first_paid FROM deal_stage_events
             WHERE status_id IN (142, 69716460, 60412544) GROUP BY kommo_id) x
       JOIN deals d ON d.kommo_id = x.kommo_id
       JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE ${paidC.join(" AND ")} GROUP BY d.manager_id, day ORDER BY day`,
    paidP
  );
  const overallDaily = new Map<string, number>();
  for (const r of paidWeekly.rows) {
    const v = Number(r.v);
    overallDaily.set(r.day, (overallDaily.get(r.day) ?? 0) + v);
    const wi = weeks.findIndex((w) => r.day >= w.from && r.day <= w.to);
    if (wi >= 0) {
      moneyOf(r.manager_id).weeks[wi].fact += v;
      overallMoney.weeks[wi].fact += v;
    }
  }
  overallMoney.daily = [...overallDaily.entries()].map(([date, v]) => ({ date, v }));

  // Тижневе/денне ОЧІКУВАННЯ = сума угод, у яких рахунок ВПЕРШЕ виставлено в цьому
  // бакеті (перший вхід у funnel_stage='invoiced' за подіями) — «виставлено рахунків
  // на суму X цього тижня». Кожна угода один раз, у тиждень першого рахунку.
  const expP: unknown[] = [[8921932, 155304], fmt(mStart), fmt(mEnd)];
  const expC = ["d.pipeline_id = ANY($1)", `(x.first_inv ${KYIV})::date BETWEEN $2 AND $3`];
  if (managerId) { expP.push(managerId); expC.push(`d.manager_id = $${expP.length}`); }
  if (teamId) { expP.push(teamId); expC.push(`m.team_id = $${expP.length}`); }
  const expWeekly = await pool.query<{ manager_id: number; day: string; v: string }>(
    `SELECT d.manager_id, to_char((x.first_inv ${KYIV})::date, 'YYYY-MM-DD') AS day, SUM(d.price) AS v
       FROM (SELECT dse.kommo_id, MIN(dse.changed_at) AS first_inv
               FROM deal_stage_events dse
               JOIN deals dd ON dd.kommo_id = dse.kommo_id
               JOIN pipeline_stage_map psm ON psm.pipeline_id = dd.pipeline_id AND psm.status_id = dse.status_id
              WHERE psm.funnel_stage = 'invoiced' GROUP BY dse.kommo_id) x
       JOIN deals d ON d.kommo_id = x.kommo_id
       JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE ${expC.join(" AND ")} GROUP BY d.manager_id, day`,
    expP
  );
  for (const r of expWeekly.rows) {
    const v = Number(r.v);
    const wi = weeks.findIndex((w) => r.day >= w.from && r.day <= w.to);
    if (wi >= 0) {
      moneyOf(r.manager_id).weeks[wi].expected += v;
      overallMoney.weeks[wi].expected += v;
    }
  }

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

  const WK_STAGES = FUNNEL_ORDER; // 5 класичних етапів
  const WK_LABELS = FUNNEL_LABELS;
  const buildStages = (facts: WkMap, plan: Record<string, number>) =>
    WK_STAGES.map((stage) => {
      const pm = plan[stage] ?? 0;
      const wkOut = weeks.map((w) => ({
        plan: Math.round(pm * (totalWd > 0 ? w.wd / totalWd : 0)),
        fact: facts[stage]?.[w.key] ?? 0,
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
    granularity,
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

  // КРОК 9: рероут на core/metrics.stuckDeals (SQL/пороги ідентичні: minDays для
  // грошових стадій, ×3 для ранньої, вікно 180 днів, годинник COALESCE(last_activity,
  // created), LIMIT 50). Роут лишає крос-посилання в CRM (`crmUrl`).
  const stuck = await metrics.stuckDeals({ managerId, teamId }, minDays);
  res.json({
    minDays,
    deals: stuck.map((d) => ({
      kommoId: d.kommoId,
      crmUrl: kommoLeadUrl(d.kommoId),
      name: d.name,
      client: d.client,
      manager: d.manager,
      price: d.price,
      stage: d.stage,
      days: d.days,
      activityDays: d.activityDays,
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

  // Нічна авто-звірка (data_check_state) — інваріанти-запобіжники з датою прогону.
  const recon = await pool.query<{ ran_at: string; warnings: number; checks: unknown }>(
    `SELECT ran_at, warnings, checks FROM data_check_state WHERE id = 1`
  );
  res.json({
    checks: [
      { key: "noManager", label: "Угоди без менеджера", count: noManager.rowCount ?? 0, sample: sample(noManager.rows) },
      { key: "noAmount", label: "Угоди без суми (грошові етапи)", count: noAmount.rowCount ?? 0, sample: sample(noAmount.rows) },
      { key: "unmapped", label: "Угоди без статусу (не змаплено)", count: unmapped.rowCount ?? 0, sample: sample(unmapped.rows) },
      { key: "negatives", label: "Відʼємна сума без позначки «мінус»", count: negatives.rowCount ?? 0, sample: sample(negatives.rows) },
      { key: "duplicates", label: "Можливі дублі (клієнт з 2+ активними угодами)", count: duplicates.rowCount ?? 0, sample: sample(duplicates.rows) },
    ],
    reconciliation: recon.rows[0]
      ? { ranAt: recon.rows[0].ran_at, warnings: recon.rows[0].warnings, checks: recon.rows[0].checks }
      : null,
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
 * Історія «отриманих коштів» по одному постійному клієнту, помісячно (успішно
 * закриті 142 угоди повного циклу за датою закриття). Для плитки план-сітки:
 * піки/падіння замовлень + база для «плану з викликом» (+10–15%).
 * Повертає: history[{month, orders, revenue}] (13 міс), avgRecent (сер. по
 * останніх 3 активних міс.), suggestedPlan (avgRecent × 1.12) для челендж-плану.
 */
dashboardRouter.get("/repeat-client-history", async (req, res) => {
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const r = await pool.query<{ month: string; orders: string; revenue: string }>(
    `SELECT to_char(date_trunc('month', (d.closed_at_kommo ${KYIV})), 'YYYY-MM') AS month,
            COUNT(*) AS orders, COALESCE(SUM(d.price), 0) AS revenue
       FROM deals d
      WHERE d.client_key = $1 AND d.pipeline_id = ANY($2) AND d.status_id = 142
        AND d.closed_at_kommo IS NOT NULL
        AND (d.closed_at_kommo ${KYIV})::date >= (CURRENT_DATE - INTERVAL '13 months')
      GROUP BY 1 ORDER BY 1`,
    [clientKey, [8921932, 155304]]
  );
  const history = r.rows.map((x) => ({ month: x.month, orders: Number(x.orders), revenue: Number(x.revenue) }));
  // Середнє по останніх 3 місяцях, де були оплати (щоб пусті місяці не занижували).
  const active = history.filter((h) => h.revenue > 0).slice(-3);
  const avgRecent = active.length ? Math.round(active.reduce((s, h) => s + h.revenue, 0) / active.length) : 0;
  res.json({ history, avgRecent, suggestedPlan: Math.round(avgRecent * 1.12) });
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
  await pool.query(
    `INSERT INTO repeat_client_plan_history (client_key, month, changed_by, action, plan, status, comment)
     VALUES ($1, $2, $3, 'save', $4, $5, $6)`,
    [clientKey, month, auth.userId, num(b.plan) ?? 0, status, str(b.comment)]
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
  await pool.query(
    `INSERT INTO repeat_client_plan_history (client_key, month, changed_by, action, status)
     VALUES ($1, $2, $3, 'approve', $4)`,
    [clientKey, month, auth.userId, status]
  );
  res.json({ ok: true, status });
});

/** Затвердити ВСІ pending-плани за місяць (тімлід — своя команда, адмін — усі
 *  або обрана команда). Одним кліком закриває чергу на затвердження. */
dashboardRouter.post("/repeat-client-plan/approve-all", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") return res.status(403).json({ error: "Forbidden" });
  const b = req.body ?? {};
  const month = ((b.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  let teamId = b.teamId != null ? Number(b.teamId) : null;
  if (auth.role === "team_lead") teamId = auth.teamId;

  const params: unknown[] = [month, auth.userId];
  const conds = ["p.month = $1", "p.status = 'pending'"];
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }

  const upd = await pool.query<{ client_key: string }>(
    `UPDATE repeat_client_plans p SET status = 'approved', approved_by = $2, approved_at = now()
       FROM managers m
      WHERE p.manager_id = m.id AND ${conds.join(" AND ")}
      RETURNING p.client_key`,
    params
  );
  for (const row of upd.rows) {
    await pool.query(
      `INSERT INTO repeat_client_plan_history (client_key, month, changed_by, action, status)
       VALUES ($1, $2, $3, 'approve', 'approved')`,
      [row.client_key, month, auth.userId]
    );
  }
  res.json({ ok: true, approved: upd.rowCount });
});

/** Історія змін плану по клієнту (хто/коли/дія/план/статус). */
dashboardRouter.get("/repeat-client-plan/history", async (req, res) => {
  const auth = req.auth!;
  if (auth.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const month = ((req.query.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const r = await pool.query<{ changed_at: string; action: string; plan: string | null; status: string | null; comment: string | null; who: string | null }>(
    `SELECT h.changed_at, h.action, h.plan, h.status, h.comment, COALESCE(mm.name, u.email) AS who
       FROM repeat_client_plan_history h
       LEFT JOIN users u ON u.id = h.changed_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE h.client_key = $1 AND h.month = $2
      ORDER BY h.changed_at DESC LIMIT 100`,
    [clientKey, month]
  );
  res.json({
    history: r.rows.map((x) => ({
      changedAt: x.changed_at, action: x.action,
      plan: x.plan != null ? Number(x.plan) : null,
      status: x.status, comment: x.comment, who: x.who,
    })),
  });
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

// ── Департаментні плани КВП (Звіт КВП) ──────────────────────────────────
// Top-down цілі по відділу на місяць, editable лише КВП (admin). Виручку сюди
// НЕ дублюємо (вона в plans, сума по менеджерах — read-only у звіті); тут решта
// цілей, щоб «Викон.%» був реальним для кожного рядка матриці План/Факт.
const KVP_PLAN_METRICS = [
  "success", "avg_check", "new_revenue", "repeat_revenue",
  "created_full_cycle", "dispatched_cars", "new_clients", "repeat_clients",
  "ad_leads", "ad_conversion", "target_leads",
  "transferred", "transfer_success", "leadgen_conversion",
  // Рядки з ручного звіту КВП (структура файлу керівника):
  "received_total",      // план «Отримані кошти», якщо немає суми планів менеджерів
  "dispatched_sum",      // Відправлені авто, грн
  "success_deals",       // Успішні угоди, шт
  "paid_deals",          // Оплата отримана, шт
  "managers_count",      // Менеджерів у продажу
  "avg_per_manager",     // Середня сума на менеджера
  "nontarget_leads",     // Не цільові ліди
  "ad_revenue",          // Дохід з реклами, грн
  "ad_dispatched",       // Відправлені авто з реклами, шт
  "ad_avg_check",        // Середній чек реклами
  "leadgen_revenue",     // Дохід з лідогену, грн
  "leadgen_dispatched",  // Відправлені авто з лідогену, шт
];
// Плани по командах — динамічні ключі team_revenue_<teamId>.
const kvpMetricAllowed = (m: string) => KVP_PLAN_METRICS.includes(m) || /^team_revenue_\d+$/.test(m);

dashboardRouter.get("/kvp-plan", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const month = ((req.query.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const r = await pool.query<{ metric: string; planned_value: string }>(
    `SELECT metric, planned_value FROM kvp_plans WHERE month = $1`,
    [month]
  );
  const plans: Record<string, number> = {};
  for (const row of r.rows) plans[row.metric] = Number(row.planned_value);
  res.json({ month, plans });
});

/** Set department KVP targets for a month (admin/КВП only). Null/empty deletes. */
dashboardRouter.post("/kvp-plan", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin") return res.status(403).json({ error: "Лише КВП (адміністратор)" });
  const monthRaw = String(req.body?.month ?? "").slice(0, 7);
  const plans = req.body?.plans as Record<string, unknown> | undefined;
  if (!/^\d{4}-\d{2}$/.test(monthRaw) || !plans || typeof plans !== "object") {
    return res.status(400).json({ error: "month (YYYY-MM) та plans обовʼязкові" });
  }
  const month = monthRaw + "-01";
  for (const [metric, raw] of Object.entries(plans)) {
    if (!kvpMetricAllowed(metric)) continue;
    const value = raw === "" || raw == null ? null : Number(raw);
    if (value == null || !Number.isFinite(value)) {
      await pool.query(`DELETE FROM kvp_plans WHERE month = $1 AND metric = $2`, [month, metric]);
      continue;
    }
    await pool.query(
      `INSERT INTO kvp_plans (month, metric, planned_value, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (month, metric) DO UPDATE SET
         planned_value = EXCLUDED.planned_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [month, metric, value, auth.userId]
    );
  }
  res.json({ ok: true });
});

/**
 * Додаткові факти для Звіту КВП (рядки з ручного файлу керівника, яких немає
 * в /overview): відправлені авто за період (перший вхід угоди в «Авто працює»
 * за подіями CRM — кількість і сума, загалом та по каналах реклама/лідоген),
 * отримані кошти по каналах (успішно 142 закриті в періоді + оплата-снапшот),
 * кількість активних менеджерів продажу. Admin (КВП) only.
 */
dashboardRouter.get("/kvp-extra", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const from = (req.query.from as string) || today.slice(0, 7) + "-01";
  const to = (req.query.to as string) || today;
  const { adSources } = await getSettings();
  const params: unknown[] = [[8921932, 155304], from, to, adSources];

  // Відправлені авто: угоди, що ВПЕРШЕ увійшли в «Авто працює» у періоді.
  const disp = await pool.query<{ c: string; s: string; ad_c: string; ad_s: string; lg_c: string; lg_s: string }>(
    `WITH first_avto AS (
       SELECT kommo_id, MIN(changed_at) AS t FROM deal_stage_events
       WHERE status_id IN (69716300, 98470988, 10937178) GROUP BY kommo_id
     )
     SELECT COUNT(*) AS c, COALESCE(SUM(d.price), 0) AS s,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql("$4")}) AS ad_c,
            COALESCE(SUM(d.price) FILTER (WHERE ${metrics.adDealSql("$4")}), 0) AS ad_s,
            COUNT(*) FILTER (WHERE d.lead_channel = 'leadgen') AS lg_c,
            COALESCE(SUM(d.price) FILTER (WHERE d.lead_channel = 'leadgen'), 0) AS lg_s
     FROM first_avto f JOIN deals d ON d.kommo_id = f.kommo_id
     WHERE d.pipeline_id = ANY($1) AND (f.t ${KYIV})::date BETWEEN $2 AND $3`,
    params
  );

  // Отримані кошти по каналах — та сама формула, що «Отримані кошти» (142 закриті
  // в періоді + оплата-снапшот), відфільтрована по каналу угоди.
  const rev = await pool.query<{ ad_rev: string; lg_rev: string }>(
    `SELECT
       COALESCE(SUM(d.price) FILTER (WHERE ${metrics.adDealSql("$4")} AND d.status_id = 142
         AND (d.closed_at_kommo ${KYIV})::date BETWEEN $2 AND $3), 0)
       + COALESCE(SUM(d.price) FILTER (WHERE ${metrics.adDealSql("$4")} AND d.status_id IN (69716460, 60412544)), 0) AS ad_rev,
       COALESCE(SUM(d.price) FILTER (WHERE d.lead_channel = 'leadgen' AND d.status_id = 142
         AND (d.closed_at_kommo ${KYIV})::date BETWEEN $2 AND $3), 0)
       + COALESCE(SUM(d.price) FILTER (WHERE d.lead_channel = 'leadgen' AND d.status_id IN (69716460, 60412544)), 0) AS lg_rev
     FROM deals d WHERE d.pipeline_id = ANY($1)`,
    params
  );

  // Активні менеджери продажу (з командою, без лідоген-команд).
  const mgr = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM managers m LEFT JOIN teams t ON t.id = m.team_id
     WHERE m.is_active AND m.team_id IS NOT NULL AND COALESCE(t.name, '') NOT ILIKE '%лідоген%'`
  );

  // ПОТІК грошей за період: угоди, в які оплата ВПЕРШЕ надійшла в періоді
  // (перший вхід у 142/«Оплата отримана» за подіями). Для тижневих зрізів —
  // знімкові формули вище дублювали б «зараз в оплаті» у кожному тижні.
  const flow = await pool.query<{ s: string; ad_s: string; lg_s: string }>(
    `WITH first_paid AS (
       SELECT kommo_id, MIN(changed_at) AS t FROM deal_stage_events
       WHERE status_id IN (142, 69716460, 60412544) GROUP BY kommo_id
     )
     SELECT COALESCE(SUM(d.price), 0) AS s,
            COALESCE(SUM(d.price) FILTER (WHERE ${metrics.adDealSql("$4")}), 0) AS ad_s,
            COALESCE(SUM(d.price) FILTER (WHERE d.lead_channel = 'leadgen'), 0) AS lg_s
     FROM first_paid f JOIN deals d ON d.kommo_id = f.kommo_id
     WHERE d.pipeline_id = ANY($1) AND (f.t ${KYIV})::date BETWEEN $2 AND $3`,
    params
  );

  const d = disp.rows[0];
  res.json({
    from, to,
    dispatched: { count: Number(d?.c ?? 0), revenue: Number(d?.s ?? 0) },
    ad: { revenue: Number(rev.rows[0]?.ad_rev ?? 0), dispatched: Number(d?.ad_c ?? 0), dispatchedSum: Number(d?.ad_s ?? 0) },
    leadgen: { revenue: Number(rev.rows[0]?.lg_rev ?? 0), dispatched: Number(d?.lg_c ?? 0), dispatchedSum: Number(d?.lg_s ?? 0) },
    managersCount: Number(mgr.rows[0]?.c ?? 0),
    flow: {
      received: Number(flow.rows[0]?.s ?? 0),
      ad: Number(flow.rows[0]?.ad_s ?? 0),
      leadgen: Number(flow.rows[0]?.lg_s ?? 0),
    },
  });
});

// ───────────────────────── Р4a: ЄДИНИЙ ЗВІТ (manager-report) ─────────────────────────

/**
 * Р4a — ЄДИНИЙ звіт (менеджер / тімлід / КВП) з фільтром рівня. Чистий шар
 * ЗБІРКИ: усі секції з наявних core-функцій (money/metrics), сам майже нічого не
 * рахує. scope-резолвер жорстко обмежує за роллю (403 при виході за межі).
 * Легасі (/report,/overview,/kvp-extra) не чіпаємо — приберемо окремим кроком.
 */
dashboardRouter.get("/manager-report", async (req, res) => {
  const auth = req.auth!;
  const reqLevel = (String(req.query.level ?? "department")) as "department" | "team" | "manager";
  const reqId = req.query.id ? Number(req.query.id) : null;

  // ── єдиний scope-резолвер + роль-обмеження ──
  let level: "department" | "team" | "manager";
  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") {
    if (reqLevel !== "manager" || (reqId && reqId !== auth.managerId))
      return res.status(403).json({ error: "Менеджер бачить лише свій звіт" });
    level = "manager"; managerId = auth.managerId;
  } else if (auth.role === "team_lead") {
    if (reqLevel === "manager") {
      if (!reqId) return res.status(400).json({ error: "id менеджера обовʼязковий" });
      const chk = await pool.query(`SELECT 1 FROM managers WHERE id = $1 AND team_id = $2`, [reqId, auth.teamId]);
      if (!chk.rowCount) return res.status(403).json({ error: "Менеджер не з вашої команди" });
      level = "manager"; managerId = reqId;
    } else {
      level = "team"; teamId = auth.teamId;
    }
  } else {
    level = reqLevel;
    if (level === "manager") { if (!reqId) return res.status(400).json({ error: "id обовʼязковий" }); managerId = reqId; }
    else if (level === "team") { if (!reqId) return res.status(400).json({ error: "id обовʼязковий" }); teamId = reqId; }
  }

  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  if (!from || !to) return res.status(400).json({ error: "from/to обовʼязкові" });
  const granularity: "month" | "week" = req.query.granularity === "week" ? "week" : "month";
  const compareFrom = (req.query.compareFrom as string) ?? null;
  const compareTo = (req.query.compareTo as string) ?? null;
  const { adSources } = await getSettings();

  const monthStartOf = (d: string) => d.slice(0, 7) + "-01";
  const planScopeSql = (p: unknown[], mgrCol = "p.manager_id", teamCol = "mp.team_id") => {
    const sc: string[] = [];
    if (managerId) { p.push(managerId); sc.push(`${mgrCol} = $${p.length}`); }
    if (teamId) { p.push(teamId); sc.push(`${teamCol} = $${p.length}`); }
    return sc.length ? "AND " + sc.join(" AND ") : "";
  };
  async function fetchPlan(mFrom: string): Promise<number> {
    const p: unknown[] = [monthStartOf(mFrom)];
    const r = await pool.query<{ s: string }>(
      `SELECT COALESCE(SUM(p.planned_value),0) s FROM plans p JOIN managers mp ON mp.id = p.manager_id
        WHERE p.metric='payment_amount' AND date_trunc('month',p.plan_date) = $1::date ${planScopeSql(p)}`, p);
    return Math.round(Number(r.rows[0]?.s ?? 0));
  }
  async function fetchCarryover(mFrom: string): Promise<{ amount: number; deals: number }> {
    const p: unknown[] = [monthStartOf(mFrom)];
    const r = await pool.query<{ a: string; d: string }>(
      `SELECT COALESCE(SUM(cm.amount),0) a, COALESCE(SUM(cm.deals),0) d
         FROM monthly_carryover_mgr cm JOIN managers m ON m.id = cm.manager_id
        WHERE cm.month = $1::date ${planScopeSql(p, "cm.manager_id", "m.team_id")}`, p);
    return { amount: Number(r.rows[0]?.a ?? 0), deals: Number(r.rows[0]?.d ?? 0) };
  }

  const T = metrics.CONVERSION_TARGETS;
  const vs = (v: number | null, target: number) => (v == null ? null : Math.round((v - target) * 10) / 10);

  async function buildPeriod(pFrom: string, pTo: string) {
    const [proj, succFlow, plan, funnel, expected, adsRows, pzRows, reRows, carry] = await Promise.all([
      money.revenueProjection({ from: pFrom, to: pTo, managerId, teamId }),
      money.successMoney({ from: pFrom, to: pTo, managerId, teamId }),
      fetchPlan(pFrom),
      metrics.funnelCohortHonest({ from: pFrom, to: pTo, managerId, teamId }, granularity),
      metrics.expectedPaymentsByPlanned({ managerId, teamId }),
      metrics.conversionAdsByMonth({ managerId, teamId }, adSources),
      metrics.conversionProdzvinByMonth({ managerId, teamId }),
      metrics.conversionReactivationByMonth({ managerId, teamId }),
      fetchCarryover(pFrom),
    ]);
    const ad = sumConv(adsRows, pFrom, pTo), pz = sumConv(pzRows, pFrom, pTo), re = sumConv(reRows, pFrom, pTo);
    const fact = proj.fact; // ЄДИНЕ джерело «факту» (= receivedMoney)
    // 🔴 ПРОГНОЗ = ФОРМУЛА A (бектест: зміщення −3.9%, MAE 4.6%): факт + ПОВНА грошова
    // зона (expected.total — усі 5 стадій за СТАТУСОМ, ~65% закривається до кінця міс,
    // решту добирають угоди з ранніх стадій) + добір (новий бізнес, трейл-3м). Складові
    // диз'юнктні. Додаємо ЛИШЕ для поточного місяця, що ТРИВАЄ (місячна гранулярність);
    // минулий/завершений/тиждень → прогноз = факт (зона/добір — «зараз»-величини).
    const monthInProgress = granularity === "month" && proj.elapsedWorkingDays < proj.totalWorkingDays;
    const zoneFull = monthInProgress ? expected.total.sum : 0;
    const zoneDeals = monthInProgress ? expected.total.deals : 0;
    const dobir = monthInProgress ? await money.newBusinessDobir({ managerId, teamId }) : 0;
    const projected = fact + zoneFull + dobir;
    return {
      revenue: {
        plan, fact,
        // Датований потік (success по closed_at) — база ЧЕСНОГО Δ між періодами:
        // received-снапшот (paidOnly) несиметричний між «свіжим» і «дозрілим» місяцем.
        successFlow: succFlow.revenue,
        pctComplete: plan > 0 ? Math.round((fact / plan) * 100) : null,
        remaining: Math.max(0, plan - fact),
        projection: {
          projected,
          projectedPct: plan > 0 ? Math.round((projected / plan) * 100) : null,
          zoneFull, zoneDeals, dobir,
          byPace: proj.byPace,
          byPacePct: plan > 0 ? Math.round((proj.byPace / plan) * 100) : null,
          floor: proj.floor,
          floorPct: plan > 0 ? Math.round((proj.floor / plan) * 100) : null,
          elapsedWorkingDays: proj.elapsedWorkingDays, totalWorkingDays: proj.totalWorkingDays,
        },
      },
      funnel,
      expected: { total: expected.total, thisMonth: expected.thisMonth, nextMonth: expected.nextMonth, overdue: expected.overdue, later: expected.later, noDate: expected.noDate },
      conversions: {
        ads: { cohort: ad.wonCohort, period: ad.wonPeriod, entered: ad.entered, mature: ad.mature, target: T.ads, vsTarget: vs(ad.wonCohort, T.ads) },
        prodzvin: { won: pz.wonCohort, handoff: pz.handoffCohort, entered: pz.entered, mature: pz.mature, target: T.leadgen, vsTarget: vs(pz.wonCohort, T.leadgen) },
        reactivation: { won: re.wonCohort, handoff: re.handoffCohort, entered: re.entered, mature: re.mature, target: T.leadgen, vsTarget: vs(re.wonCohort, T.leadgen) },
      },
      carryover: carry,
    };
  }

  const current = await buildPeriod(from, to);
  const compareData = compareFrom && compareTo ? await buildPeriod(compareFrom, compareTo) : null;

  // Тижнева розбивка — по місяцю поточного періоду.
  const weekly = await money.weeklyBreakdown({ from: monthStartOf(from), managerId, teamId }, current.revenue.plan);

  // Світлофор команд — лише на рівні department (найгірші зверху).
  // Δ (flowCur/flowPrev) — like-for-like по ДАТОВАНОМУ потоку (successByTeam): received-
  // снапшот несиметричний між свіжим MTD і дозрілим минулим місяцем. fact (для % плану)
  // лишається received — та сама база, що план/факт.
  let teams: { teamId: number; teamName: string; plan: number; fact: number; pctPlan: number | null; remaining: number; flowCur: number | null; flowPrev: number | null }[] | undefined;
  if (level === "department") {
    const [facts, plansRes, flowsCur, flowsPrev] = await Promise.all([
      money.receivedByTeam({ from, to }),
      pool.query<{ team_id: number; s: string }>(
        `SELECT mp.team_id, COALESCE(SUM(p.planned_value),0) s FROM plans p JOIN managers mp ON mp.id = p.manager_id
          WHERE p.metric='payment_amount' AND date_trunc('month',p.plan_date) = $1::date GROUP BY mp.team_id`, [monthStartOf(from)]),
      compareFrom && compareTo ? money.successByTeam({ from, to }) : Promise.resolve(null),
      compareFrom && compareTo ? money.successByTeam({ from: compareFrom, to: compareTo }) : Promise.resolve(null),
    ]);
    const planByTeam = new Map(plansRes.rows.map((r) => [r.team_id, Math.round(Number(r.s))]));
    const curByTeam = flowsCur ? new Map(flowsCur.filter((t) => t.teamId != null).map((t) => [t.teamId, Math.round(t.revenue)])) : null;
    const prevByTeam = flowsPrev ? new Map(flowsPrev.filter((t) => t.teamId != null).map((t) => [t.teamId, Math.round(t.revenue)])) : null;
    teams = facts.filter((t) => t.teamId != null).map((t) => {
      const plan = planByTeam.get(t.teamId) ?? 0;
      const fact = Math.round(t.revenue);
      return {
        teamId: t.teamId, teamName: t.teamName, plan, fact,
        pctPlan: plan > 0 ? Math.round((fact / plan) * 100) : null, remaining: Math.max(0, plan - fact),
        flowCur: curByTeam ? (curByTeam.get(t.teamId) ?? 0) : null,
        flowPrev: prevByTeam ? (prevByTeam.get(t.teamId) ?? 0) : null,
      };
    }).sort((a, b) => (a.pctPlan ?? 999) - (b.pctPlan ?? 999)); // найгірші зверху
  }

  // Δ до compareWith — по ключових скалярах; для когортних — maturityMismatch.
  const delta = (cur: number | null, prev: number | null) => {
    if (cur == null || prev == null) return { current: cur, previous: prev, delta: null, deltaPct: null };
    const d = Math.round((cur - prev) * 10) / 10;
    return { current: cur, previous: prev, delta: d, deltaPct: prev !== 0 ? Math.round((d / Math.abs(prev)) * 1000) / 10 : null };
  };
  let compare: Record<string, unknown> | null = null;
  if (compareData) {
    const cf = (rows: metrics.FunnelHonestRow[]) => rows[0]?.pct?.paid ?? null;
    compare = {
      // 🔴 successFlow — ГОЛОВНА Δ hero (like-for-like по датованому потоку; received-Δ
      // лишається для довідки, але «свіжий снапшот vs дозрілий місяць» перекручує).
      successFlow: delta(current.revenue.successFlow, compareData.revenue.successFlow),
      revenueFact: delta(current.revenue.fact, compareData.revenue.fact),
      revenuePctComplete: delta(current.revenue.pctComplete, compareData.revenue.pctComplete),
      funnelPaidPct: { ...delta(cf(current.funnel), cf(compareData.funnel)), maturityMismatch: current.funnel[0]?.mature === false },
      adsCohort: { ...delta(current.conversions.ads.cohort, compareData.conversions.ads.cohort), maturityMismatch: current.conversions.ads.mature === false },
      prodzvinWon: { ...delta(current.conversions.prodzvin.won, compareData.conversions.prodzvin.won), maturityMismatch: current.conversions.prodzvin.mature === false },
      reactivationWon: { ...delta(current.conversions.reactivation.won, compareData.conversions.reactivation.won), maturityMismatch: current.conversions.reactivation.mature === false },
      expectedThisMonth: delta(current.expected.thisMonth.sum, compareData.expected.thisMonth.sum),
      expectedOverdue: delta(current.expected.overdue.sum, compareData.expected.overdue.sum),
    };
  }

  res.json({
    scope: { level, id: managerId ?? teamId ?? null, period: { from, to, granularity }, compareWith: compareFrom && compareTo ? { from: compareFrom, to: compareTo } : null },
    ...current,
    weekly,
    ...(teams ? { teams } : {}),
    compare,
  });
});
