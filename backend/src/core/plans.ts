import { pool } from "../db/pool.js";
import { workingDaysBetween, monthEndOf } from "./dates.js";

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
