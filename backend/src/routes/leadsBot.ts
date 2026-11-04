/**
 * 🤖 Бот «UTS Заявки» — черга LinkedIn (задача 7361).
 *  • `POST /webhook` — без `requireAuth`: стукає сервер Telegram. Межа — секрет у заголовку
 *    `X-Telegram-Bot-Api-Secret-Token` (виводиться з токена, `bot/leadsBot.ts`); не збігся → 401 і жодної дії.
 *    Розуміє код підключення і кнопку «Взяти». Завжди 200, інакше Telegram повторюватиме оновлення.
 *  • `GET /me`, `POST /link`, `POST /unlink` — ВЛАСНИЙ акаунт (скоуп — сам токен), як «Привʼязати Telegram» бота підпису.
 */
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import { kommoWrite } from "../kommo/client.js";
import { kommoLeadUrl } from "../core/kommoLinks.js";
import { LINK_TOKEN_TTL_MS } from "../core/signCode.js";
import { createLeadsLinkCode, leadsBotStatus, linkLeadsChat } from "../core/leadsBotLink.js";
import { expiredText, takeOffer, takenText, TAKE_PREFIX } from "../core/linkedinQueue.js";
import { leadsBotAnswer, leadsBotConfigured, leadsBotEdit, leadsBotSend, leadsBotUsername, leadsWebhookSecret } from "../bot/leadsBot.js";
import type { Db } from "../core/adCallFacts.js";

export const leadsBotRouter = Router();
const db = pool as unknown as Db;

type Update = {
  message?: { chat?: { id?: number; type?: string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat?: { id?: number }; message_id?: number } };
};

leadsBotRouter.post("/webhook", async (req, res) => {
  const secret = leadsWebhookSecret();
  if (!secret || req.header("X-Telegram-Bot-Api-Secret-Token") !== secret) return res.status(401).json({ error: "bad_secret" });
  res.json({ ok: true });
  const u = req.body as Update;
  try {
    if (u.callback_query) {
      const cq = u.callback_query;
      const chatId = cq.message?.chat?.id, msgId = cq.message?.message_id;
      const kommoId = cq.data?.startsWith(TAKE_PREFIX) ? Number(cq.data.slice(TAKE_PREFIX.length)) : NaN;
      if (!chatId || !Number.isInteger(kommoId)) { await leadsBotAnswer(cq.id, "Невідома дія"); return; }
      const r = await takeOffer(db, {
        kommoId, chatId, now: new Date(),
        assign: async (id, kommoUserId, name) => {
          await kommoWrite("/api/v4/leads", [{ id, responsible_user_id: kommoUserId }], "PATCH");
          await kommoWrite("/api/v4/leads/notes", [{ entity_id: id, note_type: "common", params: { text: `Взяв через бота черги LinkedIn: ${name}` } }], "POST")
            .catch(() => { /* примітка — не головне */ });
        },
      });
      if (r.ok) {
        await leadsBotAnswer(cq.id, "Заявка ваша");
        if (msgId) await leadsBotEdit(chatId, msgId, takenText(r.dealName, kommoLeadUrl(kommoId)));
        return;
      }
      const why = r.why;
      await leadsBotAnswer(cq.id, why === "expired" ? "Час минув — заявку передано далі"
        : why === "kommo_failed" ? "Kommo не відповів — спробуйте ще раз" : why === "not_linked" ? "Цей Telegram не підключено до дашборда" : "Ця заявка вже не ваша");
      if (msgId && (why === "expired" || why === "not_yours")) await leadsBotEdit(chatId, msgId, why === "expired" ? expiredText(null) : "Ця заявка вже не ваша.");
      return;
    }
    const msg = u.message;
    const chatId = msg?.chat?.id;
    if (!chatId || msg?.chat?.type !== "private") return; // лише особистий чат
    await leadsBotSend(chatId, await linkLeadsChat(db, String(msg?.text ?? ""), chatId));
  } catch (e) { console.error("leads-webhook:", (e as Error).message); }
});

/** Для плашки «Підключіть бот заявок»: чи підключено і чи людині це потрібно (менеджер / тімлід від 1 місяця або вже в колі). */
leadsBotRouter.get("/me", requireAuth, async (req, res) => {
  const s = await leadsBotStatus(db, req.auth!.userId);
  const configured = leadsBotConfigured();
  res.json({ configured, ...s, botUsername: configured ? await leadsBotUsername() : null });
});

leadsBotRouter.post("/link", requireAuth, async (req, res) => {
  if (!leadsBotConfigured()) return res.status(503).json({ error: "Бот заявок ще не налаштований на сервері" });
  const username = await leadsBotUsername();
  if (!username) return res.status(503).json({ error: "Telegram не відповідає — спробуйте пізніше" });
  const code = await createLeadsLinkCode(db, req.auth!.userId);
  res.json({ url: `https://t.me/${username}?start=${code}`, code, botUsername: username, expiresInSec: LINK_TOKEN_TTL_MS / 1000 });
});

leadsBotRouter.post("/unlink", requireAuth, async (req, res) => {
  await pool.query(`UPDATE users SET leads_bot_chat_id = NULL, leads_bot_linked_at = NULL WHERE id = $1`, [req.auth!.userId]);
  res.json({ ok: true });
});
