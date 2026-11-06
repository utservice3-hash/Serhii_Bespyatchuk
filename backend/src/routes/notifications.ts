/**
 * 🔔 Центр сповіщень дашборда (ТЗ «Зарплата» §6) — дзвіночок у шапці для кожного залогіненого; «лише свої»
 * (notification_recipients.user_id = id із сесії). Правила «подія → канали» — право `notify_rules` (ОД, адмін).
 */
import { Router, type Request } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { PayrollError } from "../payroll/service.js";
import { listFor, badgeFor, markRead, listRules, setRule } from "../payroll/notifyCenter.js";
import { h } from "./payroll.js";

const intP = (x: unknown) => { const n = Number(x); if (!Number.isInteger(n) || n <= 0) throw new PayrollError(400, "Неправильний id."); return n; };
const body = (req: Request) => (req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {});

// ---------------- 🔔 центр сповіщень (увесь дашборд; лише свої) ----------------
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.get("/", h(null, (req, _r, v) => {
  const f = req.query.filter === "act" || req.query.filter === "unread" ? req.query.filter : "all";
  return listFor(pool, v.userId, f, req.query.before ? intP(req.query.before) : null, Math.min(100, Math.max(1, Number(req.query.limit) || 30)));
}));
notificationsRouter.get("/badge", h(null, (_q, _r, v) => badgeFor(pool, v.userId)));
notificationsRouter.post("/read", h(null, async (req, _r, v) => {
  const b = body(req); await markRead(pool, v.userId, b.all === true ? null : (Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [])); return undefined;
}));
notificationsRouter.get("/rules", h(["notify_rules"], () => listRules(pool)));
notificationsRouter.put("/rules/:type", h(["notify_rules"], async (req) => {
  const b = body(req);
  if (!(await setRule(pool, String(req.params.type), Array.isArray(b.channels) ? b.channels.map(String) : undefined, typeof b.enabled === "boolean" ? b.enabled : undefined)))
    throw new PayrollError(404, "Такого типу сповіщень немає.");
  return { ok: true };
}));
