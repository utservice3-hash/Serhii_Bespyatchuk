import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_ADMIN_ACTIONS, CLIENT_ADMIN_LOG_SQL } from "./clientAdminLog.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Джерело шукається ПЕРЕБОРОМ коренів: набір біжить із `dist`, а перевіряти треба `.ts`.
 * Не знайшли — `assert.fail`, а не мовчазний пропуск: перевірка, яка тихо не виконалась,
 * гірша за її відсутність. Спіймано на собі 05.09.2026 — читання «поруч із dist» дало ENOENT.
 */
const SRC_ROOTS = [
  path.join(import.meta.dirname, "..", ".."),
  path.join(import.meta.dirname, "..", "..", ".."),
  path.join(import.meta.dirname, "..", "..", "..", ".."),
];
function readSrc(rel: string): string {
  for (const r of SRC_ROOTS) {
    try { return readFileSync(path.join(r, rel), "utf8"); } catch { /* далі */ }
  }
  assert.fail(`не знайдено ${rel} — перевірка не має права мовчки пропускатись`);
}

/**
 * #339 — ЖУРНАЛ НАКРИВАЄ ВСІ ТРИ ДІЇ, І ЖОДНА З НИХ НЕ ПИШЕ «В НІКУДИ».
 *
 * 📐 Привід (рішення власника 05.09.2026 — окремий журнал, не `access_audit`): повернення
 * з архіву ЗАНУЛЯЄ `archived_at`, `archive_reason` і `archived_by`. Тобто після нього з
 * бази неможливо дізнатись, що клієнт узагалі був в архіві, хто його поклав і чому. Стан
 * не є історією, і тут це видно буквально: історія стиралась дією.
 *
 * 🔴 ПЕРЕВІРЯЄМО ОБИДВА БОКИ (правило 12: перелічувач має сліпу зону).
 * ① кожна дія зі списку справді викликається в роуті — інакше «журнал є», а рядків немає;
 * ② у роуті немає виклику з дією ПОЗА списком — інакше `CHECK` у базі відкине запис
 *    мовчки (журнал не кидає помилку назовні за побудовою), і слід зникне саме тоді,
 *    коли він найпотрібніший.
 *
 * ⚠️ ЧОГО ЦЕЙ ГЕЙТ НЕ ДОВОДИТЬ: що виклик справді ВИКОНАВСЯ. Це звірка переліку дій із
 * місцями виклику, а не прогін роута — доказ виконання дала б лише жива дія на проді.
 * Названо прямо, щоб зелене тут не читали як «журнал працює».
 */
test("#339 журнал накриває архів, повернення й зміну відповідального — і нічого зайвого", () => {
  const src = readSrc("src/routes/dashboard.ts");
  const called = [...src.matchAll(/logClientAdmin\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(called.length >= 3, `🔴 у роутах лише ${called.length} виклик(и) журналу — дія без сліду лишилась`);
  for (const a of CLIENT_ADMIN_ACTIONS) {
    assert.ok(called.includes(a), `🔴 дію «${a}» ніхто не пише в журнал — вона лишиться без сліду`);
  }
  for (const c of called) {
    assert.ok((CLIENT_ADMIN_ACTIONS as readonly string[]).includes(c),
      `🔴 дія «${c}» не входить у CHECK таблиці — база відкине запис, і журнал промовчить про це`);
  }
});

/**
 * #340 — 🪞 ДЗЕРКАЛО: журнал не підмінений `access_audit`.
 *
 * `access_audit.target_type` має CHECK IN ('user','role'), тож клієнт туди не влазить без
 * послаблення обмеження на таблиці ПРАВ. Гейт стереже саме цю межу: спроба писати дії по
 * клієнтах у журнал доступів або впаде на CHECK, або (гірше) призведе до послаблення
 * обмеження, яке стереже зовсім інше.
 */
test("#340 🪞 дії по клієнтах ідуть в окрему таблицю, не в журнал доступів", () => {
  assert.match(CLIENT_ADMIN_LOG_SQL, /INSERT INTO client_admin_log/,
    "🔴 журнал пише не у свою таблицю");
  assert.doesNotMatch(CLIENT_ADMIN_LOG_SQL, /access_audit/,
    "🔴 дії по клієнту поїхали в журнал доступів — це послаблення таблиці прав заради запису про клієнта");
  const schema = readSrc("src/db/schema.sql");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS client_admin_log/,
    "🔴 таблиці журналу немає в схемі — на чистій базі запис падатиме, а журнал це проковтне мовчки");
  for (const a of CLIENT_ADMIN_ACTIONS) {
    assert.ok(schema.includes(`'${a}'`), `🔴 дія «${a}» не дозволена CHECK-ом у схемі — записи по ній зникатимуть`);
  }
});
