import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { successByMgr } from "../core/money.js";

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

/** Поточний місяць по-київськи: [1-ше число, сьогодні]. */
function kyivMonthToDate(): { from: string; to: string } {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  return { from: today.slice(0, 7) + "-01", to: today };
}

/**
 * Other users you can message, with unread counts, their team, and current-
 * month paid revenue so the UI can group by team and award achievement badges.
 *
 * 🔴 ВИРУЧКА — ЛИШЕ ЧЕРЕЗ `core/money.ts` (02.08.2026). Тут стояв власний
 * підзапит: `SUM(price)` по `funnel_stage='paid'` з анкером
 * `created_at_kommo >= date_trunc('month', now())`. Дві помилки в одному рядку:
 *   • АНКЕР по даті СТВОРЕННЯ замість дати входу в етап. Угода, створена в червні
 *     й оплачена в липні, не потрапляла нікуди; створена в липні й ще не оплачена —
 *     теж. Похибка структурно найбільша саме в ПОТОЧНОМУ місяці, який лідерборд і
 *     показує: липень 2 079 764 ₴ проти 2 865 961 ₴ у ядрі — **−27.4%**
 *     (травень −3.5%, червень −4.7% — закриті місяці розходяться менше).
 *   • `funnel_stage='paid'` замість множини 9∪10 з дедуплікацією.
 *
 * Це не косметика: бейдж рахується від порогів 100/200/300 тис. (`getRank`), тож
 * заниження ПУБЛІЧНО знижувало людям статус — у липні 6 із 46 користувачів.
 *
 * 🔴 ПОПРАВКА ВЛАСНИКА (02.08.2026): метрика тут ① `successByMgr` — лише «успішно
 * реалізовано» (142). Спершу викотили ② (9∪10), але лідерборд публічно ОЦІНЮЄ
 * людину, а частково оплачена угода переїздить у наступний місяць: зарахувати її
 * зараз означало б поставити людині в заслугу незавершене.
 */
messagesRouter.get("/users", async (req, res) => {
  const me = req.auth!.userId;
  await pool.query(`UPDATE users SET last_seen = now() WHERE id = $1`, [me]);
  const period = kyivMonthToDate();
  const [result, byMgr] = await Promise.all([
    pool.query<{
      id: number; manager_id: number | null; name: string; email: string;
      team_name: string; last_seen: string | null; unread: string;
    }>(
      `SELECT u.id, u.manager_id, COALESCE(m.name, u.email) AS name, u.email,
              COALESCE(t.name, 'Без команди') AS team_name, u.last_seen,
              (SELECT COUNT(*) FROM messages msg
                WHERE msg.sender_id = u.id AND msg.recipient_id = $1 AND msg.read_at IS NULL) AS unread
         FROM users u
         LEFT JOIN managers m ON m.id = u.manager_id
         LEFT JOIN teams t ON t.id = u.team_id
        WHERE u.id <> $1 AND u.is_active = true
        ORDER BY team_name, name`,
      [me]
    ),
    successByMgr(period),
  ]);
  const revenueOf = new Map(byMgr.map((r) => [r.managerId, r.revenue]));
  // 🔒 Поля перелічені ЯВНО, а не спредом рядка. `manager_id` потрібен лише щоб
  // зіставити виручку з ядром — назовні він не їде: до цієї правки його у відповіді
  // не було, і додавати його «за компанію» означало б розширити payload побічно.
  res.json({
    users: result.rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      team_name: u.team_name,
      last_seen: u.last_seen,
      unread: u.unread,
      // Користувач без прив'язки до менеджера (бухгалтер, директор) — 0, а не null:
      // `getRank` рахує число, і null дав би «👻» через NaN-порівняння, а не за фактом.
      revenue: u.manager_id == null ? 0 : revenueOf.get(u.manager_id) ?? 0,
    })),
  });
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
