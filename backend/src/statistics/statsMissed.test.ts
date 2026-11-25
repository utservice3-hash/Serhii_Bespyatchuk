import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MISSED_METRICS, missedMetricValue, missedSeriesKey, missedPointsOf, missedCompanySet, missedSetFor, missedViewerOf,
  missedSeriesTo, type MissedMetric,
} from "./missedStats.js";
import { blockDenied } from "./statsBuckets.js";
import { WALL_METRICS } from "./seriesWarmSet.js";
import { missedScopeFor, type MissedSeries } from "../core/missedCallsRules.js";

/**
 * 📵 #11050–#11053 — ГРАФІКИ ПРОПУЩЕНИХ ПЕРЕЇХАЛИ У «СТАТИСТИКИ» (Роман 25.11.2026: «із вкладки пропущених дзвінків забрати
 * ці графіки, а перенести все у вкладку статистики, щоб не дублювалась інформація»; 26.11 «роби і деплой»).
 * План: `/mnt/project-files/plans/missed-to-stats/plan.md`.
 *
 * Що тут стережеться — рівно ті місця, де перенос міг збрехати ТИХО, тобто дати правдоподібний графік:
 *   ① лінії взяті з переліку команд «Статистик», а не з ядра — і загубили «Без відповідального» (56% жовтня) та чотири
 *      команди, яких у `LIVE_TEAMS` немає; Σ ліній розійшлась би з компанією;
 *   ② частка рахується не з лічильників точки, або точку без пропущених показано нулем;
 *   ③ сьогоднішній день (доба на передзвін не минула) став останньою точкою;
 *   ④ блок відкрився тим, кому вкладка «Пропущені дзвінки» закрита, або тімлід побачив компанію (рішення Романа 26.11).
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const pt = (period: string, missed: number, callback: number, clientSelf: number, medianMin: number | null) => ({ period, missed, callback, clientSelf, medianMin });

/**
 * #11050 — ЖИВИЙ SQL: ряди «Статистик» = ядро вкладки. Компанія = «усього» ядра; кожна лінія ядра (команда поза
 * `LIVE_TEAMS`, «Поза командами», «Без відповідального») — своя лінія, і Σ ліній = компанія в кожній точці; лінія команди з
 * компанійного виклику = виклик ядра зі зрізом команди (скоуп звужує відповідь, не розрахунок); частки — з лічильників точки;
 * кінець ряду — учора. Червоніє, якщо: брати команди з `LIVE_TEAMS` або пропустити якусь лінію ядра; рахувати частку не з
 * лічильників точки; показати точку без пропущених нулем; прибрати кламп «учора».
 */
test("#11050 ПРОПУЩЕНІ НА СТАТИСТИКАХ · ЖИВИЙ SQL: лінії з ядра (Σ = компанія), команда = зріз ядра, частки з точки, кінець — учора", async (t) => {
  // Чисті межі — по обидва боки, без БД (виконуються в будь-якому оточенні).
  assert.equal(missedSeriesTo("2026-12-31", "2026-09-17"), "2026-09-16", "🔴 кінець ряду не «учора»: сьогоднішня частка «не передзвонили» ще не мала доби");
  assert.equal(missedSeriesTo("2026-09-10", "2026-09-17"), "2026-09-10", "🔴 кламп зсунув кінець, який і так раніше за вчора");
  assert.equal(missedSeriesTo("2026-03-31", "2026-03-01"), "2026-02-28", "🔴 «учора» від 1-го числа не перейшло в попередній місяць");
  assert.equal(missedMetricValue("missed_nocb_pct", pt("p", 0, 0, 0, null)), null, "🔴 точку без пропущених показано як 0%, а не «немає даних»");
  assert.equal(missedMetricValue("missed_self_pct", pt("p", 0, 0, 0, null)), null, "🔴 точку без пропущених показано як 0%");
  assert.equal(missedMetricValue("missed_cb_median", pt("p", 0, 0, 0, 5)), null, "🔴 медіану показано там, де пропущених немає");
  assert.equal(missedMetricValue("missed_nocb_pct", pt("p", 3, 1, 1, 7)), 66.7, "🔴 «не передзвонили» ≠ (пропущено − передзвонили) ÷ пропущено");
  assert.equal(missedMetricValue("missed_self_pct", pt("p", 3, 1, 1, 7)), 33.3, "🔴 «клієнт сам» ≠ клієнт сам ÷ пропущено");
  assert.equal(missedMetricValue("missed_cb_median", pt("p", 3, 1, 1, 7)), 7, "🔴 медіана не та, що порахувало ядро для точки");
  assert.deepEqual(WALL_METRICS.filter((m) => m.block === "missed").map((m) => m.metric), [...MISSED_METRICS],
    "🔴 фоновий прогрів не знає всіх чотирьох показників — розділ відкриватиметься холодним");

  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const R = await import("../core/missedCallsRules.js");
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    // 5 — команда з `LIVE_TEAMS`, 50011 — команда, якої там НЕМАЄ (Лідогенерація на проді).
    await c.query("INSERT INTO teams(id,name) VALUES (5,'Яцик Team lead'),(50011,'Лідогенерація') ON CONFLICT DO NOTHING");
    await c.query(`INSERT INTO managers(id,name,team_id,is_active) VALUES (1,'Яцик',5,true),(2,'Лідген',50011,true),(4,'Без команди',NULL,true) ON CONFLICT DO NOTHING`);
    let seq = 0;
    const call = (at: string, type: string, disp: string, sec: number, mgr: number | null, phone: string) =>
      c.query(`INSERT INTO ringostat_calls(uniqueid,calldate,call_type,disposition,billsec,manager_id,client_phone) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [`s${String(++seq)}`, at, type, disp, sec, mgr, phone]);
    await call("2026-09-14 10:00:00+03", "in", "NO ANSWER", 0, 1, "B1");      // команда 5
    await call("2026-09-14 10:10:00+03", "out", "ANSWERED", 30, 1, "B1");     // передзвін через 10 хв
    await call("2026-09-14 11:00:00+03", "in", "NO ANSWER", 0, 1, "B2");      // команда 5, без передзвону
    await call("2026-09-14 12:00:00+03", "in", "BUSY", 0, 2, "B3");           // команда 50011 (поза LIVE_TEAMS)
    await call("2026-09-14 13:00:00+03", "in", "NO ANSWER", 0, 4, "B4");      // поза командами
    await call("2026-09-14 14:00:00+03", "in", "NO ANSWER", 0, null, "B5");   // без відповідального
    await call("2026-09-14 15:00:00+03", "in", "NO ANSWER", 0, null, "B6");   // без відповідального
    await call("2026-09-14 15:20:00+03", "in", "ANSWERED", 40, 1, "B6");      // клієнт передзвонив сам
    await call("2026-09-15 09:00:00+03", "in", "NO ANSWER", 0, 2, "B7");      // інший день, команда 50011
    await c.query("SET TIME ZONE 'UTC'");

    const run = async (g: "day" | "week" | "month", s: import("../core/missedCallsRules.js").MissedScope): Promise<MissedSeries[]> => {
      const q = R.missedSeriesSql(g, "2026-09-10", "2026-09-16", s);
      return R.foldSeries((await c.query(q.sql, q.params)).rows as import("../core/missedCallsRules.js").MissedSeriesRaw[]);
    };
    for (const g of ["day", "week", "month"] as const) {
      const company = await run(g, {});
      const set = missedSetFor({ kind: "company" }, { series: company });
      assert.equal(set[0].scopeType, "company", "🔴 перша лінія не компанія");
      assert.deepEqual(set.slice(1).map((s) => missedSeriesKey(s.scopeType, s.scopeKey)), company.filter((s) => s.key !== "total").map((s) => s.key),
        `🔴 ${g}: лінії «Статистик» ≠ лініям ядра — щось загублено або додано`);
      assert.ok(set.some((s) => s.scopeType === "team_lead" && s.scopeKey === "50011"), "🔴 команда поза `LIVE_TEAMS` загубилась");
      assert.deepEqual(set.slice(-2).map((s) => s.scopeName), ["Поза командами", "Без відповідального"], "🔴 «Поза командами» / «Без відповідального» загубились");
      const companyPts = missedPointsOf(company, missedSeriesKey("company", "company"), "missed_count");
      assert.ok(companyPts.length > 0, "🔴 порожній ряд компанії — перевірці нема що звіряти");
      for (const p of companyPts) {
        const sum = set.slice(1).reduce((n, s) => n + (missedPointsOf(company, missedSeriesKey(s.scopeType, s.scopeKey), "missed_count").find((x) => x.period === p.period)?.value ?? 0), 0);
        assert.equal(sum, p.value, `🔴 ${g} ${p.period}: Σ ліній (${String(sum)}) ≠ компанії (${String(p.value)})`);
      }
      for (const teamId of [5, 50011]) {
        const viaTeam = await run(g, { teamId });
        for (const m of MISSED_METRICS) {
          assert.deepEqual(missedPointsOf(company, missedSeriesKey("team_lead", String(teamId)), m), missedPointsOf(viaTeam, "total", m),
            `🔴 ${g} ${m}: лінія команди ${String(teamId)} з компанійного виклику ≠ ядро зі зрізом команди`);
        }
      }
    }
    const day = await run("day", {});
    const at = (m: MissedMetric, key = "total") => missedPointsOf(day, key, m).find((x) => x.period === "2026-09-14")?.value;
    assert.equal(at("missed_count"), 6, "🔴 пропущені за 14.09 — не з ядра");
    assert.equal(at("missed_nocb_pct"), 83.3, "🔴 «не передзвонили» 14.09 не з лічильників точки (5 із 6)");
    assert.equal(at("missed_self_pct"), 16.7, "🔴 «клієнт сам» 14.09 не з лічильників точки (1 із 6)");
    assert.equal(at("missed_cb_median"), 10, "🔴 медіана передзвону не з ядра");
    assert.equal(at("missed_count", "ownerless"), 2, "🔴 «Без відповідального» за 14.09 не з ядра");
  } finally { await c.end(); scratch.dispose(); }

  // Проводка роуту: один компанійний виклик ядра на всі лінії, кінець — учора, гілка рядів для «Поза командами».
  const route = codeOnly(read("backend/src/routes/statisticsSeries.ts"));
  assert.match(route, /const missedSeriesM = memoize\("missedSeries", missedSeriesRaw\);/, "🔴 ряди пропущених не через спільний виклик ядра");
  assert.match(route, /const end = missedSeriesTo\(to, kyivToday\(\)\);[\s\S]{0,120}await missedSeriesM\(g, from, end, managerId != null \? \{ managerId \} : \{\}\)/,
    "🔴 лінія команди рахується зрізом, а не з компанійного виклику, або кінець ряду не «учора»");
  assert.match(route, /if \(block === MISSED_BLOCK\) crm = await missedPoints\(metric, g, cf, to, scopeType, scopeKey, managerId\);/,
    "🔴 лінії «Поза командами» / «Без відповідального» не мають гілки рядів — лишаться порожніми");
  assert.match(route, /if \(q\?\.block === MISSED_BLOCK\) return unit \? \[\] : missedSet\(auth, q\.g, q\.from, q\.to\);/, "🔴 набір ліній пропущених не свій");
});

const can = (tabs: string[]) => ({ tab: (x: string) => tabs.includes(x), perm: () => false });

/**
 * #11051 — ДОСТУП: числа «Пропущених дзвінків» на «Статистиках» бачить лише той, кому відкрита вкладка «Пропущені дзвінки»;
 * дзеркально — з вкладкою відкрито, і решта відділів від цього не закрилась. Червоніє, якщо прибрати рядок у `blockDenied`
 * або закрити блок усім.
 */
test("#11051 ПРОПУЩЕНІ НА СТАТИСТИКАХ · ДОСТУП: лише з вкладкою «Пропущені дзвінки», дзеркально відкрито", () => {
  assert.ok(blockDenied("missed", can(["statistics"])), "🔴 числа пропущених видно без вкладки «Пропущені дзвінки» — «Статистики» стали обхідним входом");
  assert.equal(blockDenied("missed", can(["statistics", "missed-calls"])), null, "🔴 той, кому вкладка відкрита, не бачить розділу");
  assert.equal(blockDenied("sales", can(["statistics"])), null, "🔴 рядок пропущених закрив чужий відділ");
  const route = codeOnly(read("backend/src/routes/statisticsSeries.ts"));
  const h = route.slice(route.indexOf('statsSeriesRouter.get("/series"'));
  assert.ok(h.indexOf("blockDenied(block,") > 0 && h.indexOf("blockDenied(block,") < h.indexOf("await seriesSet("), "🔴 межа не перед набором ліній");
});

/**
 * #11053 — ХТО ЯКІ ЛІНІЇ БАЧИТЬ — дзеркало клампу вкладки (`missedScopeFor`), виконанням для кожної ролі. Тімлід — своя
 * команда й її менеджери БЕЗ компанії (рішення Романа 26.11.2026, картка «Ні, як зараз»); менеджер — лише свої; без
 * привʼязки — нічого (не компанія); керівництво й фінансист — компанія й усі лінії. Червоніє, якщо тімліду додати компанію,
 * менеджеру без manager_id віддати компанію або вирішувати за наявністю manager_id замість ролі.
 */
test("#11053 ПРОПУЩЕНІ НА СТАТИСТИКАХ · СКОУП: як на вкладці — тімлід без компанії, менеджер лише свої, без привʼязки нічого", () => {
  const series: MissedSeries[] = [
    { key: "total", name: null, points: [pt("2026-09-14", 3, 1, 0, 4)] },
    { key: "team:5", name: "Яцик Team lead", points: [pt("2026-09-14", 1, 1, 0, 4)] },
    { key: "ownerless", name: "Без відповідального", points: [pt("2026-09-14", 2, 0, 0, null)] },
  ];
  const ctx = { teamName: "Яцик Team lead", managers: [{ id: 1, name: "Яцик" }, { id: 9, name: "Новенька" }], series };
  const roles: { role: string; managerId: number | null; teamId: number | null }[] = [
    { role: "manager", managerId: 1, teamId: 5 }, { role: "manager", managerId: null, teamId: null },
    { role: "team_lead", managerId: 3, teamId: 5 }, { role: "team_lead", managerId: null, teamId: null },
    { role: "kvp", managerId: 7, teamId: null }, { role: "admin", managerId: null, teamId: null },
    { role: "financier", managerId: null, teamId: null }, { role: "ceo", managerId: 2, teamId: 6 },
  ];
  for (const a of roles) {
    const set = missedSetFor(missedViewerOf(a), ctx);
    const tab = missedScopeFor(a, {});
    const what = `${a.role} (manager ${String(a.managerId)}, team ${String(a.teamId)})`;
    if (tab.managerId != null) {
      // Вкладка звужує до менеджера: на «Статистиках» — лише його лінія, або нічого, якщо привʼязки немає (вкладка ставить -1).
      assert.deepEqual(set.map((s) => s.managerId), tab.managerId > 0 ? [tab.managerId] : [], `🔴 ${what}: менеджер бачить не лише себе`);
    } else if (tab.teamId != null) {
      assert.ok(!set.some((s) => s.scopeType === "company"), `🔴 ${what}: тімлід бачить компанію — перенос відкрив числа, яких на вкладці немає`);
      if (tab.teamId > 0) {
        assert.deepEqual(set.map((s) => [s.scopeType, s.scopeKey]), [["team_lead", "5"], ["manager", "1"], ["manager", "9"]], `🔴 ${what}: не своя команда й її менеджери`);
      } else assert.deepEqual(set, [], `🔴 ${what}: тімлід без команди бачить чужі лінії`);
    } else {
      assert.deepEqual(set.map((s) => s.scopeKey), ["company", "5", "ownerless"], `🔴 ${what}: керівництво бачить не компанію й усі лінії ядра`);
    }
  }
  // Дзеркало: адмін компанію БАЧИТЬ (інакше «тімлід без компанії» зеленіло б і тоді, коли компанії немає ні в кого).
  assert.equal(missedSetFor(missedViewerOf({ role: "admin", managerId: null, teamId: null }), ctx)[0].scopeType, "company", "🔴 керівництво не бачить компанії");
  assert.deepEqual(missedCompanySet([]).map((s) => s.scopeKey), ["company"], "🔴 без даних ядра пропала навіть лінія компанії");
});
