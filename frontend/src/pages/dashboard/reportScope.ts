import type { ReportPlan, ReportPlanManager } from "../../api";

/**
 * 🧩 МУЛЬТИВИБІР КОМАНД — ЗЛИТТЯ N ВІДПОВІДЕЙ `/report-plan` В ОДНУ (21.08.2026).
 *
 * 🔴 ЧОМУ N ЗАПИТІВ, А НЕ НОВИЙ ПАРАМЕТР API. Контракт `/report-plan` читають
 * `#50` (звільнені), `#53` (безпланові), `#56` (Задачник), `#59` (гроші звільнених)
 * і обидва вигляди Звіту. Новий `teamIds=` означав би другу гілку скоупу ВСЕРЕДИНІ
 * роута — тобто другий вираз тих самих чисел, який колись розійдеться з першим.
 * Тут же кожна команда рахується ТИМ САМИМ кодом, що й сьогодні, а склеювання
 * лишається на фронті й нічого не рахує заново.
 * 📐 Заміряно на проді 20.08.2026: 5 команд паралельно — 2 506 мс проти 1 526 мс
 * на один запит, при межі REQ_TIMEOUT_MS = 20 000.
 *
 * 🔴 ЩО СУМУЄТЬСЯ, А ЩО НІ. Лічильні поля `glance` адитивні й сумуються. Частка
 * `avgCheck` — НІ: `glance` не несе знаменника (кількості угод), тож «середнє
 * середніх» було б вигаданим числом. Тому при 2+ командах вона стає `null` і
 * читається як «—». Показати неправильне середнє гірше, ніж не показати жодного:
 * саме так народжуються числа, яким вірять.
 */

/** Адитивні поля `glance` — перелічені ПОШТУЧНО, без spread-суми. */
const ADDITIVE = [
  "plan", "fact", "factSuccess", "factPaid", "expect", "expectThisMonth", "expectNextMonth",
  "dispatched", "dispatchedRevenue", "created", "expectNoDate", "jam", "jamDeals",
  "dobir", "byPace", "talks", "attempts", "factNoPlan",
] as const;

export function mergeReportPlans(parts: ReportPlan[]): ReportPlan {
  if (parts.length === 0) throw new Error("mergeReportPlans: порожній список — злити нема чого");
  if (parts.length === 1) return parts[0];
  const base = parts[0];

  /**
   * 🔴 ДЕДУП ПО `managerId` — ЗАХИСТ, ЯКИЙ МУСИТЬ ЛИШАТИСЬ ВИДИМИМ. Членство в
   * команді — скалярний FK `managers.team_id`, тож одна людина у двох ростерах
   * неможлива за побудовою (заміряно 20.08.2026: 0 перетинів по всіх командах).
   * Але якщо це колись зміниться, рядок ми покажемо ОДИН, а `glance` лишиться
   * сумою — і тоді `#99` (Σ груп == Σ рядків) почервоніє, замість того щоб
   * подвоєння тихо поїхало в підсумок.
   */
  const seen = new Set<number>();
  const managers: ReportPlanManager[] = [];
  for (const p of parts) for (const m of p.managers) if (!seen.has(m.managerId)) { seen.add(m.managerId); managers.push(m); }
  const dis = new Set<number>();
  const dismissed = parts.flatMap((p) => p.dismissed ?? []).filter((d) => !dis.has(d.managerId) && (dis.add(d.managerId), true));

  const glance = { ...base.glance } as ReportPlan["glance"];
  for (const k of ADDITIVE) glance[k] = parts.reduce((s, p) => s + (p.glance[k] ?? 0), 0);
  glance.statusCounts = {
    g: parts.reduce((s, p) => s + p.glance.statusCounts.g, 0),
    a: parts.reduce((s, p) => s + p.glance.statusCounts.a, 0),
    r: parts.reduce((s, p) => s + p.glance.statusCounts.r, 0),
  };
  // Частка — не сума й не середнє середніх. Знаменника в `glance` немає.
  glance.avgCheck = null;

  // `scope`/`elapsed`/`remainingWorkdays` — властивості ПЕРІОДУ й ГЛЯДАЧА, однакові
  // в усіх частинах (той самий from/to, той самий токен). Беремо з першої.
  return { ...base, glance, managers, dismissed };
}
