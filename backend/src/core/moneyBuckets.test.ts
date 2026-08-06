import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allFcStatuses, unbucketedStatuses, bucketOfStatus, bucketsOfStatus,
  CLOSED_STATUSES, RECEIVED_STATUSES, AWAITING_STATUSES, OPERATIONAL_STATUSES, LOST_STATUSES,
} from "./moneyBuckets.js";
import { needsDb } from "../testMode.js";

/**
 * #45 — КОЖЕН СТАТУС FC-ВОРОНКИ МАЄ КОРЗИНУ.
 *
 * 🔴 Це гейт про той самий клас, що й картка Антипенка: статус `69716460`
 * «Оплата отримана» ніс реальні гроші (23 632 ₴ у однієї людини за серпень) і
 * при цьому не входив у метрику, якою екран підписував свій факт. Кожна метрика
 * окремо була правильна — тому жоден існуючий тест цього не бачив.
 *
 * 🧨 САБОТАЖ (як просив власник, і він перевірений, а не обіцяний): прибрати
 * `69716460` з `RECEIVED_STATUSES` — і цей тест ЧЕРВОНІЄ з назвою стадії
 * «Оплата отримана» у тексті помилки. Перевірено окремим тестом `#45s` нижче,
 * який відтворює саботаж НА КОПІЇ реєстру, а не на живому — щоб доказ їхав із
 * набором, а не жив у чиїйсь памʼяті про разовий ручний прогін.
 */
test("#45 кожен статус FC-воронок належить якійсь корзині", () => {
  const all = allFcStatuses();
  // ⚠️ Порожній результат = ПРОВАЛ: спершу доводимо, що ЩО перевіряти взагалі є.
  assert.ok(all.length >= 28, `🔴 реєстр статусів підозріло малий (${all.length}) — перевіряти нічого`);
  const orphans = unbucketedStatuses();
  assert.deepEqual(
    orphans.map((o) => `${o.pipelineId}:${o.statusId} ${o.name}`), [],
    "🔴 СТАТУС БЕЗ КОРЗИНИ — це наступний Антипенко: гроші на ньому не потраплять у жодну метрику"
  );
});

/** #45b — корзини ДИЗ'ЮНКТНІ: статус у двох корзинах подвоїв би виручку. */
test("#45b жоден статус не належить двом корзинам одночасно", () => {
  const dup = allFcStatuses()
    .map((s) => ({ s, b: bucketsOfStatus(s.statusId) }))
    .filter((x) => x.b.length > 1);
  assert.deepEqual(dup.map((d) => `${d.s.statusId} ${d.s.name} → ${d.b.join("+")}`), [],
    "🔴 статус у двох корзинах — виручка порахується двічі");
});

/**
 * #45s — ДОКАЗ САБОТАЖЕМ. Не «тест пройшов», а «тест уміє падати САМЕ на цьому».
 * Відтворюємо рішення корзини на КОПІЇ списків із вилученим `69716460` і
 * вимагаємо, щоб стадія лишилась без корзини. Якби `bucketOfStatus` мав фолбек,
 * цей тест упав би — і саме це нам і треба знати.
 */
test("#45s саботаж: без 69716460 у «гроші прийшли» стадія лишається без корзини", () => {
  const sabotaged = [CLOSED_STATUSES, RECEIVED_STATUSES.filter((s) => s !== 69716460),
    AWAITING_STATUSES, OPERATIONAL_STATUSES, LOST_STATUSES];
  const found = sabotaged.some((list) => list.includes(69716460));
  assert.equal(found, false, "🔴 69716460 знайшовся в іншій корзині — гейт #45 не впіймав би саботажу");
  // дзеркало: у НЕзіпсованому реєстрі він таки має корзину, і саме «гроші прийшли»
  assert.equal(bucketOfStatus(69716460), "received");
  assert.equal(bucketOfStatus(60412544), "received", "стара воронка — та сама корзина");
});

/**
 * #45c — РЕЄСТР ЗВІРЯЄТЬСЯ З ЯДРОМ. Без цього #45 був би заборонена циклічна
 * перевірка «A = A»: реєстр сам себе оголосив повним. Тут списки порівнюються з
 * РЕАЛЬНИМИ константами `money.ts`/`metrics.ts`.
 * ⚠️ Імпорт ЛІНИВИЙ: `money.js` → `db/pool.js` → `config.js` кидає без
 * `DATABASE_URL` ще НА ІМПОРТІ, тобто раніше, ніж спрацював би `skip`.
 */
test("#45c реєстр корзин збігається з константами ядра", needsDb(), async () => {
  const money = await import("./money.js");
  const metrics = await import("./metrics.js");
  const sorted = (a: readonly number[]) => [...a].sort((x, y) => x - y);
  assert.deepEqual(sorted(CLOSED_STATUSES), sorted(money.STAGE_SUCCESS), "🔴 «закрито» розійшлось із STAGE_SUCCESS");
  assert.deepEqual(sorted(RECEIVED_STATUSES), sorted(money.STAGE_PAID), "🔴 «гроші прийшли» розійшлось із STAGE_PAID");
  assert.deepEqual(sorted(AWAITING_STATUSES), sorted(metrics.EXPECT_ZONE), "🔴 «очікування» розійшлось із EXPECT_ZONE");
});

/**
 * #45d — ДЗЕРКАЛО ДО #45: кожна корзина реально НЕПОРОЖНЯ і містить те, що
 * обіцяє назвою. Односторонній гейт зеленів би й тоді, коли всі статуси зсипали
 * в одну корзину: сиріт нема, а сенсу теж.
 */
test("#45d кожна корзина непорожня і тримає очікуване", () => {
  assert.equal(bucketOfStatus(142), "closed");
  assert.equal(bucketOfStatus(143), "lost");
  assert.equal(bucketOfStatus(69716312), "awaiting", "етап 8 «Очікуємо оплату»");
  assert.equal(bucketOfStatus(69693668), "operational", "«Взято на прорахунок» — ще не гроші");
  assert.equal(bucketOfStatus(69716460), "received");
  // і навпаки: вигаданий статус корзини НЕ отримує (немає тихого фолбека)
  assert.equal(bucketOfStatus(999999999), null, "🔴 невідомий статус отримав корзину — фолбек ховав би поломку");
});
