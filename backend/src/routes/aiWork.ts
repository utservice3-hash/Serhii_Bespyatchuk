import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

export const aiWorkRouter = Router();
aiWorkRouter.use(requireAuth);

const ALLOWED_EMAILS = ["ranutservice@gmail.com"];

/** Access: admins, plus explicitly whitelisted assistant accounts. */
async function ensureAccess(userId: number, role: string): Promise<boolean> {
  if (role === "admin") return true;
  const r = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  const email = r.rows[0]?.email?.toLowerCase() ?? "";
  return ALLOWED_EMAILS.includes(email);
}

const SELECT = `
  SELECT a.id, a.role, a.body, a.status, a.created_at AS "createdAt",
         COALESCE(a.author_name, m.name, u.email, 'АІ') AS "authorName"
  FROM ai_messages a
  LEFT JOIN users u ON u.id = a.author_user_id
  LEFT JOIN managers m ON m.id = u.manager_id`;

aiWorkRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  if (!(await ensureAccess(auth.userId, auth.role))) return res.status(403).json({ error: "Forbidden" });
  const r = await pool.query(`${SELECT} ORDER BY a.created_at ASC`);
  res.json({ messages: r.rows });
});

aiWorkRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  if (!(await ensureAccess(auth.userId, auth.role))) return res.status(403).json({ error: "Forbidden" });
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ error: "Порожнє повідомлення" });
  const who = await pool.query<{ name: string }>(
    `SELECT COALESCE(m.name, u.email) AS name FROM users u LEFT JOIN managers m ON m.id = u.manager_id WHERE u.id = $1`,
    [auth.userId]
  );
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO ai_messages (author_user_id, author_name, role, body) VALUES ($1, $2, 'user', $3) RETURNING id`,
    [auth.userId, who.rows[0]?.name ?? "Користувач", body.slice(0, 8000)]
  );
  const r = await pool.query(`${SELECT} WHERE a.id = $1`, [ins.rows[0].id]);
  res.status(201).json({ message: r.rows[0] });
});
