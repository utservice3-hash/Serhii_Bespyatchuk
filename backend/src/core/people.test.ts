import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPhoto, photoStoredName, nextPhotoState, photoDir, PHOTO_MAX_BYTES, type PhotoState } from "./peopleRules.js";
import { copyDocuments } from "../jobs/backupDocuments.js";

/**
 * 📷 ФОТО СПІВРОБІТНИКІВ — ЧИСТІ ПРАВИЛА (22.09.2026). Три гейти, кожен з прикладами по ОБИДВА боки межі.
 */

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

/**
 * #640 — ФАЙЛ ФОТО ПЕРЕВІРЯЄТЬСЯ ЗА БАЙТАМИ. JPEG/PNG/WebP проходять із правильним типом; PDF (його
 * `sniffFileMime` теж впізнає — саме тому він тут), текст, порожнеча й файл понад 5 МБ — відмова.
 * Межа 5 МБ — по обидва боки: рівно 5 МБ проходить, на байт більше — ні.
 */
test("#640 фото: приймаються лише JPEG/PNG/WebP за байтами, до 5 МБ включно", () => {
  assert.deepEqual(checkPhoto(JPEG), { ok: true, mime: "image/jpeg" });
  assert.deepEqual(checkPhoto(PNG), { ok: true, mime: "image/png" });
  assert.deepEqual(checkPhoto(WEBP), { ok: true, mime: "image/webp" });
  for (const [what, buf] of [["PDF", PDF], ["текст", new TextEncoder().encode("<svg onload=alert(1)>")], ["порожнеча", new Uint8Array(0)], ["null", null]] as const) {
    assert.equal(checkPhoto(buf as Uint8Array | null).ok, false, `🔴 ${what} прийнято як фото`);
  }
  const edge = new Uint8Array(PHOTO_MAX_BYTES); edge.set(JPEG);
  assert.equal(checkPhoto(edge).ok, true, "🔴 фото рівно 5 МБ відхилено");
  const over = new Uint8Array(PHOTO_MAX_BYTES + 1); over.set(JPEG);
  assert.equal(checkPhoto(over).ok, false, "🔴 фото понад 5 МБ прийнято");
});

/**
 * #641 — ФОТО ЛЯГАЄ ТУДИ, ЩО ЇДЕ В НІЧНИЙ БЕКАП. Бекап (`copyDocuments`) копіює лише ФАЙЛИ КОРЕНЯ
 * теки документів. Тому: (1) імʼя файлу — без жодного розділювача шляху, з префіксом `photo-`;
 * (2) файл із таким імʼям у корені справді потрапляє в копію, а в підтеці — ні (другий бік межі);
 * (3) тека фото — та сама, яку бере САМА джоба бекапу (`backupDb.DOCS_DIR`), а не переписана в тест формула.
 */
test("#641 фото: файл у корені теки документів — і нічний бекап його копіює", async () => {
  const name = photoStoredName("0f8b1c2d-aaaa-bbbb-cccc-1234567890ab", "image/jpeg");
  assert.match(name, /^photo-[0-9a-f-]{36}\.jpg$/, "🔴 імʼя файлу фото не того виду");
  assert.equal(path.basename(name), name, "🔴 імʼя фото містить шлях — файл ляже в підтеку, поза бекап");
  assert.match(photoStoredName("x", "image/png"), /\.png$/);
  assert.match(photoStoredName("x", "image/webp"), /\.webp$/);

  const src = mkdtempSync(path.join(tmpdir(), "photo-src-"));
  const dst = mkdtempSync(path.join(tmpdir(), "photo-dst-"));
  writeFileSync(path.join(src, name), JPEG);
  mkdirSync(path.join(src, "photos"));
  writeFileSync(path.join(src, "photos", "photo-in-subdir.jpg"), JPEG);
  copyDocuments(src, dst);
  assert.deepEqual(readdirSync(path.join(dst, "documents")), [name], "🔴 фото з кореня не потрапило в копію (або підтека потрапила — тоді межа гейта зсунулась)");

  // Звіряємо з ТІЄЮ текою, яку бере сама джоба бекапу (`jobs/backupDb.ts` → `DOCS_DIR`), а не з копією формули:
  // зміна будь-якого боку — фото чи бекапу — червоніє тут. `config` бекапу вимагає змінних — даємо заглушки.
  for (const k of ["DATABASE_URL", "JWT_SECRET", "KOMMO_BASE_URL", "KOMMO_API_TOKEN"]) process.env[k] ??= "test";
  const { DOCS_DIR: backupDir } = await import("../jobs/backupDb.js");
  assert.equal(path.resolve(photoDir()), path.resolve(backupDir), "🔴 тека фото ≠ тека, яку копіює нічний бекап");
  assert.equal(photoDir({ DOCS_DIR: "/srv/docs" }), "/srv/docs", "🔴 перемикач бекапу DOCS_DIR не веде за собою фото");
});

/**
 * #642 — КОЖНА ДІЯ З ФОТО СКАСОВНА. «Прибрати» → «Повернути попереднє» дає рівно той самий файл;
 * «Замінити» → «Повернути попереднє» — старе фото; повернення двічі — назад як було. І чесні відмови:
 * прибрати відсутнє чи повернути неіснуюче попереднє — помилка, а не мовчазний нуль.
 */
test("#642 фото: прибрати/замінити скасовуються «Повернути попереднє», нічого не губиться", () => {
  const run = (s: PhotoState, ...acts: Parameters<typeof nextPhotoState>[1][]) => acts.reduce((cur, a) => {
    const r = nextPhotoState(cur, a);
    assert.ok(r.ok, `🔴 дія ${a.kind} відхилена: ${r.ok ? "" : r.error}`);
    return r.state;
  }, s);
  const empty: PhotoState = { file: null, prev: null };
  const a = run(empty, { kind: "upload", file: "photo-a.jpg" });
  assert.deepEqual(a, { file: "photo-a.jpg", prev: null });
  assert.deepEqual(run(a, { kind: "remove" }, { kind: "restore" }), { file: "photo-a.jpg", prev: null }, "🔴 «Прибрати» незворотне");
  const b = run(a, { kind: "upload", file: "photo-b.jpg" });
  assert.deepEqual(b, { file: "photo-b.jpg", prev: "photo-a.jpg" }, "🔴 заміна загубила попереднє фото");
  assert.deepEqual(run(b, { kind: "restore" }), { file: "photo-a.jpg", prev: "photo-b.jpg" });
  assert.deepEqual(run(b, { kind: "restore" }, { kind: "restore" }), b, "🔴 повернення двічі не повертає як було");
  // Прибране фото не губиться, навіть якщо після нього завантажили нове.
  assert.deepEqual(run(a, { kind: "remove" }, { kind: "upload", file: "photo-c.jpg" }), { file: "photo-c.jpg", prev: "photo-a.jpg" });
  assert.equal(nextPhotoState(empty, { kind: "remove" }).ok, false, "🔴 «прибрати» відсутнє фото — не помилка");
  assert.equal(nextPhotoState(a, { kind: "restore" }).ok, false, "🔴 «повернути» без попереднього — не помилка");
});
