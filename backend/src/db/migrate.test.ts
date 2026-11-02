import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { provisionScratch, skipReason, type Unavailable } from "./scratchDb.js";

/**
 * ТЕСТ #8 — СХЕМА З НУЛЯ.
 *
 * Міграція має проходити на ПОРОЖНІЙ базі, а не лише «доїжджати» на наявній. Ми вже
 * ловили цей клас двічі: сид `key_card` стояв ПЕРЕД `INSERT` рахунків (на живій БД
 * працювало, на чистій лишались NULL), і `GRANT ... FROM ai_readonly` перелічував
 * `tracker_devices`, що створюються нижче (на живій проходило, на чистій — падало).
 *
 * 🔴 ЧОМУ ТЕПЕР БЕЗ TEST_SCRATCH_DB_URL. Раніше без цієї змінної тест ПРОПУСКАВСЯ —
 * і, оскільки її ніхто ніколи не ставив, «схема з нуля» не прогонялась ЖОДНОГО разу.
 * Скіп виглядав як страховка, а був порожнім рядком у наборі. Тепер базу піднімає
 * сам набір (`scratchDb.ts`), тож перевірка справді відбувається.
 *
 * 🔒 Бойова база не використовується НІКОЛИ: тільки власний тимчасовий кластер,
 * який ми ж і зносимо у `finally`.
 */

const SCHEMA = path.join(import.meta.dirname, "schema.sql");

/**
 * Прогнати міграцію на вказаній базі. Кидає з виводом, якщо впала.
 * `migrateJs` дозволяє вказати ІНШУ копію міграції (для #8b) — свідомо без env-хука
 * в самому `migrate.ts`: бойовий код не має вміти читати довільний файл схеми лише
 * заради тесту.
 */
function migrate(url: string, migrateJs = path.join(import.meta.dirname, "migrate.js")): string {
  return execFileSync(process.execPath, [migrateJs], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      // Міграції потрібен лише DATABASE_URL, але config.ts вимагає повний набір —
      // підставляємо явні пустушки, щоб тест не залежав від .env оточення.
      JWT_SECRET: "scratch", KOMMO_BASE_URL: "https://scratch.invalid", KOMMO_API_TOKEN: "scratch",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("#8 міграція проходить на ПОРОЖНІЙ базі повністю", async (t) => {
  const scratch = provisionScratch();
  if ("unavailable" in scratch) {
    // Скіп лишається можливим, але тепер він НАЗИВАЄ ПРИЧИНУ і не є станом за
    // замовчуванням: у дев-оточенні тест реально біжить.
    t.skip(skipReason(scratch));
    return;
  }
  try {
    const out = migrate(scratch.url);
    assert.match(out, /Migration applied/,
      `міграція не дійшла до кінця на порожній базі (${scratch.strategy}):\n${out}`);
  } finally {
    scratch.dispose();
  }
});

test("#8b ДЗЕРКАЛО: зламану схему тест ЛОВИТЬ, а не пропускає", async (t) => {
  // Без цієї пари #8 зеленів би і тоді, коли перевіряти вже нічого: якби migrate
  // ковтав помилки або ми дивились не на той вивід, «Migration applied» друкувалось
  // би однаково. Ламаємо схему СВІДОМО тим самим способом, який реально стався —
  // GRANT на таблицю, якої ще немає, — і вимагаємо падіння.
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const dir = mkdtempSync(path.join(tmpdir(), "uts-badschema-"));
  try {
    // Копія всього dist: `migrate.js` читає `schema.sql` поруч із собою і тягне
    // відносні імпорти (`./pool.js`, `../oneOnOne/catalog.js`), тож підмінити можна
    // лише цілим деревом.
    const distSrc = path.resolve(import.meta.dirname, "..");
    cpSync(distSrc, path.join(dir, "dist"), { recursive: true });
    // Копія лежить поза проєктом, тож `pg` та інші пакети не резолвляться. Симлінк на
    // справжній node_modules дешевший за копію і не смітить у репозиторії.
    symlinkSync(path.resolve(distSrc, "..", "node_modules"), path.join(dir, "node_modules"), "dir");
    const bad = path.join(dir, "dist", "db", "schema.sql");
    writeFileSync(bad, readFileSync(SCHEMA, "utf8")
      + "\nGRANT SELECT ON table_that_does_not_exist TO test_readonly;\n");
    let failed = false;
    let message = "";
    try { migrate(scratch.url, path.join(dir, "dist", "db", "migrate.js")); } catch (e) {
      failed = true;
      message = e instanceof Error ? `${e.message}` : String(e);
    }
    assert.ok(failed, "🔴 міграція зі ЗАВІДОМО зламаним GRANT «пройшла» — тест #8 нічого не доводить");
    assert.match(message, /table_that_does_not_exist|does not exist/,
      `міграція впала, але не на підкинутій помилці — перевірка дивиться не туди:\n${message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    scratch.dispose();
  }
});

/** Усі `ADD CONSTRAINT <імʼя> CHECK (<колонка> IN (...))` схеми по порядку: імʼя → списки значень у тому порядку, як ідуть у файлі. */
export function checkInLists(sql: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const m of sql.matchAll(/ADD CONSTRAINT (\w+)\s+CHECK\s*\(\s*\w+\s+IN\s*\(([^)]*)\)\s*\)/g)) {
    const vals = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    out.set(m[1], [...(out.get(m[1]) ?? []), vals]);
  }
  return out;
}

/**
 * #2973 — ПРОМІЖНИЙ CHECK НЕ ВУЖЧИЙ ЗА ПІДСУМКОВИЙ (02.11.2026). Схема ганяється ЦІЛОЮ на кожному викаті, тож CHECK, який
 * перестворюють кілька разів, на живій базі перевіряється і в РАННІЙ редакції. Вужчий ранній перелік мовчить, поки в
 * даних немає нового значення, і валить міграцію в день, коли воно зʼявляється: так 02.11 перший файл Реєстру УТБ
 * (`ba_files.owner_kind = 'utb'`) зупинив викат на кроці migrate з прод-сторінкою, що вже поїхала вперед.
 * Ширший ранній перелік — законний (`hiring_candidates_status_check`: старі статуси, поки дані не перенесено).
 * 🧨 Червоніє, якщо прибрати 'utb' з раннього `ba_files_owner_kind_check`.
 */
test("#2973 СХЕМА: кожна рання редакція CHECK вміщає всі значення підсумкової", () => {
  const sql = readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8");
  const lists = checkInLists(sql);
  assert.ok((lists.get("ba_files_owner_kind_check")?.length ?? 0) >= 2, "🔴 парсер не бачить перестворюваних CHECK — гейт осліп");
  const bad: string[] = [];
  for (const [name, eds] of lists) {
    const last = eds[eds.length - 1];
    eds.slice(0, -1).forEach((ed, i) => {
      const miss = last.filter((v) => !ed.includes(v));
      if (miss.length) bad.push(`${name} (редакція ${i + 1} з ${eds.length}) без: ${miss.join(", ")}`);
    });
  }
  assert.deepEqual(bad, [], "🔴 рання редакція CHECK вужча за підсумкову — міграція впаде, щойно в даних зʼявиться це значення");
  // Фікстура з обох боків межі: вужча рання — ловиться, ширша — ні.
  const narrow = checkInLists("ADD CONSTRAINT x CHECK (k IN ('a')); ADD CONSTRAINT x CHECK (k IN ('a','b'));").get("x")!;
  const wide = checkInLists("ADD CONSTRAINT y CHECK (k IN ('a','b','c')); ADD CONSTRAINT y CHECK (k IN ('a','b'));").get("y")!;
  assert.deepEqual(narrow[1].filter((v) => !narrow[0].includes(v)), ["b"]);
  assert.deepEqual(wide[1].filter((v) => !wide[0].includes(v)), []);
});
