import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ENPS_SCALE, ENPS_BANDS, classifyEnps, bandFor, summarizeEnps,
  granularityFor, bucketOf, buildEnpsSeries, parseEnpsRange, spanDays, ENPS_DEFAULT_DAYS,
} from "./enps.js";

/**
 * 📊 #143–#143d — eNPS: ОДНА ШКАЛА, ОДНА ФОРМУЛА, ДОВІЛЬНИЙ ПЕРІОД.
 *
 * 🔴 ЩО ЦЕ СТЕРЕЖЕ. Пороги «9-10 / 7-8 / 0-6» жили в ЧОТИРЬОХ місцях: `BETWEEN` у SQL,
 * `enpsColor` на фронті, підпис під пікером і мертвий `ENPS` у каталозі, який не
 * імпортувався нікуди. Класифікація пішла з SQL у ядро, підпис будується з чисел,
 * мертву копію видалено — лишились ДВІ: ядро і фронтовий пікер. Другу звіряє `#143c`,
 * тож розійтись мовчки вони більше не можуть.
 */

const FE_SCALE = fileURLToPath(new URL("../../../frontend/src/pages/dashboard/sections/enpsScale.ts", import.meta.url));
// Набір біжить із `dist/`, а читаємо ми ДЖЕРЕЛО: із dist/oneOnOne/ до backend/src/ — два рівні вгору.
const ROUTE = fileURLToPath(new URL("../../src/routes/oneOnOnes.ts", import.meta.url));

/** Коментарі вирізаються перед пошуком: у доках я цитую саме те, що заборонено (#58, #127, #140). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

/**
 * #143 — СМУГИ ПОКРИВАЮТЬ УВЕСЬ ДІАПАЗОН, БЕЗ ДІРОК І БЕЗ ПЕРЕТИНІВ.
 *
 * 🔴 Дірка означала б «бейджа немає» рівно для тих значень, яких ніхто не перевіряв
 * руками, — і побачили б ми це не в тесті, а на екрані власника.
 *
 * 🧨 САБОТАЖ (виконано): зсунути межу `good.from` 30 → 31 — червоніє на 30;
 * розтягнути `ok.to` 29 → 31 — червоніє на перетині.
 */
test("#143 смуги eNPS покривають −100..100 рівно один раз", () => {
  for (let v = -100; v <= 100; v++) {
    const hits = ENPS_BANDS.filter((b) => v >= b.from && v <= b.to);
    assert.equal(hits.length, 1, `🔴 eNPS ${v} потрапив у ${hits.length} смуг (має рівно в одну)`);
    assert.equal(bandFor(v).key, hits[0].key);
  }
  // Межі зі специфікації власника — поіменно, щоб «покриття» не зійшлось випадково.
  const at = (v: number) => bandFor(v).label;
  assert.equal(at(50), "Відмінно"); assert.equal(at(49), "Добре");
  assert.equal(at(30), "Добре");    assert.equal(at(29), "Нормально");
  assert.equal(at(10), "Нормально");assert.equal(at(9),  "Зона уваги");
  assert.equal(at(0),  "Зона уваги");assert.equal(at(-1), "Погано");
  assert.equal(at(-29), "Погано");  assert.equal(at(-30), "Критично");
});

/**
 * #143b — КЛАСИФІКАЦІЯ Й ФОРМУЛА.
 *
 * 🧨 САБОТАЖ (виконано): включити нейтралів у чисельник → червоніє на прикладі власника;
 * рахувати eNPS з ОКРУГЛЕНИХ відсотків → червоніє на випадку, де округлення розходяться;
 * повернути бали поза шкалою у знаменник → червоніє на перевірці `invalid`.
 */
test("#143b eNPS = %промоутерів − %критиків, і рахується з сирих лічильників", () => {
  // Приклад власника: 60% / 24% / 16% → +44.
  const s = summarizeEnps([{ score: 10, count: 15 }, { score: 8, count: 6 }, { score: 3, count: 4 }]);
  assert.deepEqual(
    [s.total, s.promotersPct, s.passivesPct, s.detractorsPct, s.enps],
    [25, 60, 24, 16, 44], "🔴 приклад власника (60/24/16 → +44) не відтворюється");
  assert.equal(s.band?.label, "Добре");

  // Нейтрали у формулу НЕ входять: додаємо їх — eNPS мусить ВПАСТИ (бо росте знаменник),
  // а не лишитись тим самим і не зрости.
  const withPassives = summarizeEnps([{ score: 10, count: 15 }, { score: 8, count: 26 }, { score: 3, count: 4 }]);
  assert.ok(withPassives.enps! < s.enps!, "🔴 нейтрали не впливають на знаменник — формула не та");

  // 🔴 З СИРИХ ЛІЧИЛЬНИКІВ, А НЕ З ОКРУГЛЕНИХ ВІДСОТКІВ. Тут різниця округлень дає
  // інший бал: 4/7 та 2/7 → 57%−29% = 28 (округлено), а чесно (4−2)/7 = 28.57 → 29.
  const r = summarizeEnps([{ score: 9, count: 4 }, { score: 7, count: 1 }, { score: 5, count: 2 }]);
  assert.equal(r.enps, 29, "🔴 eNPS порахований з округлених відсотків — на межі смуги це міняє бейдж");

  // Відсотки в сумі дають РІВНО 100 (метод найбільшого залишку): 1/3 кожного — це 34/33/33.
  const thirds = summarizeEnps([{ score: 10, count: 1 }, { score: 7, count: 1 }, { score: 0, count: 1 }]);
  assert.equal(thirds.promotersPct + thirds.passivesPct + thirds.detractorsPct, 100,
    "🔴 три частки на екрані не складаються в 100% — читається як арифметична помилка");

  // Бали ПОЗА шкалою (рішення власника 24.08): зі знаменника геть, але названі числом.
  const bad = summarizeEnps([{ score: 10, count: 3 }, { score: 42, count: 2 }, { score: -1, count: 1 }]);
  assert.equal(bad.total, 3, "🔴 бал поза шкалою потрапив у знаменник — він занижує eNPS мовчки");
  assert.equal(bad.invalid, 3, "🔴 бали поза шкалою не пораховані — на екрані їх нічим показати");
  assert.equal(bad.enps, 100);

  // 🔴 ПОРОЖНІЙ ПЕРІОД — null, А НЕ 0. Нуль читається як результат опитування.
  const empty = summarizeEnps([]);
  assert.equal(empty.enps, null, "🔴 «немає оцінок» перетворилось на eNPS = 0");
  assert.equal(empty.band, null);
  assert.equal(empty.promotersPct, 0);

  // Межі класів — поіменно.
  assert.equal(classifyEnps(10), "promoter"); assert.equal(classifyEnps(9), "promoter");
  assert.equal(classifyEnps(8), "passive");   assert.equal(classifyEnps(7), "passive");
  assert.equal(classifyEnps(6), "detractor"); assert.equal(classifyEnps(0), "detractor");
  for (const bad2 of [-1, 11, 1.5, null, undefined, NaN]) assert.equal(classifyEnps(bad2 as number), "invalid");
});

/**
 * #143c — ФРОНТ І ЯДРО КЛАСИФІКУЮТЬ ОДНАКОВО.
 *
 * 🔴 Копія на фронті потрібна (пікер фарбує один бал ще до будь-якого запиту), але
 * копія без звірки — це наступні «чотири джерела правди». Тут транспілюється
 * СПРАВЖНІЙ модуль фронту, а не його переказ.
 *
 * 🧨 САБОТАЖ (виконано): змінити `promoterFrom` у `enpsScale.ts` на 8 — червоніє.
 */
test("#143c шкала на фронті збігається з ядром — бал у бал", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(readFileSync(FE_SCALE, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const fe = await import(`data:text/javascript,${encodeURIComponent(js)}`);

  assert.deepEqual({ ...fe.ENPS_SCALE }, { ...ENPS_SCALE }, "🔴 числа шкали на фронті інші, ніж у ядрі");
  for (let v = -5; v <= 15; v++) {
    assert.equal(fe.classifyEnps(v), classifyEnps(v), `🔴 бал ${v} класифікується по-різному: фронт vs ядро`);
  }
  // Підпис під пікером БУДУЄТЬСЯ з чисел: інакше він застаріє мовчки першої ж зміни шкали.
  assert.match(fe.SCALE_CAPTION, new RegExp(`${ENPS_SCALE.promoterFrom}-${ENPS_SCALE.max} промоутер`),
    "🔴 підпис шкали написаний словами, а не зібраний із порогів");
});

/**
 * #143d — ПЕРІОД ДОВІЛЬНИЙ, ОБИДВА КІНЦІ ВКЛЮЧНО.
 *
 * 🔴 «Обидва кінці» — не формальність: `col <= to` без нижнього близнюка вже одного разу
 * зрізав увесь останній день місяця (для червня сховав 251 угоду).
 *
 * 🧨 САБОТАЖ (виконано): у запиті `>=` → `>` — червоніє на перевірці джерела роута;
 * прибрати перевірку `from > to` — червоніє; зробити грануляцію фіксованою — червоніє.
 */
test("#143d період eNPS: довільний, обидва кінці включно, грануляція за довжиною", () => {
  const TODAY = "2026-08-24";

  // Явний період повертається як є.
  assert.deepEqual(parseEnpsRange({ from: "2026-07-01", to: "2026-08-24" }, TODAY),
    { from: "2026-07-01", to: "2026-08-24" });
  // Один день — валідний період (від дня до дня), і він рівно один.
  assert.deepEqual(parseEnpsRange({ from: TODAY, to: TODAY }, TODAY), { from: TODAY, to: TODAY });
  assert.equal(spanDays(TODAY, TODAY), 1, "🔴 один день порахований як нуль — межі не включні");

  // Сміття й перевернутий період — 400, а не тихий фолбек на «щось розумне».
  for (const bad of [{ from: "2026-08-24" }, { from: "вчора", to: TODAY }, { from: TODAY, to: "2026-08-01" }]) {
    assert.ok("error" in parseEnpsRange(bad, TODAY), `🔴 прийнято некоректний період: ${JSON.stringify(bad)}`);
  }

  // Фолбек `months` (старий бандл у браузерах у момент викату) — початок місяця N-1 назад.
  assert.deepEqual(parseEnpsRange({ months: 3 }, TODAY), { from: "2026-06-01", to: TODAY });
  // Без параметрів — останні 90 днів, обидва кінці включно.
  const def = parseEnpsRange({}, TODAY) as { from: string; to: string };
  assert.equal(spanDays(def.from, def.to), ENPS_DEFAULT_DAYS, "🔴 дефолтний період не дорівнює оголошеному");

  // Грануляція — за довжиною, з перевіркою САМЕ на межах.
  assert.equal(granularityFor("2026-08-01", "2026-08-31"), "day");    // 31
  assert.equal(granularityFor("2026-08-01", "2026-09-01"), "week");   // 32
  assert.equal(granularityFor("2026-05-01", "2026-08-28"), "week");   // 120
  assert.equal(granularityFor("2026-05-01", "2026-08-29"), "month");  // 121

  // Бакети: тиждень — з понеділка, місяць — з першого.
  assert.equal(bucketOf("2026-08-24", "day"), "2026-08-24");
  assert.equal(bucketOf("2026-08-27", "week"), "2026-08-24", "🔴 тиждень рахується не з понеділка");
  assert.equal(bucketOf("2026-08-24", "week"), "2026-08-24");
  assert.equal(bucketOf("2026-08-23", "week"), "2026-08-17", "🔴 неділя віднесена до НАСТУПНОГО тижня");
  assert.equal(bucketOf("2026-08-27", "month"), "2026-08-01");

  // Тренд ріже ті самі дні тим самим правилом, що й підсумок.
  const series = buildEnpsSeries([
    { day: "2026-08-24", score: 10, count: 2 },
    { day: "2026-08-27", score: 0, count: 1 },
    { day: "2026-09-01", score: 9, count: 1 },
  ], "week");
  assert.deepEqual(series.map((x) => x.bucket), ["2026-08-24", "2026-08-31"]);
  assert.equal(series[0].total, 3);
  assert.equal(series[0].enps, 33);

  // 🔴 І САМ ЗАПИТ МУСИТЬ БРАТИ ОБИДВА КІНЦІ ВКЛЮЧНО. Правильна чиста функція нічого не
  // варта, якщо SQL поруч ріже останній день.
  const src = stripComments(readFileSync(ROUTE, "utf8"));
  const q = /oneOnOnesRouter\.get\("\/enps"[\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
  assert.ok(q, "🔴 не знайдено роут /enps — гейт втратив предмет");
  assert.match(q, /meeting_date >= \$\{fromP\}/, "🔴 нижня межа не включна");
  assert.match(q, /meeting_date <= \$\{toP\}/, "🔴 верхня межа не включна");
  assert.doesNotMatch(q, /BETWEEN 9 AND 10|BETWEEN 0 AND 6/,
    "🔴 класифікація повернулась у SQL — знову два джерела порогів");
});
