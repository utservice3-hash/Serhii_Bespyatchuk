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
            t.created_at AS "createdAt", t.updated_at AS "updatedAt"
     FROM tasks t
     LEFT JOIN managers m ON m.id = t.assignee_id
     ${where}
     ORDER BY t.created_at DESC`,
    params
  );

  res.json({ tasks: result.rows });
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
