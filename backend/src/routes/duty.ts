import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

/**
 * Графік чергування. Тімлід (РНК) призначає менеджерів своєї команди на дні,
 * адмін — будь-яку команду. Менеджер бачить графік своєї команди (свої дні
 * підсвічені) у режимі читання. Мотивація: заявки, що надходять увечері/у
 * вихідні, чекають відповідального довше (див. «сер. час опрацювання заявки») —
 * черговий закриває це вікно.
 * shift: 'day' (весь день) | 'evening' (18–21) | 'weekend' (вихідний).
 */
export const dutyRouter = Router();
dutyRouter.use(requireAuth);

const pad = (n: number) => String(n).padStart(2, "0");
const defFrom = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
};
const defTo = () => {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const SHIFTS = new Set(["day", "evening", "weekend"]);

// У чергуванні беруть участь ЛИШЕ команди РНК (робота з наявними клієнтами),
// включно з їхніми тімлідами. Менеджерів РПК/інших до графіка не пропонуємо.
const RNK_TEAM = "t.name ILIKE '%РНК%'";

/** Менеджери, доступні для призначення тому, хто дивиться (лід → своя команда). */
async function assignableManagers(auth: { role: string; teamId: number | null }, teamId: number | null) {
  let scope = teamId;
  if (auth.role === "team_lead") scope = auth.teamId;
  const params: unknown[] = [];
  let where = `m.is_active AND ${RNK_TEAM}`;
  if (scope) { params.push(scope); where += ` AND m.team_id = $${params.length}`; }
  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE ${where}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );
  return r.rows;
}

/**
 * Графік за період. Скоуп: manager → лише СВОЯ команда (щоб бачив, хто чергує);
 * team_lead → своя команда; admin → усі або обрана команда (?teamId).
 * Повертає assignments + (для лід/адмін) список менеджерів для призначення.
 */
dutyRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  const from = (req.query.from as string) || defFrom();
  const to = (req.query.to as string) || defTo();
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager" || auth.role === "team_lead") teamId = auth.teamId;

  const params: unknown[] = [from, to];
  const conds = ["ds.duty_date BETWEEN $1 AND $2"];
  if (teamId) { params.push(teamId); conds.push(`ds.team_id = $${params.length}`); }

  const r = await pool.query<{
    id: number; duty_date: string; manager_id: number; manager_name: string;
    team_id: number | null; team_name: string | null; shift: string; note: string | null;
  }>(
    `SELECT ds.id, to_char(ds.duty_date, 'YYYY-MM-DD') AS duty_date, ds.manager_id,
            m.name AS manager_name, ds.team_id, t.name AS team_name, ds.shift, ds.note
       FROM duty_schedule ds
       JOIN managers m ON m.id = ds.manager_id
       LEFT JOIN teams t ON t.id = ds.team_id
      WHERE ${conds.join(" AND ")}
      ORDER BY ds.duty_date, ds.shift, m.name`,
    params
  );
  const assignments = r.rows.map((x) => ({
    id: x.id, date: x.duty_date, managerId: x.manager_id, managerName: x.manager_name,
    teamId: x.team_id, teamName: x.team_name, shift: x.shift, note: x.note,
    mine: x.manager_id === auth.managerId,
  }));

  const canEdit = auth.role === "admin" || auth.role === "team_lead";
  const managers = canEdit ? await assignableManagers(auth, teamId) : [];
  res.json({ from, to, assignments, managers, canEdit });
});

/** Призначити менеджера на день (лід — лише своя команда). */
dutyRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const date = String(req.body?.date ?? "").slice(0, 10);
  const managerId = Number(req.body?.managerId);
  const shift = SHIFTS.has(String(req.body?.shift)) ? String(req.body.shift) : "day";
  const note = req.body?.note != null ? String(req.body.note).slice(0, 500) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !managerId) {
    return res.status(400).json({ error: "date (YYYY-MM-DD) та managerId обовʼязкові" });
  }
  // Команда менеджера + гейт для тімліда (лише своя команда) + лише РНК-команди.
  const mgr = await pool.query<{ team_id: number | null; is_rnk: boolean }>(
    `SELECT m.team_id, (t.name ILIKE '%РНК%') AS is_rnk
       FROM managers m LEFT JOIN teams t ON t.id = m.team_id
      WHERE m.id = $1 AND m.is_active`, [managerId]);
  if (!mgr.rowCount) return res.status(404).json({ error: "Менеджера не знайдено" });
  if (!mgr.rows[0].is_rnk) return res.status(400).json({ error: "У чергуванні беруть участь лише команди РНК" });
  const teamId = mgr.rows[0].team_id;
  if (auth.role === "team_lead" && teamId !== auth.teamId) {
    return res.status(403).json({ error: "Лише своя команда" });
  }
  const r = await pool.query<{ id: number }>(
    `INSERT INTO duty_schedule (duty_date, manager_id, team_id, shift, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (duty_date, manager_id, shift) DO UPDATE SET note = EXCLUDED.note
     RETURNING id`,
    [date, managerId, teamId, shift, note, auth.userId]
  );
  res.json({ ok: true, id: r.rows[0].id });
});

/** Зняти призначення (лід — лише своя команда). */
dutyRouter.delete("/:id", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "admin" && auth.role !== "team_lead") {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const id = Number(req.params.id);
  const row = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM duty_schedule WHERE id = $1`, [id]);
  if (!row.rowCount) return res.json({ ok: true }); // already gone
  if (auth.role === "team_lead" && row.rows[0].team_id !== auth.teamId) {
    return res.status(403).json({ error: "Лише своя команда" });
  }
  await pool.query(`DELETE FROM duty_schedule WHERE id = $1`, [id]);
  res.json({ ok: true });
});
