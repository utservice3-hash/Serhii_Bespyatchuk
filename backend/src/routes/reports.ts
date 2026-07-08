import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { runReadOnly } from "../ai/readQuery.js";

/**
 * «Мої звіти»: renders the AI-built widgets (ai_widgets). Every authenticated
 * user may view, but each widget's `visibility` scopes who gets it:
 *   all   → everyone,  leads → team_lead+admin,  admin → admin only.
 * The SQL runs read-only per request so figures are always live from the DB.
 * Widget CRUD is done by the AI (see ai/respond.ts); admins can also delete here.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth);

function visibilityFilter(role: string): string[] {
  if (role === "admin") return ["all", "leads", "admin"];
  if (role === "team_lead") return ["all", "leads"];
  return ["all"];
}

reportsRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  const vis = visibilityFilter(auth.role);
  const r = await pool.query<{
    id: number; title: string; chart_type: string; sql: string; config: unknown; visibility: string;
  }>(
    `SELECT id, title, chart_type, sql, config, visibility
       FROM ai_widgets WHERE visibility = ANY($1) ORDER BY sort_order, id`,
    [vis]
  );
  const widgets = await Promise.all(
    r.rows.map(async (w) => {
      const run = await runReadOnly(w.sql);
      return {
        id: w.id,
        title: w.title,
        chartType: w.chart_type,
        config: w.config ?? null,
        visibility: w.visibility,
        rows: run.ok ? run.rows : [],
        error: run.ok ? null : run.error,
      };
    })
  );
  res.json({ widgets });
});

reportsRouter.delete("/:id", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  await pool.query(`DELETE FROM ai_widgets WHERE id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});
