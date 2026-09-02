import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAIL_MARK, failureNames } from "./testRunGate.js";

/**
 * 🏷 #270–#271b — ПЕРЕЛІК ПАДІНЬ І ВАРТОВИЙ ПОРОЖНЬОГО ПРОГОНУ.
 *
 * 🔴 ПРИВІД, ЗАМІРЯНИЙ 01.09.2026 І СПІЛЬНИЙ ДЛЯ ВСІХ ЧОТИРЬОХ ЧАТІВ. Розбір
 * `deploy-accept.log` виловлював імена падінь грепом по `✖` — символу, який малює
 * `spec`-репортер. Один чат отримав ОДИНАДЦЯТЬ «зелених» саботажів, бо в його режимі
 * цього символа не існувало: відсутність негативного рядка прочиталась як «усе добре».
 * Вирок при цьому був здоровий — його дає рядок «ВИКОНАЛОСЬ» і код виходу; брехав саме
 * ПЕРЕЛІК, і брехав у найгірший бік.
 *
 * 🔴 ЧОМУ ГЕЙТ САМЕ ТАКИЙ. Перевіряти «є рядок FAIL-GATE» замало: це стверджувало б
 * форму, а не властивість. Властивість тут одна — **перелік не залежить від того, чим
 * малюють вивід**. Тому обидва прогони роблять ОДНЕ Й ТЕ САМЕ на одних даних і
 * різняться РІВНО репортером, а зрівнюється результат розбору.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BE = ROOT;                       // каталог backend/
const GATE = join(ROOT, "dist", "testRunGate.js");

/**
 * Прогін фікстури з названим репортером. Повертає повний вивід і код виходу.
 *
 * 🔴 `NODE_TEST_CONTEXT` І `NODE_OPTIONS` ЗНІМАЮТЬСЯ, І ЦЕ НЕ ОХАЙНІСТЬ. Ці гейти самі
 * біжать усередині `node --test`, а дитина, що успадкувала `NODE_TEST_CONTEXT`, вважає
 * себе підпроцесом чужого прогону й перемикається на службовий репортер — наші
 * `--test-reporter` мовчки ігноруються, і вивід приходить ПОРОЖНІЙ. Спіймано на собі
 * 01.09.2026: руками все працювало, а з-під набору перелік був порожній.
 */
function runWith(reporter: string, dir: string, target?: string): { out: string; code: number } {
  const env: NodeJS.ProcessEnv = { ...process.env, TEST_SCOPE: "" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    const out = execFileSync(process.execPath, [
      `--test-reporter=${reporter}`, "--test-reporter-destination=stdout",
      `--test-reporter=${GATE}`, "--test-reporter-destination=stdout",
      "--test", target ?? join(dir, "fx.test.js"),
    ], { encoding: "utf8", env, cwd: BE });
    return { out, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", code: err.status ?? -1 };
  }
}

/**
 * ⚠️ У ТІЛІ ФІКСТУР ВИКЛИК НАЗИВАЄТЬСЯ `T`, А НЕ `test`, І ЦЕ НЕ СТИЛЬ.
 * Маніфест набору вишукує в зібраних файлах літерали `test("…")` і вимагає реєструвати
 * кожне знайдене імʼя. Фікстури — не гейти, реєструвати їх не можна; але записані як
 * `test("АЛЬФА…")` вони потрапляли б у той самий скан (спіймано 01.09.2026: маніфест
 * зажадав зареєструвати «АЛЬФА червоний» і «БЕТА зелений»). Псевдонім лишає фікстуру
 * робочою й невидимою для скану. Не «причісувати» назад.
 */
function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-"));
  writeFileSync(join(dir, "fx.test.js"),
    'import { test as T } from "node:test";\nimport assert from "node:assert/strict";\n' + body);
  return dir;
}

const TWO_FAIL = `
T("АЛЬФА червоний", () => { assert.equal(1, 2); });
T("БЕТА зелений", () => { assert.equal(1, 1); });
T("ГАМА червоний", () => { assert.equal("а", "б"); });
`;

test("#270 перелік падінь ОДНАКОВИЙ у tap і в spec — розбір не залежить від репортера", () => {
  const dir = fixture(TWO_FAIL);
  try {
    const tap = runWith("tap", dir);
    const spec = runWith("spec", dir);

    // Порожній скоуп = ПРОВАЛ: без цього рівність зійшлася б на «нуль == нуль».
    assert.deepEqual(failureNames(tap.out), ["АЛЬФА червоний", "ГАМА червоний"],
      "🔴 у режимі tap перелік не той — саме тут символьний розбір і порожнів мовчки");
    assert.deepEqual(failureNames(spec.out), failureNames(tap.out),
      "🔴 зміна репортера змінила ПЕРЕЛІК — значить, розбір знову спирається на малюнок, а не на подію");
    assert.equal(tap.code, 1, "🔴 падіння мусить давати ненульовий код виходу — друга, незалежна ознака");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#270b ДЗЕРКАЛО: зелений прогін не вигадує падінь, а розбір не бере чужі рядки", () => {
  const dir = fixture(`T("ТІЛЬКИ ЗЕЛЕНИЙ", () => { assert.ok(true); });`);
  try {
    const r = runWith("tap", dir);
    /**
     * 🔴 СПЕРШУ ДОВЕСТИ, ЩО ПРОГІН БУВ. Перша редакція цього дзеркала перевіряла лише
     * «імен падінь немає» — і проходила ВАКУУМНО на порожньому виводі, тобто хворіла
     * рівно тим, що весь цей файл і лікує: відсутність прочитана як «усе гаразд».
     */
    assert.match(r.out, /ТІЛЬКИ ЗЕЛЕНИЙ/,
      "🔴 фікстура не побігла — перевіряти «падінь немає» на порожньому виводі безглуздо");
    assert.deepEqual(failureNames(r.out), [],
      "🔴 на зеленому прогоні зʼявились імена падінь — маркер ліпиться не туди");
    assert.equal(r.code, 0, "🔴 зелений прогін мусить виходити нулем");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // Розбір бере РІВНО свій маркер: чужий текст із тим самим словом його не зрушує.
  assert.deepEqual(failureNames(`✖ АЛЬФА\nnot ok 1 - БЕТА\n${FAIL_MARK} ГАМА\n   ${FAIL_MARK} відступ`),
    ["ГАМА"], "🔴 розбір ловить рядки, які маркером не позначені");
});

test("#271 нуль виконаних НАЗИВАЄ СЕБЕ і виходить ненулем — разова команда теж має сторожа", () => {
  const dir = fixture(`T("СКІПНУТИЙ", { skip: "оточення не дає" }, () => { assert.ok(false); });`);
  try {
    const r = runWith("tap", dir);
    assert.equal(r.code, 1,
      "🔴 «виконалось 0» вийшло НУЛЕМ — саме так порожній прогін і вдає успіх");
    assert.match(r.out, /НІЧОГО НЕ ВИКОНАЛОСЬ/,
      "🔴 порожній прогін не назвав себе — читач побачить «0 падінь» і піде далі");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#271b ДВІ ПРИЧИНИ ПОРОЖНЕЧІ РОЗРІЗНЯЮТЬСЯ — і зелений прогін сторожа не будить", () => {
  // «Усе скіпнуто» веде до оточення, «нічого не знайдено» — до збірки чи шляху.
  // Спільний підпис для двох різних відмов ми вже одного разу купили дорого.
  const skipped = fixture(`T("С", { skip: "немає БД" }, () => {});`);
  try {
    assert.match(runWith("tap", skipped).out, /усі 1 тест\(ів\) СКІПНУТО/,
      "🔴 «все скіпнуто» подано як «нічого не знайдено» — читача пошлють лагодити не те");
  } finally { rmSync(skipped, { recursive: true, force: true }); }

  /**
   * 🔴 «НІЧОГО НЕ ЗНАЙДЕНО» — ЦЕ ПРО ГЛОБ, А НЕ ПРО ФАЙЛ, І ЦЕ ЗАМІРЯНО.
   * Файл БЕЗ жодного `test()` раннер рахує як ОДИН зелений тест (контейнер файлу),
   * тож `ran` там дорівнює 1 і вартовий мовчить — законно. Порожній прогін настає,
   * коли глоб не збіг нічого: саме так виглядає незібраний `dist` або одрук у шляху.
   */
  const nothing = runWith("tap", "", "dist/**/*.НЕМАЄ-ТАКОГО.js");
  assert.match(nothing.out, /не знайшов ЖОДНОГО тесту/,
    "🔴 глоб, що нічого не збіг, не назвав себе — саме тут «0 падінь» і вдає успіх");
  assert.equal(nothing.code, 1, "🔴 порожній прогін мусить виходити ненулем");

  const green = fixture(`T("З", () => { assert.ok(true); });`);
  try {
    assert.doesNotMatch(runWith("tap", green).out, /НІЧОГО НЕ ВИКОНАЛОСЬ/,
      "🔴 вартовий будиться на здоровому прогоні — його почнуть гортати очима");
  } finally { rmSync(green, { recursive: true, force: true }); }
});
