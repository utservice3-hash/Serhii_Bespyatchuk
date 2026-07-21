import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

export const teamsRouter = Router();
teamsRouter.use(requireAuth);

teamsRouter.get("/", async (_req, res) => {
  // ФІЛЬТР показу, НЕ видалення: ховаємо порожні команди (0 активних менеджерів) з
  // усіх переліків/фільтрів/декомпозиції. Дані команди лишаються в БД недоторканими —
  // якщо в неї знову зайде активний менеджер (як буває при переводі відділу в нову
  // Kommo-групу), рядок зʼявиться сам. Приклад: стара «Тендер»→«Самостійний» (team 4)
  // спорожніла після переводу Шевчука в нову групу «Самостійні» (team 36283).
  const result = await pool.query(
    `SELECT id, name FROM teams t
      WHERE EXISTS (SELECT 1 FROM managers m WHERE m.team_id = t.id AND m.is_active)
      ORDER BY name`
  );
  res.json({ teams: result.rows });
});

teamsRouter.get("/managers", async (req, res) => {
  const auth = req.auth!;
  // A team-lead only sees (and can assign tasks to) their own team; admin/КВП
  // sees everyone; a manager only themselves.
  const params: unknown[] = [];
  const conds = ["m.is_active = true"];
  if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`m.team_id = $${params.length}`); }
  else if (auth.role === "manager") { params.push(auth.managerId); conds.push(`m.id = $${params.length}`); }
  else if (req.query.teamId) { params.push(Number(req.query.teamId)); conds.push(`m.team_id = $${params.length}`); } // admin picked a team
  const result = await pool.query(
    `SELECT m.id, m.name, m.team_id AS "teamId", t.name AS "teamName"
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE ${conds.join(" AND ")}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );
  res.json({ managers: result.rows });
});
