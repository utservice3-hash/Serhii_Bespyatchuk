import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

/**
 * ІНВАРІАНТИ КОНВЕРСІЙ (пункт C — зведення `scripts/gateStepV.ts` у той самий набір;
 * скрипт видалено, щоб не лишалось навіть залишкової другої культури).
 *
 * Що тримаємо:
 *  • стеля ≤100% — чисельник ⊆ знаменник за побудовою (когортна версія);
 *  • дозрівання: поточний місяць НЕ може бути mature (когорта не догорнулась);
 *  • детермінізм: два виклики поспіль дають те саме;
 *  • крос-екран: Σ per-manager == загальне по відділу (розрізи можна класти поруч).
 */

const load = async () => ({
  metrics: await import("./metrics.js"),
  getSettings: (await import("../routes/settings.js")).getSettings,
});

const MATURE_YM = process.env.TEST_CONV_MONTH ?? "2026-02"; // зрілий місяць
const kyivYm = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
const monthRange = (ym: string) => ({
  from: `${ym}-01`,
  to: new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10),
});

test("C.1 конверсія реклами: ≤100%, знаменник не порожній", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  assert.ok(adSources.length > 0, "adSources порожній — конфіг-помилка, рекламні метрики були б нулями");
  const rows = await metrics.conversionAdsByMonth({}, adSources);
  assert.ok(rows.length > 0, "конверсія реклами порожня — порожній результат це ПРОВАЛ");
  const bad = rows.filter((r) => r.cohortPct != null && r.cohortPct > 100);
  assert.deepEqual(bad.map((r) => `${r.ym}=${r.cohortPct}%`), [],
    "когортна конверсія >100% — чисельник вийшов за межі знаменника");
  const empty = rows.filter((r) => Number(r.entered) === 0);
  assert.ok(empty.length < rows.length, "у ВСІХ місяців знаменник нульовий — рекламна воронка не рахується");
});

test("C.2 ДОЗРІВАННЯ: поточний місяць не може бути mature", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const rows = await metrics.conversionAdsByMonth({}, adSources);
  const cur = rows.find((r) => r.ym === kyivYm());
  if (!cur) return; // поточного місяця ще немає в ряді — нічого перевіряти
  assert.equal(cur.mature, false,
    `поточний місяць ${cur.ym} позначено дозрілим — когорта ще догортається, цифра буде заниженою`);
});

test("C.3 ДЕТЕРМІНІЗМ: два виклики поспіль дають те саме", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const a = await metrics.conversionAdsByMonth({}, adSources);
  const b = await metrics.conversionAdsByMonth({}, adSources);
  assert.deepEqual(b, a, "той самий виклик дав інший результат — недетермінована метрика");
});

test("C.4 КРОС-ЕКРАН: Σ per-manager == загальне по відділу (зрілий місяць)", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const range = monthRange(MATURE_YM);
  const mgr = await metrics.conversionAdsByManager(range, adSources);
  assert.ok(mgr.length > 0, `per-manager конверсія за ${MATURE_YM} порожня — провал`);
  const sumEntered = mgr.reduce((s, m) => s + Number(m.entered ?? 0), 0);
  const monthly = (await metrics.conversionAdsByMonth({}, adSources)).find((r) => r.ym === MATURE_YM);
  assert.ok(monthly, `місяця ${MATURE_YM} немає в помісячному ряді`);
  assert.ok(sumEntered > 0, "Σ per-manager знаменник = 0 — розріз порожній");
  // Σ per-manager рахує лише угоди з manager_id; відділ бере всі → Σ ≤ відділ.
  assert.ok(sumEntered <= Number(monthly!.entered),
    `Σ per-manager ${sumEntered} БІЛЬШЕ за відділ ${monthly!.entered} — так бути не може`);
  assert.ok(sumEntered >= Number(monthly!.entered) * 0.9,
    `Σ per-manager ${sumEntered} проти відділу ${monthly!.entered} — >10% угод без менеджера, розрізи не сходяться`);
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db/pool.js");
  await pool.end();
});

/**
 * 📅 #366/#366b — ПОДЕННИЙ ЗНАМЕННИК ДЛЯ ЕКРАНА «РЕКЛАМА» (08.09.2026).
 *
 * Екран показує витрати GA4 по днях поруч із лідами CRM. Щоб ці ліди не розійшлися з
 * `conversion_ads`, поденна функція бере ТЕ САМЕ приватне ядро (`dealCohortCte`), а не
 * свій SQL. Гейт це і доводить — рівністю з помісячним знаменником.
 *
 * 🔴 ЧОМУ ПОТРІБНЕ ДЗЕРКАЛО #366b. Сама рівність зеленіє й тоді, коли функція віддала
 * ОДИН рядок із сумою місяця (тобто групування по днях не працює зовсім). Дзеркало
 * вимагає, щоб днів було більше одного і жоден не дорівнював місяцю.
 *
 * 🧨 САБОТАЖ: додати `JOIN managers` у поденний запит — угоди з `manager_id IS NULL`
 * випадуть, Σ по днях стане МЕНШОЮ за місяць, і #366 почервоніє.
 */
test("#366 ПОДЕННИЙ ЗНАМЕННИК == ПОМІСЯЧНОМУ: те саме ядро, жодного рядка не загублено", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const days = await metrics.conversionAdsByDay(monthRange(MATURE_YM), adSources);
  assert.ok(days.length > 0,
    `поденний знаменник за ${MATURE_YM} порожній — це ПРОВАЛ, а не «нуль»: перевірці не було що знаходити`);
  const sum = days.reduce((s, d) => s + d.entered, 0);
  const monthly = (await metrics.conversionAdsByMonth({}, adSources)).find((r) => r.ym === MATURE_YM);
  assert.ok(monthly, `місяця ${MATURE_YM} немає в помісячному ряді — порівнювати нема з чим`);
  assert.equal(sum, Number(monthly!.entered),
    `Σ по днях ${sum} ≠ знаменник місяця ${monthly!.entered} — поденний розріз втратив або додав рядки. ` +
    "Тоді екран «Реклама» показував би інші ліди, ніж conversion_ads, і розбіжність була б тихою");
  const wonSum = days.reduce((s, d) => s + d.won, 0);
  assert.ok(wonSum <= sum, `виграних ${wonSum} більше за вхідних ${sum} — чисельник вийшов за знаменник`);
});

test("#366b 🪞 РОЗРІЗ СПРАВДІ ПОДЕННИЙ — а не один кошик під виглядом місяця", needsDb(), async () => {
  const { metrics, getSettings } = await load();
  const { adSources } = await getSettings();
  const days = await metrics.conversionAdsByDay(monthRange(MATURE_YM), adSources);
  assert.ok(days.length > 1,
    `у ${MATURE_YM} лише ${days.length} рядок — групування по днях не працює, і #366 зеленів би дарма`);
  assert.match(days[0].day, /^\d{4}-\d{2}-\d{2}$/,
    `день «${days[0].day}» не у форматі YYYY-MM-DD — екран не зможе зіставити його з днем GA4`);
  const sum = days.reduce((s, d) => s + d.entered, 0);
  const max = Math.max(...days.map((d) => d.entered));
  assert.ok(max < sum,
    `найбільший день (${max}) дорівнює всьому місяцю (${sum}) — розріз злипся в один рядок`);
});
