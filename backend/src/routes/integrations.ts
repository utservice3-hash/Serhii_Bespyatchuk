import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { trackerPeriodError, trackerVacations } from "../core/vacationRules.js";

/**
 * 🔌 ЗАПИТИ ДЛЯ ІНШИХ НАШИХ СИСТЕМ. Без `requireAuth`: стукає СЕРВЕР іншої системи, не браузер; межа — ключ у
 * заголовку, свій на кожну інтеграцію (реєстр винятків — `auth/gates.ts`).
 */
export const integrationsRouter = Router();

/** Порівняння ключа без витоку через час відповіді: SHA-256 обох, потім timingSafeEqual (як `ssoKeyAccepted`). */
function keyAccepted(presented: string | undefined, expected: string): boolean {
  if (!expected || !presented) return false;
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 🏖 ВІДПУСТКИ ДЛЯ ТАЙМ-ТРЕКЕРА (5149, етап 3). `?from=YYYY-MM-DD&to=YYYY-MM-DD`, обидва дні включно, не довше року.
 * Відповідь: `{ vacations: [{ dashboardUserId, email, from, until, type: "vacation" }] }` — правило в `trackerVacations`.
 * Ключ — `X-Tracker-Vacations-Key` (`TRACKER_VACATIONS_KEY`), окремий від SSO і лише на читання.
 */
integrationsRouter.get("/tracker/vacations", async (req, res) => {
  if (!config.tracker.vacationsKey) return res.status(503).json({ error: "not_configured" });
  if (!keyAccepted(req.header("X-Tracker-Vacations-Key"), config.tracker.vacationsKey)) return res.status(401).json({ error: "bad_key" });
  const { from, to } = req.query;
  const err = trackerPeriodError(from, to);
  if (err) return res.status(400).json({ error: err });
  res.json({ vacations: await trackerVacations(pool, from as string, to as string) });
});
