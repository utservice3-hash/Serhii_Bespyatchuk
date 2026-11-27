import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🚪 Звільнені в «Зарплаті» (задача 10723, вимога Тетяни 25.11, «роби» Романа 27.11 з пропозиціями плану `zvilneni.md`):
 *  - звільнення в «Наймі» саме стає звільненням у «Зарплаті» (тип `naim`: лише відсоток, без ставки й бонусу), поки HR не оформить обхідний;
 *  - менеджер без жодної угоди в місяці звільнення отримує 0 — правило сильніше за п. 11 оферу (вмикає `state.dismissZero`);
 *  - з угодами — виплата лише після обхідного: без обхідного (дата з «Найму») форма теж закрита.
 * Тимліда й не продажі «0 → 0» не стосується. Гейти `#11320`–`#11325`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");

type Leave = { date: string; type: string } | null;
type Opt = { leave?: Leave; deals?: number; level?: "start" | "profi"; role?: "manager" | "lead"; zero?: boolean };
async function calc({ leave = { date: "2026-11-10", type: "naim" }, deals = 0, level = "start", role = "manager", zero = true }: Opt = {}) {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  const base = { dept: "sales", startDate: "2024-01-01", birthday: null, official: [], clientRates: [] };
  const X = role === "lead"
    ? { ...base, id: "X", name: "Тімлід", role: "lead", title: "Тім-лід", team: "t1", leadsTeam: "t1", leave, terms: [{ from: "2000-01", rate: 30000 }], adjustments: [] }
    : { ...base, id: "X", name: "Звільнений", role: "manager", title: "Менеджер", team: "t1", leave, terms: [{ from: "2000-01", level }],
      adjustments: [{ id: 1, kind: "bonus", amount: 1000, note: "постійний", from: "2026-01", to: null }] };
  const state = {
    now: "2026-11-25T18:00", liveMonth: "2026-11", closedMonth: "2026-10",
    settings: { birthday: { v2From: "2026-11" } },
    employees: [X, { ...base, id: "M", name: "Колега", role: "manager", title: "Менеджер", team: "t1", leave: null, terms: [{ from: "2000-01", level: "profi" }], adjustments: [] }],
    departments: { sales: { name: "Продажі", sales: true } }, teams: { t1: { name: "Т1" } },
    plans: {}, kpi: {}, records: {}, advances: {}, clearances: {},
    deals: { X: { "2026-11": deals ? [{ id: "d1", date: "2026-11-05", client: "К", margin: deals, pay: "paid" }] : [] }, M: { "2026-11": [{ id: "d2", date: "2026-11-06", client: "Л", margin: 80000, pay: "paid" }] } },
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "", name: "HR" }, od: { id: "", name: "ОД" }, finance: [] },
    ...(zero ? { dismissZero: true } : {}),
  };
  const zp = createPayroll(state as never);
  return { c: zp.calc("X", "2026-11") as Record<string, any>, blocked: zp.payBlocked("X", "2026-11") as boolean };
}

/**
 * #11320 — 0 УГОД У МІСЯЦІ ЗВІЛЬНЕННЯ → 0: ні ставки «Старт», ні ДН (фонд −100), ні постійного бонусу; і «зараз», і «при плані».
 * Нічого платити — виплату обхідний не блокує. 🧨 Червоніє, якщо прибрати правило або забути ДН / постійний бонус.
 */
test("#11320 ЗВІЛЬНЕНИЙ БЕЗ УГОД: 0 зараз і при плані — без ставки, ДН і постійного бонусу; виплату не блокує", async () => {
  const { c, blocked } = await calc();
  assert.equal(c.dismissZero, true, "🔴 правило «0 угод → 0» не спрацювало");
  assert.equal(c.now.total, 0, `🔴 нараховано ${c.now.total}, а має бути 0`);
  assert.equal(c.atPlan.total, 0, `🔴 «при плані» ${c.atPlan.total}, а має бути 0`);
  assert.deepEqual(c.birthdays, [], "🔴 збір на ДН зі звільненого без угод не списуємо");
  assert.equal(c.now.adjBonus, 0, "🔴 постійний бонус звільненому без угод не нараховуємо");
  assert.equal(blocked, false, "🔴 платити нічого — форма не має чекати обхідного");
});

/**
 * #11321 🪞 ПАРА: ТОЙ САМИЙ ЗВІЛЬНЕНИЙ З УГОДОЮ 50 000 — відсоток є (10 % «Старт» = 5 000), ставки й бонусу немає (тип з «Найму»
 * невідомий), а виплата закрита до обхідного. 🧨 Червоніє, якщо «0 → 0» накриє людей з угодами, або тип `naim` дасть ставку,
 * або без обхідного форма відкриється.
 */
test("#11321 ЗВІЛЬНЕНИЙ З УГОДОЮ: лише відсоток, без ставки; виплата чекає обхідного", async () => {
  const { c, blocked } = await calc({ deals: 50000 });
  assert.ok(!c.dismissZero, "🔴 «0 → 0» спрацювало на людині з угодою");
  assert.equal(c.now.pctAmount, 5000, `🔴 відсоток ${c.now.pctAmount}, чекали 5 000`);
  assert.equal(c.now.rate, 0, "🔴 тип з «Найму» невідомий — ставки до обхідного немає");
  assert.equal(blocked, true, "🔴 з результатом виплата лише після обхідного, а його ще немає");
});

/**
 * #11322 — ПРАВИЛО ТЕТЯНИ СИЛЬНІШЕ ЗА П. 11: «Старт» з ініціативи компанії без угод — 0. Пара: без `dismissZero` (як у пакеті) —
 * ставка за відпрацьовані дні є. 🧨 Червоніє, якщо п. 11 переможе, або якщо правило діятиме без прапорця стану.
 */
test("#11322 «З ІНІЦІАТИВИ КОМПАНІЇ» БЕЗ УГОД: 0 з правилом; без прапорця стану — ставка за дні, як у пакеті", async () => {
  const on = (await calc({ leave: { date: "2026-11-10", type: "company" } })).c;
  const off = (await calc({ leave: { date: "2026-11-10", type: "company" }, zero: false })).c;
  assert.equal(on.now.total, 0, `🔴 з правилом має бути 0, а ${on.now.total}`);
  assert.ok(off.now.rate > 0, "🔴 без dismissZero — п. 11: ставка за дні");
});

/**
 * #11323 🪞 «0 → 0» — ЛИШЕ МЕНЕДЖЕРИ: тімлід, звільнений з ініціативи компанії, отримує ставку за дні, хоч власних угод не має.
 * 🧨 Червоніє, якщо правило поширити на всіх.
 */
test("#11323 ТІМЛІД БЕЗ УГОД: ставка за відпрацьовані дні лишається", async () => {
  const { c } = await calc({ role: "lead", leave: { date: "2026-11-10", type: "company" } });
  assert.ok(!c.dismissZero, "🔴 правило «0 угод → 0» — лише для менеджерів з продажу");
  assert.ok(c.now.rate > 0 && c.now.rate < 30000, `🔴 ставка тімліда пропорційно дням: ${c.now.rate}`);
});

/**
 * #11324 — ДАТА ЗВІЛЬНЕННЯ ЩЕ НЕ НАСТАЛА: людина працює, угоди можуть бути — правило не діє. 🧨 Червоніє, якщо прибрати умову дати.
 */
test("#11324 ЗВІЛЬНЕННЯ В МАЙБУТНЬОМУ: «0 → 0» ще не діє", async () => {
  const { c } = await calc({ leave: { date: "2026-11-28", type: "company" } });
  assert.ok(!c.dismissZero, "🔴 до дати звільнення людина працює");
  assert.ok(c.now.rate > 0, "🔴 з ініціативи компанії до дати — ставка за дні");
});

/**
 * #11325 — ДЖЕРЕЛО: стан бере дату з «Найму» (тип `naim`) лише без оформленого звільнення і вмикає правило; HR не може обрати
 * `naim` руками; «Зміни з «Найму»» і список для оформлення бачать таких людей. 🧨 Червоніє, якщо прибрати будь-яку з ланок.
 */
test("#11325 ДЖЕРЕЛО: дата з «Найму» → тип naim; dismissZero у стані; naim не обирається; HR бачить кого оформити", () => {
  const st = SRC("payroll/state.ts"), sv = SRC("payroll/service.ts");
  assert.match(st, /leave: r\.leave_date \? \{ date: dateOnly\(r\.leave_date\), type: r\.leave_type \}\s*: r\.naim_dismissed && [^?]*\? \{ date: r\.naim_dismissed, type: "naim" \} : null/,
    "🔴 оформлене в «Зарплаті» має пріоритет, інакше — дата з «Найму» з типом naim");
  assert.match(st, /WHEN x\.status = 'dismissed' THEN/, "🔴 дата лише зі статусу «звільнений» у «Наймі»");
  assert.match(st, /ttnLegacy, dismissZero: true,/, "🔴 правило «0 угод → 0» має їхати в стан рушія");
  assert.match(sv, /!\(type in LEAVE_TYPES\) \|\| type === "naim"\) fail\(422/, "🔴 тип naim не можна обрати руками");
  assert.match(sv, /filter\(\(p\) => !p\.leave \|\| \(p\.leave as \{ type\?: string \}\)\.type === "naim"\)/, "🔴 HR має бачити звільнених у «Наймі» в списку для оформлення");
  assert.match(sv, /leave: p\.leave && \(p\.leave as \{ type\?: string \}\)\.type !== "naim" \? p\.leave : null,/, "🔴 рядок «у «Наймі» звільнений» з кнопкою обхідного має лишитись");
});
