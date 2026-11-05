/**
 * 💰 «Зарплата» і 🔔 центр сповіщень — маршрути за контрактом пакета (api/openapi.yaml, 49 операцій) + довідники для
 * налаштувань (люди, відділи, команди). Межа: вкладка `payroll` (ROUTE_TAB) + права-ключі ТЗ §2 у кожному обробнику;
 * «self» — лише id із сесії, ніколи не з параметра. Логіка — `payroll/service.ts`, суми — рушій пакета.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasPerm } from "../auth/rbac.js";
import * as P from "../payroll/service.js";
import { CardKeyMissing } from "../payroll/cards.js";

export const PAYROLL_PERMS = ["payroll_view_all", "payroll_edit", "payroll_settings", "payroll_final_word", "payroll_export_cards", "payroll_clearance", "payroll_offer_tasks", "notify_rules"] as const;
const viewer = (req: Request): P.Viewer => {
  const a = req.auth!;
  return { userId: a.userId, roleKey: a.roleKey, perms: new Set(PAYROLL_PERMS.filter((k) => roleHasPerm(a.roleKey, k))) };
};
type H = (req: Request, res: Response, v: P.Viewer) => Promise<unknown>;
/** Обгортка: права → обробник → JSON; PayrollError — статус і текст для людини. */
export const h = (need: string[] | null, fn: H) => async (req: Request, res: Response) => {
  const v = viewer(req);
  if (need && !need.some((p) => v.perms.has(p))) return res.status(403).json({ error: "Немає права на цю дію.", message: "Немає права на цю дію." });
  try {
    const out = await fn(req, res, v);
    if (!res.headersSent) out === undefined ? res.status(204).end() : res.json(out);
  } catch (e) {
    if (e instanceof P.PayrollError) return res.status(e.status).json({ error: e.message, message: e.message, field: e.field });
    if (e instanceof CardKeyMissing) return res.status(503).json({ error: e.message, message: e.message });
    throw e;
  }
};
const VIEW = ["payroll_view_all"], EDIT = ["payroll_edit"];
const mk = (req: Request, key = "month") => P.checkMonth(req.params[key] ?? req.query[key]);
const intP = (x: unknown) => { const n = Number(x); if (!Number.isInteger(n) || n <= 0) throw new P.PayrollError(400, "Неправильний id."); return n; };
const body = (req: Request) => (req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {});
const sendXlsx = (res: Response, buf: Buffer, name: string) => {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(buf);
};

export const payrollRouter = Router();
payrollRouter.use(requireAuth);

// ---------------- кабінет «Моя зарплата» (self) ----------------
payrollRouter.get("/me", h(null, (_q, _r, v) => P.cabinet(pool, v)));
payrollRouter.get("/me/deals", h(null, async (req, _r, v) => P.myDeals(pool, v, req.query.month ? mk(req) : (await P.engine(pool)).zp.liveMonth)));
payrollRouter.get("/me/goal", h(null, (req, _r, v) => P.myGoal(pool, v, req.query as Record<string, unknown>)));
payrollRouter.post("/me/records/:month/agree", h(null, (req, _r, v) => P.agree(pool, v, mk(req))));
payrollRouter.post("/me/records/:month/dispute", h(null, (req, _r, v) => P.dispute(pool, v, mk(req), body(req).text)));
payrollRouter.post("/me/records/:month/payout-form", h(null, (req, _r, v) => P.submitForm(pool, v, mk(req), body(req))));
payrollRouter.post("/me/advances", h(null, async (req, res, v) => { const r = await P.requestAdvance(pool, v, body(req)); res.status(201); return r; }));
payrollRouter.post("/me/advance-remind", h(null, (_q, _r, v) => P.toggleAdvanceReminder(pool, v)));
payrollRouter.post("/me/advances/:id/cancel", h(null, (req, _r, v) => P.cancelAdvance(pool, v, intP(req.params.id))));
payrollRouter.get("/me/cards", h(null, (_q, _r, v) => P.myCards(pool, v)));
payrollRouter.post("/me/cards", h(null, async (req, res, v) => { const r = await P.addCard(pool, v, body(req)); res.status(201); return r; }));
payrollRouter.delete("/me/cards/:id", h(null, async (req, _r, v) => { await P.archiveCard(pool, v, intP(req.params.id)); return undefined; }));
payrollRouter.post("/me/level", h(null, (req, _r, v) => { if (body(req).level !== "profi") throw new P.PayrollError(422, "Можна обрати лише «Профі»."); return P.chooseProfi(pool, v); }));
payrollRouter.post("/me/clearance/shots", h(null, (req, _r, v) => P.sendShots(pool, v, body(req))));

// ---------------- перевірка, нарахування, відомість ----------------
payrollRouter.get("/months/:month/accruals", h(VIEW, (req) => P.accruals(pool, mk(req))));
payrollRouter.get("/months/:month/queue", h(VIEW, (req, _r, v) => P.queue(pool, v, mk(req))));
payrollRouter.get("/records/:month/:userId", h(VIEW, (req, _r, v) => P.recordView(pool, v, mk(req), intP(req.params.userId))));
payrollRouter.patch("/records/:month/:userId", h(EDIT, (req, _r, v) => P.verify(pool, v, mk(req), intP(req.params.userId), body(req))));
payrollRouter.post("/records/:month/:userId/extras", h(EDIT, async (req, res, v) => { const r = await P.addExtra(pool, v, mk(req), intP(req.params.userId), body(req)); res.status(201); return r; }));
payrollRouter.delete("/records/:month/:userId/extras/:id", h(EDIT, async (req, _r, v) => { await P.deleteExtra(pool, v, mk(req), intP(req.params.userId), intP(req.params.id)); return undefined; }));
payrollRouter.post("/records/:month/:userId/resolve", h(["payroll_final_word"], (req, _r, v) => P.resolveDispute(pool, v, mk(req), intP(req.params.userId), body(req))));
payrollRouter.get("/statement", h(VIEW, async (req) => P.statement(pool, req.query.month ? mk(req) : ((await P.engine(pool)).zp.closedMonth ?? (await P.engine(pool)).zp.liveMonth))));
payrollRouter.get("/statement/export", h(["payroll_export_cards"], async (req, res, v) => {
  const m = mk(req); const cols = String(req.query.columns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  sendXlsx(res, await P.statementXlsx(pool, v, m, cols), `Vidomist_ZP_${m}.xlsx`); return undefined;
}));
payrollRouter.post("/statement/mark-paid", h(EDIT, (req, _r, v) => {
  const b = body(req); const ids = Array.isArray(b.userIds) ? b.userIds.map(Number).filter(Number.isInteger) : [];
  return P.markPaid(pool, v, P.checkMonth(b.month), ids);
}));

// ---------------- аванси ----------------
payrollRouter.get("/advances", h(VIEW, async (req) => P.advancesView(pool, req.query.month ? mk(req) : (await P.engine(pool)).zp.liveMonth)));
payrollRouter.post("/advances/:id/pay", h(EDIT, (req, _r, v) => P.payAdvance(pool, v, intP(req.params.id))));
payrollRouter.post("/advances/:id/reject", h(EDIT, (req, _r, v) => P.rejectAdvance(pool, v, intP(req.params.id), body(req).reason)));
payrollRouter.get("/advances/export", h(["payroll_export_cards"], async (req, res, v) => { const m = mk(req); sendXlsx(res, await P.advancesXlsx(pool, v, m), `Avans_${m}.xlsx`); return undefined; }));

// ---------------- обхідний лист ----------------
payrollRouter.post("/employees/:userId/leave", h(EDIT, async (req, res, v) => { const r = await P.createLeave(pool, v, intP(req.params.userId), body(req)); res.status(201); return r; }));
payrollRouter.get("/clearances", h(null, (_q, _r, v) => P.clearancesList(pool, v)));
payrollRouter.get("/clearances/:userId", h(null, (req, _r, v) => P.clearanceView(pool, v, intP(req.params.userId))));
payrollRouter.put("/clearances/:userId/items/:key/draft", h(null, (req, _r, v) => P.draftClearance(pool, v, intP(req.params.userId), String(req.params.key), body(req).data ?? req.body)));
payrollRouter.post("/clearances/:userId/items/:key/sign", h(null, (req, _r, v) => P.signClearance(pool, v, intP(req.params.userId), String(req.params.key), body(req).data ?? req.body)));
payrollRouter.get("/clearances/:userId/pdf", h(null, async (req, res, v) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.send(await P.clearancePrintHtml(pool, v, intP(req.params.userId))); return undefined;
}));

// ---------------- прогноз, аналітика, архів ----------------
payrollRouter.get("/forecast", h(VIEW, async (req) => P.forecastView(pool, req.query.month ? mk(req) : (await P.engine(pool)).zp.liveMonth)));
payrollRouter.get("/analytics", h(VIEW, async (req) => P.analyticsView(pool, req.query.month ? mk(req) : (await P.engine(pool)).zp.liveMonth, req.query.plan !== "false")));
payrollRouter.get("/archive", h(VIEW, (req) => P.archiveView(pool, req.query.userId ? intP(req.query.userId) : null)));
payrollRouter.post("/archive/import", h(["payroll_settings"], (req, _r, v) => P.importArchive(pool, v, body(req).file)));

// ---------------- налаштування, люди ----------------
payrollRouter.get("/settings", h(VIEW, async (req) => P.settingsView(pool, req.query.month ? mk(req) : (await P.engine(pool)).zp.liveMonth)));
payrollRouter.post("/settings", h(["payroll_settings"], async (req, res, v) => { const r = await P.saveSettings(pool, v, body(req)); res.status(201); return r; }));
payrollRouter.get("/employees", h(VIEW, () => P.employeesView(pool)));
payrollRouter.post("/employees", h(EDIT, async (req, res, v) => { const r = await P.addEmployee(pool, v, body(req)); res.status(201); return r; }));
payrollRouter.patch("/employees/:userId", h(EDIT, (req, _r, v) => P.updateEmployee(pool, v, intP(req.params.userId), body(req))));
payrollRouter.post("/departments", h(["payroll_settings"], (req, _r, v) => P.saveDepartment(pool, v, body(req))));
payrollRouter.post("/teams", h(["payroll_settings"], (req, _r, v) => P.saveTeam(pool, v, body(req))));
payrollRouter.get("/history", h(VIEW, (req) => P.historyView(pool, req.query.userId ? intP(req.query.userId) : null)));
payrollRouter.get("/offer-tasks", h(["payroll_offer_tasks", "payroll_final_word"], () => P.offerTasks(pool)));
payrollRouter.post("/offer-tasks/:id/done", h(["payroll_offer_tasks", "payroll_final_word"], (req, _r, v) => P.offerTaskDone(pool, v, intP(req.params.id))));

