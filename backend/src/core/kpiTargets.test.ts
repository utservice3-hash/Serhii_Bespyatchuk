import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { accumulateKpiTargets, type KpiUmbrella, type KpiDayPlan } from "./kpiTargets.js";

/**
 * #80 — МІСЯЧНА ЦІЛЬ ПО ПОКАЗНИКАХ ЗНЯТА, ФАКТ ЛИШИВСЯ.
 *
 * Рішення власника 18.08.2026: ціль по показниках живе на ТИЖНІ; місяць лишається
 * фактом. Доти `/report-plan` брав парасольки БЕЗ фільтра рівня періоду, тож місячна
 * ціль підмішувалась у будь-який період, зокрема й у тижневий.
 *
 * 🔴 ПАСТКА, ЗАРАДИ ЯКОЇ І СТОЇТЬ `#80b`: місячна парасолька має приховані ДЕННІ
 * діти (21 шт. на місяць). Прибрати її з розрахунку «в лоб» — і її дні стають
 * нічийними, спрацьовує daily-фолбек, і та сама ціль повертається розкладеною по
 * днях. Тобто зняття виглядало б як зняття, а число лишилось би.
 */
const MGR = 7;
const M = (metric: string, target: number) => ({ metric, target });

/** Тиждень 2026-08-10..16 (5 роб. днів) і місяць 2026-08-01..31 (21 роб. день). */
const weekUmb: KpiUmbrella = { assigneeId: MGR, from: "2026-08-10", to: "2026-08-16", kind: "week",
  metrics: [M("ads_count", 25), M("conversion", 30)] };
const monthUmb: KpiUmbrella = { assigneeId: MGR, from: "2026-08-01", to: "2026-08-31", kind: "month",
  metrics: [M("ads_count", 100), M("conversion", 55)] };
/** Діти МІСЯЧНОЇ парасольки — рівно те, що просочилось би без карти покриття. */
const monthKids: KpiDayPlan[] = ["2026-08-03", "2026-08-04", "2026-08-05"].map((d) => ({
  assigneeId: MGR, day: d, metrics: [M("ads_count", 5)] }));

test("#80 ЦІЛЬ БЕРЕТЬСЯ З ТИЖНЕВОЇ ПАРАСОЛЬКИ, МІСЯЧНА — НІ", () => {
  const onlyWeek = accumulateKpiTargets([weekUmb], [], "2026-08-10", "2026-08-16").get(MGR);
  assert.equal(onlyWeek?.ads_count, 25, "🔴 тижнева ціль перестала читатись — зламали не те");
  assert.equal(onlyWeek?.conversion, 30, "🔴 ставкова тижнева ціль загубилась");

  const withMonth = accumulateKpiTargets([weekUmb, monthUmb], [], "2026-08-10", "2026-08-16").get(MGR);
  assert.equal(withMonth?.ads_count, 25,
    "🔴 місячна ціль знову підмішується до тижневої (було: 25 + частка від 100)");
  assert.equal(withMonth?.conversion, 30,
    "🔴 ставкова місячна ціль перебила тижневу через MAX (55 замість 30)");

  const monthOnly = accumulateKpiTargets([monthUmb], [], "2026-08-01", "2026-08-31").get(MGR);
  assert.equal(monthOnly, undefined,
    "🔴 у місячному вигляді без тижневих задач зʼявилась ціль — місячну ціль не знято");
});

test("#80b ДІТИ МІСЯЧНОЇ ПАРАСОЛЬКИ НЕ ПРОСОЧУЮТЬСЯ ЧЕРЕЗ DAILY-ФОЛБЕК", () => {
  const covered = accumulateKpiTargets([monthUmb], monthKids, "2026-08-01", "2026-08-31").get(MGR);
  assert.equal(covered, undefined,
    "🔴 денні діти місячної парасольки полічені як «нічийні» — знята ціль повернулась "
    + "через задні двері, лише розкладена по днях");
  // 🪞 Дзеркало: daily-фолбек НЕ вбитий — дні ПОЗА будь-якою парасолькою рахуються.
  const orphan = accumulateKpiTargets([], monthKids, "2026-08-01", "2026-08-31").get(MGR);
  assert.equal(orphan?.ads_count, 15,
    "🔴 daily-фолбек перестав працювати взагалі — менеджери без парасольки втратять цілі");
});

test("#80c ЧАСТКА ПЕРІОДУ ЗБЕРЕЖЕНА: пів тижня → пів цілі", () => {
  // Пн–Ср із тижня Пн–Нд: 3 робочі дні з 5 → 25 × 3/5 = 15.
  const half = accumulateKpiTargets([weekUmb], [], "2026-08-10", "2026-08-12").get(MGR);
  assert.equal(half?.ads_count, 15, "🔴 апортування по робочих днях зламалось");
  assert.equal(half?.conversion, 30, "🔴 ставкову ціль поділили — конверсія не ділиться");
});

/**
 * #80d — ФАКТ ПОКАЗУЄТЬСЯ НАВІТЬ БЕЗ ЦІЛІ. Це друга половина рішення: місячну ціль
 * знято, але цифри місяця мусять лишитись на екрані. Перевіряємо ДЖЕРЕЛО компонента
 * `Kpi`: він завжди друкує факт, а відсутність цілі підписує словами.
 */
test("#80d БЛОК ПОКАЗНИКІВ МАЛЮЄ ФАКТ І БЕЗ ВИСТАВЛЕНОЇ ЦІЛІ", () => {
  const sec = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src",
    "pages", "dashboard", "sections", "ReportPlanSection.tsx"), "utf8");
  const kpi = sec.split("function Kpi(")[1]?.slice(0, 1200) ?? "";
  assert.ok(kpi.length > 0, "🔴 компонента `Kpi` немає — перевіряти нічого");
  assert.ok(/const f = fact == null \? "—"/.test(kpi),
    "🔴 факт більше не форматується безумовно");
  assert.ok(/план не задано/.test(kpi),
    "🔴 зник підпис «план не задано» — метрика без цілі читатиметься як зламана");
  assert.equal(/if \(!has\) return null/.test(kpi), false,
    "🔴 метрика без цілі ХОВАЄТЬСЯ — після зняття місячної цілі місяць спорожнів би");
  assert.ok(/📅 Показники\{isMonthMode \? "" : ` · \$\{periodLabel\}`\}/.test(sec),
    "🔴 заголовок блоку знову жорсткий («Місяць · показники») — при виборі тижня бреше");
});

/**
 * #80e — ВХІД МІСЯЧНОГО ПЛАНУ ПРИБРАНО З ЗАДАЧНИКА, ТИЖНЕВИЙ ЖИВИЙ.
 * 🪞 Друга половина обовʼязкова: без неї гейт зеленів би й тоді, коли зламано ОБИДВА.
 */
test("#80e ЗАДАЧНИК: місячного плану немає, тижневий лишився", () => {
  const fe = path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages");
  const tasks = readFileSync(path.join(fe, "dashboard", "sections", "TasksSection.tsx"), "utf8");
  const form = readFileSync(path.join(fe, "dashboard", "taskForm.ts"), "utf8");
  const dash = readFileSync(path.join(fe, "Dashboard.tsx"), "utf8");
  assert.equal(/<option value="monthly_kpi">/.test(tasks), false,
    "🔴 опція «Місячний план (KPI)» повернулась у Задачник");
  assert.ok(/<option value="weekly_kpi">/.test(tasks),
    "🔴 дзеркало: тижневий план зник із Задачника — зламали обидва шляхи, а не один");
  assert.equal(/"monthly_kpi"/.test(form), false,
    "🔴 тип monthly_kpi знову в union — форма прийме місячний план");
  assert.equal(/taskForm\.taskType === "weekly_kpi" \? "week" : "month"/.test(dash), false,
    "🔴 відправка знову вміє period:'month'");
  assert.ok(/period: "week",/.test(dash),
    "🔴 дзеркало: тижневий шлях відправки зник");
});
