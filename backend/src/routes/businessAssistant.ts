import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR } from "./uploads.js";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasTab } from "../auth/rbac.js";
import {
  CLAIM_STATUSES, CLAIM_STATUS_LABEL, CASE_STATUSES, CASE_STATUS_LABEL, DOC_TYPE_LABEL, CLAIM_DOC_TYPES, CASE_DOC_TYPES,
  BA_FILE_MAX_BYTES, sniffBaMime, baStoredName,
} from "../core/baRules.js";
import {
  BaError, type Db, listClaims, claimCard, createClaim, updateClaim, setClaimArchived,
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
      fileMaxBytes: BA_FILE_MAX_BYTES,
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
function uploadHandler(kind: "claim" | "case") {
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
function downloadHandler(kind: "claim" | "case") {
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
