/**
 * 🔗 «Клієнти → LinkedIn» (задача 7361): статистика черги LinkedIn за період. Межа — вкладка `linkedin`
 * (`routeTab.ts`: керівництво й КВП). Список кола й відповідальна — окремий роут `/api/linkedin-queue` (право).
 */
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { loadLinkedinStats } from "../core/linkedinStats.js";

export const linkedinRouter = Router();
linkedinRouter.use(requireAuth);

linkedinRouter.get("/stats", async (req, res) => {
  try { res.json(await loadLinkedinStats(pool, req.query.from, req.query.to, config.linkedinQueue.mode)); }
  catch (e) {
    const status = (e as { status?: number })?.status;
    if (!status) console.error("linkedin/stats:", e);
    res.status(status ?? 500).json({ error: (e as Error)?.message ?? "Помилка" });
  }
});
