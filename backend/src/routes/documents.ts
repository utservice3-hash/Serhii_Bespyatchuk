import { Router } from "express";
import { randomUUID } from "crypto";
import { writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { UPLOAD_DIR } from "./uploads.js";

/**
 * Регламенти та документи — файлова база відділу продажу (дерево папок + файли).
 * Читають усі автентифіковані; керує лише КВП (роль admin). Файли лежать у
 * `uploads/../documents` (персистить між деплоями — білд чіпає лише `dist`) і
 * віддаються авторизованим стрімом (не публічним static — регламенти внутрішні).
 *
 * 🔴 ПОПРАВКА 14.09.2026: ТУТ СТОЯЛО «потрапляє в нічний бекап» — І ЦЕ БУЛА НЕПРАВДА.
 * Заміряно: `jobs/backupDb.ts` бере ВСІ таблиці з `pg_tables` (90 із 90 у бекапі за
 * 14.09, `MANIFEST.txt` підтверджує), а файлових тек не бере ЖОДНА джоба й ЖОДЕН
 * крон — у теці бекапу нуль згадок `documents`, `uploads`, `tar`; у коді нуль
 * `tar`/`rsync`/`cpSync`. Тобто РЯДОК про файл бекапиться, а БАЙТИ — ні.
 * Рядок прожив тут як факт і встиг переїхати в чуже ТЗ — саме той клас, що
 * «неможливо за побудовою»: твердження пережило свою причину, бо ніхто не звіряв.
 * 🧾 Борг: бекапу файлових тек немає. Рішення (додати `tar` у джобу чи прийняти
 * ризик) — власника; поки його немає, втрата диска означає втрату регламентів.
 */
export const documentsRouter = Router();
documentsRouter.use(requireAuth);

// Поза `uploads/` — щоб публічний `/api/files` static НЕ віддавав регламенти
// за прямим URL в обхід авторизації. Тека `backend/documents` персистить між
// деплоями (білд чіпає лише dist).
const DOCS_DIR = path.join(UPLOAD_DIR, "..", "documents");
const MAX_BYTES = 50 * 1024 * 1024; // 50 МБ на файл
const onlyAdmin = requireRole("admin");

/**
 * Уся структура: пласкі списки папок і файлів (дерево будує фронт).
 *
 * 🔴 ЦЕЙ РОУТ ВІДДАВАВ 500, І ЕКРАН ПРИ ЦЬОМУ КАЗАВ «ПОРОЖНЬО».
 * Заміряно проти прода 14.09.2026: `column u.name does not exist`. У `users` немає
 * колонки `name` — є `full_name` (перелік колонок: id, email, password_hash, role,
 * manager_id, team_id, created_at, is_active, initial_password, last_seen,
 * role_override, deactivated_at, deactivated_reason, full_name, tracker_enabled,
 * news_seen_at). Сусідній роут задач увесь час стояв із `cu.full_name` — правильний
 * зразок лежав поруч, як `AS day` у випадку 06.08.
 *
 * ⚠️ Чому це не спіймав жоден гейт: SQL у шаблонному рядку не типізується, а
 * матриця доступу перевіряє КОД ВІДПОВІДІ на 403/не-403 — 500 для неї «пройдений
 * гейт». Тримає тепер `#400j`.
 */
documentsRouter.get("/tree", async (_req, res) => {
  const [folders, files] = await Promise.all([
    pool.query(
      `SELECT id, parent_id, name, created_at FROM doc_folders ORDER BY name`
    ),
    pool.query(
      // 👤 ІМʼЯ АВТОРА — КАНОНІЧНИЙ ТРИРІВНЕВИЙ ВИРАЗ (`core/absences.ts` → OWNER_NAME_SQL,
      // той самий у `routes/auth.ts`, `routes/tracker.ts`, `routes/settings.ts`).
      // 🔴 ДВОРІВНЕВИЙ ТУТ НЕ ПРАЦЮЄ, І ЦЕ ЗАМІРЯНО, А НЕ ЗДОГАД: `users.full_name` за
      // побудовою заповнюють лише РУЧНИМ акаунтам — CRM-менеджерам ПІБ живе в
      // `managers.name` (коментар до колонки в `schema.sql`). Замір прода 14.09.2026:
      // 58 акаунтів привʼязані до CRM, і в УСІХ 58 `full_name` порожній. Тобто в
      // колонці «автор» кожен такий завантажувач показувався б ПОШТОЮ.
      // ⚠️ Сьогодні це ще не видно: у базі 2 файли одного не-CRM автора. Стане видно
      // з першим же файлом, який заллє менеджер із CRM. Тримає #404.
      `SELECT f.id, f.folder_id, f.name, f.category, f.mime, f.size_bytes, f.created_at,
              COALESCE(m.name, u.full_name, u.email) AS author
         FROM doc_files f
         LEFT JOIN users u ON u.id = f.created_by
         LEFT JOIN managers m ON m.id = u.manager_id
        ORDER BY f.name`
    ),
  ]);
  res.json({ folders: folders.rows, files: files.rows });
});

/** Створити папку. */
documentsRouter.post("/folder", onlyAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const parentId = req.body?.parentId != null ? Number(req.body.parentId) : null;
  if (!name) return res.status(400).json({ error: "Назва папки обовʼязкова" });
  const r = await pool.query(
    `INSERT INTO doc_folders (parent_id, name, created_by) VALUES ($1, $2, $3)
     RETURNING id, parent_id, name, created_at`,
    [parentId, name, req.auth!.userId]
  );
  res.json(r.rows[0]);
});

/** Перейменувати папку. */
documentsRouter.patch("/folder/:id", onlyAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Назва папки обовʼязкова" });
  const r = await pool.query(
    `UPDATE doc_folders SET name = $1 WHERE id = $2 RETURNING id`,
    [name, Number(req.params.id)]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Папку не знайдено" });
  res.json({ ok: true });
});

/** Видалити папку (каскадом папки+файли; фізичні файли чистимо вручну). */
documentsRouter.delete("/folder/:id", onlyAdmin, async (req, res) => {
  const id = Number(req.params.id);
  // Зібрати stored_name усіх файлів усередині піддерева, щоб прибрати з диска.
  const stored = await pool.query<{ stored_name: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM doc_folders WHERE id = $1
       UNION ALL
       SELECT c.id FROM doc_folders c JOIN sub ON c.parent_id = sub.id
     )
     SELECT stored_name FROM doc_files WHERE folder_id IN (SELECT id FROM sub)`,
    [id]
  );
  await pool.query(`DELETE FROM doc_folders WHERE id = $1`, [id]);
  await Promise.all(
    stored.rows.map((r) => unlink(path.join(DOCS_DIR, r.stored_name)).catch(() => {}))
  );
  res.json({ ok: true });
});

/** Завантажити файл (base64) у папку (folderId=null → корінь). */
documentsRouter.post("/file", onlyAdmin, async (req, res) => {
  const { filename, dataBase64 } = req.body ?? {};
  const folderId = req.body?.folderId != null ? Number(req.body.folderId) : null;
  if (!dataBase64 || typeof dataBase64 !== "string") {
    return res.status(400).json({ error: "Файл відсутній" });
  }
  const base64 = dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({ error: "Файл завеликий (макс. 50 МБ)" });
  }
  const display = String(filename ?? "файл").trim() || "файл";
  const ext = path.extname(display).slice(0, 12).replace(/[^.\w]/g, "");
  const storedName = `${randomUUID()}${ext}`;
  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(path.join(DOCS_DIR, storedName), buffer);
  const category = req.body?.category ? String(req.body.category).trim().slice(0, 40) : null;
  const r = await pool.query(
    `INSERT INTO doc_files (folder_id, name, stored_name, category, mime, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, folder_id, name, category, mime, size_bytes, created_at`,
    [folderId, display, storedName, category, req.body?.mime ?? null, buffer.length, req.auth!.userId]
  );
  res.json(r.rows[0]);
});

/** Оновити файл: перейменувати та/або змінити категорію. */
documentsRouter.patch("/file/:id", onlyAdmin, async (req, res) => {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "Назва файла обовʼязкова" });
    params.push(name); sets.push(`name = $${params.length}`);
  }
  if (req.body?.category !== undefined) {
    const category = req.body.category ? String(req.body.category).trim().slice(0, 40) : null;
    params.push(category); sets.push(`category = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Нема що оновлювати" });
  params.push(Number(req.params.id));
  const r = await pool.query(
    `UPDATE doc_files SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (!r.rowCount) return res.status(404).json({ error: "Файл не знайдено" });
  res.json({ ok: true });
});

/** Видалити файл (+ з диска). */
documentsRouter.delete("/file/:id", onlyAdmin, async (req, res) => {
  const r = await pool.query<{ stored_name: string }>(
    `DELETE FROM doc_files WHERE id = $1 RETURNING stored_name`,
    [Number(req.params.id)]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Файл не знайдено" });
  await unlink(path.join(DOCS_DIR, r.rows[0].stored_name)).catch(() => {});
  res.json({ ok: true });
});

/** Завантаження/перегляд файла — авторизований стрім (усі ролі). */
documentsRouter.get("/file/:id/download", async (req, res) => {
  const r = await pool.query<{ name: string; stored_name: string; mime: string | null }>(
    `SELECT name, stored_name, mime FROM doc_files WHERE id = $1`,
    [Number(req.params.id)]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Файл не знайдено" });
  const f = r.rows[0];
  if (f.mime) res.type(f.mime);
  // inline — щоб pdf/зображення відкривались у браузері; imʼя для збереження.
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`
  );
  res.sendFile(path.join(DOCS_DIR, f.stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл відсутній на диску" });
  });
});
