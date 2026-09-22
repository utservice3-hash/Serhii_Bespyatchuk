import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { isAdminScope } from "../auth/rbac.js";
import { nominationWeek, frozenWeek, draftWeek, cellFingerprint, type WeekView } from "../core/nominations.js";
import { managerPhotos, employeePhotos } from "../core/people.js";
import { lastWeek, weekOf, canReview, validateReview, validateBulkConfirm, validateManualSlide, NOMINATIONS, MARGIN_FLAG_PCT, MANUAL_KINDS, SLIDE_TEMPLATES } from "../core/nominationRules.js";

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

/**
 * Відповідь екрану: тиждень + для кожного рядка, чи може ЦЕЙ глядач його підтвердити, + фото людей
 * тижня з реєстру «Співробітників» (менеджер → співробітник через `employees.manager_id`).
 */
async function withRights(view: WeekView, v: Viewer) {
  return {
    ...view,
    photos: await managerPhotos(),
    viewer: { role: v.role, teamId: v.teamId, managerId: v.managerId },
    // Підписи й одиниці — з одного місця (`NOMINATIONS`), щоб на фронті не жила друга копія.
    defs: NOMINATIONS, marginFlagPct: MARGIN_FLAG_PCT,
    teams: view.teams.map((t) => ({
      ...t,
      cells: t.cells.map((c) => {
        const r = view.state === "frozen" ? { ok: false as const, why: "тиждень зафіксовано" }
          : canReview(v, { teamId: t.teamId, crmWinners: c.crm.state === "ok" ? c.crm.winners : [], overrideManagerIds: c.final.status === "overridden" ? c.final.winners : null });
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
  res.json(await withRights(await nominationWeek(weekFrom, v.teamId), v));
}));

/**
 * Рішення по рядку: `confirm` («Погоджуюсь»), `override` («Свої дані»: переможець, число, звідки воно),
 * `retract` («Скасувати» — рядок знову чекає; історія лише дописується). З `nominations: [...]` замість
 * `nomination` — «Погодитись з рештою»: сервер сам бере лише ті рядки, де є пропозиція системи, рішення
 * ще немає й дозволено `canReview`, і пише їх ОДНІЄЮ транзакцією.
 */
nominationsRouter.post("/review", safe(async (req: Request, res: Response) => {
  const v = viewerOf(req);
  if (!v) return res.status(403).json({ error: "Номінації тижня — для тімлідів і керівництва" });
  if (Array.isArray((req.body as { nominations?: unknown } | undefined)?.nominations)) return bulkConfirm(req, res, v);
  const parsed = validateReview(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const b = parsed.value;
  if (await frozenWeek(b.weekFrom)) return res.status(409).json({ error: "Тиждень уже зафіксовано — змінити неможливо" });
  const draft = await draftWeek(b.weekFrom);
  const team = draft.teams.find((t) => t.teamId === b.teamId);
  if (!team) return res.status(404).json({ error: "Команди немає в заліку" });
  const cell = team.cells.find((c) => c.nomination === b.nomination)!;
  // Переможці «своїх даних», що вже стоять, теж рахуються: тімлід не скасує й не «поверне» рішення керівництва про себе.
  const right = canReview(v, { teamId: b.teamId, crmWinners: cell.crm.state === "ok" ? cell.crm.winners : [],
    overrideManagerIds: [...(b.overrideManagerIds ?? []), ...(cell.final.status === "overridden" ? cell.final.winners : [])] });
  if (!right.ok) return res.status(403).json({ error: right.why });
  if (b.overrideManagerIds && !b.overrideManagerIds.every((id) => team.members.some((m) => m.id === id))) {
    return res.status(400).json({ error: "переможець мусить бути менеджером цієї команди в заліку" });
  }
  if (b.action === "retract" && (!cell.review || cell.review.action === "retract")) {
    return res.status(409).json({ error: "Скасовувати нічого: рішення по цьому рядку ще немає" });
  }
  // Відбиток CRM пише СЕРВЕР, з власного розрахунку в цю мить, а не з тіла запиту.
  await pool.query(
    `INSERT INTO nomination_reviews (week_from, team_id, nomination, action, crm_fingerprint, override_manager_ids, override_value, reason, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [b.weekFrom, b.teamId, b.nomination, b.action, cellFingerprint(cell), b.overrideManagerIds, b.overrideValue, b.reason, req.auth!.userId]);
  res.json(await withRights(await draftWeek(b.weekFrom, v.teamId), v));
}));

async function bulkConfirm(req: Request, res: Response, v: Viewer) {
  const parsed = validateBulkConfirm(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const b = parsed.value;
  if (await frozenWeek(b.weekFrom)) return res.status(409).json({ error: "Тиждень уже зафіксовано — змінити неможливо" });
  const draft = await draftWeek(b.weekFrom);
  const team = draft.teams.find((t) => t.teamId === b.teamId);
  if (!team) return res.status(404).json({ error: "Команди немає в заліку" });
  const todo = team.cells.filter((c) => b.nominations.includes(c.nomination) && c.crm.state === "ok"
    && c.final.status === "unconfirmed" && canReview(v, { teamId: b.teamId, crmWinners: c.crm.state === "ok" ? c.crm.winners : [] }).ok);
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    for (const c of todo) {
      await conn.query(
        `INSERT INTO nomination_reviews (week_from, team_id, nomination, action, crm_fingerprint, user_id) VALUES ($1,$2,$3,'confirm',$4,$5)`,
        [b.weekFrom, b.teamId, c.nomination, cellFingerprint(c), req.auth!.userId]);
    }
    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    conn.release();
  }
  res.json({ ...(await withRights(await draftWeek(b.weekFrom, v.teamId), v)), bulk: { confirmed: todo.map((c) => c.nomination) } });
}

/**
 * 🎞 РУЧНІ СЛАЙДИ ПРЕЗЕНТАЦІЇ (прохід 2): новачки, дні народження, новини, довільні. Лише
 * керівництво — і читання, і запис: це підготовка зустрічі, а не частина екрана тімліда.
 * Видалення мʼяке (скасовне). SQL тут — лише про ці слайди, чисел із CRM у них немає.
 */
const leadOnly = (req: Request, res: Response): boolean => {
  if (isAdminScope(req.auth!)) return true;
  res.status(403).json({ error: "Слайди презентації готує керівництво" });
  return false;
};
type SlideRow = { id: number; kind: string; title: string; person: string | null; fields: Record<string, string>; position: number };
const listSlides = async (weekFrom: string) => (await pool.query<SlideRow>(
  `SELECT id, kind, title, person, fields, position FROM nomination_manual_slides
    WHERE week_from = $1 AND deleted_at IS NULL ORDER BY position, id`, [weekFrom])).rows;
/** Відповідь редактора: шаблони + слайди тижня + фото людей, обраних на слайдах. */
async function slidesPayload(weekFrom: string) {
  const slides = await listSlides(weekFrom);
  const ids = slides.map((x) => Number(x.fields?.employeeId)).filter((x) => Number.isInteger(x) && x > 0);
  return { weekFrom, kinds: MANUAL_KINDS, templates: SLIDE_TEMPLATES, slides, photos: await employeePhotos([...new Set(ids)]) };
}

nominationsRouter.get("/manual-slides", safe(async (req: Request, res: Response) => {
  if (!leadOnly(req, res)) return;
  const q = typeof req.query.weekFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.weekFrom) ? weekOf(req.query.weekFrom).from : lastWeek(new Date()).from;
  res.json(await slidesPayload(q));
}));

nominationsRouter.post("/manual-slides", safe(async (req: Request, res: Response) => {
  if (!leadOnly(req, res)) return;
  const v = validateManualSlide(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const x = v.value;
  await pool.query(
    `INSERT INTO nomination_manual_slides (week_from, kind, title, person, fields, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [x.weekFrom, x.kind, x.title, x.person, JSON.stringify(x.fields), x.position, req.auth!.userId]);
  res.status(201).json(await slidesPayload(x.weekFrom));
}));

nominationsRouter.patch("/manual-slides/:id", safe(async (req: Request, res: Response) => {
  if (!leadOnly(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "невірний id" });
  const v = validateManualSlide(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const x = v.value;
  const r = await pool.query(
    `UPDATE nomination_manual_slides SET kind=$2, title=$3, person=$4, fields=$5, position=$6, updated_at=now()
      WHERE id=$1 AND week_from=$7 AND deleted_at IS NULL`, [id, x.kind, x.title, x.person, JSON.stringify(x.fields), x.position, x.weekFrom]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Слайд не знайдено" });
  res.json(await slidesPayload(x.weekFrom));
}));

nominationsRouter.delete("/manual-slides/:id", safe(async (req: Request, res: Response) => {
  if (!leadOnly(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "невірний id" });
  const r = await pool.query<{ week_from: string }>(
    `UPDATE nomination_manual_slides SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL
     RETURNING to_char(week_from,'YYYY-MM-DD') AS week_from`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Слайд не знайдено" });
  res.json(await slidesPayload(r.rows[0].week_from));
}));

/** Скасування видалення — та сама кнопка в тому самому екрані (правило «незворотна кнопка — пастка»). */
nominationsRouter.post("/manual-slides/:id/restore", safe(async (req: Request, res: Response) => {
  if (!leadOnly(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "невірний id" });
  const r = await pool.query<{ week_from: string }>(
    `UPDATE nomination_manual_slides SET deleted_at = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING to_char(week_from,'YYYY-MM-DD') AS week_from`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: "Слайд не знайдено серед видалених" });
  res.json(await slidesPayload(r.rows[0].week_from));
}));
