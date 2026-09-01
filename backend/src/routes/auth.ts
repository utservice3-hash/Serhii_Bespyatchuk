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

// Time tracker SSO. The tracker is a separate system with its own server and user table; the
// dashboard supplies identity only. See auth/trackerSso.ts.
//
// All three endpoints are self-disabling: without TRACKER_URL and TRACKER_SSO_KEY they answer
// 503 and the nav item does not render, so this can merge long before the tracker is ready.

/** How long to wait on the tracker before telling the user it is unavailable. */
const TRACKER_TIMEOUT_MS = 4000;

/**
 * The URL that drops a person into the tracker already signed in.
 *
 * Takes no parameters at all — no `next`, no `return_to`. The target is built from config, which
 * is what keeps this from becoming an open redirect. Adding `next` is the obvious next request
 * and the only way to break it.
 *
 * JSON rather than a 302 because the dashboard has no cookies: the credential is a Bearer token
 * in localStorage that axios attaches, and a top-level navigation carries no Authorization
 * header. Side benefit: the ticket lands in neither the request line nor a Location header, so
 * it never reaches the nginx log.
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
    // Network, timeout, TLS. Say so and navigate nowhere: a tab that then asks for a password is
    // worse than an honest refusal here.
    return res.status(504).json({ error: "tracker_unreachable" });
  }

  if (answer.status === 403) {
    const body = (await answer.json().catch(() => ({}))) as { error?: string };
    // 409 rather than proxying the 403: this is "you are not there yet", not "you may not". The
    // dashboard explains it in its own words before navigating anywhere.
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

  // Exactly one key. Nothing is spread out of the tracker's body: a field arriving without a
  // decision is the class of mistake ROW_SPREAD_EXEMPTIONS exists for.
  res.json({ url: `${config.tracker.url}/#ticket=${body.ticket}` });
});

/**
 * An assertion for the desktop agent: this is our person, and here is who.
 *
 * Lives two minutes and is stored nowhere. The tracker redeems it, not the agent — so a stolen
 * assertion alone is useless without the shared key.
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
 * The tracker asking whose assertion this is.
 *
 * No requireAuth: the caller is the tracker's server, not a browser, and the credential is the
 * X-Dashboard-Sso-Key header. Both are required — a key names nobody, an assertion redeems
 * nowhere — so stealing either one alone is useless.
 *
 * The round trip exists so JWT_SECRET stays inside the dashboard: a tracker able to verify our
 * signature is also able to mint dashboard admin tokens. It also re-checks is_active at
 * redemption rather than at issue.
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
