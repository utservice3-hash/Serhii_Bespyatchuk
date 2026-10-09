import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skipReason } from "../db/scratchDb.js";
import { needsDb } from "../testMode.js";
import { rangeWindows, compareWindows, compareLabel, sameDayPrevMonth, planFactLine, spreadWeekCellsToDays, foldWeek, type WeekPlanCell } from "./statsCompare.js";
import { avgCheckBase, avgCheckTargetOf, AVG_CHECK_MIN_DEALS } from "../core/avgCheckTargetRules.js";
import { effectiveNorm, callsNormVerdict, canSetCallsNorm } from "../core/callsNormRules.js";

/**
 * 📋 ЗАДАЧА 4632 — «ПЛАН-ФАКТ» У СТАТИСТИКАХ (ТЗ Юлі 28.09, відповіді 10.10.2026; рішення Романа 10.10.2026):
 * «з – по» з порівнянням тих самих дат минулого місяця, підписи з датами, вкладка «План-факт», ціль сер. чека по
 * командах (3 міс + 5%, ≥30 угод, фіксується на місяць), норма дзвінків у «Планах» (КВП, до наступної зміни).
 */
const srcOf = (rel: string) => fileURLToPath(new URL(rel, import.meta.url).href.replace("/dist/", "/src/"));
const SRC = (p: string) => readFileSync(srcOf(`../${p}`), "utf8");

test("#1540 «З – ПО»: ті самі дати минулого місяця, кінець місяця обрізається; незавершений — до сьогодні", () => {
  assert.deepEqual(rangeWindows("2026-09-23", "2026-09-25", "2026-10-10").prev, { from: "2026-08-23", to: "2026-08-25" });
  const clamp = rangeWindows("2026-10-29", "2026-10-31", "2026-11-05");
  assert.deepEqual(clamp.prev, { from: "2026-09-29", to: "2026-09-30" }, "🔴 31.10 порівнюється з 01.10 замість 30.09");
  assert.equal(sameDayPrevMonth("2026-03-31"), "2026-02-28");
  assert.equal(sameDayPrevMonth("2026-01-15"), "2025-12-15", "🔴 січень не перейшов у грудень минулого року");
  const live = rangeWindows("2026-10-01", "2026-10-31", "2026-10-10");
  assert.deepEqual(live.cur, { from: "2026-10-01", to: "2026-10-10" }, "🔴 незавершений період рахується до кінця, а не до сьогодні");
  assert.deepEqual(live.prev, { from: "2026-09-01", to: "2026-09-10" }, "🔴 порівняння незавершеного — не тієї самої довжини");
  assert.equal(live.complete, false);
  assert.equal(rangeWindows("2026-09-01", "2026-09-30", "2026-10-10").complete, true);
});

test("#1540b ПІДПИС ПОРІВНЯННЯ ЗАВЖДИ З ДАТАМИ — і для завершеного періоду теж", () => {
  const span = /\d\d\.\d\d–\d\d\.\d\d/;
  const cases = [
    compareWindows("week", "2026-10-04"), compareWindows("week", "2026-10-08"),
    compareWindows("month", "2026-09-30"), compareWindows("month", "2026-10-08"),
    rangeWindows("2026-09-23", "2026-09-25", "2026-10-10"),
  ];
  for (const w of cases) assert.match(compareLabel(w), span, `🔴 підпис без дат: «${compareLabel(w)}»`);
  assert.equal(compareLabel(compareWindows("week", "2026-10-04")), "минулого тижня (21.09–27.09)", "🔴 повний тиждень підписано без дат");
  assert.equal(compareLabel(compareWindows("week", "2026-10-07")), "28.09–30.09 (той самий відрізок минулого тижня)");
  assert.equal(compareLabel(compareWindows("month", "2026-09-30")), "серпня (01.08–31.08)", "🔴 повний вересень не проти повного серпня");
  assert.match(compareLabel(rangeWindows("2026-09-23", "2026-09-25", "2026-10-10")), /ті самі дати минулого місяця/);
});

test("#1540c РЯДОК ПЛАН-ФАКТ: без плану — «—», а не 0%; залишок не відʼємний; минулий період — без «треба на день»", () => {
  const base = { expect: 0, avgRevenue: 0, successDeals: 0, calls: 0, managerDays: 0, workDaysLeft: 10, complete: false };
  const noPlan = planFactLine({ ...base, plan: null, fact: 5000 });
  assert.deepEqual([noPlan.plan, noPlan.pct, noPlan.remaining, noPlan.needPerDay], [null, null, null, null], "🔴 без плану показано число");
  const over = planFactLine({ ...base, plan: 100_000, fact: 120_000 });
  assert.equal(over.remaining, 0, "🔴 перевиконання дало відʼємний залишок");
  assert.equal(over.pct, 120);
  const mid = planFactLine({ ...base, plan: 100_000, fact: 40_000 });
  assert.equal(mid.needPerDay, 6000, "🔴 треба на день ≠ залишок ÷ робочі дні");
  assert.equal(planFactLine({ ...base, plan: 100_000, fact: 40_000, complete: true }).needPerDay, null, "🔴 минулому періоду пишуть «треба на день»");
  const avg = planFactLine({ ...base, plan: null, fact: 0, avgRevenue: 30_000, successDeals: 10, calls: 900, managerDays: 20 });
  assert.deepEqual([avg.avgCheck, avg.callsPerDay], [3000, 45]);
  assert.equal(planFactLine({ ...base, plan: null, fact: 0 }).avgCheck, null, "🔴 чек без угод — 0 замість «—»");
});

test("#1540d ОДИН ПЛАН НА ЕКРАНІ: «з – по» = розклад Звіту, тиждень «План-факт» = план плитки, день = частка того самого тижня", () => {
  const dash = SRC("routes/dashboard.ts");
  const rp = dash.slice(dash.indexOf('dashboardRouter.get("/report-plan"'));
  assert.match(rp.slice(0, 20_000), /moneyPlanByMgr = await plans\.proratedMonthPlanByManager\(from, to, teamId\)/, "🔴 Звіт розкладає план своїм кодом");
  const ss = SRC("statistics/statsSummary.ts");
  const pbm = ss.slice(ss.indexOf("export async function planByManager"), ss.indexOf("/** Відправлені авто"));
  assert.match(pbm, /if \(gran === "range"\)[\s\S]{0,800}plans\.proratedMonthPlanByManager\(full\.from, full\.to, null\)/, "🔴 «з – по» на Статистиках — другий розклад плану");
  const pf = ss.slice(ss.indexOf("export async function buildPlanFact"));
  assert.match(pf, /planByManager\(gran, win\.full\)/, "🔴 «План-факт» бере план не тією функцією, що плитка");
  assert.match(pf, /money\.receivedByMgrAtTeam\(/, "🔴 факт «План-факт» не з ядра грошей (②)");
  assert.match(ss, /if \(g === "day"\) return dayPlanSeries\(from, to\);/, "🔴 на кроці «день» плану знову немає");
  assert.match(ss, /week: "план тижня динамічний[^"]*узгоджено в задачі 5146/, "🔴 зник підпис, що динамічний тиждень узгоджено в 5146");
});

test("#1540e ЖИВА БАЗА: «План-факт» за вересень — Σ команд = компанія = ядро грошей; план компанії = план плитки", needsDb(), async () => {
  const { buildPlanFact, buildSummary } = await import("./statsSummary.js");
  const money = await import("../core/money.js");
  const viewer = { allTeams: true, teamId: null, managerId: null };
  const pf = await buildPlanFact("month", "2026-09-30", viewer);
  const core = await money.receivedMoney({ from: "2026-09-01", to: "2026-09-30" });
  assert.ok(pf.company, "компанія мусить бути для адмін-рівня");
  const sumTeams = pf.teams.reduce((a, t) => a + t.fact, 0);
  assert.ok(Math.abs(pf.company!.fact - Math.round(core.revenue)) <= 1, `🔴 компанія ${pf.company!.fact} ≠ ядро ${Math.round(core.revenue)}`);
  assert.ok(Math.abs(sumTeams - pf.company!.fact) <= pf.teams.length, `🔴 Σ команд ${sumTeams} ≠ компанія ${pf.company!.fact} — гроші загубились між командами`);
  for (const t of pf.teams) {
    const sumM = t.managers.reduce((a, m) => a + m.fact, 0);
    assert.ok(Math.abs(sumM - t.fact) <= t.managers.length, `🔴 ${t.name}: Σ менеджерів ${sumM} ≠ команда ${t.fact}`);
  }
  const tile = (await buildSummary("month", "2026-09-30", viewer)).tiles.find((x) => x.key === "revenue")!;
  assert.equal(pf.company!.plan, tile.plan, "🔴 план компанії у «План-факт» ≠ план плитки за той самий місяць");
});

test("#1541 ЦІЛЬ СЕР. ЧЕКА: база — 3 повні місяці перед місяцем; +5%; менше 30 угод — цілі немає", () => {
  assert.deepEqual(avgCheckBase("2026-10-01"), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(avgCheckBase("2027-01-01"), { from: "2026-10-01", to: "2026-12-31" }, "🔴 січень не бере жовтень–грудень");
  assert.deepEqual(avgCheckBase("2026-03-01"), { from: "2025-12-01", to: "2026-02-28" });
  assert.equal(AVG_CHECK_MIN_DEALS, 30);
  assert.equal(avgCheckTargetOf(29 * 3000, 29), null, "🔴 ціль поставлено на 29 угодах");
  assert.equal(avgCheckTargetOf(30 * 3000, 30), 3150, "🔴 на 30 угодах ціль не = чек + 5%");
  assert.equal(avgCheckTargetOf(2_225_448, 1093), 2138, "Яцик, жовтень 2026 (заміряно 10.10)");
});

test("#1541b ЦІЛЬ ФІКСУЄТЬСЯ НА МІСЯЦЬ: записана ціль не перераховується; відсутня команда дораховується й записується", async (t) => {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    // Записана ціль команди 5 — НЕ та, що вийшла б із даних (у порожній базі угод нуль, тобто цілі не було б).
    await c.query(`INSERT INTO avg_check_targets (month, team_id, base_from, base_to, revenue, deals, target)
                   VALUES ('2026-10-01', 5, '2026-07-01', '2026-09-30', 2225448, 1093, 2138)`);
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test";
    process.env.KOMMO_BASE_URL ??= "https://x.invalid";
    process.env.KOMMO_API_TOKEN ??= "x";
    const { teamAvgCheckTargets } = await import("../core/avgCheckTarget.js");
    const got = await teamAvgCheckTargets("2026-10-01", [5, 6]);
    assert.equal(got.get(5)?.target, 2138, "🔴 зафіксовану ціль перераховано посеред місяця");
    assert.equal(got.get(6)?.target, null, "команда без угод за базу — без цілі");
    const stored = (await c.query(`SELECT team_id, deals, target FROM avg_check_targets WHERE month = '2026-10-01' ORDER BY team_id`)).rows;
    assert.deepEqual(stored.map((r) => [r.team_id, Number(r.deals), r.target]), [[5, 1093, "2138"], [6, 0, null]],
      "🔴 відсутню команду не записано — наступне звернення порахувало б її знову");
    // Повторне звернення не дублює і не переписує.
    await teamAvgCheckTargets("2026-10-01", [5, 6]);
    assert.equal(Number((await c.query(`SELECT count(*) FROM avg_check_targets`)).rows[0].count), 2);
    const { pool } = await import("../db/pool.js");
    await pool.end();
  } finally {
    await c.end().catch(() => {});
  }
});

test("#1541c КОЛІР ЧЕКА — ЛИШЕ ЗА ЦІЛЛЮ: «у нормі / нижче», без цілі — словами; компанії ціль не ставиться", () => {
  const ss = SRC("statistics/statsSummary.ts");
  assert.match(ss, /key: "avgCheck"[\s\S]{0,400}binary: true/, "🔴 плитка чека фарбується трьома кольорами плану, а не «у нормі / нижче»");
  assert.match(ss, /planNote: viewer\.allTeams \? "ціль ставиться по командах/, "🔴 компанії показано ціль, якої Юля не ставила");
  assert.match(ss, /ціль не ставиться: у команди \$\{tgt\.deals\} успішних угод/, "🔴 «без цілі» не пояснює чому");
  const fe = readFileSync(srcOf("../../../frontend/src/pages/dashboard/sections/StatisticsSummary.tsx"), "utf8");
  assert.match(fe, /if \(binary\) return pct >= 100 \?/, "🔴 двоколірна шкала зникла з фронту");
  assert.match(fe, /if \(target == null\) return <span title=\{`ціль не ставиться/, "🔴 клітинка без цілі мовчить");
});

test("#1542 НОРМА ДЗВІНКІВ: діє з місяця й до наступної зміни; минулі місяці — зі своєю; ставить лише КВП (і адмін)", () => {
  const rows = [
    { fromMonth: "2026-10-01", norm: 45, setAt: "2026-10-10T09:00:00Z" },
    { fromMonth: "2026-12-01", norm: 50, setAt: "2026-10-11T09:00:00Z" },
    { fromMonth: "2026-10-01", norm: 40, setAt: "2026-10-10T08:00:00Z" },
  ];
  assert.equal(effectiveNorm(rows, "2026-09-01"), null, "🔴 норма з жовтня застосувалась до вересня — заднім числом");
  assert.equal(effectiveNorm(rows, "2026-10-01"), 45, "🔴 у межах місяця перемогла не пізніша зміна");
  assert.equal(effectiveNorm(rows, "2026-11-01"), 45, "🔴 норма не діє «до наступної зміни»");
  assert.equal(effectiveNorm(rows, "2027-01-01"), 50);
  assert.equal(callsNormVerdict({ norm: 45, fromMonth: "2026-09" }, "2026-10-01").ok, false, "🔴 норму поставлено заднім числом");
  assert.deepEqual(callsNormVerdict({ norm: 45, fromMonth: "2026-10" }, "2026-10-01"), { ok: true, norm: 45, fromMonth: "2026-10-01" });
  assert.equal(callsNormVerdict({ norm: 0, fromMonth: "2026-10" }, "2026-10-01").ok, false);
  assert.equal(callsNormVerdict({ norm: 45.5, fromMonth: "2026-10" }, "2026-10-01").ok, false);
  assert.equal(canSetCallsNorm({ roleKey: "kvp" }), true, "дзеркало: КВП ставить");
  assert.equal(canSetCallsNorm({ roleKey: "admin" }), true);
  for (const k of ["team_lead", "manager", "ceo", "opdir", "financier", "hr"]) assert.equal(canSetCallsNorm({ roleKey: k }), false, `🔴 ${k} ставить норму`);
});

test("#1542b ОДНЕ ДЖЕРЕЛО НОРМИ: Звіт, Статистики й «Налаштування» читають «Плани»; «Налаштування» більше не пишуть норму", () => {
  const dash = SRC("routes/dashboard.ts");
  assert.match(dash, /const callsNormNow = await callsNormFor\(to\);/);
  assert.match(dash, /callNorm: callNorm\.callNormCell\(callDaysM\.get\(m\.id\) \?\? \[\], callsNormNow,/, "🔴 колонка Звіту «Днів з нормою» читає не «Плани»");
  assert.doesNotMatch(dash, /appSettings\.callsDailyNorm/, "🔴 Звіт знову читає норму з «Налаштувань»");
  const ss = SRC("statistics/statsSummary.ts");
  assert.match(ss, /const normNow = await callsNormFor\(win\.cur\.to\);/, "🔴 плитка дзвінків читає норму не з «Планів»");
  const st = SRC("routes/settings.ts");
  assert.match(st, /callsDailyNorm: current\.callsDailyNorm,/, "🔴 «Налаштування» знову приймають норму з тіла — друге джерело");
  assert.match(st, /s\.callsDailyNorm = await callsNormFor\(kyivToday\(\)\);/, "🔴 «Налаштування» показують не чинну норму");
});

test("#1542c РОУТ НОРМИ: право — ПЕРШОЮ дією, до розбору тіла; межа вкладки «Плани»", () => {
  const pl = SRC("routes/plans.ts");
  const body = pl.slice(pl.indexOf('plansRouter.post("/calls-norm"'));
  const gate = body.indexOf("canSetCallsNorm(auth)"), parse = body.indexOf("callsNormVerdict(req.body");
  assert.ok(gate > 0 && parse > gate, "🔴 тіло читається до перевірки права — 403 стане 400 (гарантія #11)");
  const rt = SRC("auth/routeTab.ts");
  assert.match(rt, /pre\("\/api\/plans"\), tabs: \["plans"\]/);
  assert.match(rt, /pre\("\/api\/statistics\/plan-fact"\), tabs: \["statistics"\]/, "🔴 «План-факт» потрапив під вкладку depstats");
});

test("#1542d КОЛОНКА ЗВІТУ «ДНІВ З НОРМОЮ»: денні комірки зі скоупом команди, норма — з «Планів», чесне «норму не задано»", () => {
  const dash = SRC("routes/dashboard.ts");
  const i = dash.indexOf("callNorm: callNorm.callNormCell(");
  assert.ok(i > 0, "🔴 рядок менеджера в /report-plan більше не несе callNorm");
  const handlerStart = dash.lastIndexOf('.get("/report-plan"', i);
  assert.ok(handlerStart > 0 && handlerStart < i, "🔴 обробник /report-plan не впізнано");
  const around = dash.slice(handlerStart, i);
  assert.match(around, /reportCuts\.callsByManagerDay\(from, to, \{ managerId, teamId \}\)/,
    "🔴 дні з нормою беруться не з тих самих денних комірок (callsByManagerDay зі скоупом команди)");
  assert.match(dash.slice(i, i + 200), /callsNormNow/, "🔴 норма в колонці береться не з «Планів»");
  const FE = (p: string) => readFileSync(srcOf(`../../../frontend/src/${p}`), "utf8");
  assert.match(FE("pages/dashboard/reportTableCols.ts"), /key: "normDays"[\s\S]{0,120}m\.callNorm\?\.daysWithNorm \?\? null/, "🔴 колонка сортує не за daysWithNorm або зникла");
  const table = FE("pages/dashboard/sections/ReportTableSection.tsx");
  assert.match(table, /case "normDays":[\s\S]{0,300}норму не задано/, "🔴 клітинка без норми не називає стан — покаже порожнє або 0");
  assert.match(table, /case "normDays":[\s\S]{0,600}c\.workDays/, "🔴 знаменник (робочі дні) зник із клітинки");
});

test("#1540f ПЛАН НА ДЕНЬ: Σ днів тижня = план тижня плитки (`foldWeek`), і з ручною ціллю на два тижні, і на межі місяців", () => {
  // Менеджер 1: автоплан; менеджер 2: ручна ціль задачі 77 на 28.09–11.10 (два тижні; вересень і жовтень окремими частинами).
  const cells: WeekPlanCell[] = [
    { managerId: 1, teamId: 5, blockFrom: "2026-09-28", blockTo: "2026-09-30", auto: 30_000, manual: null, manualTaskId: null },
    { managerId: 1, teamId: 5, blockFrom: "2026-10-01", blockTo: "2026-10-04", auto: 20_000, manual: null, manualTaskId: null },
    { managerId: 1, teamId: 5, blockFrom: "2026-10-05", blockTo: "2026-10-11", auto: 50_000, manual: null, manualTaskId: null },
    { managerId: 2, teamId: 5, blockFrom: "2026-09-28", blockTo: "2026-09-30", auto: 9, manual: 40_000, manualTaskId: 77 },
    { managerId: 2, teamId: 5, blockFrom: "2026-10-01", blockTo: "2026-10-04", auto: 9, manual: 40_000, manualTaskId: 77 },
    { managerId: 2, teamId: 5, blockFrom: "2026-10-05", blockTo: "2026-10-11", auto: 9, manual: 40_000, manualTaskId: 77 },
  ];
  const days = spreadWeekCellsToDays(cells, () => ["company"], "2026-09-28", "2026-10-11").get("company")!;
  const weekSum = (from: string, to: string) => [...days].filter(([d]) => d >= from && d <= to).reduce((a, [, v]) => a + v, 0);
  const tileWeek = (starts: string[]) => [...foldWeek(cells.filter((c) => starts.includes(c.blockFrom)), starts).values()]
    .reduce((a, p) => a + p.autoPerBlock.reduce((x, v) => x + v, 0) + p.manual, 0);
  assert.equal(Math.round(weekSum("2026-09-28", "2026-10-04")), tileWeek(["2026-09-28", "2026-10-01"]), "🔴 тиждень через межу місяців: Σ днів ≠ план плитки");
  assert.equal(Math.round(weekSum("2026-10-05", "2026-10-11")), tileWeek(["2026-10-05"]), "🔴 ручна ціль на два тижні загубилась у другому тижні");
  assert.equal([...days.keys()].filter((d) => ["2026-10-03", "2026-10-04", "2026-10-10"].includes(d)).length, 0, "🔴 план на вихідний");
});
