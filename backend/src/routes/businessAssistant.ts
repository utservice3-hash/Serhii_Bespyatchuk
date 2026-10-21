import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR } from "./uploads.js";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasTab } from "../auth/rbac.js";
import {
  CLAIM_STATUSES, CLAIM_STATUS_LABEL, CASE_STATUSES, CASE_STATUS_LABEL, DOC_TYPE_LABEL, CLAIM_DOC_TYPES, CASE_DOC_TYPES,
  ISSUE_DOC_TYPES, UTB_DOC_TYPES, BA_FILE_MAX_BYTES, TTN_NORM_PCT, sniffBaMime, baStoredName, defaultTtnMonth, parseDateOrNull,
} from "../core/baRules.js";
import { UTB_STATUSES, UTB_STATUS_LABEL, isUtbStatus, utbAccessOf, utbOwnerIds, utbExportRows, type UtbAccess, type UtbFilter } from "../core/baUtbRules.js";
import { listUtb, utbCard, utbManagers, createUtb, updateUtb } from "../core/baUtb.js";
import { buildXlsx } from "../core/xlsxWrite.js";
import {
  employeesForIssue, listEquipment, equipmentCard, createEquipment, updateEquipment, setEquipmentArchived,
  issueEquipment, returnIssue, undoReturn,
} from "../core/baEquipment.js";
import { ttnMonth, saveTtnCheck, ttnDealsOf, setRouteMismatch, clearRouteMismatch } from "../core/baTtn.js";
import {
  BaError, type Db, type FileOwner, listClaims, claimCard, createClaim, updateClaim, setClaimArchived,
  listCases, caseCard, createCase, updateCase, setCaseArchived, insertFile, fileForDownload,
} from "../core/baClaims.js";

/** Та сама тека, що в `routes/documents.ts` і в нічному бекапі; файли — у її корені з префіксом `ba-`. */
const DOCS_DIR = path.join(UPLOAD_DIR, "..", "documents");

/**
 * 🗂 БІЗНЕС-АСИСТЕНТ, прохід 1 (задача 4314): Претензії й Судовий реєстр.
 *
 * Дві межі, як у найму:
 *  1. tab-гейт `pre("/api/ba")` у `requireAuth` — роль мусить мати вкладку `ba`;
 *  2. `onlyBa` ПЕРШИМ оператором кожного обробника — та сама вкладка ще раз. Друга межа існує,
 *     бо перша стоїть у спільній мапі роутів, і випадкова правка префікса відкрила б розділ мовчки.
 * Розділ бачать бізнес-асистент і керівництво (сид `screen_access`), і хто бачить — той веде
 * (рішення Романа 24.09.2026: «повний доступ»). Звіряє `#772` + матриця `#11`.
 */
export const baRouter = Router();
baRouter.use(requireAuth);

function onlyBa(req: Request): void {
  if (!req.auth || !roleHasTab(req.auth.roleKey, "ba")) throw new BaError(403, "Розділ «Бізнес-асистент» недоступний для вашої ролі");
}
/**
 * 🚛 Реєстр Укртрансбезпеки (задача 6269) — ВУЖЧЕ за розділ: веде власник реєстру поіменно, бачать адміни й операційний
 * директор (Роман 21.10.2026), решті з вкладкою `ba` (СЕО, КВП, бізнес-асистент) — 403. Кличеться ДРУГИМ, після `onlyBa`
 * (першим у кожному обробнику лишається межа розділу — `#772b`).
 */
function utbGate(req: Request, need: UtbAccess): UtbAccess {
  const a = utbAccessOf(req.auth!.userId, req.auth!.roleKey, utbOwnerIds());
  if (!a) throw new BaError(403, "Реєстр Укртрансбезпеки недоступний для вашої ролі");
  if (need === "edit" && a !== "edit") throw new BaError(403, "Реєстр Укртрансбезпеки веде лише його власник — у вас перегляд");
  return a;
}
function fail(res: Response, e: unknown) {
  if (e instanceof BaError) return res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
  console.error("[ba]", e);
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
const idOf = (req: Request, name = "id"): number => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new BaError(400, "Некоректний id");
  return n;
};

baRouter.get("/meta", (req, res) => {
  try {
    onlyBa(req);
    res.json({
      claimStatuses: CLAIM_STATUSES.map((k) => ({ key: k, label: CLAIM_STATUS_LABEL[k] })),
      caseStatuses: CASE_STATUSES.map((k) => ({ key: k, label: CASE_STATUS_LABEL[k] })),
      claimDocTypes: CLAIM_DOC_TYPES.map((k) => ({ key: k, label: DOC_TYPE_LABEL[k] })),
      caseDocTypes: CASE_DOC_TYPES.map((k) => ({ key: k, label: DOC_TYPE_LABEL[k] })),
      issueDocTypes: ISSUE_DOC_TYPES.map((k) => ({ key: k, label: DOC_TYPE_LABEL[k] })),
      fileMaxBytes: BA_FILE_MAX_BYTES,
      // Місяць ТТН за замовчуванням — «два тому» за Києвом (1 жовтня перевіряють серпень).
      ttnDefaultMonth: defaultTtnMonth(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" })),
      ttnNormPct: TTN_NORM_PCT,
      // 🚛 Реєстр УТБ: `null` — вкладку не показувати; `view` — без кнопок; `edit` — веде.
      utbAccess: utbAccessOf(req.auth!.userId, req.auth!.roleKey, utbOwnerIds()),
      utbStatuses: UTB_STATUSES.map((k) => ({ key: k, label: UTB_STATUS_LABEL[k] })),
      utbDocTypes: UTB_DOC_TYPES.map((k) => ({ key: k, label: DOC_TYPE_LABEL[k] })),
    });
  } catch (e) { fail(res, e); }
});

// ── Претензії ────────────────────────────────────────────────────────────────
baRouter.get("/claims", async (req, res) => {
  try { onlyBa(req); res.json({ claims: await listClaims(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});
baRouter.get("/claims/:id", async (req, res) => {
  try { onlyBa(req); res.json(await claimCard(pool as unknown as Db, idOf(req))); } catch (e) { fail(res, e); }
});
baRouter.post("/claims", async (req, res) => {
  try {
    onlyBa(req);
    const id = await tx((db) => createClaim(db, req.auth!.userId, req.body));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});
baRouter.patch("/claims/:id", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    const out = await tx((db) => updateClaim(db, req.auth!.userId, id, req.body));
    res.json({ ok: true, caseCreated: out.caseCreated });
  } catch (e) { fail(res, e); }
});
baRouter.post("/claims/:id/archive", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    const archived = req.body?.archived !== false;
    await tx((db) => setClaimArchived(db, req.auth!.userId, id, archived));
    res.json({ ok: true, archived });
  } catch (e) { fail(res, e); }
});

// ── Судовий реєстр ───────────────────────────────────────────────────────────
baRouter.get("/cases", async (req, res) => {
  try { onlyBa(req); res.json({ cases: await listCases(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});
baRouter.get("/cases/:id", async (req, res) => {
  try { onlyBa(req); res.json(await caseCard(pool as unknown as Db, idOf(req))); } catch (e) { fail(res, e); }
});
baRouter.post("/cases", async (req, res) => {
  try {
    onlyBa(req);
    const id = await tx((db) => createCase(db, req.auth!.userId, req.body));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});
baRouter.patch("/cases/:id", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    await tx((db) => updateCase(db, req.auth!.userId, id, req.body));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
baRouter.post("/cases/:id/archive", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    const archived = req.body?.archived !== false;
    await tx((db) => setCaseArchived(db, req.auth!.userId, id, archived));
    res.json({ ok: true, archived });
  } catch (e) { fail(res, e); }
});

// ── Файли ────────────────────────────────────────────────────────────────────
/**
 * base64 у JSON, як у найму й задачнику (multipart у проєкті немає). Тип — за першими байтами,
 * розмір — до 10 МБ. Байти пишуться ДО рядка в базі; не вставився рядок — файл прибирається.
 * Файли не видаляються: документ справи — доказ, а помилково доданий лишається в історії.
 */
function uploadHandler(kind: FileOwner) {
  return async (req: Request, res: Response) => {
    try {
      onlyBa(req);
      const ownerId = idOf(req);
      const { filename, dataBase64, docType } = req.body ?? {};
      if (typeof dataBase64 !== "string" || !dataBase64) throw new BaError(400, "Файл відсутній");
      const buffer = Buffer.from(dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64, "base64");
      if (!buffer.length) throw new BaError(400, "Файл порожній");
      if (buffer.length > BA_FILE_MAX_BYTES) throw new BaError(413, "Файл більший за 10 МБ");
      const name = (String(filename ?? "файл").trim() || "файл").slice(0, 200);
      const mime = sniffBaMime(buffer, name);
      if (!mime) throw new BaError(400, "Приймаються PDF, DOCX, PNG, JPG або WEBP");
      const storedName = baStoredName(randomUUID(), mime);
      await mkdir(DOCS_DIR, { recursive: true });
      const full = path.join(DOCS_DIR, storedName);
      await writeFile(full, buffer);
      try {
        const id = await tx((db) => insertFile(db, req.auth!.userId, kind, ownerId, { docType, name, storedName, mime, size: buffer.length }));
        res.status(201).json({ id });
      } catch (e) { await unlink(full).catch(() => undefined); throw e; }
    } catch (e) { fail(res, e); }
  };
}
function downloadHandler(kind: FileOwner) {
  return async (req: Request, res: Response) => {
    try {
      onlyBa(req);
      const f = await fileForDownload(pool as unknown as Db, kind, idOf(req), idOf(req, "fileId"));
      res.type(f.mime);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.sendFile(path.join(DOCS_DIR, path.basename(f.stored_name)), (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "Файл відсутній на диску" });
      });
    } catch (e) { fail(res, e); }
  };
}
baRouter.post("/claims/:id/files", uploadHandler("claim"));
baRouter.get("/claims/:id/files/:fileId", downloadHandler("claim"));
baRouter.post("/cases/:id/files", uploadHandler("case"));
baRouter.get("/cases/:id/files/:fileId", downloadHandler("case"));
baRouter.post("/issues/:id/files", uploadHandler("issue"));
baRouter.get("/issues/:id/files/:fileId", downloadHandler("issue"));

// ── 🚛 Реєстр Укртрансбезпеки (задача 6269) ──────────────────────────────────
/** Фільтр із запиту — той самий `filterUtb` віддає і таблицю, і Excel. Сміття — 400, а не мовчазне «без фільтра». */
function utbFilterOf(req: Request): UtbFilter {
  const q = req.query;
  const s = (k: string) => (typeof q[k] === "string" ? String(q[k]) : "");
  const date = (k: string, label: string) => {
    if (!s(k)) return null;
    const d = parseDateOrNull(s(k));
    if (!d) throw new BaError(400, `${label}: дата у форматі РРРР-ММ-ДД`);
    return d;
  };
  const mid = s("managerId") ? Number(s("managerId")) : null;
  if (mid != null && (!Number.isInteger(mid) || mid <= 0)) throw new BaError(400, "Некоректний менеджер");
  if (s("status") && !isUtbStatus(s("status"))) throw new BaError(400, "Невідомий статус");
  return { q: s("q"), carrier: s("carrier"), managerId: mid, status: s("status") ? (s("status") as UtbFilter["status"]) : null,
    from: date("from", "Період «з»"), to: date("to", "Період «по»") };
}
baRouter.get("/utb", async (req, res) => {
  try { onlyBa(req); utbGate(req, "view"); res.json({ rows: await listUtb(pool as unknown as Db, utbFilterOf(req)) }); } catch (e) { fail(res, e); }
});
baRouter.get("/utb/managers", async (req, res) => {
  try { onlyBa(req); utbGate(req, "view"); res.json({ managers: await utbManagers(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});
baRouter.get("/utb/export.xlsx", async (req, res) => {
  try {
    onlyBa(req); utbGate(req, "view");
    const rows = await listUtb(pool as unknown as Db, utbFilterOf(req));
    const buf = buildXlsx([{ name: "Реєстр УТБ", rows: utbExportRows(rows) }]);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="reyestr-utb.xlsx"`);
    res.send(buf);
  } catch (e) { fail(res, e); }
});
baRouter.get("/utb/:id", async (req, res) => {
  try { onlyBa(req); utbGate(req, "view"); res.json(await utbCard(pool as unknown as Db, idOf(req))); } catch (e) { fail(res, e); }
});
baRouter.post("/utb", async (req, res) => {
  try {
    onlyBa(req); utbGate(req, "edit");
    const id = await tx((db) => createUtb(db, req.auth!.userId, req.body));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});
baRouter.patch("/utb/:id", async (req, res) => {
  try {
    onlyBa(req); utbGate(req, "edit");
    const id = idOf(req);
    await tx((db) => updateUtb(db, req.auth!.userId, id, req.body));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
// Файли — ті самі фабрики розділу, але ПІСЛЯ межі реєстру: перегляд не додає, сторонній не бачить.
const utbUpload = uploadHandler("utb"), utbDownload = downloadHandler("utb");
baRouter.post("/utb/:id/files", async (req, res) => {
  try { onlyBa(req); utbGate(req, "edit"); await utbUpload(req, res); } catch (e) { fail(res, e); }
});
baRouter.get("/utb/:id/files/:fileId", async (req, res) => {
  try { onlyBa(req); utbGate(req, "view"); await utbDownload(req, res); } catch (e) { fail(res, e); }
});

// ── Облік техніки (прохід 2, 29.09.2026) ─────────────────────────────────────
/** Кому видати: лише id, ПІБ і стан із реєстру — телефонів, дат народження тощо розділ не отримує (#984). */
baRouter.get("/employees", async (req, res) => {
  try { onlyBa(req); res.json({ employees: await employeesForIssue(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});
baRouter.get("/equipment", async (req, res) => {
  try { onlyBa(req); res.json({ items: await listEquipment(pool as unknown as Db) }); } catch (e) { fail(res, e); }
});
baRouter.get("/equipment/:id", async (req, res) => {
  try { onlyBa(req); res.json(await equipmentCard(pool as unknown as Db, idOf(req))); } catch (e) { fail(res, e); }
});
baRouter.post("/equipment", async (req, res) => {
  try {
    onlyBa(req);
    const id = await tx((db) => createEquipment(db, req.auth!.userId, req.body));
    res.status(201).json({ id });
  } catch (e) { fail(res, e); }
});
baRouter.patch("/equipment/:id", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    await tx((db) => updateEquipment(db, req.auth!.userId, id, req.body));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
baRouter.post("/equipment/:id/archive", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    const archived = req.body?.archived !== false;
    await tx((db) => setEquipmentArchived(db, req.auth!.userId, id, archived));
    res.json({ ok: true, archived });
  } catch (e) { fail(res, e); }
});
baRouter.post("/equipment/:id/issue", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    const issueId = await tx((db) => issueEquipment(db, req.auth!.userId, id, req.body));
    res.status(201).json({ issueId });
  } catch (e) { fail(res, e); }
});
baRouter.post("/issues/:id/return", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    await tx((db) => returnIssue(db, req.auth!.userId, id, req.body));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
baRouter.post("/issues/:id/undo-return", async (req, res) => {
  try {
    onlyBa(req);
    const id = idOf(req);
    await tx((db) => undoReturn(db, req.auth!.userId, id));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── ТТН-моніторинг (прохід 2, 29.09.2026) ────────────────────────────────────
baRouter.get("/ttn", async (req, res) => {
  try {
    onlyBa(req);
    const month = String(req.query.month ?? "");
    res.json(await ttnMonth(pool as unknown as Db, month, config.kommo.baseUrl));
  } catch (e) { fail(res, e); }
});
/** Угоди менеджера за місяць (05.10.2026): де ТТН немає, і де позначено «маршрут не збігся». */
baRouter.get("/ttn/:month/:managerId/deals", async (req, res) => {
  try {
    onlyBa(req);
    res.json({ deals: await ttnDealsOf(pool as unknown as Db, String(req.params.month), idOf(req, "managerId"), config.kommo.baseUrl) });
  } catch (e) { fail(res, e); }
});
baRouter.put("/ttn/deals/:kommoId/mismatch", async (req, res) => {
  try {
    onlyBa(req);
    const kommoId = idOf(req, "kommoId");
    await tx((db) => setRouteMismatch(db, req.auth!.userId, kommoId, req.body));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
baRouter.delete("/ttn/deals/:kommoId/mismatch", async (req, res) => {
  try {
    onlyBa(req);
    const kommoId = idOf(req, "kommoId");
    await tx((db) => clearRouteMismatch(db, kommoId));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
baRouter.put("/ttn/:month/:managerId", async (req, res) => {
  try {
    onlyBa(req);
    const managerId = idOf(req, "managerId");
    const month = String(req.params.month);
    await tx((db) => saveTtnCheck(db, req.auth!.userId, month, managerId, req.body));
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
