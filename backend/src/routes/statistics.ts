import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import {
  CATALOG, getDepartment, getMetric, canonTeamLead, SALES_TEAM_LEAD, STATS_AUTO_FROM,
} from "../statistics/catalog.js";

/**
 * API розділу «Статистики». Структура (вкладки/метрики) — з catalog.ts.
 * Читання: усі авторизовані; для sales non-admin бачить лише свій розріз
 * (team_lead за своєю командою). Запис manual: ЛИШЕ admin; auto/derived —
 * руками не редагуються (400).
 */
export const statisticsRouter = Router();
statisticsRouter.use(requireAuth);

/** team_lead, до якого прив'язаний non-admin (за його командою); null — не sales. */
function ownTeamLead(teamId: number | null): string | null {
  if (teamId != null && SALES_TEAM_LEAD[teamId]) return canonTeamLead(SALES_TEAM_LEAD[teamId]);
  return null;
}

// Структура розділу — джерело правди для фронта.
statisticsRouter.get("/catalog", (_req, res) => {
  res.json({ departments: CATALOG, autoFrom: STATS_AUTO_FROM });
});

// Значення. ?department=&period_type=month|week&from=YYYY-MM-DD&to=YYYY-MM-DD
statisticsRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  const department = String(req.query.department ?? "");
  const periodType = String(req.query.period_type ?? "month");
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;

  const dept = getDepartment(department);
  if (!dept) return res.status(400).json({ error: "Невідомий відділ" });
  if (periodType !== "month" && periodType !== "week") return res.status(400).json({ error: "period_type: month|week" });

  const params: unknown[] = [department, periodType];
  const conds = ["department = $1", "period_type = $2"];
  if (from) { params.push(from); conds.push(`period_start >= $${params.length}`); }
  if (to) { params.push(to); conds.push(`period_start <= $${params.length}`); }

  // Скоуп sales для non-admin: лише свій team_lead.
  if (auth.role !== "admin" && dept.hasTeamLeadBreakdown) {
    const lead = ownTeamLead(auth.teamId);
    if (!lead) return res.json({ department, periodType, rows: [], scopedTo: null });
    params.push(lead); conds.push(`team_lead = $${params.length}`);
  }

  const r = await pool.query<{ period_start: string; team_lead: string | null; metric_key: string; value: string | null; source: string }>(
    `SELECT to_char(period_start,'YYYY-MM-DD') AS period_start, team_lead, metric_key, value, source
       FROM statistics_values WHERE ${conds.join(" AND ")}
      ORDER BY period_start DESC, team_lead NULLS FIRST, metric_key`,
    params
  );

  // План/факт (R4): для sales-виручки помісячно — план із таблиці `plans`
  // (metric='payment_amount', per-manager) агрегований по тімліду. Ключ
  // `${month}|${team_lead}` → сума плану. Тиждень/інші відділи — плану немає.
  const plans: Record<string, number> = {};
  if (dept.key === "sales" && periodType === "month") {
    const pp: unknown[] = [];
    const pc: string[] = ["p.metric = 'payment_amount'"];
    if (from) { pp.push(from); pc.push(`p.plan_date >= $${pp.length}`); }
    if (to) { pp.push(to); pc.push(`p.plan_date <= $${pp.length}`); }
    const pr = await pool.query<{ month: string; team_id: number | null; plan: string }>(
      `SELECT to_char(p.plan_date,'YYYY-MM-DD') AS month, m.team_id, COALESCE(SUM(p.planned_value),0) AS plan
         FROM plans p JOIN managers m ON m.id = p.manager_id
        WHERE ${pc.join(" AND ")}
        GROUP BY month, m.team_id`, pp);
    const scopedLead = auth.role !== "admin" ? ownTeamLead(auth.teamId) : null;
    for (const row of pr.rows) {
      const lead = row.team_id != null && SALES_TEAM_LEAD[row.team_id]
        ? canonTeamLead(SALES_TEAM_LEAD[row.team_id]) : "Шевчук Назар";
      if (scopedLead && lead !== scopedLead) continue;
      const k = `${row.month}|${lead}`;
      plans[k] = (plans[k] ?? 0) + Number(row.plan);
    }
  }

  res.json({
    department, periodType,
    scopedTo: auth.role !== "admin" && dept.hasTeamLeadBreakdown ? ownTeamLead(auth.teamId) : null,
    rows: r.rows.map((x) => ({ ...x, value: x.value === null ? null : Number(x.value) })),
    plans,
  });
});

// Запис ручних значень (лише admin). Auto/derived — 400.
statisticsRouter.put("/manual", requireRole("admin"), async (req, res) => {
  const auth = req.auth!;
  const { department, period_type, period_start, team_lead, values } = req.body ?? {};
  const dept = getDepartment(String(department ?? ""));
  if (!dept) return res.status(400).json({ error: "Невідомий відділ" });
  if (period_type !== "month" && period_type !== "week") return res.status(400).json({ error: "period_type: month|week" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(period_start ?? ""))) return res.status(400).json({ error: "period_start: YYYY-MM-DD" });
  if (!values || typeof values !== "object") return res.status(400).json({ error: "values: обʼєкт metric_key→число|null" });

  const lead = dept.hasTeamLeadBreakdown ? (team_lead ? canonTeamLead(String(team_lead)) : null) : null;

  const entries = Object.entries(values as Record<string, unknown>);
  for (const [key] of entries) {
    const met = getMetric(dept.key, key);
    if (!met) return res.status(400).json({ error: `Невідома метрика: ${key}` });
    if (met.source !== "manual") return res.status(400).json({ error: `Метрику «${met.label}» не можна редагувати вручну (${met.source})` });
  }

  for (const [key, raw] of entries) {
    const val = raw === null || raw === "" ? null : Number(raw);
    if (val !== null && !Number.isFinite(val)) return res.status(400).json({ error: `Некоректне значення для ${key}` });
    await pool.query(
      `INSERT INTO statistics_values (department, period_type, period_start, team_lead, metric_key, value, source, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',$7)
       ON CONFLICT (department, period_type, period_start, COALESCE(team_lead,''), metric_key)
       DO UPDATE SET value = EXCLUDED.value, source = 'manual', updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [dept.key, period_type, period_start, lead, key, val, `user:${auth.userId}`]
    );
  }
  res.json({ ok: true, saved: entries.length });
});
