/**
 * 📅 «Календар оплат» («Фінанси», задача Тетяни #6369, 27.10.2026): нагадування про періодичні витрати. Окремий роутер,
 * бо межа інша, ніж у решти «Фінансів»: бачать і ведуть лише Тетяна й адмін — `view_private_finance` (як «Оплати
 * перевізникам» і Сейф), і це ПЕРШИЙ middleware кожного роута. Логіка — `core/finRecurring.ts`; тут лише проводка.
 * Нічого не пише в Kommo / 1С і не чіпає План/факт.
 */
import { Router, type Response } from "express";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import { FinError, type Db } from "../core/finance.js";
import {
  kyivToday, loadCalendar, loadItems, remindersFor, createRecurring, updateRecurring, payRecurring, undoPaid, loadPaid, historyXlsx, LEAD_DAYS,
} from "../core/finRecurring.js";

export const financeCalendarRouter = Router();
financeCalendarRouter.use(requireAuth);

function fail(res: Response, e: unknown) {
  if (e instanceof FinError) return res.status(e.status).json({ error: e.message });
  console.error("[finance/calendar]", e);
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
const idOf = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new FinError(400, "Некоректний id");
  return n;
};

financeCalendarRouter.get("/", requirePerm("view_private_finance"), async (_req, res) => {
  try {
    const c = await loadCalendar(pool as unknown as Db, kyivToday());
    res.json({ today: c.today, leadDays: c.leadDays, items: c.items, months: c.months, history: c.history, payers: c.payers });
  } catch (e) { fail(res, e); }
});
// 🔔 Нагадування МЕНІ (значок біля «Фінансів» і повідомлення раз на день): лише оплати, де я — той, хто платить.
financeCalendarRouter.get("/due", requirePerm("view_private_finance"), async (req, res) => {
  try {
    const today = kyivToday();
    res.json({ today, leadDays: LEAD_DAYS, items: remindersFor(await loadItems(pool as unknown as Db), req.auth!.userId, today) });
  } catch (e) { fail(res, e); }
});
financeCalendarRouter.get("/history.xlsx", requirePerm("view_private_finance"), async (_req, res) => {
  try {
    const buf = historyXlsx(await loadPaid(pool as unknown as Db));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="istoriya_oplat_${kyivToday()}.xlsx"`);
    res.send(buf);
  } catch (e) { fail(res, e); }
});
financeCalendarRouter.post("/", requirePerm("view_private_finance"), async (req, res) => {
  try { res.status(201).json({ id: await tx((db) => createRecurring(db, req.auth!.userId, req.body)) }); } catch (e) { fail(res, e); }
});
financeCalendarRouter.patch("/:id", requirePerm("view_private_finance"), async (req, res) => {
  try { const id = idOf(req.params.id); await tx((db) => updateRecurring(db, req.auth!.userId, id, req.body)); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
financeCalendarRouter.post("/:id/pay", requirePerm("view_private_finance"), async (req, res) => {
  try { const id = idOf(req.params.id); res.json(await tx((db) => payRecurring(db, req.auth!.userId, id, req.body))); } catch (e) { fail(res, e); }
});
financeCalendarRouter.post("/paid/:id/undo", requirePerm("view_private_finance"), async (req, res) => {
  try { const id = idOf(req.params.id); res.json(await tx((db) => undoPaid(db, req.auth!.userId, id))); } catch (e) { fail(res, e); }
});
