import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

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

  if (auth.role === "manager") {
    params.push(auth.managerId);
    conditions.push(`t.assignee_id = $${params.length}`);
  } else if (auth.role === "team_lead") {
    // Team-lead sees their own team's tasks + anything they created themselves.
    // NOT the admin's personal tasks (those have no assignee — the old
    // `assignee_id IS NULL` clause leaked them into every team-lead's view).
    params.push(auth.teamId);
    const teamP = params.length;
    params.push(auth.userId);
    conditions.push(`(m.team_id = $${teamP} OR t.created_by = $${params.length})`);
  }
  // admin sees everything (frontend splits into «Мої» / «Усі» tabs).

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
            t.subtasks_json AS "subtasksJson",
            t.created_at AS "createdAt", t.updated_at AS "updatedAt"
     FROM tasks t
     LEFT JOIN managers m ON m.id = t.assignee_id
     LEFT JOIN users u ON u.id = t.created_by
     ${where}
     ORDER BY t.created_at DESC`,
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
  dispatch_count: "Кількість поставлених авто",
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
  } else if (auth.role !== "admin") {
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

  // One composite daily_kpi task per working day, bundling all the day's targets.
  const createdIds: number[] = [];
  for (const day of sorted) {
    const metrics = dailyMetrics.map((m) => ({ ...m, actual: null as number | null, done: false }));
    const r = await pool.query<{ id: number }>(
      `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, plan_date, period_start, period_end, deadline, auto, metrics_json, department)
       VALUES ($1,'not_started',$2,$3,'daily_kpi',$4,$4,$4,$4,true,$5,$6) RETURNING id`,
      [`План на день ${day} — ${dailyMetrics.length} показник(и) (${mgrName})`,
       assigneeId, auth.userId, day, JSON.stringify(metrics), deptName]
    );
    createdIds.push(r.rows[0].id);
  }
  res.status(201).json({ created: createdIds.length });
});

// One reactivation task per manager, bundling the picked clients as a checklist
// the manager ticks off. Team-lead → own team only; admin → anyone.
const reactivationSchema = z.object({
  assigneeId: z.number(),
  clients: z.array(checklistItem).min(1),
});
tasksRouter.post("/reactivation", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const parsed = reactivationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { assigneeId, clients } = parsed.data;

  const mgr = await pool.query<{ name: string; team_id: number | null }>(
    `SELECT name, team_id FROM managers WHERE id = $1`, [assigneeId]
  );
  if (!mgr.rows[0]) return res.status(400).json({ error: "Менеджера не знайдено" });
  if (auth.role === "team_lead" && mgr.rows[0].team_id !== auth.teamId) {
    return res.status(403).json({ error: "Лише своя команда" });
  }

  const checklist = clients.map((c) => ({ ...c, done: false }));
  const r = await pool.query<{ id: number }>(
    `INSERT INTO tasks (title, status, assignee_id, created_by, priority, department, task_type, checklist_json)
     VALUES ($1,'not_started',$2,$3,'high','Реактивація','reactivation',$4) RETURNING id`,
    [`🔄 Реактивація клієнтів (${clients.length}) — ${mgr.rows[0].name}`, assigneeId, auth.userId, JSON.stringify(checklist)]
  );
  res.status(201).json({ id: r.rows[0].id });
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
    assignees = [auth.managerId];
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
  auth: { role: string; userId: number; managerId: number | null; teamId: number | null },
  taskId: number
): Promise<{ ok: boolean; found: boolean }> {
  if (auth.role === "admin") {
    const r = await pool.query(`SELECT 1 FROM tasks WHERE id = $1`, [taskId]);
    return { ok: (r.rowCount ?? 0) > 0, found: (r.rowCount ?? 0) > 0 };
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

tasksRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const auth = req.auth!;
  const scope = await canTouchTask(auth, id);
  if (!scope.found) return res.status(404).json({ error: "Задачу не знайдено" });
  if (!scope.ok) return res.status(403).json({ error: "Немає доступу до цієї задачі" });
  // Reassignment is scoped like task creation: a manager only to themselves, a
  // team-lead only within their team.
  if (parsed.data.assigneeId !== undefined && auth.role !== "admin") {
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
  const scope = await canTouchTask(req.auth!, id);
  if (!scope.found) return res.status(404).json({ error: "Задачу не знайдено" });
  if (!scope.ok) return res.status(403).json({ error: "Немає доступу до цієї задачі" });
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
  res.status(204).send();
});
