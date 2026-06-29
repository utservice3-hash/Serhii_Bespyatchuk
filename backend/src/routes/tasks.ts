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
    params.push(auth.teamId);
    conditions.push(`(m.team_id = $${params.length} OR t.assignee_id IS NULL)`);
  }
  // admin sees everything.

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT t.id, t.title, t.status, t.deadline, t.assignee_id AS "assigneeId",
            m.name AS "assigneeName", t.priority, t.comments, t.department,
            t.task_type AS "taskType", t.metric, t.target_value AS "targetValue",
            t.actual_value AS "actualValue", t.plan_date AS "planDate",
            t.period_start AS "periodStart", t.period_end AS "periodEnd",
            t.parent_id AS "parentId", t.auto,
            t.created_at AS "createdAt", t.updated_at AS "updatedAt"
     FROM tasks t
     LEFT JOIN managers m ON m.id = t.assignee_id
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
  avgCheck: z.number().nonnegative().optional(),
  conversion: z.number().min(0).max(100).optional(),
});

const METRIC_LABELS: Record<string, string> = {
  ads_count: "Кількість прийнятої реклами",
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
  const { assigneeId, period, days, adsCount, avgCheck, conversion } = parsed.data;

  const sorted = [...days].sort();
  const periodStart = sorted[0];
  const periodEnd = sorted[sorted.length - 1];
  const periodLabel = period === "week" ? "тиждень" : "місяць";

  const mgr = await pool.query<{ name: string }>(`SELECT name FROM managers WHERE id = $1`, [assigneeId]);
  const mgrName = mgr.rows[0]?.name ?? "";
  const kpiType = period === "week" ? "weekly_kpi" : "monthly_kpi";
  const createdIds: number[] = [];

  // ads_count → parent KPI task + one auto daily sub-task per working day.
  if (adsCount && adsCount > 0) {
    const parent = await pool.query<{ id: number }>(
      `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, metric, target_value, period_start, period_end, auto)
       VALUES ($1,'not_started',$2,$3,$4,'ads_count',$5,$6,$7,true) RETURNING id`,
      [`План на ${periodLabel}: ${METRIC_LABELS.ads_count} — ${adsCount} (${mgrName})`,
       assigneeId, auth.userId, kpiType, adsCount, periodStart, periodEnd]
    );
    const parentId = parent.rows[0].id;
    createdIds.push(parentId);
    const daily = Math.max(1, Math.round(adsCount / sorted.length));
    for (const day of sorted) {
      await pool.query(
        `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, metric, target_value, plan_date, parent_id, deadline, auto)
         VALUES ($1,'not_started',$2,$3,'daily_kpi','ads_count',$4,$5,$6,$5,true)`,
        [`${METRIC_LABELS.ads_count}: ${daily}/день`, assigneeId, auth.userId, daily, day, parentId]
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
  const { title, status, deadline, assigneeId, priority, comments, department } = parsed.data;

  const result = await pool.query(
    `INSERT INTO tasks (title, status, deadline, assignee_id, priority, comments, department, created_by)
     VALUES ($1, COALESCE($2, 'not_started'), $3, $4, COALESCE($5, 'medium'), $6, $7, $8)
     RETURNING id`,
    [
      title,
      status ?? null,
      deadline ?? null,
      assigneeId ?? null,
      priority ?? null,
      comments ?? null,
      department ?? null,
      req.auth!.userId,
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
