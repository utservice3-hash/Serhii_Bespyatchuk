import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * K1-K3 — ЗВІТ КВП: ВІДСОТОК ПЛАНУ РАХУЄТЬСЯ ОДНИМ ВИРАЗОМ І ДРУКУЄТЬСЯ ЧЕРЕЗ `fmtPct`.
 *
 * 🔴 ПРИВІД — ЖИВИЙ КЛІК ВЛАСНИКА НА ПРОДІ: плитка «Прогноз місяця» показувала
 * «факт 1.4М · **null% плану**». Механізм заміряно на проді 20.08.2026:
 *   • `buildProjection` кличеться в `Promise.all`, де `strategic` ще НЕ порахований,
 *     тож туди йшов `plan = null` → `projection.projectedPct` був `null` ЗАВЖДИ;
 *   • плитка друкувала його сирою інтерполяцією, тож `null` виходив СЛОВОМ;
 *   • а повна таблиця нижче рахувала той самий відсоток ВЛАСНИМ виразом і показувала
 *     правильно — одне число, два шляхи, різні результати на одному екрані.
 *
 * Тому гейти стережуть не «немає слова null», а причину: ОДИН вираз на всі поверхні.
 *
 * ⚠️ ПЕРЕВІРКА ПО ДЖЕРЕЛУ, і це свідомо. Роут вимагає живих БД+авторизації, тобто
 * без прода чесно скіпався б — а саме такий гейт нічого не стереже в щоденному
 * `npm test`. Той самий вибір уже зроблено для `#72d` (правило не дублюється) і
 * `#74c` (фронт не має власного числа годин).
 */

const SRC = path.join(import.meta.dirname, "..", "..", "src");
const src = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
const FE = path.join("..", "..", "frontend", "src", "pages", "dashboard", "sections", "KvpReportSection.tsx");

/** Тіло саме роуту `/kvp-report` — щоб не ловити збіги із сусідніх роутів. */
function kvpRouteBody(): string {
  const s = src("routes/dashboard.ts");
  const i = s.indexOf(`dashboardRouter.get("/kvp-report", async`);
  assert.ok(i > 0, "🔴 роут /kvp-report не знайдено — гейти нижче порожні");
  // Наступний роут — межа тіла. `pre(` тут не використовуємо: сусід через дефіс
  // (`/kvp-report/manager-detail`) є ІНШИМ роутом і оголошений ВИЩЕ.
  const j = s.indexOf("dashboardRouter.", i + 40);
  return s.slice(i, j > 0 ? j : undefined);
}

test("K1 ВІДСОТОК ПРОГНОЗУ НЕ БЕРЕТЬСЯ З ЗАВЖДИ-NULL ПОЛЯ", () => {
  const body = kvpRouteBody();
  // Доводимо, що шукати БУЛО ЩО: виклик із `null`-планом лишається (плану на той
  // момент ще немає), тож поле `projection.projectedPct` і далі `null` — і саме тому
  // брати його в відповідь не можна.
  assert.match(body, /buildProjection\(\{ from, to, granularity: "month" \}, null\)/,
    "🔴 виклик buildProjection змінився — перевір, чи `projectedPct` ядра більше не null, "
    + "інакше гейт нижче стереже неіснуючу пастку");
  assert.ok(!/projectedPct:\s*projection\.projectedPct/.test(body),
    "🔴 у відповідь повертається `projection.projectedPct` — воно NULL за побудовою "
    + "(план у buildProjection не передається), і екран знову надрукує «null% плану»");
});

test("K2 ВІДСОТОК ПЛАНУ — ОДИН ВИРАЗ НА ВСІ ПОВЕРХНІ ЗВІТУ", () => {
  const body = kvpRouteBody();
  assert.match(body, /const pctOfPlan = \(/,
    "🔴 спільного виразу відсотка немає — кожна поверхня рахує своє");
  // Усі три поверхні (виконання плану · плитка прогнозу · повна таблиця) — через нього.
  // ⚠️ Оголошення пишеться як `pctOfPlan = (`, тож цей патерн ловить РІВНО виклики.
  const viaHelper = (body.match(/pctOfPlan\(/g) ?? []).length;
  assert.ok(viaHelper >= 3, `🔴 через спільний вираз іде лише ${viaHelper} виклик(и) — `
    + "поверхонь три (виконання плану · плитка прогнозу · повна таблиця), котрась рахує сама");
  // Сама арифметика мусить існувати РІВНО В ОДНОМУ місці — у тілі `pctOfPlan`.
  // ⚠️ Не «нуль входжень»: одне з них і є оголошення. Друге = повернута копія.
  const arith = (body.match(/strategic > 0 \? Math\.round\(/g) ?? []).length;
  assert.equal(arith, 1,
    `🔴 вираз відсотка зустрічається ${arith} раз(и) — має бути РІВНО один (тіло pctOfPlan). `
    + "Друга копія і є те, через що плитка й таблиця показували різне");
});

test("K3 ЕКРАН НЕ ДРУКУЄ ВІДСОТОК СИРОЮ ІНТЕРПОЛЯЦІЄЮ", () => {
  const fe = src(FE);
  assert.match(fe, /const fmtPct = \(v: number \| null\) => \(v == null \? "—"/,
    "🔴 fmtPct зник або перестав віддавати «—» на null — тоді все нижче безпредметне");
  // ⚠️ ЦІЛИМОСЬ У ДВА НУЛЬОВІ ПОЛЯ, а не в усе, де є «pct». `m.pct ?? 0`,
  //    `Math.min(100, pct)` і ширини смуг — нормальні, вони не бувають null на екрані.
  //    Небезпечні рівно `projectedPct` і `planPct`: обидва `number | null` з сервера.
  const raw = [...fe.matchAll(/\$\{[^}]*\b(?:projectedPct|planPct)\b[^}]*\}/g)]
    .map((m) => m[0])
    .filter((x) => !x.includes("fmtPct") && !x.includes("== null") && !x.includes("?? "));
  assert.deepEqual(raw, [],
    `🔴 нульовий відсоток друкується без захисту — екран покаже слово «null»: ${raw.join(" · ")}`);
  // 🪞 І доводимо, що шукати БУЛО ДЕ: обидва поля на екрані присутні.
  for (const f of ["projectedPct", "planPct"])
    assert.ok(fe.includes(f), `🔴 «${f}» зник з екрана — перевірка вище порожня`);
});
