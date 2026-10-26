/**
 * 🔐 Вхід віджета «ТЕСТ ЗАКАЗ 1С» — без паролів і без сесії дашборда.
 *
 * Віджет кличе нас через `self.$authorizedAjax(...)`. Kommo сам додає заголовок `X-Auth-Token` з одноразовим JWT,
 * підписаним СЕКРЕТНИМ КЛЮЧЕМ нашої приватної інтеграції. Заміряно на живому акаунті 26.10.2026 (токен віджета
 * Genesis, лише форма, без значень): `alg HS256`; поля `iss` (адреса акаунта), `aud`, `jti`, `iat`, `nbf`,
 * `exp` (≈30 хв), `account_id`, `subdomain`, `client_uuid` (ID інтеграції), `user_id`, `is_admin`.
 *
 * Отже довіряємо рівно тому, що підписав Kommo: хто відкрив (`user_id`), з якого акаунта і з якої інтеграції.
 * Підробити без секрету неможливо; секрет живе лише в env сервера, у браузер не потрапляє.
 * Межа `client_uuid` потрібна, бо підпис — секретом ІНТЕГРАЦІЇ: токен чужої інтеграції того ж акаунта мав би
 * правильний `account_id`, але не наш підпис, — а токен НАШОЇ інтеграції з іншого акаунта мав би наш підпис і
 * чужий `account_id`. Тому перевіряємо обидва.
 */
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { zakaz1cKommoAuthEnv, type Zakaz1cKommoAuthEnv } from "./env.js";

export interface KommoCaller {
  userId: number;
  accountId: number;
  isAdmin: boolean;
}

export type KommoAuthResult = { ok: true; caller: KommoCaller } | { ok: false; why: string };

/** Чиста перевірка — гейти ганяють рівно її. `nowSec` — для тестів строку дії. */
export function verifyKommoToken(token: string, env: Zakaz1cKommoAuthEnv, nowSec?: number): KommoAuthResult {
  if (!env.secret || !env.clientUuid) return { ok: false, why: "модуль не налаштований: немає секрету або ID інтеграції" };
  if (!token) return { ok: false, why: "немає токена Kommo" };
  let p: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, env.secret, {
      algorithms: ["HS256"],
      clockTolerance: 30,
      ...(nowSec !== undefined ? { clockTimestamp: nowSec } : {}),
    });
    if (typeof decoded === "string") return { ok: false, why: "токен без полів" };
    p = decoded;
  } catch (e) {
    const name = (e as Error).name;
    return { ok: false, why: name === "TokenExpiredError" ? "токен Kommo прострочений" : "підпис Kommo не збігся" };
  }
  if (String(p.client_uuid ?? "") !== env.clientUuid) return { ok: false, why: "токен іншої інтеграції" };
  if (Number(p.account_id) !== env.accountId) return { ok: false, why: "токен іншого акаунта Kommo" };
  const userId = Number(p.user_id);
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, why: "у токені немає користувача" };
  return { ok: true, caller: { userId, accountId: env.accountId, isAdmin: p.is_admin === true } };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      kommoCaller?: KommoCaller;
    }
  }
}

/** Мідлвар: без валідного токена Kommo — 401, і далі нічого не виконується. */
export function requireKommoCaller(req: Request, res: Response, next: NextFunction) {
  const token = String(req.headers["x-auth-token"] ?? "");
  const r = verifyKommoToken(token, zakaz1cKommoAuthEnv());
  if (!r.ok) {
    res.status(401).json({ error: `Вхід через Kommo не підтверджено: ${r.why}.` });
    return;
  }
  req.kommoCaller = r.caller;
  next();
}
