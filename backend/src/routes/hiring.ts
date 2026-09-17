import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR } from "./uploads.js";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { isAdminScope } from "../auth/rbac.js";
import {
  hiringAccess, validRange, dailyTotals, STATUS_LABEL, TRANSITIONS, LEAD_TRANSITIONS, HIRING_STATUSES, type HiringAccess,
  VACANCY_STATUSES, VACANCY_STATUS_LABEL, VACANCY_RESULTS, HIRING_FILE_MAX_BYTES, sniffFileMime, hiringStoredName,
} from "../core/hiringRules.js";
import {
  HiringError, type Db, scheduleRows, createInterview, updateInterview, setInterviewDeleted,
  listCandidates, candidateCard, createCandidate, updateCandidateFields, changeStatus, addComment,
  dailyReport, setDailyManual, hiringMeta,
  listVacancies, createVacancy, updateVacancy, setCandidateVacancies, addRefusalReason, refuseCandidate, setReserve,
  insertFile, fileForDownload, setFileDeleted,
} from "../core/hiring.js";
import {
  trainingBoard, trainingDetail, issueInvite, extendAccess, restoreAccess, promoteCandidate, answerQuestion,
} from "../core/hiringTraining.js";
import { CANDIDATE_ACCESS, canDecideTraining } from "../core/hiringTrainingRules.js";

/** Та сама тека, що в `routes/documents.ts` (DOCS_DIR) і в нічному бекапі. */
const DOCS_DIR = path.join(UPLOAD_DIR, "..", "documents");

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
      vacancyStatuses: VACANCY_STATUSES.map((k) => ({ key: k, label: VACANCY_STATUS_LABEL[k] })),
      vacancyResults: VACANCY_RESULTS,
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
      vacancyId: q.vacancyId ? Number(q.vacancyId) || null : null,
      reserve: q.reserve === "yes" || q.reserve === "no" ? q.reserve : null,
      refusalSide: typeof q.refusalSide === "string" ? q.refusalSide : null,
      noVacancy: q.noVacancy === "1",
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

// ── Вакансії (прохід 1a) ────────────────────────────────────────────────────
hiringRouter.get("/vacancies", async (req, res) => {
  try {
    onlyEdit(req);
    const scope = req.query.scope === "closed" || req.query.scope === "all" ? req.query.scope : "active";
    res.json({ rows: await listVacancies(pool as unknown as Db, scope) });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/vacancies", async (req, res) => {
  try {
    onlyEdit(req);
    const id = await tx((db) => createVacancy(db, req.auth!.userId, req.body ?? {}));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});

hiringRouter.patch("/vacancies/:id", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    await tx((db) => updateVacancy(db, id, req.body ?? {}));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.put("/candidates/:id/vacancies", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    await tx((db) => setCandidateVacancies(db, req.auth!.userId, id, req.body?.vacancyIds));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Відмова з причиною, резерв ──────────────────────────────────────────────
hiringRouter.post("/refusal-reasons", async (req, res) => {
  try {
    onlyEdit(req);
    const id = await tx((db) => addRefusalReason(db, req.auth!.userId, req.body ?? {}));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/refuse", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    await tx((db) => refuseCandidate(db, req.auth!.userId, id, req.body ?? {}, access, req.auth!.teamId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/reserve", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    await tx((db) => setReserve(db, req.auth!.userId, id, req.body ?? {}));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Файли-докази ────────────────────────────────────────────────────────────
/**
 * base64 у JSON, як у задачника й документів (multipart у проєкті немає). Тип — за першими
 * байтами, не за словом клієнта; розмір — до 5 МБ. Байти пишуться ДО рядка в базі, а якщо
 * рядок не вставився (ліміт, чужа картка) — файл із диска прибирається.
 */
hiringRouter.post("/candidates/:id/files", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    const { filename, dataBase64 } = req.body ?? {};
    if (typeof dataBase64 !== "string" || !dataBase64) throw new HiringError(400, "Файл відсутній");
    const buffer = Buffer.from(dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64, "base64");
    if (!buffer.length) throw new HiringError(400, "Файл порожній");
    if (buffer.length > HIRING_FILE_MAX_BYTES) throw new HiringError(413, "Файл більший за 5 МБ");
    const mime = sniffFileMime(buffer);
    if (!mime) throw new HiringError(400, "Приймаються лише PNG, JPG, WEBP або PDF");
    const name = (String(filename ?? "файл").trim() || "файл").slice(0, 200);
    const storedName = hiringStoredName(randomUUID(), mime);
    await mkdir(DOCS_DIR, { recursive: true });
    const full = path.join(DOCS_DIR, storedName);
    await writeFile(full, buffer);
    try {
      const fileId = await tx((db) => insertFile(db, req.auth!.userId, id, { name, storedName, mime, size: buffer.length }));
      res.status(201).json({ id: fileId });
    } catch (e) { await unlink(full).catch(() => undefined); throw e; }
  } catch (e) { fail(res, e); }
});

hiringRouter.get("/candidates/:id/files/:fileId", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    const fileId = Number(req.params.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) throw new HiringError(400, "Некоректний id файлу");
    const f = await fileForDownload(pool as unknown as Db, id, fileId, access, req.auth!.teamId);
    res.type(f.mime);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(path.join(DOCS_DIR, f.stored_name), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "Файл відсутній на диску" });
    });
  } catch (e) { fail(res, e); }
});

hiringRouter.delete("/candidates/:id/files/:fileId", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    const fileId = Number(req.params.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) throw new HiringError(400, "Некоректний id файлу");
    await tx((db) => setFileDeleted(db, req.auth!.userId, id, fileId, true));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/files/:fileId/restore", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    const fileId = Number(req.params.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) throw new HiringError(400, "Некоректний id файлу");
    await tx((db) => setFileDeleted(db, req.auth!.userId, id, fileId, false));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── На навчанні (прохід 2a) ─────────────────────────────────────────────────
/**
 * Дошка й прогрес — рекрутер, адмін-рівень, тімлід своєї команди. Рішення «менеджер» і відповідь
 * на питання — лише тімлід або адмін-рівень (`canDecideTraining`), як у затвердженому макеті.
 */
const decides = (req: Request) => canDecideTraining({ roleKey: req.auth!.roleKey, adminScope: isAdminScope(req.auth!) });

hiringRouter.get("/training", async (req, res) => {
  try {
    const access = anyAccess(req);
    const rows = await trainingBoard(pool as unknown as Db, access, req.auth!.teamId);
    res.json({ rows, rules: CANDIDATE_ACCESS, canDecide: decides(req) });
  } catch (e) { fail(res, e); }
});

hiringRouter.get("/training/:id", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    const { row, steps, questions, events } = await trainingDetail(pool as unknown as Db, id, access, req.auth!.teamId);
    res.json({ row, steps, questions, events, canDecide: decides(req), canRestore: access === "edit" });
  } catch (e) { fail(res, e); }
});

/** Посилання-запрошення: токен віддається ОДИН раз, у базі — лише хеш. Адресу будує фронт. */
hiringRouter.post("/candidates/:id/invite", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    res.status(201).json(await tx((db) => issueInvite(db, req.auth!.userId, id, access, req.auth!.teamId)));
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/access/extend", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    await tx((db) => extendAccess(db, req.auth!.userId, id, access, req.auth!.teamId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/access/restore", async (req, res) => {
  try {
    onlyEdit(req);
    const id = idOf(req);
    await tx((db) => restoreAccess(db, req.auth!.userId, id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/promote", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    await tx((db) => promoteCandidate(db, req.auth!.userId, id, req.body?.comment, decides(req), access, req.auth!.teamId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

hiringRouter.post("/candidates/:id/questions/:questionId/answer", async (req, res) => {
  try {
    const access = anyAccess(req);
    const id = idOf(req);
    const qid = Number(req.params.questionId);
    if (!Number.isInteger(qid) || qid <= 0) throw new HiringError(400, "Некоректний id питання");
    await tx((db) => answerQuestion(db, req.auth!.userId, id, qid, req.body?.answer, decides(req), access, req.auth!.teamId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
