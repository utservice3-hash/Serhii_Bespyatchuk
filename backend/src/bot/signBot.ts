/**
 * 🤖 БОТ ПІДПИСУ («UTS Підпис», @uts_sign_bot) — окремий від адмін-бота (`bot/bot.ts`).
 *
 * Чому окремий і чому без grammy: адмін-бот живе окремим процесом через polling, а хост
 * убиває другий Node-процес; бот підпису приймає оновлення ВЕБХУКОМ у основний процес
 * (routes/telegram.ts), тож окремого процесу немає взагалі. Bot API кличемо fetch-ом, як
 * `bot/notify.ts`. Токен — `TELEGRAM_SIGN_BOT_TOKEN`; без нього все тут — тихий no-op,
 * а екран каже «бот не налаштований».
 *
 * Секрет вебхука виводиться з токена (sha256), а не з окремої змінної: одна річ у .env
 * замість двох, і Telegram передає його заголовком `X-Telegram-Bot-Api-Secret-Token`.
 */
import { createHash } from "crypto";

const token = () => process.env.TELEGRAM_SIGN_BOT_TOKEN?.trim() || null;
export const signBotConfigured = (): boolean => token() != null;

export function webhookSecret(): string | null {
  const t = token();
  return t ? createHash("sha256").update(`webhook:${t}`).digest("hex").slice(0, 40) : null;
}

export function webhookUrl(): string {
  return process.env.TELEGRAM_SIGN_WEBHOOK_URL?.trim() || "https://dashboard.uts.ua/api/telegram/sign-webhook";
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = (await r.json()) as { ok: boolean; result?: T; description?: string };
    if (!j.ok) { console.error(`signBot ${method}: ${j.description ?? r.status}`); return null; }
    return j.result ?? null;
  } catch (e) { console.error(`signBot ${method} failed:`, e); return null; }
}

let usernameCache: string | null = null;
export async function signBotUsername(): Promise<string | null> {
  if (usernameCache) return usernameCache;
  const me = await call<{ username?: string }>("getMe", {});
  usernameCache = me?.username ?? null;
  return usernameCache;
}

export async function signBotSend(chatId: number | string, text: string): Promise<boolean> {
  const r = await call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
  return r != null;
}

/** На старті: зареєструвати вебхук (ідемпотентно; Telegram сам перезаписує). */
export async function signBotEnsureWebhook(): Promise<void> {
  const secret = webhookSecret();
  if (!secret) { console.warn("signBot: TELEGRAM_SIGN_BOT_TOKEN не заданий — бот підпису вимкнено."); return; }
  const ok = await call("setWebhook", { url: webhookUrl(), secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false });
  console.log(`signBot: webhook ${ok != null ? "зареєстровано" : "НЕ зареєстровано"} → ${webhookUrl()}`);
}
