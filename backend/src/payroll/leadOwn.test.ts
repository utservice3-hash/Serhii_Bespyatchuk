import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🧭 ЗП тімліда = власний результат + команда (Тетяна 27.11: «Тім-лід — має свій результат, його зп рахується згідно оферу як у
 * менеджера (старт або профі) + % від команди, 3% коли план команда не виконала і 6 коли виконала»; Роман 27.11: «додати до викату»).
 * Ставка тімліда лишається; % власних угод — за шкалою його рівня без особистого плану (Старт 10 %, Профі 25 % / 30 % від 70 000).
 * Вмикає `state.leadOwn`; без нього рушій рахує як пакет (`#2600`). Гейти `#11360`–`#11362`.
 */
const SRC = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "src", p), "utf8");
const FRONT = (p: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", p), "utf8");

/** Тімлід зі ставкою 25 000, команда: А 200 000 + Б 139 422 (плану немає → 3 %); власні угоди тімліда — `own`. */
async function mk(own: number, { level, flag = true, records }: { level?: "start" | "profi"; flag?: boolean; records?: object } = {}) {
  const { createPayroll } = await import("./engine/zarplata-engine.mjs");
  const base = { dept: "sales", startDate: "2024-01-01", birthday: null, official: [], leave: null, clientRates: [], adjustments: [] };
  const state = {
    now: "2026-11-25T18:00", liveMonth: "2026-11", closedMonth: "2026-10", settings: { birthday: { v2From: null } },
    employees: [
      { ...base, id: "L", name: "Тімлід", role: "lead", title: "Тім-лід", team: "t1", leadsTeam: "t1", terms: [{ from: "2000-01", rate: 25000, ...(level ? { level } : {}) }] },
      { ...base, id: "A", name: "А", role: "manager", title: "Менеджер", team: "t1", terms: [{ from: "2000-01", level: "profi" }] },
      { ...base, id: "B", name: "Б", role: "manager", title: "Менеджер", team: "t1", terms: [{ from: "2000-01", level: "profi" }] },
    ],
    departments: { sales: { name: "Продажі", sales: true } }, teams: { t1: { name: "Т1" } }, plans: {}, kpi: {}, advances: {}, clearances: {},
    records: records ?? {},
    deals: { A: { "2026-11": [{ id: "a", date: "2026-11-03", client: "К", margin: 200000, pay: "paid" }] }, B: { "2026-11": [{ id: "b", date: "2026-11-04", client: "Л", margin: 139422, pay: "paid" }] } },
    ownDeals: { L: { "2026-11": own ? [{ id: "o", date: "2026-11-05", client: "М", margin: own, pay: "paid" }] : [] } },
    responsibles: { ba: { id: "", name: "БА" }, acc: { id: "", name: "Бух" }, hr: { id: "", name: "HR" }, od: { id: "", name: "ОД" }, finance: [] },
    ...(flag ? { leadOwn: true } : {}),
  };
  return createPayroll(state as never);
}
type Calc = { margin: number; ownMargin: number; now: { rate: number; pct: number; pctAmount: number; ownPct: number; ownAmount: number; total: number } };

/**
 * #11360 — РУШІЙ: «Старт» з власною маржею 41 600 → +10 % = 4 160 поверх ставки 25 000 і 3 % команди; «Профі» з 80 000 → 30 %
 * (від 70 000) = 24 000; без угод — 0. Пара: без `leadOwn` — як у пакеті (власні не йдуть у %). 🧨 Червоніє, якщо власні угоди не
 * рахувати, рахувати не за рівнем, підмішати їх у відсоток команди або ввімкнути без прапорця.
 */
test("#11360 ТІМЛІД: % власних угод за шкалою рівня поверх ставки й % команди; без прапорця стану — як у пакеті", async () => {
  const st = (await mk(41600)).calc("L", "2026-11") as Calc;
  assert.equal(st.now.pctAmount, 339422 * 3 / 100, "🔴 % команди має лишитись від маржі команди");
  assert.deepEqual([st.now.ownPct, st.now.ownAmount], [10, 4160], "🔴 «Старт»: 10 % від власної маржі 41 600");
  assert.equal(st.now.total, 25000 + 339422 * 3 / 100 + 4160, "🔴 нараховано = ставка + % команди + % власних");
  const pr = (await mk(80000, { level: "profi" })).calc("L", "2026-11") as Calc;
  assert.deepEqual([pr.now.ownPct, pr.now.ownAmount], [30, 24000], "🔴 «Профі»: від 70 000 — 30 %");
  const none = (await mk(0)).calc("L", "2026-11") as Calc;
  assert.equal(none.now.ownAmount, 0, "🔴 без власних угод — 0");
  const pkg = (await mk(41600, { flag: false })).calc("L", "2026-11") as Calc;
  assert.equal(pkg.now.total, 25000 + 339422 * 3 / 100, "🔴 без leadOwn у стані — як у пакеті");
});

/**
 * #11361 — ВІДОМІСТЬ: власні угоди тімліда — у нарахованому й «До виплати»; фінансист правив маржу КОМАНДИ — власні не змінюються.
 * 🧨 Червоніє, якщо settlement загубить власні угоди або правка маржі команди їх перерахує.
 */
test("#11361 ВІДОМІСТЬ ТІМЛІДА: власні угоди в нарахованому й до виплати; правка маржі команди їх не чіпає", async () => {
  const f = (await mk(41600)).settlement("L", "2026-11") as { total: number; pay: number; leadOwn: number };
  assert.equal(f.leadOwn, 4160, "🔴 відомість не бачить % власних угод");
  assert.equal(f.total, 25000 + 339422 * 3 / 100 + 4160, "🔴 нараховано без власних угод");
  const rec = { "2026-11": { L: { status: "review", overrides: { margin: 300000 }, notes: {}, extras: [] } } };
  const g = (await mk(41600, { records: rec })).settlement("L", "2026-11") as { total: number; leadOwn: number };
  assert.equal(g.leadOwn, 4160, "🔴 правка маржі команди змінила % власних угод");
  assert.equal(g.total, 25000 + 300000 * 3 / 100 + 4160, "🔴 правка маржі команди — лише в % команди");
});

/**
 * #11362 — ДЖЕРЕЛО: прапорець у стані; рівень тімліда можна поставити в «Працівниках»; кабінет показує «Відсоток від власних угод»;
 * «Шкали» й ліміт авансу говорять «власної маржі». 🧨 Червоніє, якщо прибрати прапорець, поле рівня для тімліда або повернути
 * старі підписи «без власних угод».
 */
test("#11362 ДЖЕРЕЛО: leadOwn у стані; рівень тімліда в «Працівниках»; підписи кабінету, «Шкал» і аванс від власної маржі", () => {
  assert.match(SRC("payroll/state.ts"), /dismissZero: true, leadOwn: true,/, "🔴 правило має їхати в стан рушія");
  const ppl = FRONT("payroll/system/PeopleSettings.tsx");
  assert.match(ppl, /if \(\(p\.role === "manager" \|\| p\.role === "lead"\) && f\.level !== \(p\.level \?\? "start"\)\) body\.level = f\.level;/, "🔴 рівень тімліда має зберігатись");
  const terms = FRONT("payroll/cabinet/Terms.tsx");
  assert.match(terms, /\["Відсоток від власних угод",/, "🔴 кабінет тімліда — рядок про власні угоди");
  assert.doesNotMatch(terms, /без ваших власних угод/, "🔴 старий підпис «без власних угод» повернувся");
  const set = FRONT("payroll/system/SettingsTab.tsx");
  assert.doesNotMatch(set, /маржі команди без власних угод/, "🔴 «Шкали» досі кажуть «без власних угод»");
  assert.match(set, /\["advance\.leadPct", "Тім-лід, % власної маржі"\]/, "🔴 ліміт авансу тімліда — від власної маржі (правка 25.11)");
  assert.match(FRONT("payroll/cabinet/Overview.tsx"), /k: `Відсоток · \$\{pc\(x\.ownPct\)\} · власні угоди`/, "🔴 кабінет: розклад нарахованого з власними угодами");
});
