import { pool } from "../db/pool.js";

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
