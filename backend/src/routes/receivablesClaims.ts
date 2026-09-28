import { Router, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { roleHasTab, roleHasPerm } from "../auth/rbac.js";
import * as metrics from "../core/metrics.js";
import { BaError, type Db, openClaimsByClient, claimFromReceivables } from "../core/baClaims.js";

function fail(res: Response, e: unknown) {
  if (e instanceof BaError) return res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
  console.error("[receivables-claims]", e);
  return res.status(500).json({ error: "Помилка сервера" });
}
async function tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client as unknown as Db);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 🧾 КНОПКА «ПРОБЛЕМНИЙ КЛІЄНТ» У ДЕБІТОРЦІ (Бізнес-асистент, задача 4314) — окремий роутер під
 * вкладкою `receivables`. Окремий ФАЙЛ, бо реєстр роутів (`auth/routeScan.ts`) читає один роутер на файл.
 * Фінансист розділу не бачить, а кнопку натискати мусить (рішення Романа 24.09.2026), тож межа
 * тут — право `create_claim`, а не вкладка `ba`. Бухгалтерія права не має (лише перегляд).
 */
export const receivablesClaimRouter = Router();
receivablesClaimRouter.use(requireAuth);

/** Що показати в колонці «Дії»: чи можна створювати, чи можна відкрити розділ, і де претензія вже є. */
receivablesClaimRouter.get("/open", async (req, res) => {
  try {
    const canCreate = roleHasPerm(req.auth!.roleKey, "create_claim");
    const canOpen = roleHasTab(req.auth!.roleKey, "ba");
    // Хто не може ні створити, ні відкрити, списку не отримує: факт претензії — не для всіх.
    const open = canCreate || canOpen ? await openClaimsByClient(pool as unknown as Db) : [];
    res.json({ canCreate, canOpen, open });
  } catch (e) { fail(res, e); }
});

receivablesClaimRouter.post("/", requirePerm("create_claim"), async (req, res) => {
  try {
    const clientKey = typeof req.body?.clientKey === "string" ? req.body.clientKey.trim() : "";
    if (!clientKey) throw new BaError(400, "clientKey обовʼязковий");
    // Сума й дні — з ЯДРА дебіторки на весь бізнес (скоуп вирішує, кому показувати, а не що рахувати).
    const rows = await metrics.receivablesByClient({ managerId: null, teamId: null });
    const out = await tx((db) => claimFromReceivables(db, req.auth!.userId, clientKey, rows));
    // Слід дії — у історії самої претензії (`ba_events`, з автором): журнал доступів
    // (`access_audit`) про ролі й людей, і його CHECK типу цілі клієнта не знає.
    res.status(out.created ? 201 : 200).json({ id: out.id, created: out.created });
  } catch (e) { fail(res, e); }
});
