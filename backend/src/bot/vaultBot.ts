/**
 * 🔐 БОТ «UTS Сейф» — окремий від «UTS Підпис» (рішення Романа 18.09.2026).
 *
 * Надсилає ЛИШЕ одноразові коди для перегляду доступів і підтвердження привʼязки. Паролів не
 * надсилає ніколи. Оновлення приймає вебхуком в основний процес (`routes/vaultBot.ts`), як бот
 * підпису: другий Node-процес хост убиває. Токен — `TELEGRAM_VAULT_BOT_TOKEN`; без нього все тут —
 * тихий no-op, а екран каже «бот не налаштований».
 *
 * Секрет вебхука виводиться з токена (sha256) з ІНШОЮ сіллю, ніж у бота підпису: знати секрет
 * одного вебхука не означає знати секрет іншого.
 */
import { createHash } from "crypto";

const token = () => process.env.TELEGRAM_VAULT_BOT_TOKEN?.trim() || null;
export const vaultBotConfigured = (): boolean => token() != null;

export function vaultWebhookSecret(): string | null {
  const t = token();
  return t ? createHash("sha256").update(`vault-webhook:${t}`).digest("hex").slice(0, 40) : null;
}

export function vaultWebhookUrl(): string {
  return process.env.TELEGRAM_VAULT_WEBHOOK_URL?.trim() || "https://dashboard.uts.ua/api/vault-bot/webhook";
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = (await r.json()) as { ok: boolean; result?: T; description?: string };
    // Тіла запиту НЕ логуємо: у ньому може бути код показу.
    if (!j.ok) { console.error(`vaultBot ${method}: ${j.description ?? r.status}`); return null; }
    return j.result ?? null;
  } catch (e) { console.error(`vaultBot ${method} failed:`, (e as Error).message); return null; }
}

let usernameCache: string | null = null;
export async function vaultBotUsername(): Promise<string | null> {
  if (usernameCache) return usernameCache;
  const me = await call<{ username?: string }>("getMe", {});
  usernameCache = me?.username ?? null;
  return usernameCache;
}

export async function vaultBotSend(chatId: number | string, text: string): Promise<boolean> {
  return (await call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true })) != null;
}

/** На старті: зареєструвати вебхук (ідемпотентно). */
export async function vaultBotEnsureWebhook(): Promise<void> {
  const secret = vaultWebhookSecret();
  if (!secret) { console.warn("vaultBot: TELEGRAM_VAULT_BOT_TOKEN не заданий — бот сейфу вимкнено."); return; }
  const ok = await call("setWebhook", { url: vaultWebhookUrl(), secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false });
  console.log(`vaultBot: webhook ${ok != null ? "зареєстровано" : "НЕ зареєстровано"} → ${vaultWebhookUrl()}`);
}
