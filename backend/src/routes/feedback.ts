import { Router } from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { UPLOAD_DIR } from "./uploads.js";
import {
  FEEDBACK_CLOSED_STATUSES, FEEDBACK_FILE_MAX_BYTES, FEEDBACK_FILES_PER_ITEM, FEEDBACK_RETENTION_DAYS, imageKind,
} from "../core/feedbackRetention.js";
import {
  FEEDBACK_COMMENT_MAX, FEEDBACK_FORM, composeMessage, validateFeedback, type FeedbackComment,
} from "../core/feedbackForm.js";
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
         f.kind, f.impact, f.fields_json AS "fields", f.context_json AS "context",
         f.comments_json AS "comments", f.confirmed_at AS "confirmedAt",
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
  // `form` — опис полів форми. Фронт малює з нього, сервер ним же перевіряє (`core/feedbackForm.ts`).
  res.json({ feedback: r.rows, form: FEEDBACK_FORM });
});

/** Імʼя для переписки: як у списку — менеджер, а якщо акаунт без менеджера, то пошта. */
async function nameOf(userId: number): Promise<string> {
  const r = await pool.query<{ name: string }>(
    `SELECT COALESCE(m.name, u.email) AS name FROM users u LEFT JOIN managers m ON m.id = u.manager_id WHERE u.id = $1`,
    [userId]);
  return r.rows[0]?.name ?? `Користувач #${userId}`;
}

/** Дописати коментар у переписку звернення (масив у рядку — живе й видаляється разом зі зверненням). */
function commentSql(param: number): string {
  return `comments_json = comments_json || jsonb_build_array($${param}::jsonb)`;
}

function comment(c: Omit<FeedbackComment, "at">): string {
  const out: FeedbackComment = {
    at: new Date().toISOString(), byUserId: c.byUserId, byName: c.byName, role: c.role, kind: c.kind, body: c.body,
  };
  return JSON.stringify(out);
}

/**
 * Нове звернення — будь-кому з вкладкою. Лише за формою: тип + обовʼязкові поля типу (серед них
 * ПРИКЛАД) + «наскільки заважає», де його питають. Вільний текст без типу більше не приймаємо —
 * саме такі звернення й були незрозумілі. Відмова називає СЛОВАМИ, чого не вистачає.
 */
feedbackRouter.post("/", async (req, res) => {
  const auth = req.auth!;
  const v = validateFeedback(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error, missing: v.missing });
  const ctxRaw = (req.body?.context && typeof req.body.context === "object" ? req.body.context : {}) as Record<string, unknown>;
  // Контекст — лише відомі ключі й короткі рядки: це підпис для того, хто розбирає, а не сховище.
  const context: Record<string, string> = {};
  for (const k of ["fromSection", "build", "role", "path"]) {
    if (typeof ctxRaw[k] === "string" && ctxRaw[k]) context[k] = (ctxRaw[k] as string).slice(0, 120);
  }
  const d = v.draft;
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO feedback (author_user_id, section, message, kind, impact, fields_json, context_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [auth.userId, d.section, composeMessage(d), d.kind, d.impact, JSON.stringify(d.fields), JSON.stringify(context)]
  );
  const r = await pool.query(`${SELECT} WHERE f.id = $1`, [ins.rows[0].id]);
  res.status(201).json({ feedback: r.rows[0] });
});

/**
 * Рішення того, хто розбирає: прийняти, відхилити, «потрібні деталі», вирішено, повернути.
 * «Потрібні деталі» і «відхилено» — лише з текстом: питання автору / причина. Без нього людина
 * бачить лише плашку й не знає, що робити далі (рівно та біда, з якою це все починалось).
 * Текст іде і в `admin_note` (як раніше), і в переписку — щоб автор бачив розмову цілком.
 */
feedbackRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status ?? "");
  const adminNote = req.body?.adminNote != null ? String(req.body.adminNote).trim().slice(0, FEEDBACK_COMMENT_MAX) : null;
  if (!["pending", "needs_info", "approved", "rejected", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Невірний статус" });
  }
  if ((status === "needs_info" || status === "rejected") && !adminNote) {
    return res.status(400).json({ error: status === "needs_info" ? "Напишіть, яких деталей не вистачає" : "Напишіть причину відхилення" });
  }
  const note = adminNote && (status === "needs_info" || status === "rejected" || req.body?.comment === true)
    ? comment({ byUserId: req.auth!.userId, byName: await nameOf(req.auth!.userId), role: "admin",
        kind: status === "needs_info" ? "question" : status === "rejected" ? "reject" : "note", body: adminNote })
    : null;
  const upd = await pool.query(
    // 🕰 `closed_at` — старт лічильника видалення: ставиться при першому переході в закритий
    // стан (resolved↔rejected його не скидає) і знімається при поверненні на розгляд. Тримає #495.
    // `confirmed_at` скидається при будь-якій зміні статусу: підтвердження стосується того рішення.
    `UPDATE feedback SET status = $1, admin_note = COALESCE($2, admin_note), updated_at = now(),
            closed_at = CASE WHEN $1 = ANY($4::text[]) THEN COALESCE(closed_at, now()) ELSE NULL END,
            confirmed_at = CASE WHEN status = $1 THEN confirmed_at ELSE NULL END,
            comments_json = CASE WHEN $5::jsonb IS NULL THEN comments_json ELSE comments_json || jsonb_build_array($5::jsonb) END
     WHERE id = $3 RETURNING id`,
    [status, adminNote, id, FEEDBACK_CLOSED_STATUSES, note]
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

/**
 * Коментар у переписці — автор або адмін-рівень (чуже → 404, як фото).
 * Відповідь АВТОРА на «потрібні деталі» повертає звернення на розгляд: інакше воно чекало б,
 * доки той, хто розбирає, сам випадково помітить відповідь.
 */
feedbackRouter.post("/:id/comments", async (req, res) => {
  const item = await visibleItem(req);
  if (!item) return res.status(404).json({ error: "Звернення не знайдено" });
  const body = String(req.body?.body ?? "").trim().slice(0, FEEDBACK_COMMENT_MAX);
  if (!body) return res.status(400).json({ error: "Порожній коментар" });
  const auth = req.auth!;
  const isAuthor = item.authorUserId === auth.userId;
  const c = comment({ byUserId: auth.userId, byName: await nameOf(auth.userId), role: isAuthor ? "author" : "admin",
    kind: isAuthor ? "reply" : "note", body });
  await pool.query(
    `UPDATE feedback SET ${commentSql(2)}, updated_at = now(),
            status = CASE WHEN $3 AND status = 'needs_info' THEN 'pending' ELSE status END
      WHERE id = $1`,
    [item.id, c, isAuthor]);
  const r = await pool.query(`${SELECT} WHERE f.id = $1`, [item.id]);
  res.status(201).json({ feedback: r.rows[0] });
});

/**
 * Автор перевіряє вирішене: «працює» → `confirmed_at`; «досі не працює» → назад на розгляд
 * з поясненням у переписці (і лічильник видалення знімається — звернення знову відкрите).
 * Лише автор і лише на «вирішено»: підтвердити чужу роботу за автора нема кому.
 */
feedbackRouter.post("/:id/confirm", async (req, res) => {
  const item = await visibleItem(req);
  if (!item) return res.status(404).json({ error: "Звернення не знайдено" });
  const auth = req.auth!;
  if (item.authorUserId !== auth.userId) return res.status(403).json({ error: "Підтверджує автор звернення" });
  const st = await pool.query<{ status: string }>(`SELECT status FROM feedback WHERE id = $1`, [item.id]);
  if (st.rows[0]?.status !== "resolved") return res.status(409).json({ error: "Підтвердити можна лише вирішене звернення" });
  if (req.body?.ok === true) {
    await pool.query(`UPDATE feedback SET confirmed_at = now(), updated_at = now() WHERE id = $1`, [item.id]);
  } else {
    const body = String(req.body?.body ?? "").trim().slice(0, FEEDBACK_COMMENT_MAX);
    if (!body) return res.status(400).json({ error: "Напишіть, що саме досі не працює — на якому прикладі" });
    const c = comment({ byUserId: auth.userId, byName: await nameOf(auth.userId), role: "author", kind: "reopen", body });
    await pool.query(
      `UPDATE feedback SET status = 'pending', closed_at = NULL, confirmed_at = NULL, updated_at = now(), ${commentSql(2)}
        WHERE id = $1`, [item.id, c]);
  }
  const r = await pool.query(`${SELECT} WHERE f.id = $1`, [item.id]);
  res.json({ feedback: r.rows[0] });
});

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
