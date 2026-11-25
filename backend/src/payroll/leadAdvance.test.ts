import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💸 Задача 10723: аванс тімліда — 15 % від СВОГО результату (правка 25.11.2026, переслав Роман: «тім-лід аванс за свій
 * результат 15%»; «роби» Романа 25.11). Було з пакета 03.11: 15 % від маржі ВСІЄЇ команди — тобто тімлід брав авансом
 * практично все нараховане (Михальчевська, 17 201 ₴). Власні угоди тімліда їдуть окремим полем `ownDeals` і НЕ входять
 * у `deals`: інакше їх побачили б маржа команди й компанії, ТТН, обхідний, авто-«Профі». Гейти `#10965`–`#10968`.
 * Рушій — чистий модуль, імпорт лінивий, як велить правило зони testing.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

type Zp = { calc: (id: string, mk: string) => Record<string, any>; advanceLimit: (id: string, mk: string) => Record<string, any>; companyMargin: (mk: string) => number };
type Deal = { id: string; date: string; client: string; margin: number; pay: string };
const D = (id: string, date: string, margin: number): Deal => ({ id, date, client: `К${id}`, margin, pay: "paid" });

/**
 * Листопад 2026, «сьогодні» 25.11. Команда t1: тімлід L (ставка 30 000, без плану → 3 % від маржі команди) і менеджер M
 * з маржею 500 000. Нараховано тімліду 30 000 + 15 000 = 45 000 — це стеля авансу. Тімлід L2 веде команду t2 (менеджер M2,
 * маржа 100 000), а власних угод не має — тож підстановка маржі команди дала б йому 15 000, а не 0.
 * `own` — власні угоди тімліда: 30 000 + 20 000 до сьогодні й 99 999 ПІСЛЯ сьогодні (не рахується).
 */
async function zp(own: Record<string, Record<string, Deal[]>> | undefined): Promise<Zp> {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  const base = { dept: "sales", startDate: "2024-01-01", birthday: null, official: [], leave: null, clientRates: [], adjustments: [] };
  return createPayroll({
    now: "2026-11-25T10:00", liveMonth: "2026-11", closedMonth: "2026-10",
    settings: { birthday: { v2From: null } },
    employees: [
      { ...base, id: "L", name: "Тімлід", role: "lead", title: "Тімлід", team: "t1", leadsTeam: "t1", terms: [{ from: "2024-01", rate: 30000 }] },
      { ...base, id: "L2", name: "Тімлід 2", role: "lead", title: "Тімлід", team: "t2", leadsTeam: "t2", terms: [{ from: "2024-01", rate: 30000 }] },
      { ...base, id: "M", name: "Менеджер", role: "manager", title: "Менеджер", team: "t1", terms: [{ from: "2000-01", level: "profi" }] },
      { ...base, id: "M2", name: "Менеджер 2", role: "manager", title: "Менеджер", team: "t2", terms: [{ from: "2000-01", level: "profi" }] },
    ],
    departments: { sales: { name: "Продажі", sales: true } }, teams: { t1: { name: "Т1" }, t2: { name: "Т2" } },
    plans: {}, deals: { M: { "2026-11": [D("m1", "2026-11-10", 500000)] }, M2: { "2026-11": [D("m2", "2026-11-11", 100000)] } }, kpi: {}, records: {},
    ...(own === undefined ? {} : { ownDeals: own }),
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "", name: "HR" }, od: { id: "", name: "ОД" }, finance: [] },
  } as never) as never as Zp;
}
const OWN = { L: { "2026-11": [D("l1", "2026-11-05", 30000), D("l2", "2026-11-20", 20000), D("l3", "2026-11-28", 99999)] } };

/**
 * #10965 — ТІМЛІД БЕРЕ 15 % ВІД СВОЇХ УГОД: 50 000 власної маржі → 7 500, хоча маржа команди 500 000 і нараховано 45 000.
 * Угода після «сьогодні» не рахується (як у менеджера).
 * 🧨 Червоніє, якщо основою лишити маржу команди (вийде 45 000 — стеля), або рахувати угоди з майбутнього (22 499).
 */
test("#10965 АВАНС ТІМЛІДА: 15 % від власних угод «Успішно реалізовано», не від маржі команди; угоди з майбутнього не рахуються", async () => {
  const z = await zp(OWN);
  const L = z.advanceLimit("L", "2026-11");
  assert.equal(z.calc("L", "2026-11").now.total, 45000, "передумова: нараховано тімліду 30 000 + 3 % від 500 000");
  assert.equal(L.base, 50000, "🔴 основа — власна маржа тімліда до сьогодні (30 000 + 20 000)");
  assert.equal(L.basis, "ownMargin", "🔴 основа має називатись власною маржею — з неї кабінет пише підпис");
  assert.equal(L.pct, 15, "🔴 відсоток — 15");
  assert.equal(L.amount, 7500, "🔴 ліміт = 15 % від 50 000");
  assert.equal(L.cap, 45000, "🔴 стеля — нараховане, як і була");
});

/**
 * #10966 — БЕЗ ВЛАСНИХ УГОД — НУЛЬ (буквально «за свій результат»); пара: менеджер у тій самій фікстурі не змінився.
 * 🧨 Червоніє, якщо тімліду без угод підставити маржу команди або ставку, або якщо правка зачепить ліміт менеджера.
 */
test("#10966 ТІМЛІД БЕЗ СВОЇХ УГОД — 0; ліміт менеджера не змінився від появи ownDeals", async () => {
  const z = await zp(OWN), old = await zp(undefined);
  assert.equal(z.advanceLimit("L2", "2026-11").amount, 0, "🔴 тімлід без власних угод авансу не бере");
  assert.equal(z.advanceLimit("L2", "2026-11").base, 0, "🔴 основа — нуль, а не маржа команди чи ставка");
  assert.deepEqual(
    (({ basis, base, pct, amount }) => ({ basis, base, pct, amount }))(z.advanceLimit("M", "2026-11")),
    (({ basis, base, pct, amount }) => ({ basis, base, pct, amount }))(old.advanceLimit("M", "2026-11")),
    "🔴 ліміт менеджера не має залежати від власних угод тімліда");
  assert.equal(z.advanceLimit("M", "2026-11").basis, "margin", "🔴 менеджер — від своєї маржі");
});

/**
 * #10967 — ВЛАСНІ УГОДИ НЕ ПРОТІКАЮТЬ У РОЗРАХУНОК: маржа команди, нараховане тімліду й маржа компанії однакові з ownDeals і без.
 * Пара: без ownDeals рушій рахує як у пакеті — від маржі команди (так лишаються зеленими 63 тести пакета, #2600).
 * 🧨 Червоніє, якщо угоди тімліда покласти в `deals` (маржа компанії зросте на 50 000) або зламати сумісність із пакетом.
 */
test("#10967 ВЛАСНІ УГОДИ ТІМЛІДА — ЛИШЕ ДЛЯ АВАНСУ: маржа команди, нараховане й маржа компанії ті самі; без ownDeals — як у пакеті", async () => {
  const z = await zp(OWN), old = await zp(undefined);
  assert.equal(z.calc("L", "2026-11").margin, 500000, "🔴 маржа команди тімліда — лише менеджери");
  assert.equal(z.calc("L", "2026-11").now.total, old.calc("L", "2026-11").now.total, "🔴 нараховане тімліду не має змінитись");
  assert.equal(z.companyMargin("2026-11"), old.companyMargin("2026-11"), "🔴 маржа компанії не має бачити угод тімліда");
  const P = old.advanceLimit("L", "2026-11");
  assert.deepEqual([P.basis, P.base, P.amount], ["teamMargin", 500000, 45000], "🔴 без ownDeals — правило пакета: 15 % від маржі команди, стеля 45 000");
});

/**
 * #10968 — СТАН І КАБІНЕТ: `state.ts` збирає власні угоди тімліда окремим полем (менеджер — першим), віддає його рушію;
 * кабінет пише підпис для нової основи.
 * 🧨 Червоніє, якщо угоди тімліда піти в `deals`, якщо прибрати `ownDeals` зі стану (рушій мовчки повернеться до маржі
 * команди), або якщо кабінет не знає `ownMargin` (підпис «ставки» під маржею).
 */
test("#10968 СТАН І ПІДПИС: власні угоди тімліда окремим полем ownDeals (менеджер першим), кабінет підписує «вашої маржі»", () => {
  const st = SRC("payroll/state.ts");
  assert.match(st, /if \(m != null && e\.role === "lead"\) byLead\.set\(m, e\.id\)/, "🔴 тімліди з менеджером Kommo мають потрапити в byLead");
  assert.match(st, /const e = byManager\.get\(r\.manager_id\);[^\n]*\n\s*if \(!e\) \{ const lead = byLead\.get\(r\.manager_id\); if \(lead\) \(\(ownDeals\[lead\]/, "🔴 угода менеджера — менеджеру, тімліда — в ownDeals");
  assert.doesNotMatch(st, /\(\(deals\[lead\]/, "🔴 угоди тімліда не мають іти в загальні deals");
  assert.match(st, /plans, deals, ownDeals, kpi,/, "🔴 ownDeals має їхати в стан рушія — без нього рушій рахує від маржі команди");
  assert.match(FRONT("payroll/cabinet/format.ts"), /L\.basis === "ownMargin" \? "вашої маржі «Успішно реалізовано»"/, "🔴 кабінет має підписати нову основу ліміту");
});
