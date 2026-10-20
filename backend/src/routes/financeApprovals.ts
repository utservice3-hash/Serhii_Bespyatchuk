/**
 * 🧪 «План/факт · авто (тест)» (20.10.2026): факт із таблиці «UTS Утверждение оплат» поруч із ручним. Лише ЧИТАННЯ —
 * ні бази, ні таблиці не пише. Окремий роутер із межею `view_private_finance` (Адмін, фінансист) ПЕРШИМ middleware: у
 * рядках ЗП — прізвища. Таблицю читаємо наживо з кешем на 10 хв; «Оновити з таблиці» (`?refresh=1`) кеш скидає.
 */
import { Router, type Response } from "express";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { readSheetRange } from "../bankSources/googleSheets.js";
import { parseApprovalRows, approvalsCompare, type ApprovalLine } from "../core/paymentApprovals.js";
import { kyivDate } from "../core/financeKpi.js";
import type { Db } from "../core/finance.js";

export const financeApprovalsRouter = Router();
financeApprovalsRouter.use(requireAuth);
function fail(res: Response, e: unknown) {
  console.error("finance/approvals-test:", e);
  res.status(500).json({ error: (e as Error)?.message ?? "Помилка" });
}

const CACHE_MS = 10 * 60_000;
let cache: { at: Date; lines: ApprovalLine[] } | null = null;
let inflight: Promise<{ at: Date; lines: ApprovalLine[] }> | null = null;
async function sheetLines(refresh: boolean) {
  if (!refresh && cache && Date.now() - cache.at.getTime() < CACHE_MS) return cache;
  inflight ??= (async () => {
    try {
      const { spreadsheetId, tab } = config.approvalsSheet;
      const lines = parseApprovalRows(await readSheetRange(spreadsheetId, `'${tab}'!A1:R`));
      cache = { at: new Date(), lines };
      return cache;
    } finally { inflight = null; }
  })();
  return inflight;
}

financeApprovalsRouter.get("/", requirePerm("view_private_finance"), async (req, res) => {
  try {
    const q = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : kyivDate().slice(0, 7);
    const { at, lines } = await sheetLines(req.query.refresh === "1");
    res.json(await approvalsCompare(pool as unknown as Db, `${q}-01`, lines, at));
  } catch (e) { fail(res, e); }
});
