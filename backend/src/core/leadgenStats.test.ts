import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pct, LEADGEN_CALL_MIN_SEC, LEADGEN_CONVERSION_TARGETS } from "./leadgenStats.js";

/**
 * #343…#344b — ЛІДОГЕНЕРАЦІЯ: сім показників із подій CRM.
 *
 * Гейти стережуть рівно те, на чому цей екран може тихо збрехати: підміну стадії,
 * підміну означення «успішного дзвінка» і повернення до `funnel_stage`, який
 * склеює два різні показники в один.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");

test("#343 КОНВЕРСІЯ: нульовий знаменник дає null, а не 0 %", () => {
  // По один бік межі — рахується.
  assert.equal(pct(578, 2250), 25.7, "🔴 конверсія порахована неправильно");
  assert.equal(pct(1, 3), 33.3, "🔴 округлення не до десятої");
  assert.equal(pct(0, 10), 0, "🔴 чесний нуль при ненульовому знаменнику зник");
  // По другий — «нема з чого рахувати» ≠ «нуль». Нуль на екрані читається як провал
  // людини; «—» читається як відсутність даних. Це різні повідомлення.
  for (const whole of [0, -1]) {
    assert.equal(pct(5, whole), null,
      `🔴 знаменник ${whole} дав число — екран показав би 0 % там, де рахувати нема з чого`);
  }
});

test("#343b 🪞 ДЗЕРКАЛО: стадії — ті самі id, що заміряні на проді", async () => {
  const m = await import("./metrics.js");
  // Підміна будь-якого — це тихо інший показник під тією ж назвою.
  assert.equal(m.PZ_TAKEN, 69693696, "🔴 «Взято в роботу» більше не той статус");
  assert.equal(m.PZ_OPR, 69716492, "🔴 «Отримано контакти ОПР» більше не той статус");
  assert.equal(m.REACT_WARMING, 69693740, "🔴 «Клієнт підігрівається» більше не той статус");
  assert.ok(m.PRODZVIN_PIPELINES.includes(8921936), "🔴 воронка Продзвіну зникла з переліку");
  assert.ok(m.REACTIVATION_PIPELINES.includes(8921948), "🔴 воронка Реактивації зникла з переліку");
  assert.notEqual(m.PZ_OPR, m.PZ_TAKEN, "🔴 два різні показники вказують на один статус");
});

test("#344 ЯДРО ЛІДОГЕНУ НЕ РАХУЄ ПО funnel_stage — там ОПР і прорахунки склеєні", () => {
  const src = SRC("core/leadgenStats.ts");
  assert.ok(src.length > 500, "🔴 джерело ядра не прочиталось — гейту не було що перевіряти");
  // `pipeline_stage_map` веде і 69716492, і 142 в один `quote_requested`
  // (`seedKommoMapping.sql:48-53`), тож будь-яке повернення до `funnel_stage` тихо
  // склеїть «ОПР» і «Передано на прорахунок» в одне число.
  assert.ok(!/funnel_stage/.test(src),
    "🔴 ядро знову читає funnel_stage — ОПР і прорахунки склеяться в один показник");
  // І друга половина: id стадій беруться з ядра метрик, а не вписані числом.
  assert.ok(/PZ_TAKEN|PZ_OPR|REACT_WARMING/.test(src), "🔴 стадії більше не з ядра метрик");
  assert.ok(!/\b69693696\b|\b69716492\b|\b69693740\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "🔴 id стадії вписаний числом у код — друга копія правила розійдеться тихо");
});

test("#344b 🪞 ДЗЕРКАЛО: «успішний дзвінок» тримається на ОБОХ умовах — напрямок і поріг", () => {
  const src = SRC("core/leadgenStats.ts");
  // Поріг виведено з заміру: вихідні >= 20 c дають 3 604 проти 3 627 у таблиці лідгенів
  // за серпень (0.6 %). Сусідні пороги промахуються в рази, тож обидві умови несучі.
  assert.equal(LEADGEN_CALL_MIN_SEC, 20, "🔴 поріг успішного дзвінка зрушив — число розійдеться з таблицею");
  assert.ok(/call_type\s*=\s*'out'/.test(src),
    "🔴 зник напрямок: вхідні й транзитні почнуть рахуватись як робота лідгена");
  assert.ok(/billsec\s*>=/.test(src),
    "🔴 зник поріг тривалості: 44 % дзвінків лідгенів — нульові, вони роздують число вдвічі");
  // Цілі конверсій — рішення власника з таблиці, не число зі стелі.
  assert.equal(LEADGEN_CONVERSION_TARGETS.oprOfLeads, 40, "🔴 ціль «ліди → ОПР» зрушила");
  assert.equal(LEADGEN_CONVERSION_TARGETS.quotesOfOpr, 50, "🔴 ціль «ОПР → прорахунок» зрушила");
});
