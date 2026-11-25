import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 💵 Задача 10723: постійний «Бонус» / «Корекція» на період (ТЗ Тетяни 23.11.2026, відповіді 24.11, затвердив Сергій 24.11,
 * «роби» Романа 25.11). Сума щомісяця з `from` до `to` включно (`to` порожнє — безстроково), коментар «за що» бачить людина.
 * Бонус — лише до ЗП, НЕ до авансу; корекція зменшує нараховане, але НЕ нижче нуля. Гейти `#10885`–`#10889`.
 * Рушій — чистий модуль, імпорт лінивий, як велить правило зони testing.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

type Adj = { id: number; kind: "bonus" | "correction"; amount: number; note: string; from: string; to: string | null };
type Zp = { calc: (id: string, mk: string) => Record<string, any>; settlement: (id: string, mk: string) => Record<string, any>; advanceLimit: (id: string, mk: string) => Record<string, any>; adjustmentsOf: (id: string, mk: string) => Adj[] };

/** Листопад 2026 — поточний. Усі на ставці 20 000 без відсотка й без ДН (правило ДН вимкнене), щоб нараховане було рівно ставкою. */
const emp = (id: string, adjustments: Adj[]) => ({ id, name: `Людина ${id}`, role: "staff", title: "Посада", dept: "ops", team: null,
  startDate: "2024-01-01", birthday: null, terms: [{ from: "2024-01", rate: 20000 }], official: [], leave: null, clientRates: [], adjustments });
const A = (id: number, kind: Adj["kind"], amount: number, from: string, to: string | null, note = "за що"): Adj => ({ id, kind, amount, note, from, to });
async function zp(people: Array<[string, Adj[]]>, records: Record<string, unknown> = {}): Promise<Zp> {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  return createPayroll({
    now: "2026-11-25T10:00", liveMonth: "2026-11", closedMonth: "2026-10",
    settings: { birthday: { v2From: null } },
    employees: people.map(([id, a]) => emp(id, a)),
    departments: { ops: { name: "Операційний", sales: false } }, teams: {},
    plans: {}, deals: {}, kpi: {}, records,
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "", name: "HR" }, od: { id: "", name: "ОД" }, finance: [] },
  } as never) as never as Zp;
}

/**
 * #10885 — ПЕРІОД: бонус діє рівно з `from` по `to` включно — по обидва боки кожної межі; безстроковий — і через рік.
 * 🧨 Червоніє, якщо межу зробити строгою (`<` замість `<=`), забути `to` або рахувати бонус до місяця початку.
 */
test("#10885 БОНУС НА ПЕРІОД: діє з/по включно, до початку й після кінця — нуль; безстроковий діє й через рік", async () => {
  const z = await zp([["1", [A(1, "bonus", 3000, "2026-12", "2027-02")]], ["2", [A(2, "bonus", 1000, "2026-11", null)]]]);
  const b = (id: string, mk: string) => z.calc(id, mk).now.adjBonus;
  assert.equal(b("1", "2026-11"), 0, "🔴 до місяця початку бонус не діє");
  assert.equal(b("1", "2026-12"), 3000, "🔴 у місяці початку бонус діє");
  assert.equal(b("1", "2027-02"), 3000, "🔴 у місяці кінця бонус ще діє (включно)");
  assert.equal(b("1", "2027-03"), 0, "🔴 після місяця кінця бонус не діє");
  assert.equal(b("2", "2027-11"), 1000, "🔴 безстроковий бонус діє й через рік");
  assert.equal(z.calc("1", "2026-12").now.total, 20000 + 3000, "🔴 бонус має дійти до суми нарахування");
  assert.equal(z.calc("1", "2026-12").atPlan.total, 20000 + 3000, "🔴 і до суми «при виконанні плану»");
  assert.deepEqual(z.calc("1", "2026-12").adjustments.map((a: Adj) => a.note), ["за що"], "🔴 коментар «за що» має їхати з розрахунком у кабінет");
});

/**
 * #10886 — КОРЕКЦІЯ НЕ РОБИТЬ ВИПЛАТУ МІНУСОВОЮ: менша за нараховане — віднімається повністю; більша — рівно до нуля.
 * Та сама межа — і в закритті місяця (settlement), включно з правкою фінансиста.
 * 🧨 Червоніє, якщо прибрати нижню межу (буде −10 000), або віднімати корекцію до бонусу, або в settlement не обмежити.
 */
test("#10886 КОРЕКЦІЯ: менша за нараховане — повністю, більша — до нуля; у закритті місяця так само, і після правки фінансиста", async () => {
  const z = await zp([["1", [A(1, "correction", 5000, "2026-11", null)]], ["2", [A(2, "correction", 30000, "2026-11", null)]],
    ["3", [A(3, "correction", 25000, "2026-11", null), A(4, "bonus", 3000, "2026-11", null)]]],
  { "2026-11": { "2": { status: "verified", overrides: { rate: 10000 }, notes: { rate: "правка" }, extras: [] } } });
  assert.equal(z.calc("1", "2026-11").now.total, 15000, "🔴 корекція 5 000 зі ставки 20 000 — 15 000");
  assert.equal(z.calc("2", "2026-11").now.total, 0, "🔴 корекція 30 000 зі ставки 20 000 — нуль, не мінус");
  assert.equal(z.calc("2", "2026-11").now.adjCorr, 20000, "🔴 утримано рівно стільки, скільки було нараховано");
  assert.equal(z.calc("3", "2026-11").now.total, 0, "🔴 бонус і корекція разом: 20 000 + 3 000 − 25 000 → нуль");
  assert.equal(z.calc("3", "2026-11").now.adjCorr, 23000, "🔴 корекція утримує й бонус, але не більше суми");
  assert.equal(z.settlement("1", "2026-11").total, 15000, "🔴 у закритті місяця корекція теж віднімається");
  assert.equal(z.settlement("2", "2026-11").total, 0, "🔴 після правки ставки до 10 000 корекція 30 000 — знову нуль, не −20 000");
  assert.equal(z.settlement("2", "2026-11").autoTotal, 0, "🔴 «як рахувала система» теж не мінус");
  assert.ok(z.settlement("2", "2026-11").pay >= 0, "🔴 до виплати — не мінус");
});

/**
 * #10887 — БОНУС ЛИШЕ ДО ЗП, НЕ ДО АВАНСУ: стеля авансу — нараховане без постійного бонусу. Пара: без бонусу стеля = нараховане.
 * Числа підібрано так, щоб стеля вирішувала: ставка 20 000, бонус 10 000, корекція 15 000 → нараховано 15 000, а без бонусу 5 000;
 * правило 50 % ставки дало б 10 000.
 * 🧨 Червоніє, якщо не відняти бонус від стелі (аванс 10 000) або відняти його й тоді, коли бонусу немає.
 */
test("#10887 АВАНС: постійний бонус до авансу не йде — стеля без бонусу; без бонусу стеля = нараховане", async () => {
  const z = await zp([["1", [A(1, "bonus", 10000, "2026-11", null), A(2, "correction", 15000, "2026-11", null)]], ["2", [A(3, "correction", 15000, "2026-11", null)]]]);
  const L1 = z.advanceLimit("1", "2026-11"), L2 = z.advanceLimit("2", "2026-11");
  assert.equal(z.calc("1", "2026-11").now.total, 15000, "передумова: нараховано 15 000");
  assert.equal(L1.byRule, 10000, "передумова: правило — 50 % ставки");
  assert.equal(L1.amount, 5000, "🔴 аванс не може включати постійний бонус: 15 000 − 10 000 = 5 000");
  assert.equal(L2.amount, 5000, "🪞 без бонусу стеля — нараховане (20 000 − 15 000 = 5 000)");
  const z0 = await zp([["1", [A(1, "bonus", 10000, "2026-11", null)]]]);
  assert.equal(z0.advanceLimit("1", "2026-11").amount, 10000, "🪞 великий бонус не зменшує аванс за правилом: 50 % ставки");
});

/**
 * #10888 — ЗАКРИТТЯ ЗБІГАЄТЬСЯ З КАБІНЕТОМ: без правок фінансиста settlement.total == calc.now.total == autoTotal для бонусу,
 * корекції й обох разом; рядки кабінету додають до нарахованого.
 * 🧨 Червоніє, якщо бонус/корекцію врахувати лише в одному з двох шляхів (кабінет покаже одне, лист — інше).
 */
test("#10888 ЗАКРИТТЯ = КАБІНЕТ: без правок нараховане однакове в розрахунку й у закритті місяця, з бонусом, корекцією й обома", async () => {
  const z = await zp([["1", [A(1, "bonus", 2500, "2026-11", null)]], ["2", [A(2, "correction", 1200, "2026-11", null)]], ["3", [A(3, "bonus", 700, "2026-11", null), A(4, "correction", 900, "2026-11", "2026-11")]]]);
  for (const id of ["1", "2", "3"]) {
    const c = z.calc(id, "2026-11"), f = z.settlement(id, "2026-11");
    assert.equal(f.total, c.now.total, `🔴 людина ${id}: закриття (${f.total}) ≠ кабінет (${c.now.total})`);
    assert.equal(f.autoTotal, c.now.total, `🔴 людина ${id}: «як рахувала система» ≠ кабінет`);
    assert.equal(f.adjBonus, c.now.adjBonus, `🔴 людина ${id}: бонус у листі ≠ бонус у кабінеті`);
    assert.equal(f.adjCorr, c.now.adjCorr, `🔴 людина ${id}: корекція в листі ≠ корекція в кабінеті`);
  }
  assert.equal(z.calc("3", "2026-11").now.total, 20000 + 700 - 900);
});

/**
 * #10889 — ТАБЛИЦЯ, ДОСТУП, ЕКРАНИ: таблиця з обовʼязковим коментарем і періодом, закрита від AI-запитів (обидва дзеркала);
 * стан читає лише незняті; початок не раніше поточного місяця, зняття не стирає закриті місяці; маршрути — з правом payroll_edit;
 * налаштування людини, кабінет, розрахунковий лист і «Перевірка» показують бонус і корекцію окремо.
 * 🧨 Червоніє, якщо прибрати перевірку коментаря, дозволити запис заднім числом, стерти минулі місяці при знятті або сховати рядок з екрана.
 */
test("#10889 БОНУС/КОРЕКЦІЯ: таблиця з коментарем і періодом, не для AI; не заднім числом; маршрути з payroll_edit; видно на 4 екранах", () => {
  const schema = SRC("db/schema.sql"), st = SRC("payroll/state.ts"), svc = SRC("payroll/service.ts"), rt = SRC("routes/payroll.ts");
  const t = schema.match(/CREATE TABLE IF NOT EXISTS payroll_adjustments \(([\s\S]*?)\n\);/)?.[1] ?? "";
  assert.match(t, /kind\s+TEXT NOT NULL CHECK \(kind IN \('bonus', 'correction'\)\)/, "🔴 вид — лише бонус або корекція");
  assert.match(t, /note\s+TEXT NOT NULL CHECK \(btrim\(note\) <> ''\)/, "🔴 коментар «за що» обовʼязковий і на рівні бази");
  assert.match(t, /to_month\s+DATE CHECK \(to_month IS NULL OR \(.*to_month >= from_month\)\)/, "🔴 кінець періоду — не раніше початку");
  assert.match(schema, /payroll_client_rates, payroll_adjustments FROM ai_readonly;/, "🔴 таблиця має бути закрита від AI-запитів");
  assert.match(SRC("ai/metricTools.ts"), /"payroll_adjustments"/, "🔴 дзеркало FORBIDDEN_TABLES не знає таблиці");
  assert.match(st, /FROM payroll_adjustments WHERE removed_at IS NULL/, "🔴 стан має читати лише незняті");
  assert.match(svc, /if \(from < e\.zp\.liveMonth\) fail\(422/, "🔴 запис заднім числом змінив би вже виплачене");
  assert.match(svc, /if \(a\.f < live\) await c\.query\(`UPDATE payroll_adjustments SET to_month = \$3::date/, "🔴 зняття має лишати закриті місяці як були");
  assert.match(rt, /payrollRouter\.post\("\/employees\/:userId\/adjustments", h\(EDIT,/, "🔴 додати — лише з правом payroll_edit");
  assert.match(rt, /payrollRouter\.delete\("\/employees\/:userId\/adjustments\/:id", h\(EDIT,/, "🔴 зняти — лише з правом payroll_edit");
  assert.match(FRONT("payroll/system/PeopleSettings.tsx"), /<Adjustments p=\{p\} live=\{live\} onDone=\{onDone\} \/>/, "🔴 у налаштуваннях людини немає блоку бонусу/корекції");
  assert.match(FRONT("payroll/cabinet/Overview.tsx"), /out\.push\(\{ k: "Бонус", s: `\$\{b\.note\}/, "🔴 у кабінеті бонус не показано окремо з коментарем");
  assert.match(FRONT("payroll/cabinet/Overview.tsx"), /out\.push\(\{ k: "Корекція"/, "🔴 у кабінеті корекцію не показано окремо");
  assert.match(FRONT("payroll/cabinet/CloseCard.tsx"), /k: `Бонус · \$\{b\.note\}`/, "🔴 у розрахунковому листі немає бонусу");
  assert.match(FRONT("payroll/cabinet/CloseCard.tsx"), /k: `Корекція · /, "🔴 у розрахунковому листі немає корекції");
  assert.match(FRONT("payroll/finance/VerifyTab.tsx"), /const total = pre \+ adjB - adjCorr;/, "🔴 «Перевірка» рахує нараховане без бонусу/корекції");
});
