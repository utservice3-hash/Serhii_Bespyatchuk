/**
 * 📁 КОПІЯ ТЕКИ ДОКУМЕНТІВ У НІЧНИЙ БЕКАП (борг із плану «Документи v2», рішення власника 16.09.2026).
 *
 * Файли документів лежать на диску (`backend/documents`), а бекап бази копіює лише таблиці:
 * після відновлення бази з копії кожен `doc_files.stored_name` показував би в порожнечу.
 * Тому поруч із CSV таблиць кладемо саму теку. Чиста частина — `copyDocuments`: повертає,
 * що скопійовано і чого не знайшлось, і саме її стереже `#446` на тимчасовій теці.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface DocsCopyResult { copied: number; bytes: number; missingDir: boolean }

/** Копіює всі файли з `srcDir` у `dstDir/documents`. Немає теки-джерела — не помилка, а факт у маніфесті. */
export function copyDocuments(srcDir: string, dstDir: string): DocsCopyResult {
  if (!existsSync(srcDir)) return { copied: 0, bytes: 0, missingDir: true };
  const target = path.join(dstDir, "documents");
  mkdirSync(target, { recursive: true });
  let copied = 0, bytes = 0;
  for (const name of readdirSync(srcDir)) {
    const from = path.join(srcDir, name);
    const st = statSync(from);
    if (!st.isFile()) continue;
    cpSync(from, path.join(target, name));
    copied++; bytes += st.size;
  }
  return { copied, bytes, missingDir: false };
}

export const manifestLine = (r: DocsCopyResult): string =>
  r.missingDir ? "documents: тека відсутня (файлів документів ще немає)\n" : `documents files: ${r.copied} (${r.bytes} bytes)\n`;
