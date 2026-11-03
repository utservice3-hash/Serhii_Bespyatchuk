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
import https from "https";

const token = () => process.env.TELEGRAM_VAULT_BOT_TOKEN?.trim() || null;
export const vaultBotConfigured = (): boolean => token() != null;

export function vaultWebhookSecret(): string | null {
  const t = token();
  return t ? createHash("sha256").update(`vault-webhook:${t}`).digest("hex").slice(0, 40) : null;
}

export function vaultWebhookUrl(): string {
  return process.env.TELEGRAM_VAULT_WEBHOOK_URL?.trim() || "https://dashboard.uts.ua/api/vault-bot/webhook";
}

/**
 * 🌐 ЗАПИТ ДО TELEGRAM — ЛИШЕ IPv4 і з тайм-аутом (03.11.2026). `fetch` із прод-сервера до api.telegram.org ЗАВИСАВ
 * (той самий клас, що Google у перекладі #5940: Node обирає IPv6, а `curl` проходить за 0,1 с). Зависле `getMe`
 * тримало `/secrets/status`, і «Співробітники», «Плинність», «Exit» у «Наймі» падали в «скоро» — у всіх, хто має право.
 */
export const VAULT_TG_TIMEOUT_MS = 8_000;
export function tgPost(path: string, payload: string, timeoutMs = VAULT_TG_TIMEOUT_MS): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "api.telegram.org", path, method: "POST", family: 4, timeout: timeoutMs,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { raw += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on("timeout", () => req.destroy(new Error(`немає відповіді ${Math.round(timeoutMs / 1000)} с`)));
    req.on("error", (e) => reject(e));
    req.end(payload);
  });
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const t = token();
  if (!t) return null;
  try {
    const r = await tgPost(`/bot${t}/${method}`, JSON.stringify(body));
    const j = JSON.parse(r.body) as { ok: boolean; result?: T; description?: string };
    // Тіла запиту НЕ логуємо: у ньому може бути код показу. Токен — теж (він у шляху запиту).
    if (!j.ok) { console.error(`vaultBot ${method}: ${j.description ?? r.status}`); return null; }
    return j.result ?? null;
  } catch (e) { console.error(`vaultBot ${method} failed:`, (e as Error).message.replaceAll(t, "***")); return null; }
}

let usernameCache: string | null = null;
export async function vaultBotUsername(): Promise<string | null> {
  if (usernameCache) return usernameCache;
  const me = await call<{ username?: string }>("getMe", {});
  usernameCache = me?.username ?? null;
  return usernameCache;
}

/**
 * Імʼя бота для СТАТУСУ (екрани «Найму»): чекаємо щонайбільше `ms`, далі — `null`. Статус відповідає на «чи є доступ»,
 * а імʼя бота потрібне лише кнопці привʼязки — тож повільний Telegram не має права тримати вкладки. `get` — для гейта.
 */
export async function vaultBotUsernameQuick(ms = 3_000, get: () => Promise<string | null> = vaultBotUsername): Promise<string | null> {
  if (usernameCache) return usernameCache;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([get().catch(() => null), late]); }
  finally { clearTimeout(timer); }
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
