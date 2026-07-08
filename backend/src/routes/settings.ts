import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { provisionUsers, resetPassword, generatePassword } from "../db/userProvisioning.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

export interface AppSettings {
  loyaltyThreshold: number; // paid orders to count as a "regular" client
  loyaltyWindowMonths: number; // window for the threshold
  sleepingWindowMonths: number; // lapsed-but-recoverable lookback
  receivablesOverdueWarnDays: number; // highlight debt overdue beyond this
  // Базовий тариф калькулятора ставок (грн/км), коли заявок по напрямку немає:
  // окремо ціла машина і догруз («зелена зона» з карти прорахунку).
  ratesFallbackFullPerKm: number;
  ratesFallbackPartPerKm: number;
  // Значення поля «Источник клиента» (2098035), що рахуються як «прийнята
  // реклама» в повному циклі (KPI ads_count). Ручний метод КВП: 6 сайтових
  // джерел. Admin-редаговане — можна додавати/прибирати без правок коду.
  adSources: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  loyaltyThreshold: 2,
  loyaltyWindowMonths: 2,
  sleepingWindowMonths: 6,
  receivablesOverdueWarnDays: 0,
  ratesFallbackFullPerKm: 25,
  ratesFallbackPartPerKm: 15,
  adSources: [
    "uts.ua", "Дзвінок з uts.ua", "Callback з uts.ua",
    "yalogist.com.ua", "Дзвінок з yalogist.com.ua", "Callback з yalogist.com.ua",
  ],
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
    ratesFallbackFullPerKm: clampInt(body.ratesFallbackFullPerKm, 1, 500, current.ratesFallbackFullPerKm),
    ratesFallbackPartPerKm: clampInt(body.ratesFallbackPartPerKm, 1, 500, current.ratesFallbackPartPerKm),
    adSources: Array.isArray(body.adSources)
      ? [...new Set((body.adSources as unknown[]).map((s) => String(s).trim()).filter((s) => s.length > 0))]
      : current.adSources,
  };

  await pool.query(
    `UPDATE app_settings SET data = $1 WHERE id = 1`,
    [JSON.stringify(next)]
  );
  res.json({ settings: next });
});

function requireAdmin(role: string, res: import("express").Response): boolean {
  if (role !== "admin") {
    res.status(403).json({ error: "Лише адміністратор" });
    return false;
  }
  return true;
}

// --- User management (admin only) ---

settingsRouter.get("/users", async (req, res) => {
  if (!requireAdmin(req.auth!.role, res)) return;
  // Hide logins whose CRM manager is deactivated / no longer in CRM (manager
  // linked but inactive). Admin (no manager link) and active managers stay.
  const result = await pool.query(
    `SELECT u.id, u.email, u.role, u.is_active, u.initial_password,
            COALESCE(m.name, CASE WHEN u.role = 'admin' THEN 'Операційний директор' END) AS manager_name,
            t.name AS team_name
     FROM users u
     LEFT JOIN managers m ON m.id = u.manager_id
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.manager_id IS NULL OR m.is_active
     ORDER BY u.role = 'admin' DESC, t.name NULLS LAST, u.email`
  );
  res.json({ users: result.rows });
});

// Manually create a login (email + password). Password optional — generated
// and returned if omitted.
settingsRouter.post("/users", async (req, res) => {
  if (!requireAdmin(req.auth!.role, res)) return;
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const role = ["admin", "team_lead", "manager"].includes(req.body?.role) ? req.body.role : "manager";
  const teamId = req.body?.teamId ? Number(req.body.teamId) : null;
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Невірний e-mail" });
  }
  const exists = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (exists.rowCount) return res.status(409).json({ error: "Користувач з таким e-mail вже існує" });

  const password = String(req.body?.password ?? "").trim() || generatePassword();
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (email, password_hash, role, team_id, is_active, initial_password)
     VALUES ($1, $2, $3, $4, true, $5)`,
    [email, passwordHash, role, teamId, password]
  );
  res.json({ email, password });
});

// Re-sync logins from the current CRM roster; returns any newly created creds.
settingsRouter.post("/users/provision", async (req, res) => {
  if (!requireAdmin(req.auth!.role, res)) return;
  const created = await provisionUsers();
  res.json({ created });
});

settingsRouter.post("/users/:id/reset-password", async (req, res) => {
  if (!requireAdmin(req.auth!.role, res)) return;
  const password = await resetPassword(Number(req.params.id));
  res.json({ password });
});

// Toggle a user's role (team lead vs. manager) and active state.
settingsRouter.patch("/users/:id", async (req, res) => {
  if (!requireAdmin(req.auth!.role, res)) return;
  const id = Number(req.params.id);
  const current = await pool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!current.rows[0]) return res.status(404).json({ error: "Користувача не знайдено" });
  if (current.rows[0].role === "admin") {
    return res.status(400).json({ error: "Не можна змінювати адміністратора" });
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (req.body.role === "team_lead" || req.body.role === "manager") {
    params.push(req.body.role);
    sets.push(`role = $${params.length}`);
  }
  if (typeof req.body.isActive === "boolean") {
    params.push(req.body.isActive);
    sets.push(`is_active = $${params.length}`);
  }
  if (sets.length === 0) return res.json({ ok: true });
  params.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  res.json({ ok: true });
});
