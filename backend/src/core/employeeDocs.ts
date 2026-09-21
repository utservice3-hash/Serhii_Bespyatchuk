/**
 * 📎 ДОКУМЕНТИ ЛЮДИНИ В КАРТЦІ РЕЄСТРУ (21.09.2026, прохання Івана: «завантажувати NDA, офер і т.д.»,
 * Роман: «продублюю логіку вкладки файлів»).
 *
 * Це НЕ окреме сховище: документ — той самий `doc_files` модуля «Документи», розділ `personal`, тож його видно
 * і в «Документах → Особисті», і в кошику там само. Належить людині так:
 *   • є акаунт → адресат `addressee_user_id` (людина бачить свій документ у «Документах»);
 *   • акаунта немає → `employee_id` (бачить лише керівництво — правило `canSeeDocument` не змінюється).
 * Список картки = документи з `employee_id` людини + УСІ особисті документи й офери її акаунта (у тому числі
 * завантажені через «Документи» чи сформовані з шаблону офера).
 *
 * 🔴 Розділ завжди `personal`, навіть для офера: розділ `offer` вмикає нагадування «підпишіть» — людині,
 * що давно підписала папірець, воно прийшло б у Telegram. Тип «Офер» лишається в `category`.
 * Доступ — лише керівництво (`isManagement`), як до особистих документів у модулі. Тримає #613.
 */
import type { Db } from "./secrets.js";
import { ImportError } from "./employeeImport.js";

export const HR_DOC_KINDS = ["Офер", "NDA", "Договір", "Заява", "Наказ", "Інше"] as const;
export const MAX_DOC_BYTES = 100 * 1024 * 1024;

/** Документ людини? Той самий предикат для списку, відкриття й видалення. */
const OWNS = `(f.employee_id = e.id OR (e.user_id IS NOT NULL AND f.addressee_user_id = e.user_id AND f.section IN ('personal','offer')))`;

export async function listEmployeeDocs(db: Db, employeeId: number) {
  const e = (await db.query(`SELECT id FROM employees WHERE id = $1`, [employeeId])).rows[0];
  if (!e) throw new ImportError(404, "Співробітника не знайдено");
  return (await db.query(
    `SELECT f.id, f.name, f.category, f.description, f.section, f.mime, f.size_bytes::int AS size_bytes, f.version,
            f.created_at, f.archived_at, f.deleted_at, COALESCE(NULLIF(u.full_name, ''), m.name, u.email) AS author,
            EXISTS (SELECT 1 FROM doc_signatures s WHERE s.file_id = f.id AND s.version = f.version AND s.sha256 = f.sha256 AND s.rejected_at IS NULL) AS signed
       FROM doc_files f JOIN employees e ON e.id = $1
       LEFT JOIN users u ON u.id = f.created_by LEFT JOIN managers m ON m.id = u.manager_id
      WHERE ${OWNS}
      ORDER BY (f.deleted_at IS NOT NULL), f.created_at DESC`, [employeeId])).rows;
}

/** Файл цієї людини (включно з видаленими — для «Повернути»), або 404 — чужий документ не підтверджує існування. */
export async function employeeDoc(db: Db, employeeId: number, fileId: number) {
  const r = (await db.query<{ id: number; name: string; stored_name: string; mime: string | null; deleted_at: string | null }>(
    `SELECT f.id, f.name, f.stored_name, f.mime, f.deleted_at FROM doc_files f JOIN employees e ON e.id = $1 WHERE f.id = $2 AND ${OWNS}`,
    [employeeId, fileId])).rows[0];
  if (!r) throw new ImportError(404, "Документ не знайдено");
  return r;
}

export async function attachEmployeeDoc(db: Db, actorId: number, employeeId: number,
  b: { filename?: unknown; mime?: unknown; kind?: unknown; buffer: Buffer | null },
  store: (display: string, buf: Buffer) => Promise<{ storedName: string; sha256: string }>) {
  const e = (await db.query<{ id: number; user_id: number | null }>(`SELECT id, user_id FROM employees WHERE id = $1`, [employeeId])).rows[0];
  if (!e) throw new ImportError(404, "Співробітника не знайдено");
  if (!b.buffer || !b.buffer.length) throw new ImportError(400, "Файл відсутній");
  if (b.buffer.length > MAX_DOC_BYTES) throw new ImportError(413, "Файл завеликий (макс. 100 МБ)");
  const kind = HR_DOC_KINDS.includes(b.kind as never) ? (b.kind as string) : "Інше";
  const display = (typeof b.filename === "string" && b.filename.trim() ? b.filename.trim() : "документ").slice(0, 200);
  const mime = typeof b.mime === "string" && b.mime ? b.mime.slice(0, 120) : null;
  const { storedName, sha256 } = await store(display, b.buffer);
  // Тип модуля «Документи» — лише зі свого списку; NDA/Договір/… — «Інше» з назвою типу в описі.
  const category = kind === "Офер" ? "Офер" : "Інше";
  const r = await db.query<{ id: number }>(
    `INSERT INTO doc_files (folder_id, name, stored_name, category, mime, size_bytes, created_by, section, addressee_user_id, description, version, sha256, employee_id)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, 'personal', $7, $8, 1, $9, $10) RETURNING id`,
    [display, storedName, category, mime, b.buffer.length, actorId, e.user_id, kind === category ? null : kind, sha256, e.id]);
  const id = r.rows[0].id;
  await db.query(`INSERT INTO doc_file_versions (file_id, version, stored_name, sha256, mime, size_bytes, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6)`,
    [id, storedName, sha256, mime, b.buffer.length, actorId]);
  await db.query(`INSERT INTO doc_events (file_id, kind, actor_id, details) VALUES ($1, 'uploaded', $2, $3)`, [id, actorId, { version: 1, via: "hr" }]);
  return { id };
}

/** Прибрати / повернути — той самий кошик, що в «Документах» (`deleted_at`); файл на диску лишається. */
export async function setEmployeeDocDeleted(db: Db, actorId: number, employeeId: number, fileId: number, deleted: boolean) {
  const f = await employeeDoc(db, employeeId, fileId);
  if (!!f.deleted_at === deleted) throw new ImportError(409, deleted ? "Документ уже прибрано" : "Документ не прибраний");
  await db.query(deleted ? `UPDATE doc_files SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1`
    : `UPDATE doc_files SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1`, deleted ? [fileId, actorId] : [fileId]);
  await db.query(`INSERT INTO doc_events (file_id, kind, actor_id, details) VALUES ($1, $2, $3, $4)`,
    [fileId, deleted ? "deleted" : "undeleted", actorId, { name: f.name, via: "hr" }]);
}
