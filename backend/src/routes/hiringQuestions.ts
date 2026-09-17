import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { HiringError, type Db } from "../core/hiring.js";
import { askQuestion, myQuestions } from "../core/hiringTraining.js";

/**
 * 🎓 ПИТАННЯ ТІМЛІДУ З НАВЧАННЯ (найм, прохід 2a, 17.09.2026).
 *
 * Змонтовано під `/api/training/questions`, тож першу межу тримає tab-гейт `training` — вкладка
 * кандидата. Друга межа — у ядрі: питати може лише власник акаунта кандидата з відкритим доступом,
 * і бачить він лише свої питання (ключ — `userId` із токена, а не параметр запиту).
 * Відповідь тімліда — `POST /api/hiring/candidates/:id/questions/:questionId/answer`.
 */
export const hiringQuestionsRouter = Router();
hiringQuestionsRouter.use(requireAuth);

hiringQuestionsRouter.get("/", async (req, res) => {
  try {
    res.json({ rows: await myQuestions(pool as unknown as Db, req.auth!.userId) });
  } catch (e) {
    console.error("[training-questions]", e);
    res.status(500).json({ error: "Помилка сервера" });
  }
});

hiringQuestionsRouter.post("/", async (req, res) => {
  try {
    const id = await askQuestion(pool as unknown as Db, req.auth!.userId, req.body ?? {});
    res.status(201).json({ id });
  } catch (e) {
    if (e instanceof HiringError) return res.status(e.status).json({ error: e.message });
    console.error("[training-questions]", e);
    res.status(500).json({ error: "Помилка сервера" });
  }
});
