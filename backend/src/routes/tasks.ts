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
  priority: z.enum(PRIORITIES).optional(),
  comments: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
});

const patchSchema = upsertSchema.partial();

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
    `SELECT t.id, t.title, t.status, t.deadline, t.assignee_id AS "assigneeId",
            m.name AS "assigneeName", t.priority, t.comments, t.department,
            t.task_type AS "taskType", t.metric, t.target_value AS "targetValue",
            t.actual_value AS "actualValue", t.plan_date AS "planDate",
            t.period_start AS "periodStart", t.period_end AS "periodEnd",
            t.parent_id AS "parentId", t.auto, u.role AS "createdByRole",
            t.created_by AS "createdById", m.team_id AS "assigneeTeamId",
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
  avgCheck: z.number().nonnegative().optional(),
  conversion: z.number().min(0).max(100).optional(),
});

const METRIC_LABELS: Record<string, string> = {
  ads_count: "Кількість прийнятої реклами",
  leadgen_count: "Кількість прийнятих лідогенів",
  avg_check: "Середній чек",
  conversion: "Конверсія",
};

tasksRouter.post("/plan", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { assigneeId, period, days, adsCount, leadgenCount, avgCheck, conversion } = parsed.data;

  const sorted = [...days].sort();
  const periodStart = sorted[0];
  const periodEnd = sorted[sorted.length - 1];
  const periodLabel = period === "week" ? "тиждень" : "місяць";

  const mgr = await pool.query<{ name: string }>(`SELECT name FROM managers WHERE id = $1`, [assigneeId]);
  const mgrName = mgr.rows[0]?.name ?? "";
  const kpiType = period === "week" ? "weekly_kpi" : "monthly_kpi";
  const createdIds: number[] = [];

  // Count metrics → parent KPI task + one auto daily sub-task per working day.
  for (const [metric, total] of [["ads_count", adsCount], ["leadgen_count", leadgenCount]] as const) {
    if (!total || total <= 0) continue;
    const parent = await pool.query<{ id: number }>(
      `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, metric, target_value, period_start, period_end, auto)
       VALUES ($1,'not_started',$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
      [`План на ${periodLabel}: ${METRIC_LABELS[metric]} — ${total} (${mgrName})`,
       assigneeId, auth.userId, kpiType, metric, total, periodStart, periodEnd]
    );
    const parentId = parent.rows[0].id;
    createdIds.push(parentId);
    const daily = Math.max(1, Math.round(total / sorted.length));
    for (const day of sorted) {
      await pool.query(
        `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, metric, target_value, plan_date, parent_id, deadline, auto)
         VALUES ($1,'not_started',$2,$3,'daily_kpi',$4,$5,$6,$7,$6,true)`,
        [`${METRIC_LABELS[metric]}: ${daily}/день`, assigneeId, auth.userId, metric, daily, day, parentId]
      );
    }
  }

  // avg_check / conversion → single period-aggregate task (no daily split).
  for (const [metric, target] of [["avg_check", avgCheck], ["conversion", conversion]] as const) {
    if (target && target > 0) {
      const suffix = metric === "conversion" ? "%" : "₴";
      const r = await pool.query<{ id: number }>(
        `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, metric, target_value, period_start, period_end, auto)
         VALUES ($1,'not_started',$2,$3,$4,$5,$6,$7,$8,true) RETURNING id`,
        [`План на ${periodLabel}: ${METRIC_LABELS[metric]} ≥ ${target}${suffix} (${mgrName})`,
         assigneeId, auth.userId, kpiType, metric, target, periodStart, periodEnd]
      );
      createdIds.push(r.rows[0].id);
    }
  }

  if (createdIds.length === 0) {
    return res.status(400).json({ error: "Вкажіть хоча б одну ціль (реклама, чек або конверсія)" });
  }
  res.status(201).json({ created: createdIds.length });
});

tasksRouter.post("/", async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { title, status, deadline, priority, comments, department } = parsed.data;
  const auth = req.auth!;
  let assigneeId = parsed.data.assigneeId ?? null;

  // Who may assign to whom:
  //  • manager  → only to themselves;
  //  • team_lead → only to a manager in their own team;
  //  • admin    → anyone.
  if (auth.role === "manager") {
    assigneeId = auth.managerId;
  } else if (auth.role === "team_lead") {
    if (!assigneeId) return res.status(400).json({ error: "Оберіть менеджера" });
    const chk = await pool.query<{ ok: boolean }>(
      `SELECT (m.team_id = $1) AS ok FROM managers m WHERE m.id = $2`,
      [auth.teamId, assigneeId]
    );
    if (!chk.rows[0]?.ok) return res.status(403).json({ error: "Можна ставити задачі лише своїй команді" });
  }

  const result = await pool.query(
    `INSERT INTO tasks (title, status, deadline, assignee_id, priority, comments, department, created_by)
     VALUES ($1, COALESCE($2, 'not_started'), $3, $4, COALESCE($5, 'medium'), $6, $7, $8)
     RETURNING id`,
    [
      title,
      status ?? null,
      deadline ?? null,
      assigneeId,
      priority ?? null,
      comments ?? null,
      department ?? null,
      auth.userId,
    ]
  );

  res.status(201).json({ id: result.rows[0].id });
});

tasksRouter.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
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
  };

  for (const [key, value] of Object.entries(parsed.data)) {
    params.push(value);
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
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [Number(req.params.id)]);
  res.status(204).send();
});
