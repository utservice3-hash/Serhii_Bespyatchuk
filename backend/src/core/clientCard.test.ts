import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

/**
 * ГЕЙТИ КАРТКИ КЛІЄНТА — «як він платив» (12 міс. + останні угоди).
 *
 * Питання, на яке відповідають ці тести, одне: чи гістограма картки — ТА САМА
 * цифра, що факт на екрані планів і у Звіті, чи схожа. Розійдуться — і власник
 * побачить на одному екрані два «липні».
 *
 * Імпорти ліниві: `core/money.js` тягне `db/pool.js` → `config.js`, який кидає без
 * `DATABASE_URL` ще НА ІМПОРТІ, тобто раніше, ніж спрацює skip.
 */
const loadMoney = () => import("./money.js");

/** Місяць, за який рахуємо, і діапазон 12 міс. назад від нього. */
const MONTH = "2026-07";
const RANGE = { from: "2025-08-01", to: "2026-07-31" };

/** Клієнт для проби — беремо найбільшого за фактом, а не зашитого поіменно. */
async function biggestClient(): Promise<{ key: string; revenue: number }> {
  const M = await loadMoney();
  const rows = await M.successByClientKey({ from: RANGE.from, to: RANGE.to });
  const top = rows.filter((r) => r.key !== "—").sort((a, b) => b.revenue - a.revenue)[0];
  assert.ok(top && top.revenue > 0,
    "🔴 за 12 міс. немає жодного клієнта з виручкою — перевірці НЕМА ЧОГО знаходити, це провал");
  return { key: top.key, revenue: top.revenue };
}

test("#29 КАРТКА РАХУЄ ЯДРОМ: помісячний розклад по клієнту == загальному розкладу", needsDb(), async () => {
  const M = await loadMoney();
  const { key } = await biggestClient();
  // Ліворуч — те, що бере картка (новий аргумент `onlyClientKey`).
  // Праворуч — повний розклад ядра, відфільтрований у памʼяті.
  // Збігаються по КОЖНОМУ місяцю → аргумент звужує вибірку, а не рахує інакше.
  const [mine, all] = await Promise.all([
    M.successByClientBucket(RANGE, "month", key),
    M.successByClientBucket(RANGE, "month"),
  ]);
  const theirs = all.filter((r) => r.clientKey === key);
  assert.ok(theirs.length > 0, "🔴 у повному розкладі клієнта немає — перевірка порожня");
  assert.equal(mine.length, theirs.length, "різна кількість місяців у розкладі клієнта");
  const norm = (rows: { bucket: string; revenue: number; deals: number }[]) =>
    [...rows].sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((r) => `${r.bucket}:${Math.round(r.revenue)}:${r.deals}`);
  assert.deepEqual(norm(mine), norm(theirs),
    "🔴 картка й ядро дають РІЗНІ місячні суми по одному клієнту");
});

test("#29b ДЗЕРКАЛО: аргумент СПРАВДІ звужує, а не ігнорується", needsDb(), async () => {
  // Без цієї пари #29 зеленів би й тоді, якби `onlyClientKey` мовчки не діяв:
  // «розклад по клієнту» дорівнював би розкладу по всіх, а фільтр у памʼяті
  // приховав би це. Тому перевіряємо ДВІ речі: чужих у вибірці немає, і повний
  // розклад помітно ширший.
  const M = await loadMoney();
  const { key } = await biggestClient();
  const [mine, all] = await Promise.all([
    M.successByClientBucket(RANGE, "month", key),
    M.successByClientBucket(RANGE, "month"),
  ]);
  const foreign = mine.filter((r) => r.clientKey !== key);
  assert.deepEqual(foreign, [], "🔴 у вибірці по одному клієнту є ЧУЖІ рядки — фільтр не працює");
  assert.ok(all.length > mine.length * 2,
    `🔴 повний розклад (${all.length}) не ширший за розклад одного клієнта (${mine.length}) — `
    + "або в базі один клієнт, або аргумент насправді не звужує");
  // І навпаки: неіснуючий ключ мусить дати ПОРОЖНЬО, а не «усе».
  const ghost = await M.successByClientBucket(RANGE, "month", "__zzz_nemaje_takogo_klienta__");
  assert.deepEqual(ghost, [], "🔴 неіснуючий ключ повернув рядки — фільтр не застосовується");
});

test("#29c Σ МІСЯЦІВ КАРТКИ == ФАКТУ КЛІЄНТА того ж діапазону", needsDb(), async () => {
  // Той самий інваріант, що тримає екран планів (#22c), але з боку картки:
  // стовпчики мусять складатись у той факт, який менеджер бачить у рядку клієнта.
  const M = await loadMoney();
  const { key, revenue } = await biggestClient();
  const months = await M.successByClientBucket(RANGE, "month", key);
  const sum = months.reduce((s, r) => s + r.revenue, 0);
  assert.ok(Math.abs(sum - revenue) < 1,
    `🔴 Σ стовпчиків картки ${Math.round(sum)} ≠ факту клієнта ${Math.round(revenue)}`);
});

test("#29d МІСЯЦЬ КАРТКИ == МІСЯЦЮ ЕКРАНА ПЛАНІВ (одна цифра, не дві схожі)", needsDb(), async () => {
  const M = await loadMoney();
  const { key } = await biggestClient();
  const monthScope = { from: `${MONTH}-01`, to: `${MONTH}-31` };
  const [fromCard, fromPlans] = await Promise.all([
    M.successByClientBucket(monthScope, "month", key),
    M.successByClientKey(monthScope),
  ]);
  const cardSum = fromCard.reduce((s, r) => s + r.revenue, 0);
  const planSum = fromPlans.find((r) => r.key === key)?.revenue ?? 0;
  assert.ok(Math.abs(cardSum - planSum) < 1,
    `🔴 «${MONTH}» у картці ${Math.round(cardSum)}, а в рядку клієнта на екрані планів `
    + `${Math.round(planSum)} — два «липні» на одному екрані`);
});
