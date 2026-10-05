import { Router } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { UPLOAD_DIR } from "./uploads.js";
import {
  FEEDBACK_CLOSED_STATUSES, FEEDBACK_FILE_MAX_BYTES, FEEDBACK_FILES_PER_ITEM, FEEDBACK_RETENTION_DAYS, imageKind,
} from "../core/feedbackRetention.js";
import { isAdminScope, isAdminOrLead } from "../auth/rbac.js";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";

export const feedbackRouter = Router();
feedbackRouter.use(requireAuth);

/**
 * 📎 ТЕКА ФОТО — ПОЗА публічним `uploads/` (той віддається за прямим URL без токена),
 * як і вкладення задач. Звідси ж байти прибирає джоба `purgeFeedback`.
 */
export const FEEDBACK_FILES_DIR = process.env.FEEDBACK_FILES_DIR ?? path.join(UPLOAD_DIR, "..", "feedback-files");

function pathId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const SELECT = `
  SELECT f.id, f.section, f.message, f.status, f.admin_note AS "adminNote",
         f.created_at AS "createdAt", f.updated_at AS "updatedAt",
         f.author_user_id AS "authorUserId",
         COALESCE(m.name, u.email) AS "authorName",
         f.closed_at AS "closedAt",
         f.closed_at + interval '${FEEDBACK_RETENTION_DAYS} days' AS "purgeAt",
         COALESCE((SELECT json_agg(json_build_object('id', ff.id, 'name', ff.name, 'mime', ff.mime,
                                    'sizeBytes', ff.size_bytes, 'createdById', ff.created_by) ORDER BY ff.created_at)
                     FROM feedback_files ff WHERE ff.feedback_id = f.id), '[]'::json) AS "files"
  FROM feedback f
  JOIN users u ON u.id = f.author_user_id
  LEFT JOIN managers m ON m.id = u.manager_id`;

/** List feedback: admin sees everything, everyone else only their own items. */
feedbackRouter.get("/", async (req, res) => {
  const auth = req.auth!;
  const params: unknown[] = [];
  let where = "";
  if (!isAdminScope(auth)) {
    params.push(auth.userId);
    where = `WHERE f.author_user_id = $1`;
  }
  const r = await pool.query(`${SELECT} ${where} ORDER BY f.created_at DESC`, params);
  res.json({ feedback: r.rows });
});

/** Submit a new feedback / bug report — available to every authenticated user. */
feedbackRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  const message = String(req.body?.message ?? "").trim();
  const section = req.body?.section ? String(req.body.section).slice(0, 60) : null;
  if (!message) return res.status(400).json({ error: "Опишіть проблему або пропозицію" });
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO feedback (author_user_id, section, message) VALUES ($1, $2, $3) RETURNING id`,
    [auth.userId, section, message.slice(0, 4000)]
  );
  const r = await pool.query(`${SELECT} WHERE f.id = $1`, [ins.rows[0].id]);
  res.status(201).json({ feedback: r.rows[0] });
});

/** Admin decision / status update: approve, reject, or mark resolved. */
feedbackRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status ?? "");
  const adminNote = req.body?.adminNote != null ? String(req.body.adminNote).slice(0, 2000) : null;
  if (!["pending", "approved", "rejected", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Невірний статус" });
  }
  const upd = await pool.query(
    // 🕰 `closed_at` — старт лічильника видалення: ставиться при першому переході в закритий
    // стан (resolved↔rejected його не скидає) і знімається при поверненні на розгляд. Тримає #495.
    `UPDATE feedback SET status = $1, admin_note = COALESCE($2, admin_note), updated_at = now(),
            closed_at = CASE WHEN $1 = ANY($4::text[]) THEN COALESCE(closed_at, now()) ELSE NULL END
     WHERE id = $3 RETURNING id`,
    [status, adminNote, id, FEEDBACK_CLOSED_STATUSES]
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: "Не знайдено" });
  const r = await pool.query(`${SELECT} WHERE f.id = $1`, [id]);
  res.json({ feedback: r.rows[0] });
});

/**
 * Звернення, яке бачить цей користувач: адмін-рівень — будь-яке, решта — лише своє.
 * Та сама межа, що в `GET /`; чуже віддаємо як 404, а не 403, щоб не підтверджувати існування.
 */
async function visibleItem(req: import("express").Request): Promise<{ id: number; authorUserId: number } | null> {
  const id = pathId(String(req.params.id));
  if (id == null) return null;
  const r = await pool.query<{ id: number; author_user_id: number }>(`SELECT id, author_user_id FROM feedback WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return null;
  if (!isAdminScope(req.auth!) && row.author_user_id !== req.auth!.userId) return null;
  return { id: row.id, authorUserId: row.author_user_id };
}

/** Фото до звернення — base64 у тілі, як вкладення задач. Лише картинки, тип — за байтами. */
feedbackRouter.post("/:id/files", async (req, res) => {
  const item = await visibleItem(req);
  if (!item) return res.status(404).json({ error: "Звернення не знайдено" });
  const { filename, dataBase64 } = req.body ?? {};
  if (!dataBase64 || typeof dataBase64 !== "string") return res.status(400).json({ error: "Файл відсутній" });
  const cnt = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM feedback_files WHERE feedback_id = $1`, [item.id]);
  if (cnt.rows[0].n >= FEEDBACK_FILES_PER_ITEM) {
    return res.status(409).json({ error: `Не більше ${FEEDBACK_FILES_PER_ITEM} фото на звернення` });
  }
  const buffer = Buffer.from(dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64, "base64");
  if (!buffer.length) return res.status(400).json({ error: "Файл порожній" });
  if (buffer.length > FEEDBACK_FILE_MAX_BYTES) return res.status(413).json({ error: "Фото завелике (макс. 5 МБ)" });
  const mime = imageKind(buffer);
  if (!mime) return res.status(400).json({ error: "Можна лише фото: JPG, PNG або WEBP" });
  const display = String(filename ?? "фото").trim().slice(0, 200) || "фото";
  const storedName = `${randomUUID()}.${mime.split("/")[1]}`;
  await mkdir(FEEDBACK_FILES_DIR, { recursive: true });
  await writeFile(path.join(FEEDBACK_FILES_DIR, storedName), buffer);
  const r = await pool.query(
    `INSERT INTO feedback_files (feedback_id, name, stored_name, mime, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, mime, size_bytes AS "sizeBytes", created_by AS "createdById"`,
    [item.id, display, storedName, mime, buffer.length, req.auth!.userId]
  );
  res.status(201).json(r.rows[0]);
});

/** Віддача фото — лише тому, хто бачить звернення. Немає байтів — це кажемо, а не віддаємо порожнє. */
feedbackRouter.get("/:id/files/:fileId", async (req, res) => {
  const item = await visibleItem(req);
  if (!item) return res.status(404).json({ error: "Звернення не знайдено" });
  const fid = pathId(String(req.params.fileId));
  if (fid == null) return res.status(400).json({ error: "Некоректний ідентифікатор файла" });
  const r = await pool.query<{ name: string; stored_name: string; mime: string }>(
    `SELECT name, stored_name, mime FROM feedback_files WHERE id = $1 AND feedback_id = $2`, [fid, item.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Фото не знайдено" });
  const f = r.rows[0];
  res.type(f.mime);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.sendFile(path.join(FEEDBACK_FILES_DIR, f.stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл відсутній на диску" });
  });
});

/** Прибрати фото — той, хто поклав, або адмін-рівень. Одразу з диска: це не архів, а помилкове фото. */
feedbackRouter.delete("/:id/files/:fileId", async (req, res) => {
  const item = await visibleItem(req);
  if (!item) return res.status(404).json({ error: "Звернення не знайдено" });
  const fid = pathId(String(req.params.fileId));
  if (fid == null) return res.status(400).json({ error: "Некоректний ідентифікатор файла" });
  const own = await pool.query<{ created_by: number | null; stored_name: string }>(
    `SELECT created_by, stored_name FROM feedback_files WHERE id = $1 AND feedback_id = $2`, [fid, item.id]);
  if (!own.rowCount) return res.status(404).json({ error: "Фото не знайдено" });
  if (own.rows[0].created_by !== req.auth!.userId && !isAdminScope(req.auth!)) {
    return res.status(403).json({ error: "Прибрати фото може той, хто його додав" });
  }
  await pool.query(`DELETE FROM feedback_files WHERE id = $1`, [fid]);
  await unlink(path.join(FEEDBACK_FILES_DIR, own.rows[0].stored_name)).catch(() => {});
  res.status(204).send();
});
