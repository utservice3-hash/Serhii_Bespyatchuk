import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

/**
 * Ван-ту-вани (1-on-1). Тімлід проводить зі СВОЄЮ командою; admin (операційний/
 * КВП) — з усіма (у т.ч. тімлідами) і бачить загальну статистику. Менеджери
 * доступу НЕ мають (роут гейтований). Відповіді — JSON { qKey: {score,text} };
 * overall = середнє по числових score (для статистики оцінок).
 */
export const oneOnOnesRouter = Router();
oneOnOnesRouter.use(requireAuth);
// 🔒 Доступ гейтить ЕКРАН `oneonone` (tab-гейт у requireAuth: roleHasTab(roleKey,'oneonone')) —
// ЄДИНЕ джерело правди. Раніше тут стояв додатковий блок `role==='manager'`; він був
// (а) надлишковий для справжніх менеджерів — їх уже ріже tab-гейт (у ролі manager немає екрана
// oneonone), і (б) ШКІДЛИВИЙ для company/own-scope кастомних ролей (напр. hr), яких scope-clamp
// робить 'manager' → блок різав їх попри виданий екран (→ порожній «Ван-ту-ван»). Прибрано:
// хто має екран, той має доступ, незалежно від data_scope. Хто ПРОВОДИТЬ/чиє видно — нижче по скоупу.

const monthOf = (q: unknown) => (String(q || new Date().toISOString().slice(0, 7)).slice(0, 7)) + "-01";
const overallOf = (answers: Record<string, { score?: number; text?: string }>) => {
  const scores = Object.values(answers || {}).map((a) => a?.score).filter((s): s is number => typeof s === "number" && s > 0);
  return scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
};

/** Хто в скоупі того, хто дивиться (team_lead → своя команда; admin → усі активні). */
async function subjectScope(auth: { role: string; teamId: number | null }) {
  if (auth.role === "team_lead") return { where: "m.team_id = $1 AND m.is_active", params: [auth.teamId] as unknown[] };
  return { where: "m.is_active", params: [] as unknown[] };
}

/** Список працівників для 1-on-1 + статус заповнення за місяць. */
oneOnOnesRouter.get("/subjects", async (req, res) => {
  const month = monthOf(req.query.month);
  const { where, params } = await subjectScope(req.auth!);
  const r = await pool.query(
    `SELECT m.id, m.name, m.team_id, m.is_team_lead, t.name AS team_name,
            o.overall, (o.subject_manager_id IS NOT NULL) AS done, o.updated_at
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN one_on_ones o ON o.subject_manager_id = m.id AND o.month = $${params.length + 1}
      WHERE ${where}
      ORDER BY t.name NULLS LAST, m.is_team_lead DESC, m.name`,
    [...params, month]
  );
  res.json({ month, subjects: r.rows });
});

/** Одна анкета (subject + month). */
oneOnOnesRouter.get("/:managerId", async (req, res) => {
  const managerId = Number(req.params.managerId);
  const month = monthOf(req.query.month);
  if (req.auth!.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== req.auth!.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const r = await pool.query(
    `SELECT o.subject_manager_id, o.month, o.answers, o.overall, o.updated_at,
            COALESCE(mm.name, u.email) AS conducted_by_name
       FROM one_on_ones o
       LEFT JOIN users u ON u.id = o.conducted_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE o.subject_manager_id = $1 AND o.month = $2`,
    [managerId, month]
  );
  res.json(r.rows[0] ?? { subject_manager_id: managerId, month, answers: {}, overall: null });
});

/** Зберегти анкету. */
oneOnOnesRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  const managerId = Number(req.body?.subjectManagerId);
  const month = monthOf(req.body?.month);
  const answers = (req.body?.answers ?? {}) as Record<string, { score?: number; text?: string }>;
  if (!managerId || typeof answers !== "object") return res.status(400).json({ error: "subjectManagerId та answers обовʼязкові" });
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const overall = overallOf(answers);
  await pool.query(
    `INSERT INTO one_on_ones (subject_manager_id, month, conducted_by, answers, overall, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (subject_manager_id, month) DO UPDATE SET
       answers = EXCLUDED.answers, overall = EXCLUDED.overall, conducted_by = EXCLUDED.conducted_by, updated_at = now()`,
    [managerId, month, auth.userId, JSON.stringify(answers), overall]
  );
  res.json({ ok: true, overall });
});

/** Статистика оцінок: по працівниках за останні N місяців + середнє по команді. */
oneOnOnesRouter.get("/stats/scores", async (req, res) => {
  const months = Math.min(12, Math.max(1, Number(req.query.months) || 6));
  const { where, params } = await subjectScope(req.auth!);
  const r = await pool.query(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name,
            to_char(o.month, 'YYYY-MM') AS month, o.overall, o.answers
       FROM one_on_ones o
       JOIN managers m ON m.id = o.subject_manager_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE ${where} AND o.month >= (date_trunc('month', now()) - make_interval(months => $${params.length + 1}))
      ORDER BY t.name NULLS LAST, m.name, o.month`,
    [...params, months - 1]
  );
  res.json({ rows: r.rows });
});
