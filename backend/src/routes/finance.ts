import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasTab, roleHasPerm } from "../auth/rbac.js";
import {
  FinError, type Db, loadMonth, itemCard, createResp, renameResp, deleteResp, createGroup, updateGroup, deleteGroup,
  createItem, updateItem, setItemOff, deleteItem, restore, saveValues, setNote, setApproval, setItemSections,
} from "../core/finance.js";
import {
  loadPeriod, kpiCard, saveKpiValues, setKpiNote, setPeriodClosed, createSection, renameSection, deleteSection,
  createKpi, updateKpi, setKpiOff, deleteKpi, restoreKpiThing, autoActive, opexMonth, receivablesFxAt, bankTotals,
} from "../core/financeKpi.js";
import { fmRefsFor } from "../core/financeKpiRefs.js";

/**
 * 💰 ФІНАНСИ, прохід 1 (29.09.2026): «План/факт витрат» і «Статті».
 *
 * Дві межі, як у Бізнес-асистента:
 *  1. tab-гейт `pre("/api/finance")` у `requireAuth` — роль мусить мати вкладку `finance`;
 *  2. ПЕРШИМ оператором кожного обробника — `onlyFinance` (читання) або `canEdit` / `canApprove`
 *     (запис). Друга межа існує, бо перша стоїть у спільній мапі роутів, і правка префікса відкрила б
 *     розділ мовчки. Запис гейтить ПРАВО, а не вкладку: `edit_finance`, погодження — `approve_finance_plan`.
 * Склад ролей — сид у кінці `schema.sql`; звіряє `#933` + матриця `#11`.
 */
export const financeRouter = Router();
financeRouter.use(requireAuth);

function onlyFinance(req: Request): void {
  if (!req.auth || !roleHasTab(req.auth.roleKey, "finance")) throw new FinError(403, "Розділ «Фінанси» недоступний для вашої ролі");
}
function canEdit(req: Request): void {
  onlyFinance(req);
  if (!roleHasPerm(req.auth!.roleKey, "edit_finance")) throw new FinError(403, "Вносити зміни у «Фінанси» ваша роль не може");
}
function canApprove(req: Request): void {
  onlyFinance(req);
  if (!roleHasPerm(req.auth!.roleKey, "approve_finance_plan")) throw new FinError(403, "Погоджувати план ваша роль не може");
}
function fail(res: Response, e: unknown) {
  if (e instanceof FinError) return res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
  console.error("[finance]", e);
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
const idOf = (req: Request): number => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new FinError(400, "Некоректний id");
  return n;
};
const confirmed = (req: Request) => req.query.confirm === "1";

// ── Читання ──────────────────────────────────────────────────────────────────
financeRouter.get("/month", async (req, res) => {
  try {
    onlyFinance(req);
    const m = await loadMonth(pool as unknown as Db, req.query.m);
    // Поля — явним переліком (#17e2): нове поле ядра не поїде назовні саме.
    res.json({
      month: m.month, currentMonth: m.currentMonth, tree: m.tree, totals: m.totals, approval: m.approval, imported: m.imported,
      canEdit: roleHasPerm(req.auth!.roleKey, "edit_finance"), canApprove: roleHasPerm(req.auth!.roleKey, "approve_finance_plan"),
    });
  } catch (e) { fail(res, e); }
});
financeRouter.get("/items/:id", async (req, res) => {
  try { onlyFinance(req); res.json(await itemCard(pool as unknown as Db, idOf(req), req.query.year)); } catch (e) { fail(res, e); }
});

// ── Структура ────────────────────────────────────────────────────────────────
financeRouter.post("/resps", async (req, res) => {
  try { canEdit(req); res.status(201).json({ id: await tx((db) => createResp(db, req.auth!.userId, req.body)) }); } catch (e) { fail(res, e); }
});
financeRouter.patch("/resps/:id", async (req, res) => {
  try { canEdit(req); const id = idOf(req); await tx((db) => renameResp(db, req.auth!.userId, id, req.body)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
financeRouter.delete("/resps/:id", async (req, res) => {
  try { canEdit(req); const id = idOf(req); await tx((db) => deleteResp(db, req.auth!.userId, id)); res.json({ ok: true, undo: { kind: "resp", id } }); } catch (e) { fail(res, e); }
});
financeRouter.post("/groups", async (req, res) => {
  try { canEdit(req); res.status(201).json({ id: await tx((db) => createGroup(db, req.auth!.userId, req.body)) }); } catch (e) { fail(res, e); }
});
financeRouter.patch("/groups/:id", async (req, res) => {
  try { canEdit(req); const id = idOf(req); await tx((db) => updateGroup(db, req.auth!.userId, id, req.body)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
financeRouter.delete("/groups/:id", async (req, res) => {
  try {
    canEdit(req);
    const id = idOf(req);
    await tx((db) => deleteGroup(db, req.auth!.userId, id, confirmed(req)));
    res.json({ ok: true, undo: { kind: "group", id } });
  } catch (e) { fail(res, e); }
});
financeRouter.post("/items", async (req, res) => {
  try { canEdit(req); res.status(201).json({ id: await tx((db) => createItem(db, req.auth!.userId, req.body)) }); } catch (e) { fail(res, e); }
});
financeRouter.patch("/items/:id", async (req, res) => {
  try { canEdit(req); const id = idOf(req); await tx((db) => updateItem(db, req.auth!.userId, id, req.body)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
financeRouter.put("/item-sections", async (req, res) => {
  try { canEdit(req); res.json(await tx((db) => setItemSections(db, req.auth!.userId, req.body?.items))); } catch (e) { fail(res, e); }
});
financeRouter.post("/items/:id/off", async (req, res) => {
  try {
    canEdit(req);
    const id = idOf(req);
    res.json(await tx((db) => setItemOff(db, req.auth!.userId, id, req.body?.off !== false)));
  } catch (e) { fail(res, e); }
});
financeRouter.delete("/items/:id", async (req, res) => {
  try {
    canEdit(req);
    const id = idOf(req);
    await tx((db) => deleteItem(db, req.auth!.userId, id, confirmed(req)));
    res.json({ ok: true, undo: { kind: "item", id } });
  } catch (e) { fail(res, e); }
});
financeRouter.post("/restore", async (req, res) => {
  try {
    canEdit(req);
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) throw new FinError(400, "Некоректний id");
    await tx((db) => restore(db, req.auth!.userId, req.body?.kind, id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Цифри, коментарі, погодження ─────────────────────────────────────────────
financeRouter.put("/values", async (req, res) => {
  try { canEdit(req); res.json(await tx((db) => saveValues(db, req.auth!.userId, req.body?.month, req.body?.cells))); } catch (e) { fail(res, e); }
});
financeRouter.put("/notes", async (req, res) => {
  try {
    canEdit(req);
    const itemId = Number(req.body?.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new FinError(400, "Некоректна стаття");
    await tx((db) => setNote(db, req.auth!.userId, itemId, req.body?.month, req.body?.text));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
financeRouter.post("/approval", async (req, res) => {
  try {
    canApprove(req);
    const approved = req.body?.approved !== false;
    await tx((db) => setApproval(db, req.auth!.userId, req.body?.month, approved));
    res.json({ ok: true, approved });
  } catch (e) { fail(res, e); }
});

// ── Тиждень і місяць (прохід 2а) ─────────────────────────────────────────────
/** Числа ядра для автоматичних рядків періоду (`core/financeKpiRefs.ts`): роут лише кличе (#17c). */
const refsFor = (kind: unknown, p: unknown) => fmRefsFor(kind, p);
financeRouter.get("/kpi", async (req, res) => {
  try {
    onlyFinance(req);
    const refs = await refsFor(req.query.kind, req.query.p);
    const p = await loadPeriod(pool as unknown as Db, req.query.kind, req.query.p, refs);
    // Друге число до предиката (правило 4): статті без розділу з фактом місяця і деталі валютної дебіторки.
    const opex = p.kind === "month" && autoActive(p.kind, p.start) ? (await opexMonth(pool as unknown as Db, p.start)).unassigned : null;
    const fx = autoActive(p.kind, p.start) ? await receivablesFxAt(pool as unknown as Db, p.end, new Date()) : null;
    // «з них перекази між своїми рахунками» — друге число біля «Надходження / Витрати загальні» (питання відкрите).
    const bank = autoActive(p.kind, p.start) ? await bankTotals(pool as unknown as Db, p.start, p.end) : null;
    res.json({
      opexUnassigned: opex, receivablesFx: fx, bankOwn: bank ? { in: bank.ownIn, out: bank.ownOut } : null,
      kind: p.kind, start: p.start, end: p.end, prev: p.prev, label: p.label, prevLabel: p.prevLabel, current: p.current,
      sections: p.sections, closed: p.closed, importedInterim: p.importedInterim, canEdit: roleHasPerm(req.auth!.roleKey, "edit_finance"),
    });
  } catch (e) { fail(res, e); }
});
financeRouter.get("/kpi/items/:id", async (req, res) => {
  try { onlyFinance(req); res.json(await kpiCard(pool as unknown as Db, idOf(req), req.query.kind)); } catch (e) { fail(res, e); }
});
financeRouter.put("/kpi/values", async (req, res) => {
  try {
    canEdit(req);
    const refs = await refsFor(req.body?.kind, req.body?.p);
    res.json(await tx((db) => saveKpiValues(db, req.auth!.userId, req.body?.kind, req.body?.p, req.body?.cells, refs)));
  } catch (e) { fail(res, e); }
});
financeRouter.put("/kpi/notes", async (req, res) => {
  try {
    canEdit(req);
    const kpiId = Number(req.body?.kpiId);
    if (!Number.isInteger(kpiId) || kpiId <= 0) throw new FinError(400, "Некоректний показник");
    await tx((db) => setKpiNote(db, req.auth!.userId, kpiId, req.body?.kind, req.body?.p, req.body?.text));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
financeRouter.post("/kpi/close", async (req, res) => {
  try {
    canEdit(req);
    const closed = req.body?.closed !== false;
    // Закриття фіксує авто-рядки числом на цей момент — тому довідка рахується тут, ядром (#17c).
    const refs = closed ? await refsFor(req.body?.kind, req.body?.p) : {};
    await tx((db) => setPeriodClosed(db, req.auth!.userId, req.body?.kind, req.body?.p, closed, refs));
    res.json({ ok: true, closed });
  } catch (e) { fail(res, e); }
});
financeRouter.post("/kpi/sections", async (req, res) => {
  try { canEdit(req); res.status(201).json({ id: await tx((db) => createSection(db, req.auth!.userId, req.body)) }); } catch (e) { fail(res, e); }
});
financeRouter.patch("/kpi/sections/:id", async (req, res) => {
  try { canEdit(req); const id = idOf(req); await tx((db) => renameSection(db, req.auth!.userId, id, req.body)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
financeRouter.delete("/kpi/sections/:id", async (req, res) => {
  try { canEdit(req); const id = idOf(req); await tx((db) => deleteSection(db, req.auth!.userId, id)); res.json({ ok: true, undo: { kind: "section", id } }); } catch (e) { fail(res, e); }
});
financeRouter.post("/kpi/items", async (req, res) => {
  try { canEdit(req); res.status(201).json({ id: await tx((db) => createKpi(db, req.auth!.userId, req.body)) }); } catch (e) { fail(res, e); }
});
financeRouter.patch("/kpi/items/:id", async (req, res) => {
  try { canEdit(req); const id = idOf(req); await tx((db) => updateKpi(db, req.auth!.userId, id, req.body)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
financeRouter.post("/kpi/items/:id/off", async (req, res) => {
  try { canEdit(req); const id = idOf(req); res.json(await tx((db) => setKpiOff(db, req.auth!.userId, id, req.body?.off !== false))); } catch (e) { fail(res, e); }
});
financeRouter.delete("/kpi/items/:id", async (req, res) => {
  try {
    canEdit(req);
    const id = idOf(req);
    await tx((db) => deleteKpi(db, req.auth!.userId, id, confirmed(req)));
    res.json({ ok: true, undo: { kind: "kpi", id } });
  } catch (e) { fail(res, e); }
});
financeRouter.post("/kpi/restore", async (req, res) => {
  try {
    canEdit(req);
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) throw new FinError(400, "Некоректний id");
    await tx((db) => restoreKpiThing(db, req.auth!.userId, req.body?.kind, id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
