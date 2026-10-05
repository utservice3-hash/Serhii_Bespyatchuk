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
  // 🔓 РІШЕННЯ ВЛАСНИКА 14.09.2026 («всі можуть ставити один одному задачі») і
  // 16.09.2026 («менеджери не можуть ставити себе відповідальними» — бо цей список
  // віддавав менеджеру РІВНО себе, а тімліду лише його команду, і форма показувала
  // «—»). Тепер усі ролі бачать усіх активних; `teamId` у query — лише фільтр за
  // бажанням, не межа. Тримає `#423`.
  const params: unknown[] = [];
  const conds = ["m.is_active = true"];
  if (req.query.teamId) { params.push(Number(req.query.teamId)); conds.push(`m.team_id = $${params.length}`); }
  const result = await pool.query(
    `SELECT m.id, m.name, m.team_id AS "teamId", t.name AS "teamName"
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE ${conds.join(" AND ")}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );
  // 👁 НЕВІДОМЕ МАЄ БУТИ ВИДИМИМ (відгук Шаврової 05.10.2026: «не можу ставити
  // менеджера з команди»). Список вище — лише активні, тож людина, вимкнена в Kommo,
  // просто зникає з селекта, і це читається як заборона задачника. Віддаємо
  // неактивних ЛИШЕ з команди того, хто питає, — щоб форма могла сказати це словами.
  const a = req.auth!;
  const inactive = await pool.query<{ id: number; name: string }>(
    `SELECT m.id, m.name FROM managers m
      WHERE m.is_active = false
        AND m.team_id = COALESCE($1::int, (SELECT team_id FROM managers WHERE id = $2::int))
      ORDER BY m.name`,
    [a.teamId ?? null, a.managerId && a.managerId > 0 ? a.managerId : null]
  );
  res.json({ managers: result.rows, myTeamInactive: inactive.rows });
});
