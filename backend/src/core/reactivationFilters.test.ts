import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { passesFilter, byMarginDesc, isReturned, RETURN_GAP_DAYS, VIP_SLEEP_DAYS } from "./reactivationFilters.js";

/**
 * #692 — ФІЛЬТРИ РЕАКТИВАЦІЇ по обидва боки кожної межі: «без розмови» = lastTalk null; «прострочений
 * крок» = лише state overdue (today/planned — ні); «VIP спить» = vip І ≥14 днів (13 — ні, regular
 * з 14 — ні); «стоп: дебіторка» = прапорець; фільтр по менеджеру накладається на будь-який.
 * Сортування за маржею: більша зверху, null унизу. «Повернуто» = пауза ≥ 60 днів; без попередньої
 * оплати — не повернутий. Червоніє на зміщенні порогів або перевернутому порядку null.
 */
test("#692 фільтри реактивації: межі no_talk / step_overdue / vip_sleeping / debt_hold, менеджер, маржа, повернуто", () => {
  const base = { lastTalk: "2026-09-01", nextStepState: "planned" as const, segment: "regular", daysSince: 5, managerId: 1, debtHold: false };
  assert.equal(passesFilter(base, "all", null), true);
  assert.equal(passesFilter({ ...base, lastTalk: null }, "no_talk", null), true);
  assert.equal(passesFilter(base, "no_talk", null), false, "🪞 з розмовою — не «без розмови»");
  assert.equal(passesFilter({ ...base, nextStepState: "overdue" }, "step_overdue", null), true);
  assert.equal(passesFilter({ ...base, nextStepState: "today" }, "step_overdue", null), false, "сьогодні — ще не прострочено");
  assert.equal(passesFilter({ ...base, segment: "vip", daysSince: VIP_SLEEP_DAYS }, "vip_sleeping", null), true);
  assert.equal(passesFilter({ ...base, segment: "vip", daysSince: VIP_SLEEP_DAYS - 1 }, "vip_sleeping", null), false);
  assert.equal(passesFilter({ ...base, segment: "regular", daysSince: 40 }, "vip_sleeping", null), false, "не VIP — не в цьому фільтрі");
  assert.equal(passesFilter({ ...base, debtHold: true }, "debt_hold", null), true);
  assert.equal(passesFilter(base, "debt_hold", null), false);
  assert.equal(passesFilter(base, "all", 2), false, "чужий менеджер відсікається");
  assert.equal(passesFilter(base, "all", 1), true);
  const sorted = [{ margin6m: null }, { margin6m: 100 }, { margin6m: 900 }].sort(byMarginDesc);
  assert.deepEqual(sorted.map((x) => x.margin6m), [900, 100, null], "null унизу, не зверху");
  assert.equal(RETURN_GAP_DAYS, 60);
  assert.equal(isReturned("2026-09-10", "2026-07-12"), true, "60 днів рівно — повернутий");
  assert.equal(isReturned("2026-09-10", "2026-07-13"), false, "59 днів — ні");
  assert.equal(isReturned("2026-09-10", null), false, "без попередньої оплати — новий, не повернутий");
});

/**
 * #692b — ПРОВОДКА: рядок плану несе margin6m (Σ price paid за 6 міс — ті самі гроші, що на Звіті,
 * без «Расходу 1») і debtHold з receivables.overdue_days > 0; підсумки — три цифри через isReturned
 * із чистого модуля; фронт має чотири фільтри, режим «за маржею» і три картки. Читає джерело.
 */
test("#692b РОУТ /client-plans: margin6m, debtHold, три цифри через isReturned; фронт — фільтри, сортування, картки", () => {
  const src = path.join(import.meta.dirname, "..", "..", "src");
  const d = readFileSync(path.join(src, "routes", "dashboard.ts"), "utf8");
  const i = d.indexOf('dashboardRouter.get("/client-plans"'); const body = d.slice(i, d.indexOf("\n});", i));
  assert.match(body, /margin6m: \(\(\) => \{ const a = histByKey\.get\(c\.client_key\)/, "маржа не з помісячних бакетів ядра (hist)");
  assert.match(body, /a\.slice\(-6\)/, "маржа має бути за останні 6 місяців");
  assert.doesNotMatch(body, /SUM\(d\.price\) AS margin/, "власний SQL по грошах — повз ядро (#17c)");
  assert.doesNotMatch(body, /carrier_obligation/, "маржа тут — price, «Расход 1» не потрібен");
  assert.match(body, /FROM receivables WHERE overdue_days > 0/, "стоп через дебіторку не з прострочення");
  assert.match(body, /debtHold: debtKeys\.has\(c\.client_key\)/);
  assert.match(body, /\bisReturned\(r\.first_m, r\.last_before\)/, "«повернуто» не через чисте правило");
  assert.match(body, /react: \{ inWork:[\s\S]*returnedMonth: returned\.count, returnedMargin: returned\.margin, gapDays: RETURN_GAP_DAYS \}/);
  const f = readFileSync(path.join(src, "..", "..", "frontend", "src", "pages", "dashboard", "sections", "ClientPlansSection.tsx"), "utf8");
  for (const k of ['"no_talk"', '"step_overdue"', '"vip_sleeping"', '"debt_hold"', '["margin", "за маржею 6 міс"]', "повернуто за місяць", "повернутої маржі", "в роботі (реактивація)"])
    assert.ok(f.includes(k), `фронт: немає ${k}`);
});
