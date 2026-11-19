import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  pickHandoffActor, pickLeadgenClients, firstSuccessOf, aggLtv, cohortsOf, unlinkedByMonth, ltvAccess, kyivDay, ltvGroupOf, type LtvRow,
  ltvSourceLabel, bySourceOf, SOURCE_UNSET, SOURCE_NO_LEAD,
} from "./leadgenLtvRules.js";

/**
 * 💎 LTV КЛІЄНТІВ ЛІДОГЕНЕРАЦІЇ (ТЗ 28.10.2026; Роман 06.11.2026 «роби так, як каже ТЗ»). Окремий файл: живий гейт підключає
 * спільний пул (`db/pool.js`, синглтон) до одноразової бази — один кластер на файл (правило testing.md).
 */
const SRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");
const FSRC = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", rel), "utf8");
const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/**
 * #3770 — ХТО КЛІЄНТ ЛІДГЕНА І ЗА КИМ ВІН (п. 3.1, 3.2, 9): перша успішна угода клієнта = угода з передачі → так; перша успішна
 * — інша, раніша угода (постійний до передачі) → ні; дві передачі з однією угодою — раніша; архів «перевізник» → ні; КВП
 * позначив постійним ДО передачі → ні, ПІСЛЯ → так. Хто передав — автор ОСТАННЬОГО входу в «Кваліфіковано» того дня; робот
 * і вхід іншого дня — не він. Найраніший успіх — за часом, а не за порядком у масиві.
 * 🧨 Червоніє, якщо брати поточного відповідального, рахувати постійних, ігнорувати архів чи час позначки КВП.
 */
test("#3770 КЛІЄНТ ЛІДГЕНА: перша успішна з передачі, постійні й перевізники — ні, хто передав — автор входу в «Кваліфіковано»", () => {
  const first = firstSuccessOf(new Map([
    ["a", [{ at: 3000, day: "2026-09-10", dealId: 31 }, { at: 1000, day: "2026-08-01", dealId: 11 }]], // найраніша — 11
    ["b", [{ at: 500, day: "2026-07-01", dealId: 5 }, { at: 2000, day: "2026-09-01", dealId: 12 }]],  // була успішна до передачі
    ["c", [{ at: 1500, day: "2026-08-05", dealId: 13 }]],
    ["d", [{ at: 1600, day: "2026-08-06", dealId: 14 }]],
    ["e", [{ at: 1700, day: "2026-08-07", dealId: 15 }]],
    ["f", [{ at: 1800, day: "2026-08-08", dealId: 16 }]],
  ]));
  assert.deepEqual(first.get("a"), { dealId: 11, day: "2026-08-01" }, "🔴 перша успішна — не найраніша за часом");
  const handoffs = [
    { pzId: 101, dealId: 11, day: "2026-07-28" }, { pzId: 102, dealId: 12, day: "2026-08-20" },
    { pzId: 104, dealId: 13, day: "2026-08-02" }, { pzId: 103, dealId: 13, day: "2026-08-01" }, // дві передачі — раніша
    { pzId: 105, dealId: 14, day: "2026-08-03" }, { pzId: 106, dealId: 15, day: "2026-08-04" }, { pzId: 107, dealId: 16, day: "2026-08-05" },
    { pzId: 108, dealId: null, day: "2026-08-05" },
  ];
  const picks = pickLeadgenClients(first, handoffs, new Set(["d"]), new Map([["e", "2026-08-01"], ["f", "2026-08-30"]]));
  assert.deepEqual(picks.map((p) => p.clientKey), ["a", "c", "f"], "🔴 не ті клієнти лідгенів");
  assert.equal(picks.find((p) => p.clientKey === "c")!.pzId, 103, "🔴 клієнт закріплений не за тією (не ранішою) передачею");
  assert.ok(!picks.some((p) => p.clientKey === "b"), "🔴 постійний до передачі зарахований лідгену");
  assert.ok(!picks.some((p) => p.clientKey === "d"), "🔴 перевізник з архіву зарахований");
  assert.ok(!picks.some((p) => p.clientKey === "e"), "🔴 позначений КВП постійним ДО передачі зарахований");
  assert.ok(picks.some((p) => p.clientKey === "f"), "🔴 позначка КВП ПІСЛЯ передачі забрала клієнта в лідгена");

  const day = "2026-08-01";
  const ev = [
    { entityId: 103, createdBy: 7, toStatusId: 142, at: sec("2026-08-01T09:00:00+03:00") },
    { entityId: 103, createdBy: 9, toStatusId: 142, at: sec("2026-08-01T15:00:00+03:00") },  // останній вхід того дня
    { entityId: 103, createdBy: 0, toStatusId: 142, at: sec("2026-08-01T16:00:00+03:00") },  // робот — не людина
    { entityId: 103, createdBy: 11, toStatusId: 142, at: sec("2026-08-02T10:00:00+03:00") }, // інший день
    { entityId: 103, createdBy: 12, toStatusId: 50, at: sec("2026-08-01T17:00:00+03:00") },  // не «Кваліфіковано»
    { entityId: 999, createdBy: 13, toStatusId: 142, at: sec("2026-08-01T18:00:00+03:00") }, // інша угода
  ];
  assert.equal(pickHandoffActor(ev.filter((e) => e.createdBy !== 0), 103, day), 9, "🔴 хто передав — не автор останнього входу дня");
  assert.equal(pickHandoffActor(ev, 103, day), null, "🔴 робот записаний як той, хто передав");
  assert.equal(kyivDay(sec("2026-07-31T22:30:00Z")), "2026-08-01", "🔴 день — не за Києвом");
});

/**
 * #3771 — ПОКАЗНИКИ (п. 3.5): середній, повторні (2+ угоди), угод на клієнта, приріст і нові ЛИШЕ за періодом (обидві межі
 * включно); когорти — за місяцем першої успішної, Σ когорт = усі клієнти; ⚠ — понад 20% передач без угоди менеджера
 * (рівно 20% — ні).
 * 🧨 Червоніє, якщо змішати «за весь час» із періодом, зсунути межу періоду чи поріг ⚠.
 */
test("#3771 ПОКАЗНИКИ: середній, повторні, угод на клієнта, приріст і нові за період, когорти й ⚠ понад 20%", () => {
  const rows: LtvRow[] = [
    { clientKey: "a", ltv: 10000, deals: 3, turnover: 50000, firstDay: "2026-09-30", growth: 2000 },
    { clientKey: "b", ltv: 2000, deals: 1, turnover: 9000, firstDay: "2026-10-01", growth: 2000 },
    { clientKey: "c", ltv: -500, deals: 1, turnover: 0, firstDay: "2026-10-31", growth: 0 },
    { clientKey: "d", ltv: 4500, deals: 2, turnover: 20000, firstDay: "2026-11-01", growth: 0 },
  ];
  const a = aggLtv(rows, "2026-10-01", "2026-10-31");
  assert.deepEqual(a, { clients: 4, ltv: 16000, turnover: 79000, avg: 4000, repeatPct: 50, dealsPerClient: 1.8, growth: 4000, newClients: 2,
    repeat: 2, activeNow: 0, mix: { rw: 0, rs: 2, ow: 0, os: 2 } },
    "🔴 підсумок не той (нові — лише з першою угодою в періоді, обидві межі включно)");
  assert.deepEqual(aggLtv([], "2026-10-01", "2026-10-31").avg, null, "дзеркало: без клієнтів — «—», а не 0");
  const months = unlinkedByMonth([
    ...Array.from({ length: 10 }, (_, i) => ({ day: "2026-10-05", dealId: i < 2 ? null : i })), // рівно 20% — без ⚠
    ...Array.from({ length: 10 }, (_, i) => ({ day: "2026-09-05", dealId: i < 3 ? null : i })), // 30% — ⚠
  ]);
  const cs = cohortsOf(rows, months, "2026-10-01", "2026-10-31");
  assert.deepEqual(cs.map((c) => c.ym), ["2026-11", "2026-10", "2026-09"], "🔴 когорти не за місяцем першої угоди або не нові зверху");
  assert.equal(cs.reduce((s, c) => s + c.clients, 0), a.clients, "🔴 Σ когорт ≠ клієнтів відділу");
  assert.deepEqual(cs.map((c) => [c.ym, c.warn]), [["2026-11", false], ["2026-10", false], ["2026-09", true]], "🔴 ⚠ не за порогом «понад 20%»");
});

/**
 * #3772 — МЕЖА (п. 6, на сервері): менеджер поза командою — 403; лідген — лише свої (вибір іншого — 403, себе — можна);
 * тімлід — своя команда; керівництво — увесь відділ із вибором будь-кого. Обидва роути йдуть через `ltvAccess` ДО читання.
 * 🧨 Червоніє, якщо лідгену віддати відділ або чужого лідгена, чи роут читатиме дані до межі.
 */
test("#3772 ДОСТУП LTV: лідген — лише свої, менеджер продажу — 403, тімлід — команда, керівництво — усе", () => {
  const lg = { role: "manager", teamId: 50011, managerId: 118, leadgenTeamId: 50011 };
  assert.deepEqual(ltvAccess(lg, null), { ok: true, scope: { kind: "own", managerId: 118 }, pick: null }, "🔴 лідгену не своя межа");
  assert.equal(ltvAccess(lg, 134).ok, false, "🔴 лідген побачив чужого лідгена");
  assert.equal(ltvAccess(lg, 118).ok, true, "дзеркало: себе обрати можна");
  assert.equal(ltvAccess({ role: "manager", teamId: 5, managerId: 40, leadgenTeamId: null }, null).ok, false, "🔴 менеджер продажу бачить LTV лідгенів");
  assert.deepEqual(ltvAccess({ role: "team_lead", teamId: 50011, managerId: 106 }, null), { ok: true, scope: { kind: "team", teamId: 50011 }, pick: null });
  assert.deepEqual(ltvAccess({ role: "admin", teamId: null }, 134), { ok: true, scope: { kind: "all" }, pick: 134 }, "дзеркало: керівництво — усе й будь-кого");
  const r = SRC("routes/dashboard.ts");
  for (const route of ["/leadgen-ltv", "/leadgen-ltv-clients"]) {
    const body = r.slice(r.indexOf(`dashboardRouter.get("${route}"`), r.indexOf("\n});", r.indexOf(`dashboardRouter.get("${route}"`)));
    assert.ok(body.length > 0, `🔴 роуту ${route} немає`);
    const gate = body.indexOf("ltvAccess(");
    assert.ok(gate > 0 && gate < body.indexOf("if (!access.ok)") && body.indexOf("if (!access.ok)") < body.search(/leadgenLtv(View|Clients)\(/),
      `🔴 ${route}: межа не перед читанням даних`);
  }
});

/**
 * #3773 — ДЖОБА ПІД НАГЛЯДОМ (п. 10): крон о :12/:42 кличе `runJob("buildLeadgenLtv")`, у реєстрі нагляду `everyMin` = 30
 * (тривога на 2×), прапорець «уже працює» зі стелею, пропуск — `jobSkip`, а не успіх.
 * 🧨 Червоніє, якщо джобу прибрати з крону чи з нагляду, розійтись частотами або зняти стелю.
 */
test("#3773 ДЖОБА LTV: крон :12/:42, у нагляді на 30 хв, стеля прапорця, пропуск — не успіх", async () => {
  const idx = SRC("index.ts");
  assert.match(idx, /cron\.schedule\("12,42 \* \* \* \*", \(\) => \{\s*void runJob\("buildLeadgenLtv", \(\) => buildLeadgenLtv\(\)\);/, "🔴 джоба не в кроні");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "buildLeadgenLtv")?.everyMin, 30, "🔴 джоба не під наглядом або частота розійшлась із кроном");
  const job = SRC("jobs/buildLeadgenLtv.ts");
  assert.match(job, /if \(running && Date\.now\(\) - running < CEILING_MS\) return jobSkip\(/, "🔴 немає стелі прапорця або пропуск — успіх");
});

/**
 * #3774 — ФРОНТ (п. 5): блок — `<details className="chart-card">`, згорнутий за замовчуванням, після «Деталей відділу» й перед
 * «Планами лідгенів»; статичний імпорт (один чанк, #225); у «Які угоди рахуємо» — вкладка «Клієнти LTV»; картки «Відділ» і
 * лідгенів блок не чіпає (він окремий компонент).
 * 🧨 Червоніє, якщо блок розгорнутий за замовчуванням, не на своєму місці, лінивий або без вкладки «Клієнти LTV».
 */
test("#3774 ФРОНТ LTV: згорнутий блок між «Деталями» й «Планами», статичний імпорт, вкладка «Клієнти LTV»", () => {
  const blk = FSRC("pages/dashboard/sections/LeadgenLtvBlock.tsx");
  assert.match(blk, /const \[open, setOpen\] = useState\(false\);/, "🔴 блок не згорнутий за замовчуванням");
  assert.match(blk, /<details className="chart-card"[^>]*open=\{open\}/, "🔴 блок не в стилі сусідніх (`details.chart-card`)");
  assert.match(blk, /💎 LTV клієнтів лідогенерації · /);
  const s = FSRC("pages/dashboard/sections/LeadgenSection.tsx");
  assert.match(s, /^import \{ LeadgenLtvBlock \} from "\.\/LeadgenLtvBlock";$/m, "🔴 блок не статичним імпортом");
  const det = s.indexOf("<Details d={d}"), ltv = s.indexOf("<LeadgenLtvBlock "), plans = s.indexOf("<LeadgenPlanFormation ");
  assert.ok(det > 0 && det < ltv && ltv < plans, "🔴 блок LTV не між «Деталями» і «Планами лідгенів»");
  const cd = FSRC("pages/dashboard/sections/LeadgenCountedDeals.tsx");
  assert.match(cd, /\["ltv", "Клієнти LTV", ltv\?\.clients\.length\]/, "🔴 немає вкладки «Клієнти LTV»");
});

/* ───────── живий гейт: одна одноразова база на файл ───────── */
type Live = { c: import("pg").Client; done: () => Promise<void> };
let live: Promise<Live | { skip: string }> | null = null;
function liveDb(): Promise<Live | { skip: string }> {
  live ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const scratch = provisionScratch();
    if ("unavailable" in scratch) return { skip: skipReason(scratch) };
    process.env.DATABASE_URL = scratch.url;
    process.env.JWT_SECRET ??= "test"; process.env.KOMMO_BASE_URL ??= "https://x.invalid"; process.env.KOMMO_API_TOKEN ??= "x";
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: scratch.url });
    await c.connect();
    const { pool } = await import("../db/pool.js");
    const schema = SRC("db/schema.sql");
    await c.query(schema);
    await c.query(schema);
    return { c, done: async () => { await pool.end().catch(() => {}); await c.end(); scratch.dispose(); } };
  })();
  return live;
}
after(async () => { const l = live && await live; if (l && "done" in l) await l.done(); });

/**
 * #3990 — «СТАЛИ ПОСТІЙНИМИ» І «ПРАЦЮЮТЬ ЗАРАЗ» (задача 8729, Роман 13.11.2026): постійний — 2+ успішні угоди (1 — ні, 2 — так),
 * працює — лише стан `active` («сплячий», «втрачений» і невідомий — ні). Склад на чотири групи покриває кожного рівно раз:
 * Σ груп = клієнтів, у тому числі в когортах.
 * 🧨 САБОТАЖ: у `isRepeatClient` `deals >= 2` → `deals >= 3` → червоніє (клієнт із 2 угодами — разовий).
 */
test("#3990 СТАЛИ ПОСТІЙНИМИ Й ПРАЦЮЮТЬ ЗАРАЗ: 2+ угоди, лише стан active; склад покриває кожного рівно раз", () => {
  const R = (k: string, deals: number, state: string | null, firstDay = "2026-10-05"): LtvRow => ({ clientKey: k, ltv: 1000, deals, turnover: 0, firstDay, growth: 0, state });
  const rows = [R("a", 2, "active"), R("b", 5, "sleeping"), R("c", 2, "lost"), R("d", 1, "active"), R("e", 1, "sleeping"), R("f", 1, null), R("g", 3, null, "2026-09-01")];
  const a = aggLtv(rows, "2026-10-01", "2026-10-31");
  assert.deepEqual([a.repeat, a.activeNow], [4, 2], "🔴 постійних не 4 (a, b, c, g з 2+ угодами) або працюють не 2 (лише active: a, d)");
  assert.deepEqual(a.mix, { rw: 1, rs: 3, ow: 1, os: 2 }, "🔴 склад: невідомий стан має йти в «не працює», 2 угоди — у постійні");
  assert.equal(Object.values(a.mix).reduce((x, y) => x + y, 0), a.clients, "🔴 Σ груп ≠ клієнтів");
  assert.deepEqual([ltvGroupOf(1, "active"), ltvGroupOf(2, "active"), ltvGroupOf(2, undefined), ltvGroupOf(1, "lost")], ["ow", "rw", "rs", "os"], "🔴 межа «1 угода — разовий / 2 — постійний»");
  for (const c of cohortsOf(rows, new Map(), "2026-10-01", "2026-10-31"))
    assert.equal(Object.values(c.mix).reduce((x, y) => x + y, 0), c.clients, `🔴 когорта ${c.ym}: Σ груп ≠ клієнтів`);
});

/**
 * #3775 — ЖИВИЙ SQL БЛОКУ (схема двічі — ті самі таблиці): лідгени команди — своїми рядками, звільнений і «не з команди» — в
 * «Інші» поіменно (звільнений підписаний); Σ людей + «Інші» = відділ; повернуті з пулу — окремо, в LTV не входять; приріст —
 * ядром ① за період (угода поза періодом — ні); лідген бачить лише своїх, тімлід — без «Інших»; оборот ядра — сума рахунку
 * тих самих успішних угод, угода без сум — видно числом.
 * 🧨 Червоніє, якщо «Інші» випадуть із суми, пул змішається з LTV, приріст рахуватиме весь час, або межа пропустить чужих.
 */
test("#3775 ЖИВИЙ SQL LTV: люди + «Інші» = відділ, пул окремо, приріст за період ядром, межа лідгена й тімліда", async (t) => {
  const l = await liveDb();
  if ("skip" in l) return t.skip(l.skip);
  const { c } = l;
  await c.query(`INSERT INTO managers (id, name, kommo_user_id, team_id, is_active) VALUES
    (118, 'Демчук', 13369800, 50011, true), (134, 'Крупник', 13656180, 50011, true),
    (106, 'Сердюк', 12812476, 50011, false), (44, 'Ковтонюк', 8458577, NULL, true), (7, 'Менеджер', 777, NULL, true)`);
  const ins = (k: string, lg: number | null, actor: number | null, ltv: number, deals: number, first: string) =>
    c.query(`INSERT INTO leadgen_ltv_clients (client_key, lg_manager_id, actor_kommo_user_id, pz_id, handoff_day, first_deal_id, first_day, deals, ltv, turnover)
             VALUES ($1,$2,$3,1,$4,1,$4,$5,$6,0)`, [k, lg, actor, first, deals, ltv]);
  await ins("a", 118, 13369800, 10000, 3, "2026-08-01"); await ins("b", 118, 13369800, 2000, 1, "2026-10-10");
  await ins("c", 134, 13656180, 3000, 2, "2026-09-01");
  await ins("d", 106, 12812476, 5000, 1, "2026-07-01");  // звільнений — «Інші»
  await ins("e", 44, 8458577, 1000, 1, "2026-06-01");    // не з команди — «Інші»
  await ins("f", null, 13948136, 700, 1, "2026-06-02");  // акаунт Kommo без менеджера — «Інші»
  await c.query(`INSERT INTO leadgen_ltv_pool (client_key, lg_manager_id, taken_at, ltv_after, deals_after) VALUES ('p', 134, '2026-10-02', 900, 1)`);
  // Приріст — ядро ①: успішні угоди клієнта «a» в жовтні й у вересні.
  await c.query(`INSERT INTO deals (kommo_id, manager_id, pipeline_id, status_id, closed_at_kommo, price, client_key) VALUES
    (9001, 7, 8921932, 142, '2026-10-15 12:00+03', 1200, 'a'), (9002, 7, 8921932, 142, '2026-09-15 12:00+03', 800, 'a')`);
  const { leadgenLtvView } = await import("./leadgenLtv.js");
  const v = await leadgenLtvView({ kind: "all" }, "2026-10-01", "2026-10-31", null);
  assert.deepEqual(v.people.map((p) => [p.name, p.agg.clients, p.agg.ltv]), [["Демчук", 2, 12000], ["Крупник", 1, 3000]], "🔴 рядки команди не ті");
  assert.ok(v.others, "🔴 «Інших» немає");
  assert.deepEqual(v.others!.people.map((p) => [p.name, p.dismissed]).sort(), [["Ковтонюк", false], ["Сердюк", true], ["акаунт Kommo 13948136", false]].sort(),
    "🔴 «Інші» не поіменно або звільнений не підписаний");
  assert.equal(v.people.reduce((s, p) => s + p.agg.ltv, 0) + v.others!.agg.ltv, v.totals.ltv, "🔴 Σ людей + «Інші» ≠ відділ");
  assert.equal(v.totals.ltv, 21700, "🔴 LTV відділу не той (пул туди не входить)");
  assert.deepEqual(v.pool, { clients: 1, ltv: 900 }, "🔴 повернуті з пулу не окремо");
  assert.equal(v.totals.growth, 1200, "🔴 приріст рахує не лише період");
  assert.equal(v.totals.newClients, 1, "🔴 нові за період не ті");
  const own = await leadgenLtvView({ kind: "own", managerId: 134 }, "2026-10-01", "2026-10-31", null);
  assert.deepEqual([own.totals.clients, own.others, own.people.map((p) => p.name), own.pool.clients], [1, null, ["Крупник"], 1], "🔴 лідген бачить чужих");
  const team = await leadgenLtvView({ kind: "team", teamId: 50011 }, "2026-10-01", "2026-10-31", null);
  assert.deepEqual([team.totals.clients, team.others], [3, null], "🔴 тімлід бачить «Інших» або не свою команду");

  await c.query(`INSERT INTO deal_fin_fields (kommo_id, income) VALUES (9001, 15000)`);
  const { successIncomeByClientKey } = await import("./money.js");
  assert.deepEqual(await successIncomeByClientKey(["a"]).then((m) => m.get("a")), { income: 15000, missing: 1 }, "🔴 оборот не сума рахунку тих самих угод або без сум мовчить");
});

/**
 * #8719 — ЗВІДКИ ПРИЙШОВ КЛІЄНТ ЛІДГЕНА: підпис джерела по обидва боки кожної межі. Ліда немає → «лід не знайдено»; поле
 * порожнє чи з пробілів → «не проставлене» (два невідомі різні); LinkedIn / Prozorro — за мітками ядра, і мітка перебиває текст
 * поля; LinkedIn перед Prozorro; решта — текст поля як у Kommo, без зведення реактивацій. «За джерелом»: кожен клієнт рівно раз,
 * Σ рядків = `aggLtv` усіх (клієнти, LTV, постійні, працюють, склад); невідомі — внизу.
 * 🧨 Червоніє, якщо порожнє джерело лишити порожнім, злити два невідомі, ігнорувати тег, звести реактивації або загубити клієнта.
 */
test("#8719 ДЖЕРЕЛО КЛІЄНТА ЛІДГЕНА: невідоме словами, LinkedIn/Prozorro за міткою, Σ «За джерелом» = шапка", () => {
  const L = (o: Partial<{ found: boolean; linkedin: boolean; prozorro: boolean; source: string | null }>) =>
    ltvSourceLabel({ found: true, linkedin: false, prozorro: false, source: null, ...o });
  assert.equal(L({ found: false, source: "Холодная база" }), SOURCE_NO_LEAD, "🔴 лід, якого немає в дашборді, отримав джерело");
  assert.equal(L({ source: null }), SOURCE_UNSET, "🔴 порожнє джерело не підписане словами");
  assert.equal(L({ source: "   " }), SOURCE_UNSET, "🔴 джерело з пробілів прочиталось як значення");
  assert.notEqual(SOURCE_UNSET, SOURCE_NO_LEAD, "🔴 два різні невідомі злиті в один підпис");
  assert.equal(L({ source: " Холодная база " }), "Холодная база", "🔴 текст поля не той (пробіли по краях)");
  assert.equal(L({ source: null, linkedin: true }), "LinkedIn", "🔴 лід з тегом LinkedIn і порожнім полем — «не проставлене»");
  assert.equal(L({ source: "Реактивация звонком", linkedin: true }), "LinkedIn", "🔴 мітка LinkedIn не перебила текст поля");
  assert.equal(L({ source: "AI тендер", prozorro: true }), "Prozorro", "🔴 Prozorro не за міткою ядра");
  assert.equal(L({ linkedin: true, prozorro: true }), "LinkedIn", "🔴 LinkedIn і Prozorro разом — не LinkedIn, як у Звіті");
  assert.equal(L({ source: "Реактивація закриті" }), "Реактивація закриті", "🔴 реактивації зведені в одне значення");

  const R = (k: string, source: string, ltv: number, deals: number, state: string | null): LtvRow & { source: string } =>
    ({ clientKey: k, ltv, deals, turnover: 0, firstDay: "2026-10-05", growth: 0, state, source });
  const rows = [R("a", "Холодная база", 500, 2, "active"), R("b", SOURCE_UNSET, 9000, 3, "sleeping"), R("c", "Реактивация звонком", 3000, 1, "active"),
    R("d", "Холодная база", 700, 1, null), R("e", "Реактивація закриті", 100, 2, "lost"), R("f", SOURCE_NO_LEAD, 50, 1, null)];
  const all = aggLtv(rows, "2026-10-01", "2026-10-31");
  const by = bySourceOf(rows, "2026-10-01", "2026-10-31");
  const sum = (f: (x: typeof by[number]) => number) => by.reduce((x, r) => x + f(r), 0);
  assert.deepEqual([sum((r) => r.clients), sum((r) => r.ltv), sum((r) => r.repeat), sum((r) => r.activeNow)], [all.clients, all.ltv, all.repeat, all.activeNow],
    "🔴 Σ «За джерелом» ≠ шапці (клієнти, LTV, постійні, працюють)");
  for (const g of ["rw", "rs", "ow", "os"] as const) assert.equal(sum((r) => r.mix[g]), all.mix[g], `🔴 склад «${g}» не сходиться`);
  assert.deepEqual(by.map((r) => r.source), ["Реактивация звонком", "Холодная база", "Реактивація закриті", SOURCE_UNSET, SOURCE_NO_LEAD],
    "🔴 порядок: більший LTV вище, невідомі внизу (навіть із найбільшим LTV)");
  assert.deepEqual(by.find((r) => r.source === "Холодная база")!.repeatPct, 50, "🔴 % повторних джерела не той");
  assert.deepEqual(by.map((r) => r.known), [true, true, true, false, false], "🔴 невідоме не позначене як невідоме");
});

/**
 * #8719b — ЖИВИЙ SQL ДЖЕРЕЛА: джерело береться з ліда, який лідген ПЕРЕДАВ (`pz_id`), а не з першої угоди менеджера
 * (`first_deal_id`), — у фікстурі в них різні джерела; тег LinkedIn на ліді з порожнім полем → LinkedIn; «AI тендер» → Prozorro;
 * ліда в базі немає → «лід не знайдено». «За джерелом» у відповіді блока: Σ = `totals` і для відділу, і для лідгена (межа та сама).
 * 🧨 Червоніє, якщо джойнити `first_deal_id`, писати свою перевірку LinkedIn за текстом поля або загубити рядок розкладу.
 */
test("#8719b ЖИВИЙ SQL ДЖЕРЕЛА: з ліда передачі (pz_id), не з першої угоди; мітки ядра; Σ «За джерелом» = totals", async (t) => {
  const l = await liveDb();
  if ("skip" in l) return t.skip(l.skip);
  const { c } = l;
  await c.query(`INSERT INTO managers (id, name, kommo_user_id, team_id, is_active) VALUES (8719, 'Лідген 8719', 87190, 50011, true) ON CONFLICT (id) DO NOTHING`);
  await c.query(`INSERT INTO deals (kommo_id, pipeline_id, status_id, client_source, tags) VALUES
    (871901, 8921936, 142, 'Холодная база', NULL), (871902, 8921932, 142, 'uts.ua', NULL),
    (871903, 8921936, 142, '', ARRAY['LinkedIn']), (871904, 8921936, 142, 'AI тендер', NULL), (871906, 8921936, 142, NULL, NULL)`);
  const ins = (k: string, pz: number, first: number) =>
    c.query(`INSERT INTO leadgen_ltv_clients (client_key, lg_manager_id, actor_kommo_user_id, pz_id, handoff_day, first_deal_id, first_day, deals, ltv, turnover)
             VALUES ($1, 8719, 87190, $2, '2026-10-01', $3, '2026-10-02', 2, 1000, 0)`, [k, pz, first]);
  await ins("s8719a", 871901, 871902);   // лід — «Холодная база», перша угода менеджера — «uts.ua»
  await ins("s8719b", 871903, 871902);   // тег LinkedIn, поле порожнє
  await ins("s8719c", 871904, 871902);   // «AI тендер»
  await ins("s8719d", 871905, 871902);   // ліда в базі немає
  await ins("s8719e", 871906, 871902);   // поле NULL
  const { leadgenLtvClients, leadgenLtvView } = await import("./leadgenLtv.js");
  const cl = await leadgenLtvClients({ kind: "all" }, 8719);
  const src = Object.fromEntries(cl.clients.map((x) => [x.clientKey, x.source]));
  assert.deepEqual(src, { s8719a: "Холодная база", s8719b: "LinkedIn", s8719c: "Prozorro", s8719d: SOURCE_NO_LEAD, s8719e: SOURCE_UNSET },
    "🔴 джерело не з ліда передачі або мітки не ядра");
  assert.deepEqual(cl.clients.filter((x) => !x.sourceKnown).map((x) => x.clientKey).sort(), ["s8719d", "s8719e"], "🔴 невідоме не позначене");
  for (const [scope, pick] of [[{ kind: "all" } as const, null], [{ kind: "own", managerId: 8719 } as const, null]] as const) {
    const v = await leadgenLtvView(scope, "2026-10-01", "2026-10-31", pick);
    const sum = (f: (x: typeof v.bySource[number]) => number) => v.bySource.reduce((a, r) => a + f(r), 0);
    assert.deepEqual([sum((r) => r.clients), sum((r) => r.ltv), sum((r) => r.repeat), sum((r) => r.activeNow)],
      [v.totals.clients, v.totals.ltv, v.totals.repeat, v.totals.activeNow], `🔴 ${scope.kind}: Σ «За джерелом» ≠ totals`);
    assert.ok(v.bySource.length > 0, `🔴 ${scope.kind}: розкладу немає`);
  }
  const own = await leadgenLtvView({ kind: "own", managerId: 8719 }, "2026-10-01", "2026-10-31", null);
  assert.equal(own.bySource.find((r) => r.source === "Холодная база")?.clients, 1, "🔴 лідген не бачить свого клієнта в розкладі");
  assert.ok(!own.bySource.some((r) => r.source === "uts.ua"), "🔴 у розклад потрапило джерело першої угоди менеджера");
});

/**
 * #8719c — ФРОНТ ДЖЕРЕЛА: колонка «Звідки прийшов» у спільній таблиці клієнтів (блок і вкладка «Клієнти LTV»), фільтр «Джерело»
 * в обох місцях, таблиця «За джерелом» з рядком «Разом» перед «По лідгенах». Підпис невідомого фронт НЕ пише сам — лише сервер.
 * 🧨 Червоніє, якщо прибрати колонку, фільтр чи таблицю або завести на фронті свою копію «не проставлене».
 */
test("#8719c ФРОНТ ДЖЕРЕЛА: колонка, фільтр у блоці й «Клієнтах LTV», таблиця «За джерелом»; підпис невідомого — з сервера", () => {
  const blk = FSRC("pages/dashboard/sections/LeadgenLtvBlock.tsx");
  assert.match(blk, /<th style=\{th\}>Звідки прийшов<\/th>/, "🔴 у таблиці клієнтів немає колонки «Звідки прийшов»");
  assert.match(blk, /\{c\.source\}<\/td>/, "🔴 колонка не показує джерело клієнта");
  assert.match(blk, /<SourcePick rows=\{base\}/, "🔴 немає фільтра «Джерело» у списку клієнтів лідгена");
  const st = blk.indexOf("<SourceTable rows={d.bySource}"), lg = blk.indexOf("По лідгенах");
  assert.ok(st > 0 && st < lg, "🔴 таблиця «За джерелом» не перед «По лідгенах»");
  assert.match(blk, /line\("total", "Разом", total/, "🔴 у таблиці «За джерелом» немає рядка «Разом»");
  const cd = FSRC("pages/dashboard/sections/LeadgenCountedDeals.tsx");
  assert.match(cd, /<SourcePick rows=\{ltv\.clients\}/, "🔴 немає фільтра «Джерело» у вкладці «Клієнти LTV»");
  for (const [f, src] of [["LeadgenLtvBlock.tsx", blk], ["LeadgenCountedDeals.tsx", cd]] as const)
    assert.ok(!/не проставлен/.test(src), `🔴 ${f}: своя копія підпису невідомого джерела (має йти з сервера)`);
});
