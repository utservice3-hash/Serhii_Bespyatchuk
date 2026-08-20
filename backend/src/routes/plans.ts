import { Router } from "express";
import { isAdminScope, isAdminOrLead } from "../auth/rbac.js";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import type { AuthPayload } from "../auth/auth.js";
import * as money from "../core/money.js";
import { getSettings } from "./settings.js";
import * as metrics from "../core/metrics.js";
import { planRecommendation, baseMonthsFor } from "../core/plans.js";
import { monthEndOf } from "../core/dates.js";

export const plansRouter = Router();
plansRouter.use(requireAuth);

// «YYYY-MM» | «YYYY-MM-DD» → 'YYYY-MM-01'; попередній місяць; N місяців тому (перше число).
const monthStartOf = (m: string) => m.slice(0, 7) + "-01";
const shiftMonth = (m: string, back: number) => { const [y, mm] = m.split("-").map(Number); return new Date(Date.UTC(y, mm - 1 - back, 1)).toISOString().slice(0, 10); };

const upsertSchema = z.object({
  managerId: z.number(),
  planDate: z.string(),
  metric: z.enum(["lead_taken", "quote_requested", "approved", "invoiced", "paid", "payment_amount", "repeat_payment_amount"]),
  plannedValue: z.number(),
});

// 🔒 GOVERNANCE (рішення власника): ПРЯМИЙ запис у сакральний `plans` — ЛИШЕ admin.
// Тімлід НЕ пише в plans повз двоетапне погодження: він формує план через «Формування»
// (POST /formation/submit → status='submitted'), а число в `plans` лягає ВИКЛЮЧНО на
// admin-approve (/formation/approve). Грід-редактор для тімліда — read-only (FE), а тут
// сервер це підкріплює: єдиний інший writer у `plans` — саме /formation/approve (admin).
plansRouter.post("/", requireRole("admin"), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { managerId, planDate, metric, plannedValue } = parsed.data;

  await pool.query(
    `INSERT INTO plans (manager_id, plan_date, metric, planned_value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (manager_id, plan_date, metric)
     DO UPDATE SET planned_value = EXCLUDED.planned_value`,
    [managerId, planDate, metric, plannedValue]
  );

  res.status(204).send();
});

plansRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  const managerId = auth.role === "manager" ? auth.managerId : Number(req.query.managerId);
  if (!managerId) return res.status(400).json({ error: "managerId is required" });

  const result = await pool.query(
    `SELECT plan_date, metric, planned_value FROM plans WHERE manager_id = $1 ORDER BY plan_date`,
    [managerId]
  );
  res.json({ plans: result.rows });
});

// ───────────────────────── ФОРМУВАННЯ ПЛАНУ (двоетапне погодження) ─────────────────────────
// Роль-скоуп: manager → своя команда (read-only); team_lead → своя команда (подає);
// admin → усі (?teamId фільтр), затверджує/повертає. У сакральний `plans` пише ЛИШЕ approve.

/** Резолвер teamId зі скоупу ролі (manager/team_lead → своя команда; admin → ?teamId|усі). */
async function formationScope(auth: AuthPayload, qTeamId?: string): Promise<{ teamId: number | null; canApprove: boolean; canSubmit: boolean }> {
  if (isAdminScope(auth)) return { teamId: qTeamId ? Number(qTeamId) : null, canApprove: true, canSubmit: true };
  if (auth.role === "team_lead") return { teamId: auth.teamId, canApprove: false, canSubmit: true };
  // manager → своя команда, лише читання
  const tr = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [auth.managerId]);
  return { teamId: tr.rows[0]?.team_id ?? null, canApprove: false, canSubmit: false };
}

plansRouter.get("/formation", async (req, res) => {
  const auth = req.auth!;
  const month = monthStartOf(String(req.query.month ?? ""));
  if (!/^\d{4}-\d{2}-01$/.test(month)) return res.status(400).json({ error: "month (YYYY-MM) обовʼязковий" });
  const growthPct = req.query.growth != null ? Number(req.query.growth) : 0.10;
  const { teamId, canApprove, canSubmit } = await formationScope(auth, req.query.teamId as string | undefined);

  const refMonth = shiftMonth(month, 1);            // останній ЗАВЕРШЕНИЙ місяць (клієнт-спліт/історія-хвіст)
  const refFrom = refMonth, refTo = monthEndOf(refMonth);
  const histFrom = shiftMonth(month, 6);            // 6 повних місяців, що закінчуються refMonth
  const scopeM: money.MoneyScope = { teamId };
  const scopeMetric: metrics.MetricScope = { teamId };

  // Ростер активних менеджерів у скоупі, згруповано по команді.
  const roster = (await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE m.is_active ${teamId ? "AND m.team_id = $1" : "AND m.team_id IS NOT NULL"}
      ORDER BY t.name NULLS LAST, m.name`, teamId ? [teamId] : []
  )).rows;

  // 🔴 ДОВІДКОВО: Σ ЗАТВЕРДЖЕНИХ планів по клієнтах за TARGET-місяць.
  // Рішення власника 03.08.2026: ручне поле «постійні принесуть» ЛИШАЄТЬСЯ, а ця
  // цифра стоїть ПОРУЧ. Розбіжність між ними має бути ВИДИМОЮ, а не мовчазною —
  // той самий принцип, що з відповідальним менеджером: показуємо конфлікт, а не
  // ховаємо. Тому тут НЕ окремий підрахунок: беремо ті самі рядки
  // `repeat_client_plans` зі статусом 'approved', що й екран клієнтів.
  const [hist, split, carry, plansRows, formRows, repeatApproved] = await Promise.all([
    money.successByManagerMonth({ ...scopeM, from: histFrom, to: refTo }),
    metrics.clientSplitForPlan({ ...scopeMetric, from: refFrom, to: refTo }),
    metrics.carryoverByManager({ teamId }, month),
    pool.query<{ manager_id: number; planned_value: string; metric: string }>(
      `SELECT manager_id, planned_value, metric FROM plans WHERE plan_date = $1 AND metric IN ('payment_amount','repeat_payment_amount')`, [month]),
    pool.query<{ manager_id: number; proposed_value: string; status: string; comment: string | null; return_comment: string | null;
      below_min: boolean; submitted_by: number | null; submitted_at: string | null; submitted_name: string | null;
      decided_by: number | null; decided_at: string | null; decided_name: string | null }>(
      `SELECT pf.manager_id, pf.proposed_value, pf.status, pf.comment, pf.return_comment, pf.below_min,
              pf.submitted_by, to_char(pf.submitted_at,'YYYY-MM-DD') AS submitted_at, COALESCE(sm.name, su.email) AS submitted_name,
              pf.decided_by, to_char(pf.decided_at,'YYYY-MM-DD') AS decided_at, COALESCE(dm.name, du.email) AS decided_name
         FROM plan_formation pf
         LEFT JOIN users su ON su.id = pf.submitted_by LEFT JOIN managers sm ON sm.id = su.manager_id
         LEFT JOIN users du ON du.id = pf.decided_by LEFT JOIN managers dm ON dm.id = du.manager_id
        WHERE pf.month = $1 AND pf.metric = 'payment_amount'`, [month]),
    pool.query<{ manager_id: number; approved_sum: string; approved_clients: string; total_sum: string }>(
      `SELECT manager_id,
              COALESCE(SUM(plan) FILTER (WHERE status = 'approved'), 0) AS approved_sum,
              COUNT(*) FILTER (WHERE status = 'approved') AS approved_clients,
              COALESCE(SUM(plan), 0) AS total_sum
         FROM repeat_client_plans WHERE month = $1 AND manager_id IS NOT NULL
        GROUP BY manager_id`, [month]),
  ]);
  const repeatMap = new Map(repeatApproved.rows.map((r) => [r.manager_id, r]));

  // Історія → map manager → month → {rev,deals}; 6-міс ряд + 3-міс база рекомендації.
  const histMonths = [6, 5, 4, 3, 2, 1].map((b) => shiftMonth(month, b)); // старий→новий, закінчується refMonth
  const histMap = new Map<number, Map<string, { revenue: number; deals: number }>>();
  for (const r of hist) { const mm = histMap.get(r.managerId) ?? new Map(); mm.set(r.bucket, { revenue: r.revenue, deals: r.deals }); histMap.set(r.managerId, mm); }
  const splitMap = new Map(split.map((s) => [s.managerId, s]));
  const carryMap = new Map(carry.map((c) => [c.managerId, c.amount]));
  const planMap = new Map(plansRows.rows.filter((p) => p.metric === "payment_amount").map((p) => [p.manager_id, Number(p.planned_value)]));
  // Ручне поле «постійні принесуть» — лишається як є (рішення власника); поруч
  // із ним фронт покаже Σ затверджених, і розбіжність буде видно.
  const repeatPlanMap = new Map(plansRows.rows.filter((p) => p.metric === "repeat_payment_amount").map((p) => [p.manager_id, Number(p.planned_value)]));
  const formMap = new Map(formRows.rows.map((f) => [f.manager_id, f]));
  const baseM = baseMonthsFor(month); // 3 повні місяці перед target

  const mgrOut = roster.map((m) => {
    const mh = histMap.get(m.id) ?? new Map();
    const history = histMonths.map((mo) => ({ month: mo, revenue: mh.get(mo)?.revenue ?? 0, deals: mh.get(mo)?.deals ?? 0 }));
    const recBase = baseM.map((mo) => ({ month: mo, revenue: mh.get(mo)?.revenue ?? 0, deals: mh.get(mo)?.deals ?? 0 }));
    const rec = planRecommendation(recBase, month, growthPct);
    const sp = splitMap.get(m.id);
    const f = formMap.get(m.id);
    return {
      managerId: m.id, name: m.name, teamId: m.team_id, teamName: m.team_name,
      history,
      recommendation: { value: rec.recommendation, perWorkingDay: rec.perWorkingDay, baseSum: rec.baseSum, baseWorkingDays: rec.baseWorkingDays, targetWorkingDays: rec.targetWorkingDays, baseMonthlyAvg: rec.baseMonthlyAvg, growthPct: rec.growthPct, sparseHistory: rec.sparseHistory },
      // 🔴 ДВА БЛОКИ РІЗНОЇ ПРИРОДИ (18.08.2026). `repeat/new/undef` — ПАРТИЦІЯ
      // новизни, вона й тільки вона складається в `total`. `source` — накладка
      // ДЖЕРЕЛА: лідоген і реклама є ПІДМНОЖИНАМИ партиції. Доти `leadgen` стояв
      // четвертим класом поряд із «постійними», тож постійний клієнт, приведений
      // лідогеном, не рахувався постійним ніде.
      clients: {
        repeat: { count: sp?.repeatCount ?? 0, sum: Math.round(sp?.repeatRevenue ?? 0) },
        new: { count: sp?.newCount ?? 0, sum: Math.round(sp?.newRevenue ?? 0) },
        undef: { count: sp?.undefCount ?? 0, sum: Math.round(sp?.undefRevenue ?? 0) },
        total: { count: sp?.total ?? 0, sum: Math.round(sp?.totalRevenue ?? 0) },
        source: {
          leadgen: { count: sp?.leadgenCount ?? 0, sum: Math.round(sp?.leadgenRevenue ?? 0) },
          ad: { count: sp?.adCount ?? 0, sum: Math.round(sp?.adRevenue ?? 0) },
        },
      },
      carryover: Math.round(carryMap.get(m.id) ?? 0),
      currentPlan: Math.round(planMap.get(m.id) ?? 0),
      // Довідкова цифра з екрана «Постійні клієнти». `approved` — те, що
      // система вважає планом по постійних; `declared` — ручне поле. Обидва
      // віддаються окремо, щоб фронт МІГ показати розбіжність, а не мусив
      // здогадуватись, яка з них «правильна».
      repeatClients: {
        approved: Math.round(Number(repeatMap.get(m.id)?.approved_sum ?? 0)),
        approvedClients: Number(repeatMap.get(m.id)?.approved_clients ?? 0),
        entered: Math.round(Number(repeatMap.get(m.id)?.total_sum ?? 0)),
        declared: Math.round(Number(repeatPlanMap.get(m.id) ?? 0)),
      },
      formation: f ? {
        status: f.status, proposedValue: Math.round(Number(f.proposed_value)), comment: f.comment, returnComment: f.return_comment,
        belowMin: f.below_min === true,
        submittedBy: f.submitted_name, submittedAt: f.submitted_at, decidedBy: f.decided_name, decidedAt: f.decided_at,
      } : { status: "draft", proposedValue: null, comment: null, returnComment: null, belowMin: false, submittedBy: null, submittedAt: null, decidedBy: null, decidedAt: null },
    };
  });

  // Групування по командах + лічильники шапки (рекомендовано/перенесено/затверджено/подано).
  const teamsMap = new Map<string, { teamId: number | null; teamName: string; managers: typeof mgrOut }>();
  for (const m of mgrOut) {
    const key = String(m.teamId ?? "none");
    const e = teamsMap.get(key) ?? { teamId: m.teamId, teamName: m.teamName ?? "Без команди", managers: [] as typeof mgrOut };
    e.managers.push(m); teamsMap.set(key, e);
  }
  const teams = [...teamsMap.values()].map((t) => {
    const recommended = t.managers.reduce((a, m) => a + m.recommendation.value, 0);
    const carryover = t.managers.reduce((a, m) => a + m.carryover, 0);
    const approved = t.managers.filter((m) => m.formation.status === "approved").length;
    const submitted = t.managers.filter((m) => m.formation.status === "submitted").length;
    return { teamId: t.teamId, teamName: t.teamName, total: t.managers.length, recommended, carryover, approved, submitted, managers: t.managers };
  });

  // Мʼяка нижня межа з НАЛАШТУВАНЬ (не хардкод): фронт блокує подачу без
  // обґрунтування, сервер перевіряє те саме нижче — фронту тут не довіряємо.
  const { planMinPerManager } = await getSettings();
  res.json({ month, refMonth, growthPct, role: auth.role, canApprove, canSubmit, minPerManager: planMinPerManager, teams });
});

/** Лазі-дриліл: розклад ПОСТІЙНИХ по клієнтах (розкривається під рядком «Постійні»). */
plansRouter.get("/formation/repeat-clients", async (req, res) => {
  const auth = req.auth!;
  const managerId = Number(req.query.managerId);
  const month = monthStartOf(String(req.query.month ?? ""));
  if (!managerId || !/^\d{4}-\d{2}-01$/.test(month)) return res.status(400).json({ error: "managerId + month обовʼязкові" });
  // Роль-скоуп: manager/team_lead — лише своя команда; admin — будь-хто.
  if (!isAdminScope(auth)) {
    const myTeam = auth.role === "team_lead" ? auth.teamId
      : (await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [auth.managerId])).rows[0]?.team_id ?? null;
    const tgt = (await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId])).rows[0]?.team_id ?? null;
    if (myTeam == null || tgt !== myTeam) return res.status(403).json({ error: "Лише своя команда" });
  }
  const bd = await metrics.repeatClientsBreakdown(managerId, month, 4);
  res.json(bd);
});

const submitSchema = z.object({ managerId: z.number(), month: z.string(), proposedValue: z.number(), comment: z.string().optional() });
plansRouter.post("/formation/submit", requireRole("admin", "team_lead"), async (req, res) => {
  const auth = req.auth!;
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { managerId, proposedValue, comment } = parsed.data;
  const month = monthStartOf(parsed.data.month);
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  // 🔴 МʼЯКА МЕЖА, але перевіряється НА СЕРВЕРІ: нижче мінімуму — лише з обґрунтуванням.
  // Фронт блокує кнопку, проте покладатись на нього не можна (запит шлеться напряму).
  const { planMinPerManager } = await getSettings();
  if (proposedValue < planMinPerManager && !String(comment ?? "").trim()) {
    return res.status(400).json({
      error: `План ${proposedValue.toLocaleString("uk-UA")} ₴ нижчий за мінімум ` +
        `${planMinPerManager.toLocaleString("uk-UA")} ₴ — потрібне обґрунтування.`,
    });
  }
  // Прапорець ставить СЕРВЕР за фактичним порогом на момент подачі — фронт на нього не впливає.
  const belowMin = planMinPerManager > 0 && proposedValue < planMinPerManager;
  await pool.query(
    `INSERT INTO plan_formation (manager_id, month, metric, proposed_value, status, comment, below_min, submitted_by, submitted_at, updated_at)
     VALUES ($1, $2, 'payment_amount', $3, 'submitted', $4, $5, $6, now(), now())
     ON CONFLICT (manager_id, month, metric) DO UPDATE
        SET proposed_value = EXCLUDED.proposed_value, status = 'submitted', comment = EXCLUDED.comment,
            below_min = EXCLUDED.below_min,
            submitted_by = EXCLUDED.submitted_by, submitted_at = now(), return_comment = NULL, updated_at = now()`,
    [managerId, month, proposedValue, comment ?? null, belowMin, auth.userId]
  );
  res.json({ ok: true, status: "submitted" });
});

const approveSchema = z.object({ managerId: z.number().optional(), teamId: z.number().optional(), month: z.string() });
plansRouter.post("/formation/approve", requireRole("admin"), async (req, res) => {
  const auth = req.auth!;
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const month = monthStartOf(parsed.data.month);
  const { managerId, teamId } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Кого затверджуємо: конкретний менеджер АБО всі 'submitted' у команді (батч).
    const sel: unknown[] = [month];
    let scopeSql = "";
    if (managerId) { sel.push(managerId); scopeSql = `AND pf.manager_id = $${sel.length}`; }
    else if (teamId) { sel.push(teamId); scopeSql = `AND m.team_id = $${sel.length}`; }
    const rows = (await client.query<{ manager_id: number; proposed_value: string }>(
      `SELECT pf.manager_id, pf.proposed_value
         FROM plan_formation pf JOIN managers m ON m.id = pf.manager_id
        WHERE pf.month = $1 AND pf.metric = 'payment_amount' AND pf.status = 'submitted' ${scopeSql}
        FOR UPDATE OF pf`, sel)).rows;
    for (const r of rows) {
      // Сакральний `plans` — ЛИШЕ дозволений metric='payment_amount' (не тиражуємо repeat-баг).
      await client.query(
        `INSERT INTO plans (manager_id, plan_date, metric, planned_value)
         VALUES ($1, $2, 'payment_amount', $3)
         ON CONFLICT (manager_id, plan_date, metric) DO UPDATE SET planned_value = EXCLUDED.planned_value`,
        [r.manager_id, month, Number(r.proposed_value)]
      );
      await client.query(
        `UPDATE plan_formation SET status = 'approved', decided_by = $3, decided_at = now(), updated_at = now()
          WHERE manager_id = $1 AND month = $2 AND metric = 'payment_amount'`,
        [r.manager_id, month, auth.userId]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, approved: rows.length });
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally {
    client.release();
  }
});

const returnSchema = z.object({ managerId: z.number(), month: z.string(), returnComment: z.string().optional() });
plansRouter.post("/formation/return", requireRole("admin"), async (req, res) => {
  const auth = req.auth!;
  const parsed = returnSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const month = monthStartOf(parsed.data.month);
  const { managerId, returnComment } = parsed.data;
  // `plans` НЕ чіпаємо — діє попередній затверджений план (якщо був).
  const r = await pool.query(
    `UPDATE plan_formation SET status = 'returned', return_comment = $3, decided_by = $4, decided_at = now(), updated_at = now()
      WHERE manager_id = $1 AND month = $2 AND metric = 'payment_amount' AND status = 'submitted'`,
    [managerId, month, returnComment ?? null, auth.userId]
  );
  if (r.rowCount === 0) return res.status(409).json({ error: "Немає поданого плану для повернення" });
  res.json({ ok: true, status: "returned" });
});
