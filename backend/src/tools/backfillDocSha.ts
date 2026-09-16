/**
 * 🔢 БЕКФІЛ ХЕШІВ для документів, завантажених ДО v2 (борг 16.09.2026): 21 файл без sha256.
 * Без хеша неможливі підпис і ознайомлення (обидва привʼязані до версії+хеша), і картка каже
 * «хеша немає (старий файл)». Скрипт читає файл з диска, рахує sha256, пише його у `doc_files`
 * і заводить запис версії 1 у `doc_file_versions`, якщо його немає.
 *
 * Запуск (з ПРОД-чекауту, .env поруч):  node dist/tools/backfillDocSha.js            — сухий прогін
 *                                          node dist/tools/backfillDocSha.js --write    — записати
 * Ідемпотентно: чіпає лише рядки з sha256 IS NULL; файл відсутній → рядок названо, не зачеплено.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = process.env.DOCS_DIR ?? path.resolve(__dirname, "..", "..", "documents");
const write = process.argv.includes("--write");

async function main() {
  const rows = (await pool.query<{ id: number; name: string; stored_name: string; mime: string | null; size_bytes: string | null; created_by: number | null; version: number }>(
    `SELECT id, name, stored_name, mime, size_bytes, created_by, version FROM doc_files WHERE sha256 IS NULL ORDER BY id`)).rows;
  console.log(`${write ? "ЗАПИС" : "СУХИЙ ПРОГІН"}: без хеша ${rows.length}, тека ${DOCS_DIR}`);
  let done = 0, missing = 0;
  for (const r of rows) {
    const f = path.join(DOCS_DIR, r.stored_name);
    if (!existsSync(f)) { missing++; console.log(`  ✖ #${r.id} ${r.name}: файла ${r.stored_name} немає на диску`); continue; }
    const buf = readFileSync(f);
    const sha = createHash("sha256").update(buf).digest("hex");
    console.log(`  ${write ? "✔" : "·"} #${r.id} ${r.name}: ${buf.length} B → ${sha.slice(0, 12)}…`);
    if (!write) continue;
    await pool.query(`UPDATE doc_files SET sha256 = $2, size_bytes = COALESCE(size_bytes, $3) WHERE id = $1 AND sha256 IS NULL`, [r.id, sha, buf.length]);
    await pool.query(
      `INSERT INTO doc_file_versions (file_id, version, stored_name, sha256, mime, size_bytes, created_by)
       SELECT $1, $2, $3, $4, $5, $6, $7 WHERE NOT EXISTS (SELECT 1 FROM doc_file_versions WHERE file_id = $1 AND version = $2)`,
      [r.id, r.version, r.stored_name, sha, r.mime, buf.length, r.created_by]);
    done++;
  }
  console.log(`підсумок: ${write ? "записано" : "готово до запису"} ${write ? done : rows.length - missing}, без файла ${missing}.`);
}
main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
