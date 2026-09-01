import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

/**
 * SSO into the time tracker — the crypto half.
 *
 * The tracker is a separate system of ours with its own server and user table. The dashboard
 * only asserts who someone is; it never asserts what they may see. Roles are not mapped:
 * provisionUsers() rewrites role from Kommo every 30 minutes, so a mapping would open someone
 * else's working hours half an hour after a CRM edit.
 *
 * Separate file so the purpose check below lives in exactly one place.
 */

/**
 * Without this check an ordinary 12-hour login token would pass as an assertion, putting a
 * full-privilege credential into two more processes. Kept apart from signToken/verifyToken so
 * the wrong one cannot be called by accident — the types differ.
 */
const PURPOSE = "tracker-sso";

/** Two minutes: the agent's trip from dashboard login to tracker. */
const TTL_SECONDS = 120;

interface AssertionPayload {
  purpose: string;
  userId: number;
  email?: string;
}

/** Who this is, by the dashboard's word, for two minutes. */
export function signAssertion(userId: number, email?: string): string {
  const payload: AssertionPayload = { purpose: PURPOSE, userId, email };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: TTL_SECONDS });
}

export const ASSERTION_TTL_SECONDS = TTL_SECONDS;

/**
 * `null` on any failure — expired, forged, or issued for something else. Reasons are not
 * distinguished: whoever is probing should not learn which part failed.
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
 * 🔴 ПОСВІДЧЕННЯ НЕ Є ОБЛІКОВКОЮ ДЛЯ ВИДАЧІ ПОСВІДЧЕНЬ.
 *
 * Заміряно 01.09.2026 живим викликом обробника: посвідчення підписане тим самим
 * `JWT_SECRET`, що й токен входу, а `verifyToken` — це голий `jwt.verify` без перевірки
 * призначення. Тому посвідчення проходило як Bearer, і `POST /tracker-assertion` видавав
 * за ним НОВЕ посвідчення: три продовження поспіль дали HTTP 200. Двохвилинний строк
 * життя був декоративним — хто здобув одне, тримав його безстроково.
 *
 * 🔴 ТВЕРДЖЕННЯ САМЕ ТАКЕ: роут вимагає токен БЕЗ поля `purpose`, тобто справжній токен
 * входу. Формулювання «не пускати токени з purpose» описувало б те саме сьогодні й
 * розійшлося б завтра, щойно зʼявиться друге призначення: обривати треба РІВНО ланцюг
 * «посвідчення → нове посвідчення», а браузерна сесія мусить працювати далі.
 */
export function isLoginToken(auth: unknown): boolean {
  return typeof auth === "object" && auth !== null && !("purpose" in (auth as Record<string, unknown>));
}

/**
 * timingSafeEqual over SHA-256 rather than `===`: string comparison stops at the first
 * mismatching character, and the response time leaks how much was guessed. Hashing first
 * because timingSafeEqual throws on differing lengths, and the key length should not leak either.
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

/**
 * 🔴 КОМУ ДАШБОРД ВІДКРИВАЄ ТРЕКЕР — ОДНЕ МІСЦЕ НА FE І СЕРВЕР.
 *
 * Рішення власника 01.09.2026: «питати кнопку». Ознака вже існує — `users.tracker_enabled`,
 * нею керує екран налаштувань, і її ж читає наявний `routes/tracker.ts`; другої не заводимо.
 * Предикат окремо, бо ховання пункту в меню НІЧОГО не закриває: адресу можна попросити
 * напряму, тож те саме рішення мусить стояти й на сервері.
 */
export function trackerAllowed(person: { tracker_enabled?: boolean } | null | undefined): boolean {
  return Boolean(person?.tracker_enabled);
}

/** Unconfigured means: no nav item, and every endpoint answers 503. */
export function ssoConfigured(): boolean {
  return Boolean(config.tracker.url && config.tracker.ssoKey);
}
