import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasPerm, isAdminScope, isAdminOrLead } from "../auth/rbac.js";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const STATUSES = [
  "todo_list",
  "to_realize",
  "planned",
  "not_started",
  "deferred",
  "in_progress",
  "ball_on_executor",
  "ready_for_approval",
  "done",
] as const;

const PRIORITIES = ["low", "medium", "high"] as const;

const upsertSchema = z.object({
  title: z.string().min(1),
  status: z.enum(STATUSES).optional(),
  deadline: z.string().nullable().optional(),
  assigneeId: z.number().nullable().optional(),
  // Одна задача на КІЛЬКОХ менеджерів (створюється копія кожному).
  assigneeIds: z.array(z.number()).optional(),
  priority: z.enum(PRIORITIES).optional(),
  comments: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
});

const checklistItem = z.object({
  clientKey: z.string(),
  clientName: z.string(),
  orders: z.number().optional(),
  revenue: z.number().optional(),
  lastPaid: z.string().nullable().optional(),
  category: z.string().optional(),
  paymentType: z.string().nullable().optional(),
  done: z.boolean().optional(),
  comment: z.string().nullable().optional(),
});

const subtaskItem = z.object({
  title: z.string(),
  done: z.boolean().optional(),
});

const patchSchema = upsertSchema.partial().extend({
  checklistJson: z.array(checklistItem).nullable().optional(),
  subtasksJson: z.array(subtaskItem).nullable().optional(),
});

tasksRouter.get("/", async (req, res) => {
  const auth = req.auth!;

  const conditions: string[] = [];
  const params: unknown[] = [];

  // 🔴 ВЛАСНІСТЬ ЗАДАЧ: ОСОБИСТА задача = БЕЗ виконавця (`assignee_id IS NULL`) — приватна
  // творцю (`created_by`), НЕ протікає між акаунтами навіть адміну. ПРИЗНАЧЕНА (assignee_id
  // NOT NULL — KPI/реактивація/manual менеджеру) — видимість за роллю (годує «одну цифру» у
  // Звіті, тож НЕ ховаємо). Розріз по assignee_id, не по task_type (уже так міркує гілка лід).
  if (auth.role === "manager") {
    // Менеджер: задачі, ПРИЗНАЧЕНІ йому + ВЛАСНІ особисті (щоб бачив свої, як canTouchTask).
    params.push(auth.managerId);
    const mp = params.length;
    params.push(auth.userId);
    conditions.push(`(t.assignee_id = $${mp} OR (t.assignee_id IS NULL AND t.created_by = $${params.length}))`);
  } else if (auth.role === "team_lead") {
    // Team-lead sees their own team's tasks + anything they created themselves.
    // NOT other accounts' personal tasks (those have no assignee — the old
    // `assignee_id IS NULL` clause leaked them into every team-lead's view).
    params.push(auth.teamId);
    const teamP = params.length;
    params.push(auth.userId);
    conditions.push(`(m.team_id = $${teamP} OR t.created_by = $${params.length})`);
  } else {
    // admin (та інші company-ролі): УСІ призначені/KPI задачі (наглядова видимість) + ЛИШЕ
    // ВЛАСНІ особисті. Чужі особисті (assignee-less, створені іншим акаунтом) — приватні.
    params.push(auth.userId);
    conditions.push(`(t.assignee_id IS NOT NULL OR t.created_by = $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT t.id, t.title, t.status, to_char(t.deadline, 'YYYY-MM-DD') AS deadline, t.assignee_id AS "assigneeId",
            m.name AS "assigneeName", t.priority, t.comments, t.department,
            t.task_type AS "taskType", t.metric, t.target_value AS "targetValue",
            t.actual_value AS "actualValue", to_char(t.plan_date, 'YYYY-MM-DD') AS "planDate",
            to_char(t.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(t.period_end, 'YYYY-MM-DD') AS "periodEnd",
            t.parent_id AS "parentId", t.auto, u.role AS "createdByRole",
            t.created_by AS "createdById", m.team_id AS "assigneeTeamId",
            t.metrics_json AS "metricsJson", t.checklist_json AS "checklistJson",
            t.subtasks_json AS "subtasksJson", t.pinned,
            t.o2o_type AS "o2oType", to_char(t.o2o_meeting_date, 'YYYY-MM-DD') AS "o2oMeetingDate",
            t.o2o_resolution AS "o2oResolution", t.o2o_resolved_at AS "o2oResolvedAt",
            COALESCE(rm.name, ru.email) AS "o2oResolvedByName",
            t.created_at AS "createdAt", t.updated_at AS "updatedAt"
     FROM tasks t
     LEFT JOIN managers m ON m.id = t.assignee_id
     LEFT JOIN users u ON u.id = t.created_by
     LEFT JOIN users ru ON ru.id = t.o2o_resolved_by
     LEFT JOIN managers rm ON rm.id = ru.manager_id
     ${where}
     ORDER BY t.pinned DESC, t.created_at DESC`,
    params
  );

  res.json({ tasks: result.rows });
});

// --- Weekly/monthly KPI plan (team-lead / admin) ---

const planSchema = z.object({
  assigneeId: z.number(),
  period: z.enum(["week", "month"]),
  // ISO dates (YYYY-MM-DD) the team-lead picked as working days.
  days: z.array(z.string()).min(1),
  adsCount: z.number().nonnegative().optional(),
  leadgenCount: z.number().nonnegative().optional(),
  dispatchCount: z.number().nonnegative().optional(),
  avgCheck: z.number().nonnegative().optional(),
  conversion: z.number().min(0).max(100).optional(),
  // Сума, яку менеджер має принести за період (розкладається по днях). Якщо не
  // задано — береться з місячного плану виручки (plans.payment_amount).
  paymentAmount: z.number().nonnegative().optional(),
});

const METRIC_LABELS: Record<string, string> = {
  ads_count: "Кількість прийнятої реклами",
  leadgen_count: "Кількість прийнятих лідогенів",
  dispatch_count: "Поставлені авто (за подіями)",
  avg_check: "Середній чек",
  conversion: "Конверсія",
  payment_amount: "Сума до принесення, ₴",
};

tasksRouter.post("/plan", async (req, res) => {
  const auth = req.auth!;
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { period, days, adsCount, leadgenCount, dispatchCount, avgCheck, conversion, paymentAmount } = parsed.data;
  // Хто кому може ставити план на день:
  //  • менеджер — ЛИШЕ собі (assignee форсується на себе);
  //  • тімлід — лише своїй команді;
  //  • адмін — будь-кому.
  let assigneeId = parsed.data.assigneeId;
  if (auth.role === "manager") {
    if (!auth.managerId) return res.status(403).json({ error: "Обліковий запис без менеджера" });
    assigneeId = auth.managerId;
  } else if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [assigneeId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  } else if (!isAdminScope(auth)) {
    return res.status(403).json({ error: "Немає доступу" });
  }

  const sorted = [...days].sort();
  const periodStart = sorted[0];
  const periodEnd = sorted[sorted.length - 1];

  const mgr = await pool.query<{ name: string; team_name: string | null }>(
    `SELECT m.name, tm.name AS team_name FROM managers m LEFT JOIN teams tm ON tm.id = m.team_id WHERE m.id = $1`,
    [assigneeId]
  );
  const mgrName = mgr.rows[0]?.name ?? "";
  const deptName = mgr.rows[0]?.team_name ?? null;

  // Daily revenue target ("сума") from the manager's monthly payment plan
  // (plan ÷ working days of the plan's month), if such a plan exists.
  const monthAnchor = `${periodStart.slice(0, 7)}-01`;
  const payPlanRes = await pool.query<{ v: string }>(
    `SELECT planned_value v FROM plans WHERE manager_id = $1 AND metric = 'payment_amount' AND plan_date = $2`,
    [assigneeId, monthAnchor]
  );
  let dailyPayment = 0;
  if (paymentAmount && paymentAmount > 0) {
    // Явно задана сума за період → рівномірно по обраних днях плану.
    dailyPayment = Math.round(paymentAmount / sorted.length);
  } else if (payPlanRes.rows[0]) {
    const [y, mo] = monthAnchor.split("-").map(Number);
    const dim = new Date(y, mo, 0).getDate();
    let wd = 0;
    for (let d = 1; d <= dim; d++) { const dow = new Date(y, mo - 1, d).getDay(); if (dow !== 0 && dow !== 6) wd++; }
    dailyPayment = wd > 0 ? Math.round(Number(payPlanRes.rows[0].v) / wd) : 0;
  }

  // Build the per-day metric bundle. Count metrics split evenly across days;
  // avg_check / conversion / payment apply as a daily target each day.
  const dailyMetrics: { metric: string; target: number }[] = [];
  if (adsCount && adsCount > 0) dailyMetrics.push({ metric: "ads_count", target: Math.max(1, Math.round(adsCount / sorted.length)) });
  if (leadgenCount && leadgenCount > 0) dailyMetrics.push({ metric: "leadgen_count", target: Math.max(1, Math.round(leadgenCount / sorted.length)) });
  if (dispatchCount && dispatchCount > 0) dailyMetrics.push({ metric: "dispatch_count", target: Math.max(1, Math.round(dispatchCount / sorted.length)) });
  if (avgCheck && avgCheck > 0) dailyMetrics.push({ metric: "avg_check", target: avgCheck });
  if (conversion && conversion > 0) dailyMetrics.push({ metric: "conversion", target: conversion });
  if (dailyPayment > 0) dailyMetrics.push({ metric: "payment_amount", target: dailyPayment });

  if (dailyMetrics.length === 0) {
    return res.status(400).json({ error: "Вкажіть хоча б одну ціль (реклама, лідоген, авто, чек або конверсія), або задайте місячний план виручки для «суми»" });
  }

  // ОДНА задача на період (тиждень/місяць) — «парасолька». Дні НЕ стають окремими
  // задачами у списку: вони діти (parent_id), сховані в розкривному списку задачі,
  // де видно прогрес виконано/не виконано по кожному дню. Оцінює/ретаргетить їх
  // той самий движок (evaluateKpiTasks) — діти лишаються daily_kpi.
  const periodLabel = period === "week" ? "тиждень" : "місяць";
  // Підсумкові цілі періоду для згорнутого вигляду задачі.
  const periodTargets: { metric: string; target: number; actual: number | null; done: boolean }[] = [];
  if (adsCount && adsCount > 0) periodTargets.push({ metric: "ads_count", target: adsCount, actual: null, done: false });
  if (leadgenCount && leadgenCount > 0) periodTargets.push({ metric: "leadgen_count", target: leadgenCount, actual: null, done: false });
  if (dispatchCount && dispatchCount > 0) periodTargets.push({ metric: "dispatch_count", target: dispatchCount, actual: null, done: false });
  if (avgCheck && avgCheck > 0) periodTargets.push({ metric: "avg_check", target: avgCheck, actual: null, done: false });
  if (conversion && conversion > 0) periodTargets.push({ metric: "conversion", target: conversion, actual: null, done: false });
  if (dailyPayment > 0) periodTargets.push({ metric: "payment_amount", target: paymentAmount && paymentAmount > 0 ? paymentAmount : dailyPayment * sorted.length, actual: null, done: false });

  const parentRes = await pool.query<{ id: number }>(
    // 🔴 `period_kind` ПИШЕТЬСЯ ЯВНО. Доти тип періоду жив лише у слові всередині
    // `title`, і `effectiveWeekTargets` не мав за що зачепитись — місячна парасолька
    // покриває будь-який день місяця, отже проходила як «тижнева».
    `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, plan_date, period_start, period_end, deadline, auto, metrics_json, department, period_kind)
     VALUES ($1,'not_started',$2,$3,'kpi_period',$4,$4,$5,$5,true,$6,$7,$8) RETURNING id`,
    [`План на ${periodLabel} (${mgrName}) — ${dailyMetrics.length} показник(и), ${sorted.length} дн.`,
     assigneeId, auth.userId, periodStart, periodEnd, JSON.stringify(periodTargets), deptName,
     period === "week" ? "week" : "month"]
  );
  const parentId = parentRes.rows[0].id;

  for (const day of sorted) {
    const metrics = dailyMetrics.map((m) => ({ ...m, actual: null as number | null, done: false }));
    await pool.query(
      `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, plan_date, period_start, period_end, deadline, auto, metrics_json, department, parent_id)
       VALUES ($1,'not_started',$2,$3,'daily_kpi',$4,$4,$4,$4,true,$5,$6,$7)`,
      [`День ${day} (${mgrName})`, assigneeId, auth.userId, day, JSON.stringify(metrics), deptName, parentId]
    );
  }
  res.status(201).json({ created: 1, parentId, days: sorted.length });
});

// One reactivation task per manager, bundling the picked clients as a checklist
// the manager ticks off. Team-lead → own team only; admin → anyone.
const reactivationSchema = z.object({
  /** Явний виконавець — лишається для сумісності й для клієнтів без закріпленого менеджера. */
  assigneeId: z.number().optional(),
  clients: z.array(checklistItem).min(1),
  /**
   * Розподілити пачку по ВІДПОВІДАЛЬНИХ (рішення власника 04.09.2026: «менеджер, який
   * був зафіксований; якщо такого немає — тімлід сам обирає»). Без прапорця поведінка
   * стара: одна задача на явно названого виконавця.
   */
  splitByOwner: z.boolean().optional(),
});
tasksRouter.post("/reactivation", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const parsed = reactivationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { assigneeId, clients, splitByOwner } = parsed.data;

  /**
   * 🔀 РОЗПОДІЛ ПО ВІДПОВІДАЛЬНИХ. Відповідальний — той самий COALESCE(закріплений,
   * основний за оплатами), що й скрізь на екрані клієнтів: інакше «менеджер біля
   * клієнта» і «виконавець задачі» розійшлись би, і кожна відповідь окремо була б
   * правильною. Клієнти без відповідального йдуть на `assigneeId` — той, кого тімлід
   * назвав явно (рішення власника 04.09.2026); без нього — відмова з переліком, а не
   * тихе призначення «комусь».
   */
  const ownerOf = new Map<string, number>();
  if (splitByOwner) {
    const keys = clients.map((c) => c.clientKey).filter(Boolean) as string[];
    const own = await pool.query<{ client_key: string; manager_id: number }>(
      `WITH per_cm AS (
         SELECT d.client_key, d.manager_id, COUNT(*) AS n
           FROM deals d JOIN pipeline_stage_map psm
             ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
          WHERE psm.funnel_stage = 'paid' AND d.client_key = ANY($1) AND d.manager_id IS NOT NULL
          GROUP BY 1, 2),
       primary_mgr AS (
         SELECT DISTINCT ON (client_key) client_key, manager_id
           FROM per_cm ORDER BY client_key, n DESC, manager_id)
       SELECT k AS client_key, COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id
         FROM unnest($1::text[]) AS k
         LEFT JOIN loyalty_overrides lo ON lo.client_key = k
         LEFT JOIN primary_mgr pm ON pm.client_key = k
        WHERE COALESCE(lo.pinned_manager_id, pm.manager_id) IS NOT NULL`, [keys]);
    for (const r of own.rows) ownerOf.set(r.client_key, r.manager_id);
  }

  const groups = new Map<number, typeof clients>();
  const orphans: typeof clients = [];
  for (const c of clients) {
    const owner = splitByOwner ? ownerOf.get(c.clientKey) : assigneeId;
    if (owner == null) { orphans.push(c); continue; }
    groups.set(owner, [...(groups.get(owner) ?? []), c]);
  }
  if (orphans.length) {
    if (assigneeId == null) {
      return res.status(400).json({
        error: `У ${orphans.length} клієнтів немає закріпленого менеджера — оберіть, кому їх передати`,
        orphans: orphans.map((c) => c.clientName || c.clientKey),
      });
    }
    groups.set(assigneeId, [...(groups.get(assigneeId) ?? []), ...orphans]);
  }
  if (!groups.size) return res.status(400).json({ error: "Нема кому ставити задачу" });

  const ids: number[] = [];
  for (const [owner, list] of groups) {
    const mgr = await pool.query<{ name: string; team_id: number | null }>(
      `SELECT name, team_id FROM managers WHERE id = $1`, [owner]);
    if (!mgr.rows[0]) return res.status(400).json({ error: `Менеджера ${owner} не знайдено` });
    if (auth.role === "team_lead" && mgr.rows[0].team_id !== auth.teamId) {
      return res.status(403).json({ error: "Лише своя команда" });
    }
    const checklist = list.map((c) => ({ ...c, done: false }));
    const r = await pool.query<{ id: number }>(
      `INSERT INTO tasks (title, status, assignee_id, created_by, priority, department, task_type, checklist_json)
       VALUES ($1,'not_started',$2,$3,'high','Реактивація','reactivation',$4) RETURNING id`,
      [`🔄 Реактивація клієнтів (${list.length}) — ${mgr.rows[0].name}`, owner, auth.userId, JSON.stringify(checklist)]);
    ids.push(r.rows[0].id);
  }
  res.status(201).json({ id: ids[0], ids, tasks: ids.length });
});

tasksRouter.post("/", async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { title, status, deadline, priority, comments, department } = parsed.data;
  const auth = req.auth!;

  // Список виконавців: assigneeIds (кілька) або один assigneeId. Менеджер завжди сам.
  let assignees: (number | null)[];
  if (auth.role === "manager") {
    // Справжній менеджер (managerId>0) → задача собі (як було). HR/own-scope БЕЗ валідного
    // менеджера (scope-clamp дає managerId=-1) → ОСОБИСТА задача (assignee NULL, created_by=я),
    // а не падіння на assignee_id=-1 (FK). Створення особистої гейтить екран `tasks`, не scope.
    assignees = auth.managerId && auth.managerId > 0 ? [auth.managerId] : [null];
  } else {
    const ids = parsed.data.assigneeIds?.length ? parsed.data.assigneeIds : (parsed.data.assigneeId != null ? [parsed.data.assigneeId] : []);
    if (auth.role === "team_lead") {
      if (!ids.length) return res.status(400).json({ error: "Оберіть менеджера" });
      const chk = await pool.query<{ id: number }>(
        `SELECT id FROM managers WHERE id = ANY($1) AND team_id = $2`, [ids, auth.teamId]);
      const okIds = new Set(chk.rows.map((r) => r.id));
      if (ids.some((id) => !okIds.has(id))) return res.status(403).json({ error: "Можна ставити задачі лише своїй команді" });
      assignees = ids;
    } else {
      assignees = ids.length ? ids : [null]; // admin: без виконавця = особиста задача
    }
  }
  const uniqueAssignees = [...new Set(assignees)];

  // Департамент кожному — з його команди (якщо не заданий явно).
  const deptOf = async (assigneeId: number | null): Promise<string | null> => {
    if (department) return department;
    if (!assigneeId) return null;
    const t = await pool.query<{ name: string | null }>(
      `SELECT tm.name FROM managers m LEFT JOIN teams tm ON tm.id = m.team_id WHERE m.id = $1`, [assigneeId]);
    return t.rows[0]?.name ?? null;
  };

  const ids: number[] = [];
  for (const assigneeId of uniqueAssignees) {
    const dept = await deptOf(assigneeId);
    const result = await pool.query(
      `INSERT INTO tasks (title, status, deadline, assignee_id, priority, comments, department, created_by)
       VALUES ($1, COALESCE($2, 'not_started'), $3, $4, COALESCE($5, 'medium'), $6, $7, $8)
       RETURNING id`,
      [title, status ?? null, deadline ?? null, assigneeId, priority ?? null, comments ?? null, dept, auth.userId]
    );
    ids.push(result.rows[0].id);
  }

  res.status(201).json({ id: ids[0], ids });
});

/**
 * Whether the caller may modify/delete this task — mirrors the GET visibility:
 * manager → tasks assigned to them or created by them; team_lead → their
 * team's tasks or their own; admin → everything.
 */
async function canTouchTask(
  auth: { role: string; roleKey: string; userId: number; managerId: number | null; teamId: number | null },
  taskId: number
): Promise<{ ok: boolean; found: boolean }> {
  if (isAdminScope(auth)) {
    // Дзеркалить GET: admin торкається УСІХ призначених задач + ЛИШЕ власних особистих
    // (чужі особисті — приватні). `found` — чи існує задача взагалі (для коректного 404 vs 403).
    const r = await pool.query<{ assignee_id: number | null; created_by: number | null }>(
      `SELECT assignee_id, created_by FROM tasks WHERE id = $1`, [taskId]);
    const t = r.rows[0];
    if (!t) return { ok: false, found: false };
    return { ok: t.assignee_id !== null || t.created_by === auth.userId, found: true };
  }
  const r = await pool.query<{ assignee_id: number | null; created_by: number | null; team_id: number | null }>(
    `SELECT t.assignee_id, t.created_by, m.team_id
       FROM tasks t LEFT JOIN managers m ON m.id = t.assignee_id
      WHERE t.id = $1`,
    [taskId]
  );
  const t = r.rows[0];
  if (!t) return { ok: false, found: false };
  if (auth.role === "team_lead") {
    return { ok: t.team_id === auth.teamId || t.created_by === auth.userId, found: true };
  }
  // manager
  return { ok: t.assignee_id === auth.managerId || t.created_by === auth.userId, found: true };
}

/**
 * ЗАМОК ЗАДАЧІ З 1×1 (`task_type='oneonone'`). Сенс: домовленості зі зустрічі субʼєкт
 * не може позбутися сам — знімає лише ведучий через рев'ю на наступному 1×1.
 *
 * 🔴 Замок ОБОВʼЯЗКОВО двобічний. Сам по собі DELETE-гейт декоративний: субʼєкт міг би
 * так само її знешкодити через PATCH — поставити status='done', перейменувати, зняти
 * дедлайн або відвʼязати від себе (assigneeId=null → задача стає особистою і зникає
 * з-під нагляду). Тому субʼєкту лишаємо тільки коментарі та статуси КРІМ 'done'.
 *
 * Повний доступ (правка й зняття будь-коли) — автор задачі (ведучий) або наскрізний.
 */
const O2O_SUBJECT_ALLOWED = new Set(["comments", "status"]);
/** Повний доступ до задачі з 1×1 (обходить замок субʼєкта): автор (ведучий), адмін
 *  (тепер і СЕО/ОД — scopeCompatRole), або наскрізний 1×1 (HR за правом). Субʼєкту —
 *  лише коментарі й статус, крім 'done'. */
function o2oFullAccess(auth: { userId: number; role: string; roleKey: string }, createdBy: number | null): boolean {
  return createdBy === auth.userId || isAdminScope(auth) || roleHasPerm(auth.roleKey, "view_all_1x1");
}
/** Мета задачі + чи має цей користувач ПОВНИЙ доступ до неї як до задачі з 1×1. */
async function o2oMeta(auth: { userId: number; role: string; roleKey: string }, taskId: number) {
  const r = await pool.query<{ task_type: string; created_by: number | null }>(
    "SELECT task_type, created_by FROM tasks WHERE id=$1", [taskId]);
  const t = r.rows[0];
  if (!t) return { found: false, isO2O: false, full: false };
  const isO2O = t.task_type === "oneonone";
  return { found: true, isO2O, full: isO2O && o2oFullAccess(auth, t.created_by) };
}

tasksRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const auth = req.auth!;
  const meta = await o2oMeta(auth, id);
  if (!meta.found) return res.status(404).json({ error: "Задачу не знайдено" });
  if (!meta.full) {
    const scope = await canTouchTask(auth, id);
    if (!scope.found) return res.status(404).json({ error: "Задачу не знайдено" });
    if (!scope.ok) return res.status(403).json({ error: "Немає доступу до цієї задачі" });
    if (meta.isO2O) {
      const forbidden = Object.keys(parsed.data).filter((k) => !O2O_SUBJECT_ALLOWED.has(k));
      if (forbidden.length) {
        return res.status(403).json({ error: `Задача з 1×1: змінювати «${forbidden.join(", ")}» може лише ведучий` });
      }
      if (parsed.data.status === "done") {
        return res.status(403).json({ error: "Задача з 1×1 закривається лише на наступному 1×1 — ведучим" });
      }
    }
  }
  // Reassignment is scoped like task creation: a manager only to themselves, a
  // team-lead only within their team.
  if (parsed.data.assigneeId !== undefined && !isAdminScope(auth)) {
    const newAssignee = parsed.data.assigneeId;
    if (auth.role === "manager" && newAssignee !== auth.managerId && newAssignee !== null) {
      return res.status(403).json({ error: "Менеджер не може передавати задачі іншим" });
    }
    if (auth.role === "team_lead" && newAssignee != null) {
      const chk = await pool.query<{ ok: boolean }>(
        `SELECT (team_id = $1) AS ok FROM managers WHERE id = $2`,
        [auth.teamId, newAssignee]
      );
      if (!chk.rows[0]?.ok) return res.status(403).json({ error: "Можна призначати лише своїй команді" });
    }
  }

  const fields: string[] = [];
  const params: unknown[] = [];
  const columnByKey: Record<string, string> = {
    title: "title",
    status: "status",
    deadline: "deadline",
    assigneeId: "assignee_id",
    priority: "priority",
    comments: "comments",
    department: "department",
    checklistJson: "checklist_json",
    subtasksJson: "subtasks_json",
  };

  for (const [key, value] of Object.entries(parsed.data)) {
    params.push(key === "checklistJson" || key === "subtasksJson" ? JSON.stringify(value) : value);
    fields.push(`${columnByKey[key]} = $${params.length}`);
  }
  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }
  params.push(id);

  await pool.query(
    `UPDATE tasks SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
    params
  );

  res.status(204).send();
});

tasksRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const auth = req.auth!;
  const meta = await o2oMeta(auth, id);
  if (!meta.found) return res.status(404).json({ error: "Задачу не знайдено" });
  // Задачу з 1×1 знімає лише ведучий (автор) або наскрізний — субʼєкту 403.
  if (!meta.full) {
    const scope = await canTouchTask(auth, id);
    if (!scope.found) return res.status(404).json({ error: "Задачу не знайдено" });
    if (!scope.ok) return res.status(403).json({ error: "Немає доступу до цієї задачі" });
    if (meta.isO2O) return res.status(403).json({ error: "Задачу з 1×1 знімає лише ведучий" });
  }
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
  res.status(204).send();
});
