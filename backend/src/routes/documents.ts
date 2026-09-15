import { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID, createHash } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { signBotConfigured, signBotSend } from "../bot/signBot.js";
import { notifyOfferOnce } from "../jobs/offerReminders.js";
import { generateSignCode, verifySignCode, signCodeMessage, SIGN_CODE_TTL_MS } from "../core/signCode.js";
import { UPLOAD_DIR } from "./uploads.js";
import { OWNER_NAME_SQL } from "../core/absences.js";
import {
  canSeeDocument, canSeeOffersSection, canUploadTo, canEditDocument, canManageAccess, canSignDocument,
  signatureState, isManagement, MANAGEMENT_ROLES, DEFAULT_RIGHTS,
  type DocLike, type DocViewer, type AccessContext, type FolderRights, type Grant, type DocSection,
} from "../core/docAccess.js";

/**
 * 📁 РЕГЛАМЕНТИ ТА ДОКУМЕНТИ v2 (15.09.2026) — доступи, типи, версії, перегляд, підпис, архів.
 * ТЗ `TZ-DOKUMENTY-I-PIDPYSY_1.md`, план `docs/PLAN_DOCUMENTS_V2_2026-09-15.md`.
 *
 * 🔴 ДОСТУП — ЧЕРЕЗ `core/docAccess.ts`, І ТІЛЬКИ ЧЕРЕЗ НЬОГО. Дерево, картка, завантаження,
 * пошук — усе фільтрує та сама функція `canSeeDocument`. Документ, схований у списку, не
 * відкривається за прямим посиланням (гейт #430f звіряє рівність по чотирьох місцях).
 * Це свідомий виняток із правила «видимість за обсягом ролі» — див. коментар у ядрі.
 *
 * Файли лежать на диску хостингу в `backend/documents` (поза публічним `/api/files`), 120 КБ на
 * 15.09. ⚠️ У нічний бекап тека НЕ потрапляє (звірено 14.09) — борг власнику.
 * Фізично файли НЕ видаляються: «прибрати» = стан, старі версії лишаються на диску.
 */
export const documentsRouter = Router();
documentsRouter.use(requireAuth);

const DOCS_DIR = path.join(UPLOAD_DIR, "..", "documents");
// 100 МБ — рішення власника 15.09.2026 («ліміт файлу 100 МБ має вистачити»). Файл їде
// base64 у JSON, тож ліміт тіла в index.ts мусить бути ≥ 100 × 4/3 ≈ 134 МБ (стоїть 140).
const MAX_BYTES = 100 * 1024 * 1024;
export const DOC_TYPES = ["Регламент", "Інструкція", "Шаблон", "Офер", "Матеріал для клієнта", "Інше"] as const;
const SECTIONS: DocSection[] = ["general", "personal", "offer"];

const viewerOf = (req: Request): DocViewer => ({ userId: req.auth!.userId, roleKey: req.auth!.roleKey });
const management = (req: Request, res: Response, next: NextFunction) =>
  isManagement(req.auth!.roleKey) ? next() : res.status(403).json({ error: "Лише керівництво (адмін, опдир, СЕО)" });

const FILE_SELECT = `
  SELECT f.id, f.folder_id, f.name, f.category, f.mime, f.size_bytes, f.created_at, f.updated_at,
         f.section, f.addressee_user_id, f.description, f.version, f.sha256,
         f.archived_at, f.archived_reason, f.created_by,
         COALESCE(am.name, au.full_name, au.email) AS author,
         COALESCE(dm.name, du.full_name, du.email) AS addressee
    FROM doc_files f
    LEFT JOIN users au ON au.id = f.created_by LEFT JOIN managers am ON am.id = au.manager_id
    LEFT JOIN users du ON du.id = f.addressee_user_id LEFT JOIN managers dm ON dm.id = du.manager_id`;

interface FileRow {
  id: number; folder_id: number | null; name: string; category: string | null; mime: string | null;
  size_bytes: string | null; created_at: string; updated_at: string; section: DocSection;
  addressee_user_id: number | null; description: string | null; version: number; sha256: string | null;
  archived_at: string | null; archived_reason: string | null; created_by: number | null;
  author: string | null; addressee: string | null;
}
const toDocLike = (r: FileRow): DocLike => ({ id: r.id, folderId: r.folder_id, section: r.section, addresseeUserId: r.addressee_user_id, createdBy: r.created_by, archivedAt: r.archived_at });

/** Контекст доступу поточного глядача: явні права його ролі по папках + його винятки. */
async function accessContext(req: Request): Promise<AccessContext> {
  const roleKey = req.auth!.roleKey;
  const [rights, grants] = await Promise.all([
    pool.query<{ folder_id: number; can_view: boolean; can_upload: boolean; can_edit: boolean; can_publish: boolean }>(
      `SELECT folder_id, can_view, can_upload, can_edit, can_publish FROM doc_folder_access WHERE role_key = $1`, [roleKey]),
    pool.query<{ folder_id: number | null; file_id: number | null; user_id: number; can_view: boolean; can_upload: boolean; expires_at: string | null }>(
      `SELECT folder_id, file_id, user_id, can_view, can_upload, expires_at FROM doc_access_grants WHERE user_id = $1`, [req.auth!.userId]),
  ]);
  const folderRights = new Map<number, FolderRights>();
  for (const r of rights.rows) folderRights.set(r.folder_id, { canView: r.can_view, canUpload: r.can_upload, canEdit: r.can_edit, canPublish: r.can_publish });
  const gs: Grant[] = grants.rows.map((g) => ({ folderId: g.folder_id, fileId: g.file_id, userId: g.user_id, canView: g.can_view, canUpload: g.can_upload, expiresAt: g.expires_at }));
  return { folderRights, grants: gs };
}

async function logAccess(actorId: number, action: string, details: Record<string, unknown>, folderId: number | null = null, fileId: number | null = null) {
  await pool.query(`INSERT INTO doc_access_log (actor_id, folder_id, file_id, action, details) VALUES ($1, $2, $3, $4, $5)`,
    [actorId, folderId, fileId, action, JSON.stringify(details)]).catch((e) => console.error("[doc_access_log]", (e as Error).message));
}
async function logEvent(fileId: number, kind: string, actorId: number | null, details: Record<string, unknown> = {}) {
  await pool.query(`INSERT INTO doc_events (file_id, kind, actor_id, details) VALUES ($1, $2, $3, $4)`, [fileId, kind, actorId, JSON.stringify(details)])
    .catch((e) => console.error("[doc_events]", (e as Error).message));
}

async function loadFile(id: number): Promise<FileRow | null> {
  const r = await pool.query<FileRow>(`${FILE_SELECT} WHERE f.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** Файл видно глядачу? 404 не 403: чужий документ не мусить підтверджувати своє існування. */
async function visibleFile(req: Request, res: Response, id: number): Promise<{ row: FileRow; ctx: AccessContext } | null> {
  const [row, ctx] = await Promise.all([loadFile(id), accessContext(req)]);
  if (!row) { res.status(404).json({ error: "Документ не знайдено" }); return null; }
  if (!canSeeDocument(viewerOf(req), toDocLike(row), ctx)) { res.status(403).json({ error: "Документ не для вас. Доступ мають адресат і керівництво.", reason: "no_access" }); return null; }
  return { row, ctx };
}

function decodeBase64(dataBase64: unknown): Buffer | null {
  if (!dataBase64 || typeof dataBase64 !== "string") return null;
  const base64 = dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64;
  return Buffer.from(base64, "base64");
}
async function storeBuffer(display: string, buffer: Buffer): Promise<{ storedName: string; sha256: string }> {
  const ext = path.extname(display).slice(0, 12).replace(/[^.\w]/g, "");
  const storedName = `${randomUUID()}${ext}`;
  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(path.join(DOCS_DIR, storedName), buffer);
  return { storedName, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function shape(r: FileRow, sigs: { version: number; sha256: string; signed_at: string }[], sentAt: string | null, viewer: DocViewer, ctx: AccessContext) {
  const st = signatureState({ version: r.version, sha256: r.sha256, section: r.section }, sigs.map((s) => ({ version: s.version, sha256: s.sha256, signedAt: s.signed_at })), new Date(), sentAt);
  return {
    id: r.id, folderId: r.folder_id, name: r.name, category: r.category, mime: r.mime, sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    createdAt: r.created_at, updatedAt: r.updated_at, section: r.section, addresseeUserId: r.addressee_user_id, addressee: r.addressee,
    description: r.description, version: r.version, sha256: r.sha256, archivedAt: r.archived_at, archivedReason: r.archived_reason,
    author: r.author, createdBy: r.created_by,
    signature: st,
    canEdit: canEditDocument(viewer, toDocLike(r), ctx),
    canSign: canSignDocument(viewer, toDocLike(r)) && st.kind !== "signed",
  };
}

/**
 * ДЕРЕВО: папки, файли (вже відфільтровані предикатом), розділи з лічильниками, права глядача.
 * 🔴 Помилка тут — 500 з тілом `{error}`, і фронт показує стан «помилка», НЕ «порожньо».
 */
documentsRouter.get("/tree", async (req, res) => {
  const viewer = viewerOf(req);
  const ctx = await accessContext(req);
  const [folders, files, sigs, sent] = await Promise.all([
    pool.query<{ id: number; parent_id: number | null; name: string; created_at: string }>(`SELECT id, parent_id, name, created_at FROM doc_folders ORDER BY name`),
    pool.query<FileRow>(`${FILE_SELECT} ORDER BY f.updated_at DESC`),
    pool.query<{ file_id: number; version: number; sha256: string; signed_at: string }>(`SELECT file_id, version, sha256, signed_at FROM doc_signatures`),
    pool.query<{ file_id: number; at: string }>(`SELECT file_id, min(at) AS at FROM doc_events WHERE kind = 'sent' GROUP BY file_id`),
  ]);
  const sigBy = new Map<number, { version: number; sha256: string; signed_at: string }[]>();
  for (const s of sigs.rows) { const a = sigBy.get(s.file_id) ?? []; a.push(s); sigBy.set(s.file_id, a); }
  const sentBy = new Map(sent.rows.map((r) => [r.file_id, r.at]));
  const visible = files.rows.filter((r) => canSeeDocument(viewer, toDocLike(r), ctx));
  const hasOwnOffer = visible.some((r) => r.section === "offer" && r.addressee_user_id === viewer.userId && r.archived_at == null);
  const mgmt = isManagement(viewer.roleKey);
  const counts = {
    general: visible.filter((r) => r.section === "general" && !r.archived_at).length,
    personal: visible.filter((r) => r.section === "personal" && !r.archived_at).length,
    offer: visible.filter((r) => r.section === "offer" && !r.archived_at).length,
    archive: visible.filter((r) => !!r.archived_at).length,
  };
  res.json({
    folders: folders.rows.map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name, createdAt: f.created_at })),
    files: visible.map((r) => shape(r, sigBy.get(r.id) ?? [], sentBy.get(r.id) ?? null, viewer, ctx)),
    counts,
    sections: { general: true, personal: true, offer: canSeeOffersSection(viewer, hasOwnOffer), archive: mgmt },
    viewer: { userId: viewer.userId, roleKey: viewer.roleKey, isManagement: mgmt, canManageAccess: canManageAccess(viewer),
              canUploadRoot: canUploadTo(viewer, null, ctx),
              uploadFolders: folders.rows.filter((f) => canUploadTo(viewer, f.id, ctx)).map((f) => f.id) },
    types: DOC_TYPES,
  });
});

/** Люди для вибору адресата (особисті/офери) — лише керівництву. */
documentsRouter.get("/people", management, async (_req, res) => {
  const r = await pool.query<{ user_id: number; name: string; role: string; team_name: string | null }>(
    `SELECT u.id AS user_id, ${OWNER_NAME_SQL} AS name, COALESCE(u.role_override, u.role) AS role, t.name AS team_name
       FROM users u LEFT JOIN managers m ON m.id = u.manager_id LEFT JOIN teams t ON t.id = m.team_id
      WHERE u.is_active ORDER BY name`);
  res.json({ people: r.rows.map((p) => ({ userId: p.user_id, name: p.name, role: p.role, team: p.team_name })) });
});

/** Картка документа: усе з дерева + історія версій, підписи, події. */
documentsRouter.get("/file/:id", async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  const id = v.row.id;
  const [versions, sigs, events] = await Promise.all([
    pool.query(`SELECT v.version, v.sha256, v.mime, v.size_bytes, v.created_at, COALESCE(m.name, u.full_name, u.email) AS author
                  FROM doc_file_versions v LEFT JOIN users u ON u.id = v.created_by LEFT JOIN managers m ON m.id = u.manager_id
                 WHERE v.file_id = $1 ORDER BY v.version DESC`, [id]),
    pool.query<{ version: number; sha256: string; signed_at: string; method: string; signer: string; evidence_stored_name: string | null }>(
      `SELECT s.version, s.sha256, s.signed_at, s.method, s.evidence_stored_name, COALESCE(m.name, u.full_name, u.email) AS signer
         FROM doc_signatures s LEFT JOIN users u ON u.id = s.signed_by LEFT JOIN managers m ON m.id = u.manager_id
        WHERE s.file_id = $1 ORDER BY s.signed_at DESC`, [id]),
    pool.query(`SELECT e.kind, e.at, e.details, COALESCE(m.name, u.full_name, u.email) AS actor
                  FROM doc_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN managers m ON m.id = u.manager_id
                 WHERE e.file_id = $1 ORDER BY e.at`, [id]),
  ]);
  const sentAt = (events.rows.find((e) => e.kind === "sent") as { at?: string } | undefined)?.at ?? null;
  // Відкриття картки адресатом — подія «opened» (для таймлайна офера), один раз.
  if (v.row.addressee_user_id === req.auth!.userId && !events.rows.some((e) => e.kind === "opened")) {
    await logEvent(id, "opened", req.auth!.userId);
  }
  res.json({
    file: shape(v.row, sigs.rows, sentAt, viewerOf(req), v.ctx),
    versions: versions.rows,
    signatures: sigs.rows.map((s) => ({ version: s.version, sha256: s.sha256, signedAt: s.signed_at, method: s.method, signer: s.signer, hasEvidence: !!s.evidence_stored_name,
      current: s.sha256 === v.row.sha256 && s.version === v.row.version })),
    events: events.rows,
  });
});

/** Хто бачить документ (для блоку «хто бачить») — керівництву. */
documentsRouter.get("/file/:id/viewers", management, async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  const r = v.row;
  const roles = await pool.query<{ key: string; name: string }>(`SELECT key, name FROM roles ORDER BY name`);
  const rights = r.folder_id == null ? [] : (await pool.query<{ role_key: string; can_view: boolean }>(`SELECT role_key, can_view FROM doc_folder_access WHERE folder_id = $1`, [r.folder_id])).rows;
  const grants = await pool.query<{ name: string; expires_at: string | null }>(
    `SELECT ${OWNER_NAME_SQL} AS name, g.expires_at FROM doc_access_grants g JOIN users u ON u.id = g.user_id LEFT JOIN managers m ON m.id = u.manager_id
      WHERE (g.file_id = $1 OR g.folder_id = $2) AND (g.expires_at IS NULL OR g.expires_at > now())`, [r.id, r.folder_id]);
  let who: { label: string; note: string }[];
  if (r.archived_at) who = [{ label: "Керівництво", note: "читання без змін" }];
  else if (r.section === "offer") who = [{ label: r.addressee ?? "адресата не вказано", note: "адресат" }, { label: "Керівництво", note: "керує доступом" }];
  else if (r.section === "personal") who = [{ label: r.addressee ?? "адресата не вказано", note: "адресат" }, { label: r.author ?? "автор невідомий", note: "виклав" }, { label: "Керівництво", note: "керує доступом" }];
  else {
    const closed = new Set(rights.filter((x) => !x.can_view).map((x) => x.role_key));
    const open = roles.rows.filter((x) => !closed.has(x.key) || MANAGEMENT_ROLES.includes(x.key));
    who = open.length === roles.rows.length ? [{ label: "Уся команда", note: "усі ролі" }] : open.map((x) => ({ label: x.name, note: "за правами папки" }));
  }
  res.json({ who, exceptions: grants.rows.map((g) => ({ name: g.name, until: g.expires_at })) });
});

/** Прев'ю або завантаження. `?inline=1` — віддати у вкладку/iframe (PDF, зображення, HTML). */
documentsRouter.get("/file/:id/download", async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  const versionQ = req.query.version != null ? Number(req.query.version) : null;
  let stored = (await pool.query<{ stored_name: string; mime: string | null }>(`SELECT stored_name, mime FROM doc_files WHERE id = $1`, [v.row.id])).rows[0];
  if (versionQ != null && versionQ !== v.row.version) {
    const old = await pool.query<{ stored_name: string; mime: string | null }>(`SELECT stored_name, mime FROM doc_file_versions WHERE file_id = $1 AND version = $2`, [v.row.id, versionQ]);
    if (!old.rowCount) return res.status(404).json({ error: "Такої версії немає" });
    stored = old.rows[0];
  }
  const inline = String(req.query.inline ?? "") === "1";
  if (stored.mime) res.type(stored.mime);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(v.row.name)}`);
  res.sendFile(path.join(DOCS_DIR, stored.stored_name), (err) => { if (err && !res.headersSent) res.status(404).json({ error: "Файл на диску не знайдено" }); });
});

/** Фото паперового підпису — керівництву й самому підписанту. */
documentsRouter.get("/file/:id/signature/:sigId/evidence", async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  const s = await pool.query<{ evidence_stored_name: string | null; signed_by: number }>(`SELECT evidence_stored_name, signed_by FROM doc_signatures WHERE id = $1 AND file_id = $2`, [Number(req.params.sigId), v.row.id]);
  const row = s.rows[0];
  if (!row?.evidence_stored_name) return res.status(404).json({ error: "Фото підпису немає" });
  if (!isManagement(req.auth!.roleKey) && row.signed_by !== req.auth!.userId) return res.status(403).json({ error: "Фото підпису бачать підписант і керівництво" });
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(path.join(DOCS_DIR, row.evidence_stored_name));
});

/** Папки — керівництво. */
documentsRouter.post("/folder", management, async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "Назва папки порожня" });
  const parentId = req.body?.parentId != null ? Number(req.body.parentId) : null;
  const r = await pool.query(`INSERT INTO doc_folders (parent_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, parent_id, name, created_at`, [parentId, name, req.auth!.userId]);
  res.json(r.rows[0]);
});
documentsRouter.patch("/folder/:id", management, async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "Назва папки порожня" });
  const r = await pool.query(`UPDATE doc_folders SET name = $1 WHERE id = $2`, [name, Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Папку не знайдено" });
  res.json({ ok: true });
});
documentsRouter.delete("/folder/:id", management, async (req, res) => {
  // Файли з диска НЕ видаляємо (розділ 12 ТЗ); рядки — каскадом.
  const r = await pool.query(`DELETE FROM doc_folders WHERE id = $1`, [Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Папку не знайдено" });
  await logAccess(req.auth!.userId, "folder_deleted", {}, Number(req.params.id));
  res.json({ ok: true });
});

/**
 * ЗАВАНТАЖИТИ ФАЙЛ. Розділ і адресат — обовʼязкові осі: особистий/офер без адресата не
 * приймається (інакше документ не бачив би ніхто, крім керівництва, і це читалось би як
 * загублений). Публікувати в «Загальні» — керівництво або право `can_upload` на папці.
 */
documentsRouter.post("/file", async (req, res) => {
  const viewer = viewerOf(req);
  const ctx = await accessContext(req);
  const section = SECTIONS.includes(req.body?.section) ? (req.body.section as DocSection) : "general";
  const folderId = req.body?.folderId != null ? Number(req.body.folderId) : null;
  const addressee = req.body?.addresseeUserId != null ? Number(req.body.addresseeUserId) : null;
  if (section === "general" && !canUploadTo(viewer, folderId, ctx)) return res.status(403).json({ error: "У цю папку публікує лише керівництво" });
  if (section !== "general" && !isManagement(viewer.roleKey)) return res.status(403).json({ error: "Особисті документи й офери виклада є керівництво" });
  if (section !== "general" && !addressee) return res.status(400).json({ error: "Вкажіть адресата: особистий документ і офер належать людині" });
  const buffer = decodeBase64(req.body?.dataBase64);
  if (!buffer) return res.status(400).json({ error: "Файл відсутній" });
  if (buffer.length > MAX_BYTES) return res.status(413).json({ error: "Файл завеликий (макс. 100 МБ)" });
  const display = String(req.body?.filename ?? "файл").trim() || "файл";
  const category = DOC_TYPES.includes(req.body?.category) ? String(req.body.category) : section === "offer" ? "Офер" : "Інше";
  const { storedName, sha256 } = await storeBuffer(display, buffer);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO doc_files (folder_id, name, stored_name, category, mime, size_bytes, created_by, section, addressee_user_id, description, version, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11) RETURNING id`,
    [section === "general" ? folderId : null, display, storedName, category, req.body?.mime ? String(req.body.mime).slice(0, 120) : null, buffer.length,
     viewer.userId, section, section === "general" ? null : addressee, req.body?.description ? String(req.body.description).slice(0, 2000) : null, sha256]);
  const id = r.rows[0].id;
  await pool.query(`INSERT INTO doc_file_versions (file_id, version, stored_name, sha256, mime, size_bytes, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6)`,
    [id, storedName, sha256, req.body?.mime ?? null, buffer.length, viewer.userId]);
  await logEvent(id, section === "offer" ? "sent" : "uploaded", viewer.userId, { version: 1 });
  if (section === "offer") void notifyOfferOnce(id);
  const row = await loadFile(id);
  res.json(shape(row!, [], section === "offer" ? new Date().toISOString() : null, viewer, ctx));
});

/**
 * НОВА ВЕРСІЯ. Хеш міняється → підпис попередньої версії стає недійсним автоматично
 * (`signatureState` звіряє sha), старий запис лишається й позначається як «інша версія».
 */
documentsRouter.post("/file/:id/version", async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  if (!canEditDocument(viewerOf(req), toDocLike(v.row), v.ctx)) return res.status(403).json({ error: v.row.archived_at ? "Документ в архіві: нову версію не можна нікому" : "Немає права редагувати" });
  const buffer = decodeBase64(req.body?.dataBase64);
  if (!buffer) return res.status(400).json({ error: "Файл відсутній" });
  if (buffer.length > MAX_BYTES) return res.status(413).json({ error: "Файл завеликий (макс. 100 МБ)" });
  const display = String(req.body?.filename ?? v.row.name).trim() || v.row.name;
  const { storedName, sha256 } = await storeBuffer(display, buffer);
  const next = v.row.version + 1;
  await pool.query(`INSERT INTO doc_file_versions (file_id, version, stored_name, sha256, mime, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [v.row.id, next, storedName, sha256, req.body?.mime ?? v.row.mime, buffer.length, req.auth!.userId]);
  await pool.query(`UPDATE doc_files SET stored_name = $2, sha256 = $3, version = $4, mime = COALESCE($5, mime), size_bytes = $6, name = $7, updated_at = now() WHERE id = $1`,
    [v.row.id, storedName, sha256, next, req.body?.mime ?? null, buffer.length, display]);
  await logEvent(v.row.id, "version", req.auth!.userId, { version: next, sha256 });
  if (v.row.section === "offer") { await logEvent(v.row.id, "sent", req.auth!.userId, { version: next }); await pool.query(`UPDATE doc_files SET reminded_at = NULL WHERE id = $1`, [v.row.id]); void notifyOfferOnce(v.row.id); }
  res.json({ ok: true, version: next, sha256 });
});

/** Метадані: назва, тип, опис, папка (лише загальні). */
documentsRouter.patch("/file/:id", async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  if (!canEditDocument(viewerOf(req), toDocLike(v.row), v.ctx)) return res.status(403).json({ error: v.row.archived_at ? "Документ в архіві не редагується" : "Немає права редагувати" });
  const sets: string[] = []; const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (typeof req.body?.name === "string" && req.body.name.trim()) push("name", req.body.name.trim().slice(0, 200));
  if (req.body?.category !== undefined) push("category", DOC_TYPES.includes(req.body.category) ? req.body.category : null);
  if (req.body?.description !== undefined) push("description", req.body.description ? String(req.body.description).slice(0, 2000) : null);
  if (req.body?.folderId !== undefined && v.row.section === "general") push("folder_id", req.body.folderId == null ? null : Number(req.body.folderId));
  if (!sets.length) return res.status(400).json({ error: "Нічого змінювати" });
  push("updated_at", new Date());
  params.push(v.row.id);
  await pool.query(`UPDATE doc_files SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  res.json({ ok: true });
});

/** Прибрати з екрана = архів (стан). Файл лишається. Керівництво. */
documentsRouter.post("/file/:id/archive", management, async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  if (v.row.archived_at) return res.status(400).json({ error: "Уже в архіві" });
  await pool.query(`UPDATE doc_files SET archived_at = now(), archived_reason = 'manual', archived_by = $2, updated_at = now() WHERE id = $1`, [v.row.id, req.auth!.userId]);
  await logEvent(v.row.id, "archived", req.auth!.userId, { reason: "manual" });
  res.json({ ok: true });
});
documentsRouter.post("/file/:id/restore", management, async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  if (!v.row.archived_at) return res.status(400).json({ error: "Документ не в архіві" });
  await pool.query(`UPDATE doc_files SET archived_at = NULL, archived_reason = NULL, archived_by = NULL, updated_at = now() WHERE id = $1`, [v.row.id]);
  await logEvent(v.row.id, "restored", req.auth!.userId);
  res.json({ ok: true });
});
/** Видалення лишається для сумісності матриці, але фізично = архів (рішення 12.4). */
documentsRouter.delete("/file/:id", management, async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  await pool.query(`UPDATE doc_files SET archived_at = COALESCE(archived_at, now()), archived_reason = COALESCE(archived_reason, 'manual'), archived_by = $2 WHERE id = $1`, [v.row.id, req.auth!.userId]);
  await logEvent(v.row.id, "archived", req.auth!.userId, { reason: "manual", via: "delete" });
  res.json({ ok: true, archived: true });
});

/**
 * ПІДПИС. Способи: `paper_photo` (фото підписаного паперу, рішення Сергія 15.09) і `telegram_code`
 * (код у бот «UTS Підпис», рівень 2 ТЗ; два кроки — send/verify; правило коду в core/signCode.ts, #442).
 * `diia` — значення є, реалізація після підключення до Дії.
 */
documentsRouter.post("/file/:id/sign", async (req, res) => {
  const v = await visibleFile(req, res, Number(req.params.id)); if (!v) return;
  if (!canSignDocument(viewerOf(req), toDocLike(v.row))) return res.status(403).json({ error: "Підписує лише адресат документа" });
  if (!v.row.sha256) return res.status(400).json({ error: "У документа немає хеша — підпис не може привʼязатись до версії" });
  const method = String(req.body?.method ?? "");
  const userId = req.auth!.userId;
  const finish = async (evidence: string | null) => {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO doc_signatures (file_id, version, sha256, signed_by, method, evidence_stored_name, ip) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [v.row.id, v.row.version, v.row.sha256, userId, method, evidence, req.ip ?? null]);
    await logEvent(v.row.id, "signed", userId, { method, version: v.row.version, signatureId: r.rows[0].id });
    res.json({ ok: true, signatureId: r.rows[0].id });
  };
  if (method === "paper_photo") {
    const buffer = decodeBase64(req.body?.dataBase64);
    if (!buffer) return res.status(400).json({ error: "Додайте фото або скан підписаного документа" });
    if (buffer.length > 20 * 1024 * 1024) return res.status(413).json({ error: "Фото завелике (макс. 20 МБ)" });
    const { storedName } = await storeBuffer(String(req.body?.filename ?? "signature.jpg"), buffer);
    return finish(storedName);
  }
  if (method === "telegram_code") {
    if (!signBotConfigured()) return res.status(503).json({ error: "Бот підпису ще не налаштований на сервері", reason: "not_configured" });
    const u = await pool.query<{ telegram_chat_id: string | null }>(`SELECT telegram_chat_id FROM users WHERE id = $1`, [userId]);
    const chatId = u.rows[0]?.telegram_chat_id;
    if (!chatId) return res.status(409).json({ error: "Спершу привʼяжіть Telegram", reason: "not_linked" });
    const step = String(req.body?.step ?? "");
    if (step === "send") {
      const code = generateSignCode();
      await pool.query(`UPDATE sign_codes SET used_at = now() WHERE user_id = $1 AND purpose = 'sign' AND used_at IS NULL`, [userId]);
      await pool.query(
        `INSERT INTO sign_codes (user_id, purpose, code, file_id, sha256, version, expires_at) VALUES ($1, 'sign', $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)`,
        [userId, code, v.row.id, v.row.sha256, v.row.version, String(SIGN_CODE_TTL_MS)]);
      const ok = await signBotSend(chatId, signCodeMessage(code, v.row.name, v.row.version));
      if (!ok) return res.status(502).json({ error: "Не вдалося надіслати код у Telegram. Перевірте, що бот не заблокований" });
      return res.json({ sent: true, expiresInSec: SIGN_CODE_TTL_MS / 1000 });
    }
    if (step === "verify") {
      const c = await pool.query<{ id: number; code: string; file_id: number; sha256: string; version: number; attempts: number; expires_at: string; used_at: string | null }>(
        `SELECT id, code, file_id, sha256, version, attempts, expires_at, used_at FROM sign_codes
          WHERE user_id = $1 AND purpose = 'sign' ORDER BY created_at DESC LIMIT 1`, [userId]);
      const rec = c.rows[0];
      if (!rec) return res.status(400).json({ error: "Спершу надішліть код" });
      const out = verifySignCode({ code: rec.code, fileId: rec.file_id, sha256: rec.sha256, version: rec.version, attempts: rec.attempts, expiresAt: rec.expires_at, usedAt: rec.used_at },
        String(req.body?.code ?? ""), { fileId: v.row.id, sha256: v.row.sha256, version: v.row.version }, new Date());
      if (!out.ok) {
        if (out.reason === "mismatch") await pool.query(`UPDATE sign_codes SET attempts = attempts + 1 WHERE id = $1`, [rec.id]);
        const text = { expired: "Код прострочений — надішліть новий", used: "Цей код уже використано — надішліть новий", attempts: "Вичерпано 3 спроби — надішліть новий код",
          wrong_version: "Код надіслано на іншу версію документа — надішліть новий", mismatch: `Код не збігається${out.attemptsLeft > 0 ? `, лишилось спроб: ${out.attemptsLeft}` : " — надішліть новий"}` }[out.reason];
        return res.status(400).json({ error: text, reason: out.reason, attemptsLeft: out.attemptsLeft });
      }
      await pool.query(`UPDATE sign_codes SET used_at = now() WHERE id = $1`, [rec.id]);
      return finish(null);
    }
    return res.status(400).json({ error: "Крок має бути send або verify" });
  }
  return res.status(400).json({ error: "Доступні способи: фото паперового варіанта і код у Telegram; Дія — після підключення" });
});

/** ДОСТУПИ ПАПКИ: матриця ролей + персональні винятки. Читає й пише лише керівництво. */
documentsRouter.get("/access/:folderId", management, async (req, res) => {
  const folderId = Number(req.params.folderId);
  const [roles, rights, grants, log] = await Promise.all([
    pool.query<{ key: string; name: string }>(`SELECT key, name FROM roles ORDER BY (key = ANY($1::text[])) DESC, name`, [MANAGEMENT_ROLES]),
    pool.query<{ role_key: string; can_view: boolean; can_upload: boolean; can_edit: boolean; can_publish: boolean }>(`SELECT role_key, can_view, can_upload, can_edit, can_publish FROM doc_folder_access WHERE folder_id = $1`, [folderId]),
    pool.query<{ id: number; user_id: number; name: string; can_view: boolean; can_upload: boolean; expires_at: string | null }>(
      `SELECT g.id, g.user_id, ${OWNER_NAME_SQL} AS name, g.can_view, g.can_upload, g.expires_at FROM doc_access_grants g JOIN users u ON u.id = g.user_id LEFT JOIN managers m ON m.id = u.manager_id WHERE g.folder_id = $1 ORDER BY g.created_at`, [folderId]),
    pool.query(`SELECT l.action, l.details, l.at, COALESCE(m.name, u.full_name, u.email) AS actor FROM doc_access_log l LEFT JOIN users u ON u.id = l.actor_id LEFT JOIN managers m ON m.id = u.manager_id WHERE l.folder_id = $1 ORDER BY l.at DESC LIMIT 50`, [folderId]),
  ]);
  const by = new Map(rights.rows.map((r) => [r.role_key, r]));
  res.json({
    roles: roles.rows.map((r) => {
      const mgmt = MANAGEMENT_ROLES.includes(r.key); const x = by.get(r.key);
      return { key: r.key, name: r.name, management: mgmt,
        canView: mgmt || (x?.can_view ?? DEFAULT_RIGHTS.canView), canUpload: mgmt || (x?.can_upload ?? DEFAULT_RIGHTS.canUpload),
        canEdit: mgmt || (x?.can_edit ?? DEFAULT_RIGHTS.canEdit), canPublish: mgmt || (x?.can_publish ?? DEFAULT_RIGHTS.canPublish), canManage: mgmt };
    }),
    grants: grants.rows.map((g) => ({ id: g.id, userId: g.user_id, name: g.name, canView: g.can_view, canUpload: g.can_upload, expiresAt: g.expires_at })),
    log: log.rows,
  });
});
documentsRouter.put("/access/:folderId", management, async (req, res) => {
  const folderId = Number(req.params.folderId);
  const roles = Array.isArray(req.body?.roles) ? req.body.roles as { key: string; canView: boolean; canUpload: boolean; canEdit: boolean; canPublish: boolean }[] : [];
  const before = (await pool.query(`SELECT role_key, can_view, can_upload, can_edit, can_publish FROM doc_folder_access WHERE folder_id = $1`, [folderId])).rows;
  for (const r of roles) {
    if (MANAGEMENT_ROLES.includes(r.key)) continue; // керівництво не звужується через інтерфейс
    await pool.query(
      `INSERT INTO doc_folder_access (folder_id, role_key, can_view, can_upload, can_edit, can_publish, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (folder_id, role_key) DO UPDATE SET can_view = EXCLUDED.can_view, can_upload = EXCLUDED.can_upload,
         can_edit = EXCLUDED.can_edit, can_publish = EXCLUDED.can_publish, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [folderId, String(r.key), !!r.canView, !!r.canUpload, !!r.canEdit, !!r.canPublish, req.auth!.userId]);
  }
  const grants = Array.isArray(req.body?.grants) ? req.body.grants as { userId: number; canView?: boolean; canUpload?: boolean; expiresAt?: string | null }[] : null;
  if (grants) {
    await pool.query(`DELETE FROM doc_access_grants WHERE folder_id = $1`, [folderId]);
    for (const g of grants) {
      if (!Number.isFinite(Number(g.userId))) continue;
      await pool.query(`INSERT INTO doc_access_grants (folder_id, user_id, can_view, can_upload, expires_at, granted_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [folderId, Number(g.userId), g.canView !== false, !!g.canUpload, g.expiresAt || null, req.auth!.userId]);
    }
  }
  await logAccess(req.auth!.userId, "access_changed", { before, after: roles, grants }, folderId);
  res.json({ ok: true });
});
