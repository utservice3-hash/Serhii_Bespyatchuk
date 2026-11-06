/**
 * 💳 Номери карт «Зарплати» (ТЗ §2, §11): у БД — лише зашифровано; на екрані — •••• останні 4; повністю — лише у
 * відомості й Excel для фінансистів (право `payroll_export_cards`). Шифр — AES-256-GCM у Node (без розширень Postgres),
 * ключ — `PAYROLL_CARD_KEY` (64 hex-символи) ЛИШЕ в .env сервера. Хеш для «та сама карта двічі» — HMAC-SHA256 тим же ключем.
 * Немає ключа — карти не приймаються (зрозуміла помилка), решта «Зарплати» працює.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { luhn } from "./engine/zarplata-engine.mjs";

export class CardKeyMissing extends Error {
  constructor() { super("Карти тимчасово недоступні: на сервері не налаштовано ключ шифрування (PAYROLL_CARD_KEY). Зверніться до адміністратора."); }
}
function key(): Buffer {
  const hex = (process.env.PAYROLL_CARD_KEY || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new CardKeyMissing();
  return Buffer.from(hex, "hex");
}
export const cardsAvailable = (): boolean => { try { key(); return true; } catch { return false; } };
export const digitsOf = (s: string): string => String(s).replace(/\D/g, "");

export function validateCard(number: string, holder: string): string | null {
  const d = digitsOf(number);
  if (d.length < 16 || d.length > 19) return "Номер карти — 16–19 цифр.";
  if (!luhn(d)) return "Номер карти з помилкою — перевірте цифри (контрольна сума не сходиться).";
  if (!String(holder ?? "").trim()) return "Вкажіть ПІБ отримувача — карта може бути на іншу людину.";
  return null;
}
export function encryptCard(number: string): { enc: Buffer; last4: string; hash: string } {
  const k = key(), d = digitsOf(number), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([c.update(d, "utf8"), c.final()]);
  return { enc: Buffer.concat([iv, c.getAuthTag(), body]), last4: d.slice(-4), hash: createHmac("sha256", k).update(d).digest("hex") };
}
export function decryptCard(enc: Buffer): string {
  const k = key(), iv = enc.subarray(0, 12), tag = enc.subarray(12, 28), body = enc.subarray(28);
  const d = createDecipheriv("aes-256-gcm", k, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}
export const cardHash = (number: string): string => createHmac("sha256", key()).update(digitsOf(number)).digest("hex");
