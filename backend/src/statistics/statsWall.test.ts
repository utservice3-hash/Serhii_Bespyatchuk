import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mainSpec, bucketOfDay, sumIntoBuckets, periodStarts, blockDenied } from "./statsBuckets.js";
import { STATS_CRM_FROM, hasDepstats } from "./seriesCatalog.js";
import { clipPointsToToday } from "./statsCompare.js";
import { needsApi, API_BASE } from "../testMode.js";

/**
 * 🧱 #10400–#10416 — ЕКРАН «СТАТИСТИКИ» = СТІНА КАРТОК + ЛИШЕ CRM І ДАШБОРД (зустріч 20.11.2026).
 * Рішення Романа 20.11: «картки з цифрами — так» (ТЗ 14.10 «лише графіки» скасовано); «всі дані з CRM — дашборду, немає
 * ніяких інших даних»; «Мій набір» — у браузері; машини нових = повністю нові клієнти, джерело не важливе.
 *
 * Прохід А — стіна (`#10400`–`#10406`), прохід Б — ряди (`#10410`–`#10416`). Правила фронту ВИКОНУЮТЬСЯ (транспіляція
 * `statsCards.ts`), а не читаються очима; джерело звіряється лише там, де твердження — про проводку.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SEC = "frontend/src/pages/dashboard/sections";
const ROUTE = "backend/src/routes/statisticsSeries.ts";
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

async function loadCards() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(read("frontend/src/pages/dashboard/statsCards.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}
const P = (period: string, value: number) => ({ period, value });

// ─────────────────────────────── ПРОХІД А · СТІНА ───────────────────────────────

/**
 * #10400 — КАРТКА НІКОЛИ НЕ ПОРІВНЮЄ ПЕРІОД, ЩО ЙДЕ. Головне число — останній ПОВНИЙ період, порівняння — з СУСІДНІМ
 * повним; «половина листопада проти цілого жовтня» читалась би як обвал (клас #877).
 * 🧨 Червоніє, якщо поточний період потрапить у «повні», якщо prev візьметься «будь-яка попередня точка» через дірку,
 * або обрив ряду перестане називатись.
 */
test("#10400 КАРТКА: число — останній повний період, порівняння — з сусіднім повним, період, що йде, — окремо", async () => {
  const { cardFigures, prevPeriod, periodStartOf } = await loadCards();
  // Місяць: 20.11 — листопад іде.
  const m = cardFigures([P("2026-09-01", 100), P("2026-10-01", 120), P("2026-11-01", 30)], "month", "2026-11-20");
  assert.equal(m.last?.period, "2026-10-01", "🔴 головне число — не жовтень (останній повний), а період, що йде");
  assert.equal(m.prev?.period, "2026-09-01");
  assert.equal(m.deltaPct, 20, "🔴 зміна жовтня до вересня не +20%");
  assert.equal(m.current?.value, 30, "🔴 листопад «станом на» зник");
  assert.equal(m.currentStart, "2026-11-01");
  assert.equal(m.missingSince, null, "🔴 обрив ряду вигадано там, де його немає");
  // 🪞 Падіння — теж число, а не «немає з чим порівняти».
  assert.equal(cardFigures([P("2026-09-01", 100), P("2026-10-01", 80)], "month", "2026-11-20").deltaPct, -20);
  // Дірка у вересні: prev — НЕ серпень.
  const gap = cardFigures([P("2026-08-01", 100), P("2026-10-01", 120)], "month", "2026-11-20");
  assert.equal(gap.prev, null, "🔴 порівняння через дірку: жовтень проти серпня під підписом «до попереднього»");
  assert.equal(gap.deltaPct, null);
  // Ряд обривається у вересні: про жовтень треба сказати словами.
  const cut = cardFigures([P("2026-08-01", 50), P("2026-09-01", 80)], "month", "2026-11-20");
  assert.equal(cut.last?.period, "2026-09-01");
  assert.equal(cut.missingSince, "2026-09-01", "🔴 «після вересня даних немає» не сказано — картка видає вересень за останній місяць");
  assert.equal(cut.current, null);
  assert.equal(cardFigures([P("2026-09-01", 0), P("2026-10-01", 5)], "month", "2026-11-20").deltaPct, null, "🔴 ділення на нуль у зміні");
  // Тиждень: пʼятниця 20.11 і неділя 22.11 — обидві в тижні з понеділка 16.11.
  const w = cardFigures([P("2026-11-02", 10), P("2026-11-09", 12), P("2026-11-16", 3)], "week", "2026-11-20");
  assert.deepEqual([w.last?.period, w.prev?.period, w.deltaPct, w.current?.value], ["2026-11-09", "2026-11-02", 20, 3],
    "🔴 тижнева картка порівнює неповний тиждень або не той сусідній");
  assert.equal(periodStartOf("2026-11-22", "week"), "2026-11-16", "🔴 неділя віднесена до наступного тижня");
  assert.equal(prevPeriod("2026-01-01", "month"), "2025-12-01", "🔴 січень не бачить грудня минулого року");
  assert.equal(prevPeriod("2026-03-01", "month"), "2026-02-01");
});

/**
 * #10401 — «МІЙ НАБІР» ІЗ БРАУЗЕРА: вміст сховища — чужий текст. Розбір ніколи не кидає, лишає лише відомі ключі без
 * повторів і не більше MINE_MAX. 🪞 Дзеркало: правильний набір лишається тим самим і в тому самому порядку.
 * 🧨 Червоніє, якщо прибрати фільтр відомих ключів або дедуп.
 */
test("#10401 «МІЙ НАБІР»: сміття, не-масив, невідомі ключі й повтори відкидаються; правильний набір — як був", async () => {
  const { parseMine, MINE_MAX } = await loadCards();
  const known = ["a", "b", "c"];
  assert.deepEqual(parseMine(null, known), []);
  assert.deepEqual(parseMine("{не json", known), [], "🔴 зламаний localStorage кладе екран");
  assert.deepEqual(parseMine('{"a":1}', known), []);
  assert.deepEqual(parseMine('["a","zzz","a",5,"b"]', known), ["a", "b"], "🔴 невідомий показник або повтор потрапили на стіну");
  assert.deepEqual(parseMine('["c","a"]', known), ["c", "a"], "🔴 правильний набір змінено (порядок людини — її порядок)");
  const many = Array.from({ length: 40 }, (_, i) => `k${i}`);
  assert.equal(parseMine(JSON.stringify(many), many).length, MINE_MAX, "🔴 набір без стелі");
});

/**
 * #10402 — ГОЛОВНА СЕРІЯ КАРТКИ ЗВУЖУЄ ВЖЕ ДОЗВОЛЕНЕ. Адмін — компанія, тімлід — своя команда (компанія йому лише
 * бенчмарк), менеджер — він сам. Роут бере `mainSpec` з набору ПІСЛЯ клампу ролі й без плану.
 * 🧨 Червоніє, якщо картка тімліда покаже бенчмарк компанії замість його команди, або `scope=main` піде повз клам.
 */
test("#10402 ГОЛОВНА СЕРІЯ: адмін — компанія, тімлід — своя команда, менеджер — він сам; роут звужує набір після клампу", () => {
  type S = { scopeKey: string; benchmark?: boolean };
  const company: S = { scopeKey: "company" }, team: S = { scopeKey: "5" }, mgr: S = { scopeKey: "77" };
  assert.deepEqual(mainSpec<S>([company, team, { scopeKey: "6" }]), [company], "🔴 адмін бачить на картці не компанію");
  assert.deepEqual(mainSpec([{ ...company, benchmark: true }, team, mgr]), [team], "🔴 картка тімліда — бенчмарк компанії, а не його команда");
  assert.deepEqual(mainSpec([mgr]), [mgr]);
  assert.deepEqual(mainSpec([]), [], "🔴 порожній набір (напрямок без права) дав серію");
  assert.deepEqual(mainSpec([{ ...company, benchmark: true }]), [{ ...company, benchmark: true }], "🔴 некомерційний тімлід лишився без картки");
  const route = codeOnly(read(ROUTE));
  assert.match(route, /const full = await seriesSet\([\s\S]{0,200}\);\s*[\s\S]{0,400}const lite = req\.query\.scope === "main";\s*const set = lite \? mainSpec\(full\) : full;/,
    "🔴 scope=main бере серію не з набору після клампу ролі");
  assert.match(route, /const series = await Promise\.all\(set\.map\(\(s\) => stitch\(/, "🔴 серії рахуються не з звуженого набору");
  assert.match(route, /if \(lite\) plan = \[\];/, "🔴 картка тягне план, якого не малює");
});

/**
 * #10403 — ПРОВОДКА ЕКРАНА (заміняє `#1762` і `#877`). Стіна кличе `scope: "main"` і рахує картку `cardFigures`;
 * рейка відділів — той самий ланцюг CATS; «Мій набір» — з localStorage через `parseMine`; розгорнутий показник —
 * той самий графік, а «＋ Показник» — з будь-якого відділу. Плиток `StatisticsSummary`, «План-факт», лінії плану
 * немає, як і тексту шва під графіком; помилка — помилка, а не «немає даних».
 */
test("#10403 ЕКРАН: стіна карток (scope=main, cardFigures), рейка відділів, «Мій набір» з браузера, графік і помилка — на місці", () => {
  const fe = codeOnly(read(`${SEC}/StatisticsChartsSection.tsx`));
  const wall = fe.slice(fe.indexOf("function StatsWall("), fe.indexOf("function WallCard("));
  assert.ok(wall.length > 200, "🔴 стіни StatsWall немає — перевіряти нема що");
  assert.match(wall, /fetchStatsSeries\(\{[^}]*scope: "main" \}\)/, "🔴 картки тягнуть усі команди замість головної серії");
  assert.match(fe, /const f = cardFigures\(points, g, today\);/, "🔴 картка рахує число не правилом cardFigures");
  assert.match(fe, /parseMine\(localStorage\.getItem\(MINE_KEY\)/, "🔴 «Мій набір» читається не через parseMine");
  assert.match(fe, /localStorage\.setItem\(MINE_KEY, JSON\.stringify\(/, "🔴 «Мій набір» не зберігається в браузері");
  assert.match(fe, /CATS\.filter\(\(c\) => !c\.manualForm\)\.map\(/, "🔴 зникла рейка відділів");
  assert.match(fe, /Показник з будь-якого відділу/, "🔴 «＋ Показник» знову лише з поточного відділу");
  assert.match(fe, /<LineChart data=\{rows\}/, "🔴 розгорнутого графіка немає");
  assert.match(fe, /<ValuesTable rows=\{rows\.slice\(eff\.lo, eff\.hi \+ 1\)\}/, "🔴 таблиці значень під графіком немає");
  assert.match(fe, /return last && prev && String\(last\.period\) >= curStart\s*\? <ReferenceArea [^>]*label=\{\{ value: "іде"/, "🔴 період, що йде, на великому графіку не позначений — неповний місяць читається як обвал");
  assert.match(read("frontend/src/pages/Dashboard.tsx"), /section === "statistics" && <StatisticsChartsSection role=\{auth\?\.role\} \/>/);
  assert.match(read("frontend/src/api.ts"), /scope\?: "main"/, "🔴 клієнт API не передає scope");
  assert.doesNotMatch(fe, /<StatisticsSummary\b|from "\.\/StatisticsSummary"|<StatisticsPlanFact\b/, "🔴 повернулись старі плитки / «План-факт»");
  assert.doesNotMatch(fe, /type="stepAfter"|resp\.plan/, "🔴 на графіку знову лінія плану");
  assert.doesNotMatch(fe, /\{SEAM_NOTE\}/, "🔴 пояснення ряду знову текстом під графіком, а не в ⓘ");
  assert.doesNotMatch(fe, /очікує вводу/, "🔴 помилка завантаження знову читається як «немає даних»");
  assert.match(fe, /setLoadErr\(/, "🔴 збій запиту не показується як помилка");
});

/**
 * #10404 — ВІДДІЛИ Й «ЧАС ОПРАЦЮВАННЯ» (заміняє `#2445`). Порядок рейки — як на макеті; медіана й «до 5 хв» — у «Продажах»
 * з ядра вікна (`leadTakeSeries` + фільтр вікна), у каталозі CRM_ABLE, із застереженням про порожні до вересня поле й нотатки.
 */
test("#10404 ВІДДІЛИ: порядок рейки; «Час опрацювання» — у «Продажах», з ядра вікна і зі застереженням", async () => {
  const fe = read(`${SEC}/StatisticsChartsSection.tsx`);
  const cats = fe.slice(fe.indexOf("const CATS"), fe.indexOf("const MULTI_POOL"));
  assert.deepEqual([...cats.matchAll(/^\s{2}\{ key: "(\w+)", icon:/gm)].map((m) => m[1]),
    ["sales", "ads", "leadgen", "tenders", "logistics", "finance", "hr", "manual"], "🔴 склад або порядок відділів не той, що на макеті");
  const sales = cats.slice(cats.indexOf(`{ key: "sales"`), cats.indexOf(`{ key: "ads"`));
  assert.match(sales, /\{ key: "lead_take_median", block: "sales", label: "Медіана часу опрацювання заявки, хв", unit: "хв",/);
  assert.match(sales, /\{ key: "lead_take_m5_pct", block: "sales", label: "Взято до 5 хв, %", unit: "%",/);
  assert.doesNotMatch(sales, /lead_take_(avg|mean)|label: "[^"]*середн[^"]*хв/i, "🔴 зʼявилось середнє часу — рішення власника: лише медіана");
  assert.ok(fe.includes("до вересня поле «Взято в роботу» й нотатки-дзвінки майже порожні — частка «взято» тоді спиралась на етап і Ringostat"),
    "🔴 у ⓘ немає застереження про порожні до вересня поле й нотатки");
  const { isCrmAble } = await import("./seriesCatalog.js");
  for (const k of ["lead_take_median", "lead_take_m5_pct"]) assert.ok(isCrmAble("sales", k), `🔴 ${k} не в CRM_ABLE`);
  const route = read(ROUTE);
  assert.match(route, /\blead_take_median: leadTakeC\(\(s\) => s\.medianMin\),/);
  assert.match(route, /\blead_take_m5_pct: leadTakeC\(\(s\) => s\.m5Pct\),/);
  assert.match(route, /await leadTakeSeries\(\{ from, to, \.\.\.SERIES_TAKE_FILTER, teamId, managerId \}, g\)/, "🔴 обчислювач іде повз ядро вікна");
});

/**
 * #10405 — ВІСЬ І КЕРУВАННЯ ГРАФІКА (заміняє `#879`). Круглі поділки, підписані «Крок» і «Період», дефолт 3 місяці,
 * пояснення ряду — в ⓘ. Шва 01.07 на графіку більше немає (таблиці на графіку немає), і точки не підписані «ручна таблиця».
 */
test("#10405 ГРАФІК: круглі поділки, «Крок»/«Період», 3 місяці; без лінії шва й «ручної таблиці»; ⓘ каже, звідки ряд", async () => {
  const ts = (await import("typescript")).default;
  const src = read(`${SEC}/StatisticsChartsSection.tsx`);
  const fn = src.slice(src.indexOf("export function niceTicks"), src.indexOf("const axisFmt"));
  const js = ts.transpileModule(fn.replace("export function", "function") + "\nmodule.exports = niceTicks;", { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const m = { exports: {} as unknown };
  new Function("module", js)(m);
  const niceTicks = m.exports as (max: number) => number[];
  assert.deepEqual(niceTicks(14000), [0, 5000, 10000, 15000]);
  assert.deepEqual(niceTicks(0), [0]);
  assert.match(src, />Крок:</);
  assert.match(src, />Період:</);
  assert.match(src, /useState\("3м"\)/);
  assert.match(src, /<InfoHint text=\{\[metric\.hint, metric\.seamHint, SEAM_NOTE\]\.filter\(Boolean\)\.join\(" · "\)\} \/>/);
  const code = codeOnly(src);
  assert.doesNotMatch(code, /<ReferenceLine\b|value: "01\.07"/, "🔴 на графіку знову лінія шва таблиці");
  assert.doesNotMatch(code, /ручна таблиця/, "🔴 точки знову підписані «ручна таблиця» — таблиці на графіку немає");
  const note = /const SEAM_NOTE = "([^"]+)"/.exec(src)?.[1] ?? "";
  assert.match(note, /лише з CRM/, "🔴 ⓘ не каже, що ряд лише з CRM");
  assert.match(note, /від 06\.2025/, "🔴 ⓘ не називає глибину ряду — обрив читатимуть як «до того було нуль»");
});

/** #10406 — ФАКТ НЕ В МАЙБУТНЄ (заміняє `#882d`; підпис шва прибрано разом зі швом — `#10405`). */
test("#10406 ФАКТ НА ГРАФІКУ — НЕ В МАЙБУТНЄ: поточний період лишається, наступний — ні", () => {
  const pts = [P("2026-09-28", 207), P("2026-10-05", 5), P("2026-10-12", 1)];
  assert.deepEqual(clipPointsToToday(pts, "2026-10-02").map((p) => p.period), ["2026-09-28"], "🔴 заплановані завантаження стоять як факт");
  const route = codeOnly(read(ROUTE));
  assert.match(route, /for \(const s of series\) s\.points = clipPointsToToday\(s\.points, today\);/, "🔴 серія віддає точки з майбутнього");
});

// ─────────────────────────────── ПРОХІД Б · РЯДИ ───────────────────────────────

/**
 * #10410 — РЯД НЕ ЧИТАЄ РУЧНОЇ ТАБЛИЦІ (заміняє `#871` і `#2446`). `stats_series` згадує лише запис ручних показників
 * (`POST /series/manual`); серія — тільки COMPUTERS / депстат-авто від `cf`. Нових роутів немає, матриця та сама.
 */
test("#10410 ЛИШЕ CRM: серія не читає stats_series; обчислювачі — від cf; склад роутів і матриця ті самі", () => {
  const route = codeOnly(read(ROUTE));
  const manualAt = route.indexOf(`statsSeriesRouter.post("/series/manual"`);
  assert.ok(manualAt > 0, "🔴 не знайшов POST /series/manual — зріз став би порожнім");
  assert.equal((route.slice(0, manualAt).match(/\bstats_series\b/g) ?? []).length, 0, "🔴 серія знову читає ручну таблицю");
  assert.ok((route.slice(manualAt).match(/\bstats_series\b/g) ?? []).length >= 1, "🪞 запис ручних показників зник — зріз нічого не довів");
  assert.match(route, /if \(metric in COMPUTERS\) crm = await COMPUTERS\[metric\]\(g, cf, to, sc\.teamId, sc\.managerId\);/, "🔴 обчислювач не від cf або не зі скоупу серії");
  assert.match(route, /else if \(hasDepstats\(block, metric\)\) crm = await depstatsRead\(block, metric, g, cf, to, sc\);/);
  assert.doesNotMatch(route, /storedPoints|companySalesSheet|applyCorrections|sheetWeekToMonday/, "🔴 повернулась зшивка з таблицею");
  const paths = [...route.matchAll(/statsSeriesRouter\.(get|post|put|patch|delete)\("([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(paths, ["GET /series", "GET /summary", "GET /plan-fact", "GET /lapsed-clients", "POST /series/manual"], "🔴 склад роутів змінився — потрібен запис у матриці");
  assert.match(read("backend/src/auth/accessMatrix.ts"), /\{ method: "GET", path: "\/api\/statistics\/series", cls: "GET",/);
});

/**
 * #10411 — ГЛИБИНА РЯДУ = 06.2025 (замір 20.11: до червня 2025 CRM має 12–48% угод ручного підрахунку). Кламп `from` і
 * фільтр точок — по тій самій межі, тож тиждень, що почався раніше, не виходить «повним».
 */
test("#10411 ГЛИБИНА: STATS_CRM_FROM = 2025-06-01; ряд клампиться й фільтрується по ній", () => {
  assert.equal(STATS_CRM_FROM, "2025-06-01", "🔴 глибина ряду змінилась без заміру");
  const route = codeOnly(read(ROUTE));
  assert.match(route, /const cf = from > STATS_CRM_FROM \? from : STATS_CRM_FROM;/, "🔴 ряд не клампиться по глибині CRM");
  assert.match(route, /const points = crm\.filter\(\(p\) => p\.period >= cf && p\.period <= to\)/, "🔴 неповний кошик до межі показується як повний");
  assert.match(route, /crmFrom: STATS_CRM_FROM/, "🔴 фронт не знає глибини ряду");
  assert.match(read("docs/METRICS_GLOSSARY.md"), /## 23\. «СТАТИСТИКИ» — ЛИШЕ CRM І РОЗДІЛИ ДАШБОРДА[\s\S]*2025-06-01/, "🔴 правило глибини не в словнику");
});

/** #10412 — КОШИКИ: неділя — у своєму тижні з понеділка, межа місяця всередині тижня, порожній кошик не народжується. */
test("#10412 КОШИКИ: тиждень з понеділка, місяць з 1-го; Σ у кошик; початки періодів — не раніше from", () => {
  assert.equal(bucketOfDay("2026-11-22", "week"), "2026-11-16", "🔴 неділя — у наступному тижні");
  assert.equal(bucketOfDay("2026-11-16", "week"), "2026-11-16");
  assert.equal(bucketOfDay("2026-11-22", "month"), "2026-11-01");
  assert.equal(bucketOfDay("2026-11-22", "day"), "2026-11-22");
  const rows = [{ day: "2026-10-31", v: 2 }, { day: "2026-11-01", v: 3 }, { day: "2026-11-02", v: 5 }];
  assert.deepEqual(sumIntoBuckets(rows, "week", (r) => r.v), [{ bucket: "2026-10-26", value: 5 }, { bucket: "2026-11-02", value: 5 }],
    "🔴 тиждень через межу місяців розірвано або день загублено");
  assert.deepEqual(sumIntoBuckets(rows, "month", (r) => r.v), [{ bucket: "2026-10-01", value: 2 }, { bucket: "2026-11-01", value: 8 }]);
  assert.deepEqual(sumIntoBuckets([], "month", () => 1), [], "🔴 порожній кошик народився нулем — «не було» ≠ «нуль»");
  assert.deepEqual(periodStarts("week", "2026-10-28", "2026-11-20"), ["2026-11-02", "2026-11-09", "2026-11-16"],
    "🔴 тиждень, що почався до from, рахується як повний");
  assert.deepEqual(periodStarts("month", "2026-09-15", "2026-11-20"), ["2026-10-01", "2026-11-01"]);
  assert.deepEqual(periodStarts("month", "2026-10-01", "2026-11-20"), ["2026-10-01", "2026-11-01"], "🔴 місяць, що починається рівно в from, загублено");
});

/**
 * #10413 — «ФІНАНСИ» І HR НЕ СТАЮТЬ ОБХІДНИМ ВХОДОМ. Межа та сама, що в їхніх джерел: вкладка `finance`, право
 * `view_employee_secrets`. 🪞 Дзеркало: кому відкрито — бачать; «Продажі» межі не мають. Роут відмовляє ДО обчислення.
 */
test("#10413 ДОСТУП: «Фінанси» без вкладки й HR без реєстру — 403; кому відкрито — бачать; відмова до обчислення", () => {
  const can = (tabs: string[], perms: string[]) => ({ tab: (t: string) => tabs.includes(t), perm: (p: string) => perms.includes(p) });
  assert.ok(blockDenied("finance", can([], [])), "🔴 числа «Фінансів» видно без вкладки «Фінанси»");
  assert.equal(blockDenied("finance", can(["finance"], [])), null, "🔴 фінансист не бачить свого відділу");
  assert.ok(blockDenied("hr", can(["finance", "statistics"], [])), "🔴 плинність видно без права на реєстр людей");
  assert.equal(blockDenied("hr", can([], ["view_employee_secrets"])), null, "🔴 HR не бачить свого відділу");
  assert.equal(blockDenied("sales", can([], [])), null, "🔴 «Продажі» закрито тому, кому відкрито «Статистики»");
  const route = codeOnly(read(ROUTE));
  const h = route.slice(route.indexOf(`statsSeriesRouter.get("/series"`), route.indexOf(`statsSeriesRouter.get("/summary"`));
  const deniedAt = h.indexOf("blockDenied(block,"), setAt = h.indexOf("await seriesSet(");
  assert.ok(deniedAt > 0 && setAt > deniedAt, "🔴 межа «Фінансів»/HR не перевіряється або перевіряється після обчислення");
  assert.match(h, /if \(denied\) return res\.status\(403\)\.json\(\{ error: denied \}\);/);
  assert.match(h, /tab: \(t\) => roleHasTab\(auth\.roleKey, t\), perm: \(p\) => roleHasPerm\(auth\.roleKey, p\)/, "🔴 межа бере не роль глядача");
});

/** #10414 — МАШИНИ НОВИХ = ВІДПРАВЛЕНІ − ПОСТІЙНІ (словник §22), тим самим викликом ядра, що «всього». */
test("#10414 МАШИНИ НОВИХ: усі відправлені мінус постійні з того самого dispatchedByLoadBucket; правило в словнику", () => {
  const route = codeOnly(read(ROUTE));
  assert.match(route, /new_clients_cars: async \(g, from, to, teamId, managerId\) =>\s*\(await dispatchedByLoadBucket\(\{ from, to, teamId, managerId, activeOnly: true \}, g\)\)\.map\(\(x\) => P\(x\.ym, x\.deals - x\.repeat\)\),/,
    "🔴 «машини нових» рахуються не як усі відправлені мінус постійні того самого виклику");
  assert.match(route, /cars_delivered_all: async \(g, from, to, teamId, managerId\) =>\s*\(await dispatchedByLoadBucket\(\{ from, to, teamId, managerId, activeOnly: true \}, g\)\)\.map\(\(x\) => P\(x\.ym, x\.deals\)\),/);
  assert.match(read("docs/METRICS_GLOSSARY.md"), /## 22\. МАШИНИ НОВИХ КЛІЄНТІВ/, "🔴 правила немає в словнику");
});

/**
 * #10416 — КОЖЕН ПОКАЗНИК МЕНЮ МАЄ ОБЧИСЛЮВАЧ, І ОБЧИСЛЮВАЧ — ФУНКЦІЄЮ СВОГО ЕКРАНА. Пункт без обчислювача — порожній
 * графік, що читається як «немає даних»; обчислювач зі своїм SQL — число, що розійдеться з екраном-джерелом.
 */
test("#10416 ДЖЕРЕЛА: кожен показник меню — у COMPUTERS або депстат-авто; нові — функціями своїх екранів", () => {
  const route = codeOnly(read(ROUTE));
  const body = route.slice(route.indexOf("export const COMPUTERS"), route.indexOf("\n};", route.indexOf("export const COMPUTERS")));
  const computers = new Set([...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
  assert.ok(computers.size >= 30, `🔴 знайдено лише ${computers.size} обчислювачів — зріз зламався`);
  const fe = read(`${SEC}/StatisticsChartsSection.tsx`);
  const cats = fe.slice(fe.indexOf("const CATS"), fe.indexOf('{ key: "manual"'));
  const items = [...cats.matchAll(/\{ key: "(\w+)", block: "(\w+)"/g)].map((m) => [m[1], m[2]] as const);
  assert.ok(items.length >= 30, `🔴 знайдено лише ${items.length} показників меню`);
  const dead = items.filter(([k, b]) => !computers.has(k) && !hasDepstats(b, k)).map(([k]) => k);
  assert.deepEqual(dead, [], `🔴 показники меню без обчислювача (порожній графік): ${dead.join(", ")}`);
  const src: [string, RegExp][] = [
    ["prozorro_deals", /prozorro_deals: async[^\n]*\n\s*\(await createdSplitByBucket\(\{ from, to, teamId, managerId \}, g\)\)\.map\(\(x\) => P\(x\.bucket, x\.prozorroCount\)\)/],
    ["linkedin_deals", /linkedin_deals: async[^\n]*\n\s*\(await createdSplitByBucket\(\{ from, to, teamId, managerId \}, g\)\)\.map\(\(x\) => P\(x\.bucket, x\.linkedinCount\)\)/],
    ["ad (Реклама «Надійшло»)", /const days = await money\.adReceivedByDay\(\{ from, to \}, \(await getSettings\(\)\)\.adSources\);/],
    ["lg (тренд «Лідогенерації»)", /const t = await leadgenTrend\(to, months, \{ teamId: null, managerId: null \}\);/],
    ["fin (Фінанси → Тиждень і місяць)", /refs: \(await fmRefsFor\(g, st\)\)/],
    ["hr (плинність реєстру)", /await churnReport\(pool as unknown as Db, from\.slice\(0, 7\), to\.slice\(0, 7\)\)/],
    ["hr_turnover_total", /hr_turnover_total: hrC\(\(m\) => m\.turnover\),/],
  ];
  for (const [name, re] of src) assert.match(route, re, `🔴 ${name}: обчислювач іде не через функцію свого екрана`);
  assert.doesNotMatch(route, /m\.turnover \* 100|turnover \* 100/, "🔴 плинність знову множиться на 100 — уже у відсотках");
});

// ─────────────────────────────── ЖИВІ (test:prod) ───────────────────────────────

async function adminToken(): Promise<string> {
  const { signToken } = await import("../auth/auth.js");
  return signToken({ userId: 0, role: "admin", roleKey: "admin", managerId: null, teamId: null });
}
type SeriesResp = { series: { scopeKey: string; points: { period: string; value: number }[] }[] };
async function seriesOf(block: string, metric: string, extra = ""): Promise<SeriesResp> {
  const r = await fetch(`${API_BASE}/api/statistics/series?block=${block}&metric=${metric}&granularity=month&from=2026-10-01&to=2026-10-31${extra}`,
    { headers: { Authorization: `Bearer ${await adminToken()}` } });
  assert.equal(r.status, 200, `🔴 ${metric}: сервер відповів ${r.status}`);
  return await r.json() as SeriesResp;
}
const octOf = (b: SeriesResp) => b.series.find((s) => s.scopeKey === "company")?.points.find((p) => p.period === "2026-10-01")?.value;

/**
 * #10415 — ЖИВИЙ: картка == ядро, і «нові + постійні == всього». Жовтень 2026 — закритий місяць, тож числа не повзуть
 * під час прогону. Картка (`scope=main`) адміна — рівно одна серія компанії.
 */
test("#10415 ЖИВИЙ: «Отримані кошти» жовтня на картці == ядру; машини нових + постійних == всіх відправлених", needsApi(), async () => {
  const money = await import("../core/money.js");
  const main = await seriesOf("sales", "payment_received", "&scope=main");
  assert.deepEqual(main.series.map((s) => s.scopeKey), ["company"], "🔴 картка адміна — не одна серія компанії");
  const core = await money.receivedMoney({ from: "2026-10-01", to: "2026-10-31" });
  assert.ok(core.revenue > 0, "🔴 ядро дало 0 за жовтень — перевіряти нема чого");
  assert.equal(Math.round(octOf(main) ?? NaN), Math.round(core.revenue), "🔴 картка рахує гроші не ядром");
  const [all, nw, rep] = await Promise.all(["cars_delivered_all", "new_clients_cars", "repeat_clients_cars"].map((m) => seriesOf("logistics", m)));
  const a = octOf(all) ?? NaN, n = octOf(nw) ?? NaN, r = octOf(rep) ?? NaN;
  assert.ok(a > 0, "🔴 відправлених за жовтень 0 — перевіряти нема чого");
  assert.equal(n + r, a, `🔴 нові ${n} + постійні ${r} ≠ усі ${a}`);
});
