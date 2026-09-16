import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyDocuments, manifestLine } from "./backupDocuments.js";

/**
 * #446 — ТЕКА ДОКУМЕНТІВ ЇДЕ В БЕКАП РАЗОМ З ТАБЛИЦЯМИ: усі файли скопійовано байт-у-байт,
 * підтеки не чіпаються, відсутня тека — названа в маніфесті, а не мовчазний нуль.
 * Червоніє, якщо копіювання пропустити або порахувати файли, не скопіювавши.
 */
test("#446 БЕКАП ДОКУМЕНТІВ: усі файли теки скопійовано в <бекап>/documents, маніфест називає кількість", () => {
  const src = mkdtempSync(path.join(tmpdir(), "docs-src-")); const dst = mkdtempSync(path.join(tmpdir(), "docs-dst-"));
  writeFileSync(path.join(src, "a.pdf"), "AAA"); writeFileSync(path.join(src, "b.html"), "<b>BB</b>"); mkdirSync(path.join(src, "sub")); writeFileSync(path.join(src, "sub", "c.txt"), "no");
  const r = copyDocuments(src, dst);
  assert.deepEqual(r, { copied: 2, bytes: 3 + 9, missingDir: false }, "порахувало не те, що скопіювало");
  assert.deepEqual(readdirSync(path.join(dst, "documents")).sort(), ["a.pdf", "b.html"], "у копії не ті файли");
  assert.equal(readFileSync(path.join(dst, "documents", "a.pdf"), "utf8"), "AAA", "вміст не той");
  assert.match(manifestLine(r), /documents files: 2 \(12 bytes\)/);
  const none = copyDocuments(path.join(src, "nope"), dst);
  assert.equal(none.missingDir, true); assert.match(manifestLine(none), /тека відсутня/);
  assert.equal(existsSync(path.join(dst, "documents", "c.txt")), false, "підтека скопійована — а має лишатись поза копією");
});
