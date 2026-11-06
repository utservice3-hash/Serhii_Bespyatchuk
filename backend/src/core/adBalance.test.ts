import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorFromCabinet, computeAdBalance, AD_PAYMENTS_SQL, AD_VAT, AD_COSTS_SQL, AD_DAY_COST_SQL, AD_SYNCED_SQL } from "./adBalance.js";

/**
 * #7140 — БАЛАНС РЕКЛАМНОГО КАБІНЕТУ: ПДВ ДІЛЕННЯМ, ВИТРАТИ ×1,2, СЕРЕДНЯ БЕЗ СЬОГОДНІ, ЗВІРКА З КАБІНЕТОМ (30.10.2026).
 *
 * На числах реального звіряння 30.10: від нуля з 01.06 оплати 875 000 і витрати GA4 704 623 дають ~29 452 —
 * кабінет показав 29 205,81. Якщо ПДВ почнуть знімати «−20%», залишок піде в мінус — гейт червоніє.
 *
 * 🧨 Червоніє, якщо: ПДВ знімається не діленням на 1,2; витрати GA4 перестануть множитись на 1,2; оплати до точки
 * звірки потраплять у суму; сьогоднішній неповний день піде в середню; звірка з кабінетом не поверне сьогоднішні
 * витрати в точку початку дня; поповнення почнуть братись не з ТОВ «ГУГЛ».
 */
test("#7140 БАЛАНС КАБІНЕТУ: ×1,2 на витратах, ÷1,2 для без ПДВ, середня без сьогодні, звірка з кабінетом", () => {
  assert.equal(AD_VAT, 1.2);
  const anchor = { asOf: "2026-06-01", balance: 0 };
  const b = computeAdBalance(anchor,
    [{ day: "2026-05-31", amount: 999_999 }, { day: "2026-06-01", amount: -875_000 }],
    [{ day: "2026-06-01", cost: 704_623 - 7 * 3_000 - 117 },
     ...Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(23 + i).padStart(2, "0")}`, cost: 3_000 })),
     { day: "2026-10-30", cost: 117 }],
    "2026-10-30");
  assert.equal(b.paidSince, 875_000, "🔴 у поповнення потрапила оплата ДО точки звірки, або мінус банку не знято");
  assert.equal(b.spentSince, 845_547.6, "🔴 витрати GA4 не помножено на 1,2 (кабінет списує з ПДВ)");
  assert.equal(b.balance, 29_452.4, "🔴 залишок не той, що звірили з кабінетом 30.10");
  assert.equal(b.balanceNet, 24_543.67, "🔴 без ПДВ — не ділення на 1,2");
  assert.equal(b.avgDaily, 3_600, "🔴 у середню потрапив неповний сьогоднішній день");
  assert.equal(b.daysLeft, 8.2);
  assert.equal(b.low, false);
  assert.deepEqual(b.lastPayment, { day: "2026-06-01", amount: 875_000 });

  const low = computeAdBalance({ asOf: "2026-10-29", balance: 10_000 }, [],
    Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(22 + i).padStart(2, "0")}`, cost: 3_000 })), "2026-10-29");
  assert.equal(low.low, true, "🔴 менше 5 днів до нуля — а тривоги немає");

  const a = anchorFromCabinet(29_205.81, 116.92, "2026-10-30");
  assert.deepEqual(a, { asOf: "2026-10-30", balance: 29_346.11 },
    "🔴 звірка не повернула сьогоднішні витрати (з ПДВ) у залишок на початок дня — їх списало б двічі");

  assert.match(AD_PAYMENTS_SQL, /counterparty_name ILIKE '%гугл%'/, "🔴 поповнення беруться не з ТОВ «ГУГЛ»");
});

/**
 * #7140b — МЕЖА «ТІЛЬКИ АДМІНИ»: обидва маршрути балансу під requireRole("admin"), і в матриці тімлід — у deny.
 * 🧨 Червоніє, якщо зняти requireRole з GET чи POST або відкрити тімліду в матриці (вкладка «Реклама» в нього є).
 */
test("#7140b БАЛАНС КАБІНЕТУ — ЛИШЕ АДМІНИ: requireRole на обох маршрутах, тімлід у deny", () => {
  const routes = readFileSync(path.join(import.meta.dirname, "..", "routes", "dashboard.js"), "utf8");
  assert.match(routes, /dashboardRouter\.get\("\/ads\/balance", \(0, _?middleware_js_?\d*\.requireRole\)\("admin"\)|dashboardRouter\.get\("\/ads\/balance", requireRole\("admin"\)/,
    "🔴 GET балансу без requireRole(\"admin\")");
  assert.match(routes, /dashboardRouter\.post\("\/ads\/balance", requireRole\("admin"\)/, "🔴 POST звірки без requireRole(\"admin\")");
  const matrix = readFileSync(path.join(import.meta.dirname, "..", "auth", "accessMatrix.js"), "utf8");
  const row = matrix.match(/path: "\/api\/dashboard\/ads\/balance", cls: "GET",\s*allow: \[([^\]]*)\], deny: \[([^\]]*)\]/);
  assert.ok(row, "🔴 немає рядка матриці для GET /api/dashboard/ads/balance");
  assert.ok(row![2].includes('"team_lead"') && !row![1].includes('"team_lead"'), "🔴 тімлід бачить баланс кабінету");
});

/**
 * #7140c — СВІЖА ВИТРАТА ДНЯ (заміряно 05.11.2026). GA4 приходить раз на добу о 06:00, тож сьогодні в ньому 241 грн при
 * реальних 7 448 — і залишок був на ~8 700 вищий за кабінет. Аркуш бюджету синкається щогодини й за повні дні
 * збігається з GA4. Беремо більше з двох.
 * 🧨 Червоніє, якщо витрати знову беруться лише з GA4, аркуш перекриває GA4 замість GREATEST, у суму потрапляють
 * заготовлені майбутні дні аркуша, звірка з кабінетом рахує сьогоднішню витрату іншим правилом або «станом на» забуде аркуш.
 */
test("#7140c БАЛАНС КАБІНЕТУ: витрата дня — більше з GA4 і аркуша бюджету, без майбутніх днів аркуша; звірка тим самим правилом", () => {
  for (const sql of [AD_COSTS_SQL, AD_DAY_COST_SQL]) {
    assert.match(sql, /FROM ad_ga4_daily/, "🔴 зникло GA4");
    assert.match(sql, /FROM ad_budget_daily/, "🔴 немає аркуша бюджету — сьогоднішня витрата знову нуль до 06:00 наступного дня");
    assert.match(sql, /GREATEST\(COALESCE\(g\.cost, 0\), COALESCE\(b\.cost, 0\)\)/, "🔴 не «більше з двох»");
    assert.match(sql, /FULL JOIN/, "🔴 день, що є лише в одному джерелі, випадає");
    assert.match(sql, /day <= \(now\(\) AT TIME ZONE 'Europe\/Kyiv'\)::date\)/, "🔴 майбутні заготовлені дні аркуша потрапляють у витрати");
  }
  assert.match(AD_SYNCED_SQL, /ad_budget_daily/, "🔴 «станом на» не бачить щогодинного аркуша");
  const routes = readFileSync(path.join(import.meta.dirname, "..", "routes", "dashboard.js"), "utf8");
  assert.doesNotMatch(routes, /SELECT sum\(cost\) AS cost FROM ad_ga4_daily WHERE day = \$1::date/, "🔴 звірка рахує сьогоднішню витрату лише з GA4");
});
