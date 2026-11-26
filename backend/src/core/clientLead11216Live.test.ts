import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { thisYearWindow } from "./clientOrderHistory.js";

/**
 * 🚦 «З КИМ ГОВОРИТИ»: ПРАВКИ ІЗ ЗУСТРІЧІ 25.11.2026, ЩО ХОДЯТЬ У БАЗУ (стратегічна задача 11216). Живі гейти — на одній
 * одноразовій базі на файл (прийом `leadgenLtv.test.ts`); чисті правила — без бази.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

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
    const schema = read("backend/src/db/schema.sql");
    await c.query(schema);
    await c.query(schema);
    return { c, done: async () => { await pool.end().catch(() => {}); await c.end(); scratch.dispose(); } };
  })();
  return live;
}
after(async () => { const l = live && await live; if (l && "done" in l) await l.done(); });

/**
 * #11219 — «ЗА ЦЕЙ РІК» = ПОТОЧНИЙ КАЛЕНДАРНИЙ РІК ЗА КИЄВОМ, ВІД 1 СІЧНЯ ДО СЬОГОДНІ; і рядок бере обидва числа з ядра
 * грошей одним викликом, по клієнту цілком. 1 січня вікно — один день; 31 грудня — увесь рік; рік не «останні 12 місяців».
 * 🧨 Червоніє, якщо вікно почнеться не з 1 січня, зачепить завтра, або рядок рахуватиме рік власним SQL чи зі звуженням.
 */
test("#11219 «ЗА ЦЕЙ РІК»: вікно від 1 січня до сьогодні за Києвом; оборот і дохід у рядку — одним викликом ядра грошей", () => {
  assert.deepEqual(thisYearWindow("2026-11-26"), { year: 2026, from: "2026-01-01", to: "2026-11-26" });
  assert.deepEqual(thisYearWindow("2026-01-01"), { year: 2026, from: "2026-01-01", to: "2026-01-01" }, "🔴 1 січня вікно — не один день");
  assert.deepEqual(thisYearWindow("2026-12-31"), { year: 2026, from: "2026-01-01", to: "2026-12-31" }, "🔴 31 грудня вікно — не весь рік");
  assert.deepEqual(thisYearWindow("2027-01-01"), { year: 2027, from: "2027-01-01", to: "2027-01-01" }, "🔴 новий рік не починає нове вікно");
  const dash = codeOnly(read("backend/src/routes/dashboard.ts"));
  const plans = dash.slice(dash.indexOf('dashboardRouter.get("/client-plans"'), dash.indexOf('dashboardRouter.post("/client-plans/submit"'));
  assert.match(plans, /const yearWin = clientOrderHistory\.thisYearWindow\(todayKyiv\);/, "🔴 рік рахується не від київського «сьогодні»");
  assert.match(plans, /money\.successPeriodByClientKey\(clientKeys, yearWin\.from, yearWin\.to\),/, "🔴 оборот і дохід за рік — не ядром грошей або не по всіх клієнтах списку");
  assert.match(plans, /return \{ year: yearWin\.year, revenue: Math\.round\(y\?\.revenue \?\? 0\), income: Math\.round\(y\?\.income \?\? 0\), deals: y\?\.deals \?\? 0, missing: y\?\.missing \?\? 0 \};/,
    "🔴 рядок не несе рік, дохід, оборот, число угод і число угод без суми рахунку");
  const core = codeOnly(read("backend/src/core/money.ts"));
  const fn = core.slice(core.indexOf("export async function successPeriodByClientKey("), core.indexOf("export async function successForSources("));
  assert.ok(fn.length > 200, "🔴 перевіряти нічого: функції року в ядрі немає");
  assert.match(fn, /const src = sourceSql\("success", p\);/, "🔴 рік рахується не з каси «успішно реалізовано»");
  assert.doesNotMatch(fn, /managerId|teamId|teamOnDateSql/, "🔴 рік клієнта звужено за менеджером чи командою — число залежатиме від того, хто дивиться");
  const lead = codeOnly(read("frontend/src/pages/dashboard/sections/ClientLeadSection.tsx"));
  assert.match(lead, /\{c\.yearMoney && <YearMoney y=\{c\.yearMoney\} \/>\}/, "🔴 у рядку «З ким говорити» немає обороту й доходу за рік");
  assert.match(lead, /оборот <b>\{partial \? "≥ " : ""\}\{uah\(y\.income\)\}<\/b> · дохід <b>\{uah\(y\.revenue\)\}<\/b>/, "🔴 оборот і дохід переплутані або неповний оборот не позначено");
});

/**
 * #11219b — ЖИВИЙ SQL РОКУ: дохід і оборот — з тих самих успішних угод, у межах року ЗА КИЄВОМ з обох кінців (угода
 * 01.01 о 00:30 за Києвом — у році, хоч за UTC ще грудень; угода завтра о 00:30 — ні, хоч за UTC ще сьогодні); програна —
 * ні; угода іншого менеджера того самого клієнта — так (рік рахується по клієнту, не по тому, хто дивиться); угода без
 * суми рахунку — у доході є, в обороті названа числом; сторно — мінусом. Дохід == `successByClientKey` за той самий період.
 * 🧨 Червоніє, якщо межа поїде на UTC, програна потрапить у рік, або оборот і дохід рахуватимуться з різних угод.
 */
test("#11219b ЖИВИЙ SQL РОКУ: межі за Києвом з обох кінців, програна — ні, чужий менеджер — так, угода без суми рахунку — числом", async (t) => {
  const l = await liveDb();
  if ("skip" in l) return t.skip(l.skip);
  const { c } = l;
  await c.query(`INSERT INTO managers (id, name, kommo_user_id, team_id, is_active) VALUES
    (9701, 'Перший', 97010, NULL, true), (9702, 'Другий', 97020, NULL, true)`);
  await c.query(`INSERT INTO deals (kommo_id, manager_id, pipeline_id, status_id, closed_at_kommo, price, client_key) VALUES
    (97101, 9701, 8921932, 142, '2026-01-01 00:30+02', 1000, 'рік-а'),
    (97102, 9702, 8921932, 142, '2025-12-31 23:30+02', 5000, 'рік-а'),
    (97103, 9702, 8921932, 142, '2026-11-18 23:30+02', 2000, 'рік-а'),
    (97104, 9701, 8921932, 143, '2026-06-10 12:00+03', 9000, 'рік-а'),
    (97105, 9701, 8921932, 142, '2026-11-19 00:30+02', 7000, 'рік-а'),
    (97106, 9701, 8921932, 142, '2026-03-05 12:00+02', -300, 'рік-б')`);
  await c.query(`INSERT INTO deal_fin_fields (kommo_id, income) VALUES (97101, 10000), (97102, 50000), (97104, 90000), (97105, 70000), (97106, 4000)`);
  const { successPeriodByClientKey, successByClientKey } = await import("./money.js");
  const m = await successPeriodByClientKey(["рік-а", "рік-б", "рік-нема"], "2026-01-01", "2026-11-18");
  assert.deepEqual(m.get("рік-а"), { revenue: 3000, income: 10000, missing: 1, deals: 2 },
    "🔴 рік клієнта: не ті угоди (межа за Києвом, програна, завтрашня, чужий менеджер) або угода без суми рахунку не названа");
  assert.deepEqual(m.get("рік-б"), { revenue: -300, income: 4000, missing: 0, deals: 1 }, "🔴 сторно в році не мінусом або оборот не з тієї угоди");
  assert.equal(m.has("рік-нема"), false, "🔴 клієнт без успішних угод року отримав рядок");
  // 🪞 Дохід року == та сама каса ядра за той самий період (інший лише відбір ключів).
  const byKey = new Map((await successByClientKey({ from: "2026-01-01", to: "2026-11-18" })).map((r) => [r.key, r]));
  for (const k of ["рік-а", "рік-б"]) {
    assert.equal(m.get(k)!.revenue, byKey.get(k)!.revenue, `🔴 ${k}: дохід року ≠ successByClientKey за той самий період`);
    assert.equal(m.get(k)!.deals, byKey.get(k)!.deals, `🔴 ${k}: число угод року ≠ successByClientKey`);
  }
  // Сусіднє вікно забирає рівно те, що не увійшло: рік 2025 — лише угода 31.12 о 23:30 за Києвом.
  const prev = await successPeriodByClientKey(["рік-а"], "2025-01-01", "2025-12-31");
  assert.deepEqual(prev.get("рік-а"), { revenue: 5000, income: 50000, missing: 0, deals: 1 }, "🔴 угода 31.12 не в минулому році — межа року не за Києвом");
  assert.deepEqual([...(await successPeriodByClientKey([], "2026-01-01", "2026-11-18")).keys()], [], "🔴 з порожнього списку ключів зʼявились рядки");
});

/**
 * #11221b — ЖИВА АНКЕТА: збережене читається тим самим, що записали (усі пʼять колонок — кожна на своє питання); друге
 * збереження ЗАМІНЮЄ анкету цілком, а не доклеює; клієнт без анкети в мапі відсутній (а не «заповнений порожнім»);
 * хто і коли змінив — видно. Колонки таблиці == перелік питань ядра.
 * 🧨 Червоніє, якщо відповідь ляже не у своє питання, стара відповідь переживе збереження, або клієнт без анкети отримає рядок.
 */
test("#11221b ЖИВА АНКЕТА: відповідь у своєму питанні; збереження замінює цілком; клієнт без анкети — без рядка; видно, хто змінив", async (t) => {
  const l = await liveDb();
  if ("skip" in l) return t.skip(l.skip);
  const { c } = l;
  const cp = await import("./clientProfile.js");
  await c.query(`INSERT INTO users (id, email, password_hash, role, full_name, is_active) VALUES (97901, 'anketa@x.ua', 'x', 'manager', 'Анкетний Менеджер', true)`);
  const cols = (await c.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'client_profiles'`)).rows.map((r) => r.column_name);
  for (const f of cp.PROFILE_FIELDS) assert.ok(cols.includes(f.column), `🔴 у таблиці немає колонки ${f.column} для питання «${f.label}»`);
  const a1 = { business: "меблі", volume: "5 машин на тиждень", share: "половину, решту возить власний транспорт", international: "Польща раз на місяць", airSea: "ні" };
  assert.equal(await cp.saveProfile(c, { clientKey: "анкета-а", userId: 97901, answers: a1 }), 5);
  const m1 = await cp.profilesFor(c, ["анкета-а", "анкета-нема"]);
  assert.deepEqual(m1.get("анкета-а")?.answers, a1, "🔴 відповідь лягла не у своє питання");
  assert.equal(m1.get("анкета-а")?.filled, 5);
  assert.equal(m1.get("анкета-а")?.updatedBy, "Анкетний Менеджер", "🔴 не видно, хто заповнив анкету");
  assert.match(m1.get("анкета-а")?.updatedDay ?? "", /^\d{4}-\d{2}-\d{2}$/, "🔴 не видно, коли заповнили анкету");
  assert.equal(m1.has("анкета-нема"), false, "🔴 клієнт без анкети отримав рядок");
  // Друге збереження — заміна цілком: прибрана відповідь не переживає.
  const a2 = cp.cleanProfile({ business: "меблі та двері", volume: "5 машин на тиждень" });
  assert.equal(await cp.saveProfile(c, { clientKey: "анкета-а", userId: null, answers: a2 }), 2);
  const m2 = await cp.profilesFor(c, ["анкета-а"]);
  assert.deepEqual(m2.get("анкета-а")?.answers, { business: "меблі та двері", volume: "5 машин на тиждень", share: "", international: "", airSea: "" }, "🔴 збереження доклеює, а не замінює — стара відповідь пережила");
  assert.equal(m2.get("анкета-а")?.filled, 2, "🔴 число відповідей не з того, що лежить у базі");
  assert.equal((await c.query(`SELECT 1 FROM client_profiles WHERE client_key = 'анкета-а'`)).rowCount, 1, "🔴 на клієнта більше однієї анкети");
  assert.deepEqual([...(await cp.profilesFor(c, [])).keys()], [], "🔴 з порожнього списку ключів зʼявились анкети");
});
