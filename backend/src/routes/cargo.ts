/**
 * 🚚 КОНФІГУРАТОР ВАНТАЖУ В АВТО — /api/cargo/* (12.10.2026). Вкладка екрана «Калькулятор ставок та вантажу».
 *
 * Код Сергія (`roman-package-konfigurator/server/routes/cargoConfigurator.ts`, макет v3) перенесено з такими змінами — і лише ними:
 *  1. Вхід — наш `requireAuth` + вкладка `rates` першим оператором (доступ — усі, хто бачить калькулятор ставок, рішення 09.10).
 *  2. «Адмін» пакета (`role === 'admin'`) — право `manage_cargo`: довідник веде й усю історію бачить адмін, СЕО, ОД
 *     (рішення Романа 12.10.2026). Решта, зокрема тім-лід, — лише свої розрахунки (теж рішення Романа 12.10).
 *  3. `created_by` — наш INTEGER `users.id`; імʼя для списку — з менеджера CRM / картки / акаунта (`NAME_SQL`).
 *  4. Явні колонки замість `SELECT *` (гейт #17e); Express 4 — обгортка `h()`, бо він сам не ловить помилки async.
 *  5. Нове: `GET /three.js` — three.js r128 з НАШОГО сервера, лише при відкритті 3D (рішення Романа 12.10: варіант А —
 *     сайт не важчає, на сторонні сервери не ходимо). Окремий npm-пакет не ставимо: ланцюг викату зупиняється на зміні
 *     package-lock, а правило «один JS-чанк» (#225) забороняє динамічний імпорт.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasTab, roleHasPerm } from "../auth/rbac.js";
import { NAME_SQL } from "../surveys/surveyRules.js";
import { DEFAULT_PALLETS, DEFAULT_VEHICLES, type PalletRow, type Vehicle } from "../cargo/cargoDefaults.js";
import { checkCalcState, checkLayout, checkPalletRows, checkVehicles, summarize, type CalcState, type HistoryEntry, type HistoryRow } from "../cargo/cargoState.js";
import type { PoolClient } from "pg";

/** Право «адміна» конфігуратора — одне місце. */
export const CARGO_ADMIN_PERM = "manage_cargo";

export const cargoRouter = Router();
cargoRouter.use(requireAuth);
cargoRouter.use((req, res, next) => {
  if (!req.auth || !roleHasTab(req.auth.roleKey, "rates")) return res.status(403).json({ error: "Калькулятор ставок та вантажу недоступний для вашої ролі" });
  next();
});
cargoRouter.use(express.json({ limit: "1mb" }));

const isAdmin = (req: Request) => roleHasPerm(req.auth!.roleKey, CARGO_ADMIN_PERM);
const me = (req: Request) => req.auth!.userId;

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
    console.error("[cargo]", e);
    if (!res.headersSent) res.status(500).json({ error: "Помилка сервера. Спробуйте ще раз." });
  }
};
function adminOnly(req: Request): void { if (!isAdmin(req)) throw new HttpError(403, "Лише для адміністраторів."); }

const VEHICLE_COLS = "id, grp, name, bodies, kg, kg_max, load_sides, arch, src, note";
const PALLET_COLS = "key, name, l, w";
const HISTORY_COLS = "id, created_by, created_by_name, created_at, vehicle, items, fit";

/* eslint-disable @typescript-eslint/no-explicit-any */
const vehicleOf = (r: any): Vehicle => ({ id: r.id, grp: r.grp, name: r.name, bodies: r.bodies, kg: r.kg, kgMax: r.kg_max, load: r.load_sides, arch: r.arch, src: r.src, q: r.note });
const palletOf = (r: any): PalletRow => ({ key: r.key, name: r.name, l: r.l, w: r.w });
const rowOf = (r: any): HistoryRow => ({ id: String(r.id), userId: String(r.created_by), userName: r.created_by_name, createdAt: new Date(r.created_at).toISOString(), vehicle: r.vehicle, items: r.items, fit: r.fit });

async function readReference(db: { query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }> } = pool) {
  const v = await db.query(`SELECT ${VEHICLE_COLS} FROM cargo_vehicles ORDER BY sort, id`);
  const p = await db.query(`SELECT ${PALLET_COLS} FROM cargo_pallets ORDER BY sort, key`);
  return { vehicles: v.rows.map(vehicleOf), pallets: p.rows.map(palletOf) };
}
async function writeVehicles(db: PoolClient, list: Vehicle[], by: number) {
  await db.query("DELETE FROM cargo_vehicles");
  let i = 0;
  for (const v of list) {
    await db.query(`INSERT INTO cargo_vehicles (id, grp, name, bodies, kg, kg_max, load_sides, arch, src, note, sort, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [v.id, v.grp.trim(), v.name.trim(), JSON.stringify(v.bodies), v.kg, v.kgMax ?? null, v.load, v.arch ? JSON.stringify(v.arch) : null, v.src, v.q ?? null, ++i, by]);
  }
}
async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { c.release(); }
}

/* ── three.js r128 з нашого сервера (лише при відкритті 3D) ── */
export const THREE_FILE = path.join(import.meta.dirname, "..", "..", "vendor", "three-r128.min.js");
let threeCache: Buffer | null = null;
cargoRouter.get("/three.js", h((_req, res) => {
  threeCache ??= readFileSync(THREE_FILE);
  res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "private, max-age=86400" }).send(threeCache);
}));

/* ── Довідник: читають усі, змінює адмін ── */
cargoRouter.get("/reference", h(async (_req, res) => { res.json(await readReference()); }));

cargoRouter.put("/reference/vehicles", h(async (req, res) => {
  adminOnly(req);
  const list = req.body && req.body.vehicles;
  const err = checkVehicles(list); if (err) throw new HttpError(400, err);
  await tx((c) => writeVehicles(c, list as Vehicle[], me(req)));
  res.json({ vehicles: (await readReference()).vehicles });
}));

cargoRouter.put("/reference/pallets", h(async (req, res) => {
  adminOnly(req);
  const list = req.body && req.body.pallets;
  const keys = (await pool.query<{ key: string }>("SELECT key FROM cargo_pallets")).rows.map((x) => x.key);
  const err = checkPalletRows(list, keys); if (err) throw new HttpError(400, err);
  await tx(async (c) => {
    for (const p of list as PalletRow[]) await c.query("UPDATE cargo_pallets SET name = $2, l = $3, w = $4, updated_at = now(), updated_by = $5 WHERE key = $1", [p.key, p.name.trim(), p.l, p.w, me(req)]);
  });
  res.json({ pallets: (await readReference()).pallets });
}));

// «Повернути стандарт»: авто й палети — як у cargo/cargoDefaults.ts
cargoRouter.post("/reference/reset", h(async (req, res) => {
  adminOnly(req);
  await tx(async (c) => {
    await writeVehicles(c, DEFAULT_VEHICLES, me(req));
    let i = 0;
    for (const p of DEFAULT_PALLETS) {
      await c.query(`INSERT INTO cargo_pallets (key, name, l, w, sort, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, l = EXCLUDED.l, w = EXCLUDED.w, sort = EXCLUDED.sort, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [p.key, p.name, p.l, p.w, ++i, me(req)]);
    }
  });
  res.json(await readReference());
}));

/* ── Історія: адмін (право manage_cargo) — уся, решта — лише своя ── */
cargoRouter.get("/history", h(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "12"), 10) || 12));
  const all = isAdmin(req);
  const q = all
    ? await pool.query(`SELECT ${HISTORY_COLS} FROM cargo_calculations ORDER BY created_at DESC, id DESC LIMIT $1`, [limit])
    : await pool.query(`SELECT ${HISTORY_COLS} FROM cargo_calculations WHERE created_by = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [me(req), limit]);
  res.json({ rows: q.rows.map(rowOf), scope: all ? "all" : "own" });
}));

cargoRouter.get("/history/:id", h(async (req, res) => {
  const id = String(req.params.id);
  const q = /^\d{1,18}$/.test(id) ? await pool.query(`SELECT ${HISTORY_COLS}, state, layout FROM cargo_calculations WHERE id = $1`, [id]) : { rows: [] as any[] };
  const row = q.rows[0];
  // чужий → 404, а не 403: id не підтверджує існування чужого розрахунку
  if (!row || (!isAdmin(req) && Number(row.created_by) !== me(req))) throw new HttpError(404, "Розрахунок не знайдено.");
  const out: HistoryEntry = { ...rowOf(row), state: row.state, layout: row.layout };
  res.json(out);
}));

cargoRouter.post("/history", h(async (req, res) => {
  const b = req.body || {};
  const err = checkCalcState(b.state) || checkLayout(b.layout) || (b.fit === null || typeof b.fit === "boolean" ? null : "fit: так / ні / null");
  if (err) throw new HttpError(400, err);
  const state = b.state as CalcState;
  const v = await pool.query<{ name: string }>("SELECT name FROM cargo_vehicles WHERE id = $1", [state.veh]);
  const sm = summarize(state, v.rows[0] ? v.rows[0].name : null);
  const name = (await pool.query<{ name: string }>(`SELECT n.name FROM (${NAME_SQL}) n WHERE n.id = $1`, [me(req)])).rows[0]?.name ?? "";
  const ins = await pool.query(`INSERT INTO cargo_calculations (created_by, created_by_name, vehicle, items, fit, state, layout)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${HISTORY_COLS}`,
    [me(req), name, sm.vehicle.slice(0, 200), sm.items.slice(0, 500), b.fit, JSON.stringify(state), b.layout ? JSON.stringify(b.layout) : null]);
  res.status(201).json(rowOf(ins.rows[0]));
}));

// зламаний JSON / завеликий запит (express.json) — українською, як у пакеті
cargoRouter.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err && err.type === "entity.parse.failed") return void res.status(400).json({ error: "Некоректний JSON." });
  if (err && err.type === "entity.too.large") return void res.status(413).json({ error: "Завеликий розрахунок." });
  next(err);
});
