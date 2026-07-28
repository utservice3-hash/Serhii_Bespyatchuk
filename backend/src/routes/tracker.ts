// Бекенд трекера часу — ОКРЕМА підсистема (банк/CRM не чіпає). Власна авторизація device-токеном
// (НЕ JWT), тож роутер монтується БЕЗ requireAuth. asyncH — автоматично через Router-патч.
import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { effectiveRoleKey } from "../auth/rbac.js";

export const trackerRouter = Router();

// Конфіг агента (нові поля можна додавати — агент ігнорує незнайомі).
const CONFIG = { idleThresholdSec: 300, heartbeatIntervalSec: 60, trackApps: false };
const MAX_BATCH = 500;
const MAX_INTERVAL_MS = 10 * 60 * 1000; // >10 хв — пропускаємо
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

  res.json({ deviceToken: token, manager: { id: u.id, name: u.pib }, config: CONFIG });
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
interface CleanInterval { startedAt: Date; endedAt: Date; state: "active" | "idle"; app: string | null; windowTitle: string | null; inputEvents: number | null }
// Валідує ОДИН інтервал структурно + за правилами (ended>started, ≤10хв). Бракований → null (пропуск).
function cleanInterval(it: unknown): CleanInterval | null {
  if (!it || typeof it !== "object") return null;
  const o = it as Record<string, unknown>;
  const s = typeof o.startedAt === "string" ? Date.parse(o.startedAt) : NaN;
  const e = typeof o.endedAt === "string" ? Date.parse(o.endedAt) : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (e <= s) return null;                       // ended має бути пізніше started
  if (e - s > MAX_INTERVAL_MS) return null;      // >10 хв — пропустити
  if (o.state !== "active" && o.state !== "idle") return null;
  return {
    startedAt: new Date(s), endedAt: new Date(e), state: o.state,
    app: typeof o.app === "string" ? o.app : null,
    windowTitle: typeof o.windowTitle === "string" ? o.windowTitle : null,
    inputEvents: Number.isInteger(o.inputEvents) ? (o.inputEvents as number) : null,
  };
}

trackerRouter.post("/heartbeat", async (req, res) => {
  const dev = await deviceByToken(req);
  if (!dev) return res.status(401).json({ error: "token_revoked" });

  const body = req.body;
  // 400 ЛИШЕ для структурно битого пейлоада — не через один аномальний інтервал.
  if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "validation", message: "body must be object" });
  if (body.intervals != null && !Array.isArray(body.intervals)) return res.status(400).json({ error: "validation", message: "intervals must be array" });
  if (Array.isArray(body.intervals) && body.intervals.length > MAX_BATCH) return res.status(400).json({ error: "validation", message: "too many intervals" });

  await pool.query(`UPDATE tracker_devices SET last_seen_at = now(), agent_version = COALESCE($2, agent_version) WHERE id = $1`,
    [dev.id, typeof body.agentVersion === "string" ? body.agentVersion : null]);

  // Очищаємо аномальні, сортуємо за часом, відкидаємо перетини (не перетинаються).
  const cand = (Array.isArray(body.intervals) ? (body.intervals as unknown[]) : [])
    .map(cleanInterval).filter((x): x is CleanInterval => x !== null)
    .sort((a, b) => +a.startedAt - +b.startedAt);
  const toInsert: CleanInterval[] = [];
  let lastEnd = -Infinity;
  for (const c of cand) { if (+c.startedAt < lastEnd) continue; toInsert.push(c); lastEnd = +c.endedAt; }

  let accepted = 0;
  for (const c of toInsert) {
    const ins = await pool.query(
      `INSERT INTO tracker_intervals (device_id, user_id, manager_id, started_at, ended_at, state, app, window_title, input_events)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (device_id, started_at) DO NOTHING RETURNING id`,
      [dev.id, dev.user_id, dev.manager_id, c.startedAt, c.endedAt, c.state, c.app, c.windowTitle, c.inputEvents]);
    if (ins.rowCount) accepted++;
  }
  res.json({ ok: true, accepted, config: CONFIG });
});

// ─────────────────────────── POST /logout ───────────────────────────
trackerRouter.post("/logout", async (req, res) => {
  const token = req.header("X-Tracker-Token");
  if (token) await pool.query(`UPDATE tracker_devices SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  res.json({ ok: true });
});
