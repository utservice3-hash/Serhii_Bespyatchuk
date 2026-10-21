/**
 * 🧪 «План/факт · авто (тест)» (20.10.2026): факт із таблиці «UTS Утверждение оплат» поруч із ручним. Лише ЧИТАННЯ —
 * ні бази, ні таблиці не пише. З 21.10.2026 читає дзеркало `fin_approvals` (його веде `syncApprovals`), а не таблицю
 * наживо: тест і «План/факт» показують ті самі дані. Окремий роутер із межею `view_private_finance` (Адмін, фінансист)
 * ПЕРШИМ middleware: у рядках ЗП — прізвища. «Оновити з таблиці» — `POST /api/finance/approvals/sync`.
 */
import { Router, type Response } from "express";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import { approvalsCompare, approvalsState, loadApprovalLines } from "../core/paymentApprovals.js";
import { kyivDate, periodEnd } from "../core/financeKpi.js";
import type { Db } from "../core/finance.js";

export const financeApprovalsRouter = Router();
financeApprovalsRouter.use(requireAuth);
function fail(res: Response, e: unknown) {
  console.error("finance/approvals-test:", e);
  res.status(500).json({ error: (e as Error)?.message ?? "Помилка" });
}

financeApprovalsRouter.get("/", requirePerm("view_private_finance"), async (req, res) => {
  try {
    const q = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : kyivDate().slice(0, 7);
    const db = pool as unknown as Db, month = `${q}-01`;
    const st = await approvalsState(db);
    const lines = await loadApprovalLines(db, month, periodEnd("month", month));
    res.json({ ...(await approvalsCompare(db, month, lines, st.syncedAt ? new Date(st.syncedAt) : new Date(0))), syncedAt: st.syncedAt, syncError: st.error });
  } catch (e) { fail(res, e); }
});
