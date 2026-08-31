import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

/**
 * Єдиний вхід у трекер часу — криптографічна частина.
 *
 * Трекер це ОКРЕМА наша система (репозиторій `timeTrackerManager`, власний сервер, власна база
 * користувачів). Дашборд для нього — постачальник особи: він каже, ХТО людина, і ніколи не каже,
 * що їй можна. Ролі сюди не їдуть свідомо: `provisionUsers()` переписує роль із Kommo кожні
 * 30 хвилин, тож мапінг ролей означав би, що правка в CRM тихо відкриває комусь чужий робочий
 * час через півгодини.
 *
 * Винесено в окремий файл із однієї причини: перевірка `purpose` мусить бути в ОДНОМУ місці.
 */

/**
 * 🔴 Мітка призначення. Без її перевірки при обміні звичайний 12-годинний токен входу теж
 * пройшов би — і повнопривілейна обліковка дашборду опинилась би ще в двох процесах.
 *
 * Саме тому `signAssertion`/`verifyAssertion` існують окремо від `signToken`/`verifyToken`:
 * викликати не той не вийде навіть неуважно, бо типи різні.
 */
const PURPOSE = "tracker-sso";

/** Дві хвилини: рівно стільки, скільки агент іде від входу в дашборд до трекера. */
const TTL_SECONDS = 120;

interface AssertionPayload {
  purpose: string;
  userId: number;
  email?: string;
}

/** Хто це — за словом дашборду, на дві хвилини. */
export function signAssertion(userId: number, email?: string): string {
  const payload: AssertionPayload = { purpose: PURPOSE, userId, email };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TTL_SECONDS });
}

export const ASSERTION_TTL_SECONDS = TTL_SECONDS;

/**
 * Перевірити посвідчення.
 *
 * @returns `null` на будь-яку невдачу — прострочене, підроблене, чи з чужим призначенням.
 * Свідомо без розрізнення причин: той, хто пробує, не має дізнатися, чим саме не підійшло.
 */
export function verifyAssertion(token: string): { userId: number; email?: string } | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AssertionPayload;
    if (decoded.purpose !== PURPOSE || typeof decoded.userId !== "number") {
      return null;
    }
    return { userId: decoded.userId, email: decoded.email };
  } catch {
    return null;
  }
}

/**
 * Чи це наш спільний із трекером ключ.
 *
 * `timingSafeEqual` над SHA-256, а не порівняння рядків: звичайне `===` зупиняється на першому
 * розбіжному символі, і час відповіді підказує, скільки початкових символів вгадано. Хешуємо
 * перед порівнянням, бо `timingSafeEqual` кидає на буферах різної довжини — а сама довжина
 * ключа теж не має витікати.
 */
export function ssoKeyAccepted(presented: string | undefined): boolean {
  const expected = config.tracker.ssoKey;
  if (!expected || !presented) {
    return false;
  }
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/** Чи налаштований єдиний вхід узагалі. Без цього кнопки в меню немає, а ендпоінти дають 503. */
export function ssoConfigured(): boolean {
  return Boolean(config.tracker.url && config.tracker.ssoKey);
}
