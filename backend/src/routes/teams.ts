import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

export const teamsRouter = Router();
teamsRouter.use(requireAuth);

teamsRouter.get("/", async (_req, res) => {
  const result = await pool.query(`SELECT id, name FROM teams ORDER BY name`);
  res.json({ teams: result.rows });
});

teamsRouter.get("/managers", async (req, res) => {
  const auth = req.auth!;
  // A team-lead only sees (and can assign tasks to) their own team; admin/КВП
  // sees everyone; a manager only themselves.
  const params: unknown[] = [];
  const conds = ["is_active = true"];
  if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`team_id = $${params.length}`); }
  else if (auth.role === "manager") { params.push(auth.managerId); conds.push(`id = $${params.length}`); }
  const result = await pool.query(
    `SELECT id, name FROM managers WHERE ${conds.join(" AND ")} ORDER BY name`,
    params
  );
  res.json({ managers: result.rows });
});
