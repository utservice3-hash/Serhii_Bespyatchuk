/**
 * 💸 «Оплати перевізникам» («Фінанси», 16.10.2026): файл на оплату й усі запити з причинами. Окремий роутер, бо межа
 * інша, ніж у решти «Фінансів» (#1450b: там першим стоїть вкладка): тут номери карток і ПІБ отримувачів → лише
 * `view_private_finance` (Адмін, фінансист), як Сейф, і це перший middleware кожного роута. У Kommo нічого не пише.
 */
import { Router, type Response } from "express";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { loadScreenDay, screenXlsx, buildPaymentFile, markContext, dropScreenCache } from "../jobs/buildPaymentFile.js";
import { pool } from "../db/pool.js";
import { setMark } from "../core/paymentMarks.js";
import type { Db } from "../core/finance.js";

export const financePaymentsRouter = Router();
financePaymentsRouter.use(requireAuth);
function fail(res: Response, e: unknown) {
  const status = (e as { status?: number })?.status;
  if (!status) console.error("finance/payments:", e);
  res.status(status ?? 500).json({ error: (e as Error)?.message ?? "Помилка" });
}

financePaymentsRouter.get("/", requirePerm("view_private_finance"), async (req, res) => {
  try { res.json(await loadScreenDay(typeof req.query.day === "string" ? req.query.day : undefined)); } catch (e) { fail(res, e); }
});
financePaymentsRouter.get("/export.xlsx", requirePerm("view_private_finance"), async (req, res) => {
  try {
    const d = await loadScreenDay(typeof req.query.day === "string" ? req.query.day : undefined);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="oplata_perevizny_${d.day}.xlsx"`);
    res.send(screenXlsx(d));
  } catch (e) { fail(res, e); }
});
// «Оновити зараз»: той самий прогін, що крон (з прапорцем «уже йде»); пише журнал дня — у Kommo нічого.
financePaymentsRouter.post("/run", requirePerm("view_private_finance"), async (_req, res) => {
  try { res.json({ ok: true, result: await buildPaymentFile() }); } catch (e) { fail(res, e); }
});

// ✋ «Погоджено» / «Скасувати» і коментар (Тетяна 26.10.2026; погоджують Тетяна й адмін — та сама межа, що в екрана).
// Рішення й сума — з журналу й живого Kommo в мить натискання; у Kommo нічого не пише.
financePaymentsRouter.post("/mark", requirePerm("view_private_finance"), async (req, res) => {
  try {
    const ctx = await markContext(Number(req.body?.requestId));
    const r = await setMark(pool as unknown as Db, req.auth!.userId, req.body, ctx);
    dropScreenCache();
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});
