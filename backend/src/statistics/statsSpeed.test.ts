import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SeriesCache, SERIES_FRESH_MS, SERIES_STALE_MS } from "./seriesCache.js";
import { WALL_METRICS, cardFrom, warmTasks, seriesDefaultTo, SERIES_DEFAULT_FROM } from "./seriesWarmSet.js";
import { firstSpec, mainSpec } from "./statsBuckets.js";
import { statsByBucket, seriesOfTakeRows, kyivParts, kyivBucket, type DealTake } from "../core/leadTakeRules.js";

/**
 * ⚡ #10419–#10423 — ШВИДКІСТЬ «СТАТИСТИК» (ціль Романа 21.11.2026: «час завантаження будь-якого графіка — менше 3 секунд»).
 *
 * Заміри прода 21.11 (a9b14be, холодно): розгорнутий «Час опрацювання» 12 с, Prozorro / LinkedIn 4,7–4,9 с, «Поставлені»
 * 3,9–4,4 с, картки «Продажів» 6,2 с. Причини з EXPLAIN ANALYZE на проді: пошук «клієнт уже був» виконувався 3–5 разів
 * на угоду; графік вантажив сім розрізів, щоб намалювати одну лінію; заявки вантажились окремо на кожен розріз і період.
 * Тут — те, що тримає лікування: памʼять готових рядів (`#10419`), розріз із завантажених заявок (`#10420`), фоновий
 * набір = меню екрана (`#10421`), перша лінія графіка окремим запитом (`#10422`), один пошук на угоду й жива робота
 * всього набору на справжньому Postgres (`#10423` — у `core/leadTake.test.ts`, де scratch-кластер уже піднятий).
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SEC = "frontend/src/pages/dashboard/sections";
const ROUTE = "backend/src/routes/statisticsSeries.ts";
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flush = () => new Promise((r) => setImmediate(r));

async function loadCards() {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(read("frontend/src/pages/dashboard/statsCards.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return await import(`data:text/javascript,${encodeURIComponent(js)}`);
}

/**
 * #10419 — ЧИСЛО З ПАМʼЯТІ НІКОЛИ НЕ ВИДАЄТЬСЯ ЗА СВІЖІШЕ, НІЖ ВОНО Є, І НІКОЛИ — ЗА ЧУЖИЙ РОЗРІЗ. Три стани за віком:
 * свіже — без розрахунку; придатне — одразу, з перерахунком у фоні; старе — запит чекає нового. Невдалий перерахунок
 * добре число не стирає, але й не омолоджує.
 * 🧨 Червоніє, якщо: з ключа випаде аргумент (тімлід отримав би компанію); придатне число змусить чекати або не
 * запустить перерахунок; число, старше за межу, віддасться без розрахунку; помилка зітре число чи зробить його «свіжим»;
 * мить «станом на» стане миттю кінця розрахунку; ряд у роуті поїде повз памʼять або залежатиме від чогось поза ключем.
 */
test("#10419 ПАМʼЯТЬ РЯДІВ: свіже — одразу, придатне — одразу з перерахунком у фоні, старе — чекає; невдача числа не стирає; ключ — усі аргументи", async () => {
  let clock = 1_000_000, calls = 0, fail = false;
  const cache = new SeriesCache<string>(SERIES_FRESH_MS, SERIES_STALE_MS, () => clock);
  const fn = async (metric: string, team: number | null) => { calls++; await Promise.resolve(); if (fail) throw new Error("neon"); return `${metric}|${team}|${calls}`; };

  // Одночасні запити одного ряду — один розрахунок; мить запису — мить ПОЧАТКУ.
  const [a, b] = await Promise.all([cache.call(fn, "cars", null), cache.call(fn, "cars", null)]);
  assert.equal(calls, 1, "🔴 два одночасні запити одного ряду порахували його двічі");
  assert.deepEqual([a.value, a.at, b === a], ["cars|null|1", 1_000_000, true]);
  // Інший розріз і інший показник — свій розрахунок (усі аргументи в ключі).
  assert.equal((await cache.call(fn, "cars", 14)).value, "cars|14|2", "🔴 команда 14 отримала ряд компанії — розріз випав із ключа");
  assert.equal((await cache.call(fn, "deals", null)).value, "deals|null|3", "🔴 інший показник отримав чужий ряд");

  // Свіже: по обидва боки межі. За мить до неї — без розрахунку й без фону.
  clock = 1_000_000 + SERIES_FRESH_MS - 1;
  assert.equal((await cache.call(fn, "cars", null)).value, "cars|null|1"); await flush();
  assert.equal(calls, 3, "🔴 свіжий ряд перераховано — памʼять не працює");
  // Рівно на межі — старе число ОДРАЗУ (той самий запис), а нове рахується у фоні.
  clock = 1_000_000 + SERIES_FRESH_MS;
  const stale = await cache.call(fn, "cars", null);
  assert.deepEqual([stale.value, stale.at], ["cars|null|1", 1_000_000], "🔴 придатний ряд змусив чекати розрахунку або видав себе за свіжий");
  await flush(); await flush();
  assert.equal(calls, 4, "🔴 придатний ряд віддано, а перерахунок у фоні не пішов — число старітиме до межі");
  const fresh = await cache.call(fn, "cars", null);
  assert.deepEqual([fresh.value, fresh.at], ["cars|null|4", 1_000_000 + SERIES_FRESH_MS], "🔴 після фонового перерахунку віддано старе число");

  // Невдалий перерахунок: число лишається (з його справжньою миттю), помилка порахована.
  fail = true;
  const t1 = fresh.at;
  clock = t1 + SERIES_FRESH_MS + 5;
  assert.equal((await cache.call(fn, "cars", null)).value, "cars|null|4"); await flush(); await flush();
  assert.equal(cache.stats().refreshFailed, 1, "🔴 невдалий фоновий перерахунок не порахований — у /api/health його не видно");
  await assert.rejects(cache.recompute(fn, "cars", null), /neon/);
  const kept = await cache.call(fn, "cars", null);
  assert.deepEqual([kept.value, kept.at], ["cars|null|4", t1], "🔴 помилка стерла добре число або омолодила його");
  // Межа «старе»: за мить до неї число ще віддається, на ній — запит чекає розрахунку (і чесно падає, якщо той не вдався).
  clock = t1 + SERIES_STALE_MS - 1;
  assert.equal((await cache.call(fn, "cars", null)).value, "cars|null|4"); await flush(); await flush();
  clock = t1 + SERIES_STALE_MS;
  await assert.rejects(cache.call(fn, "cars", null), /neon/, "🔴 число, старше за межу, віддано без розрахунку");
  fail = false;
  const again = await cache.call(fn, "cars", null);
  assert.equal(again.at, t1 + SERIES_STALE_MS, "🔴 після відновлення число не перераховано");

  // Мить запису — початок розрахунку, а не кінець: довгий розрахунок не робить число свіжішим за його дані.
  const slow = new SeriesCache<number>(SERIES_FRESH_MS, SERIES_STALE_MS, () => clock);
  const r = await slow.call(async (x: number) => { clock += 40_000; return x; }, 7);
  assert.equal(r.at, clock - 40_000, "🔴 «станом на» — мить КІНЦЯ розрахунку: число видає себе за свіжіше, ніж дані, з яких його рахували");

  // Межі — частина обіцянки екрана: свіже довше за крок фону (10 хв), старе — не довше за синк (30 хв).
  assert.ok(SERIES_FRESH_MS > 10 * 60_000 && SERIES_FRESH_MS < SERIES_STALE_MS, "🔴 «свіже» не довше за крок фонового розрахунку — картки між проходами фону рахуватимуться на вимогу");
  assert.ok(SERIES_STALE_MS <= 30 * 60_000, "🔴 число може жити довше за 30 хв — це рішення власника, не технічна правка");

  // Проводка: ряд у роуті — лише через памʼять, і його розрахунок бачить РІВНО те, що в ключі.
  const route = codeOnly(read(ROUTE));
  assert.match(route, /const args = \[block, metric, g, cf, to, sc\.scopeType, sc\.scopeKey, sc\.teamId, sc\.managerId\] as const;\n\s*const hit = force \? await seriesCache\.recompute\(seriesPoints, \.\.\.args\) : await seriesCache\.call\(seriesPoints, \.\.\.args\);/,
    "🔴 ряд рахується повз памʼять або з іншим набором аргументів");
  const sp = route.slice(route.indexOf("async function seriesPoints("), route.indexOf("const seriesCache = new SeriesCache"));
  assert.match(sp, /async function seriesPoints\(block: string, metric: string, g: Gran, cf: string, to: string,\s*scopeType: string, scopeKey: string, teamId: number \| null, managerId: number \| null\)/, "🔴 підпис розрахунку ряду змінився — звір його з ключем");
  assert.doesNotMatch(sp, /\bsc\.|\breq\.|\bauth\b|kyivToday\(/, "🔴 розрахунок ряду читає щось поза своїми аргументами — цього немає в ключі памʼяті");
  assert.equal([...route.matchAll(/COMPUTERS\[metric\]\(/g)].length, 1, "🔴 обчислювач покликано ще десь, окрім розрахунку ряду");
  assert.match(route, /const asOf = got\.length \? new Date\(Math\.min\(\.\.\.got\.map\(\(x\) => x\.at\)\)\)\.toISOString\(\) : null;/, "🔴 «станом на» — не найстаріша мить рядів відповіді");
  assert.match(route, /live: hasLive\(block, metric\), series, asOf,/, "🔴 відповідь не каже, станом на коли пораховано");
  assert.match(codeOnly(read("backend/src/index.ts")), /statsSeriesCache: statsSeriesCacheStatus\(\),/, "🔴 стану памʼяті рядів немає в /api/health — механізм, що зсуває свіжість, невидимий");
});

/**
 * #10420 — КОМАНДА, МЕНЕДЖЕР І КОРОТШИЙ ПЕРІОД — ЦЕ ПІДМНОЖИНА ЗАЯВОК КОМПАНІЇ, А НЕ ОКРЕМА ВИБІРКА. `seriesOfTakeRows`
 * застосовує до рядків ті самі три умови, що `leadSelection` ставить у SQL: `manager_id`, команда на дату заявки,
 * київська дата створення з обома кінцями. Фікстура лежить по обидва боки КОЖНОЇ межі; живу рівність «серія команди ==
 * вікно Звіту» окремо тримає `#2444` (scratch).
 * 🧨 Червоніє, якщо: межа періоду поїде на UTC-дату або втратить кінець; заявка без команди потрапить у команду; розріз
 * перестане фільтруватись (усі розрізи дорівнюватимуть компанії); обчислювач знову вантажитиме заявки окремо на розріз.
 */
test("#10420 РОЗРІЗ ІЗ ЗАЯВОК КОМПАНІЇ: команда, менеджер і підперіод за київською датою — по обидва боки кожної межі; одна вибірка на всі розрізи", () => {
  const kyiv = (y: number, mo: number, d: number, h: number, mi: number, offH: number) => Date.UTC(y, mo - 1, d, h - offH, mi);
  const take = (minutes: number | null): DealTake => ({ takenAt: minutes == null ? null : 1, event: minutes == null ? null : "stage", minutes, bucket: minutes == null ? "none" : "m5", offHours: false });
  const row = (createdAt: number, teamId: number | null, managerId: number | null, minutes: number | null) => ({ createdAt, teamId, managerId, lost: false, take: take(minutes) });
  const rows = [
    row(kyiv(2026, 9, 30, 23, 30, 3), 13, 1, 1),   // вересень за Києвом (літній час, +3)
    row(kyiv(2026, 10, 1, 0, 30, 3), 13, 1, 2),    // жовтень за Києвом, а за UTC ще 30.09
    row(kyiv(2026, 10, 15, 12, 0, 3), 15, 2, 3),
    row(kyiv(2026, 10, 20, 12, 0, 3), null, null, 4), // без команди й менеджера
    row(kyiv(2026, 10, 31, 23, 30, 2), 13, 3, 5),  // останній день жовтня (зимовий час, +2)
    row(kyiv(2026, 11, 1, 0, 30, 2), 13, 1, 6),    // листопад за Києвом, а за UTC ще 31.10
  ];
  const n = (sel: Parameters<typeof seriesOfTakeRows>[1], g: "month" | "week" | "day" = "month") =>
    Object.fromEntries(seriesOfTakeRows(rows, sel, g).map((x) => [x.bucket, x.stats.n]));
  assert.deepEqual(seriesOfTakeRows(rows, {}, "month"), statsByBucket(rows, "month"), "🔴 без розрізу серія ≠ кошикам усіх заявок");
  assert.deepEqual(n({}), { "2026-09-01": 1, "2026-10-01": 4, "2026-11-01": 1 });
  assert.deepEqual(n({ from: "2026-10-01", to: "2026-10-31" }), { "2026-10-01": 4 }, "🔴 підперіод не за київською датою або без одного з кінців (01.10 00:30 і 31.10 23:30 — жовтень; 30.09 23:30 і 01.11 00:30 — ні)");
  assert.deepEqual(n({ from: "2026-10-02", to: "2026-10-30" }), { "2026-10-01": 2 }, "🔴 межа періоду включає сусідній день");
  assert.deepEqual(n({ teamId: 13 }), { "2026-09-01": 1, "2026-10-01": 2, "2026-11-01": 1 }, "🔴 команда 13 — не її заявки (чужа команда або заявка без команди всередині)");
  assert.deepEqual(n({ teamId: 15 }), { "2026-10-01": 1 });
  assert.deepEqual(n({ teamId: 99 }), {}, "🔴 неіснуюча команда отримала заявки");
  assert.deepEqual(n({ managerId: 1 }), { "2026-09-01": 1, "2026-10-01": 1, "2026-11-01": 1 }, "🔴 менеджер 1 — не його заявки");
  assert.deepEqual(n({ managerId: 3, teamId: 13, from: "2026-10-01", to: "2026-10-31" }), { "2026-10-01": 1 });
  assert.deepEqual(n({ managerId: 2, teamId: 13 }), {}, "🔴 менеджер і команда разом — не перетин (у SQL обидві умови через AND)");
  // Медіана розрізу — з його заявок, а не з усіх.
  assert.equal(seriesOfTakeRows(rows, { teamId: 13, from: "2026-10-01", to: "2026-10-31" }, "month")[0].stats.medianMin, 3.5);

  // Дзеркало в SQL: ті самі три умови стоять у `leadSelection` — зміниш там, зміни тут.
  const core = codeOnly(read("backend/src/core/leadTake.ts"));
  assert.match(core, /if \(q\.managerId\) conds\.push\(`d\.manager_id = \$\{add\(q\.managerId\)\}`\);\n\s*if \(q\.teamId\) conds\.push\(`\$\{TEAM\} IS NOT DISTINCT FROM \$\{add\(q\.teamId\)\}`\);/, "🔴 умова розрізу в SQL змінилась — `seriesOfTakeRows` мусить лишатись її дзеркалом");
  assert.match(core, /`\(d\.created_at_kommo \$\{K\}\)::date BETWEEN \$2::date AND \$3::date`/, "🔴 умова періоду в SQL змінилась — `seriesOfTakeRows` мусить лишатись її дзеркалом");
  assert.match(core, /export async function leadTakeSeries\(q: TakeQuery, g: TakeGran\)[^\n]*\n\s*return seriesOfTakeRows\(await leadTakeSeriesRows\(q\), \{\}, g\);/, "🔴 серія ядра й серія «Статистик» розкладають заявки різними функціями");
  // Проводка: обчислювач вантажить заявки БЕЗ розрізу, раз, і ріже вже їх.
  const route = codeOnly(read(ROUTE));
  assert.match(route, /const base = from < STATS_CRM_FROM \? from : STATS_CRM_FROM;\n\s*const rows = await leadTakeSeriesRows\(\{ from: base, to, \.\.\.SERIES_TAKE_FILTER \}\);\n\s*return seriesOfTakeRows\(rows, \{ from, to, teamId, managerId \}, g\)/,
    "🔴 «Час опрацювання» знову вантажить заявки окремо на розріз чи період, або ріже їх не тими умовами");
  assert.match(route, /const leadTakeSeriesRows = memoize\("leadTakeSeriesRows", leadTakeSeriesRowsRaw\);/, "🔴 заявки вантажаться повз спільний виклик — дві картки часу знову рахують те саме паралельно");
});

/**
 * #10421 — ФОН РАХУЄ РІВНО ТЕ, ЩО ПИТАЄ ЕКРАН. Набір фонового розрахунку — дзеркало меню (`CATS`) і періоду картки
 * (`cardFrom` фронту); розійдуться — памʼять буде «повна», а стіна відкриватиметься холодною.
 * 🧨 Червоніє, якщо: показник додали в меню й забули у фоні (чи навпаки); період картки на фронті й на сервері різний
 * хоч на один день; показник «лише помісячно» гріється ще й тижнем (ряду немає) або тижневий — лише місяцем; верхня межа
 * знову стане константою року; фон піде паралельно або через нагляд джоб.
 */
test("#10421 ФОНОВИЙ НАБІР = МЕНЮ ЕКРАНА: ті самі показники й період картки, місяць і тиждень, графік — уся глибина; по одному ряду", async () => {
  const fe = read(`${SEC}/StatisticsChartsSection.tsx`);
  const cats = fe.slice(fe.indexOf("const CATS"), fe.indexOf('{ key: "manual"'));
  const menu = [...cats.matchAll(/\{ key: "(\w+)", block: "(\w+)"[^\n]*/g)].map((m) => `${m[2]}|${m[1]}|${/monthOnly: true/.test(m[0]) ? "month" : "month+week"}`).sort();
  assert.ok(menu.length >= 30, `🔴 знайдено лише ${menu.length} показників меню — зріз зламався`);
  const warm = WALL_METRICS.map((m) => `${m.block}|${m.metric}|${m.monthOnly ? "month" : "month+week"}`).sort();
  assert.deepEqual(warm, menu, "🔴 фоновий набір ≠ меню екрана: фон гріє не те, що питає стіна");
  assert.doesNotMatch(cats, /weekOnly: true/, "🔴 у меню зʼявився показник «лише по тижнях» — фоновий набір такого не вміє");

  // Період картки — виконанням обох функцій на кожному дні 15 місяців (кінці місяців, високосність, межа року).
  const cards = await loadCards();
  const diff: string[] = [];
  for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 2, 31); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    for (const g of ["month", "week"] as const) if (cards.cardFrom(day, g) !== cardFrom(day, g)) diff.push(`${day}/${g}`);
  }
  assert.deepEqual(diff, [], "🔴 період картки на екрані й у фоні різний");
  assert.deepEqual([cardFrom("2026-11-21", "month"), cardFrom("2026-11-21", "week"), cardFrom("2026-03-31", "month")], ["2025-10-01", "2026-08-22", "2025-02-01"]);
  assert.match(codeOnly(fe), /const g = effGranOf\(m, gran\), from = cardFrom\(today, g === "week" \? "week" : "month"\);/, "🔴 картка питає не той період, що рахує фон");
  assert.match(codeOnly(fe), /fetchStatsSeries\(\{ block: r\.m\.block, metric: r\.m\.key, granularity: r\.g, from: r\.from, scope: "main" \}\)/, "🔴 картка шле ще щось, окрім `from` і `scope=main` — ключ фону не збігатиметься");

  const tasks = warmTasks("2026-11-21");
  const of = (metric: string) => tasks.filter((t) => t.metric === metric).map((t) => `${t.g}|${t.from}|${t.to}`).sort();
  assert.deepEqual(of("payment_received"), ["month|2024-07-01|2026-12-31", "month|2025-10-01|2026-12-31", "week|2024-07-01|2026-12-31", "week|2026-08-22|2026-12-31"],
    "🔴 показник гріється не чотирма рядами (картка й графік × місяць і тиждень)");
  assert.deepEqual(of("hr_headcount"), ["month|2024-07-01|2026-12-31", "month|2025-10-01|2026-12-31"], "🔴 показник «лише помісячно» гріється тижнем, якого не існує");
  assert.equal(tasks.length, WALL_METRICS.reduce((s, m) => s + (m.monthOnly ? 2 : 4), 0));
  assert.equal(new Set(tasks.map((t) => JSON.stringify(t))).size, tasks.length, "🔴 у наборі повтори — один ряд рахується двічі");
  // Верхня межа — кінець ПОТОЧНОГО року: по обидва боки Нового року.
  assert.deepEqual([seriesDefaultTo("2026-12-31"), seriesDefaultTo("2027-01-01")], ["2026-12-31", "2027-12-31"], "🔴 з 1 січня графіки обірвуться на грудні");
  const route = codeOnly(read(ROUTE));
  assert.match(route, /const from = String\(req\.query\.from \?\? SERIES_DEFAULT_FROM\);\n\s*const to = String\(req\.query\.to \?\? seriesDefaultTo\(today\)\);/, "🔴 роут і фон беруть період за замовчуванням із різних місць");
  assert.equal(SERIES_DEFAULT_FROM, "2024-07-01");
  // Фон: по одному ряду, примусовий перерахунок, компанія; не кидає; у кроні, не під наглядом джоб.
  const w = route.slice(route.indexOf("export async function warmStatsSeries"), route.indexOf("export const statsSeriesCacheStatus"));
  assert.match(w, /for \(const t of tasks\) \{\n\s*try \{ await stitch\(t\.block, t\.metric, t\.g, t\.from, t\.to, COMPANY, true\); \}\n\s*catch \(e\) \{ failed\+\+;/, "🔴 фон рахує не по одному ряду, не примусово або падає на першій помилці");
  assert.doesNotMatch(w, /Promise\.all/, "🔴 фон пішов паралельно — забере базу в людей");
  assert.match(w, /if \(warmStatus\.running\) return/, "🔴 другий прохід фону може піти поверх першого");
  const idx = codeOnly(read("backend/src/index.ts"));
  assert.match(idx, /cron\.schedule\("8-59\/10 7-21 \* \* \*", \(\) => \{ void warmStatsSeries\(\); \}, \{ timezone: "Europe\/Kyiv" \}\);/, "🔴 фон не раз на 10 хв у робочий час за Києвом");
  assert.doesNotMatch(idx, /runJob\("warmStatsSeries"/, "🔴 фон пішов через `runJob`: його помилка стане банером користувачам, хоча цифр вона не псує");
});

/**
 * #10422 — ГРАФІК ВИДНО, ЩОЙНО Є ПЕРША ЛІНІЯ. `scope=first` віддає рівно ту серію, яку графік малює за замовчуванням
 * (компанія; немає компанії в наборі — перша), а повна відповідь її ПІДМІНЯЄ, ніколи навпаки. Картки, вже отримані у
 * вкладці, видно одразу при поверненні до відділу — доки їм не більше 10 хв.
 * 🧨 Червоніє, якщо: перша лінія — не та, що малюється (тімлід бачив би стрибок зі своєї команди на компанію); рання
 * відповідь затре повну; `scope=first` розширить набір глядача; памʼять вкладки покаже число, старше за межу.
 */
test("#10422 ПЕРША ЛІНІЯ ГРАФІКА: та, що малюється за замовчуванням; повна відповідь підміняє ранню, не навпаки; картки вкладки — до 10 хв", async () => {
  const company = { scopeType: "company", scopeKey: "company" };
  const admin = [company, { scopeType: "team_lead", scopeKey: "13" }, { scopeType: "team_lead", scopeKey: "15" }];
  const lead: { scopeType: string; scopeKey: string; benchmark?: boolean }[] = [{ ...company, benchmark: true }, { scopeType: "team_lead", scopeKey: "13" }, { scopeType: "manager", scopeKey: "1" }];
  const mgr = [{ scopeType: "manager", scopeKey: "7" }];
  assert.deepEqual(firstSpec(admin).map((s) => s.scopeKey), ["company"]);
  assert.deepEqual(firstSpec(lead).map((s) => s.scopeKey), ["company"], "🔴 тімліду першою прийде не та лінія, яку графік малює за замовчуванням (компанія-бенчмарк)");
  assert.deepEqual(mainSpec(lead).map((s) => s.scopeKey), ["13"], "фікстура: головна серія картки тімліда — його команда, тобто `first` ≠ `main`");
  assert.deepEqual(firstSpec(mgr).map((s) => s.scopeKey), ["7"]);
  assert.deepEqual(firstSpec([]), []);
  assert.ok(firstSpec(admin).every((s) => admin.includes(s)), "🔴 `first` створив серію, якої не було в наборі глядача");
  const fe = codeOnly(read(`${SEC}/StatisticsChartsSection.tsx`));
  // Те саме правило на екрані: що видно за замовчуванням.
  assert.match(fe, /const first = resp\.series\.find\(\(s\) => s\.scopeType === "company"\) \?\? resp\.series\[0\];/, "🔴 правило «що малюється за замовчуванням» на екрані змінилось — `firstSpec` мусить лишатись його дзеркалом");
  assert.match(fe, /let full = false;\n\s*fetchStatsSeries\(\{ \.\.\.q, scope: "first" \}\)\n\s*\.then\(\(d\) => \{ if \(alive && !full\) \{ setResp\(d\);/, "🔴 рання відповідь може затерти повну (або першої лінії більше не питають)");
  assert.match(fe, /fetchStatsSeries\(q\)\n\s*\.then\(\(d\) => \{ full = true; if \(alive\) \{ setResp\(d\);/, "🔴 повна відповідь не позначає себе — рання, що запізнилась, її затре");
  assert.match(fe, /\.catch\(\(e\) => \{ full = true; if \(alive\) \{ setChartLoading\(false\); setScopesLoading\(false\); setLoadErr\(/, "🔴 помилку повного запиту не видно або після неї рання відповідь малює графік без пояснення");
  const route = codeOnly(read(ROUTE));
  assert.match(route, /const full = await seriesSet\([^\n]*\n\s*const lite = req\.query\.scope === "main" \|\| req\.query\.scope === "first";\n\s*const set = req\.query\.scope === "main" \? mainSpec\(full\) : req\.query\.scope === "first" \? firstSpec\(full\) : full;/,
    "🔴 `scope=first` бере серію не з набору, вже обрізаного роллю");

  const cards = await loadCards();
  let clock = 0;
  const memo = cards.makeCardMemo(600_000, () => clock);
  memo.set("a", 1);
  clock = 599_999; assert.equal(memo.get("a"), 1, "🔴 картка вкладки зникла раніше межі");
  assert.equal(memo.get("b"), undefined, "🔴 картка отримала чужу відповідь — ключ не працює");
  clock = 600_000; assert.equal(memo.get("a"), undefined, "🔴 картка старша за межу показана як готова");
  assert.match(fe, /const cardMemo = makeCardMemo<StatsSeriesResp>\(10 \* 60_000\);/);
  assert.match(fe, /key: `\$\{m\.block\}\|\$\{m\.key\}\|\$\{g\}\|\$\{from\}`/, "🔴 ключ памʼяті картки не містить показника, кроку чи періоду");
  // «Станом на»: година за Києвом; не сьогодні — з датою; немає миті — підпис мовчить.
  assert.equal(cards.asOfLabel("2026-11-21T10:40:00.000Z", "2026-11-21"), "12:40");
  assert.equal(cards.asOfLabel("2026-11-20T21:55:00.000Z", "2026-11-21"), "20.11 23:55", "🔴 учорашня мить показана без дати");
  assert.equal(cards.asOfLabel("2026-11-20T22:05:00.000Z", "2026-11-21"), "00:05", "🔴 день миті рахується не за Києвом");
  assert.deepEqual([cards.asOfLabel(null, "2026-11-21"), cards.asOfLabel(undefined, "2026-11-21"), cards.asOfLabel("сміття", "2026-11-21")], [null, null, null]);
});

/**
 * #10424 — КИЇВСЬКА ДАТА ЗАЯВКИ НЕ СТВОРЮЄ ФОРМАТЕР НА КОЖЕН ВИКЛИК. Замір прода 23.11.2026 (після викату `#10419`–`#10423`):
 * холодний «Час опрацювання» 2,3 с, хоча база відповідала за 0,3 с. Решта — процесор Node: `kyivParts` будував
 * `Intl.DateTimeFormat` на кожну з 30 тис. заявок, двічі на серію (2 с на 30 тис. викликів), і фоновий розрахунок раз на
 * 10 хв зупиняв відповіді всім користувачам шматками по 2 с. Гейт рахує СТВОРЕННЯ форматера, а не час: час залежить від
 * машини (правило 14), кількість створень — ні.
 * 🪞 Дзеркало: числа ті самі. Складові звіряються з незалежним джерелом (`toLocaleString("sv-SE")`) по обидва боки
 * обох переходів часу 2026 року, опівночі й межі року.
 * 🧨 Червоніє, якщо форматер знову створюватиметься всередині `kyivParts`; якщо спільний форматер дасть іншу дату чи годину.
 */
test("#10424 КИЇВСЬКА ДАТА ЗАЯВКИ: форматер один на модуль, а не на кожну заявку; складові ті самі по обидва боки переходів часу", () => {
  const Orig = Intl.DateTimeFormat;
  let built = 0;
  const Counting = function (this: unknown, ...a: ConstructorParameters<typeof Intl.DateTimeFormat>) { built++; return new Orig(...a); } as unknown as typeof Intl.DateTimeFormat;
  Counting.supportedLocalesOf = Orig.supportedLocalesOf;
  const t0 = Date.UTC(2026, 9, 1);
  try {
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Counting;
    new Intl.DateTimeFormat("en-GB"); // дзеркало лічильника: він бачить створення
    assert.equal(built, 1, "лічильник не бачить створення форматера — перевірка нічого не доводить");
    built = 0;
    for (let i = 0; i < 2000; i++) { kyivParts(t0 + i * 3_600_000); kyivBucket(t0 + i * 3_600_000, i % 2 ? "day" : "week"); }
    seriesOfTakeRows([{ createdAt: t0, teamId: 13, managerId: 1, lost: false, take: { takenAt: 1, event: "stage", minutes: 2, bucket: "m5", offHours: false } }], { from: "2026-10-01", to: "2026-10-31" }, "month");
  } finally { (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Orig; }
  assert.equal(built, 0, `🔴 на 4000 викликів створено ${built} форматерів — київська дата знову будує форматер на кожну заявку (2 с процесора на 30 тис. заявок)`);

  // Числа ті самі: незалежне джерело складових, по обидва боки кожної межі.
  const ref = (ms: number) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Kyiv" }))!;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    return { y, mo, d, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(), h, mi };
  };
  const edges = [
    Date.UTC(2026, 2, 29, 0, 59), Date.UTC(2026, 2, 29, 1, 0),    // перехід на літній час: 02:59 → 04:00 за Києвом
    Date.UTC(2026, 9, 25, 0, 59), Date.UTC(2026, 9, 25, 1, 0),    // перехід на зимовий: 03:59 → 03:00 за Києвом
    Date.UTC(2026, 9, 31, 21, 59), Date.UTC(2026, 9, 31, 22, 0),  // північ за Києвом узимку (місяць міняється)
    Date.UTC(2026, 5, 30, 20, 59), Date.UTC(2026, 5, 30, 21, 0),  // північ за Києвом улітку
    Date.UTC(2026, 11, 31, 21, 59), Date.UTC(2026, 11, 31, 22, 0), // межа року
    Date.UTC(2026, 10, 22, 21, 59), Date.UTC(2026, 10, 22, 22, 0), // неділя → понеділок (новий тиждень)
  ];
  for (const ms of edges) assert.deepEqual(kyivParts(ms), ref(ms), `🔴 київські складові ${new Date(ms).toISOString()} не ті`);
  assert.deepEqual(edges.slice(0, 4).map((ms) => kyivParts(ms).h), [2, 4, 3, 3], "фікстура: межі справді лежать по обидва боки переходів часу");
  assert.deepEqual([kyivBucket(edges[4], "month"), kyivBucket(edges[5], "month")], ["2026-10-01", "2026-11-01"]);
  assert.deepEqual([kyivBucket(edges[10], "week"), kyivBucket(edges[11], "week")], ["2026-11-16", "2026-11-23"], "🔴 тиждень починається не з київського понеділка");
});
