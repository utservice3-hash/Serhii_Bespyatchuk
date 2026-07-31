import { Router } from "express";
import { isAdminScope } from "../auth/rbac.js";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { scheduleAiReply } from "../ai/respond.js";

export const aiWorkRouter = Router();
aiWorkRouter.use(requireAuth);

const ALLOWED_EMAILS = ["ranutservice@gmail.com"];

/** Access: admins, plus explicitly whitelisted assistant accounts. */
// Приймає auth цілком — `isAdminScope` спирається на право в БД, не лише на scope-рядок.
async function ensureAccess(userId: number, auth: { role: string; roleKey: string }): Promise<boolean> {
  if (isAdminScope(auth)) return true;
  const r = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  const email = r.rows[0]?.email?.toLowerCase() ?? "";
  return ALLOWED_EMAILS.includes(email);
}

const SELECT = `
  SELECT a.id, a.role, a.body, a.status, a.attachments, a.created_at AS "createdAt",
         COALESCE(a.author_name, m.name, u.email, 'АІ') AS "authorName"
  FROM ai_messages a
  LEFT JOIN users u ON u.id = a.author_user_id
  LEFT JOIN managers m ON m.id = u.manager_id`;

aiWorkRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  if (!(await ensureAccess(auth.userId, auth))) return res.status(403).json({ error: "Forbidden" });
  const r = await pool.query(`${SELECT} ORDER BY a.created_at ASC`);
  res.json({ messages: r.rows });
});

aiWorkRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  if (!(await ensureAccess(auth.userId, auth))) return res.status(403).json({ error: "Forbidden" });
  const body = String(req.body?.body ?? "").trim();
  // Normalize attachments to a small [{url, name}] array (images posted by the UI).
  const rawAtt = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const attachments = rawAtt
    .filter((a: unknown) => a && typeof (a as { url?: unknown }).url === "string")
    .slice(0, 8)
    .map((a: { url: string; name?: string }) => ({ url: a.url, name: String(a.name ?? "").slice(0, 200) }));
  if (!body && !attachments.length) return res.status(400).json({ error: "Порожнє повідомлення" });
  const who = await pool.query<{ name: string }>(
    `SELECT COALESCE(m.name, u.email) AS name FROM users u LEFT JOIN managers m ON m.id = u.manager_id WHERE u.id = $1`,
    [auth.userId]
  );
  // Розділ, відкритий у фронті, — у системний промт («поясни цей блок» без уточнень).
  const uiSection = String(req.body?.uiSection ?? "").trim().slice(0, 80) || null;
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO ai_messages (author_user_id, author_name, role, body, attachments, ui_section)
     VALUES ($1, $2, 'user', $3, $4, $5) RETURNING id`,
    [auth.userId, who.rows[0]?.name ?? "Користувач", body.slice(0, 8000),
     attachments.length ? JSON.stringify(attachments) : null, uiSection]
  );
  const r = await pool.query(`${SELECT} WHERE a.id = $1`, [ins.rows[0].id]);
  res.status(201).json({ message: r.rows[0] });
  scheduleAiReply();
});
