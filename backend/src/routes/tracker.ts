// Бекенд трекера часу — ОКРЕМА підсистема (банк/CRM не чіпає). Власна авторизація device-токеном
// (НЕ JWT), тож роутер монтується БЕЗ requireAuth. asyncH — автоматично через Router-патч.
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { effectiveRoleKey } from "../auth/rbac.js";
import { getSettings } from "./settings.js";
import { acceptBatch } from "../tracker/intervalPolicy.js";

export const trackerRouter = Router();

// 🔴 КОНФІГ АГЕНТА ЖИВЕ В НАЛАШТУВАННЯХ, а не тут (`AppSettings.tracker`).
// Причина та сама, з якої класифікує сервер, а не агент: правило міняється
// частіше, ніж виходить версія агента, і поки версії різні — двоє людей за той
// самий час дістануть дані різної якості. Тепер зміна діє без релізу й без
// перелогіну (конфіг їде і в /auth, і у відповіді /heartbeat).
const MAX_BATCH = 500;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");


// ─────────────────────────── POST /auth ───────────────────────────
const authSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  device: z.object({
    platform: z.string().min(1),
    hostname: z.string().nullish(),
    agentVersion: z.string().nullish(),
  }),
});

trackerRouter.post("/auth", async (req, res) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation", details: parsed.error.issues });
  const { email, password, device } = parsed.data;

  const r = await pool.query<{
    id: number; password_hash: string; role: string; role_override: string | null;
    manager_id: number | null; is_active: boolean; tracker_enabled: boolean; pib: string;
  }>(
    `SELECT u.id, u.password_hash, u.role, u.role_override, u.manager_id, u.is_active, u.tracker_enabled,
            COALESCE(m.name, u.full_name, u.email) AS pib
       FROM users u LEFT JOIN managers m ON m.id = u.manager_id
      WHERE lower(u.email) = $1`, [email]);
  const u = r.rows[0];
  // Той самий bcrypt-механізм, що логін дашборда. Невірні дані → 401.
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: "invalid_credentials" });
  if (!u.is_active) return res.status(403).json({ error: "account_disabled" });
  // Гейт: ефективна роль manager АБО явно ввімкнений tracker_enabled. Адмінів «усіх» — НЕ пускаємо.
  const allowed = effectiveRoleKey(u) === "manager" || u.tracker_enabled === true;
  if (!allowed) return res.status(403).json({ error: "role_not_allowed" });

  const token = crypto.randomBytes(32).toString("hex"); // 64 hex-символи; повертаємо РАЗ
  await pool.query(
    `INSERT INTO tracker_devices (user_id, manager_id, token_hash, platform, hostname, agent_version, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())`,
    [u.id, u.manager_id, sha256(token), device.platform, device.hostname ?? null, device.agentVersion ?? null]);

  res.json({ deviceToken: token, manager: { id: u.id, name: u.pib }, config: (await getSettings()).tracker });
});

// ─────────────────────────── спільне: пристрій за токеном ───────────────────────────
async function deviceByToken(req: import("express").Request) {
  const token = req.header("X-Tracker-Token");
  if (!token) return null;
  const r = await pool.query<{ id: number; user_id: number; manager_id: number | null }>(
    `SELECT id, user_id, manager_id FROM tracker_devices WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  return r.rows[0] ?? null;
}

// ─────────────────────────── POST /heartbeat ───────────────────────────
trackerRouter.post("/heartbeat", async (req, res) => {
  const dev = await deviceByToken(req);
  if (!dev) return res.status(401).json({ error: "token_revoked" });
  const cfg = (await getSettings()).tracker;

  const body = req.body;
  // 400 ЛИШЕ для структурно битого пейлоада — не через один аномальний інтервал.
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "validation", message: "body must be object" });
  if (body.intervals != null && !Array.isArray(body.intervals)) return res.status(400).json({ error: "validation", message: "intervals must be array" });
  if (Array.isArray(body.intervals) && body.intervals.length > MAX_BATCH) return res.status(400).json({ error: "validation", message: "too many intervals" });

  await pool.query(`UPDATE tracker_devices SET last_seen_at = now(), agent_version = COALESCE($2, agent_version) WHERE id = $1`,
    [dev.id, typeof body.agentVersion === "string" ? body.agentVersion : null]);

  const { toInsert, rejected } = acceptBatch(
    Array.isArray(body.intervals) ? (body.intervals as unknown[]) : [], cfg, Date.now());

  let accepted = 0, duplicate = 0;
  for (const c of toInsert) {
    const ins = await pool.query(
      `INSERT INTO tracker_intervals (device_id, user_id, manager_id, started_at, ended_at, state, app, source, window_title, input_events)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (device_id, started_at) DO NOTHING RETURNING id`,
      [dev.id, dev.user_id, dev.manager_id, c.startedAt, c.endedAt, c.state, c.app, c.source, c.windowTitle, c.inputEvents]);
    if (ins.rowCount) accepted++; else duplicate++;
  }
  // `received + accepted + rejected + duplicate` завжди сходиться — саме це й дає
  // агенту змогу побачити, що частина даних не доїхала.
  res.json({
    ok: true, received: Array.isArray(body.intervals) ? body.intervals.length : 0,
    accepted, duplicate, rejected, config: cfg,
  });
});

// ─────────────────────────── POST /logout ───────────────────────────
trackerRouter.post("/logout", async (req, res) => {
  const token = req.header("X-Tracker-Token");
  if (token) await pool.query(`UPDATE tracker_devices SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  res.json({ ok: true });
});
