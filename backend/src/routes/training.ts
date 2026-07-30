import { Router } from "express";
import { randomUUID } from "crypto";
import { writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { UPLOAD_DIR } from "./uploads.js";

/**
 * Навчання — навчальна база відділу продажу. Адмін (КВП) будує структуру папок
 * (навігація/розташування) і розміщує матеріали: відео (embed-URL YouTube/Vimeo/
 * пряме), завантажені файли, посилання, текст. Читають усі автентифіковані;
 * керує лише admin. Файли — у `uploads/../training` (персистить між деплоями,
 * потрапляє в нічний бекап), віддаються авторизованим стрімом.
 */
export const trainingRouter = Router();
trainingRouter.use(requireAuth);

const TRAIN_DIR = path.join(UPLOAD_DIR, "..", "training");
const MAX_BYTES = 45 * 1024 * 1024; // 45 МБ на файл (великі відео — через embed)
const onlyAdmin = requireRole("admin");
const KINDS = new Set(["video_embed", "file", "link", "text"]);

/** Уся структура: пласкі списки папок і матеріалів (дерево будує фронт). */
trainingRouter.get("/tree", async (req, res) => {
  const [folders, materials] = await Promise.all([
    pool.query(`SELECT id, parent_id, name, position, created_at FROM training_folders ORDER BY position, name`),
    pool.query(
      // 🔴 ЧЕРНЕТКИ (в т.ч. згенеровані АІ) бачить ЛИШЕ admin — решта отримує тільки
      // опубліковане. Публікація — окрема людська дія (POST /materials/:id/publish).
      `SELECT m.id, m.folder_id, m.title, m.kind, m.url, m.mime, m.size_bytes, m.content, m.position, m.created_at,
              m.status, m.created_by_ai,
              COALESCE(mm.name, u.email) AS author
         FROM training_materials m
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN managers mm ON mm.id = u.manager_id
        WHERE ($1::boolean OR m.status = 'published')
        ORDER BY m.position, m.created_at`,
      [req.auth!.role === "admin"]
    ),
  ]);
  res.json({ folders: folders.rows, materials: materials.rows });
});

/**
 * Опублікувати чернетку — ЛИШЕ людина (admin). АІ створює матеріал зі status='draft' і
 * опублікувати сам НЕ може: інструмент create_training_material інших статусів не приймає.
 */
trainingRouter.post("/materials/:id/publish", onlyAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query<{ title: string }>(
    `UPDATE training_materials SET status = 'published' WHERE id = $1 AND status = 'draft' RETURNING title`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Чернетку не знайдено (або вже опублікована)" });
  res.json({ ok: true, title: r.rows[0].title });
});

/** Створити папку. */
trainingRouter.post("/folder", onlyAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const parentId = req.body?.parentId != null ? Number(req.body.parentId) : null;
  if (!name) return res.status(400).json({ error: "Назва папки обовʼязкова" });
  const pos = await pool.query<{ n: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM training_folders WHERE parent_id IS NOT DISTINCT FROM $1`,
    [parentId]
  );
  const r = await pool.query(
    `INSERT INTO training_folders (parent_id, name, position, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, parent_id, name, position, created_at`,
    [parentId, name, pos.rows[0].n, req.auth!.userId]
  );
  res.json(r.rows[0]);
});

/** Перейменувати / перемістити папку (name та/або parentId, position). */
trainingRouter.patch("/folder/:id", onlyAdmin, async (req, res) => {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "Назва папки обовʼязкова" });
    params.push(name); sets.push(`name = $${params.length}`);
  }
  if (req.body?.parentId !== undefined) {
    const parentId = req.body.parentId != null ? Number(req.body.parentId) : null;
    if (parentId === Number(req.params.id)) return res.status(400).json({ error: "Папка не може бути власним батьком" });
    params.push(parentId); sets.push(`parent_id = $${params.length}`);
  }
  if (req.body?.position !== undefined) { params.push(Number(req.body.position)); sets.push(`position = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Нема що оновлювати" });
  params.push(Number(req.params.id));
  const r = await pool.query(`UPDATE training_folders SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`, params);
  if (!r.rowCount) return res.status(404).json({ error: "Папку не знайдено" });
  res.json({ ok: true });
});

/** Видалити папку (каскадом підпапки+матеріали; фізичні файли чистимо вручну). */
trainingRouter.delete("/folder/:id", onlyAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const stored = await pool.query<{ stored_name: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM training_folders WHERE id = $1
       UNION ALL
       SELECT c.id FROM training_folders c JOIN sub ON c.parent_id = sub.id
     )
     SELECT stored_name FROM training_materials WHERE folder_id IN (SELECT id FROM sub) AND stored_name IS NOT NULL`,
    [id]
  );
  await pool.query(`DELETE FROM training_folders WHERE id = $1`, [id]);
  await Promise.all(stored.rows.map((r) => unlink(path.join(TRAIN_DIR, r.stored_name)).catch(() => {})));
  res.json({ ok: true });
});

/**
 * Додати матеріал. kind:
 *  • video_embed — url (YouTube/Vimeo/пряме відео);
 *  • link — url;
 *  • text — content;
 *  • file — dataBase64 (+filename/mime) → зберігається на диск.
 */
trainingRouter.post("/material", onlyAdmin, async (req, res) => {
  const b = req.body ?? {};
  const title = String(b.title ?? "").trim();
  const kind = String(b.kind ?? "");
  const folderId = b.folderId != null ? Number(b.folderId) : null;
  if (!title) return res.status(400).json({ error: "Назва матеріалу обовʼязкова" });
  if (!KINDS.has(kind)) return res.status(400).json({ error: "Невідомий тип матеріалу" });

  let url: string | null = null, storedName: string | null = null, mime: string | null = null;
  let sizeBytes: number | null = null, content: string | null = null;

  if (kind === "video_embed" || kind === "link") {
    url = String(b.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Вкажіть коректне посилання (http/https)" });
  } else if (kind === "text") {
    content = String(b.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "Текст матеріалу обовʼязковий" });
  } else if (kind === "file") {
    const dataBase64 = b.dataBase64;
    if (!dataBase64 || typeof dataBase64 !== "string") return res.status(400).json({ error: "Файл відсутній" });
    const base64 = dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64;
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length > MAX_BYTES) return res.status(413).json({ error: "Файл завеликий (макс. 45 МБ; для великих відео — embed-посилання)" });
    const display = String(b.filename ?? title).trim() || "файл";
    const ext = path.extname(display).slice(0, 12).replace(/[^.\w]/g, "");
    storedName = `${randomUUID()}${ext}`;
    await mkdir(TRAIN_DIR, { recursive: true });
    await writeFile(path.join(TRAIN_DIR, storedName), buffer);
    mime = b.mime ? String(b.mime) : null;
    sizeBytes = buffer.length;
  }
  content = content ?? (b.content ? String(b.content).trim() : null); // опис для не-текстових

  const pos = await pool.query<{ n: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM training_materials WHERE folder_id IS NOT DISTINCT FROM $1`,
    [folderId]
  );
  const r = await pool.query(
    `INSERT INTO training_materials (folder_id, title, kind, url, stored_name, mime, size_bytes, content, position, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, folder_id, title, kind, url, mime, size_bytes, content, position, created_at`,
    [folderId, title, kind, url, storedName, mime, sizeBytes, content, pos.rows[0].n, req.auth!.userId]
  );
  res.json(r.rows[0]);
});

/** Оновити матеріал: назва / опис / посилання / папка / позиція. */
trainingRouter.patch("/material/:id", onlyAdmin, async (req, res) => {
  const b = req.body ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  if (b.title !== undefined) {
    const title = String(b.title).trim();
    if (!title) return res.status(400).json({ error: "Назва обовʼязкова" });
    params.push(title); sets.push(`title = $${params.length}`);
  }
  if (b.content !== undefined) { params.push(b.content ? String(b.content) : null); sets.push(`content = $${params.length}`); }
  if (b.url !== undefined) { params.push(b.url ? String(b.url) : null); sets.push(`url = $${params.length}`); }
  if (b.folderId !== undefined) { params.push(b.folderId != null ? Number(b.folderId) : null); sets.push(`folder_id = $${params.length}`); }
  if (b.position !== undefined) { params.push(Number(b.position)); sets.push(`position = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Нема що оновлювати" });
  params.push(Number(req.params.id));
  const r = await pool.query(`UPDATE training_materials SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`, params);
  if (!r.rowCount) return res.status(404).json({ error: "Матеріал не знайдено" });
  res.json({ ok: true });
});

/** Видалити матеріал (+ файл з диска, якщо був). */
trainingRouter.delete("/material/:id", onlyAdmin, async (req, res) => {
  const r = await pool.query<{ stored_name: string | null }>(
    `DELETE FROM training_materials WHERE id = $1 RETURNING stored_name`,
    [Number(req.params.id)]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Матеріал не знайдено" });
  if (r.rows[0].stored_name) await unlink(path.join(TRAIN_DIR, r.rows[0].stored_name)).catch(() => {});
  res.json({ ok: true });
});

/** Стрім завантаженого файлу/відео — авторизований (усі ролі). */
trainingRouter.get("/material/:id/file", async (req, res) => {
  const r = await pool.query<{ title: string; stored_name: string | null; mime: string | null }>(
    `SELECT title, stored_name, mime FROM training_materials WHERE id = $1`,
    [Number(req.params.id)]
  );
  if (!r.rowCount || !r.rows[0].stored_name) return res.status(404).json({ error: "Файл не знайдено" });
  const m = r.rows[0];
  if (m.mime) res.type(m.mime);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(m.title)}`);
  res.sendFile(path.join(TRAIN_DIR, m.stored_name!), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл відсутній на диску" });
  });
});
