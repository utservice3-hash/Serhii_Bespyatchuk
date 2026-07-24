import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { successByBucket, receivedByBucket, type MoneyScope } from "../core/money.js";
import { dispatchedByLoadBucket, leadsTakenByBucket, type MetricScope } from "../core/metrics.js";
import { SALES_TEAM_LEAD } from "../statistics/catalog.js";
import {
  STATS_SEAM, isCrmAble, LIVE_TEAMS, DEPSTATS_DEPT, DEPSTATS_METRIC_MAP, hasDepstats,
} from "../statistics/seriesCatalog.js";

/**
 * Вкладка «Статистики» (діаграми). Зшивка на серію: sheet (stats_series, <шов) +
 * crm (live з ядра / depstats-read, ≥шов) + manual (stats_series). Кожна точка з source.
 * Company для sales — похідна (Σ team_leads; avg = Σrev÷Σcars). Роль-скоуп на сервері.
 * Монтується на /api/statistics ПОРЯД із депстат-роутом (/series* не перетинаються).
 */
export const statsSeriesRouter = Router();
statsSeriesRouter.use(requireAuth);

type Gran = "day" | "week" | "month";
interface Point { period: string; value: number; source: "sheet" | "crm" | "manual" }
interface Series { scopeType: string; scopeKey: string; scopeName: string; points: Point[] }
interface ScopeSpec { scopeType: string; scopeKey: string; scopeName: string; teamId: number | null; managerId: number | null }

// ── LIVE-обчислювачі (реюз ядра). period='YYYY-MM-DD', source='crm'. Метрики без запису
//    тут CRM-продовження через core НЕ мають (calls/finance/hr — через depstats-read нижче). ──
type Computer = (g: Gran, from: string, to: string, teamId: number | null, managerId: number | null) => Promise<Point[]>;
const P = (period: string, value: number): Point => ({ period, value, source: "crm" });

const moneyC = (kind: "rev" | "deals" | "avg" | "recv"): Computer => async (g, from, to, teamId, managerId) => {
  const s: MoneyScope = { from, to, teamId, managerId };
  const rows = kind === "recv" ? await receivedByBucket(s, g) : await successByBucket(s, g);
  return rows.map((x) => P(x.bucket, kind === "rev" || kind === "recv" ? x.revenue : kind === "deals" ? x.deals : x.deals ? x.revenue / x.deals : 0));
};

const COMPUTERS: Record<string, Computer> = {
  revenue_success: moneyC("rev"),
  cars_success: moneyC("deals"),
  avg_check: moneyC("avg"),
  payment_received: moneyC("recv"),
  // Авто (поставлені) — dispatched по load_at, COUNT угод.
  cars_delivered: async (g, from, to, teamId, managerId) => {
    const s: MetricScope = { from, to, teamId, managerId, activeOnly: true };
    return (await dispatchedByLoadBucket(s, g)).map((x) => P(x.ym, x.deals));
  },
  // Ліди з реклами — leadsTakenByBucket(byChannel), канал 'ad'.
  ad_leads: async (g, from, to, teamId, managerId) => {
    const s: MetricScope = { from, to, teamId, managerId, activeOnly: true };
    const rows = await leadsTakenByBucket(s, g, true);
    const agg = new Map<string, number>();
    for (const r of rows as { bucket: string; deals: number; channel?: string }[])
      if (r.channel === "ad") agg.set(r.bucket, (agg.get(r.bucket) ?? 0) + Number(r.deals));
    return [...agg].map(([period, v]) => P(period, v));
  },
  // Прорахунки лідгенів — leadgen_registry.transferred_at, COUNT(DISTINCT lead). Company-level.
  lg_transfers: async (g, from, to, teamId, managerId) => {
    if (teamId != null || managerId != null) return []; // per-team поки не розрізаємо (лише компанія)
    const r = await pool.query<{ period: string; v: string }>(
      `SELECT to_char(date_trunc($1, (transferred_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') period,
              COUNT(DISTINCT lead_id) v
         FROM leadgen_registry
        WHERE (transferred_at AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $2 AND $3
        GROUP BY 1 ORDER BY 1`,
      [g, from, to]
    );
    return r.rows.map((x) => P(x.period, Number(x.v)));
  },
};
const hasLive = (block: string, metric: string): boolean => (metric in COMPUTERS) || hasDepstats(block, metric);

// ── depstats-read (calls/finance/hr): statistics_values, лише source IN (auto,manual) ≥шов ──
function teamLeadForStats(teamId: number | null): string | null {
  if (teamId == null) return null;               // company → team_lead IS NULL
  if (teamId === 36283) return "Шевчук Назар";   // «Самостійні» → Шевчук (R2, як у депстаті)
  return SALES_TEAM_LEAD[teamId] ?? null;
}
async function depstatsRead(block: string, metric: string, g: Gran, from: string, to: string, scope: ScopeSpec): Promise<Point[]> {
  if (g === "day") return [];                     // statistics_values — лише month|week
  if (scope.scopeType === "manager") return [];   // депстат per-manager нема
  const dept = DEPSTATS_DEPT[block], sv = DEPSTATS_METRIC_MAP[metric];
  if (!dept || !sv) return [];
  const cf = from > STATS_SEAM ? from : STATS_SEAM;
  const params: unknown[] = [dept, sv, g, cf, to];
  // sales·calls зберігається ПО team_lead (company-рядка NULL нема) → company = Σ лідів.
  // finance/hr — company-level (team_lead IS NULL). Per-team — конкретний team_lead.
  const salesLeadSum = block === "sales" && scope.scopeType === "company";
  let leadCond: string;
  if (salesLeadSum) leadCond = "team_lead IS NOT NULL";
  else { const lead = teamLeadForStats(scope.teamId); leadCond = lead == null ? "team_lead IS NULL" : `team_lead = $${params.push(lead)}`; }
  const r = await pool.query<{ period: string; v: string; source: string }>(
    `SELECT to_char(period_start,'YYYY-MM-DD') period, SUM(value)::float v, MIN(source) source
       FROM statistics_values
      WHERE department=$1 AND metric_key=$2 AND period_type=$3
        AND source IN ('auto','manual')            -- imported ІГНОРУЄМО (стара копія тієї ж таблиці → без дублів)
        AND period_start >= $4::date AND period_start <= $5::date AND ${leadCond}
      GROUP BY period_start ORDER BY period_start`,
    params
  );
  return r.rows.map((x) => ({ period: x.period, value: Number(x.v), source: "crm" as const }));
}

// ── sheet/manual точки однієї серії з stats_series ──
async function storedPoints(metric: string, g: Gran, scopeType: string, scopeKey: string, source: "sheet" | "manual"): Promise<Point[]> {
  const r = await pool.query<{ period: string; value: string }>(
    `SELECT to_char(period_date,'YYYY-MM-DD') period, value::float value
       FROM stats_series WHERE metric_key=$1 AND granularity=$2 AND scope_type=$3 AND scope_key=$4 AND source=$5
      ORDER BY period_date`,
    [metric, g, scopeType, scopeKey, source]
  );
  return r.rows.map((x) => ({ period: x.period, value: Number(x.value), source }));
}

// ── company sheet-історія для SALES (похідна: Σ team_leads; avg = Σrev÷Σcars) ──
async function companySalesSheet(metric: string, g: Gran): Promise<Point[]> {
  if (metric === "avg_check") {
    const r = await pool.query<{ period: string; v: string }>(
      `SELECT to_char(rev.period_date,'YYYY-MM-DD') period, (SUM(rev.value)/NULLIF(SUM(car.value),0))::float v
         FROM stats_series rev
         JOIN stats_series car ON car.metric_key='cars_success' AND car.granularity=rev.granularity
          AND car.scope_type='team_lead' AND car.scope_key=rev.scope_key AND car.period_date=rev.period_date AND car.source='sheet'
        WHERE rev.metric_key='revenue_success' AND rev.granularity=$1 AND rev.scope_type='team_lead' AND rev.source='sheet'
        GROUP BY rev.period_date ORDER BY rev.period_date`, [g]);
    return r.rows.filter((x) => x.v != null).map((x) => ({ period: x.period, value: Number(x.v), source: "sheet" as const }));
  }
  const r = await pool.query<{ period: string; v: string }>(
    `SELECT to_char(period_date,'YYYY-MM-DD') period, SUM(value)::float v
       FROM stats_series WHERE metric_key=$1 AND granularity=$2 AND scope_type='team_lead' AND source='sheet'
      GROUP BY period_date ORDER BY period_date`, [metric, g]);
  return r.rows.map((x) => ({ period: x.period, value: Number(x.v), source: "sheet" as const }));
}

// ── зшивка однієї серії ──
async function stitch(block: string, metric: string, g: Gran, from: string, to: string, sc: ScopeSpec): Promise<Series> {
  const crmAble = isCrmAble(block, metric);
  let sheet: Point[] = (sc.scopeType === "company" && block === "sales")
    ? await companySalesSheet(metric, g)
    : await storedPoints(metric, g, sc.scopeType, sc.scopeKey, "sheet");
  if (crmAble) sheet = sheet.filter((p) => p.period < STATS_SEAM);

  let crm: Point[] = [];
  const liveScope = sc.scopeType === "company" || sc.teamId != null || sc.managerId != null;
  if (liveScope && to >= STATS_SEAM) {
    if (metric in COMPUTERS) crm = await COMPUTERS[metric](g, from > STATS_SEAM ? from : STATS_SEAM, to, sc.teamId, sc.managerId);
    else if (hasDepstats(block, metric)) crm = await depstatsRead(block, metric, g, from, to, sc);
    crm = crm.filter((p) => p.period >= STATS_SEAM);
  }
  const manual = await storedPoints(metric, g, sc.scopeType, sc.scopeKey, "manual");

  const byPeriod = new Map<string, Point>();       // пріоритет crm > sheet > manual (шов не дає перетину для CRM_ABLE)
  for (const p of manual) byPeriod.set(p.period, p);
  for (const p of sheet) byPeriod.set(p.period, p);
  for (const p of crm) byPeriod.set(p.period, p);
  const points = [...byPeriod.values()].filter((p) => p.period >= from && p.period <= to).sort((a, b) => a.period.localeCompare(b.period));
  return { scopeType: sc.scopeType, scopeKey: sc.scopeKey, scopeName: sc.scopeName, points };
}

function seriesSet(auth: { role: string; teamId: number | null; managerId: number | null }): ScopeSpec[] {
  const company: ScopeSpec = { scopeType: "company", scopeKey: "company", scopeName: "Компанія", teamId: null, managerId: null };
  const teamOf = (t: { id: number; name: string }): ScopeSpec => ({ scopeType: "team_lead", scopeKey: String(t.id), scopeName: t.name, teamId: t.id, managerId: null });
  if (auth.role === "admin") return [company, ...LIVE_TEAMS.map(teamOf)];
  if (auth.role === "team_lead") { const own = LIVE_TEAMS.find((t) => t.id === auth.teamId); return [company, ...(own ? [teamOf(own)] : [])]; }
  if (auth.managerId != null) return [{ scopeType: "manager", scopeKey: String(auth.managerId), scopeName: "Мої", teamId: null, managerId: auth.managerId }];
  return [company];
}

// GET /api/statistics/series?block&metric&granularity&from&to
statsSeriesRouter.get("/series", async (req, res) => {
  const auth = req.auth!;
  const block = String(req.query.block ?? "sales");
  const metric = String(req.query.metric ?? "");
  const g = (["day", "week", "month"].includes(String(req.query.granularity)) ? req.query.granularity : "week") as Gran;
  const from = String(req.query.from ?? "2024-07-01");
  const to = String(req.query.to ?? "2026-12-31");
  if (!metric) return res.status(400).json({ error: "metric обовʼязковий" });
  const set = seriesSet({ role: auth.role, teamId: auth.teamId ?? null, managerId: auth.managerId ?? null });
  const series = await Promise.all(set.map((s) => stitch(block, metric, g, from, to, s)));
  res.json({ block, metric, granularity: g, seam: STATS_SEAM, crmAble: isCrmAble(block, metric), live: hasLive(block, metric), series });
});

// POST /api/statistics/series/manual — ручні точки (не CRM-able). admin-only.
statsSeriesRouter.post("/series/manual", requireRole("admin"), async (req, res) => {
  const auth = req.auth!;
  const { block, metric, scopeType, scopeKey, scopeName, granularity, period, value } = req.body ?? {};
  if (!block || !metric || !scopeType || !scopeKey || !granularity || !period || value == null)
    return res.status(400).json({ error: "block/metric/scopeType/scopeKey/granularity/period/value обовʼязкові" });
  if (!["month", "week"].includes(granularity)) return res.status(400).json({ error: "granularity month|week" });
  if (isCrmAble(block, metric)) return res.status(400).json({ error: "CRM-able метрику вручну не вносять (її рахує CRM)" });
  const clash = await pool.query(
    `SELECT 1 FROM stats_series WHERE metric_key=$1 AND scope_type=$2 AND scope_key=$3 AND granularity=$4 AND period_date=$5 AND source='sheet'`,
    [metric, scopeType, scopeKey, granularity, period]
  );
  if (clash.rowCount) return res.status(409).json({ error: "На цей період є sheet-точка — перезапис заборонено" });
  await pool.query(
    `INSERT INTO stats_series (block, metric_key, scope_type, scope_key, scope_name, granularity, period_date, value, source, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9)
     ON CONFLICT (metric_key, scope_type, scope_key, granularity, period_date, source)
     DO UPDATE SET value=EXCLUDED.value, scope_name=EXCLUDED.scope_name, block=EXCLUDED.block, entered_by=EXCLUDED.entered_by, entered_at=now()`,
    [block, metric, scopeType, scopeKey, scopeName ?? scopeKey, granularity, period, Number(value), auth.managerId ?? null]
  );
  res.json({ ok: true });
});
