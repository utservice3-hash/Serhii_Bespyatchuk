import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

export interface AppSettings {
  loyaltyThreshold: number; // paid orders to count as a "regular" client
  loyaltyWindowMonths: number; // window for the threshold
  sleepingWindowMonths: number; // lapsed-but-recoverable lookback
  receivablesOverdueWarnDays: number; // highlight debt overdue beyond this
}

export const DEFAULT_SETTINGS: AppSettings = {
  loyaltyThreshold: 2,
  loyaltyWindowMonths: 2,
  sleepingWindowMonths: 6,
  receivablesOverdueWarnDays: 0,
};

/** Reads the persisted settings merged over defaults. */
export async function getSettings(): Promise<AppSettings> {
  const result = await pool.query<{ data: Partial<AppSettings> }>(
    `SELECT data FROM app_settings WHERE id = 1`
  );
  return { ...DEFAULT_SETTINGS, ...(result.rows[0]?.data ?? {}) };
}

settingsRouter.get("/", async (_req, res) => {
  res.json({ settings: await getSettings() });
});

settingsRouter.put("/", async (req, res) => {
  if (req.auth!.role !== "admin") {
    return res.status(403).json({ error: "Лише адміністратор може змінювати налаштування" });
  }

  const body = req.body ?? {};
  const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const current = await getSettings();
  const next: AppSettings = {
    loyaltyThreshold: clampInt(body.loyaltyThreshold, 1, 50, current.loyaltyThreshold),
    loyaltyWindowMonths: clampInt(body.loyaltyWindowMonths, 1, 24, current.loyaltyWindowMonths),
    sleepingWindowMonths: clampInt(body.sleepingWindowMonths, 1, 36, current.sleepingWindowMonths),
    receivablesOverdueWarnDays: clampInt(body.receivablesOverdueWarnDays, 0, 365, current.receivablesOverdueWarnDays),
  };

  await pool.query(
    `UPDATE app_settings SET data = $1 WHERE id = 1`,
    [JSON.stringify(next)]
  );
  res.json({ settings: next });
});
