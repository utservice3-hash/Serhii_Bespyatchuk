import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";

export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

const SELECT = `
  SELECT f.id, f.section, f.message, f.status, f.admin_note AS "adminNote",
         f.created_at AS "createdAt", f.updated_at AS "updatedAt",
         f.author_user_id AS "authorUserId",
         COALESCE(m.name, u.email) AS "authorName"
  FROM feedback f
  JOIN users u ON u.id = f.author_user_id
  LEFT JOIN managers m ON m.id = u.manager_id`;

/** List feedback: admin sees everything, everyone else only their own items. */
feedbackRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  const params: unknown[] = [];
  let where = "";
  if (auth.role !== "admin") {
    params.push(auth.userId);
    where = `WHERE f.author_user_id = $1`;
  }
  const r = await pool.query(`${SELECT} ${where} ORDER BY f.created_at DESC`, params);
  res.json({ feedback: r.rows });
});

/** Submit a new feedback / bug report — available to every authenticated user. */
feedbackRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  const message = String(req.body?.message ?? "").trim();
  const section = req.body?.section ? String(req.body.section).slice(0, 60) : null;
  if (!message) return res.status(400).json({ error: "Опишіть проблему або пропозицію" });
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO feedback (author_user_id, section, message) VALUES ($1, $2, $3) RETURNING id`,
    [auth.userId, section, message.slice(0, 4000)]
  );
  const r = await pool.query(`${SELECT} WHERE f.id = $1`, [ins.rows[0].id]);
  res.status(201).json({ feedback: r.rows[0] });
});

/** Admin decision / status update: approve, reject, or mark resolved. */
feedbackRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status ?? "");
  const adminNote = req.body?.adminNote != null ? String(req.body.adminNote).slice(0, 2000) : null;
  if (!["pending", "approved", "rejected", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Невірний статус" });
  }
  const upd = await pool.query(
    `UPDATE feedback SET status = $1, admin_note = COALESCE($2, admin_note), updated_at = now()
     WHERE id = $3 RETURNING id`,
    [status, adminNote, id]
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: "Не знайдено" });
  const r = await pool.query(`${SELECT} WHERE f.id = $1`, [id]);
  res.json({ feedback: r.rows[0] });
});
