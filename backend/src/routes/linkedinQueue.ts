/**
 * 🔗 «Налаштування → Черга LinkedIn» (задача 7361). Межа — право `manage_linkedin_queue` (Юля й адмін) першим
 * middleware кожного роута. У Kommo нічого не пише: список, відповідальна й журнал — лише в дашборді.
 */
import { Router, type Response } from "express";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { loadQueueScreen, saveQueueDispatcher, saveQueueMembers } from "../core/linkedinQueueScreen.js";

export const linkedinQueueRouter = Router();
linkedinQueueRouter.use(requireAuth);

function fail(res: Response, e: unknown) {
  const status = (e as { status?: number })?.status;
  if (!status) console.error("linkedin-queue:", e);
  res.status(status ?? 500).json({ error: (e as Error)?.message ?? "Помилка" });
}

linkedinQueueRouter.get("/", requirePerm("manage_linkedin_queue"), async (_req, res) => {
  try { res.json(await loadQueueScreen(pool, config.linkedinQueue.mode)); } catch (e) { fail(res, e); }
});

linkedinQueueRouter.put("/members", requirePerm("manage_linkedin_queue"), async (req, res) => {
  const c = await pool.connect();
  try { await saveQueueMembers(c, (req.body as { managerIds?: unknown })?.managerIds, req.auth!.userId); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
  finally { c.release(); }
});

linkedinQueueRouter.put("/settings", requirePerm("manage_linkedin_queue"), async (req, res) => {
  try { await saveQueueDispatcher(pool, (req.body as { dispatcherUserId?: unknown })?.dispatcherUserId, req.auth!.userId); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});
