import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  addMonths, inReact, cycleMonthOf, statusOf, transferMonday, autoDue, autoReason, allowedDecisions,
  planSweep, poolAccess, daysLeft, LAUNCH_MONTH, LAUNCH_RELEASE, WEEKLY_CAP, weekMonday, mondayOnOrAfter,
  transferWindowOpen, type CycleRow, type Candidate,
} from "./reactCycleRules.js";
import { clientTabGroup, tabOf, TAB_GROUP_RANK, YELLOW_DAYS } from "./clientTabs.js";
import { skipReason } from "../db/scratchDb.js";

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SECTIONS = "frontend/src/pages/dashboard/sections";
/** Код без коментарів — щоб гейт не зеленів від слова в поясненні. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * 🔁 #840–#848 — ТЗ Юлі 22.09.2026, блок 4 «Реактивація і лідгени» (задача 4313, 30.09.2026).
 * Рішення Романа 30.09: «сам» — зі строком (з 01.10 — 4 тижні від натискання, `#1211`); у пул — усі без рахунку;
 * гроші — за угодою в Kommo (тут не рахуються). З 01.10.2026 передача щотижня — `#1210`–`#1215`.
 */

const row = (p: Partial<CycleRow> & { cycleMonth: string }): CycleRow => ({
  decision: null, decidedDate: null, pooled: false, poolReason: null, closed: false, closeReason: null, ...p,
});

test("#840 3 ПОВНІ МІСЯЦІ БЕЗ РАХУНКУ: межа по обидва боки, вкладка за рахунком, а не за днями оплати", () => {
  // Травень → червень-серпень без рахунку → вересень уже реактивація; у серпні ще ні.
  assert.equal(inReact("2026-05-31", "2026-09"), true, "🔴 рахунок у травні, а вересень не реактивація");
  assert.equal(inReact("2026-05-31", "2026-08"), false, "🔴 серпень — лише 2 повні місяці без рахунку");
  // Червень → жовтень, а не вересень: межа — календарний місяць, не 90 днів.
  assert.equal(inReact("2026-06-01", "2026-09"), false, "🔴 1 червня + вересень — це лише 2 повні місяці (липень, серпень)");
  assert.equal(inReact("2026-06-30", "2026-10"), true);
  // Рахунок у поточному місяці повертає одразу.
  assert.equal(inReact("2026-09-02", "2026-09"), false, "🔴 рахунок цього місяця не повернув клієнта");
  assert.equal(inReact(null, "2026-09"), true, "🔴 клієнт без жодного рахунку не в реактивації");
  // Перехід року й 31-ше число: анкер на 1-ше, місяць не перескакує (борг 19).
  assert.equal(addMonths("2026-10", 4), "2027-02");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(inReact("2026-11-30", "2027-03"), true);
  assert.equal(inReact("2026-11-30", "2027-02"), false);
  // Вкладка — за прапорцем рахунку; «жовтий» лишився по днях від замовлення.
  assert.equal(clientTabGroup(true, 5), "react", "🔴 3 місяці без рахунку, але свіжа оплата сховала клієнта з реактивації");
  assert.equal(clientTabGroup(false, 400), "yellow", "🔴 рахунок є, а клієнт у реактивації за старим правилом днів");
  assert.equal(clientTabGroup(false, YELLOW_DAYS - 1), "regular");
  assert.equal(clientTabGroup(false, YELLOW_DAYS), "yellow");
  assert.equal(clientTabGroup(false, null), "regular");
  assert.equal(tabOf("yellow"), "regular");
  assert.equal(tabOf("react"), "react");
  assert.ok(TAB_GROUP_RANK.regular < TAB_GROUP_RANK.yellow && TAB_GROUP_RANK.yellow < TAB_GROUP_RANK.react);
});

test("#840c ФРОНТ НЕ МАЄ ВЛАСНОГО ПРАВИЛА ВКЛАДОК: фільтр, порядок і жовтий фон — з поля сервера; група — від рахунку", () => {
  const list = read(`${SECTIONS}/ClientPlansSection.tsx`);
  assert.match(list, /tab === "regular" && c\.tabGroup === "react"\) return false/, "🔴 вкладка «Постійні» фільтрує не за групою сервера");
  assert.match(list, /tab === "react" && c\.tabGroup !== "react"\) return false/, "🔴 вкладка «Реактивація» фільтрує не за групою сервера");
  assert.match(list, /data\.tabGroupRank\[a\.tabGroup\] - data\.tabGroupRank\[b\.tabGroup\]/, "🔴 порядок «Всі» не з рангів сервера");
  assert.match(list, /const risk = c\.tabGroup === "yellow";/, "🔴 жовтий фон рядка рахується не тією групою, що вкладки");
  assert.doesNotMatch(list, /const risk = [^;]*lastOrderDays/, "🔴 у фронті знову власний поріг «жовтого» — друга редакція правила");
  assert.doesNotMatch(list, /stateFilter/, "🔴 повернувся ряд «Стан:» поруч із вкладками — дві осі на одне питання");
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  assert.match(dash, /tabGroup: clientTabs\.clientTabGroup\(inReactNow\(c\.client_key\), dayOf\(c\.last_paid\)\)/,
    "🔴 група вкладки /client-plans рахується не від рахунку (п.4.1) — або знову від стану за днями оплати");
  assert.match(dash, /const inReactNow = \(key: string\) => reactCycleRules\.inReact\(lastInvByKey\.get\(key\) \?\? null, nowYm\);/,
    "🔴 «у реактивації» рахується не правилом ядра від дати останнього рахунку");
  assert.match(dash, /money\.lastInvoiceByClientKey\(clientKeys\)/, "🔴 дата останнього рахунку не з ядра грошей — розійдеться з фактом «з рахунку»");
  assert.match(dash, /tabGroupRank: clientTabs\.TAB_GROUP_RANK,/, "🔴 ранги груп не приходять із сервера");
  assert.match(dash, /inWork: clients\.filter\(\(c\) => c\.tabGroup === "react"\)\.length,/,
    "🔴 «у роботі» зверху рахує не ту множину, що вкладка «Реактивація»");
});

test("#845 ПУЛ: бачать лідгени й керівництво, бере лише лідген; менеджер — ні (дзеркало в обидва боки)", () => {
  assert.deepEqual(poolAccess(true, false), { canSee: true, canTake: true }, "🔴 лідген не бачить або не бере");
  assert.deepEqual(poolAccess(false, true), { canSee: true, canTake: false }, "🔴 керівництво не бачить пул або бере без менеджерського акаунта");
  assert.deepEqual(poolAccess(false, false), { canSee: false, canTake: false }, "🔴 звичайний менеджер бачить пул (4.4)");
  assert.deepEqual(poolAccess(true, true), { canSee: true, canTake: true });
});

test("#845b РОУТИ ЦИКЛУ: межа — першим оператором, матриця й вкладка; пул звіряє рахунки перед показом і взяттям", () => {
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const body = (sig: string) => {
    const s = dash.indexOf(sig);
    assert.ok(s > 0, `🔴 обробник ${sig} не знайдено`);
    return dash.slice(s, dash.indexOf("\ndashboardRouter.", s + 10));
  };
  const dec = body('dashboardRouter.post("/react-decision"');
  assert.match(dec, /^[^\n]*\n\s*const auth = req\.auth!;\n\s*const clientKey = [^\n]*\n\s*if \(!clientKey \|\| !\(await canSeeClient\(auth, clientKey\)\)\) return res\.status\(403\)/,
    "🔴 /react-decision: межа не першим оператором — тіло валідовано до гейта (400 замість 403 ламає зліпок #11)");
  const list = body('dashboardRouter.get("/leadgen-pool"');
  assert.match(list, /const access = await leadgenPoolAccess\(auth\);\n\s*if \(!access\.canSee\) return res\.status\(403\)/, "🔴 пул віддається без межі");
  assert.match(list, /reactCycleRules\.inReact\(/, "🔴 пул показує клієнтів, не звіривши рахунки (4.4)");
  const take = body('dashboardRouter.post("/leadgen-pool/take"');
  assert.match(take, /const access = await leadgenPoolAccess\(auth\);\n\s*if \(!access\.canTake\) return res\.status\(403\)/, "🔴 брати може не лише лідген");
  assert.ok(take.indexOf("reactCycleRules.inReact(") < take.indexOf('client.query("BEGIN")'),
    "🔴 перевірка «ожив» не ДО транзакції — ROLLBACK відкотить закриття рядка пулу");
  assert.match(take, /reactCycle\.take\(client,/, "🔴 взяття не в транзакції");
  const matrix = read("backend/src/auth/accessMatrix.ts");
  for (const p of ["/api/dashboard/react-decision", "/api/dashboard/leadgen-pool", "/api/dashboard/leadgen-pool/take"]) {
    assert.match(matrix, new RegExp(`path: "${p.replace(/\//g, "\\/")}"`), `🔴 ${p} немає в матриці доступу`);
  }
  const rt = read("backend/src/auth/routeTab.ts");
  assert.match(rt, /pre\("\/api\/dashboard\/react-decision"\), tabs: \["loyalty"\]/);
  assert.match(rt, /pre\("\/api\/dashboard\/leadgen-pool"\), tabs: \["loyalty"\]/);
});

test("#846b НІЧНИЙ ПРОХІД ПІД НАГЛЯДОМ: щодоби за Києвом, нагляд чекає 1440 хв, є стартовий прогін", async () => {
  const idx = codeOnly(read("backend/src/index.ts"));
  assert.match(idx, /cron\.schedule\("40 0 \* \* \*", \(\) => \{\n\s*void runJob\("reactCycleSweep", \(\) => runReactCycleSweep\(\)\);\n\}, \{ timezone: "Europe\/Kyiv" \}\);/,
    "🔴 нічний прохід не щодоби о 00:40 за Києвом — автопередача зсунеться або не станеться");
  assert.match(idx, /\["reactCycleSweep", \(\) => runReactCycleSweep\(\)\]/, "🔴 немає стартового прогону — рестарт у ніч передачі зсуне її на добу");
  const { MONITORED_JOBS } = await import("../jobs/monitoredJobs.js");
  assert.equal(MONITORED_JOBS.find((j) => j.name === "reactCycleSweep")?.everyMin, 1440, "🔴 мовчання нічного проходу ніхто не побачить");
});

test("#848 ФРОНТ НЕ МАЄ ВЛАСНОГО ПРАВИЛА ЦИКЛУ: кнопки з `allowed`, строк і стан — із сервера; пул — за `leadgenPool.canSee`", () => {
  const bits = codeOnly(read(`${SECTIONS}/ReactivationCycle.tsx`));
  assert.match(bits, /cycle\.allowed\.includes\("self"\) &&/, "🔴 «Реактивую сам» малюється не за дозволом сервера");
  assert.match(bits, /cycle\.allowed\.includes\("leadgen"\) &&/, "🔴 «Передати лідгенам» малюється не за дозволом сервера");
  assert.match(bits, /if \(!cycle\.allowed\.length\) return null;/);
  assert.doesNotMatch(bits, /QUIET_MONTHS|addMonths|getUTCMonth\(\) \+ 3|\+ 4\b/, "🔴 фронт рахує межу місяців сам");
  const list = codeOnly(read(`${SECTIONS}/ClientPlansSection.tsx`));
  assert.match(list, /\{c\.reactCycle && \(/, "🔴 у рядку реактивації немає стану й кнопок циклу");
  assert.match(list, /<ReactCycleButtons clientKey=\{c\.clientKey\} cycle=\{c\.reactCycle\}/);
  assert.match(list, /\{data\.leadgenPool\?\.canSee && \(/, "🔴 вкладка пулу показується не за рішенням сервера");
  assert.match(list, /tab === "pool" \? <LeadgenPoolPanel/, "🔴 вкладка пулу нічого не показує");
  assert.match(list, /c\.reactCycle\?\.status !== cycleSub/, "🔴 фільтр «Рішення» не за станом із сервера");
  const card = codeOnly(read(`${SECTIONS}/ClientCardPanel.tsx`));
  assert.match(card, /\{card\.reactCycle && \(/, "🔴 у картці немає циклу реактивації");
  assert.match(card, /<ReactCycleButtons clientKey=\{card\.clientKey\} cycle=\{card\.reactCycle\}/);
  // Помилка кнопки видима (борг 15): відмова сервера не летить у порожнечу.
  assert.match(bits, /onError\(r\?\.data\?\.error \?\?/, "🔴 відмова сервера на кнопці циклу мовчить");
});

// ───────────── ЩОТИЖНЯ ЗАМІСТЬ РАЗ НА МІСЯЦЬ (рішення Романа 01.10.2026, підтвердила Юля) ─────────────

const cand = (k: string, lastInvoice: string | null, debtHold = false): Candidate => ({ clientKey: k, lastInvoice, managerId: 10, debtHold });

/**
 * #1210 — 4 ТИЖНІ НА РІШЕННЯ ВІД ВХОДУ, ПЕРЕДАЧА В НАЙБЛИЖЧИЙ ПОНЕДІЛОК. Рахунок у липні → вхід 01.11 →
 * 4 тижні до 28.11 → передача пн 30.11. Пул, взятий, боржник і живий не чіпаються; ожилий закривається.
 * 🧨 Червоніє, якщо повернути «кінець місяця» або передати на день раніше.
 */
test("#1210 СТРОК РІШЕННЯ: 4 тижні від входу → найближчий понеділок; пул, взятий, боржник, живий — не чіпаються; ожилий закривається", () => {
  const cm = "2026-11";
  const inv = "2026-07-10";
  assert.equal(cycleMonthOf(inv), cm);
  assert.equal(transferMonday(cm, null), "2026-11-30", "🔴 вхід 01.11 + 4 тижні → не понеділок 30.11");
  assert.equal(autoDue(cm, null, "2026-11-29"), false, "🔴 передача раніше, ніж минуло 4 тижні");
  assert.equal(autoDue(cm, null, "2026-11-30"), true, "🔴 4 тижні минули без дії, а клієнт не до передачі");
  // Вхід у понеділок: 4 тижні закінчуються в неділю, передача — у наступний понеділок, рівно через 28 днів.
  assert.equal(transferMonday("2027-02", null), "2027-03-01", "🔴 вхід у понеділок 01.02.2027 — передача не через 4 тижні");
  assert.equal(autoReason(null), "auto");
  const rows = new Map<string, CycleRow[]>([
    ["pooled", [row({ cycleMonth: cm, decision: "leadgen", pooled: true, poolReason: "manager" })]],
    ["taken", [row({ cycleMonth: cm, pooled: true, poolReason: "auto", closed: true, closeReason: "taken" })]],
  ]);
  const a = planSweep(
    [cand("silent", inv), cand("pooled", inv), cand("taken", inv), cand("debtor", inv, true), cand("alive", "2026-11-20")],
    rows, [{ clientKey: "revived", cycleMonth: "2026-10", lastInvoice: "2026-11-27" },
           { clientKey: "stillquiet", cycleMonth: "2026-10", lastInvoice: "2026-05-01" }], "2026-11-30");
  assert.deepEqual(a.pool.map((p) => `${p.clientKey}:${p.reason}:${p.fromManagerId}`), ["silent:auto:10"],
    "🔴 у пул пішов не рівно «мовчазний»: пул/взятий/боржник/живий мають лишитись");
  assert.deepEqual(a.close.map((c) => c.clientKey), ["revived"], "🔴 ожилий (рахунок у листопаді) лишився в пулі або закрито ще тихого");
});

/**
 * #1210b — ХВІСТ ЖОВТНЯ: хто вже був у реактивації (цикл `LAUNCH_MONTH`), до передачі з пн 05.10.2026,
 * а не через 4 тижні (рішення Романа 01.10: «з 05.10»). Раніше — нікого.
 * 🧨 Червоніє, якщо віддати 04.10 або чекати 02.11.
 */
test("#1210b ХВІСТ ЖОВТНЯ: до передачі з понеділка 05.10.2026 — не раніше й не пізніше", () => {
  assert.equal(LAUNCH_MONTH, "2026-10");
  assert.equal(LAUNCH_RELEASE, "2026-10-05");
  assert.equal(cycleMonthOf("2025-01-15"), "2026-10", "🔴 цикл пішов від історії — давні клієнти не в хвості");
  assert.equal(transferMonday("2026-10", null), "2026-10-05");
  const old = [cand("old", "2025-01-15")];
  for (const d of ["2026-10-01", "2026-10-04"]) {
    assert.deepEqual(planSweep(old, new Map(), [], d).pool, [], `🔴 ${d}: хвіст пішов раніше за 05.10`);
  }
  assert.equal(planSweep(old, new Map(), [], "2026-10-05").pool.length, 1, "🔴 05.10 хвіст не пішов — чекає 02.11, як у місячному правилі");
});

/**
 * #1211 — «РЕАКТИВУЮ САМ»: 4 тижні від натискання, далі найближчий понеділок; один раз за цикл.
 * 🧨 Червоніє, якщо рахувати від кінця місяця або дозволити натиснути вдруге.
 */
test("#1211 «РЕАКТИВУЮ САМ»: 4 тижні від натискання → понеділок; один раз; у пулі видно «минув строк»", () => {
  const cm = "2026-10";
  const self = row({ cycleMonth: cm, decision: "self", decidedDate: "2026-10-01" });
  assert.equal(statusOf(self), "self");
  assert.equal(transferMonday(cm, self), "2026-11-02", "🔴 натиснули 01.10 → +4 тижні 29.10 → передача не в пн 02.11");
  assert.equal(autoDue(cm, self, "2026-11-01"), false, "🔴 «сам» натиснули — а клієнт пішов, не дочекавшись 4 тижнів");
  assert.equal(autoDue(cm, self, "2026-11-02"), true, "🔴 4 тижні «сам» минули без рахунку — клієнт мав піти");
  assert.equal(autoReason(self), "self_expired", "🔴 у пулі не видно, що менеджер не встиг за власним строком");
  // Натиснули в понеділок → рівно через 4 тижні, теж у понеділок.
  assert.equal(transferMonday(cm, row({ cycleMonth: cm, decision: "self", decidedDate: "2026-10-26" })), "2026-11-23");
  assert.deepEqual(allowedDecisions(null), ["self", "leadgen"]);
  assert.deepEqual(allowedDecisions(self), ["leadgen"], "🔴 «сам» можна натиснути вдруге — строк продовжується без кінця");
  assert.deepEqual(allowedDecisions(row({ cycleMonth: cm, pooled: true, poolReason: "manager", decision: "leadgen" })), []);
  assert.equal(daysLeft("2026-10-05", "2026-10-01"), 4);
  assert.equal(daysLeft("2026-10-05", "2026-10-07"), 0, "🔴 у черзі — від'ємні дні на екрані");
});

/**
 * #1212 — ЧЕРГА І МЕЖА: за тиждень не більше `WEEKLY_CAP`; першими — з найсвіжішим рахунком; уже передане
 * цього тижня зменшує місце; передача закрита — нікого, але ожилі однаково закриваються.
 * 🧨 Червоніє, якщо прибрати межу, порядок або облік уже переданого.
 */
test("#1212 ЧЕРГА: ≤100 за тиждень, від найсвіжішого рахунку; передане цього тижня рахується; закрита передача — лише закриття", () => {
  assert.equal(WEEKLY_CAP, 100);
  // 150 клієнтів хвоста з різними датами рахунку (2025-01-01 + i днів), перемішані.
  const many = Array.from({ length: 150 }, (_, i) => cand(`k${String(i).padStart(3, "0")}`, `2025-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`));
  const shuffled = [...many].sort((a, b) => (a.clientKey.charCodeAt(3) * 7 % 11) - (b.clientKey.charCodeAt(3) * 7 % 11) || b.clientKey.localeCompare(a.clientKey));
  const a = planSweep(shuffled, new Map(), [], "2026-10-05");
  assert.equal(a.pool.length, 100, "🔴 за тиждень пішло не 100");
  assert.equal(a.deferred, 50);
  const freshest = [...many].sort((x, y) => (y.lastInvoice ?? "").localeCompare(x.lastInvoice ?? "")).slice(0, 100).map((c) => c.clientKey).sort();
  assert.deepEqual(a.pool.map((p) => p.clientKey).sort(), freshest, "🔴 першими пішли не клієнти з найсвіжішим рахунком");
  // Без рахунку взагалі — в кінці черги.
  const withNull = planSweep([cand("none", null), cand("fresh", "2025-12-01")], new Map(), [], "2026-10-05",
    { transfer: true, pooledThisWeek: 99 });
  assert.deepEqual(withNull.pool.map((p) => p.clientKey), ["fresh"], "🔴 клієнт без рахунку випередив того, хто замовляв");
  assert.equal(planSweep(shuffled, new Map(), [], "2026-10-05", { transfer: true, pooledThisWeek: 60 }).pool.length, 40,
    "🔴 уже передане цього тижня не зменшило місце — рестарт віддасть понад 100");
  assert.equal(planSweep(shuffled, new Map(), [], "2026-10-05", { transfer: true, pooledThisWeek: 100 }).pool.length, 0);
  const closedOnly = planSweep(shuffled, new Map(), [{ clientKey: "revived", cycleMonth: "2026-10", lastInvoice: "2026-10-02" }], "2026-10-05",
    { transfer: false, pooledThisWeek: 0 });
  assert.deepEqual(closedOnly.pool, [], "🔴 передача закрита, а клієнти пішли в пул");
  assert.deepEqual(closedOnly.close.map((c) => c.clientKey), ["revived"], "🔴 закриття ожилих залежить від дня тижня");
});

/**
 * #1212b — ВІКНО ПЕРЕДАЧІ: у понеділок лише з 08:00 за Києвом; решта тижня відкрита (добір пропущеного понеділка);
 * понеділки рахуються правильно й через межу року.
 * 🧨 Червоніє, якщо віддавати в понеділок уночі або закрити добір.
 */
test("#1212b ВІКНО: понеділок — з 08:00; вівторок–неділя — добір; понеділки через межу року", () => {
  assert.equal(transferWindowOpen("2026-10-05", 0), false, "🔴 нічний прогін понеділка віддав клієнтів до 08:00");
  assert.equal(transferWindowOpen("2026-10-05", 7), false);
  assert.equal(transferWindowOpen("2026-10-05", 8), true, "🔴 о 08:00 понеділка передача закрита");
  assert.equal(transferWindowOpen("2026-10-06", 0), true, "🔴 пропущений понеділок ніхто не добере");
  assert.equal(transferWindowOpen("2026-10-11", 23), true);
  assert.equal(weekMonday("2026-10-11"), "2026-10-05", "🔴 неділя віднесена не до свого тижня");
  assert.equal(weekMonday("2027-01-01"), "2026-12-28");
  assert.equal(mondayOnOrAfter("2026-12-29"), "2027-01-04");
  assert.equal(mondayOnOrAfter("2026-10-05"), "2026-10-05");
});

/**
 * #1214 — РОЗКЛАД: передача щопонеділка о 08:00 за Києвом окремим запуском; нічний прогін і старт лишаються;
 * джоба передає в правило вікно передачі й уже передане цього тижня.
 * 🧨 Червоніє, якщо прибрати понеділковий запуск або не рахувати передане цього тижня.
 */
test("#1214 РОЗКЛАД: пн 08:00 за Києвом + нічний прогін; джоба рахує вікно й передане за тиждень", () => {
  const idx = codeOnly(read("backend/src/index.ts"));
  assert.match(idx, /cron\.schedule\("0 8 \* \* 1", \(\) => \{\n\s*void runJob\("reactCycleSweep", \(\) => runReactCycleSweep\(\)\);\n\}, \{ timezone: "Europe\/Kyiv" \}\);/,
    "🔴 немає запуску щопонеділка о 08:00 за Києвом — передача станеться лише вночі вівторка");
  const job = codeOnly(read("backend/src/jobs/reactCycleSweep.ts"));
  assert.match(job, /const transfer = transferWindowOpen\(today, kyivHour\(\)\);/, "🔴 джоба не питає, чи відкрита передача");
  assert.match(job, /await autoPooledSince\(pool, weekMonday\(today\)\)/, "🔴 джоба не рахує вже передане цього тижня — рестарт віддасть понад 100");
  assert.match(job, /today, \{ transfer, pooledThisWeek \}\);/, "🔴 вікно й передане не дійшли до правила");
});

/**
 * #1215 — ФРОНТ НЕ РАХУЄ СТРОК САМ: понеділок приходить із сервера; «з», бо черга може відсунути; пояснення
 * над вкладкою — з констант ядра, без «до кінця місяця» й «01.11».
 * 🧨 Червоніє, якщо повернути `lastDay`/«кінець місяця» у фронт або зашити числа в текст.
 */
test("#1215 ФРОНТ: строк — понеділок із сервера («з пн DD.MM»), пояснення — з констант ядра", () => {
  const bits = codeOnly(read(`${SECTIONS}/ReactivationCycle.tsx`));
  assert.match(bits, /const dl = cycle\.deadline;/, "🔴 фронт перетворює строк сам");
  assert.doesNotMatch(bits, /lastDay|Date\.UTC\(/, "🔴 у фронті знову «останній день місяця»");
  assert.match(bits, /передача лідгенам з <b>пн \{ddmm\(dl\)\}<\/b>/, "🔴 на екрані не «з понеділка»");
  assert.doesNotMatch(read(`${SECTIONS}/ReactivationCycle.tsx`), /до кінця наступного місяця/, "🔴 кнопка обіцяє місячний строк");
  const list = codeOnly(read(`${SECTIONS}/ClientPlansSection.tsx`));
  for (const k of ["decisionDays", "selfGraceDays", "weeklyCap", "launchRelease", "transferHour"]) {
    assert.match(list, new RegExp(`data\\.reactRules\\.${k}`), `🔴 пояснення над вкладкою не бере ${k} із сервера`);
  }
  assert.doesNotMatch(list, /перша автопередача 01\.11\.2026|до кінця\s+місяця клієнт іде/, "🔴 над вкладкою лишився місячний текст");
});

// ─────────────────────────────── ЖИВИЙ SQL ───────────────────────────────

async function scratchDb(t: import("node:test").TestContext) {
  const { provisionScratch } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) { t.skip(skipReason(scratch)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  await c.query(readFileSync(path.join(ROOT, "backend/src/db/schema.sql"), "utf8"));
  await c.query(`INSERT INTO teams (id,name) VALUES (1,'РПК'),(50011,'Лідогенерація') ON CONFLICT (id) DO NOTHING`);
  await c.query(`INSERT INTO managers (id,name,team_id,is_active) VALUES (10,'Менеджер',1,true),(31,'Лідген А',50011,true),(32,'Лідген Б',50011,true)
                 ON CONFLICT (id) DO NOTHING`);
  await c.query(`INSERT INTO users (id,email,password_hash,role,manager_id) VALUES (1,'m@x','x','manager',10),(2,'a@x','x','manager',31),(3,'b@x','x','manager',32)`);
  return { c, scratch, done: async () => { await c.end(); scratch.dispose(); } };
}

/**
 * #843 — останній рахунок за КИЄВОМ (той самий анкер, що факт «з рахунку»), рішення по циклу в БД.
 * ⚠️ `DATABASE_URL` ставиться ДО імпорту ядра: пул — модульний синглтон, і в цьому файлі його бере лише цей тест.
 */
test("#843 ЖИВИЙ SQL: останній рахунок за Києвом; «сам» один раз, «лідгенам» після «сам»; клієнт із рахунком — 409", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  process.env.DATABASE_URL = s.scratch.url;
  process.env.JWT_SECRET ??= "test";
  process.env.KOMMO_BASE_URL ??= "https://x.invalid";
  process.env.KOMMO_API_TOKEN ??= "x";
  try {
    const deal = (id: number, ck: string, status: number, closed: string | null) => c.query(
      `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw,client_name,closed_at_kommo,created_at_kommo)
       VALUES ($1,'d',10,8921932,$2,1000,$3,$3,$3,$4,'2026-01-01')`, [id, status, ck, closed]);
    const ev = (id: number, status: number, at: string) => c.query(
      `INSERT INTO deal_stage_events (kommo_id,status_id,pipeline_id,changed_at) VALUES ($1,$2,8921932,$3)`, [id, status, at]);
    // «межа»: рахунок 31.05 о 21:30 UTC = 01.06 00:30 за Києвом → останній рахунок ЧЕРВЕНЬ, не травень.
    await deal(1, "межа", 69716312, null); await ev(1, 100274340, "2026-05-31T21:30:00Z");
    // «тихий»: рахунок у квітні + програна угода з рахунком у серпні (програна не рахується).
    await deal(2, "тихий", 142, "2026-04-20T09:00:00Z"); await ev(2, 100274340, "2026-04-10T09:00:00Z");
    await deal(3, "тихий", 143, "2026-08-20T09:00:00Z"); await ev(3, 100274340, "2026-08-10T09:00:00Z");
    // «живий»: рахунок у серпні.
    await deal(4, "живий", 69716300, null); await ev(4, 100274340, "2026-08-05T09:00:00Z");

    const M = await import("./money.js");
    const inv = await M.lastInvoiceByClientKey(["межа", "тихий", "живий", "нема"]);
    assert.equal(inv.get("межа"), "2026-06-01", "🔴 дата рахунку не за Києвом — 31.05 21:30 UTC це вже червень");
    assert.equal(inv.get("тихий"), "2026-04-10", "🔴 програна угода зсунула останній рахунок");
    assert.equal(inv.get("живий"), "2026-08-05");
    assert.equal(inv.has("нема"), false);
    assert.equal(inReact(inv.get("межа")!, "2026-09"), false, "🔴 червневий рахунок уже реактивація у вересні");

    const R = await import("./reactCycle.js");
    const base = { userId: 1, managerId: 10, nowYm: "2026-09" };
    await assert.rejects(R.decide(c, { ...base, clientKey: "живий", decision: "self", lastInvoice: inv.get("живий")! }),
      /рахунок за останні 3 місяці/, "🔴 рішення прийнято по клієнту з рахунком за 3 місяці");
    const r1 = await R.decide(c, { ...base, clientKey: "тихий", decision: "self", lastInvoice: inv.get("тихий")! });
    assert.equal(r1.cycleMonth, "2026-10", "🔴 цикл давнього клієнта не з LAUNCH_MONTH");
    await assert.rejects(R.decide(c, { ...base, clientKey: "тихий", decision: "self", lastInvoice: inv.get("тихий")! }),
      /строк не продовжується/, "🔴 «сам» натиснули вдруге — і строк продовжився");
    const r2 = await R.decide(c, { ...base, clientKey: "тихий", decision: "leadgen", lastInvoice: inv.get("тихий")! });
    assert.equal(r2.status, "pool");
    const cyc = (await R.cyclesFor(c, ["тихий"])).get("тихий")!;
    assert.equal(cyc.length, 1, "🔴 «лідгенам» після «сам» створило другий рядок циклу");
    assert.equal(statusOf(cyc[0]), "pool");
    assert.equal(cyc[0].poolReason, "manager");
    await assert.rejects(R.decide(c, { ...base, clientKey: "тихий", decision: "leadgen", lastInvoice: inv.get("тихий")! }), /пулі/);
  } finally {
    const { pool } = await import("../db/pool.js").catch(() => ({ pool: null as null | { end: () => Promise<void> } }));
    await pool?.end().catch(() => {});
    await s.done();
  }
});

test("#844 ЖИВИЙ SQL: двоє лідгенів беруть одночасно — рівно один; закріплення з поточного місяця й історія лягли", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  const { default: pg } = await import("pg");
  const c2 = new pg.Client({ connectionString: s.scratch.url });
  await c2.connect();
  try {
    const R = await import("./reactCycle.js");
    assert.equal(await R.poolAuto(c, [{ clientKey: "клієнт", cycleMonth: "2026-10", reason: "auto", fromManagerId: 10 }]), 1);
    const args = (mgr: number, user: number) => ({ clientKey: "клієнт", managerId: mgr, userId: user, lastInvoice: "2025-01-01",
      nowYm: "2026-11", effectiveFrom: "2026-11-01" });
    await c.query("BEGIN"); await c2.query("BEGIN");
    // Дві транзакції одночасно: друга чекає на замок рядка першої. Хто закінчив першим — комітить,
    // і лише тоді друга бачить закритий рядок (інакше тест сам себе заблокував би).
    type Out = { cl: typeof c; mgr: number; err?: Error };
    const run = (cl: typeof c, mgr: number, user: number): Promise<Out> =>
      R.take(cl, args(mgr, user)).then(() => ({ cl, mgr }), (err: Error) => ({ cl, mgr, err }));
    const pa = run(c, 31, 2), pb = run(c2, 32, 3);
    const first = await Promise.race([pa, pb]);
    await first.cl.query(first.err ? "ROLLBACK" : "COMMIT");
    const second = await (first.cl === c ? pb : pa);
    await second.cl.query(second.err ? "ROLLBACK" : "COMMIT");
    const ok = [first, second].filter((x) => !x.err).length;
    assert.equal(ok, 1, `🔴 клієнта взяли ${ok} лідгени — атомарність взяття зламана`);
    const lost = [first, second].find((x) => x.err)!;
    assert.match(String(lost.err?.message), /вже взяли/);
    const winner = [first, second].find((x) => !x.err)!.mgr;
    const lo = (await c.query<{ pinned_manager_id: number; m: string }>(
      `SELECT pinned_manager_id, to_char(pinned_from_month,'YYYY-MM-DD') AS m FROM loyalty_overrides WHERE client_key='клієнт'`)).rows[0];
    assert.equal(lo.pinned_manager_id, winner, "🔴 клієнт закріплений не за тим, хто взяв");
    assert.equal(lo.m, "2026-11-01", "🔴 закріплення не з поточного місяця");
    const h = (await c.query<{ to_manager_id: number; kind: string }>(`SELECT to_manager_id, kind FROM client_manager_history WHERE client_key='клієнт'`)).rows;
    assert.deepEqual(h, [{ to_manager_id: winner, kind: "fix" }], "🔴 історія передачі не записана або записана двічі");
    assert.deepEqual(await R.openPool(c), [], "🔴 взятий клієнт лишився в пулі");
  } finally {
    await c2.end().catch(() => {});
    await s.done();
  }
});

test("#846 ЖИВИЙ SQL: нічний прохід двічі — другий нічого не змінює; у пулі клієнт один раз; ожилий закривається раз", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    const R = await import("./reactCycle.js");
    const items = [{ clientKey: "x", cycleMonth: "2026-10", reason: "auto" as const, fromManagerId: 10 }];
    assert.equal(await R.poolAuto(c, items), 1);
    assert.equal(await R.poolAuto(c, items), 0, "🔴 повторний прохід переписав рядок пулу");
    // Той самий клієнт іншим циклом — унікальний індекс не дає другого відкритого рядка.
    assert.equal(await R.poolAuto(c, [{ ...items[0], cycleMonth: "2026-11" }]), 0, "🔴 клієнт у пулі двічі");
    assert.equal((await R.openPool(c)).length, 1);
    assert.equal(await R.closeRevived(c, [{ clientKey: "x", cycleMonth: "2026-10" }]), 1);
    assert.equal(await R.closeRevived(c, [{ clientKey: "x", cycleMonth: "2026-10" }]), 0, "🔴 закриття не ідемпотентне");
    const r = (await c.query<{ close_reason: string }>(`SELECT close_reason FROM client_react_cycles WHERE client_key='x'`)).rows;
    assert.deepEqual(r, [{ close_reason: "invoice" }]);
    // CHECK тримає пару «в пулі ⇔ причина»: пул без причини не записати.
    await assert.rejects(c.query(`INSERT INTO client_react_cycles (client_key, cycle_month, pooled_at) VALUES ('y','2026-10-01', now())`),
      /client_react_cycles_pool/, "🔴 пул без причини записався — у пулі не буде видно, звідки клієнт");
  } finally {
    await s.done();
  }
});

test("#848b МІСТОК «ЩЕ N У РЕАКТИВАЦІЇ» == ЛІЧИЛЬНИК ВКЛАДКИ: одне число на екрані, а не стан поруч із рахунком", () => {
  // Спіймано оком на проді 30.09.2026 після викату c0921c7: місток «677» (сплячі+втрачені) поруч із вкладкою «501».
  const list = codeOnly(read(`${SECTIONS}/ClientPlansSection.tsx`));
  assert.match(list, /🌉 Ще <b>\{tabCounts\.react\}<\/b> постійних зараз у <b>реактивації<\/b>/,
    "🔴 місток рахує реактивацію не тим числом, що вкладка — два джерела одного показника на екрані");
  assert.doesNotMatch(list, /Ще <b>\{t\.inReactivation\}<\/b>/, "🔴 місток знову на стані за днями оплати");
});

/**
 * #1213 — ЖИВИЙ SQL: «передано цього тижня» рахує лише АВТОМАТИЧНІ передачі з понеділка за Києвом; ручна
 * передача менеджером межі не їсть; другий прогін того ж тижня понад межу не віддає.
 * 🧨 Червоніє, якщо рахувати ручні, минулий тиждень або забути тижневу межу на повторі.
 */
test("#1213 ЖИВИЙ SQL: тижневий лічильник — лише авто з понеділка; повтор тижня понад 100 не віддає", async (t) => {
  const s = await scratchDb(t);
  if (!s) return;
  const { c } = s;
  try {
    const R = await import("./reactCycle.js");
    const ins = (k: string, reason: string, at: string) => c.query(
      `INSERT INTO client_react_cycles (client_key, cycle_month, pooled_at, pool_reason, from_manager_id) VALUES ($1, '2026-10-01', $2::timestamptz, $3, 10)`,
      [k, at, reason]);
    await ins("auto-mon", "auto", "2026-10-05 08:00:00+03");
    await ins("self-tue", "self_expired", "2026-10-06 00:40:00+03");
    await ins("manual", "manager", "2026-10-05 09:00:00+03");
    await ins("last-week", "auto", "2026-10-04 23:59:00+03");     // неділя минулого тижня за Києвом
    await ins("utc-trap", "auto", "2026-10-04 22:30:00+00");      // 05.10 01:30 за Києвом — уже цей тиждень
    assert.equal(await R.autoPooledSince(c, "2026-10-05"), 3, "🔴 лічильник тижня: ручна передача чи минулий тиждень, або UTC замість Києва");
    // Повтор того ж тижня: межа знає про вже передане.
    const due = Array.from({ length: 120 }, (_, i) => cand(`d${i}`, `2025-06-${String(1 + (i % 28)).padStart(2, "0")}`));
    const again = planSweep(due, new Map(), [], "2026-10-07", { transfer: true, pooledThisWeek: await R.autoPooledSince(c, "2026-10-05") });
    assert.equal(again.pool.length, 97, "🔴 повторний прогін тижня не врахував уже передане");
  } finally {
    await s.done();
  }
});
