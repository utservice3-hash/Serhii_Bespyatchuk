import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptBatch, cleanInterval, hostOnly, type IntervalPolicy } from "./intervalPolicy.js";

/**
 * #20 — КОНТРАКТ ПРИЙОМУ ІНТЕРВАЛІВ (трекер, Фаза 2).
 *
 * 🔴 НАВІЩО. Раніше `/heartbeat` віддавав самий `accepted`, а будь-яка аномалія
 * ставала `null` і зникала. Агент фізично не міг відрізнити «сервер прийняв 3 з 5»
 * від «я надіслав 3». Це той самий клас хибно-зеленого, що й скіп у наборі: нічого
 * не сталось — виглядає як усе гаразд.
 *
 * Найдорожче воно вилізло б саме зараз: ми просимо агента СКЛЕЮВАТИ сусідні
 * інтервали, а стара межа була 10 хв — тобто склеєні дані почали б зникати мовчки.
 *
 * Тести працюють БЕЗ БД і БЕЗ мережі (модуль без імпортів), тож виконуються в
 * кожному `npm test`, а не лише в прод-режимі.
 */

const CFG: IntervalPolicy = { maxIntervalSec: 900, maxClockSkewSec: 7200, sendTitles: false };
const NOW = Date.parse("2026-08-01T12:00:00Z");
const at = (offsetSec: number) => new Date(NOW + offsetSec * 1000).toISOString();
const iv = (o: Record<string, unknown> = {}) => ({
  startedAt: at(-300), endedAt: at(-240), state: "active", ...o,
});

test("#20 САБОТАЖ: інтервал на 20 хв потрапляє в rejected.tooLong, а не зникає", () => {
  // Рівно те, що станеться, якщо агент склеїть понад оголошену межу (900 с).
  const r = acceptBatch([iv({ startedAt: at(-1500), endedAt: at(-300) })], CFG, NOW);
  assert.equal(r.toInsert.length, 0, "інтервал на 20 хв не має потрапити в БД");
  assert.equal(r.rejected.tooLong, 1,
    "🔴 інтервал зник МОВЧКИ — агент не дізнається, що його дані не доїхали");
  assert.equal(r.rejected.badShape + r.rejected.clockSkew + r.rejected.overlapping, 0,
    "причина має бути названа ТОЧНО: 20 хв — це tooLong, а не «щось не так»");
});

test("#20b САБОТАЖ: зсув годинника на 5 год потрапляє в rejected.clockSkew", () => {
  // Ноутбук зі збитим годинником поклав би роботу в чужу добу, і «Час у роботі»
  // показав би нічну зміну, якої не було.
  const past = acceptBatch([iv({ startedAt: at(-18060), endedAt: at(-18000) })], CFG, NOW);
  assert.equal(past.rejected.clockSkew, 1, "🔴 годинник у МИНУЛОМУ на 5 год не спіймано");
  const future = acceptBatch([iv({ startedAt: at(18000), endedAt: at(18060) })], CFG, NOW);
  assert.equal(future.rejected.clockSkew, 1,
    "🔴 годинник у МАЙБУТНЬОМУ не спіймано — перевіряти треба ОБИДВА кінці, "
    + "інакше зсув уперед проходить як норма");
  assert.equal(past.toInsert.length + future.toInsert.length, 0);
});

test("#20c ДЗЕРКАЛО: НОРМАЛЬНИЙ інтервал приймається", () => {
  // Без цієї пари #20/#20b зеленіли б і тоді, якби прийом відкидав ГЕТЬ УСЕ:
  // «нічого не збереглось» виглядало б як «аномалії відсіяно».
  const r = acceptBatch([iv()], CFG, NOW);
  assert.equal(r.toInsert.length, 1, `🔴 звичайний інтервал відхилено: ${JSON.stringify(r.rejected)}`);
  assert.deepEqual(r.rejected, { tooLong: 0, badShape: 0, overlapping: 0, clockSkew: 0 });
  // Рівно на межі — теж приймається (15 хв при maxIntervalSec=900).
  assert.equal(acceptBatch([iv({ startedAt: at(-900), endedAt: at(0) })], CFG, NOW).toInsert.length, 1,
    "🔴 інтервал РІВНО на межі відкинуто — межа має бути включною, інакше агент, "
    + "що склеює точно до maxIntervalSec, втрачатиме кожен такий блок");
});

test("#20d ОБЛІК СХОДИТЬСЯ: прийнято + відхилено == надіслано", () => {
  // Головна властивість контракту: агент може перевірити, що нічого не загубилось.
  const batch = [
    iv(),                                                    // ок
    iv({ startedAt: at(-1500), endedAt: at(-300) }),          // tooLong
    iv({ startedAt: at(-18060), endedAt: at(-18000) }),       // clockSkew
    iv({ state: "танцює" }),                                  // badShape
    iv({ startedAt: at(-100), endedAt: at(-40) }),            // ок
    iv({ startedAt: at(-80), endedAt: at(-20) }),             // overlapping із попереднім
    "не обʼєкт",                                              // badShape
  ];
  const r = acceptBatch(batch, CFG, NOW);
  const rej = r.rejected.tooLong + r.rejected.badShape + r.rejected.overlapping + r.rejected.clockSkew;
  assert.equal(r.toInsert.length + rej, batch.length,
    `🔴 облік не сходиться: прийнято ${r.toInsert.length} + відхилено ${rej} != надіслано ${batch.length}. `
    + "Саме ця рівність і дає агенту змогу побачити втрату.");
  assert.deepEqual(r.rejected, { tooLong: 1, badShape: 2, overlapping: 1, clockSkew: 1 });
});

test("#20e ПРИВАТНІСТЬ: у базу не їде ні шлях, ні заголовок", () => {
  // Умова власника: архіву того, які сторінки люди відкривають, ми не створюємо.
  assert.equal(hostOnly("https://kommo.com/leads/detail/12345?x=1"), "kommo.com");
  assert.equal(hostOnly("www.della.eu/gruz/98765"), "della.eu");
  assert.equal(hostOnly("lardi-trans.com"), "lardi-trans.com");
  assert.equal(hostOnly("   "), null);
  const r = cleanInterval(
    iv({ source: "https://kommo.com/leads/detail/12345", windowTitle: "Угода №4471 Іваненко І.І." }),
    CFG, NOW);
  assert.ok("ok" in r);
  assert.equal(r.ok.source, "kommo.com", "🔴 шлях доїхав до БД — це вже архів сторінок");
  assert.equal(r.ok.windowTitle, null,
    "🔴 заголовок збережено при sendTitles=false. Старий або чужий агент не має "
    + "обходити політику: рішення приймає СЕРВЕР, а не те, що надіслали");
});

test("#20f ДЗЕРКАЛО: з увімкненим прапорцем заголовок ЗБЕРІГАЄТЬСЯ", () => {
  // Інакше #20e зеленів би й тоді, коли поле зрізане завжди — тобто прапорець
  // у налаштуваннях був би декорацією, а ми б думали, що він працює.
  const r = cleanInterval(iv({ windowTitle: "Угода №4471" }), { ...CFG, sendTitles: true }, NOW);
  assert.ok("ok" in r);
  assert.equal(r.ok.windowTitle, "Угода №4471");
});
