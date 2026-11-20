import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { needsApi, API_BASE } from "../testMode.js";
import { kyivMonthBounds } from "../core/dates.js";

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
  // Сама арифметика мусить існувати РІВНО В ОДНОМУ місці.
  // ⚠️ ДІМ ЇЇ ПЕРЕЇХАВ: із `pctOfPlan` у `pctOf(v, base)`, бо двосегментна смуга
  //    зробила той самий вираз потрібним і для двигуна, і для команди — з іншими
  //    знаменниками. `pctOfPlan` лишився обгорткою над ним для компанійського скоупу.
  const arith = (body.match(/Math\.round\(\(v \/ base\) \* 100\)/g) ?? []).length;
  assert.equal(arith, 1,
    `🔴 вираз відсотка зустрічається ${arith} раз(и) — має бути РІВНО один (тіло pctOf). `
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

/**
 * K4 — ВКЛАДЕНИЙ ПЕРІОД НЕ МОЖЕ ПЕРЕВИЩУВАТИ ТОЙ, ЩО ЙОГО МІСТИТЬ.
 *
 * 🔴 ПРИВІД. Перемикач «Тиждень» показував стратплан **5 459 000 ₴** проти місячних
 * 2 759 000 і «відправлено» **1801 авто / 5 031 131 ₴** проти 652 / 1 745 882.
 * Механізм: `monthsInRange("2026-07-27","2026-08-02")` дає ОБИДВА місяці, а далі
 * і план, і «авто» бралися ЦІЛИМИ місяцями (`inRange(ym)`).
 *
 * 🔴 ЦЕ ТВЕРДЖЕННЯ НЕ ЗАЛЕЖИТЬ ВІД ТОГО, ЯКА ФОРМУЛА ПРАВИЛЬНА — і саме тому воно
 * ловить те, чого не ловлять гейти про самі метрики (той самий принцип, що `#46`).
 */
test("K4 ВКЛАДЕНІСТЬ: не-місячний діапазон не бере цілі місяці", () => {
  const body = kvpRouteBody();
  // «Відправлено» — зі SCOPED джерела. `dispatchedByLoadMonth` ігнорує from/to за
  // побудовою (віддає 12 місяців), тож її повернення = повернення роздування.
  assert.ok(!/dispatchedByLoadMonth\(/.test(body),
    "🔴 повернулась `dispatchedByLoadMonth` — вона ІГНОРУЄ from/to й віддає 12 місяців, "
    + "тобто тиждень знову складеться з повних місяців");
  assert.match(body, /dispatchedByLoadBucket\(scope, "month"\)/,
    "🔴 «відправлено» більше не бере scoped-джерело");
  // Підсумок не фільтрує по цілих місяцях — bucket уже обрізаний діапазоном.
  assert.ok(!/sumSeries\(dispatchedAllSeries/.test(body),
    "🔴 «відправлено» знову підсумовується фільтром по ЦІЛИХ місяцях (`inRange`)");
  // План: на не-місячному діапазоні — частка, а не сума місяців.
  assert.match(body, /const monthAligned = /,
    "🔴 немає ознаки «діапазон = календарний місяць» — отже гілки для частки теж немає");
  assert.match(body, /planWeight/,
    "🔴 немає ваги місяця за робочими днями — план знову складається цілими місяцями");
  assert.match(body, /effWeekKvp/,
    "🔴 поточний тиждень більше не бере канонічну ціль (`effectiveWeekTargets`) — "
    + "КВП показуватиме СВОЮ тижневу ціль поруч зі Звітом, що показує канонічну");
  // 🪞 Дзеркало: місячний діапазон лишається на Σ команд (інакше «частка» тихо
  //    переписала б і місяць, а Σ команд == Σ менеджерів == Σ тижнів — інваріант).
  assert.match(body, /monthAligned\s*\n?\s*\?\s*teams\.reduce/,
    "🔴 на місячному діапазоні стратплан більше не дорівнює Σ планів команд");
});

/**
 * K10 — ДВОСЕГМЕНТНА СМУГА ПОКАЗУЄ ТЕ САМЕ, ЩО ЧИСЛО ПРОГНОЗУ ПОРУЧ.
 *
 * 🔴 ПРИВІД І ЗАМІР (прод, 20.08.2026). Плитка двигуна показувала «Очікуємо
 * 904 462 ₴» — це `expectedZoneByScope`, ЗНІМОК УСІЄЇ зони без прив'язки до дати.
 * А в прогноз входить `expectedThisMonth` = **800 744 ₴** (за плановою датою цього
 * місяця). Розрив **103 718 ₴**: 88 817 наступного місяця + 14 901 прострочене.
 * Заповни смугу тим, що плитка ПОКАЗУВАЛА, — і вона розійшлася б із числом
 * прогнозу на тому самому екрані. Класика двох «очікуємо» під одним підписом.
 *
 * 🔴 ЗВІРКА — В МЕЖАХ ОДНОГО СКОУПУ, і це не формальність. Σ команд по
 * `expectedThisMonth` дає 900 925 проти компанійських 902 222: різницю в
 * **1 297 ₴** тримає «Операційний директор» (`id=2`, `team_id = NULL`) — він є в
 * компанії й немає в жодній команді. Це ВІДОМЕ відхилення, а не помилка, тож
 * гейт порівнює компанію з компанією, а плитку — з сумою ЇЇ команд.
 */
test("K10 СМУГА == ПРОГНОЗ, і очікування береться за ПЛАНОВОЮ ДАТОЮ", () => {
  const body = kvpRouteBody();
  // Плитка двигуна віддає САМЕ датоване очікування, а не знімок усієї зони.
  assert.match(body, /const expectedThisMonth = ts\.reduce\(/,
    "🔴 двигун більше не збирає `expectedThisMonth` — смузі нема чим заповнюватись, "
    + "крім повної зони, а вона в прогноз не входить");
  assert.match(body, /forecastPct: pctOf\(revenue \+ expectedThisMonth, plan\)/,
    "🔴 прогнозний відсоток двигуна рахується не як «факт + датоване очікування»");
  // Повна зона НЕ зникає — вона лишається окремим полем для підказки.
  assert.match(body, /return \{ plan, revenue, expected, expectedThisMonth,/,
    "🔴 `expected` (уся зона) прибрано — підказці нема що показати, і два «очікуємо» "
    + "знову злиплись в одне");
  // Рядок команди — той самий вираз, той самий скоуп (свій план).
  assert.match(body, /forecastPct: pctOf\(t\.revenue \+ \(expTeamThisMap\.get\(t\.teamId\) \?\? 0\), t\.plan\)/,
    "🔴 команда рахує прогнозний відсоток іншим виразом або від іншої бази");

  // 🔒 АРИФМЕТИКА ВІДСОТКА — РІВНО ОДНА на всі скоупи.
  const arith = (body.match(/Math\.round\(\(v \/ base\) \* 100\)/g) ?? []).length;
  assert.equal(arith, 1, `🔴 вираз відсотка зустрічається ${arith} раз(и) — має бути один (тіло pctOf)`);
  // ⚠️ ЛОВИМО КОПІЮ З БАЗОЮ-ПЛАНОМ, а не «будь-який відсоток». Два винятки свідомі:
  //    тіло самого `pctOf` (воно й має бути) і ROMI — у нього база рекламний БЮДЖЕТ,
  //    інший сенс, і власник його зі скоупу цієї правки виключив.
  const legacy = (body.match(/\w+ > 0 \? Math\.round\(\([\w.]+ \/ [\w.]+\) \* 100\) : null/g) ?? [])
    .filter((x) => !x.includes("/ base") && !x.includes("budgetFact"));
  assert.deepEqual(legacy, [],
    `🔴 повернулась власна копія відсотка ПЛАНУ повз pctOf: ${legacy.join(" · ")}`);
  // Компанійська обгортка лишається — інакше скоуп «компанія» загубився б.
  assert.match(body, /const pctOfPlan = \(v: number\): number \| null => pctOf\(v, strategic\)/,
    "🔴 pctOfPlan більше не є обгорткою над спільною арифметикою");
});

/**
 * K10c — 🪞 ДЗЕРКАЛО: очікування нема → другого сегмента НЕМАЄ.
 * Сегмент нульової ширини — це артефакт, а не «нуль очікувань». Порожнє місце має
 * лишатись порожнім (те саме правило, що «невідоме читається як невідоме»).
 */
test("K10c ОЧІКУВАННЯ НЕМА — сегмента немає, а не нульова смужка", () => {
  const fe = src(FE);
  const fn = fe.slice(fe.indexOf("function PlanBar("), fe.indexOf("function Stat("));
  assert.match(fn, /\{e > 0 && </,
    "🔴 другий сегмент малюється завжди — при нульовому очікуванні лишиться примара");
  // Односегментного `Bar` більше немає — інакше поверхня могла б тихо лишитись на ньому.
  assert.ok(!/function Bar\(/.test(fe),
    "🔴 повернувся односегментний Bar — поверхня може мовчки лишитись на старій смузі, "
    + "і це читатиметься як робочий код (доля `expected` у /teams і `BandHead`)");
  assert.ok(!/<Bar\b/.test(fe), "🔴 десь лишився виклик старої смуги");
});

/**
 * K10d — 🔌 ШЛЯХИ, ЯКІ ЧИТАЄ ПЛИТКА, ІСНУЮТЬ У ЖИВІЙ ВІДПОВІДІ `/kvp-report`.
 *
 * 🔴 ЦЕ КЛАС `#106`, І ВІН НАС ЩОЙНО ВКУСИВ ДВІЧІ. Прохід 2 Звіту виїхав на прод
 * із `conversionAd`/`conversionLeadgen`, покладеними ВСЕРЕДИНУ `kpi`, тоді як фронт
 * читає їх на верхньому рівні: увімкнення чипа дало б `undefined.fact` — падіння
 * таблиці, а не хибне число. TypeScript тут безсилий: бекенд і фронт компілюються
 * ОКРЕМО, і фронтовий тип не є контрактом для роута.
 *
 * 🔴 І `#106` ЦЮ ПЛИТКУ НЕ ПОКРИВАЄ. Він бере живу відповідь `/report-plan`; плитка
 * читає `/kvp-report`. Різні роути — різні контракти, і «схожий гейт поруч» не
 * стереже нічого. Тому тут своя перевірка того самого класу.
 *
 * ⚠️ Перевіряємо НАЯВНІСТЬ ШЛЯХУ, а не число: число живе й міняється щогодини,
 * а от `engines.rpk.expectedThisMonth`, покладене на поверх нижче, зробить смугу
 * порожньою мовчки.
 */
test("K10d ЖИВА ВІДПОВІДЬ /kvp-report має всі шляхи, які читає смуга", needsApi(), async () => {
  const { signToken } = await import("../auth/auth.js");
  const token = signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
  const ym = kyivMonthBounds().ym;
  const r = await fetch(`${API_BASE}/api/dashboard/kvp-report?preset=month&date=${ym}-01`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, `🔴 /kvp-report віддав ${r.status}`);
  const body = await r.json() as Record<string, unknown>;

  /** Шлях мусить існувати І бути числом (або null там, де плану немає). */
  const at = (obj: unknown, pth: string): { ok: boolean; val: unknown } => {
    let cur = obj;
    for (const seg of pth.split(".")) {
      if (cur == null || typeof cur !== "object" || !(seg in (cur as object))) return { ok: false, val: undefined };
      cur = (cur as Record<string, unknown>)[seg];
    }
    return { ok: true, val: cur };
  };
  const need = [
    // компанійська смуга
    "verdict.planPct", "verdict.projection.projectedPct", "verdict.projection.expectedThisMonth",
    "verdict.projection.projected", "verdict.received.revenue",
    // плитки двигунів — саме той шлях, який ламався б тихо
    "engines.rpk.expectedThisMonth", "engines.rpk.forecastPct", "engines.rpk.pct", "engines.rpk.expected",
    "engines.rnk.expectedThisMonth", "engines.rnk.forecastPct", "engines.rnk.pct", "engines.rnk.expected",
  ];
  const missing = need.filter((p) => !at(body, p).ok);
  assert.deepEqual(missing, [],
    "🔴 СМУГА ЧИТАЄ ТЕ, ЧОГО У ВІДПОВІДІ НЕМАЄ. Поле, покладене на поверх нижче, не дає\n"
    + "хибного числа — воно дає порожню смугу або падіння:\n  " + missing.join("\n  "));

  // Рядок команди — той самий контракт, але на елементі масиву.
  const teams = (body.teams ?? []) as Record<string, unknown>[];
  assert.ok(teams.length > 0, "🔴 у відповіді жодної команди — перевіряти нема на чому");
  for (const f of ["pct", "forecastPct", "expectedThisMonth", "plan", "revenue"])
    assert.ok(f in teams[0], `🔴 у рядку команди немає «${f}» — смуга рядка не намалюється`);

  // 🔒 І ЗМІСТ, а не лише наявність: датоване очікування НЕ БІЛЬШЕ за всю зону.
  for (const k of ["rpk", "rnk"]) {
    const zone = Number(at(body, `engines.${k}.expected`).val ?? 0);
    const dated = Number(at(body, `engines.${k}.expectedThisMonth`).val ?? 0);
    assert.ok(dated <= zone + 1,
      `🔴 ${k}: «за плановою датою» (${dated}) більше за ВСЮ зону (${zone}) — поля переплутані місцями`);
  }
});
