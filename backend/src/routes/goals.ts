import { Router } from "express";
import { isAdminScope, isAdminOrLead } from "../auth/rbac.js";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";

// Monthly goals ("Місячні цілі") — a high-level objectives tracker for team
// leads and the КВП, separate from the numeric plans. Team-lead sees & edits
// their own team's goals; admin sees all and may scope to a team or department.
export const goalsRouter = Router();
goalsRouter.use(requireAuth);

const upsert = z.object({
  month: z.string(),           // YYYY-MM
  title: z.string().min(1),
  target: z.string().nullable().optional(),
  status: z.enum(["in_progress", "done"]).optional(),
  comment: z.string().nullable().optional(),
  teamId: z.number().nullable().optional(),
});

goalsRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const month = ((req.query.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const params: unknown[] = [month];
  let scope = "";
  // Visibility is by AUTHOR, so a team lead sees only their own goals and no one
  // sees the КВП's goals. Admin has two views: «Мої» (created by me) and «Цілі
  // команд» (everyone else's, optionally filtered by team).
  if (auth.role === "team_lead") {
    params.push(auth.userId); scope = `AND g.created_by = $${params.length}`;
  } else if (req.query.scope === "teams") {
    params.push(auth.userId); scope = `AND g.created_by <> $${params.length}`;
    if (req.query.teamId) { params.push(Number(req.query.teamId)); scope += ` AND g.team_id = $${params.length}`; }
  } else {
    params.push(auth.userId); scope = `AND g.created_by = $${params.length}`;
  }
  const r = await pool.query(
    `SELECT g.id, to_char(g.month, 'YYYY-MM') AS month, g.team_id AS "teamId", t.name AS "teamName",
            g.title, g.target, g.status, g.comment, g.created_by AS "createdById",
            COALESCE(mm.name, u.email) AS "authorName"
       FROM monthly_goals g
       LEFT JOIN teams t ON t.id = g.team_id
       LEFT JOIN users u ON u.id = g.created_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE g.month = $1 ${scope}
      ORDER BY g.status = 'done', g.created_at`,
    params
  );
  res.json({ goals: r.rows });
});

goalsRouter.post("/", requireRole("admin", "team_lead"), async (req, res) => {
  const parsed = upsert.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const auth = req.auth!;
  const { month, title, target, status, comment } = parsed.data;
  // Team-lead goals are pinned to their own team; admin may pick a team or leave
  // it department-wide (null).
  const teamId = auth.role === "team_lead" ? auth.teamId ?? null : (parsed.data.teamId ?? null);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO monthly_goals (month, team_id, title, target, status, comment, created_by)
     VALUES ($1, $2, $3, $4, COALESCE($5,'in_progress'), $6, $7) RETURNING id`,
    [`${month}-01`, teamId, title, target ?? null, status ?? null, comment ?? null, auth.userId]
  );
  res.status(201).json({ id: r.rows[0].id });
});

goalsRouter.patch("/:id", requireRole("admin", "team_lead"), async (req, res) => {
  const id = Number(req.params.id);
  const auth = req.auth!;
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ created_by: number | null }>(`SELECT created_by FROM monthly_goals WHERE id = $1`, [id]);
    if (!chk.rows[0]) return res.status(404).json({ error: "Not found" });
    if (chk.rows[0].created_by !== auth.userId) return res.status(403).json({ error: "Лише свої цілі" });
  }
  const cols: Record<string, string> = { title: "title", target: "target", status: "status", comment: "comment" };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, col] of Object.entries(cols)) {
    if (k in req.body) { params.push(req.body[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (sets.length === 0) return res.json({ ok: true });
  params.push(id);
  await pool.query(`UPDATE monthly_goals SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  res.json({ ok: true });
});

goalsRouter.delete("/:id", requireRole("admin", "team_lead"), async (req, res) => {
  const id = Number(req.params.id);
  const auth = req.auth!;
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ created_by: number | null }>(`SELECT created_by FROM monthly_goals WHERE id = $1`, [id]);
    if (chk.rows[0] && chk.rows[0].created_by !== auth.userId) return res.status(403).json({ error: "Лише свої цілі" });
  }
  await pool.query(`DELETE FROM monthly_goals WHERE id = $1`, [id]);
  res.status(204).send();
});
