import { test } from "node:test";
import assert from "node:assert/strict";
import { isSilentFileDeath } from "./testRunGate.js";

/**
 * 💀 #222–#222b — МОВЧАЗНА СМЕРТЬ ФАЙЛУ МУСИТЬ БУТИ НАЗВАНА.
 *
 * Привід: 25.08.2026 у `test:prod` двічі впав КОНТЕЙНЕР файлу (`reportTable`,
 * потім `legacyAnswers`) — усі підтести зелені, під контейнером рівно `'test failed'`,
 * без стека. Причина виявилась поза тестами: ліміт памʼяті LVE убивав процес
 * (`SIGKILL`, порожній stderr), бо `node --test` міряв паралельність по 48 ХОСТОВИХ
 * ядрах. Півдня пішло на те, що видно за секунду — якби раннер це назвав.
 *
 * 🔴 ДЗЕРКАЛО ТУТ ОБОВʼЯЗКОВЕ, і воно важливіше за пряму перевірку. Детектор, що
 * спрацьовує на БУДЬ-ЯКОМУ падінні, зробив би гірше: кожен звичайний червоний
 * пояснювався б «мабуть, памʼять», і справжня помилка з текстом читалась би як
 * інфраструктурна. Заміряно на сирих подіях: у справжнього падіння `cause` — це
 * `AssertionError` з текстом, у мертвого файлу — РІВНО рядок `"test failed"`.
 * `nesting` для розрізнення НЕ годиться: у звичайного тесту верхнього рівня він теж 0.
 */

test("#222 мертвий контейнер файлу впізнається за відсутністю причини", () => {
  assert.equal(isSilentFileDeath("reportTable.test.js", "test failed"), true);
  assert.equal(isSilentFileDeath("legacyAnswers.test.js", "  test failed  "), true,
    "🔴 пробіли навколо причини не мають ховати смерть");
  assert.equal(isSilentFileDeath("x.test.mjs", "test failed"), true);
});

test("#222b ДЗЕРКАЛО: звичайне падіння НЕ видається за смерть файлу", () => {
  // 1 · справжня помилка з текстом — причина є, отже це НЕ мовчазна смерть.
  assert.equal(isSilentFileDeath("reportTable.test.js",
    "AssertionError: справжня помилка\n\n1 !== 2\n"), false,
    "🔴 падіння з текстом прочитано як смерть — тоді кожен червоний списувався б на памʼять");
  // 2 · причина — обʼєкт помилки, а не рядок.
  assert.equal(isSilentFileDeath("reportTable.test.js", new Error("test failed")), false,
    "🔴 Error із таким же текстом — це НЕ порожня причина");
  // 3 · це не файл, а тест із такою назвою.
  assert.equal(isSilentFileDeath("#81 ТАБЛИЦЯ НЕ МАЄ ВЛАСНОГО ДЖЕРЕЛА", "test failed"), false,
    "🔴 звичайний тест прийнято за файл");
  // 4 · причини немає взагалі (undefined) — теж не наш випадок, бо не рядок.
  assert.equal(isSilentFileDeath("a.test.js", undefined), false);
});
