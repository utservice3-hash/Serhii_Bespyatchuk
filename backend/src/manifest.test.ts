import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILES, MANIFEST_TESTS, MANIFEST_SECURITY_TABLES } from "./testManifest.js";

/**
 * ПЕРЕВІРКА МАНІФЕСТУ — «зелений» має означати «пройшло», а не «не існує».
 *
 * Читаємо ЗІБРАНІ файли набору (`dist/**\/*.test.js` — той самий глоб, що й `npm test`)
 * і звіряємо з маніфестом у ДВА боки:
 *   • немає очікуваного → червоний, з назвою відсутнього;
 *   • з'явився незареєстрований → теж червоний: склад набору змінюють свідомо.
 *
 * ⚠️ Тести, що народжуються ЦИКЛОМ (по таблиці на ітерацію в `ai/metricTools.test.ts`),
 * статично у файлі не видно. Тому окремо звіряємо джерело циклу — `FORBIDDEN_TABLES`.
 * Без цього хтось скоротив би список таблиць, тестів стало б менше, а набір лишався
 * б зеленим — рівно та діра, яку маніфест і закриває.
 */

const DIST = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

/** Файли набору, як їх бачить раннер (шляхи відносно dist, у POSIX-вигляді). */
function suiteFiles(): string[] {
  return walk(DIST)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.relative(DIST, f).split(path.sep).join("/"))
    .sort();
}

/**
 * Імена з `test("…")` у зібраному файлі. Шаблонні літерали з підстановкою (`${…}`)
 * ВІДКИДАЄМО: це імена динамічних тестів, у файлі вони існують як шаблон, а не як
 * готове ім'я. Їх покриває окремий тест по джерелу циклу — інакше маніфест вимагав
 * би зареєструвати рядок «#6 БЕЗПЕКА · «${table}» …», якого в прогоні не буває.
 */
function declaredTests(file: string): string[] {
  // Коментарі зрізаємо ДО розбору: у власній документації трапляється приклад
  // `test("…")`, і без цього маніфест ловив сам себе — вимагав зареєструвати
  // неіснуючий тест з іменем «…».
  const src = readFileSync(path.join(DIST, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // ⚠️ `(?<![.\w])` — щоб не зловити ЧУЖИЙ `.test(...)`: у `gates.test.ts` є
  // `METRIC_SQL.test("SELECT SUM(price)…")`, і без цього маніфест вимагав би
  // зареєструвати SQL-рядок як назву тесту.
  //
  // ⚠️ АЛЕ `t.test(...)` — ЦЕ ПІДТЕСТ node:test, і його реєструвати ТРЕБА. Без
  // цього винятку маніфест не бачив би #25b/#25c: вони живуть підтестами, бо
  // всі три ділять ОДИН кластер (`db/pool.js` — синглтон). Зникнення підтесту
  // має червонити так само, як зникнення звичайного — інакше під виглядом
  // «рефакторингу в підтести» з набору можна тихо винести що завгодно.
  return [...src.matchAll(/(?:(?<![.\w])|(?<=\bt\.))test\(\s*(["`])((?:(?!\1)[\s\S])*?)\1/g)]
    .map((m) => m[2])
    .filter((name) => !name.includes("${"));
}

/**
 * `FORBIDDEN_TABLES` читаємо з ТЕКСТУ зібраного модуля, а не імпортом: `metricTools.js`
 * тягне `db/pool.js` → `config.js`, який кидає на відсутньому DATABASE_URL ще НА
 * ІМПОРТІ. Маніфест мусить працювати без БД — інакше він сам стане тим, що мовчки
 * не виконується.
 */
function forbiddenTablesFromSource(): string[] {
  const src = readFileSync(path.join(DIST, "ai/metricTools.js"), "utf8");
  const m = src.match(/FORBIDDEN_TABLES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, "у metricTools.js не знайдено FORBIDDEN_TABLES — маніфест не може звірити склад");
  return [...m![1].matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]);
}

test("МАНІФЕСТ: усі очікувані ФАЙЛИ на місці", () => {
  const found = suiteFiles();
  assert.ok(found.length > 0, "у dist не знайдено жодного *.test.js — набір порожній, це ПРОВАЛ");
  const missing = MANIFEST_FILES.filter((f) => !found.includes(f));
  const extra = found.filter((f) => !MANIFEST_FILES.includes(f));
  assert.deepEqual(missing, [],
    `🔴 файли набору ЗНИКЛИ (видалені? не зібрались?): ${missing.join(", ")}`);
  assert.deepEqual(extra, [],
    `файли набору не зареєстровані в маніфесті: ${extra.join(", ")} — додай їх у testManifest.ts`);
});

test("МАНІФЕСТ: усі очікувані ТЕСТИ оголошені", () => {
  const found = suiteFiles().flatMap((f) => declaredTests(f));
  assert.ok(found.length > 0, "у зібраних файлах не знайдено жодного test(…) — набір порожній");

  const missing = MANIFEST_TESTS.filter((t) => !found.includes(t));
  const extra = found.filter((t) => !MANIFEST_TESTS.includes(t));

  assert.deepEqual(missing, [],
    "🔴 ТЕСТИ З МАНІФЕСТУ ВІДСУТНІ У НАБОРІ — «зелено» було б хибним:\n  " + missing.join("\n  "));
  assert.deepEqual(extra, [],
    "тести не зареєстровані в маніфесті (додай у testManifest.ts, щоб склад набору лишався свідомим):\n  "
      + extra.join("\n  "));

  // Дублікати імен зробили б «відсутній» невидимим: один тест прикрив би інший.
  const dupes = found.filter((t, i) => found.indexOf(t) !== i);
  assert.deepEqual([...new Set(dupes)], [], `однакові імена тестів: ${[...new Set(dupes)].join(", ")}`);
});

test("МАНІФЕСТ: динамічні тести безпеки розгортаються по всіх таблицях", () => {
  const tables = forbiddenTablesFromSource();
  assert.deepEqual([...tables].sort(), [...MANIFEST_SECURITY_TABLES].sort(),
    "🔴 склад FORBIDDEN_TABLES розійшовся з маніфестом — кількість тестів безпеки змінилась мовчки");

  // Цикл має бути на місці: якщо його прибрати, 8 тестів зникнуть, а статичні імена
  // маніфесту лишаться цілими — тобто перевірка вище цього НЕ побачить.
  const src = readFileSync(path.join(DIST, "ai/metricTools.test.js"), "utf8");
  assert.match(src, /for\s*\(\s*const\s+table\s+of/,
    "цикл, що породжує по тесту на таблицю, зник із metricTools.test.js");
  assert.match(src, /#6 БЕЗПЕКА/, "шаблон імені динамічного тесту безпеки змінився або зник");
});
