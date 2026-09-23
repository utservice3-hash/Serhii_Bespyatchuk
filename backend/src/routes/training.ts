import { Router } from "express";
import { isAdminScope, isAdminOrLead } from "../auth/rbac.js";
import { randomUUID } from "crypto";
import { writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { UPLOAD_DIR } from "./uploads.js";
import { orderedMaterials, materialStates, coursePercent } from "../core/trainingProgress.js";
import { stepLockedBy, type LockDb } from "../core/trainingLock.js";
import { attachVerdict, requiredValue, moduleStats, courseModules, freeModules, type EditorFolder } from "../core/trainingEditor.js";
import { roleHasPerm } from "../auth/rbac.js";
import { effectiveMime, mimeFromName } from "../core/trainingMime.js";
import { checkUpload, MAX_UPLOAD_BYTES, ACCEPT_ATTR } from "../core/trainingUpload.js";

/**
 * Навчання — навчальна база відділу продажу. Адмін (КВП) будує структуру папок
 * (навігація/розташування) і розміщує матеріали: відео (embed-URL YouTube/Vimeo/
 * пряме), завантажені файли, посилання, текст. Читають усі автентифіковані;
 * керує лише admin. Файли — у `uploads/../training` (персистить між деплоями),
 * віддаються авторизованим стрімом.
 *
 * ⚠️ ТУТ СТОЯЛО «потрапляє в нічний бекап» — ЗАМІРЯНО 23.09.2026, ЦЕ НЕПРАВДА.
 * `jobs/backupDb.ts` копіює лише `DOCS_DIR` (backend/documents, 34 МБ). Тека
 * `backend/training` — **817 МБ, 143 файли** — у копію НЕ їде, як і `task-files/`,
 * `contact-files/`, `uploads/`. Рядок пережив свою причину; борг названо власнику
 * 23.09.2026 окремим рішенням. Не спирайся на нього при відновленні.
 */
export const trainingRouter = Router();
trainingRouter.use(requireAuth);

const TRAIN_DIR = path.join(UPLOAD_DIR, "..", "training");
// 📎 Стеля й білий список — у `core/trainingUpload.ts`, одним числом на сервер і фронт (#712).
/**
 * ✍️ ХТО РЕДАГУЄ НАВЧАННЯ — ПРАВО, А НЕ РОЛЬ (ТЗ 14.09.2026).
 *
 * 🔴 ЩО ТУТ БУЛО НАСПРАВДІ. Змінна звалась «лише адмін» — а це НЕПРАВДА: `requireRole`
 * порівнює scope-compat роль, і `scopeCompatRole` піднімає до "admin" будь-кого з правом
 * `admin_scope`. Заміряно на проді 14.09: редагувати могли ШІСТЬ ролей — admin, ceo,
 * opdir, kvp, financier і «Бухгалтерія». Назва брехала про власну межу, і саме тому межу
 * винесено в іменоване право, яке видно в Налаштуваннях.
 *
 * Склад — рішення власника 14.09.2026 дослівно: «admin, ceo, opdir, kvp». Тобто фінансист
 * і бухгалтерія редагування втрачають СВІДОМО; видача й зняття — явними рядками в
 * `schema.sql`, а не наслідком місця вставки.
 *
 * ⚠️ Зліпок цього не спіймає: пʼять із семи роутів запису мають клас `deny-only`, тож
 * `#11` дозволені ролі на них не пробує. Доказ звуження — жива проба в прийманні.
 */
const canEditTraining = requirePerm("manage_training");
const KINDS = new Set(["video_embed", "file", "link", "text"]);

/** Уся структура: пласкі списки папок і матеріалів (дерево будує фронт). */
trainingRouter.get("/tree", async (req, res) => {
  const [folders, materials] = await Promise.all([
    pool.query(`SELECT id, parent_id, name, position, created_at, course_id FROM training_folders ORDER BY position, name`),
    pool.query(
      // 🔴 ЧЕРНЕТКИ (в т.ч. згенеровані АІ) бачить ЛИШЕ admin — решта отримує тільки
      // опубліковане. Публікація — окрема людська дія (POST /materials/:id/publish).
      `SELECT m.id, m.folder_id, m.title, m.kind, m.url, m.mime, m.stored_name, m.size_bytes, m.content, m.position, m.created_at,
              m.status, m.created_by_ai, m.required,
              COALESCE(mm.name, u.email) AS author
         FROM training_materials m
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN managers mm ON mm.id = u.manager_id
        WHERE ($1::boolean OR m.status = 'published')
        ORDER BY m.position, m.created_at`,
      [isAdminScope(req.auth!)]
    ),
  ]);
  /* 📄 Тип файла — через ядро: у 84 перенесених документів колонка порожня (core/trainingMime.ts).
     🔴 ПОЛЯ ПЕРЕЛІЧЕНО ЯВНО, а не спредом рядка. Спред спіймав `#17e2`, і спіймав по ділу:
     `stored_name` довелось додати в SELECT заради виведення типу, і разом зі спредом він поїхав
     би клієнту — тобто внутрішнє імʼя файла на диску стало б видимим у відповіді. */
  const withMime = materials.rows.map((m) => ({
    id: m.id, folder_id: m.folder_id, title: m.title, kind: m.kind, url: m.url,
    mime: effectiveMime(m.mime, m.stored_name, m.title),
    size_bytes: m.size_bytes, content: m.content, position: m.position, created_at: m.created_at,
    status: m.status, created_by_ai: m.created_by_ai, required: m.required, author: m.author,
  }));
  /* 📎 Межа й перелік типів їдуть із сервера, щоб у фронта НЕ БУЛО власної копії числа:
     розійшлися б вони мовчки, і людина дізнавалась би про межу з 413 після хвилини
     завантаження. Одне джерело — `core/trainingUpload.ts`, тримає `#712`. */
  const upload = { maxBytes: MAX_UPLOAD_BYTES, accept: ACCEPT_ATTR };
  res.json({ folders: folders.rows, materials: withMime, upload });
});

/**
 * Опублікувати чернетку — ЛИШЕ людина (admin). АІ створює матеріал зі status='draft' і
 * опублікувати сам НЕ може: інструмент create_training_material інших статусів не приймає.
 */
trainingRouter.post("/materials/:id/publish", canEditTraining, async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query<{ title: string }>(
    `UPDATE training_materials SET status = 'published' WHERE id = $1 AND status = 'draft' RETURNING title`, [id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Чернетку не знайдено (або вже опублікована)" });
  res.json({ ok: true, title: r.rows[0].title });
});

/** Створити папку. */
trainingRouter.post("/folder", canEditTraining, async (req, res) => {
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
trainingRouter.patch("/folder/:id", canEditTraining, async (req, res) => {
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
  /* 🧩 Модуль курсу (редактор навчання, 17.09.2026). `courseId: null` — прибрати з курсу
     (матеріали лишаються в папці); число — зробити модулем. Правило — `core/trainingEditor.ts`. */
  if (req.body?.courseId !== undefined) {
    const courseId = req.body.courseId != null ? Number(req.body.courseId) : null;
    if (courseId !== null && !Number.isInteger(courseId)) return res.status(400).json({ error: "Некоректний курс" });
    const cur = await pool.query<{ id: number; parent_id: number | null; course_id: number | null; name: string; position: number; cur_name: string | null }>(
      `SELECT f.id, f.parent_id, f.course_id, f.name, f.position, c.title AS cur_name
         FROM training_folders f LEFT JOIN training_courses c ON c.id = f.course_id WHERE f.id = $1`,
      [Number(req.params.id)]);
    const row = cur.rows[0];
    const exists = courseId === null ? true
      : ((await pool.query(`SELECT 1 FROM training_courses WHERE id = $1`, [courseId])).rowCount ?? 0) > 0;
    const v = attachVerdict({
      folder: row ? { id: row.id, parentId: row.parent_id, courseId: row.course_id, name: row.name, position: row.position } : null,
      courseId, courseExists: exists, force: req.body?.force === true, currentCourseName: row?.cur_name ?? null,
    });
    if (!v.ok) return res.status(v.status).json({ error: v.reason });
    params.push(courseId); sets.push(`course_id = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Нема що оновлювати" });
  params.push(Number(req.params.id));
  const r = await pool.query(`UPDATE training_folders SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`, params);
  if (!r.rowCount) return res.status(404).json({ error: "Папку не знайдено" });
  res.json({ ok: true });
});

/** Видалити папку (каскадом підпапки+матеріали; фізичні файли чистимо вручну). */
trainingRouter.delete("/folder/:id", canEditTraining, async (req, res) => {
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
trainingRouter.post("/material", canEditTraining, async (req, res) => {
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
    const display = String(b.filename ?? title).trim() || "файл";
    /* 📎 Тип і розмір — ОДНІЄЮ перевіркою ядра, ДО запису на диск. Тип виводимо з імені, коли
       браузер промовчав: інакше «невідомий» і «заборонений» злились би в одну відмову. */
    const verdict = checkUpload(b.mime ? String(b.mime) : mimeFromName(display), buffer.length);
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.reason });
    const ext = path.extname(display).slice(0, 12).replace(/[^.\w]/g, "");
    storedName = `${randomUUID()}${ext}`;
    await mkdir(TRAIN_DIR, { recursive: true });
    await writeFile(path.join(TRAIN_DIR, storedName), buffer);
    mime = verdict.mime;
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
trainingRouter.patch("/material/:id", canEditTraining, async (req, res) => {
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
  /* 🧩 «Обовʼязковий крок» (редактор навчання). Необовʼязковий не тримає замок і не входить
     у знаменник відсотка — правило одне, у `core/trainingProgress.ts`. */
  if (b.required !== undefined) {
    const req_ = requiredValue(b.required);
    if (req_ === null) return res.status(400).json({ error: "required: true або false" });
    params.push(req_); sets.push(`required = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Нема що оновлювати" });
  params.push(Number(req.params.id));
  const r = await pool.query(`UPDATE training_materials SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`, params);
  if (!r.rowCount) return res.status(404).json({ error: "Матеріал не знайдено" });
  res.json({ ok: true });
});

/** Видалити матеріал (+ файл з диска, якщо був). */
trainingRouter.delete("/material/:id", canEditTraining, async (req, res) => {
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
  const type = effectiveMime(m.mime, m.stored_name, m.title);
  if (type) res.type(type);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(m.title)}`);
  res.sendFile(path.join(TRAIN_DIR, m.stored_name!), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл відсутній на диску" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   🎓 КУРСИ Й ПРОГРЕС (крок 2 ТЗ, 15.09.2026)
   ═══════════════════════════════════════════════════════════════════════════

   🔴 ПОРЯДОК І ЗАМКИ РАХУЄ ЯДРО, А НЕ SQL. `core/trainingProgress.ts` — єдине місце,
   де живе правило «наступний відкривається, коли попередній зроблено». Роути нижче
   лише подають йому рядки. Інакше правило існувало б у трьох копіях (список, відкриття,
   відсоток), і розійшлися б вони тихо.
*/

/**
 * 🎯 ЯКІ КУРСИ БАЧИТЬ ЦЯ РОЛЬ.
 *
 * ⚠️ ВІДХИЛЕННЯ ВІД БУКВИ ТЗ, НАЗВАНЕ ВГОЛОС. §4 каже про кандидата «лише курси з
 * аудиторією candidate». Виконане буквально, це дало б кандидату ПОРОЖНІЙ екран: єдиний
 * наявний курс — «Загальне навчання» з аудиторією `all`, бо таким його робить бекфіл.
 * Тобто буква ТЗ суперечить його ж меті («кандидат бачить лише вкладку Навчання і
 * проходить курс»). Читаємо `all` як «для всіх», а `candidate` — як «додатково для
 * кандидатів»; курси `manager` кандидату не показуємо.
 * 🔴 Якщо власник мав на увазі саме буквальне — це зміна ОДНОГО рядка тут, і вона
 * потребує його слова, а не мого здогаду.
 */
const audienceFor = (roleKey: string): string[] =>
  roleKey === "candidate" ? ["candidate", "all"] : ["manager", "all"];

/** Курси за аудиторією + мій відсоток по кожному. */
trainingRouter.get("/courses", async (req, res) => {
  const uid = req.auth!.userId;
  /* 🧩 Редактор бачить курси ВСІХ аудиторій — інакше той, хто щойно створив курс для
     кандидатів, не знайшов би його у своєму ж списку (у нього аудиторія `manager`). */
  const canEdit = roleHasPerm(req.auth!.roleKey, "manage_training");
  const [courses, folders, materials, progress] = await Promise.all([
    pool.query(
      `SELECT id, title, description, audience, position, published
         FROM training_courses
        WHERE audience = ANY($1) AND (published OR $2::boolean)
        ORDER BY position, id`,
      [canEdit ? ["candidate", "manager", "all"] : audienceFor(req.auth!.roleKey), isAdminScope(req.auth!)]
    ),
    pool.query(`SELECT id, parent_id, name, position, course_id FROM training_folders`),
    pool.query(`SELECT id, folder_id, position, required FROM training_materials WHERE status = 'published'`),
    pool.query(`SELECT material_id, status FROM training_progress WHERE user_id = $1`, [uid]),
  ]);

  const done = new Map(progress.rows.map((p) => [p.material_id, p.status as "opened" | "done"]));
  const fRows = folders.rows.map((f) => ({ id: f.id, parentId: f.parent_id, position: f.position }));
  const mRows = materials.rows.map((m) => ({ id: m.id, folderId: m.folder_id, position: m.position, required: m.required }));

  /* 🧩 Редактору (право `manage_training`) віддаємо ще й склад курсу: модулі, скільки в них
     кроків і які папки ще без курсу. Читачеві цього не показуємо — йому потрібен лише відсоток. */
  const eFolders: EditorFolder[] = folders.rows.map((f) => ({ id: f.id, parentId: f.parent_id, courseId: f.course_id, name: f.name, position: f.position }));
  const modulesOf = (courseId: number) => courseModules(eFolders, courseId).map((m) => ({
    id: m.id, name: m.name, position: m.position, ...moduleStats(m.id, eFolders, mRows),
  }));
  /* 📎 Межа й перелік типів їдуть із сервера, щоб у фронта НЕ БУЛО власної копії числа:
     розійшлися б вони мовчки, і людина дізнавалась би про межу з 413 після хвилини
     завантаження. Одне джерело — `core/trainingUpload.ts`, тримає `#712`. */
  const upload = { maxBytes: MAX_UPLOAD_BYTES, accept: ACCEPT_ATTR };
  res.json({
    canEdit, upload,
    freeModules: canEdit ? freeModules(eFolders).map((m) => ({ id: m.id, name: m.name, position: m.position, ...moduleStats(m.id, eFolders, mRows) })) : undefined,
    courses: courses.rows.map((c) => {
      // Модуль = КОРЕНЕВА папка курсу (рішення власника 15.09.2026).
      const modules = folders.rows.filter((f) => f.course_id === c.id && f.parent_id === null);
      const all = modules.flatMap((m) => orderedMaterials(m.id, fRows, mRows));
      // 🔴 ПОЛЯ ЯВНО, БЕЗ СПРЕДУ (ворота `#17e2`): нова колонка в `training_courses`
      // не має поїхати назовні сама лише тому, що її додали в таблицю.
      return { id: c.id, title: c.title, description: c.description, audience: c.audience,
               position: c.position, published: c.published,
               percent: coursePercent(all, done), materialCount: all.length,
               requiredCount: all.filter((m) => m.required).length,
               modules: canEdit ? modulesOf(c.id) : undefined };
    }),
  });
});

/** Склад курсу: модулі, матеріали, стан кожного і ХТО тримає замок. */
trainingRouter.get("/courses/:id", async (req, res) => {
  const uid = req.auth!.userId;
  const courseId = Number(req.params.id);
  const c = await pool.query(
    `SELECT id, title, description, audience, published FROM training_courses WHERE id = $1`, [courseId]);
  if (!c.rowCount) return res.status(404).json({ error: "Курс не знайдено" });
  if (!audienceFor(req.auth!.roleKey).includes(c.rows[0].audience)) {
    return res.status(403).json({ error: "Курс не для вашої ролі" });
  }

  const [folders, materials, progress] = await Promise.all([
    pool.query(`SELECT id, parent_id, name, position, course_id FROM training_folders`),
    pool.query(
      `SELECT id, folder_id, title, kind, position, required FROM training_materials
        WHERE status = 'published'`),
    pool.query(`SELECT material_id, status FROM training_progress WHERE user_id = $1`, [uid]),
  ]);
  const done = new Map(progress.rows.map((p) => [p.material_id, p.status as "opened" | "done"]));
  const fRows = folders.rows.map((f) => ({ id: f.id, parentId: f.parent_id, position: f.position }));
  const mRows = materials.rows.map((m) => ({ id: m.id, folderId: m.folder_id, position: m.position, required: m.required }));
  const titleOf = new Map(materials.rows.map((m) => [m.id, m.title as string]));

  const modules = folders.rows
    .filter((f) => f.course_id === courseId && f.parent_id === null)
    .sort((a, b) => a.position - b.position || a.id - b.id);

  const all = modules.flatMap((m) => orderedMaterials(m.id, fRows, mRows));
  const stateById = new Map(materialStates(all, done).map((s) => [s.id, s]));

  res.json({
    course: c.rows[0],
    percent: coursePercent(all, done),
    modules: modules.map((mod, i) => {
      const own = orderedMaterials(mod.id, fRows, mRows);
      return {
        id: mod.id, name: mod.name, index: i + 1,
        percent: coursePercent(own, done),
        // 🔴 ЗАКРИТІ ВІДДАЮТЬСЯ, А НЕ ХОВАЮТЬСЯ: людина мусить бачити, що попереду ще є,
        // і чому воно закрите. Сховане читалось би як «курс скоротився».
        materials: own.map((m) => {
          const st = stateById.get(m.id)!;
          const src = materials.rows.find((x) => x.id === m.id)!;
          return {
            id: m.id, title: src.title, kind: src.kind, required: m.required,
            state: st.state,
            blockedBy: st.blockedBy ? { materialId: st.blockedBy.materialId, title: titleOf.get(st.blockedBy.materialId) ?? "" } : null,
          };
        }),
      };
    }),
  });
});

/**
 * Спільна перевірка: чи можна ЗАРАЗ чіпати цей матеріал. `null` = можна.
 * Тіло переїхало в `core/trainingLock.ts` (прохід 2b, 18.09.2026) без зміни поведінки — щоб гейт
 * `#545` ганяв саме її на живій схемі, а не свою копію.
 */
const lockedReason = (uid: number, materialId: number) => stepLockedBy(pool as unknown as LockDb, uid, materialId);

/**
 * 📖 ВМІСТ ОДНОГО КРОКУ — для екрана навчання кандидата (прохід 2b, 18.09.2026).
 *
 * 🔴 ЗАМКНЕНИЙ КРОК ВМІСТУ НЕ ВІДДАЄ: 423 з назвою кроку, що тримає замок, — та сама
 * функція `lockedReason`, що й у «відкрив»/«опрацював». Інакше замок був би лише написом:
 * текст наступного кроку приходив би разом зі списком, і «по черзі» трималось би на чесності.
 * Поля явно, без спреду (`#17e2`): нова колонка матеріалу сама назовні не поїде.
 */
trainingRouter.get("/material/:id", async (req, res) => {
  const uid = req.auth!.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некоректний id" });
  const r = await pool.query<{ id: number; folder_id: number | null; title: string; kind: string; url: string | null;
    mime: string | null; size_bytes: string | null; content: string | null; required: boolean; stored_name: string | null }>(
    `SELECT id, folder_id, title, kind, url, mime, size_bytes, content, required, stored_name
       FROM training_materials WHERE id = $1 AND (status = 'published' OR $2::boolean)`,
    [id, isAdminScope(req.auth!)]);
  const m = r.rows[0];
  if (!m) return res.status(404).json({ error: "Матеріал не знайдено" });
  const blocked = await lockedReason(uid, id);
  if (blocked) return res.status(423).json({ error: "Крок ще закритий", blockedBy: blocked });
  const p = await pool.query<{ status: string; finished_at: string | null }>(
    `SELECT status, finished_at FROM training_progress WHERE user_id = $1 AND material_id = $2`, [uid, id]);
  res.json({
    id: m.id, folderId: m.folder_id, title: m.title, kind: m.kind, url: m.url,
    mime: effectiveMime(m.mime, m.stored_name, m.title),
    sizeBytes: m.size_bytes, content: m.content, required: m.required, hasFile: m.stored_name != null,
    status: p.rows[0]?.status ?? null, finishedAt: p.rows[0]?.finished_at ?? null,
  });
});

/** Відкриття матеріалу. 423 — якщо замкнено, із назвою того, хто тримає замок. */
trainingRouter.post("/progress/:materialId/open", async (req, res) => {
  const uid = req.auth!.userId;
  const id = Number(req.params.materialId);
  const blocked = await lockedReason(uid, id);
  if (blocked) return res.status(423).json({ error: "Матеріал ще закритий", blockedBy: blocked });
  await pool.query(
    `INSERT INTO training_progress (user_id, material_id, status)
     VALUES ($1, $2, 'opened') ON CONFLICT (user_id, material_id) DO NOTHING`, [uid, id]);
  await pool.query(
    `INSERT INTO training_events (user_id, material_id, kind) VALUES ($1, $2, 'open')`, [uid, id]);
  res.json({ ok: true });
});

/**
 * «Пройшов, далі». Для тестів тут 400 — їх закриває `POST /quiz/:id/submit` (крок 3).
 * 🔴 `DO UPDATE`, а не `DO NOTHING`: людина спершу ВІДКРИВАЄ матеріал (рядок уже є зі
 * станом `opened`), тож «нічого не роби при конфлікті» лишило б курс назавжди на 0%.
 */
trainingRouter.post("/progress/:materialId/done", async (req, res) => {
  const uid = req.auth!.userId;
  const id = Number(req.params.materialId);
  const kind = await pool.query<{ kind: string }>(`SELECT kind FROM training_materials WHERE id = $1`, [id]);
  if (!kind.rowCount) return res.status(404).json({ error: "Матеріал не знайдено" });
  if (kind.rows[0].kind === "quiz") {
    return res.status(400).json({ error: "Тест зараховується перевіркою відповідей, а не кнопкою" });
  }
  const blocked = await lockedReason(uid, id);
  if (blocked) return res.status(423).json({ error: "Матеріал ще закритий", blockedBy: blocked });

  await pool.query(
    `INSERT INTO training_progress (user_id, material_id, status, finished_at)
     VALUES ($1, $2, 'done', now())
     ON CONFLICT (user_id, material_id) DO UPDATE SET status = 'done', finished_at = now()`, [uid, id]);
  await pool.query(
    `INSERT INTO training_events (user_id, material_id, kind) VALUES ($1, $2, 'done')`, [uid, id]);
  res.json({ ok: true });
});

/** Курси — створення й правка (право `manage_training`). */
trainingRouter.post("/courses", canEditTraining, async (req, res) => {
  const { title, description, audience } = req.body ?? {};
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "Потрібна назва" });
  if (!["candidate", "manager", "all"].includes(audience)) {
    return res.status(400).json({ error: "audience: candidate | manager | all" });
  }
  const r = await pool.query<{ id: number }>(
    `INSERT INTO training_courses (title, description, audience, position, created_by)
     VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM training_courses), 0), $4) RETURNING id`,
    [title.trim(), description ?? null, audience, req.auth!.userId]);
  res.json({ id: r.rows[0].id });
});

trainingRouter.patch("/courses/:id", canEditTraining, async (req, res) => {
  const { title, description, audience, published } = req.body ?? {};
  if (audience !== undefined && !["candidate", "manager", "all"].includes(audience)) {
    return res.status(400).json({ error: "audience: candidate | manager | all" });
  }
  const r = await pool.query(
    `UPDATE training_courses SET
       title       = COALESCE($2, title),
       description = COALESCE($3, description),
       audience    = COALESCE($4, audience),
       published   = COALESCE($5, published)
     WHERE id = $1`,
    [Number(req.params.id), title ?? null, description ?? null, audience ?? null,
     typeof published === "boolean" ? published : null]);
  if (!r.rowCount) return res.status(404).json({ error: "Курс не знайдено" });
  res.json({ ok: true });
});
