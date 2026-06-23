import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

export const teamsRouter = Router();
teamsRouter.use(requireAuth);

teamsRouter.get("/", async (_req, res) => {
  const result = await pool.query(`SELECT id, name FROM teams ORDER BY name`);
  res.json({ teams: result.rows });
});
