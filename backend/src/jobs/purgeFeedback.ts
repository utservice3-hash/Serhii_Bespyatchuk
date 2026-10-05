import path from "node:path";
import { unlink } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { FEEDBACK_PURGE_WHERE } from "../core/feedbackRetention.js";

/**
 * 🗑 БЕЗПОВОРОТНЕ ВИДАЛЕННЯ ЗАКРИТИХ ЗВЕРНЕНЬ — через 30 днів після закриття (рішення Романа 05.10.2026).
 *
 * Що зникає: рядок `feedback`, його `feedback_files` (каскадом) і байти фото на диску.
 * Revert коду цього не повертає; лишаються лише нічні бекапи таблиць на строк їхньої ротації.
 *
 * 🔴 ПОРЯДОК: спершу імена файлів, потім `DELETE … RETURNING`, і лише тоді диск. Упаде диск —
 * лишиться сирота-байт без рядка (нешкідливо); навпаки — рядок без байтів, що віддає 404 на екрані.
 *
 * Повертає ЧИСЛА, а не «ок»: «відпрацювала» нічого не означає, поки не сказано «видалила N»
 * (правило зони джоб «ЗЕЛЕНА ДЖОБА ≠ ДАНІ ЙДУТЬ»).
 */
export async function purgeFeedback(db: Pool | PoolClient, filesDir: string): Promise<{ deleted: number; files: number; unlinkFailed: number }> {
  const files = await db.query<{ stored_name: string }>(
    `SELECT stored_name FROM feedback_files WHERE feedback_id IN (SELECT id FROM feedback WHERE ${FEEDBACK_PURGE_WHERE})`
  );
  const del = await db.query<{ id: number }>(`DELETE FROM feedback WHERE ${FEEDBACK_PURGE_WHERE} RETURNING id`);
  let unlinkFailed = 0;
  for (const f of files.rows) {
    await unlink(path.join(filesDir, f.stored_name)).catch(() => { unlinkFailed++; });
  }
  if (del.rowCount) console.log(`purgeFeedback: видалено звернень ${del.rowCount}, фото ${files.rowCount} (не знайдено на диску: ${unlinkFailed})`);
  return { deleted: del.rowCount ?? 0, files: files.rowCount ?? 0, unlinkFailed };
}
