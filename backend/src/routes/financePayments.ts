/**
 * 💸 «Оплати перевізникам» («Фінанси», 16.10.2026): файл на оплату й усі запити з причинами. Окремий роутер, бо межа
 * інша, ніж у решти «Фінансів» (#1450b: там першим стоїть вкладка): тут номери карток і ПІБ отримувачів → лише
 * `view_private_finance` (Адмін, фінансист), як Сейф, і це перший middleware кожного роута. У Kommo нічого не пише.
 */
import { Router, type Response } from "express";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { loadScreenDay, screenXlsx, buildPaymentFile } from "../jobs/buildPaymentFile.js";

export const financePaymentsRouter = Router();
financePaymentsRouter.use(requireAuth);
function fail(res: Response, e: unknown) {
  console.error("finance/payments:", e);
  res.status(500).json({ error: (e as Error)?.message ?? "Помилка" });
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

