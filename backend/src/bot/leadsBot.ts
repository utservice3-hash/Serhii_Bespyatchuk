/**
 * 🤖 БОТ ЗАЯВОК («UTS Заявки») — черга LinkedIn (задача 7361). Окремий від бота підпису й «UTS Сейф»: свій токен
 * (`LEADS_BOT_TOKEN`), свій вебхук, своя привʼязка чату. Як і вони — вебхуком у основний процес (хост убиває другий
 * Node-процес), Bot API — fetch-ом. Без токена все тут — тихий no-op, черга лишається в пробному режимі.
 *
 * Секрет вебхука виводиться з токена (sha256) — одна змінна в .env замість двох.
 */
import { createHash } from "crypto";

const token = () => process.env.LEADS_BOT_TOKEN?.trim() || null;
export const leadsBotConfigured = (): boolean => token() != null;

export function leadsWebhookSecret(): string | null {
  const t = token();
  return t ? createHash("sha256").update(`leads-webhook:${t}`).digest("hex").slice(0, 40) : null;
}

export function leadsWebhookUrl(): string {
  return process.env.LEADS_BOT_WEBHOOK_URL?.trim() || "https://dashboard.uts.ua/api/leads-bot/webhook";
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = (await r.json()) as { ok: boolean; result?: T; description?: string };
    if (!j.ok) { console.error(`leadsBot ${method}: ${j.description ?? r.status}`); return null; }
    return j.result ?? null;
  } catch (e) { console.error(`leadsBot ${method} failed:`, (e as Error).message); return null; }
}

let usernameCache: string | null = null;
export async function leadsBotUsername(): Promise<string | null> {
  if (usernameCache) return usernameCache;
  const me = await call<{ username?: string }>("getMe", {});
  usernameCache = me?.username ?? null;
  return usernameCache;
}

export type InlineButton = { text: string; callback_data: string };

/** Повідомлення (HTML). Повертає message_id — щоб потім погасити кнопку. */
export async function leadsBotSend(chatId: number | string, html: string, buttons?: InlineButton[]): Promise<number | null> {
  const r = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true,
    ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  });
  return r?.message_id ?? null;
}

/** Переписати повідомлення без кнопок («кнопка гасне» — Юля 03.11.2026). */
export async function leadsBotEdit(chatId: number | string, messageId: number, html: string): Promise<boolean> {
  const r = await call("editMessageText", {
    chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [] },
  });
  return r != null;
}

export async function leadsBotAnswer(callbackQueryId: string, text: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
}

/** На старті: зареєструвати вебхук (ідемпотентно). Кнопка «Взяти» = callback_query, тож вона в allowed_updates. */
export async function leadsBotEnsureWebhook(): Promise<void> {
  const secret = leadsWebhookSecret();
  if (!secret) { console.warn("leadsBot: LEADS_BOT_TOKEN не заданий — бот заявок вимкнено."); return; }
  const ok = await call("setWebhook", { url: leadsWebhookUrl(), secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  console.log(`leadsBot: webhook ${ok != null ? "зареєстровано" : "НЕ зареєстровано"} → ${leadsWebhookUrl()}`);
}

export const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
