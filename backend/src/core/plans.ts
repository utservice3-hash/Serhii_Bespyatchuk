import { pool } from "../db/pool.js";
import { workingDaysBetween, monthEndOf, fixedWeekBlocks } from "./dates.js";
import { weekPlansForMonth } from "./weekPlan.js";
import { receivedByMgr } from "./money.js";

/**
 * ЄДИНЕ ДЖЕРЕЛО «плану на менеджера для ДИСПЛЕЮ» (цеглина 1 міграції, рішення власника).
 *
 * 🎯 Контракт: план(менеджер) = власний БАЗОВИЙ план (активного) + РІВНОМІРНА частка
 * планів ДЕАКТИВОВАНИХ одноплемінників (точний залишок → першому по id, як у fix #3).
 * 0 активних у команді → план звільнених не зникає, а стає ОРФАНОМ (`orphanPlanByTeam`).
 * Σ (усі rows.plan + orphanPlanByTeam) зводиться до цілі команди/відділу (2 700 000).
 *
 * ⚠️ Це план САМЕ ДЛЯ ПОКАЗУ (світлофор Звіту 2.0, drill /teams). Редактор `plans-grid`
 * лишається на СИРОМУ базовому плані й НЕ ходить через цю функцію — рішення власника.
 *
 * 🔴 Раніше розподіл жив інлайном лише в `buildPeriod` (dashboard.ts), а `/teams` показував
 * сирий актив-план → живий розрив (team14: −25 000). Тепер обидва місця кличуть це ядро.
 */

export interface PlanScope {
  teamId?: number | null;
  month: string; // YYYY-MM-01 (перше число місяця плану)
}

export interface ManagerPlanRow {
  managerId: number;
  name: string;
  teamId: number | null;
  basePlan: number;  // власний план (активного)
  sharePlan: number; // частка планів звільнених одноплемінників
  plan: number;      // basePlan + sharePlan (для показу)
}

export interface ManagerPlanResult {
  rows: ManagerPlanRow[];                 // по одному рядку на АКТИВНОГО менеджера
  orphanPlanByTeam: Map<number, number>;  // teamId → план звільнених там, де 0 активних
}

export async function managerPlan(s: PlanScope): Promise<ManagerPlanResult> {
  const params: unknown[] = [s.month];
  const teamCond = s.teamId ? `AND m.team_id = $2` : "";
  if (s.teamId) params.push(s.teamId);

  const [ownRes, aggRes, namesRes] = await Promise.all([
    // власний план АКТИВНИХ менеджерів
    pool.query<{ manager_id: number; s: string }>(
      `SELECT p.manager_id, COALESCE(SUM(p.planned_value),0) s
         FROM plans p JOIN managers m ON m.id = p.manager_id
        WHERE p.metric='payment_amount' AND date_trunc('month',p.plan_date) = $1::date
          AND m.is_active ${teamCond}
        GROUP BY p.manager_id`, params),
    // по команді: Σ планів ДЕАКТИВОВАНИХ + к-сть АКТИВНИХ (для розподілу)
    pool.query<{ team_id: number; deact: string; nactive: string }>(
      `SELECT m.team_id,
              COALESCE(SUM(p.planned_value) FILTER (WHERE NOT m.is_active),0) deact,
              COUNT(DISTINCT m.id) FILTER (WHERE m.is_active) nactive
         FROM managers m
         LEFT JOIN plans p ON p.manager_id = m.id AND p.metric='payment_amount'
                          AND date_trunc('month',p.plan_date) = $1::date
        WHERE m.team_id IS NOT NULL ${teamCond}
        GROUP BY m.team_id`, params),
    // активні менеджери (ростер) — ORDER BY id, щоб залишок ішов першому по id (як fix #3)
    pool.query<{ id: number; name: string; team_id: number | null }>(
      s.teamId
        ? `SELECT id, name, team_id FROM managers WHERE is_active AND team_id = $1 ORDER BY id`
        : `SELECT id, name, team_id FROM managers WHERE is_active ORDER BY id`,
      s.teamId ? [s.teamId] : []),
  ]);

  const ownPlan = new Map(ownRes.rows.map((r) => [r.manager_id, Math.round(Number(r.s))]));
  const agg = new Map(aggRes.rows.map((r) => [r.team_id, { deact: Math.round(Number(r.deact)), nactive: Number(r.nactive) }]));

  // Розподіл планів звільнених рівномірно на активних одноплемінників (точний залишок).
  const activeByTeam = new Map<number | null, { id: number; name: string; team_id: number | null }[]>();
  for (const r of namesRes.rows) {
    if (!activeByTeam.has(r.team_id)) activeByTeam.set(r.team_id, []);
    activeByTeam.get(r.team_id)!.push(r);
  }
  const share = new Map<number, number>();
  for (const [tid, members] of activeByTeam) {
    const a = tid != null ? agg.get(tid) : undefined;
    if (!a || a.deact <= 0 || members.length === 0) continue;
    const base = Math.floor(a.deact / members.length);
    let rem = a.deact - base * members.length; // залишок → першим по id
    for (const mm of members) { share.set(mm.id, base + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
  }

  const rows: ManagerPlanRow[] = namesRes.rows.map((r) => {
    const basePlan = ownPlan.get(r.id) ?? 0;
    const sharePlan = share.get(r.id) ?? 0;
    return { managerId: r.id, name: r.name, teamId: r.team_id, basePlan, sharePlan, plan: basePlan + sharePlan };
  });

  const orphanPlanByTeam = new Map<number, number>();
  for (const [tid, a] of agg) {
    if (tid != null && a.nactive === 0 && a.deact > 0) orphanPlanByTeam.set(tid, a.deact);
  }

  return { rows, orphanPlanByTeam };
}

export interface PlanPerDay {
  monthPlan: number;      // місячний план виручки у scope (Σ planned_value, payment_amount)
  workingDays: number;    // робочі дні (Пн–Пт) у місяці
  perWorkingDay: number;  // monthPlan ÷ workingDays (округлено)
}

/**
 * BE-5 «План на день» — місячний план (`plans`, metric='payment_amount') у scope,
 * поділений на робочі дні місяця. Тижневий план лишається у `money.weeklyBreakdown`
 * (розкидає залишок на роб. дні незавершених тижнів); це рівний денний темп для дисплею.
 * `month` = 'YYYY-MM-01'. Scope-aware (менеджер / команда / відділ).
 */
export async function planPerWorkingDay(s: { managerId?: number | null; teamId?: number | null }, month: string): Promise<PlanPerDay> {
  const params: unknown[] = [month];
  const conds = ["p.metric='payment_amount'", "date_trunc('month',p.plan_date) = $1::date"];
  if (s.managerId) { params.push(s.managerId); conds.push(`p.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(p.planned_value),0) s
       FROM plans p JOIN managers m ON m.id = p.manager_id
      WHERE ${conds.join(" AND ")}`,
    params
  );
  const monthPlan = Math.round(Number(r.rows[0]?.s ?? 0));
  const [y, mo] = month.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, mo - 1, d).getDay();
    if (dow !== 0 && dow !== 6) workingDays++;
  }
  return { monthPlan, workingDays, perWorkingDay: workingDays > 0 ? Math.round(monthPlan / workingDays) : 0 };
}

// ───────────────────────── СТРАТЕГІЧНИЙ ПЛАН + ДЕРИВАЦІЯ (Крок Г #6) ─────────────────────────

// СТРАТЕГІЧНИЙ план виручки БІЛЬШЕ НЕ рахується окремо: /kvp-report бере його як
// Σ планів команд (managerPlan → teams.plan), щоб вердикт == рядки таблиці байт-у-байт.
// Стара strategicRevenuePlan фільтрувала m.is_active і мовчки губила план звільнених
// (25к) → 2.675М ≠ таблиця 2.700М. managerPlan лишається ЄДИНИМ джерелом планів.

export interface DerivedTarget { base: number; low: number; target: number; high: number }
/**
 * Деривація місячного плану «+10%» (коридор 10–15%, рішення власника Крок Г #6) від
 * бази (напр. факт минулого місяця / стратегічний план): target = base×1.10,
 * коридор [base×1.10 … base×1.15]. Чиста функція (без БД).
 */
export function deriveMonthlyTarget(base: number, upliftLow = 0.10, upliftHigh = 0.15): DerivedTarget {
  return {
    base: Math.round(base),
    low: Math.round(base * (1 + upliftLow)),
    target: Math.round(base * (1 + upliftLow)),
    high: Math.round(base * (1 + upliftHigh)),
  };
}

export interface PlanRecMonth { month: string; revenue: number; deals: number }
export interface PlanRecommendation {
  recommendation: number;        // = round(perWorkingDay × targetWorkingDays × (1+growthPct))
  perWorkingDay: number;         // = round(baseSum ÷ baseWorkingDays) — ДЕННИЙ ТЕМП (headline-драйвер)
  baseSum: number;               // Σ(won 3 повні міс) (won 142 по closed_at, signed)
  baseWorkingDays: number;       // Σ робочих днів місяців бази З ФАКТОМ (Пн–Пт)
  targetWorkingDays: number;     // робочі дні target-місяця (Пн–Пт)
  baseMonthlyAvg: number;        // Σ ÷ 3 — ЛИШЕ довідково (headline = weighted, не це)
  growthPct: number;
  baseMonths: PlanRecMonth[];    // 3 повні місяці бази (0 де немає)
  sparseHistory: boolean;        // <3 місяців із фактом → рекомендація орієнтовна
}

/**
 * РЕКОМЕНДАЦІЯ плану на target-місяць — ЧИСТА функція (без БД), щоб бари-історія і база
 * рекомендації рахувались з ОДНИХ чисел (викликач передає ті самі `successByManagerMonth`).
 * WEIGHTED (денний темп, рішення власника): менеджер робить X ₴/день + ріст.
 *   perWorkingDay  = Σ(won 3 повні міс) ÷ Σ(робочі дні цих міс)      ← won 142 по closed_at, signed
 *   recommendation = perWorkingDay × робочі_дні(target) × (1+growthPct)
 * Підпис макета «X ₴/день × N роб.дні × 1.10» → МАТЕМАТИЧНО ТОЧНИЙ (не приблизний):
 * headline рахується САМЕ з відображених perWorkingDay/targetWorkingDays. Поточний неповний
 * місяць у базу НЕ входить. `baseMonthlyAvg` (Σ÷3) — лише довідково, НЕ headline.
 * <3 місяців із фактом → `sparseHistory`; дільник = робочі дні ЛИШЕ місяців із фактом
 * (новий менеджер: денний темп по наявних, без розмивання «порожніми» місяцями).
 */
export function planRecommendation(baseMonths: PlanRecMonth[], targetMonth: string, growthPct = 0.10): PlanRecommendation {
  const withData = baseMonths.filter((m) => m.deals > 0);
  const baseSum = baseMonths.reduce((a, m) => a + m.revenue, 0);
  const baseWorkingDays = withData.reduce((a, m) => a + workingDaysBetween(m.month.slice(0, 7) + "-01", monthEndOf(m.month)), 0);
  const perWorkingDay = baseWorkingDays > 0 ? Math.round(baseSum / baseWorkingDays) : 0;
  const targetWorkingDays = workingDaysBetween(targetMonth.slice(0, 7) + "-01", monthEndOf(targetMonth));
  return {
    recommendation: Math.round(perWorkingDay * targetWorkingDays * (1 + growthPct)),
    perWorkingDay, baseSum: Math.round(baseSum), baseWorkingDays, targetWorkingDays,
    baseMonthlyAvg: Math.round(baseSum / (baseMonths.length || 1)),
    growthPct, baseMonths,
    sparseHistory: withData.length < 3,
  };
}

/** 3 повні місяці перед `targetMonth` ('YYYY-MM-01') → ['YYYY-MM-01' × 3] у порядку зростання. */
export function baseMonthsFor(targetMonth: string): string[] {
  const [y, m] = targetMonth.split("-").map(Number);
  return [3, 2, 1].map((back) => new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10));
}

// ───────────────────────── ДИНАМІЧНА ЦІЛЬ (Звіт Phase 2) ─────────────────────────
// «План НЕ зменшується — менше робочих днів → вища ціль на присутні дні». Рахує ПЕР-
// МЕНЕДЖЕРА (команда/відділ = Σ менеджерів → Σ-інваріант тримається: weeksLeft спільний
// для всіх, тож Σ(remaining/weeksLeft) = (Σplan−Σfact)/weeksLeft). Live (не морозиться).
// Тижні — ISO Пн–Нд, нарізані від 1-го числа (`fixedWeekBlocks`) — ЄДИНА дефініція.

/** ПРИСУТНІ робочі дні по менеджеру в [from,to]: Пн–Пт МІНУС держсвята МІНУС approved-
 *  відсутності (day_off/vacation/sick; short_day лишає день присутнім). БАТЧЕМ (2 запити
 *  на всю команду, не по менеджеру). Дзеркалить логіку `GET /api/duty/presence`. */
export async function presentWorkingDaysByManager(managerIds: number[], from: string, to: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!managerIds.length) return out;
  const hol = new Set((await pool.query<{ d: string }>(
    `SELECT to_char(holiday_date,'YYYY-MM-DD') d FROM company_holidays WHERE holiday_date BETWEEN $1 AND $2`, [from, to])).rows.map((r) => r.d));
  const abs = (await pool.query<{ manager_id: number; s: string; e: string }>(
    `SELECT manager_id, to_char(start_date,'YYYY-MM-DD') s, to_char(end_date,'YYYY-MM-DD') e
       FROM team_calendar_absences
      WHERE status='approved' AND kind IN ('day_off','vacation','sick')
        AND manager_id = ANY($1) AND start_date <= $3 AND end_date >= $2`, [managerIds, from, to])).rows;
  const absByMgr = new Map<number, { s: string; e: string }[]>();
  for (const a of abs) { const arr = absByMgr.get(a.manager_id) ?? []; arr.push({ s: a.s, e: a.e }); absByMgr.set(a.manager_id, arr); }
  for (const mid of managerIds) {
    const ranges = absByMgr.get(mid) ?? [];
    let n = 0; const d = new Date(from + "T00:00:00Z"); const end = new Date(to + "T00:00:00Z");
    while (d.getTime() <= end.getTime()) {
      const ds = d.toISOString().slice(0, 10); const dow = d.getUTCDay();
      const working = dow !== 0 && dow !== 6 && !hol.has(ds);
      const absent = ranges.some((r) => ds >= r.s && ds <= r.e);
      if (working && !absent) n++;
      d.setUTCDate(d.getUTCDate() + 1);
    }
    out.set(mid, n);
  }
  return out;
}

/** ЧИСТА декомпозиція цілі (metric-агностична): місяць → тиждень → день. Використовується
 *  і для грошей, і для активностей (реклама/лідген/авто-к-сть) — одна арифметика. */
export function decomposeTarget(o: { monthPlan: number; factMonth: number; factWeek: number; weeksLeft: number; presentDaysLeftWeek: number }): { monthTarget: number; weekTarget: number; dayTarget: number } {
  const remMonth = Math.max(0, o.monthPlan - o.factMonth);
  const weekTarget = o.weeksLeft > 0 ? Math.round(remMonth / o.weeksLeft) : 0;
  const remWeek = Math.max(0, weekTarget - o.factWeek);
  const dayTarget = o.presentDaysLeftWeek > 0 ? Math.round(remWeek / o.presentDaysLeftWeek) : 0;
  return { monthTarget: Math.round(o.monthPlan), weekTarget, dayTarget };
}

export type DynScope = { managerId?: number | null; teamId?: number | null; month?: string };
export interface DynTargetRow {
  managerId: number; name: string; teamId: number | null;
  monthPlan: number; factMonth: number; factWeek: number;
  weeksLeft: number; presentDaysLeftWeek: number;
  monthTarget: number; weekTarget: number; dayTarget: number; target: number;
}

/**
 * ДИНАМІЧНА ЦІЛЬ по грошах, ПЕР-МЕНЕДЖЕРА (Звіт Phase 2). Джерело плану — `managerPlan`
 * (metric payment_amount, Σ=2.7 млн, з перерозподілом плану звільнених); сирі плани НЕ чіпаємо.
 *   • monthTarget = monthPlan (сирий, незмінний);
 *   • weekTarget  = max(0, monthPlan − фактМісяцяДоНині) ÷ тижнівЩоЛишились;
 *   • dayTarget   = max(0, weekTarget − фактТижняДоНині) ÷ присутніхРобочихДнівЩоЛишились
 *                   (Пн–Пт − держсвята − approved-відсутності).
 * `target` = поле під обрану гранулярність. Факт — `receivedByMgr` (signed, дедуп). Місяць
 * визначається `scope.month` (дефолт — поточний київський). Для минулих/майбутніх місяців
 * «сьогодні» клампиться в межі місяця (історичний перегляд не ламається).
 */
export interface EffWeekTarget {
  managerId: number; target: number; dynamic: number; manual: number | null; isManual: boolean;
  fact: number; dayTarget: number; weeksLeft: number; presentDaysLeftWeek: number;
  /** Перевиконання місячного плану на початок тижня: план тижня 0, а надлишок НАЗВАНИЙ. */
  overPlan: number;
  /** Ціль зафіксовано знімком (тиждень уже почався) — всередині тижня вона не рухається. */
  frozen: boolean;
  /** Знімок ВІДНОВЛЕНО ретроспективно, а не збережено в момент. Межа має бути видима. */
  reconstructed: boolean;
  weekFrom: string | null;
  workingDaysWeek: number;
}
/**
 * ЄДИНИЙ ВИРАЗ «тижневої цілі» для ВСІХ трьох екранів (Variant A — одна цифра скрізь):
 *   target = manualWeekTarget ?? dynamicTarget.week
 * manualWeekTarget = payment_amount з kpi_period-парасольки Задачника, що ПОКРИВАЄ сьогодні
 * (тімлід виставив вручну → перемагає). Оскільки і /report-plan, і /kvp-report, і
 * /manager-report кличуть ЦЮ функцію з тим самим (month, kyivToday, managerId) — тижнева
 * ціль байт-в-байт однакова. `scope.month` — місяць перегляду; `kyivToday` — київське сьогодні.
 */
export async function effectiveWeekTargets(scope: DynScope, kyivToday: string): Promise<Map<number, EffWeekTarget>> {
  const dyn = await dynamicTarget(scope, "week");
  /**
   * 🗓 БАЗИС ТИЖНЕВОЇ ЦІЛІ — РОБОЧІ ДНІ + ЗАМОРОЖЕННЯ (рішення власника 06.08.2026).
   *
   * `dynamicTarget(...,"week")` ділив залишок місяця на «тижні, що лишились» і
   * рахувався НАЖИВО. Обидві властивості — поломки, і обидві виправлені тут:
   *  · базис: останній «тиждень» серпня — один день (31.08), і поділ на тижні дав
   *    би йому ПОВНУ тижневу норму, тобто ціль, яку фізично не виконати;
   *  · заморожування: ціль, що повзе всередині тижня, наздогнати неможливо в
   *    принципі — відстав у вівторок, у середу план виріс.
   *
   * 🔴 ПІДМІНА СТОЇТЬ САМЕ ТУТ, А НЕ В ТРЬОХ РОУТАХ. `effectiveWeekTargets` — це
   * ЄДИНИЙ вираз тижневої цілі для `/report-plan`, `/kvp-report` і
   * `/manager-report`; правити кожен окремо означало б завести три цілі, які
   * розійдуться мовчки. Решта полів (`dayTarget`, `presentDaysLeftWeek`,
   * `weeksLeft`) лишаються від `dynamicTarget` без змін — вони про ІНШЕ.
   */
  const monthStart = (scope.month ?? kyivToday).slice(0, 7) + "-01";
  const planByMgr = new Map(dyn.map((d) => [d.managerId, d.monthPlan]));
  const wpRows = await weekPlansForMonth({ managerId: scope.managerId, teamId: scope.teamId }, monthStart, planByMgr);
  const curWeekStart = fixedWeekBlocks(monthStart).find((w) => kyivToday >= w.from && kyivToday <= w.to)?.from ?? null;
  const wpByMgr = new Map(wpRows.filter((r) => r.weekStart === curWeekStart).map((r) => [r.managerId, r]));
  const mw = await pool.query<{ assignee_id: number; metrics_json: { metric: string; target: number | string }[] | null }>(
    `SELECT assignee_id, metrics_json FROM tasks
      WHERE auto AND task_type = 'kpi_period' AND assignee_id IS NOT NULL AND metrics_json IS NOT NULL
        AND period_start <= $1 AND COALESCE(period_end, period_start) >= $1`, [kyivToday]);
  const manual = new Map<number, number>();
  for (const r of mw.rows) { const pa = (r.metrics_json ?? []).find((x) => x.metric === "payment_amount"); if (pa) manual.set(r.assignee_id, Number(pa.target) || 0); }
  const out = new Map<number, EffWeekTarget>();
  for (const d of dyn) {
    const man = manual.get(d.managerId) ?? null;
    const wp = wpByMgr.get(d.managerId);
    const dynamic = wp ? wp.plan : d.weekTarget;      // фолбек — лише якщо тижня немає в місяці
    out.set(d.managerId, {
      managerId: d.managerId, target: man != null ? man : dynamic, dynamic, manual: man, isManual: man != null,
      fact: d.factWeek, dayTarget: d.dayTarget, weeksLeft: d.weeksLeft, presentDaysLeftWeek: d.presentDaysLeftWeek,
      overPlan: wp?.overPlan ?? 0, frozen: wp?.source != null, reconstructed: wp?.reconstructed ?? false,
      weekFrom: wp?.weekStart ?? null, workingDaysWeek: wp?.wdWeek ?? 0,
    });
  }
  return out;
}

export async function dynamicTarget(scope: DynScope, granularity: "month" | "week" | "day"): Promise<DynTargetRow[]> {
  const todayReal = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const monthStart = (scope.month ?? todayReal).slice(0, 7) + "-01";
  const mEnd = monthEndOf(monthStart);
  const today = todayReal < monthStart ? monthStart : todayReal > mEnd ? mEnd : todayReal;
  const weeks = fixedWeekBlocks(monthStart);
  const weeksLeft = weeks.filter((w) => w.to >= today).length;
  const curWeek = weeks.find((w) => today >= w.from && today <= w.to) ?? weeks[weeks.length - 1];

  const mp = await managerPlan(scope.teamId ? { month: monthStart, teamId: scope.teamId } : { month: monthStart });
  let rows = mp.rows;
  if (scope.managerId) rows = rows.filter((r) => r.managerId === scope.managerId);
  const ids = rows.map((r) => r.managerId);
  if (!ids.length) return [];

  const [factMonthArr, factWeekArr, present] = await Promise.all([
    receivedByMgr({ from: monthStart, to: today, teamId: scope.teamId ?? null, managerId: scope.managerId ?? null }),
    receivedByMgr({ from: curWeek.from, to: today, teamId: scope.teamId ?? null, managerId: scope.managerId ?? null }),
    presentWorkingDaysByManager(ids, today, curWeek.to),
  ]);
  const fMonth = new Map(factMonthArr.map((x) => [x.managerId, x.revenue]));
  const fWeek = new Map(factWeekArr.map((x) => [x.managerId, x.revenue]));
  const pick = (d: { monthTarget: number; weekTarget: number; dayTarget: number }) => granularity === "day" ? d.dayTarget : granularity === "week" ? d.weekTarget : d.monthTarget;
  return rows.map((r) => {
    const factMonth = Math.round(fMonth.get(r.managerId) ?? 0);
    const factWeek = Math.round(fWeek.get(r.managerId) ?? 0);
    const pdl = present.get(r.managerId) ?? 0;
    const dec = decomposeTarget({ monthPlan: r.plan, factMonth, factWeek, weeksLeft, presentDaysLeftWeek: pdl });
    return { managerId: r.managerId, name: r.name, teamId: r.teamId, monthPlan: Math.round(r.plan), factMonth, factWeek, weeksLeft, presentDaysLeftWeek: pdl, ...dec, target: pick(dec) };
  });
}
