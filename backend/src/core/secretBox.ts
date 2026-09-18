/**
 * 🔐 СЕЙФ ДОСТУПІВ — ЧИСТІ ПРАВИЛА Й ШИФР (18.09.2026). Без БД і без `config`.
 *
 * Шифр — AES-256-GCM із вбудованого `node:crypto`: жодної власної криптографії. Кожен запис —
 * свій випадковий IV (12 байт) і тег цілісності. Додаткові дані (AAD) привʼязують шифр до
 * ЛЮДИНИ, ТИПУ й СЕРВІСУ: шифр пароля Олени, підставлений у рядок Андрія чи в інший сервіс, не
 * розшифрується — підміна рядків у базі дає помилку, а не чужий пароль.
 *
 * Ключ приходить параметром (з `.env`, `EMPLOYEE_SECRETS_KEY`, 32 байти в base64). Модуль його
 * не читає сам — так гейти ганяють шифр на власному ключі, а без ключа нічого не розшифрується.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const KEY_VERSION = 1;
export const REVEAL_SECONDS = 30;
export const REVEAL_CODE_TTL_MS = 5 * 60_000;
export const REVEAL_MAX_ATTEMPTS = 3;
export const LINK_CODE_TTL_MS = 10 * 60_000;

/** Сервіси з таблиці «UTS Співробітники УКР» + «інше» для решти. */
export const SECRET_SERVICES = [
  ["kommo", "Kommo"], ["ringostat", "Ringostat"], ["trans_eu", "trans.eu"], ["lardi", "Lardi-Trans"],
  ["della", "Della"], ["yaware", "Yaware"], ["mail", "Пошта"], ["dashboard", "Дашборд"], ["other", "Інше"],
] as const;
export const SERVICE_LABEL: Record<string, string> = Object.fromEntries(SECRET_SERVICES);
export const CARD_SERVICE = "card";

export class SecretKeyMissing extends Error {
  constructor() { super("Сейф не налаштовано: на сервері немає ключа шифрування"); }
}

/** Ключ із `.env`: рівно 32 байти в base64. Будь-що інше — `null` (сейф вимкнений, а не «якось працює»). */
export function parseKey(raw: string | null | undefined): Buffer | null {
  if (!raw || !raw.trim()) return null;
  const b = Buffer.from(raw.trim(), "base64");
  return b.length === 32 ? b : null;
}

export const aadFor = (userId: number, kind: string, service: string): string => `uts-secret:v1:${userId}:${kind}:${service}`;

export interface SealedSecret { cipher: string; iv: string; tag: string }

export function seal(key: Buffer | null, plaintext: string, aad: string): SealedSecret {
  if (!key) throw new SecretKeyMissing();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const cipher = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { cipher: cipher.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

/** Кидає, якщо ключ не той, шифр чи тег підмінено, або AAD належить іншому рядку. */
export function unseal(key: Buffer | null, box: SealedSecret, aad: string): string {
  if (!key) throw new SecretKeyMissing();
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.cipher, "base64")), d.final()]).toString("utf8");
}

/** Номер картки: лише цифри, 12–19 знаків. Повертає нормалізований номер або `null`. */
export function normalizeCard(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/[\s-]/g, "");
  return /^\d{12,19}$/.test(d) ? d : null;
}
export const cardLast4 = (digits: string): string => digits.slice(-4);

/** 6 цифр криптографічно випадково (не `Math.random`: код відкриває пароль). */
export const newRevealCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const newSalt = (): string => randomBytes(16).toString("hex");
export const hashCode = (code: string, salt: string): string =>
  createHash("sha256").update(`${salt}:${code}`, "utf8").digest("hex");

export type RevealVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 410; reason: string; attemptsLeft: number };

/**
 * Перевірка коду показу. Спершу «мертві» стани (використано, прострочено, спроби), потім сам код.
 * Хибний код зʼїдає спробу; після трьох код згорає — треба надіслати новий.
 */
export function verifyRevealCode(
  rec: { codeHash: string; salt: string; attempts: number; expiresAt: Date | string; usedAt: Date | string | null },
  input: unknown, now: Date,
): RevealVerdict {
  const left = Math.max(0, REVEAL_MAX_ATTEMPTS - rec.attempts);
  if (rec.usedAt != null) return { ok: false, status: 410, reason: "Код уже використано — надішліть новий", attemptsLeft: 0 };
  if (new Date(rec.expiresAt).getTime() <= now.getTime()) return { ok: false, status: 410, reason: "Код прострочено (діє 5 хвилин) — надішліть новий", attemptsLeft: 0 };
  if (rec.attempts >= REVEAL_MAX_ATTEMPTS) return { ok: false, status: 410, reason: "Три невдалі спроби — надішліть новий код", attemptsLeft: 0 };
  const got = Buffer.from(hashCode(String(input ?? "").trim(), rec.salt), "hex");
  const want = Buffer.from(rec.codeHash, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want))
    return { ok: false, status: 403, reason: left - 1 > 0 ? `Код не той. Лишилось спроб: ${left - 1}` : "Код не той. Спроби вичерпано — надішліть новий", attemptsLeft: Math.max(0, left - 1) };
  return { ok: true };
}

/** Текст у Telegram: лише код і що він відкриває. САМОГО ПАРОЛЯ В ПОВІДОМЛЕННІ НЕМАЄ НІКОЛИ. */
export function revealCodeMessage(code: string, what: string, whose: string): string {
  return `🔐 Код для перегляду «${what}» · ${whose}: ${code}\nДіє 5 хвилин, один раз. Якщо ви цього не робили — повідомте Сергія.`;
}
