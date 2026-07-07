import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";

export const plansRouter = Router();
plansRouter.use(requireAuth);

const upsertSchema = z.object({
  managerId: z.number(),
  planDate: z.string(),
  metric: z.enum(["lead_taken", "quote_requested", "approved", "invoiced", "paid", "payment_amount", "repeat_payment_amount"]),
  plannedValue: z.number(),
});

plansRouter.post("/", requireRole("admin", "team_lead"), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { managerId, planDate, metric, plannedValue } = parsed.data;

  // A team-lead may only plan for managers of their own team.
  const auth = req.auth!;
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(
      `SELECT team_id FROM managers WHERE id = $1`,
      [managerId]
    );
    if (chk.rows[0]?.team_id !== auth.teamId) {
      return res.status(403).json({ error: "Лише своя команда" });
    }
  }

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
