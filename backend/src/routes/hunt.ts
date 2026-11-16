import { Router, type Request, type Response, type NextFunction } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import type { Db } from "../core/secrets.js";
import {
  HuntError, huntAllowed, radar, contactActivity, revealPhones, addCandidate, listCandidates, candidateDetail,
  updateCandidate, changeStage, addComment, HUNT_STAGES, REJECT_REASONS,
} from "../core/hunt.js";

/**
 * 🎯 ХАНТИНГ (15.11.2026, ТЗ Івана) — правила в `core/hunt.ts`.
 *
 * Межа ПОІМЕННА (`hunt_access`), не роль і не вкладка: решта користувачів, зокрема адміни, отримують 403 (ТЗ п.2, рішення
 * Романа 15.11). Єдиний відкритий роут — `GET /access`: фронт питає, чи показувати пункт, і відповідь сама нічого не віддає.
 */
export const huntRouter = Router();
huntRouter.use(requireAuth);

const db = () => pool as unknown as Db;
const me = (req: Request) => req.auth!.userId;
const num = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new HuntError(400, "Некоректний id"); return n; };
function fail(res: Response, e: unknown) {
  if (e instanceof HuntError) return res.status(e.status).json({ error: e.message });
  const code = (e as { code?: string })?.code;
  if (code === "23505") return res.status(409).json({ error: "Цей контакт уже у воронці" });
  console.error("[hunt]", (e as Error)?.message ?? e);
  return res.status(500).json({ error: "Не вдалося обробити запит — спробуйте ще раз" });
}
async function tx<T>(fn: (d: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const out = await fn(client as unknown as Db); await client.query("COMMIT"); return out; }
  catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { client.release(); }
}

huntRouter.get("/access", async (req, res) => {
  try { res.json({ allowed: await huntAllowed(db(), me(req)) }); } catch (e) { fail(res, e); }
});

// Усе нижче — лише людям зі списку.
huntRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  try { if (!(await huntAllowed(db(), me(req)))) return res.status(403).json({ error: "«Хантинг» відкритий лише Івану, Сергію й Олександру" }); next(); }
  catch (e) { fail(res, e); }
});

huntRouter.get("/radar", async (req, res) => {
  try { const r = await radar(db(), req.query); res.json({ days: r.days, rows: r.rows, dataUntil: r.dataUntil, totals: r.totals, stages: HUNT_STAGES }); }
  catch (e) { fail(res, e); }
});
huntRouter.get("/contacts/activity", async (req, res) => {
  try { res.json(await contactActivity(db(), String(req.query.key ?? ""))); } catch (e) { fail(res, e); }
});
huntRouter.post("/contacts/phones", async (req, res) => {
  try { res.json(await revealPhones(db(), me(req), req.body?.key)); } catch (e) { fail(res, e); }
});
huntRouter.get("/candidates", async (req, res) => {
  try { res.json({ rows: await listCandidates(db(), req.query), stages: HUNT_STAGES, reasons: REJECT_REASONS }); } catch (e) { fail(res, e); }
});
huntRouter.post("/candidates", async (req, res) => {
  try { res.status(201).json(await tx((d) => addCandidate(d, me(req), req.body ?? {}))); } catch (e) { fail(res, e); }
});
huntRouter.get("/candidates/:id", async (req, res) => {
  try { res.json(await candidateDetail(db(), num(req.params.id))); } catch (e) { fail(res, e); }
});
huntRouter.patch("/candidates/:id", async (req, res) => {
  try { res.json(await updateCandidate(db(), num(req.params.id), req.body ?? {})); } catch (e) { fail(res, e); }
});
huntRouter.post("/candidates/:id/stage", async (req, res) => {
  try { res.json(await tx((d) => changeStage(d, me(req), num(req.params.id), req.body ?? {}))); } catch (e) { fail(res, e); }
});
huntRouter.post("/candidates/:id/comments", async (req, res) => {
  try { res.status(201).json(await addComment(db(), me(req), num(req.params.id), req.body ?? {})); } catch (e) { fail(res, e); }
});
