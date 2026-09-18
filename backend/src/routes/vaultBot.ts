/**
 * 🤖 ВЕБХУК БОТА «UTS Сейф». Без `requireAuth`: стукає сервер Telegram, не браузер.
 * Межа — секрет у заголовку `X-Telegram-Bot-Api-Secret-Token` (виводиться з токена бота,
 * `bot/vaultBot.ts`). Не збігся → 401 і жодної дії. Записано в ROUTE_BOUNDARY_EXEMPTIONS.
 * Розуміє одне: код привʼязки. Завжди відповідає 200, інакше Telegram повторюватиме оновлення.
 */
import { Router } from "express";
import { pool } from "../db/pool.js";
import { vaultWebhookSecret, vaultBotSend } from "../bot/vaultBot.js";
import { linkVaultChat, type Db } from "../core/secrets.js";

export const vaultBotRouter = Router();

vaultBotRouter.post("/webhook", async (req, res) => {
  const secret = vaultWebhookSecret();
  if (!secret || req.header("X-Telegram-Bot-Api-Secret-Token") !== secret) return res.status(401).json({ error: "bad_secret" });
  res.json({ ok: true });
  const msg = (req.body as { message?: { chat?: { id?: number; type?: string }; text?: string } })?.message;
  const chatId = msg?.chat?.id;
  if (!chatId || msg?.chat?.type !== "private") return; // лише особистий чат: у групу код не піде
  try {
    const reply = await linkVaultChat(pool as unknown as Db, String(msg?.text ?? ""), chatId);
    await vaultBotSend(chatId, reply);
  } catch (e) { console.error("vault-webhook:", (e as Error).message); }
});
