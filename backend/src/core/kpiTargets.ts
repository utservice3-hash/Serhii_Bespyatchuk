import { workingDaysBetween } from "./dates.js";

/**
 * 🎯 ЦІЛІ-ПОКАЗНИКИ ІЗ ЗАДАЧНИКА — ЧИСТА ФУНКЦІЯ, БЕЗ БД.
 *
 * Логіка жила інлайном у `/report-plan` і через це не мала жодного гейта: єдиний
 * спосіб її перевірити був живий екран. Винесено рівно як є, з ОДНІЄЮ зміною —
 * фільтром рівня періоду (нижче).
 *
 * 🔴 ЦІЛЬ БЕРЕТЬСЯ ЛИШЕ З ТИЖНЕВИХ ПАРАСОЛЬОК (рішення власника 18.08.2026).
 * Доти запит не фільтрував `period_kind` взагалі, тож тижневі й місячні цілі
 * складались в одну купу: місячна ціль-показник підмішувалась у будь-який період,
 * зокрема й у тижневий, де їй немає місця.
 *
 * 🔴 ПОКРИТТЯ РАХУЄТЬСЯ ПО ВСІХ ПАРАСОЛЬКАХ, А ЦІЛЬ — ЛИШЕ ПО ТИЖНЕВИХ, І ЦЕ НЕ
 * НЕДОГЛЯД. Місячна парасолька має 21 приховану денну дитину (`daily_kpi`). Якби
 * фільтр прибрав місячну парасольку і з КАРТИ ПОКРИТТЯ теж, її дні стали б
 * «нічийними», спрацював би daily-фолбек — і та сама місячна ціль повернулась би
 * через задні двері, лише розкладена по днях. Тобто «прибрали» виглядало б як
 * прибрали, а число лишилося б. Тримає гейт `#80b`.
 *
 * Решта поведінки збережена дослівно: лічильні складаються з апортуванням по
 * робочих днях перетину, ставкові (`avg_check`, `conversion`) беруться як MAX,
 * daily-фолбек працює лише для днів ПОЗА будь-якою парасолькою.
 */
export interface KpiMetricTarget { metric: string; target: number | string }
export interface KpiUmbrella {
  assigneeId: number;
  /** межі парасольки (YYYY-MM-DD) */
  from: string; to: string;
  /** 'week' | 'month' | null — рівень періоду з `tasks.period_kind` */
  kind: string | null;
  metrics: KpiMetricTarget[] | null;
}
export interface KpiDayPlan { assigneeId: number; day: string; metrics: KpiMetricTarget[] | null }

/** Лічильні складаються; ставкові (чек, конверсія) — MAX, бо середнє з сум безглузде. */
const ADDITIVE = new Set(["ads_count", "leadgen_count", "dispatch_count", "payment_amount"]);

/** Рівень періоду, з якого дозволено брати ЦІЛЬ. Місячні цілі-показники зняті. */
export const TARGET_PERIOD_KIND = "week";

export function accumulateKpiTargets(
  umbrellas: KpiUmbrella[], days: KpiDayPlan[], from: string, to: string
): Map<number, Record<string, number>> {
  const planByMgr = new Map<number, Record<string, number>>();
  const accum = (aid: number, metrics: KpiMetricTarget[] | null, factor: number) => {
    const e = planByMgr.get(aid) ?? {};
    for (const m of metrics ?? []) {
      const t = Number(m.target) || 0;
      if (ADDITIVE.has(m.metric)) e[m.metric] = (e[m.metric] ?? 0) + t * factor;
      else e[m.metric] = Math.max(e[m.metric] ?? 0, t);
    }
    planByMgr.set(aid, e);
  };
  const umbByMgr = new Map<number, { ps: string; pe: string }[]>();
  for (const u of umbrellas) {
    const wdU = workingDaysBetween(u.from, u.to);
    if (wdU <= 0) continue;
    const oFrom = u.from > from ? u.from : from;      // перетин [парасолька ∩ період]
    const oTo = u.to < to ? u.to : to;
    if (oFrom > oTo) continue;
    // ПОКРИТТЯ — від УСІХ парасольок (див. шапку: інакше діти місячної просочаться).
    (umbByMgr.get(u.assigneeId) ?? umbByMgr.set(u.assigneeId, []).get(u.assigneeId)!)
      .push({ ps: u.from, pe: u.to });
    if (u.kind !== TARGET_PERIOD_KIND) continue;      // ЦІЛЬ — лише з тижневих
    const frac = workingDaysBetween(oFrom, oTo) / wdU;
    if (frac > 0) accum(u.assigneeId, u.metrics, frac);
  }
  const covered = (aid: number, d: string) => (umbByMgr.get(aid) ?? []).some((u) => d >= u.ps && d <= u.pe);
  for (const r of days) {
    if (covered(r.assigneeId, r.day)) continue;
    accum(r.assigneeId, r.metrics, 1);
  }
  return planByMgr;
}
