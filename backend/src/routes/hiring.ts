import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { isAdminScope } from "../auth/rbac.js";
import { hiringAccess, validRange, dailyTotals, STATUS_LABEL, TRANSITIONS, LEAD_TRANSITIONS, HIRING_STATUSES, type HiringAccess } from "../core/hiringRules.js";
import {
  HiringError, type Db, scheduleRows, createInterview, updateInterview, setInterviewDeleted,
  listCandidates, candidateCard, createCandidate, updateCandidateFields, changeStatus, addComment,
  dailyReport, setDailyManual, hiringMeta,
} from "../core/hiring.js";

/**
 * 🧑‍💼 НАЙМ, прохід 1 (17.09.2026): графік співбесід, база кандидатів, щоденний звіт.
 *
 * Дві межі, і обидві потрібні:
 *  1. tab-гейт `pre("/api/hiring")` у `requireAuth` — роль мусить мати вкладку `hiring`;
 *  2. `hiringAccess` ПЕРШИМ оператором кожного обробника — рекрутер/адмін-рівень редагують усе,
 *     тімлід бачить лише кандидатів своєї команди після співбесіди з ним, решта — 403.
 *     Друга межа існує тому, що першу адмін може відкрити будь-якій ролі тумблером.
 * Звіряють `#501` (межа доступу) і `#504` (матриця == сид).
 */
export const hiringRouter = Router();
hiringRouter.use(requireAuth);

function accessOf(req: Request): HiringAccess {
  const a = req.auth!;
  return hiringAccess({ roleKey: a.roleKey, adminScope: isAdminScope(a) });
}

function fail(res: Response, e: unknown) {
  if (e instanceof HiringError) return res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
  console.error("[hiring]", e);
  return res.status(500).json({ error: "Помилка сервера" });
}

/** Запис — одна транзакція: рядок графіка, картка кандидата й подія історії або всі, або жодне. */
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
  } finally { client.release(); }
}

const idOf = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new HiringError(400, "Некоректний id");
  return n;
};

const onlyEdit = (req: Request) => {
  if (accessOf(req) !== "edit") throw new HiringError(403, "Графік і звіт веде рекрутер");
};
const anyAccess = (req: Request) => {
  const a = accessOf(req);
  if (a === "none") throw new HiringError(403, "Немає доступу до найму");
  return a;
};

hiringRouter.get("/meta", async (req, res) => {
  try {
    const access = anyAccess(req);
    const meta = await hiringMeta(pool as unknown as Db);
    res.json({
      access, teamId: req.auth!.teamId, ...meta,
      statuses: HIRING_STATUSES.map((k) => ({ key: k, label: STATUS_LABEL[k] })),
      transitions: access === "lead" ? LEAD_TRANSITIONS : TRANSITIONS,
    });
  } catch (e) { fail(res, e); }
});

// ── Графік ──────────────────────────────────────────────────────────────────
hiringRouter.get("/schedule", async (req, res) => {
  try {
    onlyEdit(req);
    const r = validRange(req.query.from, req.query.to);
    if (!r) throw new HiringError(400, "Потрібен період from..to (не більше 400 днів)");
    res.json({ rows: await scheduleRows(pool as unknown as Db, r.from, r.to) });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/interviews", async (req, res) => {
  try {
    onlyEdit(req);
    const id = await tx((db) => createInterview(db, req.auth!.userId, req.body ?? {}));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});

hiringRouter.patch("/interviews/:id", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    res.json(await tx((db) => updateInterview(db, req.auth!.userId, id, req.body ?? {})));
  } catch (e) { fail(res, e); }
});

hiringRouter.delete("/interviews/:id", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    await tx((db) => setInterviewDeleted(db, req.auth!.userId, id, true));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/interviews/:id/restore", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    await tx((db) => setInterviewDeleted(db, req.auth!.userId, id, false));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Кандидати ───────────────────────────────────────────────────────────────
hiringRouter.get("/candidates", async (req, res) => {
  try {
    const access = anyAccess(req);
    const q = req.query;
    res.json(await listCandidates(pool as unknown as Db, {
      q: typeof q.q === "string" ? q.q.slice(0, 100) : undefined,
      status: typeof q.status === "string" ? q.status : undefined,
      source: typeof q.source === "string" ? q.source : undefined,
      position: typeof q.position === "string" ? q.position : undefined,
      teamId: q.teamId ? Number(q.teamId) || null : null,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    }, access, req.auth!.teamId));
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates", async (req, res) => {
  try {
    onlyEdit(req);
    const id = await tx((db) => createCandidate(db, req.auth!.userId, req.body ?? {}));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});

hiringRouter.get("/candidates/:id", async (req, res) => {
  try {
    const access = anyAccess(req);
    res.json(await candidateCard(pool as unknown as Db, idOf(req), access, req.auth!.teamId));
  } catch (e) { fail(res, e); }
});

hiringRouter.patch("/candidates/:id", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    await tx(async (db) => {
      await candidateCard(db, id, "edit", null);
      await updateCandidateFields(db, req.auth!.userId, id, req.body ?? {});
    });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/status", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    await tx((db) => changeStatus(db, req.auth!.userId, id, req.body ?? {}, access, req.auth!.teamId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/comment", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    await tx((db) => addComment(db, req.auth!.userId, id, req.body?.comment, access, req.auth!.teamId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Щоденний звіт ───────────────────────────────────────────────────────────
hiringRouter.get("/daily", async (req, res) => {
  try {
    onlyEdit(req);
    const r = validRange(req.query.from, req.query.to);
    if (!r) throw new HiringError(400, "Потрібен період from..to (не більше 400 днів)");
    const rows = await dailyReport(pool as unknown as Db, r.from, r.to);
    res.json({ rows, totals: dailyTotals(rows) });
  } catch (e) { fail(res, e); }
});

hiringRouter.put("/daily/:day", async (req, res) => {
  try {
    onlyEdit(req);
    await tx((db) => setDailyManual(db, req.auth!.userId, req.params.day, req.body ?? {}));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
