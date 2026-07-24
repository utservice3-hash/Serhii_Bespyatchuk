import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { successByBucket, receivedByBucket, type MoneyScope } from "../core/money.js";
import {
  STATS_SEAM, isCrmAble, hasLive, LIVE_METRIC, LIVE_TEAMS, type LiveKind,
} from "../statistics/seriesCatalog.js";

/**
 * Вкладка «Статистики» (діаграми). Зшивка на серію:
 *   sheet (stats_series, <шов) + crm (live з ядра, ≥шов, лише CRM_ABLE з live-обчислювачем)
 *   + manual (stats_series). Кожна точка несе source. Company для sales — похідна
 *   (Σ team_leads; avg_check = Σrev÷Σcars); для інших блоків — прямо з CSV company-scope.
 * Роль-скоуп: admin — усе; team_lead — компанія+своя команда+свої менеджери; manager — свої.
 * Монтується на /api/statistics ПОРЯД із депстат-роутом (шляхи /series* не перетинаються).
 */
export const statsSeriesRouter = Router();
statsSeriesRouter.use(requireAuth);

type Gran = "day" | "week" | "month";
interface Point { period: string; value: number; source: "sheet" | "crm" | "manual" }
interface Series { scopeType: string; scopeKey: string; scopeName: string; points: Point[] }

const SALES_SUM_METRICS = new Set(["revenue_success", "cars_success", "payment_received", "cash_deals_sum", "cars_delivered", "calls", "managers_count"]);

// ── sheet/manual точки однієї серії з stats_series ──
async function storedPoints(metric: string, gran: Gran, scopeType: string, scopeKey: string, source: "sheet" | "manual"): Promise<Point[]> {
  const r = await pool.query<{ period: string; value: string }>(
    `SELECT to_char(period_date,'YYYY-MM-DD') period, value::float value
       FROM stats_series
      WHERE metric_key=$1 AND granularity=$2 AND scope_type=$3 AND scope_key=$4 AND source=$5
      ORDER BY period_date`,
    [metric, gran, scopeType, scopeKey, source]
  );
  return r.rows.map((x) => ({ period: x.period, value: Number(x.value), source }));
}

// ── company sheet-історія для SALES (похідна) ──
async function companySalesSheet(metric: string, gran: Gran): Promise<Point[]> {
  if (metric === "avg_check") {
    // Σrevenue_success ÷ Σcars_success по періоду (ratio, не середнє середніх).
    const r = await pool.query<{ period: string; v: string }>(
      `SELECT to_char(rev.period_date,'YYYY-MM-DD') period,
              (SUM(rev.value)/NULLIF(SUM(car.value),0))::float v
         FROM stats_series rev
         JOIN stats_series car
           ON car.metric_key='cars_success' AND car.granularity=rev.granularity
          AND car.scope_type='team_lead' AND car.scope_key=rev.scope_key
          AND car.period_date=rev.period_date AND car.source='sheet'
        WHERE rev.metric_key='revenue_success' AND rev.granularity=$1
          AND rev.scope_type='team_lead' AND rev.source='sheet'
        GROUP BY rev.period_date ORDER BY rev.period_date`,
      [gran]
    );
    return r.rows.filter((x) => x.v != null).map((x) => ({ period: x.period, value: Number(x.v), source: "sheet" as const }));
  }
  // sum-метрика: Σ по всіх team_lead серіях (включно з історичними Мельник/Шевчук/…)
  const r = await pool.query<{ period: string; v: string }>(
    `SELECT to_char(period_date,'YYYY-MM-DD') period, SUM(value)::float v
       FROM stats_series
      WHERE metric_key=$1 AND granularity=$2 AND scope_type='team_lead' AND source='sheet'
      GROUP BY period_date ORDER BY period_date`,
    [metric, gran]
  );
  return r.rows.map((x) => ({ period: x.period, value: Number(x.v), source: "sheet" as const }));
}

// ── crm live точки (≥ шов) для money-метрик ──
async function crmMoney(kind: LiveKind, gran: Gran, from: string, to: string, teamId: number | null, managerId: number | null): Promise<Point[]> {
  const s: MoneyScope = { from, to, teamId, managerId };
  const g: Gran = gran;
  const rows = kind === "received_rev" ? await receivedByBucket(s, g) : await successByBucket(s, g);
  return rows.map((x) => ({
    period: x.bucket,
    value: kind === "success_rev" || kind === "received_rev" ? x.revenue
      : kind === "success_deals" ? x.deals
      : x.deals ? x.revenue / x.deals : 0, // success_avg
    source: "crm" as const,
  }));
}

// ── зшивка однієї серії: sheet(<шов) + crm(≥шов) + manual ──
async function stitch(block: string, metric: string, gran: Gran, from: string, to: string, series: { scopeType: string; scopeKey: string; scopeName: string; teamId: number | null; managerId: number | null }): Promise<Series> {
  const crmAble = isCrmAble(block, metric);
  // sheet: для sales-company — похідна; інакше — з таблиці. (Для CRM_ABLE імпорт уже обрізав ≥шов.)
  let sheet: Point[] = [];
  if (series.scopeType === "company" && block === "sales") sheet = await companySalesSheet(metric, gran);
  else sheet = await storedPoints(metric, gran, series.scopeType, series.scopeKey, "sheet");
  // Для CRM_ABLE лишаємо лише <шов (страховка навіть якщо колись просочиться ≥шов).
  if (crmAble) sheet = sheet.filter((p) => p.period < STATS_SEAM);

  // crm: лише CRM_ABLE з live-обчислювачем, вікно [max(from,шов), to], лише живі скоупи.
  let crm: Point[] = [];
  const liveScope = series.scopeType === "company" || series.teamId != null || series.managerId != null;
  if (hasLive(block, metric) && liveScope && to >= STATS_SEAM) {
    const cf = from > STATS_SEAM ? from : STATS_SEAM;
    crm = await crmMoney(LIVE_METRIC[metric], gran, cf, to, series.teamId, series.managerId);
    crm = crm.filter((p) => p.period >= STATS_SEAM);
  }
  const manual = await storedPoints(metric, gran, series.scopeType, series.scopeKey, "manual");

  // Merge по періоду: пріоритет crm > sheet > manual (шов не дає перетину для CRM_ABLE).
  const byPeriod = new Map<string, Point>();
  for (const p of manual) byPeriod.set(p.period, p);
  for (const p of sheet) byPeriod.set(p.period, p);
  for (const p of crm) byPeriod.set(p.period, p);
  const points = [...byPeriod.values()].filter((p) => p.period >= from && p.period <= to).sort((a, b) => a.period.localeCompare(b.period));
  return { scopeType: series.scopeType, scopeKey: series.scopeKey, scopeName: series.scopeName, points };
}

// ── набір серій за роллю ──
function seriesSet(auth: { role: string; teamId: number | null; managerId: number | null }): { scopeType: string; scopeKey: string; scopeName: string; teamId: number | null; managerId: number | null }[] {
  const company = { scopeType: "company", scopeKey: "company", scopeName: "Компанія", teamId: null, managerId: null };
  const teamOf = (t: { id: number; name: string }) => ({ scopeType: "team_lead", scopeKey: String(t.id), scopeName: t.name, teamId: t.id, managerId: null });
  if (auth.role === "admin") return [company, ...LIVE_TEAMS.map(teamOf)];
  if (auth.role === "team_lead") {
    const own = LIVE_TEAMS.find((t) => t.id === auth.teamId);
    return [company, ...(own ? [teamOf(own)] : [])];
  }
  // manager — лише своя серія (CRM-ера; sheet per-manager нема)
  if (auth.managerId != null) return [{ scopeType: "manager", scopeKey: String(auth.managerId), scopeName: "Мої", teamId: null, managerId: auth.managerId }];
  return [company];
}

// GET /api/statistics/series?block&metric&granularity&from&to
statsSeriesRouter.get("/series", async (req, res) => {
  const auth = req.auth!;
  const block = String(req.query.block ?? "sales");
  const metric = String(req.query.metric ?? "");
  const gran = (["day", "week", "month"].includes(String(req.query.granularity)) ? req.query.granularity : "week") as Gran;
  const from = String(req.query.from ?? "2024-07-01");
  const to = String(req.query.to ?? "2026-12-31");
  if (!metric) return res.status(400).json({ error: "metric обовʼязковий" });

  const set = seriesSet({ role: auth.role, teamId: auth.teamId ?? null, managerId: auth.managerId ?? null });
  const series = await Promise.all(set.map((s) => stitch(block, metric, gran, from, to, s)));
  res.json({ block, metric, granularity: gran, seam: STATS_SEAM, crmAble: isCrmAble(block, metric), live: hasLive(block, metric), series });
});

// POST /api/statistics/series/manual — ручна точка (бюджети/тендери/…). admin-only.
// Не можна перезаписати sheet/crm. Своє manual — редагувати можна (upsert по ключу).
statsSeriesRouter.post("/series/manual", requireRole("admin"), async (req, res) => {
  const auth = req.auth!;
  const { block, metric, scopeType, scopeKey, scopeName, granularity, period, value } = req.body ?? {};
  if (!block || !metric || !scopeType || !scopeKey || !granularity || !period || value == null)
    return res.status(400).json({ error: "block/metric/scopeType/scopeKey/granularity/period/value обовʼязкові" });
  if (!["month", "week"].includes(granularity)) return res.status(400).json({ error: "granularity month|week" });
  if (isCrmAble(block, metric)) return res.status(400).json({ error: "CRM-able метрику вручну не вносять (її рахує CRM)" });
  // Заборона перезапису sheet/crm: якщо на цей ключ+період є sheet-точка — 409.
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
