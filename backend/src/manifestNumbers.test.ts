import { test } from "node:test";
import assert from "node:assert/strict";
import { MANIFEST_TESTS, collidingNumbers, KNOWN_NUMBER_COLLISIONS } from "./testManifest.js";

/**
 * 🔢 #223–#223b — ОДИН НОМЕР = ОДИН ГЕЙТ.
 *
 * Привід і механізм — у коментарі до `collidingNumbers`. Тут важливе інше:
 * 🔴 ПОВІДОМЛЕННЯ МУСИТЬ НАЗВАТИ ОБОХ ВЛАСНИКІВ. Гейт, що каже лише «номер #30
 * зайнятий двічі», повторив би ваду, на якій ми спіймались того ж дня: вартовий
 * правильно відмовляв, а підказкою вів перевіряти `.env`, поки вмирали файли.
 * Той, хто читає падіння, має бачити ОБИДВА імені й одразу знати, що перейменувати.
 */

test("#223 новий номер не зіштовхується з уже зайнятим", () => {
  const found = collidingNumbers(MANIFEST_TESTS);
  const known = new Set(KNOWN_NUMBER_COLLISIONS);
  const fresh = [...found].filter(([tok]) => !known.has(tok));

  assert.deepEqual(fresh.map(([tok]) => tok), [],
    "🔴 НОВЕ ЗІТКНЕННЯ НОМЕРІВ:\n"
    + fresh.map(([tok, names]) =>
        `   ${tok} — ${names.length} власники:\n` + names.map((n) => `      • ${n}\n`).join(""))
        .join("")
    + "   Номер у виводі падіння — це адреса. Дай новому гейту вільний номер\n"
    + "   і онови testManifest; якщо зіткнення свідоме — внеси його в\n"
    + "   KNOWN_NUMBER_COLLISIONS з поясненням.");
});

test("#223b ДЗЕРКАЛО: гейт ловить підкинуте зіткнення, а реєстр не є смітником", () => {
  // 1 · 🧨 САБОТАЖ: підкидаємо новий дубль — мусить бути помічений і НАЗВАНИЙ.
  const sabotage = [...MANIFEST_TESTS, "#222 інший гейт із тим самим номером"];
  const found = collidingNumbers(sabotage);
  assert.ok(found.has("#222"), "🔴 підкинуте зіткнення не помічене — гейт вироджений");
  assert.equal(found.get("#222")!.length, 2);
  // обидва власники мусять бути в переліку, інакше повідомлення не скаже, що робити
  assert.ok(found.get("#222")!.some((n) => n.includes("мертвий контейнер")),
    "🔴 у переліку немає ПЕРШОГО власника — читач не дізнається, з чим зіткнувся");

  // 2 · ТОКЕНІЗАЦІЯ: крапкові підномери й суфікси з цифрою — це РІЗНІ гейти.
  const distinct = collidingNumbers(["#5.1 а", "#5.2 б", "#99b в", "#99b2 г"]);
  assert.deepEqual([...distinct.keys()], [],
    "🔴 #5.1/#5.2 або #99b/#99b2 прочитано як один номер — на такій токенізації "
    + "гейт дав би 16 фальшивих зіткнень і його б вимкнули");

  // 3 · РЕЄСТР НЕ СМІТНИК: кожен запис досі має бути справжнім зіткненням.
  const real = collidingNumbers(MANIFEST_TESTS);
  const dead = KNOWN_NUMBER_COLLISIONS.filter((t) => !real.has(t));
  assert.deepEqual(dead, [],
    `🔴 у реєстрі є мертві записи: ${dead.join(", ")}. Зіткнення розчищене — прибери рядок, `
    + "інакше він тихо дозволить НОВЕ зіткнення на тому самому номері.");
});
