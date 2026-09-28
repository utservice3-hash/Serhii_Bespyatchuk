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
import { attachVerdict, requiredValue, moduleStats, courseModules, freeModules, reorderVerdict, moveInOrder, type EditorFolder } from "../core/trainingEditor.js";
import { roleHasPerm } from "../auth/rbac.js";
import { effectiveMime, mimeFromName } from "../core/trainingMime.js";
import { checkUpload, MAX_UPLOAD_BYTES, ACCEPT_ATTR } from "../core/trainingUpload.js";
import { LESSON_ONLY, PART_ROLES, partVerdict, type PartRole } from "../core/trainingLesson.js";

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

/* ⚙️ Тека файлів навчання. `TRAINING_DIR` — лише для гейтів на тимчасовій базі (`#738`), щоб заміна файлу в тесті
   не писала в справжню теку стенда; бойовий процес цієї змінної не має. */
const TRAIN_DIR = process.env.TRAINING_DIR ?? path.join(UPLOAD_DIR, "..", "training");

/**
 * 📎 ЗБЕРЕГТИ ФАЙЛ З ФОРМИ — ОДНЕ МІСЦЕ для «додати» й «замінити» (28.09.2026): тип і розмір перевіряє ядро
 * (`core/trainingUpload.ts`) ДО запису на диск, тож заміна не може прийняти те, що не прийняло б створення.
 */
async function storeUpload(b: Record<string, unknown>, fallbackName: string):
  Promise<{ ok: true; storedName: string; mime: string; sizeBytes: number } | { ok: false; status: number; error: string }> {
  const dataBase64 = b.dataBase64;
  if (!dataBase64 || typeof dataBase64 !== "string") return { ok: false, status: 400, error: "Файл відсутній" };
  const base64 = dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64;
  const buffer = Buffer.from(base64, "base64");
  const display = String(b.filename ?? fallbackName).trim() || "файл";
  const verdict = checkUpload(b.mime ? String(b.mime) : mimeFromName(display), buffer.length);
  if (!verdict.ok) return { ok: false, status: verdict.status, error: verdict.reason };
  const ext = path.extname(display).slice(0, 12).replace(/[^.\w]/g, "");
  const storedName = `${randomUUID()}${ext}`;
  await mkdir(TRAIN_DIR, { recursive: true });
  await writeFile(path.join(TRAIN_DIR, storedName), buffer);
  return { ok: true, storedName, mime: verdict.mime, sizeBytes: buffer.length };
}
// 📎 Стеля й білий список — у `core/trainingUpload.ts`, одним числом на сервер і фронт (#716).
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
      `SELECT m.id, m.folder_id, m.title, m.kind, m.url, m.mime, m.stored_name, m.size_bytes, m.content, m.position, m.created_at, m.lesson_id, m.part_role,
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
    lesson_id: m.lesson_id, part_role: m.part_role,
  }));
  /* 📎 Межа й перелік типів їдуть із сервера, щоб у фронта НЕ БУЛО власної копії числа:
     розійшлися б вони мовчки, і людина дізнавалась би про межу з 413 після хвилини
     завантаження. Одне джерело — `core/trainingUpload.ts`, тримає `#716`. */
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

  /* ✏️ ЧАСТИНА УРОКУ (редактор, 28.09.2026): `lessonId` + `role`. Тема частини — завжди тема уроку, а не та,
     що прийшла з форми; правило — `partVerdict` у ядрі (`#737`). Перевірка ДО запису файлу на диск. */
  let lessonId: number | null = null, partRole: string | null = null, targetFolder = folderId;
  if (b.lessonId != null) {
    const lr = await pool.query<{ id: number; folder_id: number | null; lesson_id: number | null }>(
      `SELECT id, folder_id, lesson_id FROM training_materials WHERE id = $1`, [Number(b.lessonId)]);
    const l = lr.rows[0];
    const v = partVerdict(l ? { id: l.id, folderId: l.folder_id, lessonId: l.lesson_id } : null, b.role);
    if (!v.ok) return res.status(v.status).json({ error: v.reason });
    lessonId = l!.id; partRole = v.role; targetFolder = v.folderId;
  }

  let url: string | null = null, storedName: string | null = null, mime: string | null = null;
  let sizeBytes: number | null = null, content: string | null = null;

  if (kind === "video_embed" || kind === "link") {
    url = String(b.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Вкажіть коректне посилання (http/https)" });
  } else if (kind === "text") {
    content = String(b.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "Текст матеріалу обовʼязковий" });
  } else if (kind === "file") {
    /* 📎 Тип і розмір — ОДНІЄЮ перевіркою ядра, ДО запису на диск (`storeUpload`, спільне з заміною файлу). */
    const up = await storeUpload(b, title);
    if (!up.ok) return res.status(up.status).json({ error: up.error });
    storedName = up.storedName; mime = up.mime; sizeBytes = up.sizeBytes;
  }
  content = content ?? (b.content ? String(b.content).trim() : null); // опис для не-текстових

  const pos = await pool.query<{ n: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM training_materials WHERE folder_id IS NOT DISTINCT FROM $1`,
    [targetFolder]
  );
  const r = await pool.query(
    `INSERT INTO training_materials (folder_id, title, kind, url, stored_name, mime, size_bytes, content, position, created_by, lesson_id, part_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, folder_id, title, kind, url, mime, size_bytes, content, position, created_at, lesson_id, part_role`,
    [targetFolder, title, kind, url, storedName, mime, sizeBytes, content, pos.rows[0].n, req.auth!.userId, lessonId, partRole]
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
  /* ✏️ Урок чи частина — від цього залежить, що можна міняти (повний редактор, 28.09.2026). */
  const self = await pool.query<{ lesson_id: number | null }>(`SELECT lesson_id FROM training_materials WHERE id = $1`, [Number(req.params.id)]);
  if (!self.rows[0]) return res.status(404).json({ error: "Матеріал не знайдено" });
  const isPart = self.rows[0].lesson_id != null;
  const newFolder = b.folderId !== undefined ? (b.folderId != null ? Number(b.folderId) : null) : undefined;
  if (newFolder !== undefined) {
    /* 📘 Частина живе в темі свого уроку; окремо її не переносять — лише разом з уроком (нижче). */
    if (isPart) return res.status(400).json({ error: "Частину переносять разом з уроком — перенесіть сам урок" });
    params.push(newFolder); sets.push(`folder_id = $${params.length}`);
    /* ↕️ Перенесений урок стає ОСТАННІМ у новій темі: зі старим номером він падав у середину, між чужими уроками
       з тим самим номером (спіймано на стенді 28.09.2026). Явний `position` у тому ж запиті має перевагу. */
    if (b.position === undefined) {
      const last = await pool.query<{ n: number }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS n FROM training_materials WHERE folder_id IS NOT DISTINCT FROM $1 AND ${LESSON_ONLY}`, [newFolder]);
      params.push(last.rows[0].n); sets.push(`position = $${params.length}`);
    }
  }
  if (b.position !== undefined) { params.push(Number(b.position)); sets.push(`position = $${params.length}`); }
  if (b.role !== undefined) {
    if (!isPart) return res.status(400).json({ error: "Роль є лише в частини уроку" });
    if (!PART_ROLES.includes(b.role as PartRole)) return res.status(400).json({ error: "Роль частини: main або attachment" });
    params.push(b.role); sets.push(`part_role = $${params.length}`);
  }
  /* 🧩 «Обовʼязковий крок» (редактор навчання). Необовʼязковий не тримає замок і не входить
     у знаменник відсотка — правило одне, у `core/trainingProgress.ts`. */
  if (b.required !== undefined) {
    const req_ = requiredValue(b.required);
    if (req_ === null) return res.status(400).json({ error: "required: true або false" });
    params.push(req_); sets.push(`required = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Нема що оновлювати" });
  params.push(Number(req.params.id));
  /* 📘 Урок і його частини переїжджають ОДНІЄЮ транзакцією: інакше між двома запитами частини жили б у старій
     темі, а урок — у новій, і обрив посередині лишив би їх там назавжди (`#738`). */
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(`UPDATE training_materials SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`, params);
    if (newFolder !== undefined) await c.query(`UPDATE training_materials SET folder_id = $1 WHERE lesson_id = $2`, [newFolder, Number(req.params.id)]);
    await c.query("COMMIT");
    if (!r.rowCount) return res.status(404).json({ error: "Матеріал не знайдено" });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  res.json({ ok: true });
});

/**
 * 📎 ЗАМІНИТИ ФАЙЛ (повний редактор, 28.09.2026, Роман: «зміна пдф, та зміна інших файлів»). Рядок, його id,
 * прогрес людей і місце в курсі лишаються — міняються лише байти, тип і розмір. Перевірка та сама, що при
 * додаванні (`storeUpload`). Старий файл стирається ПІСЛЯ запису нового рядка: впаде запис — лишиться старий.
 */
trainingRouter.put("/material/:id/file", canEditTraining, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некоректний id" });
  const cur = await pool.query<{ kind: string; stored_name: string | null; title: string }>(
    `SELECT kind, stored_name, title FROM training_materials WHERE id = $1`, [id]);
  const m = cur.rows[0];
  if (!m) return res.status(404).json({ error: "Матеріал не знайдено" });
  if (m.kind !== "file") return res.status(400).json({ error: "Замінити файл можна лише у файлового матеріалу" });
  const up = await storeUpload(req.body ?? {}, m.title);
  if (!up.ok) return res.status(up.status).json({ error: up.error });
  try {
    await pool.query(`UPDATE training_materials SET stored_name = $1, mime = $2, size_bytes = $3 WHERE id = $4`,
      [up.storedName, up.mime, up.sizeBytes, id]);
  } catch (e) {
    await unlink(path.join(TRAIN_DIR, up.storedName)).catch(() => {});
    throw e;
  }
  if (m.stored_name) await unlink(path.join(TRAIN_DIR, m.stored_name)).catch(() => {});
  res.json({ ok: true, mime: up.mime, sizeBytes: up.sizeBytes });
});

/**
 * ↕️ ПОРЯДОК (повний редактор, 28.09.2026). `table: "materials"` — уроки однієї теми або частини одного уроку;
 * `"folders"` — теми одного курсу (або підтеми однієї теми). Два способи:
 *   • `{ id, dir: -1 | 1 }` — ↑/↓ на одне місце; порядок будує сервер зі свіжих сусідів (`moveInOrder`);
 *   • `{ ids }` — повний перелік сусідів, і він мусить збігтися з ними повністю (`reorderVerdict`).
 * Номери — 1..n одним запитом, щоб рівних не лишилось.
 */
trainingRouter.post("/reorder", canEditTraining, async (req, res) => {
  const table = req.body?.table;
  const move = req.body?.id != null;
  const ids = move ? null : req.body?.ids;
  if (table !== "materials" && table !== "folders") return res.status(400).json({ error: "table: materials або folders" });
  if (!move && (!Array.isArray(ids) || ids.length === 0)) return res.status(400).json({ error: "ids: непорожній масив або id + dir" });
  const first = Number(move ? req.body.id : ids![0]);
  const sib = table === "materials"
    ? await pool.query<{ id: number }>(
      `SELECT s.id FROM training_materials s JOIN training_materials f ON f.id = $1
        WHERE s.folder_id IS NOT DISTINCT FROM f.folder_id AND s.lesson_id IS NOT DISTINCT FROM f.lesson_id
        ORDER BY s.position, s.id`, [first])
    : await pool.query<{ id: number }>(
      `SELECT s.id FROM training_folders s JOIN training_folders f ON f.id = $1
        WHERE s.parent_id IS NOT DISTINCT FROM f.parent_id AND s.course_id IS NOT DISTINCT FROM f.course_id
        ORDER BY s.position, s.id`, [first]);
  if (!sib.rows.length) return res.status(404).json({ error: "Не знайдено" });
  const sorted = sib.rows.map((r) => r.id);
  const moved = move ? moveInOrder(sorted, first, req.body?.dir) : null;
  if (move && !moved) return res.status(400).json({ error: "Далі рухати нікуди — це вже край списку" });
  const v = reorderVerdict(sorted, moved ?? ids);
  if (!v.ok) return res.status(v.status).json({ error: v.reason });
  const tbl = table === "materials" ? "training_materials" : "training_folders";
  await pool.query(
    `UPDATE ${tbl} t SET position = o.pos FROM unnest($1::int[]) WITH ORDINALITY AS o(id, pos) WHERE t.id = o.id`, [v.ids]);
  res.json({ ok: true });
});

/** Видалити матеріал (+ файл з диска, якщо був). */
trainingRouter.delete("/material/:id", canEditTraining, async (req, res) => {
  const id = Number(req.params.id);
  /* 📘 Урок забирає свої частини (`ON DELETE CASCADE`) — отже й їхні файли на диску. Імена беремо ДО видалення:
     після нього рядків частин уже не буде, і файли лишились би сиротами на диску, який і так закінчувався. */
  const partFiles = await pool.query<{ stored_name: string }>(
    `SELECT stored_name FROM training_materials WHERE lesson_id = $1 AND stored_name IS NOT NULL`, [id]);
  const r = await pool.query<{ stored_name: string | null }>(
    `DELETE FROM training_materials WHERE id = $1 RETURNING stored_name`,
    [id]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Матеріал не знайдено" });
  if (r.rows[0].stored_name) await unlink(path.join(TRAIN_DIR, r.rows[0].stored_name)).catch(() => {});
  await Promise.all(partFiles.rows.map((f) => unlink(path.join(TRAIN_DIR, f.stored_name)).catch(() => {})));
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
    // 📘 Кроки — ЛИШЕ уроки (`core/trainingLesson.ts`): частина не додає кроку ні у відсоток, ні в лічильник.
    pool.query(`SELECT id, folder_id, position, required FROM training_materials WHERE status = 'published' AND ${LESSON_ONLY}`),
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
     завантаження. Одне джерело — `core/trainingUpload.ts`, тримає `#716`. */
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
    // 📘 Кроки — ЛИШЕ уроки; частини уроку приходять разом із ним у `GET /material/:id`.
    pool.query(
      `SELECT id, folder_id, title, kind, position, required FROM training_materials
        WHERE status = 'published' AND ${LESSON_ONLY}`),
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
  /* ✏️ Редактор відкриває будь-який урок (рішення Романа: «знімати замок для редакторів»): інакше він не міг би
     виправити третій урок, не пройшовши перших двох. Кандидату й менеджеру замок лишається (`#737b`). */
  const blocked = roleHasPerm(req.auth!.roleKey, "manage_training") ? null : await lockedReason(uid, id);
  if (blocked) return res.status(423).json({ error: "Крок ще закритий", blockedBy: blocked });
  const p = await pool.query<{ status: string; finished_at: string | null }>(
    `SELECT status, finished_at FROM training_progress WHERE user_id = $1 AND material_id = $2`, [uid, id]);
  /* 📘 Частини уроку — разом із ним, одним запитом: урок показується ЦІЛИМ (pdf/відео, текст, вкладення),
     як у Sereda. Замок уже перевірено для уроку вище, а частина власного замка не має. Поля — явно (`#17e2`). */
  const parts = await pool.query<{ id: number; title: string; kind: string; url: string | null; mime: string | null;
    size_bytes: string | null; stored_name: string | null; part_role: string; content: string | null }>(
    `SELECT id, title, kind, url, mime, size_bytes, stored_name, part_role, content
       FROM training_materials WHERE lesson_id = $1 AND (status = 'published' OR $2::boolean)
      ORDER BY position, id`,
    [id, isAdminScope(req.auth!)]);
  res.json({
    id: m.id, folderId: m.folder_id, title: m.title, kind: m.kind, url: m.url,
    mime: effectiveMime(m.mime, m.stored_name, m.title),
    sizeBytes: m.size_bytes, content: m.content, required: m.required, hasFile: m.stored_name != null,
    status: p.rows[0]?.status ?? null, finishedAt: p.rows[0]?.finished_at ?? null,
    parts: parts.rows.map((x) => ({
      id: x.id, title: x.title, kind: x.kind, url: x.url, role: x.part_role,
      mime: effectiveMime(x.mime, x.stored_name, x.title),
      sizeBytes: x.size_bytes, hasFile: x.stored_name != null, content: x.content,
    })),
  });
});

/** Відкриття матеріалу. 423 — якщо замкнено, із назвою того, хто тримає замок. */
trainingRouter.post("/progress/:materialId/open", async (req, res) => {
  const uid = req.auth!.userId;
  const id = Number(req.params.materialId);
  /* 📘 Прогрес ставиться УРОКУ, а не частині: позначка на частині не рахувалась би ніде, а людина думала б,
     що крок зараховано. */
  const partOf = await pool.query<{ lesson_id: number | null }>(`SELECT lesson_id FROM training_materials WHERE id = $1`, [id]);
  if (partOf.rows[0]?.lesson_id != null) return res.status(400).json({ error: "Це частина уроку — позначається сам урок", lessonId: partOf.rows[0].lesson_id });
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
  /* 📘 Прогрес ставиться УРОКУ, а не частині: позначка на частині не рахувалась би ніде, а людина думала б,
     що крок зараховано. */
  const partOf = await pool.query<{ lesson_id: number | null }>(`SELECT lesson_id FROM training_materials WHERE id = $1`, [id]);
  if (partOf.rows[0]?.lesson_id != null) return res.status(400).json({ error: "Це частина уроку — позначається сам урок", lessonId: partOf.rows[0].lesson_id });
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
