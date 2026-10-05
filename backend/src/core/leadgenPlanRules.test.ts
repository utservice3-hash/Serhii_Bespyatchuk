import { test } from "node:test";
import assert from "node:assert/strict";
import {
  leadgenRosterView, rosterInvariantBreaks, sumRoster, planForPeriod, periodElapsed, planExecution, planView,
  leadgenSubmitRefusal, mayEverSubmitLeadgenPlan, mayApproveLeadgenPlan, parseLeadgenSubmit, planMonthOf,
  personFormationStatus, type RosterRow, type TeamMember, type ApprovedByMonth,
} from "./leadgenPlanRules.js";

/**
 * #743…#747 — ЧИСТІ ПРАВИЛА ПЛАНІВ ЛІДГЕНІВ І РОСТЕРА ЕКРАНА (рішення власника 25.09.2026).
 * Модуль без пулу, тож кожна межа тут — фікстурою по ОБИДВА боки, у звичайному `npm test`.
 */

const LG = 50011, RNK = 7;
const row = (id: number, teamId: number | null, n: Partial<RosterRow> = {}): RosterRow => ({
  managerId: id, name: `Л${id}`, teamId, teamName: teamId == null ? null : `T${teamId}`, isActive: true,
  leads: 0, opr: 0, quotes: 0, warming: 0, calls: 0, ...n,
});
const zero = (m: TeamMember): RosterRow => row(m.managerId, m.teamId);
const member = (id: number, teamId = LG): TeamMember => ({ managerId: id, name: `Л${id}`, teamId, teamName: `T${teamId}` });

// Вересень 2026 як на проді: 4 лідгени, з них 3 у команді; Ковтонюк (РНК, 10 прорахунків), двоє продажників з нулями.
const ROWS = [
  row(1, LG, { leads: 100, opr: 40, quotes: 20, calls: 300 }),
  row(2, LG, { leads: 80, opr: 30, quotes: 15, calls: 200, warming: 4 }),
  row(3, null, { leads: 50, opr: 10, quotes: 5 }),                  // Крупник: лідген, але НЕ в команді
  row(4, RNK, { leads: 12, opr: 11, quotes: 10, calls: 7 }),        // Ковтонюк
  row(5, RNK), row(6, 9),                                            // продажники з нулями
  row(7, LG, { leads: 3, isActive: false }),                         // деактивована, досі з team_id команди
];
const MEMBERS = [member(1), member(2), member(8)];                    // 8 — учасник без жодної події

/**
 * #743 — КОМПАНІЯ: рядки = ЛИШЕ активні учасники (включно з тим, у кого подій нуль), решта людей із
 * подіями — `others`; підсумок = УВЕСЬ відділ, і Σ рядків + Σ інших == підсумок.
 * 🧨 САБОТАЖ: `totals: sumRoster(team)` у компанійській гілці → червоніє (підсумок відділу схуд).
 */
test("#743 РОСТЕР КОМПАНІЇ: рядки — учасники команди, інші — окремо, підсумок відділу не змінився", () => {
  const v = leadgenRosterView(ROWS, MEMBERS, null, zero);
  assert.deepEqual(v.rows.map((r) => r.managerId), [1, 2, 8], "🔴 рядки людей — не рівно учасники команди");
  assert.deepEqual(v.others.map((r) => r.managerId), [3, 4, 5, 6, 7], "🔴 «інші» не рівно ті, хто з подіями поза командою");
  assert.deepEqual(v.totals, sumRoster(ROWS), "🔴 підсумок відділу змінився — рішення 1 каже: рахує УСІХ");
  assert.deepEqual(rosterInvariantBreaks(v), [], "🔴 Σ рядків + Σ інших ≠ підсумку");
  assert.equal(v.rows.find((r) => r.managerId === 8)?.leads, 0, "🔴 учасник без подій мусить мати нульовий рядок, а не зникнути");
  assert.ok(v.others.some((r) => r.managerId === 7), "🔴 деактивована людина з team_id команди — не учасник, а «інші»");
  assert.equal(v.othersTotals.quotes, 15, "🔴 підсумок «інших» не той");
});

/**
 * #743b — ТІМЛІД: лише своя команда (межа та сама `teamId`), нульові рядки своїх учасників, `others` порожньо,
 * підсумок = Σ рядків. Тімлід РНК «Лідогенерації» не бачить. 🪞 Дзеркало: детектор інваріанта ловить розрив.
 * 🧨 САБОТАЖ: у гілці тімліда `others: rows.filter((r) => r.teamId !== scopeTeamId)` → червоніє.
 */
test("#743b РОСТЕР ТІМЛІДА: лише своя команда, блоку «Інші» немає; 🪞 розрив інваріанта ловиться", () => {
  const lg = leadgenRosterView(ROWS, MEMBERS, LG, zero);
  assert.deepEqual(lg.rows.map((r) => r.managerId), [1, 2, 7, 8]);
  assert.deepEqual(lg.others, [], "🔴 тімліду віддано «Інших» — блок лише для рівня компанії");
  assert.deepEqual(lg.totals, sumRoster(lg.rows));
  const rnk = leadgenRosterView(ROWS, MEMBERS, RNK, zero);
  assert.deepEqual(rnk.rows.map((r) => r.managerId), [4, 5], "🔴 тімлід РНК бачить не свою команду");
  assert.ok(!rnk.rows.some((r) => r.teamId === LG), "🔴 тімліду РНК потрапили учасники «Лідогенерації»");
  const broken = { ...leadgenRosterView(ROWS, MEMBERS, null, zero), others: [] };
  assert.notDeepEqual(rosterInvariantBreaks(broken), [], "🔴 детектор інваріанта мовчить на загубленому блоці «Інші»");
});

/**
 * #744 — ПЛАН НА ПЕРІОД: цілий місяць = план місяця; тиждень = частка за робочими днями (як Звіт продажів);
 * місяць без затвердженого плану → `null`, а не «частковий план». 🧨 САБОТАЖ: `if (v == null) { out[k] = null; continue; }` →
 * `if (v == null) continue;` → червоніє (період через межу місяців дав би план половини).
 */
test("#744 ПЛАН НА ПЕРІОД: місяць — як є, тиждень — частка робочих днів, немає плану на частину — null", () => {
  const ap: ApprovedByMonth = new Map([["2026-09-01", { leads: 220, opr: 88, quotes: 44 }]]);
  assert.deepEqual(planForPeriod(ap, "2026-09-01", "2026-09-30"), { leads: 220, opr: 88, quotes: 44, calls: null, money: null });
  // вересень 2026 — 22 робочі дні; 14–20.09 — 5 із них
  assert.deepEqual(planForPeriod(ap, "2026-09-14", "2026-09-20"), { leads: 50, opr: 20, quotes: 10, calls: null, money: null });
  assert.deepEqual(planForPeriod(ap, "2026-09-28", "2026-10-04"), { leads: null, opr: null, quotes: null, calls: null, money: null },
    "🔴 жовтня без плану — а план періоду вийшов числом");
  assert.deepEqual(planForPeriod(new Map(), "2026-09-01", "2026-09-30"), { leads: null, opr: null, quotes: null, calls: null, money: null });
  const partial: ApprovedByMonth = new Map([["2026-09-01", { quotes: 44 }]]);
  assert.deepEqual(planForPeriod(partial, "2026-09-01", "2026-09-30"), { leads: null, opr: null, quotes: 44, calls: null, money: null });
});

/**
 * #745 — ВИКОНАННЯ: пороги й темп — як `statusOf` Звіту продажів; плану немає → `none` (НЕ 0 %);
 * план 0 → `zero`. 🧨 САБОТАЖ: `if (plan == null) return { kind: "none" };` → `if (plan == null) plan = 0;`... тобто
 * прибрати гілку `none` → червоніє.
 */
test("#745 ВИКОНАННЯ: пороги й темп як у Звіті; без плану — «плану немає», а не 0 %", () => {
  assert.deepEqual(planExecution(5, null, 0.5), { kind: "none" }, "🔴 без плану — фальшивий відсоток");
  assert.deepEqual(planExecution(5, 0, 0.5), { kind: "zero" });
  assert.deepEqual(planExecution(20, 40, 0.5), { kind: "plan", fact: 20, plan: 40, pct: 50, level: "g" }, "🔴 у темпі — не «у цілі»");
  assert.equal((planExecution(14, 40, 0.5) as { level: string }).level, "a");
  assert.equal((planExecution(13, 40, 0.5) as { level: string }).level, "r");
  assert.equal((planExecution(40, 40, 1) as { level: string }).level, "g");
  assert.equal(periodElapsed("2026-09-01", "2026-09-30", "2026-08-31"), 0);
  assert.equal(periodElapsed("2026-09-01", "2026-09-30", "2026-10-02"), 1);
  assert.equal(periodElapsed("2026-09-01", "2026-09-30", "2026-09-11"), 9 / 22);
  const v = planView([row(1, LG, { quotes: 11 }), row(2, LG, { quotes: 3 })],
    new Map([[1, new Map([["2026-09-01", { leads: 1, opr: 1, quotes: 22 }]])]]), "2026-09-01", "2026-09-30", "2026-10-01");
  assert.deepEqual(v.byPerson.map((p) => p.exec.kind), ["plan", "none"]);
  assert.deepEqual({ ...v.team, exec: undefined, extra: undefined }, { total: 2, planned: 1, fact: 14, plan: 22, exec: undefined, extra: undefined },
    "🔴 команда: факт — усіх рядків, план — Σ тих, у кого він є");
});

/**
 * #746 — ХТО ПОДАЄ / ЗАТВЕРДЖУЄ: дзеркало продажів (тімлід — своя команда, адмін — будь-кого, затверджує лише
 * адмін-рівень); план — лише учаснику команди; тімлід без команди — не «усі без команди».
 * 🧨 САБОТАЖ: у `leadgenSubmitRefusal` гілка тімліда `a.teamId === t.teamId ? null : …` (без перевірки null) → червоніє.
 */
test("#746 МЕЖІ ПОДАННЯ Й ЗАТВЕРДЖЕННЯ — обидва боки кожної", () => {
  const T = (teamId: number | null, isMember = true) => ({ managerId: 1, teamId, isMember });
  assert.equal(leadgenSubmitRefusal({ role: "team_lead", teamId: LG }, T(LG)), null, "🔴 тімлід не може подати своїй команді");
  assert.equal(leadgenSubmitRefusal({ role: "admin", teamId: null }, T(LG)), null, "🔴 адмін не може подати");
  assert.equal(leadgenSubmitRefusal({ role: "team_lead", teamId: RNK }, T(LG)), "Лише своя команда");
  assert.equal(leadgenSubmitRefusal({ role: "team_lead", teamId: LG }, T(null, false)), "План ставиться лише активним учасникам команди «Лідогенерація»");
  assert.equal(leadgenSubmitRefusal({ role: "team_lead", teamId: null }, { managerId: 1, teamId: null, isMember: true }), "Лише своя команда",
    "🔴 тімлід без команди дістав людину без команди — null зіставлено рівністю");
  assert.notEqual(leadgenSubmitRefusal({ role: "admin", teamId: null }, T(RNK, false)), null, "🔴 план поставили не учаснику");
  assert.notEqual(leadgenSubmitRefusal({ role: "manager", teamId: LG }, T(LG)), null, "🔴 менеджер подав план");
  assert.notEqual(leadgenSubmitRefusal({ role: "company", teamId: null }, T(LG)), null);
  assert.deepEqual(["admin", "team_lead", "manager", "company"].map(mayEverSubmitLeadgenPlan), [true, true, false, false]);
  assert.deepEqual(["admin", "team_lead", "manager", "company"].map(mayApproveLeadgenPlan), [true, false, false, false]);
});

/** #747 — ТІЛО ПОДАННЯ: усі три значення цілі 0…стеля; місяць → перше число; стан людини з трьох рядків. */
test("#747 ТІЛО ПОДАННЯ й СТАН: цілі невідʼємні, усі три метрики обовʼязкові; «на затвердженні» переважає", () => {
  const ok = parseLeadgenSubmit({ managerId: 5, month: "2026-10", leads: 200, opr: 80, quotes: 40, comment: " ок " });
  assert.deepEqual(ok, { ok: true, managerId: 5, month: "2026-10-01", values: { leads: 200, opr: 80, quotes: 40, calls: null, money: null }, comment: "ок" });
  for (const bad of [{ leads: -1 }, { opr: 1.5 }, { quotes: undefined }, { quotes: "40" }, { month: "2026-13" }, { managerId: 0 }]) {
    const p = parseLeadgenSubmit({ managerId: 5, month: "2026-10", leads: 1, opr: 1, quotes: 1, ...bad });
    assert.equal(p.ok, false, `🔴 прийнято криве тіло ${JSON.stringify(bad)}`);
  }
  assert.equal(planMonthOf("2026-09-25"), "2026-09-01");
  assert.equal(planMonthOf("sep"), null);
  assert.equal(personFormationStatus(["approved", "submitted", "approved"]), "submitted");
  assert.equal(personFormationStatus([]), "draft");
  assert.equal(personFormationStatus(["approved", "approved", "approved"]), "approved");
});

/**
 * #1174 — ДЗВІНКИ Й ГРОШІ В ПЛАНІ (Ярослав, рішення власника 01.10.2026): необовʼязкові; стеля — своя
 * на пункт; ОДИН план по грошах порівнюється ДВІЧІ — з «Успішні» і з «Успішні + Очікування»; команда —
 * Σ планів тих, у кого він є, факт — усіх рядків. Кожна межа — по обидва боки.
 * 🧨 САБОТАЖ: у `extraExec` `m.earned + m.pending` → `m.earned` → два рядки збігаються → червоніє.
 */
test("#1174 ПЛАН НА ДЗВІНКИ Й ГРОШІ: необовʼязкові, своя стеля, гроші — двома порівняннями", () => {
  const base = { managerId: 5, month: "2026-10", leads: 1, opr: 1, quotes: 1 };
  // Необовʼязковість: відсутні / null / "" — «не плануємо»; обовʼязкові — як були.
  for (const absent of [{}, { calls: null, money: null }, { calls: "", money: "" }]) {
    const p = parseLeadgenSubmit({ ...base, ...absent });
    assert.ok(p.ok && p.values.calls === null && p.values.money === null, `🔴 порожній необовʼязковий пункт не прийнято: ${JSON.stringify(absent)}`);
  }
  assert.equal(parseLeadgenSubmit({ ...base, quotes: undefined, calls: 5, money: 5 }).ok, false, "🔴 прорахунки стали необовʼязковими");
  // Стеля своя: 150 000 ₴ — нормальний план; 150 000 дзвінків — ні.
  const m = parseLeadgenSubmit({ ...base, money: 150_000 });
  assert.ok(m.ok && m.values.money === 150_000, "🔴 план по грошах 150 000 ₴ відхилено — стеля штук застосована до гривень");
  assert.equal(parseLeadgenSubmit({ ...base, calls: 150_000 }).ok, false, "🔴 150 000 дзвінків прийнято — стеля грошей застосована до штук");
  assert.equal(parseLeadgenSubmit({ ...base, money: 1.5 }).ok, false);
  // Гроші — два порівняння одного плану; дзвінки — з факту рядка.
  const ap = new Map([
    [1, new Map([["2026-09-01", { leads: 1, opr: 1, quotes: 1, calls: 1000, money: 40_000 }]])],
    [2, new Map([["2026-09-01", { leads: 1, opr: 1, quotes: 1 }]])],
  ]) as Map<number, ApprovedByMonth>;
  const money = new Map([[1, { earned: 20_000, pending: 10_000 }], [2, { earned: 5_000, pending: 0 }]]);
  const v = planView([row(1, LG, { calls: 900 }), row(2, LG, { calls: 300 })], ap, "2026-09-01", "2026-09-30", "2026-10-01", money);
  const p1 = v.byPerson.find((x) => x.managerId === 1)!.extra;
  assert.deepEqual([p1.calls, p1.moneyEarned, p1.moneyTotal].map((e) => e.kind === "plan" ? [e.fact, e.plan, e.pct] : e.kind),
    [[900, 1000, 90], [20_000, 40_000, 50], [30_000, 40_000, 75]], "🔴 дзвінки або два порівняння грошей пораховано не з тих чисел");
  const p2 = v.byPerson.find((x) => x.managerId === 2)!.extra;
  assert.deepEqual([p2.calls.kind, p2.moneyEarned.kind, p2.moneyTotal.kind], ["none", "none", "none"],
    "🔴 людина без плану по дзвінках/грошах отримала відсоток замість «плану немає»");
  // Команда: план — лише в того, хто має; факт — усіх рядків (як прорахунки).
  const t = v.team.extra;
  assert.ok(t.calls.kind === "plan" && t.calls.fact === 1200 && t.calls.plan === 1000, "🔴 дзвінки команди: факт не всіх рядків або план не Σ");
  assert.ok(t.moneyTotal.kind === "plan" && t.moneyTotal.fact === 35_000 && t.moneyEarned.kind === "plan" && t.moneyEarned.fact === 25_000,
    "🔴 гроші команди: факт не Σ усіх рядків або два порівняння злиплись");
});

import { planPace, isCurrentFullMonth } from "./leadgenPlanRules.js";

/**
 * #1261 — НОРМА З НАЗДОГАНЯННЯМ (рішення власника 05.10.2026). Жовтень 2026 — 22 робочі дні; 15.10 (чт) лишається 12.
 * План 1 430: зроблено 500 до сьогодні → треба 78 (рівна була б 65); 800 → 53; виконано → «план виконано»; субота →
 * норма на наступний робочий день; 30.10 (останній робочий) → увесь залишок; 31.10 (сб) → робочих днів немає; плану немає → нічого.
 * 🧨 САБОТАЖ: у `planPace` `(i.plan - i.before)` → `i.plan` (без віднімання зробленого) → норма не наздоганяє → червоніє.
 */
test("#1261 НОРМА З НАЗДОГАНЯННЯМ: відстав — більше, випереджаєш — менше, виконав — ✓; вихідні й кінець місяця", () => {
  const E = "2026-10-31";
  const behind = planPace({ plan: 1430, before: 500, today: 30, todayDay: "2026-10-15", monthEnd: E });
  assert.deepEqual(behind, { kind: "pace", plan: 1430, fact: 530, leftMonth: 900, normToday: 78, doneToday: 30, leftToday: 48, leftWeek: 126, todayIsWorking: true },
    "🔴 відставання: не 78 на сьогодні / 48 лишилось / 126 на тиждень (15–16.10)");
  const ahead = planPace({ plan: 1430, before: 800, today: 0, todayDay: "2026-10-15", monthEnd: E });
  assert.ok(ahead.kind === "pace" && ahead.normToday === 53, "🔴 випередження не зменшує норму нижче рівної 65");
  assert.equal(planPace({ plan: 1430, before: 1400, today: 40, todayDay: "2026-10-15", monthEnd: E }).kind, "done", "🔴 виконаний план показує норму");
  const sat = planPace({ plan: 1430, before: 500, today: 0, todayDay: "2026-10-17", monthEnd: E });
  assert.ok(sat.kind === "pace" && !sat.todayIsWorking && sat.normToday === 93 && sat.leftToday === 93,
    "🔴 субота: норма не на наступний робочий день (930 ÷ 10 = 93)");
  const last = planPace({ plan: 1430, before: 1300, today: 10, todayDay: "2026-10-30", monthEnd: E });
  assert.ok(last.kind === "pace" && last.normToday === 130 && last.leftToday === 120, "🔴 останній робочий день: не весь залишок");
  const over = planPace({ plan: 1430, before: 1300, today: 0, todayDay: "2026-10-31", monthEnd: E });
  assert.ok(over.kind === "pace" && over.normToday === null && over.leftMonth === 130, "🔴 після останнього робочого дня вигадана норма");
  assert.equal(planPace({ plan: null, before: 5, today: 1, todayDay: "2026-10-15", monthEnd: E }).kind, "none");
  assert.equal(isCurrentFullMonth("2026-10-01", "2026-10-31", "2026-10-15"), true);
  assert.equal(isCurrentFullMonth("2026-09-01", "2026-09-30", "2026-10-15"), false, "🔴 минулий місяць — є що наздоганяти?");
  assert.equal(isCurrentFullMonth("2026-10-12", "2026-10-18", "2026-10-15"), false, "🔴 тиждень прийнято за місяць");
});
