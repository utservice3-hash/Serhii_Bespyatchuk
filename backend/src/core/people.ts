/**
 * 📷 ФОТО СПІВРОБІТНИКІВ — ДАНІ (22.09.2026). Правила — `core/peopleRules.ts`.
 *
 * Фото належить людині з реєстру `employees` (його веде «Найм → Співробітники»); до номінацій і
 * слайдів воно доходить через `employees.manager_id` — той самий звʼязок «людина ↔ менеджер Kommo»,
 * який реєстр уже веде кнопкою «Зіставити з Kommo». Немає звʼязку — у номінаціях будуть ініціали.
 */
import { pool } from "../db/pool.js";
import { nextPhotoState, photoVersion, type PhotoAction, type PhotoState } from "./peopleRules.js";

export class PeopleError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface PersonPhoto {
  employeeId: number; name: string; managerId: number | null; status: string; hasPhoto: boolean; hasPrev: boolean; v: number;
  /** Київська дата останньої дії з фото і хто її зробив — підпис «Завантажено 22.09.2026 · Даша». */
  updatedAt: string | null; updatedBy: string | null;
}

/** Усі люди реєстру з відміткою фото — для таблиці «Співробітників» (там є й звільнені) і вибору людини на слайді. */
export async function listPeoplePhotos(): Promise<PersonPhoto[]> {
  const r = await pool.query<{ id: number; full_name: string; manager_id: number | null; status: string; photo_file: string | null; photo_prev: string | null; photo_updated_at: Date | null; updated_on: string | null; updated_by: string | null }>(
    `SELECT e.id, e.full_name, e.manager_id, e.status, e.photo_file, e.photo_prev, e.photo_updated_at,
            to_char(e.photo_updated_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM.YYYY') AS updated_on,
            COALESCE(u.full_name, m.name, u.email) AS updated_by
       FROM employees e
       LEFT JOIN users u ON u.id = e.photo_updated_by
       LEFT JOIN managers m ON m.id = u.manager_id
      ORDER BY e.full_name`);
  return r.rows.map((x) => ({ employeeId: x.id, name: x.full_name, managerId: x.manager_id, status: x.status,
    hasPhoto: !!x.photo_file, hasPrev: !!x.photo_prev, v: photoVersion(x.photo_updated_at), updatedAt: x.updated_on, updatedBy: x.updated_by }));
}

/**
 * Фото менеджерів Kommo (для номінацій і слайда «План виконали»): менеджер → співробітник із фото.
 * Без аргументу — УСІ привʼязані з фото: слайд плану бере людей зі Звіту за місяць, а не з тижня
 * номінацій, і ростери можуть розійтись на новачку. Саме фото й так бачить будь-хто залогінений.
 * Без фото чи без звʼязку — немає в мапі (на слайді ініціали).
 */
export async function managerPhotos(managerIds?: readonly number[]): Promise<Record<string, { id: number; v: number }>> {
  if (managerIds && managerIds.length === 0) return {};
  const r = await pool.query<{ manager_id: number; id: number; photo_updated_at: Date | null }>(
    `SELECT DISTINCT ON (manager_id) manager_id, id, photo_updated_at FROM employees
      WHERE manager_id IS NOT NULL AND photo_file IS NOT NULL AND ($1::int[] IS NULL OR manager_id = ANY($1))
      ORDER BY manager_id, (status = 'dismissed'), photo_updated_at DESC NULLS LAST, id`, [managerIds ?? null]);
  return Object.fromEntries(r.rows.map((x) => [String(x.manager_id), { id: x.id, v: photoVersion(x.photo_updated_at) }]));
}

/** Фото співробітників за їхніми id (для ручних слайдів «Новий працівник» / «День народження»). */
export async function employeePhotos(employeeIds: readonly number[]): Promise<Record<string, { id: number; v: number }>> {
  if (employeeIds.length === 0) return {};
  const r = await pool.query<{ id: number; photo_updated_at: Date | null }>(
    `SELECT id, photo_updated_at FROM employees WHERE id = ANY($1) AND photo_file IS NOT NULL`, [employeeIds]);
  return Object.fromEntries(r.rows.map((x) => [String(x.id), { id: x.id, v: photoVersion(x.photo_updated_at) }]));
}

/** Імʼя файлу поточного фото на диску, або `null`. */
export async function photoFileOf(employeeId: number): Promise<string | null> {
  const r = await pool.query<{ photo_file: string | null }>(`SELECT photo_file FROM employees WHERE id = $1`, [employeeId]);
  return r.rows[0]?.photo_file ?? null;
}

/**
 * Дія над фото під блокуванням рядка: завантажити / прибрати / повернути попереднє. Звільненим фото не
 * ставимо (рішення плану 22.09), але прибрати чи повернути — можна: це скасування, а не нове фото.
 */
export async function applyPhotoAction(employeeId: number, action: PhotoAction, actorId: number): Promise<PhotoState & { v: number }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const cur = (await c.query<{ status: string; photo_file: string | null; photo_prev: string | null }>(
      `SELECT status, photo_file, photo_prev FROM employees WHERE id = $1 FOR UPDATE`, [employeeId])).rows[0];
    if (!cur) throw new PeopleError(404, "Людини немає в реєстрі");
    if (action.kind === "upload" && cur.status === "dismissed") throw new PeopleError(400, "Звільненим фото не завантажуємо");
    const next = nextPhotoState({ file: cur.photo_file, prev: cur.photo_prev }, action);
    if (!next.ok) throw new PeopleError(400, next.error);
    const u = await c.query<{ photo_updated_at: Date }>(
      `UPDATE employees SET photo_file = $2, photo_prev = $3, photo_updated_at = now(), photo_updated_by = $4
        WHERE id = $1 RETURNING photo_updated_at`, [employeeId, next.state.file, next.state.prev, actorId > 0 ? actorId : null]);
    await c.query("COMMIT");
    return { ...next.state, v: photoVersion(u.rows[0].photo_updated_at) };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
