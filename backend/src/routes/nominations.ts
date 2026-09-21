import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { isAdminScope } from "../auth/rbac.js";
import { nominationWeek, frozenWeek, draftWeek, cellFingerprint, type WeekView } from "../core/nominations.js";
import { lastWeek, weekOf, canReview, validateReview, NOMINATIONS, MARGIN_FLAG_PCT } from "../core/nominationRules.js";

/**
 * 🏆 НОМІНАЦІЇ ТИЖНЯ (21.09.2026). Дві межі, як у найму:
 *  1. tab-гейт `pre("/api/nominations")` у `requireAuth` — роль мусить мати вкладку `nominations`;
 *  2. у кожному обробнику — скоуп: керівництво (admin-рівень) бачить і править усі команди, тімлід —
 *     лише свою і не рядок про себе (`canReview`), решта — 403. Друга межа існує тому, що першу
 *     адмін може відкрити будь-якій ролі тумблером.
 * Числа — лише з ядра (`core/nominations.ts`), SQL тут — тільки запис рішення тімліда.
 */
export const nominationsRouter = Router();
nominationsRouter.use(requireAuth);

type Viewer = { role: "admin" | "team_lead"; teamId: number | null; managerId: number | null };
function viewerOf(req: Request): Viewer | null {
  const a = req.auth!;
  if (isAdminScope(a)) return { role: "admin", teamId: null, managerId: a.managerId ?? null };
  if (a.role === "team_lead" && a.teamId != null && a.teamId > 0) return { role: "team_lead", teamId: a.teamId, managerId: a.managerId ?? null };
  return null;
}

/** Відповідь екрану: тиждень + для кожного рядка, чи може ЦЕЙ глядач його підтвердити. */
function withRights(view: WeekView, v: Viewer) {
  return {
    ...view,
    viewer: { role: v.role, teamId: v.teamId },
    // Підписи й одиниці — з одного місця (`NOMINATIONS`), щоб на фронті не жила друга копія.
    defs: NOMINATIONS, marginFlagPct: MARGIN_FLAG_PCT,
    teams: view.teams.map((t) => ({
      ...t,
      cells: t.cells.map((c) => {
        const r = view.state === "frozen" ? { ok: false as const, why: "тиждень зафіксовано" }
          : canReview(v, { teamId: t.teamId, crmWinners: c.crm.state === "ok" ? c.crm.winners : [] });
        return { ...c, canReview: r.ok, whyNot: r.ok ? null : r.why };
      }),
    })),
  };
}

/** Express 4 не ловить кинуті проміси async-обробників — без цього запит висів би до 503 таймауту. */
const safe = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((e: unknown) => {
    console.error("nominations:", e);
    if (!res.headersSent) res.status(500).json({ error: "Не вдалося порахувати номінації — спробуйте ще раз" });
  });
};

nominationsRouter.get("/week", safe(async (req: Request, res: Response) => {
  const v = viewerOf(req);
  if (!v) return res.status(403).json({ error: "Номінації тижня — для тімлідів і керівництва" });
  const q = typeof req.query.weekFrom === "string" ? req.query.weekFrom : "";
  const weekFrom = /^\d{4}-\d{2}-\d{2}$/.test(q) ? weekOf(q).from : lastWeek(new Date()).from;
  res.json(withRights(await nominationWeek(weekFrom, v.teamId), v));
}));

nominationsRouter.post("/review", safe(async (req: Request, res: Response) => {
  const v = viewerOf(req);
  if (!v) return res.status(403).json({ error: "Номінації тижня — для тімлідів і керівництва" });
  const parsed = validateReview(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const b = parsed.value;
  if (await frozenWeek(b.weekFrom)) return res.status(409).json({ error: "Тиждень уже зафіксовано — змінити неможливо" });
  const draft = await draftWeek(b.weekFrom);
  const team = draft.teams.find((t) => t.teamId === b.teamId);
  if (!team) return res.status(404).json({ error: "Команди немає в заліку" });
  const cell = team.cells.find((c) => c.nomination === b.nomination)!;
  const right = canReview(v, { teamId: b.teamId, crmWinners: cell.crm.state === "ok" ? cell.crm.winners : [], overrideManagerIds: b.overrideManagerIds });
  if (!right.ok) return res.status(403).json({ error: right.why });
  if (b.overrideManagerIds && !b.overrideManagerIds.every((id) => team.members.some((m) => m.id === id))) {
    return res.status(400).json({ error: "переможець мусить бути менеджером цієї команди в заліку" });
  }
  // Відбиток CRM пише СЕРВЕР, з власного розрахунку в цю мить, а не з тіла запиту.
  await pool.query(
    `INSERT INTO nomination_reviews (week_from, team_id, nomination, action, crm_fingerprint, override_manager_ids, override_value, reason, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [b.weekFrom, b.teamId, b.nomination, b.action, cellFingerprint(cell), b.overrideManagerIds, b.overrideValue, b.reason, req.auth!.userId]);
  res.json(withRights(await draftWeek(b.weekFrom, v.teamId), v));
}));
