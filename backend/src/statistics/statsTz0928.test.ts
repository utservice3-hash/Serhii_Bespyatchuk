import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compareWindows, deltaPct, planPct, rankByPlan, sheetWeekToMonday, weekOf, foldWeek, clipPlanToToday, clipPointsToToday, type WeekPlanCell } from "./statsCompare.js";
import { ANOMALIES, anomaliesFor, CORRECTIONS, applyCorrections } from "./anomalies.js";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * 📊 #870–#879 — ТЗ «Статистики в дашборді UTS» 28.09.2026 (задачі 4603–4606 + 4367), 02.10.2026.
 * Рішення Романа 02.10: план — проти ② як на Звіті; план тижня — правило Звіту; помилку таблиці
 * позначаємо, не переписуємо; розформовану команду — у «архівні».
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SEC = "frontend/src/pages/dashboard/sections";
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("#870 ПОРІВНЯННЯ ОДНАКОВИХ ВІДРІЗКІВ: понеділок проти понеділка, четвер проти четверга, неділя — повні тижні", () => {
  // Понеділок 28.09.2026: поточний відрізок — 1 день, і попередній — теж 1 день (а не повний тиждень → «▼93%»).
  const mon = compareWindows("week", "2026-09-28");
  assert.deepEqual(mon.cur, { from: "2026-09-28", to: "2026-09-28" });
  assert.deepEqual(mon.prev, { from: "2026-09-21", to: "2026-09-21" }, "🔴 понеділок порівнюється не з понеділком");
  assert.equal(mon.complete, false);
  const thu = compareWindows("week", "2026-10-01");
  assert.deepEqual(thu.prev, { from: "2026-09-21", to: "2026-09-24" }, "🔴 пн–чт порівнюється не з пн–чт минулого тижня");
  assert.deepEqual(thu.full, { from: "2026-09-28", to: "2026-10-04" }, "🔴 тиждень не Пн–Нд або зламався на межі місяця");
  const sun = compareWindows("week", "2026-09-27");
  assert.equal(sun.complete, true);
  assert.deepEqual(sun.prev, { from: "2026-09-14", to: "2026-09-20" });
  // Місяць: 31.03 → 1–28.02 (клампиться), січень → грудень минулого року.
  assert.deepEqual(compareWindows("month", "2026-03-31").prev, { from: "2026-02-01", to: "2026-02-28" }, "🔴 31-ше не клампиться до кінця лютого");
  assert.equal(compareWindows("month", "2026-03-31").complete, true);
  assert.deepEqual(compareWindows("month", "2026-01-15").prev, { from: "2025-12-01", to: "2025-12-15" });
  assert.deepEqual(weekOf("2026-10-04"), { from: "2026-09-28", to: "2026-10-04" }, "🔴 неділя віднесена до наступного тижня (4367)");
});

test("#870b Δ і % ПЛАНУ — ЧЕСНІ ПОРОЖНЕЧІ, ранг — за % плану, без плану внизу", () => {
  assert.equal(deltaPct(10, 0), null, "🔴 Δ до нуля стало числом — «▼100%» / «∞» замість «порівнювати нема з чим»");
  assert.equal(deltaPct(50, 100), -50);
  assert.equal(planPct(500, null), null, "🔴 без плану — 0%, а це читається як провал");
  assert.equal(planPct(500, 1000), 50);
  const r = rankByPlan([{ id: "a", pct: 80, fact: 9 }, { id: "b", pct: null, fact: 100 }, { id: "c", pct: 120, fact: 1 }]);
  assert.deepEqual(r.map((x) => `${x.id}:${x.rank}`), ["c:1", "a:2", "b:3"], "🔴 команда без плану обігнала тих, хто план має");
});

test("#871 ТИЖДЕНЬ — ПОНЕДІЛКОМ: тижні ручної таблиці (неділя) зводяться до понеділка, як CRM", () => {
  assert.equal(sheetWeekToMonday("2026-01-04"), "2025-12-29", "🔴 тиждень таблиці лишився датований неділею — зсув на 6 днів відносно CRM");
  assert.equal(sheetWeekToMonday("2025-12-29"), "2025-12-29", "🔴 понеділок CRM зсунуло");
  const route = codeOnly(read("backend/src/routes/statisticsSeries.ts"));
  assert.match(route, /period: weekLabel\(g, x\.period\)/, "🔴 точки з таблиці віддаються без зведення до понеділка");
  assert.equal((route.match(/weekLabel\(g, x\.period\)/g) ?? []).length, 3, "🔴 не всі три читачі історії таблиці зводять тиждень до понеділка");
});

test("#874 АНОМАЛІЇ — З ДОКАЗОМ CRM ЧИСЛОМ, на понеділок, і серія їх віддає", () => {
  assert.ok(ANOMALIES.length >= 2);
  for (const a of ANOMALIES) {
    assert.match(a.crm, /\d/, `🔴 ${a.metric}/${a.scopeKey}: позначка без числа з CRM — це думка, а не факт`);
    assert.ok(a.note.length > 10);
    assert.equal(sheetWeekToMonday(a.period), a.period, `🔴 ${a.period}: аномалія не на понеділку — позначка не ляже на точку`);
    assert.ok(a.kind === "real" || a.kind === "data_error" || a.kind === "corrected");
    // Позначка «виправлено» без самого виправлення брехала б: точка показувала б число таблиці з підписом «CRM».
    if (a.kind === "corrected") assert.ok(CORRECTIONS.some((c) => c.metric === a.metric && c.scopeKey === a.scopeKey && c.period === a.period),
      `🔴 ${a.metric}/${a.scopeKey} ${a.period}: позначено «виправлено CRM», а виправлення немає`);
  }
  assert.ok(anomaliesFor("cars_success", "week").some((a) => a.period === "2025-12-29" && a.kind === "real"));
  assert.ok(anomaliesFor("avg_check", "week").some((a) => a.scopeKey === "13" && a.kind === "corrected"));
  assert.deepEqual(anomaliesFor("cars_success", "month"), [], "🔴 тижнева аномалія поїхала на місячний графік");
  assert.match(codeOnly(read("backend/src/routes/statisticsSeries.ts")), /anomalies: anomaliesFor\(metric, g\)/, "🔴 серія не віддає аномалій");
  assert.match(read(`${SEC}/StatisticsChartsSection.tsx`), /<ReferenceDot key=\{`an\$\{k\}`\}/, "🔴 графік не позначає аномалію");
});

test("#875 ПЛАН — ТІ САМІ ФУНКЦІЇ, ЩО НА ЗВІТІ; власного пропорційного плану немає", () => {
  const src = codeOnly(read("backend/src/statistics/statsSummary.ts"));
  // Правило Звіту (`plans.effectiveWeekTargets`) — по складових: менеджери з місячним планом, знімок частини тижня, ручна ціль перемагає.
  assert.match(src, /plans\.dynamicTarget\(\{ month: monthStart \}, "week"\)/, "🔴 план тижня бере менеджерів не з того ж джерела, що Звіт");
  assert.match(src, /weekPlansForMonth\(\{\}, monthStart,/, "🔴 автоплан частини тижня — не зафіксований знімок Звіту");
  assert.match(src, /plans\.manualWeekTasksOn\(b\.from\)/, "🔴 ручні цілі тижня не з того ж запиту, що Звіт");
  assert.match(src, /plans\.dynamicTarget\(\{ month: full\.from \}, "month"\)/, "🔴 план місяця не з того ж джерела, що Звіт");
  assert.doesNotMatch(src, /planned_value/, "🔴 у статистиках зʼявився власний SQL по плану — розійдеться зі Звітом");
  assert.equal((src.match(/monthWeekPlanCells\(/g) ?? []).length, 3, "🔴 плитка й лінія плану на графіку беруть план тижня різними шляхами");
  assert.match(src, /money\.receivedMoney\(scope\(win\.cur\)\)/, "🔴 факт плитки з планом — не ② ядра (рішення 1: як на Звіті)");
});

test("#876 РОЗФОРМОВАНА КОМАНДА — У «АРХІВНИХ»: поза рейтингом і поза дефолтом, із перемикачем — видно (дзеркало)", () => {
  const src = read("backend/src/statistics/statsSummary.ts");
  assert.match(src, /new Set<number>\(\[36283\]\)/, "🔴 «Самостійні» не позначені розформованими");
  assert.match(src, /\.map\(\(t\) => \(\{ \.\.\.rowOf\(t\), rank: 0 \}\)\)/, "🔴 архівна команда займає місце в рейтингу");
  const sum = read(`${SEC}/StatisticsSummary.tsx`);
  assert.match(sum, /useState\(false\)/, "🔴 архівні показані за замовчуванням");
  assert.match(sum, /filter\(\(r\) => showArchived \|\| !r\.archived\)/, "🔴 перемикач «показати архівні» нічого не робить");
  const ch = read(`${SEC}/StatisticsChartsSection.tsx`);
  assert.match(ch, /\(s\.archived && !showArchived\) \? null/, "🔴 розформована команда знову жива серія в легенді");
});

test("#877 ПЛИТКИ — З СЕРВЕРА; фронт не порівнює останню точку з «4 тижні тому» і не бреше «Немає даних» на помилці", () => {
  const ch = codeOnly(read(`${SEC}/StatisticsChartsSection.tsx`));
  assert.doesNotMatch(ch, /pts\[pts\.length - 5\]|function MiniTiles/, "🔴 повернулись старі міні-плитки з порівнянням неповного тижня");
  assert.doesNotMatch(ch, /Δ до попер\./, "🔴 під графіком знову «Δ до попер.» неповного відрізка");
  assert.doesNotMatch(ch, /очікує вводу/, "🔴 помилка завантаження знову читається як «немає даних»");
  assert.match(ch, /setLoadErr\(/, "🔴 збій запиту не показується як помилка");
  const sum = codeOnly(read(`${SEC}/StatisticsSummary.tsx`));
  assert.match(sum, /fetchStatsSummary\(\{ gran, anchor \}\)/, "🔴 плитки рахує не сервер");
  assert.match(sum, /станом на/, "🔴 неповний період не підписаний «станом на»");
});

test("#878 «РЕКЛАМА» — ОКРЕМИЙ РОЗДІЛ: власний навігатор періоду, той самий, що на Звіті, і вибір застосовується", () => {
  const ads = codeOnly(read(`${SEC}/AdsPage.tsx`));
  assert.match(ads, /import \{ PeriodNav \} from "\.\.\/PeriodNav"/, "🔴 «Реклама» без того самого навігатора, що на Звіті");
  assert.match(ads, /onPatch=\{\(patch\) => setNav\(/, "🔴 навігатор малюється, але період не змінює");
  assert.match(ads, /<AdsSection from=\{adsPeriod\.from\} to=\{adsPeriod\.to\}/, "🔴 дані беруть період не з навігатора");
  assert.doesNotMatch(ads, /<QuickPeriods\b/, "🔴 другий перемикач періоду поруч із PeriodNav");
  const dash = read("frontend/src/pages/Dashboard.tsx");
  assert.match(dash, /section === "ads" && <AdsPage role=\{auth\?\.role\} \/>/, "🔴 пункт меню «Реклама» без блоку рендера");
});

test("#878b 🪞 У СТАТИСТИКАХ «РЕКЛАМИ» БІЛЬШЕ НЕМАЄ, а в меню вона видима", () => {
  const ch = read(`${SEC}/StatisticsChartsSection.tsx`);
  assert.doesNotMatch(codeOnly(ch), /<PeriodNav\b|<AdsSection\b|custom: "ads"/, "🔴 «Реклама» лишилась і вкладкою в Статистиках — дві копії");
  const lay = read("frontend/src/components/Layout.tsx");
  const hid = /HIDDEN_NAV[^=]*=\s*new Set[^(]*\(\[([^\]]*)\]/.exec(lay)?.[1] ?? "";
  assert.ok(hid.length > 0, "🔴 не знайшов HIDDEN_NAV — перевірка стала б порожньою");
  assert.doesNotMatch(hid, /"ads"/, "🔴 «Реклама» досі прихована з меню");
  assert.match(lay, /\{ key: "ads", label: "Реклама", icon: "📣" \}/);
});

test("#879 ВІСЬ Y — КРУГЛІ ПОДІЛКИ; керування — дві підписані групи; дефолт — 3 місяці", async () => {
  const ts = (await import("typescript")).default;
  const src = read(`${SEC}/StatisticsChartsSection.tsx`);
  const fn = src.slice(src.indexOf("export function niceTicks"), src.indexOf("const axisFmt"));
  const js = ts.transpileModule(fn.replace("export function", "function") + "\nmodule.exports = niceTicks;", { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const m = { exports: {} as unknown };
  new Function("module", js)(m);
  const niceTicks = m.exports as (max: number) => number[];
  assert.deepEqual(niceTicks(14000), [0, 5000, 10000, 15000], "🔴 поділки знову «0к · 4к · 7к · 11к · 14к»");
  assert.deepEqual(niceTicks(1440000), [0, 500000, 1000000, 1500000]);
  assert.deepEqual(niceTicks(0), [0]);
  assert.match(src, />Крок:</, "🔴 крок графіка без підпису");
  assert.match(src, />Період:</, "🔴 діапазон без підпису");
  assert.match(src, /useState\("3м"\)/, "🔴 дефолтний діапазон не 3 місяці");
  assert.match(src, /01\.07: таблиця → CRM, рівні не порівнюються/, "🔴 шов 01.07 не підписаний на графіку");
});

test("#880 «ПРОРАХУНКИ ЛІДГЕНІВ» — ТА САМА ФУНКЦІЯ, ЩО ЕКРАН «ЛІДОГЕНЕРАЦІЯ», і на плитці, і на графіку", () => {
  const route = codeOnly(read("backend/src/routes/statisticsSeries.ts"));
  const block = /lg_transfers:[\s\S]*?\n  \},/.exec(route)?.[0] ?? "";
  assert.ok(block, "🔴 не знайдено ряд `lg_transfers` — гейт втратив предмет");
  assert.match(block, /sumBuckets\(await leadgenBuckets\(from, to, g, false\)\)\.map\(\(x\) => P\(x\.bucket, x\.quotes\)\)/,
    "🔴 графік прорахунків рахує не функцією екрана «Лідогенерація» — під однією назвою знову два числа");
  assert.doesNotMatch(block, /leadgen_touch/, "🔴 графік повернувся на передачі бота (вересень — 2 проти десятків на «Лідогенерації»)");
  const sum = codeOnly(read("backend/src/statistics/statsSummary.ts"));
  assert.match(sum, /return \(await leadgenStats\(w\.from, w\.to\)\)\.totals\.quotes;/, "🔴 плитка прорахунків рахує не як «Лідогенерація»");
  assert.doesNotMatch(sum, /FROM leadgen_touch/, "🔴 плитка знову на передачах бота");
});

const cell = (managerId: number, blockFrom: string, auto: number, manual: number | null = null, taskId: number | null = null): WeekPlanCell =>
  ({ managerId, teamId: 5, blockFrom, blockTo: blockFrom, auto, manual, manualTaskId: manual == null ? null : taskId });

test("#881 ТИЖДЕНЬ ЧЕРЕЗ МЕЖУ МІСЯЦІВ: кожна частина — ручна ?? авто; ручна ціль — РАЗ НА ЗАДАЧУ, а не раз на людину", () => {
  // 28.09–04.10: вереснева частина 28–30.09 і жовтнева 01–04.10. Обидві форми, що є в живих даних 02.10.2026.
  const starts = ["2026-09-28", "2026-10-01"];
  const f = foldWeek([
    cell(1, "2026-09-28", 30_000, 50_000, 101), cell(1, "2026-10-01", 40_000, 50_000, 101),   // одна задача на весь тиждень
    cell(2, "2026-09-28", 30_000, 5_000, 201), cell(2, "2026-10-01", 40_000, 3_000, 202),     // дві задачі — по частині
    cell(3, "2026-09-28", 30_000), cell(3, "2026-10-01", 40_000),                             // без ручних
    cell(4, "2026-09-28", 10_000, 8_000, 401), cell(4, "2026-10-01", 20_000),                 // ручна лише у вересневій частині
  ], starts);
  const tot = (m: number) => { const p = f.get(m)!; return p.autoPerBlock.reduce((a, v) => a + v, 0) + p.manual; };
  assert.equal(tot(1), 50_000, "🔴 одна задача на весь тиждень порахована двічі (по разу на кожну частину місяця)");
  assert.equal(tot(2), 8_000, "🔴 дві задачі по частинах місяця — порахована лише одна (правило «раз на людину»)");
  assert.equal(tot(3), 70_000, "🔴 без ручної цілі тиждень — не сума автопланів обох частин");
  assert.deepEqual(f.get(3)!.autoPerBlock, [30_000, 40_000], "🔴 розбивка по частинах місяців зсунулась");
  assert.equal(tot(4), 28_000, "🔴 ручна ціль вересневої частини зʼїла автоплан жовтневої");
});

test("#881b ВИПРАВЛЕННЯ CRM — УЗГОДЖЕНІ: чек = виручка ÷ авто, компанія зсунута рівно на дельту команди, лише на свою точку", () => {
  const at = (m: string, sk: string) => CORRECTIONS.find((c) => c.metric === m && c.scopeKey === sk)!;
  for (const sk of ["13", "company"]) {
    assert.ok(Math.abs(at("avg_check", sk).value - at("revenue_success", sk).value / at("cars_success", sk).value) < 0.01,
      `🔴 ${sk}: виправлений чек не дорівнює виправленій виручці ÷ авто`);
  }
  for (const m of ["cars_success", "revenue_success"]) {
    assert.equal(at(m, "company").value - at(m, "company").was, at(m, "13").value - at(m, "13").was,
      `🔴 ${m}: компанія виправлена не на ту саму дельту, що команда — Σ команд ≠ компанії`);
  }
  const pts = [{ period: "2026-01-12", value: 1 }, { period: "2026-01-19", value: 2 }, { period: "2026-01-26", value: 3 }];
  assert.deepEqual(applyCorrections("cars_success", "week", "13", pts).map((p) => p.value), [1, 20, 3], "🔴 виправлення не лягло або зачепило сусідні тижні");
  assert.deepEqual(applyCorrections("cars_success", "month", "13", pts), pts, "🔴 тижневе виправлення поїхало на місячний графік");
  assert.deepEqual(applyCorrections("cars_success", "week", "6", pts), pts, "🔴 виправлення зачепило іншу команду");
});

test("#881c ПЛАНИ «ВІДПРАВЛЕНИХ» І «ПРОРАХУНКІВ» — З ТИХ САМИХ ДЖЕРЕЛ, ЩО ЗВІТ І «ЛІДОГЕНЕРАЦІЯ»", () => {
  const src = codeOnly(read("backend/src/statistics/statsSummary.ts"));
  assert.match(src, /loadKpiTargets\(/, "🔴 план відправлених не з цілей задачника, які читає Звіт");
  assert.match(src, /dispatch_count/, "🔴 план відправлених бере не ту KPI-метрику");
  assert.match(src, /planForPeriod\(/, "🔴 план прорахунків не тим правилом, що «Лідогенерація»");
  assert.match(codeOnly(read("backend/src/routes/dashboard.ts")), /loadKpiTargets\(/, "🔴 Звіт читає цілі задачника іншим запитом, ніж Статистики");
});

test("#882 ПЛАН АВТО НА ГРАФІКУ — ТА САМА ФУНКЦІЯ, ЩО ПЛИТКА «ВІДПРАВЛЕНІ АВТО», і лише від шва", () => {
  const src = codeOnly(read("backend/src/statistics/statsSummary.ts"));
  assert.equal((src.match(/loadKpiTargets\(/g) ?? []).length, 1, "🔴 цілі KPI читаються двома шляхами — плитка й графік розійдуться");
  assert.match(src, /async function dispatchPlan\([^)]*\)[^{]*\{[\s\S]*?await dispatchTargets\(full\)/, "🔴 плитка бере план авто не з dispatchTargets");
  assert.match(src, /windows\.map\(\(w\) => dispatchTargets\(w\)\)/, "🔴 лінія плану авто на графіку не з dispatchTargets");
  const route = codeOnly(read("backend/src/routes/statisticsSeries.ts"));
  assert.match(route, /metric === "cars_delivered" && block === "sales"\) plan = \(await dispatchPlanSeries\(g, from > STATS_SEAM \? from : STATS_SEAM, to\)\)\.filter\(inScope\)/,
    "🔴 графік «Поставлені» не отримує план або отримує його до шва (до 01.07 цілей задачника не було)");
});

test("#883 ФОРМУЛА — ВИДИМИМ ПІДПИСОМ У КОЖНОГО ПОКАЗНИКА ГРАФІКА (ТЗ, блок 4, п.5)", () => {
  const fe = read(`${SEC}/StatisticsChartsSection.tsx`);
  const cats = fe.slice(fe.indexOf("const CATS"), fe.indexOf('{ key: "manual"'));
  const lines = cats.split("\n").filter((l) => /^\s*\{ key: "\w+", block:/.test(l));
  assert.ok(lines.length >= 30, `🔴 знайдено лише ${lines.length} показників — зріз CATS зламався, перевіряти нема що`);
  const bare = lines.filter((l) => !/\bhint: (?:"[^"]{10,}"|[A-Z_]+_HINT)/.test(l)).map((l) => l.match(/label: "([^"]+)"/)?.[1]);
  assert.deepEqual(bare, [], `🔴 показники без видимої формули: ${bare.join(", ")}`);
  assert.match(fe, /\{metric\.hint && <div style=\{\{ fontSize: 12, color: MUTED, margin: "6px 0 0" \}\}>📐 \{metric\.hint\}/, "🔴 формула більше не виводиться під чипами показників");
});

test("#882c ПЛАН НА ГРАФІКУ — НЕ В МАЙБУТНЄ: поточний тиждень лишається, наступний — ні", () => {
  const plan = [{ scopeKey: "company", points: [{ period: "2026-09-21", value: 1 }, { period: "2026-09-28", value: 2 }, { period: "2026-10-05", value: 3 }] },
                { scopeKey: "5", points: [{ period: "2026-10-12", value: 4 }] }];
  const c = clipPlanToToday(plan, "2026-10-02");
  assert.deepEqual(c.map((p) => [p.scopeKey, p.points.map((x) => x.period)]), [["company", ["2026-09-21", "2026-09-28"]]],
    "🔴 план майбутніх тижнів на графіку (або обрізано поточний тиждень, що вже йде)");
  assert.deepEqual(clipPlanToToday([{ scopeKey: "company", points: [{ period: "2026-10-01", value: 9 }] }], "2026-10-01")[0].points.length, 1, "🔴 сьогоднішній місяць/тиждень зник");
  assert.match(codeOnly(read("backend/src/routes/statisticsSeries.ts")), /const today = kyivToday\(\);[\s\S]*?plan = clipPlanToToday\(plan, today\);\s*res\.json\(/, "🔴 серія віддає план без обрізки майбутнього");
});

test("#882d ФАКТ НА ГРАФІКУ — НЕ В МАЙБУТНЄ, а підпис шва — лише коли шов усередині вікна", () => {
  const pts = [{ period: "2026-09-28", value: 207 }, { period: "2026-10-05", value: 5 }, { period: "2026-10-12", value: 1 }];
  assert.deepEqual(clipPointsToToday(pts, "2026-10-02").map((p) => p.period), ["2026-09-28"],
    "🔴 заплановані завантаження стоять на графіку як факт майбутніх тижнів (або зник поточний тиждень)");
  const route = codeOnly(read("backend/src/routes/statisticsSeries.ts"));
  assert.match(route, /\.map\(\(s\) => \(\{ \.\.\.s, points: clipPointsToToday\(s\.points, today\) \}\)\)/, "🔴 серія віддає точки з майбутнього");
  const fe = read(`${SEC}/StatisticsChartsSection.tsx`);
  assert.match(fe, /\{rows\[eff\.lo\]\?\.period < SEAM && \(rows\[eff\.hi\]\?\.period \?\? ""\) >= SEAM && \(\s*<ReferenceLine/,
    "🔴 підпис шва малюється й тоді, коли шов на краю вікна — налазить на вісь Y");
});

// ─────────────────────────────── ЖИВІ (test:prod) ───────────────────────────────

async function adminToken(): Promise<string> {
  const { signToken } = await import("../auth/auth.js");
  return signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
}
/** Остання ЗАВЕРШЕНА неділя за Києвом — закритий тиждень, щоб живі числа не повзли під час прогону. */
function lastSunday(): string {
  const t = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const d = new Date(`${t}T00:00:00Z`); const w = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (w === 0 ? 7 : w));
  return d.toISOString().slice(0, 10);
}

test("#872 ЖИВИЙ: плитка «Отримані кошти» і Σ команд == ядру грошей за ті самі дати", needsApi(), async () => {
  const money = await import("../core/money.js");
  const anchor = lastSunday();
  const r = await fetch(`${API_BASE}/api/statistics/summary?gran=week&anchor=${anchor}`, { headers: { Authorization: `Bearer ${await adminToken()}` } });
  assert.equal(r.status, 200);
  const b = await r.json() as { cur: { from: string; to: string }; tiles: { key: string; now: number }[]; teams: { teamId: number; fact: number }[] };
  const core = await money.receivedMoney({ from: b.cur.from, to: b.cur.to });
  const tile = b.tiles.find((t) => t.key === "revenue")!;
  assert.ok(core.revenue > 0, "🔴 ядро дало 0 за закритий тиждень — перевіряти нема чого");
  assert.equal(tile.now, Math.round(core.revenue), "🔴 плитка рахує гроші не ядром");
  const byTeam = new Map((await money.receivedByTeam({ from: b.cur.from, to: b.cur.to })).map((x) => [x.teamId, Math.round(x.revenue)]));
  for (const t of b.teams) assert.equal(t.fact, byTeam.get(t.teamId) ?? 0, `🔴 команда ${t.teamId}: факт таблиці ≠ ядру`);
});

test("#873 ЖИВИЙ: дзвінки плитки за закритий тиждень == депстату в межах 5% (одна привʼязка ПІБ → команда)", needsApi(), async () => {
  const { pool } = await import("../db/pool.js");
  const anchor = lastSunday();
  const r = await fetch(`${API_BASE}/api/statistics/summary?gran=week&anchor=${anchor}`, { headers: { Authorization: `Bearer ${await adminToken()}` } });
  const b = await r.json() as { cur: { from: string }; tiles: { key: string; now: number }[] };
  const dep = await pool.query<{ v: string }>(
    `SELECT COALESCE(SUM(value),0) AS v FROM statistics_values
      WHERE department='sales' AND metric_key='calls' AND period_type='week' AND period_start=$1 AND team_lead IS NOT NULL`, [b.cur.from]);
  const depV = Number(dep.rows[0].v);
  const tile = b.tiles.find((t) => t.key === "calls")!.now;
  assert.ok(depV > 0, "🔴 депстат за закритий тиждень порожній — звіряти нема з чим");
  // Межа 5%: привʼязка людей до команд береться на сьогодні, депстат — тодішня (02.10: 0% і 3.9% за два тижні).
  assert.ok(Math.abs(tile - depV) / depV <= 0.05, `🔴 дзвінки плитки ${tile} проти депстату ${depV} — два різні правила «дзвінка» на одному екрані`);
});

test("#880b ЖИВИЙ: прорахунки плитки за закритий тиждень == «Лідогенерація» за ті самі дати", needsApi(), async () => {
  const anchor = lastSunday();
  const tok = await adminToken();
  const a = await (await fetch(`${API_BASE}/api/statistics/summary?gran=week&anchor=${anchor}`, { headers: { Authorization: `Bearer ${tok}` } })).json() as
    { cur: { from: string; to: string }; tiles: { key: string; now: number }[] };
  const lg = await (await fetch(`${API_BASE}/api/dashboard/leadgen-stats?from=${a.cur.from}&to=${a.cur.to}`, { headers: { Authorization: `Bearer ${tok}` } })).json() as
    { totals: { quotes: number } };
  const tile = a.tiles.find((t) => t.key === "transfers")!.now;
  assert.ok(lg.totals.quotes > 0, "🔴 «Лідогенерація» за закритий тиждень дала 0 прорахунків — звіряти нема з чим");
  assert.equal(tile, lg.totals.quotes, "🔴 плитка й екран «Лідогенерація» показують різні прорахунки за ті самі дати");
});

test("#881d ЖИВИЙ: лінія плану на графіку за закритий тиждень == плану на плитці (одна функція, одне число)", needsApi(), async () => {
  const anchor = lastSunday();
  const tok = await adminToken();
  const a = await (await fetch(`${API_BASE}/api/statistics/summary?gran=week&anchor=${anchor}`, { headers: { Authorization: `Bearer ${tok}` } })).json() as
    { cur: { from: string }; tiles: { key: string; plan: number | null }[] };
  const tilePlan = a.tiles.find((t) => t.key === "revenue")!.plan;
  assert.ok(tilePlan != null && tilePlan > 0, "🔴 у плитки за закритий тиждень немає плану — звіряти нема з чим");
  const r = await fetch(`${API_BASE}/api/statistics/series?metric=payment_received&granularity=week&from=${a.cur.from}&to=${anchor}`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 200);
  const b = await r.json() as { plan?: { scopeKey: string; points: { period: string; value: number }[] }[] };
  const pt = b.plan?.find((p) => p.scopeKey === "company")?.points.find((p) => p.period === a.cur.from);
  assert.ok(pt, "🔴 на графіку немає точки плану за цей тиждень");
  assert.equal(Math.round(pt.value), tilePlan, "🔴 графік і плитка показують різний план того самого тижня");
});

test("#882b ЖИВИЙ: план авто на графіку за закритий тиждень == плану плитки «Відправлені авто»", needsApi(), async () => {
  const anchor = lastSunday();
  const tok = await adminToken();
  const a = await (await fetch(`${API_BASE}/api/statistics/summary?gran=week&anchor=${anchor}`, { headers: { Authorization: `Bearer ${tok}` } })).json() as
    { cur: { from: string }; tiles: { key: string; plan: number | null }[] };
  const tilePlan = a.tiles.find((t) => t.key === "dispatched")!.plan;
  assert.ok(tilePlan != null && tilePlan > 0, "🔴 у плитки «Відправлені авто» за закритий тиждень немає плану — звіряти нема з чим");
  const r = await fetch(`${API_BASE}/api/statistics/series?block=sales&metric=cars_delivered&granularity=week&from=${a.cur.from}&to=${anchor}`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 200);
  const b = await r.json() as { plan?: { scopeKey: string; points: { period: string; value: number }[] }[] };
  const pt = b.plan?.find((p) => p.scopeKey === "company")?.points.find((p) => p.period === a.cur.from);
  assert.ok(pt, "🔴 на графіку «Поставлені» немає точки плану за цей тиждень");
  assert.equal(pt.value, tilePlan, "🔴 графік і плитка показують різний план авто того самого тижня");
});
