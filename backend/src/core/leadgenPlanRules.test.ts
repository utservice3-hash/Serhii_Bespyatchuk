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
  assert.deepEqual(planForPeriod(ap, "2026-09-01", "2026-09-30"), { leads: 220, opr: 88, quotes: 44 });
  // вересень 2026 — 22 робочі дні; 14–20.09 — 5 із них
  assert.deepEqual(planForPeriod(ap, "2026-09-14", "2026-09-20"), { leads: 50, opr: 20, quotes: 10 });
  assert.deepEqual(planForPeriod(ap, "2026-09-28", "2026-10-04"), { leads: null, opr: null, quotes: null },
    "🔴 жовтня без плану — а план періоду вийшов числом");
  assert.deepEqual(planForPeriod(new Map(), "2026-09-01", "2026-09-30"), { leads: null, opr: null, quotes: null });
  const partial: ApprovedByMonth = new Map([["2026-09-01", { quotes: 44 }]]);
  assert.deepEqual(planForPeriod(partial, "2026-09-01", "2026-09-30"), { leads: null, opr: null, quotes: 44 });
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
  assert.deepEqual({ ...v.team, exec: undefined }, { total: 2, planned: 1, fact: 14, plan: 22, exec: undefined },
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
  assert.deepEqual(ok, { ok: true, managerId: 5, month: "2026-10-01", values: { leads: 200, opr: 80, quotes: 40 }, comment: "ок" });
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
