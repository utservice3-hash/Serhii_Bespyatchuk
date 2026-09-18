import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../core/hiring.js";
import { candidateSelf } from "../core/hiringTraining.js";

/**
 * 🎓 «МОЄ НАВЧАННЯ» КАНДИДАТА (прохід 2b, 18.09.2026).
 *
 * Змонтовано під `/api/training/candidate`, тож першу межу тримає tab-гейт `training`.
 * Другої межі не треба за побудовою: відповідь — лише про власника токена (`userId`), параметра
 * «чий» у роуті немає. Не-кандидат отримує `{ candidate: false }` — екран курсу працює й без
 * смуги строку, а матриця бачить 200, а не помилку.
 */
export const candidateTrainingRouter = Router();
candidateTrainingRouter.use(requireAuth);

candidateTrainingRouter.get("/me", async (req, res) => {
  try {
    const me = await candidateSelf(pool as unknown as Db, req.auth!.userId);
    res.json(me ? { candidate: true, ...me } : { candidate: false });
  } catch (e) {
    console.error("[candidate-training]", e);
    res.status(500).json({ error: "Помилка сервера" });
  }
});
