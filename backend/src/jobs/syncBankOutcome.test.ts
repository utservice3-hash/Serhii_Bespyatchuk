import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { syncBankOutcome } from "./syncBankOutcome.js";

/**
 * 🔗 #660 — фікстура по ОБИДВА боки межі, інакше гейт доводив би лише те, що функція
 * щось повертає (правило 11). Червоніє, якщо збій рахунку знову стане «не помилкою»,
 * або якщо помилка перестане називати рахунок (тоді людина не знатиме, куди дивитись),
 * або якщо рахунок без токена почне валити джобу (пропуск за налаштуванням — не збій).
 */
test("#660 SYNCBANK: збій одного рахунку з токеном — помилка з його назвою; усі в порядку — успіх; без токена — не помилка", () => {
  const one = syncBankOutcome({ failed: [{ label: "ТОВ ЮТС", error: "privat 503" }], noToken: [] });
  assert.equal(one.ok, false, "збій рахунку з токеном мусить бути помилкою джоби");
  assert.match((one as { error: string }).error, /ТОВ ЮТС/, "помилка називає рахунок");
  assert.match((one as { error: string }).error, /privat 503/, "помилка несе причину");

  const two = syncBankOutcome({ failed: [{ label: "ТОВ ЮТС", error: "privat 503" }, { label: "ТОВ Автомув", error: "timeout" }], noToken: [] });
  assert.equal(two.ok, false);
  assert.match((two as { error: string }).error, /2 рах/, "лічильник збоїв у тексті");
  assert.match((two as { error: string }).error, /Автомув/, "усі рахунки, що впали, названі");

  assert.deepEqual(syncBankOutcome({ failed: [], noToken: [] }), { ok: true }, "усі рахунки в порядку — успіх");
  assert.deepEqual(syncBankOutcome({ failed: [], noToken: ["ФОП Беспятчук (Моно)"] }), { ok: true },
    "рахунок без токена — свідомий пропуск, не збій");
});

/**
 * 🪞 #660b — ДЖЕРЕЛО `syncBank.ts` справді кличе рішення й кидає його помилку. Без цього
 * #660 зеленів би на чистій функції, яку ніхто не викликає — рівно стан до 22.09.2026,
 * коли `catch` мовчки клав назву в масив. Межа слова (`\b`) — щоб перейменування на
 * `syncBankOutcome_OFF` не читалось як присутність (правило ① з testing.md).
 */
test("#660b 🪞 ДЖЕРЕЛО: syncBank кличе syncBankOutcome і кидає його помилку, а не ковтає в catch", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "..", "..", "src", "jobs", "syncBank.ts"), "utf8");
  assert.match(src, /\bsyncBankOutcome\(\{ failed, noToken: skipped \}\)/, "джоба віддає рішенню збої й пропуски");
  assert.match(src, /if \(!outcome\.ok\) throw new Error\(outcome\.error\)/, "не-ок → помилка джоби (runJob запише last_error)");
  assert.doesNotMatch(src, /catch \(e\) \{[^}]*skipped\.push\(acc\.label\)/s,
    "збій рахунку більше не маскується під пропуск у catch");
});
