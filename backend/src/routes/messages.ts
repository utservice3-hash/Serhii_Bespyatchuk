import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

/**
 * Other users you can message, with unread counts, their team, and current-
 * month paid revenue so the UI can group by team and award achievement badges.
 */
messagesRouter.get("/users", async (req, res) => {
  const me = req.auth!.userId;
  await pool.query(`UPDATE users SET last_seen = now() WHERE id = $1`, [me]);
  const result = await pool.query(
    `SELECT u.id, COALESCE(m.name, u.email) AS name, u.email,
            COALESCE(t.name, 'Без команди') AS team_name, u.last_seen,
            (SELECT COUNT(*) FROM messages msg
              WHERE msg.sender_id = u.id AND msg.recipient_id = $1 AND msg.read_at IS NULL) AS unread,
            (SELECT COALESCE(SUM(d.price), 0)
               FROM deals d
               JOIN pipeline_stage_map psm
                 ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
              WHERE d.manager_id = u.manager_id
                AND psm.funnel_stage = 'paid'
                AND d.created_at_kommo >= date_trunc('month', now())) AS revenue
     FROM users u
     LEFT JOIN managers m ON m.id = u.manager_id
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.id <> $1 AND u.is_active = true
     ORDER BY team_name, name`,
    [me]
  );
  res.json({ users: result.rows });
});

/** Presence heartbeat — keeps the caller marked as online. */
messagesRouter.post("/heartbeat", async (req, res) => {
  await pool.query(`UPDATE users SET last_seen = now() WHERE id = $1`, [req.auth!.userId]);
  res.json({ ok: true });
});

/** Total unread messages (for the sidebar badge). */
messagesRouter.get("/unread", async (req, res) => {
  const me = req.auth!.userId;
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM messages WHERE recipient_id = $1 AND read_at IS NULL`,
    [me]
  );
  res.json({ unread: Number(result.rows[0]?.count ?? 0) });
});

/** Conversation with another user; marks their messages to me as read. */
messagesRouter.get("/:userId", async (req, res) => {
  const me = req.auth!.userId;
  const other = Number(req.params.userId);
  const result = await pool.query(
    `SELECT id, sender_id, recipient_id, body, attachment_url, attachment_name, created_at
     FROM messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY created_at`,
    [me, other]
  );
  await pool.query(
    `UPDATE messages SET read_at = now()
     WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
    [me, other]
  );
  res.json({ messages: result.rows });
});

messagesRouter.post("/:userId", async (req, res) => {
  const me = req.auth!.userId;
  const other = Number(req.params.userId);
  const body = String(req.body?.body ?? "").trim();
  const attachmentUrl = req.body?.attachmentUrl ?? null;
  const attachmentName = req.body?.attachmentName ?? null;
  if (!body && !attachmentUrl) return res.status(400).json({ error: "Порожнє повідомлення" });
  const result = await pool.query(
    `INSERT INTO messages (sender_id, recipient_id, body, attachment_url, attachment_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, sender_id, recipient_id, body, attachment_url, attachment_name, created_at`,
    [me, other, body, attachmentUrl, attachmentName]
  );
  res.json({ message: result.rows[0] });
});
