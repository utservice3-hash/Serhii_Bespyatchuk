import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { signToken } from "../auth/auth.js";
import { effectiveRoleKey, getRoleDef, scopeCompatRole } from "../auth/rbac.js";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import {
  ASSERTION_TTL_SECONDS,
  signAssertion,
  ssoConfigured,
  ssoKeyAccepted,
  verifyAssertion,
} from "../auth/trackerSso.js";

export const authRouter = Router();

// Email нормалізується (trim + нижній регістр) ще до валідації — мобільний
// автокапс/пробіл більше не ламає вхід. Пароль НЕ чіпаємо (пробіл може бути
// частиною пароля). У запиті теж lower(email) — на випадок, якщо збережений
// email містить великі літери.
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password format" });
  }
  const { email, password } = parsed.data;

  const result = await pool.query<{
    id: number;
    password_hash: string;
    role: "admin" | "team_lead" | "manager";
    role_override: string | null;
    manager_id: number | null;
    team_id: number | null;
    is_active: boolean;
  }>(
    `SELECT id, password_hash, role, role_override, manager_id, team_id, is_active FROM users WHERE lower(email) = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: "Обліковий запис деактивовано" });
  }

  // Ефективна роль = role_override ?? синкнута роль. У токен кладемо ключ ролі (для гейтів)
  // + scope-compat роль (для наявної data-scope логіки в роутах) + перелік дозволених вкладок
  // (для косметики nav у FE — сервер усе одно гейтить незалежно).
  const roleKey = effectiveRoleKey(user);
  const def = getRoleDef(roleKey);
  const screens = def ? Object.keys(def.screenAccess).filter((k) => def.screenAccess[k] === true) : undefined;
  const perms = def ? Object.keys(def.permissions).filter((k) => def.permissions[k] === true) : undefined;
  const token = signToken({
    userId: user.id,
    email,
    role: scopeCompatRole(roleKey, def),
    roleKey,
    screens,
    perms,
    managerId: user.manager_id,
    teamId: user.team_id,
  });
  res.json({ token });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ТРЕКЕР ЧАСУ — єдиний вхід
//
// Трекер це окрема наша система з власним сервером і власною базою користувачів. Тут дашборд
// виступає постачальником ОСОБИ: він каже, хто людина, і ніколи не каже, що їй можна. Ролі
// дашборду в трекер не їдуть — див. коментар у `auth/trackerSso.ts`.
//
// Усі три ендпоінти самовимкнені: без TRACKER_URL і TRACKER_SSO_KEY вони віддають 503, а пункт
// меню не рендериться. Тобто цей код можна злити задовго до того, як трекер буде готовий.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Скільки чекати на трекер, перш ніж сказати людині «недоступний». Клік не має висіти. */
const TRACKER_TIMEOUT_MS = 4000;

/**
 * Адреса, за якою людина потрапляє в трекер уже залогіненою.
 *
 * 🔴 ЖОДНОГО параметра. Ні `next`, ні `return_to`. Адреса будується з конфігу, і саме це не дає
 * ендпоінту стати відкритим редиректом. «Додати next» — очевидне наступне прохання, і воно ж
 * єдиний спосіб це зламати.
 *
 * Чому JSON, а не 302: у дашборді немає кук. Обліковка — Bearer у localStorage, який чіпляє
 * axios. Навігація верхнього рівня заголовка Authorization не несе, тож редирект-ендпоінт просто
 * не знав би, кому видавати квиток. Побічна вигода — квиток не потрапляє ні в рядок запиту, ні в
 * заголовок Location, тобто в лог nginx його не буде.
 */
authRouter.get("/tracker-sso", requireAuth, async (req, res) => {
  if (!ssoConfigured()) {
    return res.status(503).json({ error: "not_configured" });
  }

  const auth = req.auth!;
  const who = await pool.query<{ email: string; full_name: string | null }>(
    `SELECT email, full_name FROM users WHERE id = $1`,
    [auth.userId]
  );
  const person = who.rows[0];
  if (!person) {
    return res.status(503).json({ error: "not_configured" });
  }

  let answer: Response;
  try {
    answer = await fetch(`${config.tracker.url}/api/v1/sso/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dashboard-Sso-Key": config.tracker.ssoKey,
      },
      body: JSON.stringify({
        email: person.email,
        dashboardUserId: auth.userId,
        fullName: person.full_name ?? undefined,
      }),
      signal: AbortSignal.timeout(TRACKER_TIMEOUT_MS),
    });
  } catch {
    // Мережа, таймаут, TLS. Людині кажемо «недоступний» і НІКУДИ не ведемо: відкрити вкладку,
    // яка все одно попросить пароль, гірше за чесну відмову на місці.
    return res.status(504).json({ error: "tracker_unreachable" });
  }

  if (answer.status === 403) {
    const body = (await answer.json().catch(() => ({}))) as { error?: string };
    // 409, а не проксі-403: це не «вам не можна сюди», а «вас там ще немає». Дашборд показує це
    // своїми словами й ДО того, як кудись перекине — у цьому й сенс зворотного каналу.
    return res.status(409).json({
      error: body.error === "account_disabled" ? "account_disabled" : "no_tracker_account",
    });
  }
  if (!answer.ok) {
    return res.status(502).json({ error: "tracker_refused" });
  }

  const body = (await answer.json()) as { ticket?: string };
  if (!body.ticket) {
    return res.status(502).json({ error: "tracker_refused" });
  }

  // Рівно один ключ у відповіді. Нічого не розпаковуємо з тіла трекера: поле, що приїхало б сюди
  // без рішення, — це той самий клас помилки, який стереже ROW_SPREAD_EXEMPTIONS.
  res.json({ url: `${config.tracker.url}/#ticket=${body.ticket}` });
});

/**
 * Посвідчення для агента на ноутбуці: «це наша людина, ось хто саме».
 *
 * Живе дві хвилини й нікуди не записується. Обмінює його не агент, а САМ трекер — див. наступний
 * ендпоінт. Через це вкрадене посвідчення саме по собі нічого не дає: без нашого спільного ключа
 * обміняти його нікому.
 */
authRouter.post("/tracker-assertion", requireAuth, (req, res) => {
  if (!ssoConfigured()) {
    return res.status(503).json({ error: "not_configured" });
  }
  const auth = req.auth!;
  res.json({
    assertion: signAssertion(auth.userId, auth.email),
    expiresInSec: ASSERTION_TTL_SECONDS,
  });
});

/**
 * Трекер питає: чиє це посвідчення?
 *
 * Без `requireAuth` — сюди стукає сервер трекера, а не браузер, і обліковка тут заголовок
 * X-Dashboard-Sso-Key. Потрібні ОБИДВА: ключ і посвідчення. Ключ без посвідчення не називає
 * нікого, посвідчення без ключа не обмінюється — тобто крадіжка одного з двох марна.
 *
 * Навіщо цей крок узагалі, якщо посвідчення підписане: щоб JWT_SECRET лишався всередині
 * дашборду. Трекер, який уміє перевіряти наш підпис, уміє й підписати собі АДМІНСЬКИЙ токен
 * дашборду. Заразом тут ще раз перевіряється `is_active` — у момент обміну, а не видачі.
 */
authRouter.post("/tracker-identity", async (req, res) => {
  if (!ssoConfigured()) {
    return res.status(503).json({ error: "not_configured" });
  }
  if (!ssoKeyAccepted(req.header("X-Dashboard-Sso-Key"))) {
    return res.status(401).json({ error: "bad_key" });
  }

  const assertion = typeof req.body?.assertion === "string" ? req.body.assertion : "";
  const claim = verifyAssertion(assertion);
  if (!claim) {
    return res.status(401).json({ error: "invalid_assertion" });
  }

  const found = await pool.query<{ id: number; email: string; full_name: string | null; is_active: boolean }>(
    `SELECT id, email, full_name, is_active FROM users WHERE id = $1`,
    [claim.userId]
  );
  const user = found.rows[0];
  if (!user) {
    return res.status(404).json({ error: "unknown_user" });
  }

  res.json({
    userId: user.id,
    email: user.email,
    fullName: user.full_name,
    active: user.is_active,
  });
});
