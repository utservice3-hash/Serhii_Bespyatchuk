/**
 * 🤖 ВЕБХУК БОТА ПІДПИСУ. Єдиний роут без `requireAuth`: стукає сервер Telegram, не браузер.
 * Межа — секрет у заголовку `X-Telegram-Bot-Api-Secret-Token` (виводиться з токена бота,
 * див. bot/signBot.ts). Не збігся → 401 і жодної дії. Записано в ROUTE_BOUNDARY_EXEMPTIONS.
 *
 * Розуміє одне: `/start <токен привʼязки>`. Токен одноразовий, 10 хв (`#442b`). Усе інше —
 * підказка. Завжди відповідає 200, інакше Telegram повторюватиме оновлення.
 */
import { Router } from "express";
import { pool } from "../db/pool.js";
import { webhookSecret, signBotSend } from "../bot/signBot.js";
import { linkTokenState } from "../core/signCode.js";

export const telegramRouter = Router();

const HELP = "Це бот підпису документів дашборда UTS. Щоб привʼязати акаунт, відкрийте «Регламенти та документи» в дашборді й натисніть «Привʼязати Telegram».";

telegramRouter.post("/sign-webhook", async (req, res) => {
  const secret = webhookSecret();
  if (!secret || req.header("X-Telegram-Bot-Api-Secret-Token") !== secret) return res.status(401).json({ error: "bad_secret" });
  res.json({ ok: true }); // відповідаємо одразу; решта — після
  const msg = (req.body as { message?: { chat?: { id?: number }; from?: { id?: number; first_name?: string }; text?: string } })?.message;
  const chatId = msg?.chat?.id;
  const text = String(msg?.text ?? "").trim();
  if (!chatId) return;
  console.log(`sign-webhook: chat ${chatId} · «${text.slice(0, 40)}»`);
  const m = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/.exec(text);
  if (!m) { await signBotSend(chatId, HELP); return; }
  try {
    const r = await pool.query<{ id: number; user_id: number; expires_at: string; used_at: string | null; name: string }>(
      `SELECT c.id, c.user_id, c.expires_at, c.used_at, COALESCE(mg.name, u.email) AS name
         FROM sign_codes c JOIN users u ON u.id = c.user_id LEFT JOIN managers mg ON mg.id = u.manager_id
        WHERE c.purpose = 'link' AND c.code = $1
        ORDER BY c.created_at DESC LIMIT 1`, [m[1]]);
    const row = r.rows[0];
    const state = row ? linkTokenState({ expiresAt: row.expires_at, usedAt: row.used_at }, new Date()) : "expired";
    if (!row || state !== "ok") {
      await signBotSend(chatId, state === "used" ? "Це посилання вже використане. Натисніть «Привʼязати Telegram» у дашборді ще раз." : "Посилання застаріло (діє 10 хвилин). Натисніть «Привʼязати Telegram» у дашборді ще раз.");
      return;
    }
    await pool.query(`UPDATE sign_codes SET used_at = now() WHERE id = $1`, [row.id]);
    await pool.query(`UPDATE users SET telegram_chat_id = $2, telegram_linked_at = now() WHERE id = $1`, [row.user_id, chatId]);
    await signBotSend(chatId, `✅ Привʼязано: ${row.name}. Сюди приходитимуть коди для підпису документів і нагадування про непідписані офери.`);
  } catch (e) {
    console.error("sign-webhook:", e);
  }
});
