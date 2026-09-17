/**
 * 🔎 ДЖОБА ТЕКСТУ ДОКУМЕНТІВ: витягує текст ПОТОЧНОЇ версії для пошуку (`core/docText.ts`).
 * Бере документи, у яких текст відсутній або належить старій версії, по кілька за прогін.
 * Кличеться кожні 30 хв, на старті й одразу після завантаження файла чи нової версії.
 * Запис умовний (`WHERE version = $v`): якщо поки ми читали, зʼявилась нова версія, старий текст
 * не перезапише її — наступний прогін візьме новішу.
 */
import path from "path";
import { readFile } from "fs/promises";
import { pool } from "../db/pool.js";
import { UPLOAD_DIR } from "../routes/uploads.js";
import { extractText, formatOf } from "../core/docText.js";

export const DOCS_DIR = path.join(UPLOAD_DIR, "..", "documents");
const BATCH = 25;

type Row = { id: number; name: string; mime: string | null; stored_name: string; version: number };

export async function extractOne(r: Row): Promise<string> {
  const file = path.join(DOCS_DIR, path.basename(r.stored_name));
  const fmt = formatOf(r.name, r.mime);
  let res;
  try {
    const buf = fmt === "pdf" ? Buffer.alloc(0) : await readFile(file);
    res = await extractText(fmt, buf, file);
  } catch (e) {
    res = { status: "failed" as const, text: null, reason: `файл не прочитано: ${(e as Error).message.slice(0, 200)}` };
  }
  await pool.query(
    `UPDATE doc_files SET content_text = $2, content_status = $3, content_reason = $4, content_version = $5, content_at = now()
      WHERE id = $1 AND version = $5`, [r.id, res.text, res.status, res.reason, r.version]);
  return res.status;
}

/** Після завантаження: не чекаємо, помилка не валить відповідь людині (джоба добере). */
export function extractSoon(fileId: number): void {
  void pool.query<Row>(`SELECT id, name, mime, stored_name, version FROM doc_files WHERE id = $1`, [fileId])
    .then((q) => q.rows[0] ? extractOne(q.rows[0]) : null)
    .catch((e) => console.error("[docText]", (e as Error).message));
}

export async function runDocText(): Promise<Record<string, number>> {
  const q = await pool.query<Row>(
    `SELECT id, name, mime, stored_name, version FROM doc_files
      WHERE deleted_at IS NULL AND content_version IS DISTINCT FROM version ORDER BY id LIMIT ${BATCH}`);
  const tally: Record<string, number> = { ok: 0, empty: 0, unsupported: 0, failed: 0 };
  for (const r of q.rows) tally[await extractOne(r)]++;
  const left = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM doc_files WHERE deleted_at IS NULL AND content_version IS DISTINCT FROM version`)).rows[0].n;
  console.log(`docText: оброблено ${q.rowCount} (текст ${tally.ok}, без тексту ${tally.empty}, формат без тексту ${tally.unsupported}, збій ${tally.failed}); лишилось ${left}.`);
  return tally;
}
