/**
 * 🎯 ПЛАН І ПРОГНОЗ НАДХОДЖЕНЬ І ВИТРАТ («Фінанси → Тиждень і місяць», задача #5649, 19.10.2026).
 *
 * Зустріч Романа з Тетяною 13.10.2026: «взяти як план минулий місяць, поділити на чотири… щоб розуміти, чи ми в плані
 * надходжень… і так само до тижня». Її коментар до #5618: «можливість додавати вручну або щоб базувався на історії
 * минулого місяця; цифра різниці — якщо не виконано, і плюс — якщо виконано». Рішення Романа 19.10.2026 (за
 * замовчуванням із плану): тиждень = місяць / 4; «очікувано на сьогодні» — за календарними днями; ручний план вносить
 * фінансист без затвердження.
 *
 *  · план місяця = ручний (`fin_kpi_plans`) АБО число цього рядка за МИНУЛИЙ місяць — те саме, що видно на екрані:
 *    до старту автоматики (вересень) — фінальне число з таблиці Тетяни, далі — зафіксоване / закрите, інакше «Виписка»;
 *  · план тижня = план місяця, до якого належить тиждень (за його четвергом), / 4;
 *  · очікувано на сьогодні = план × частка минулих днів періоду; відхилення = факт − очікуване;
 *  · прогноз місяця = факт / частку минулих днів (лише поточний місяць; тиждень — без прогнозу).
 * Рядки — «Надходження загальні» (`bank_in`, більше — краще) і «Витрати загальні» (`bank_out`, більше — гірше).
 */
import { FinError, parseAmount, type Db } from "./finance.js";
import { addDays, kyivDate, monthStart, periodEnd, shiftPeriod, autoActive, bankTotals, type PeriodKind } from "./financeKpi.js";

export const PLAN_REFS = ["bank_in", "bank_out"] as const;
export type PlanRef = (typeof PLAN_REFS)[number];
/** Тиждень = місяць / 4 (Тетяна 13.10.2026: «поділити на чотири»). */
export const WEEKS_PER_MONTH_PLAN = 4;

/** Місяць, до якого належить тиждень, — за його четвергом (більшість днів). */
export const monthOfWeek = (weekStart: string) => monthStart(addDays(weekStart, 3));

/** Частка минулих днів періоду на `now` (календарні дні, сьогодні включно): минулий період — 1, майбутній — 0. */
export function elapsedShare(kind: PeriodKind, start: string, now: Date): number {
  const today = kyivDate(now), end = periodEnd(kind, start);
  if (today < start) return 0;
  if (today > end) return 1;
  const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) + 1;
  return days(start, today) / days(start, end);
}

export interface PlanFigures { expected: number | null; deviation: number | null; forecast: number | null }
/** Очікуване на сьогодні, відхилення факту від нього, прогноз на кінець періоду (якщо `withForecast`). */
export function planFigures(fact: number | null, plan: number | null, share: number, withForecast: boolean): PlanFigures {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const expected = plan == null ? null : r2(plan * share);
  return {
    expected,
    deviation: fact == null || expected == null ? null : r2(fact - expected),
    forecast: withForecast && fact != null && share > 0 && share < 1 ? r2(fact / share) : null,
  };
}

/**
 * Число рядка за місяць так, як його показує екран: до старту автоматики — збережене (з таблиці Тетяни);
 * зафіксоване / у закритому місяці — збережене; інакше — «Виписка» за місяць.
 */
async function monthValueAsShown(db: Db, kpiId: number, ref: PlanRef, month: string): Promise<number | null> {
  const v = (await db.query(`SELECT value::text AS value, frozen_at FROM fin_kpi_values WHERE kpi_id = $1 AND period_kind = 'month' AND period_start = $2::date`, [kpiId, month])).rows[0];
  const closed = (await db.query(`SELECT 1 FROM fin_kpi_closes WHERE period_kind = 'month' AND period_start = $1::date`, [month])).rowCount;
  const stored = v?.value != null ? Number(v.value) : null;
  if (!autoActive("month", month) || v?.frozen_at || closed) return stored;
  const t = await bankTotals(db, month, periodEnd("month", month));
  return ref === "bank_in" ? t.in : t.out;
}

export interface PlanRow {
  kpiId: number; name: string; ref: PlanRef; better: "more" | "less";
  fact: number | null; plan: number | null; planSource: "manual" | "prev-month" | null; monthPlan: number | null; month: string;
  expected: number | null; deviation: number | null; forecast: number | null; share: number;
}

/** Блок плану для періоду: рядки `bank_in` / `bank_out`, факт — з уже порахованого періоду (`factOf`). */
export async function loadPlan(db: Db, kind: PeriodKind, start: string, now: Date, factOf: (kpiId: number) => number | null): Promise<PlanRow[]> {
  const rows = (await db.query(`SELECT id, name, ref_source FROM fin_kpis WHERE deleted_at IS NULL AND ref_source = ANY($1) ORDER BY sort, id`, [[...PLAN_REFS]])).rows as { id: number; name: string; ref_source: PlanRef }[];
  const month = kind === "month" ? start : monthOfWeek(start);
  const share = elapsedShare(kind, start, now);
  const out: PlanRow[] = [];
  for (const r of rows) {
    const manual = (await db.query(`SELECT value::text AS value FROM fin_kpi_plans WHERE kpi_id = $1 AND month = $2::date`, [r.id, month])).rows[0];
    const monthPlan = manual ? Number(manual.value) : await monthValueAsShown(db, r.id, r.ref_source, shiftPeriod("month", month, -1));
    const plan = monthPlan == null ? null : kind === "month" ? monthPlan : Math.round((monthPlan / WEEKS_PER_MONTH_PLAN) * 100) / 100;
    const fact = factOf(r.id);
    out.push({ kpiId: r.id, name: r.name, ref: r.ref_source, better: r.ref_source === "bank_in" ? "more" : "less",
      fact, plan, planSource: manual ? "manual" : monthPlan == null ? null : "prev-month", monthPlan, month,
      ...planFigures(fact, plan, share, kind === "month"), share: Math.round(share * 10000) / 10000 });
  }
  return out;
}

/** Ручний план місяця: число — встановити, порожньо — прибрати (знову «з минулого місяця»). Лише рядки плану. */
export async function setManualPlan(db: Db, actor: number, kpiIdArg: unknown, monthArg: unknown, valueArg: unknown): Promise<{ ok: true }> {
  const kpiId = Number(kpiIdArg);
  const month = typeof monthArg === "string" && /^\d{4}-\d{2}(-01)?$/.test(monthArg) ? `${monthArg.slice(0, 7)}-01` : null;
  if (!Number.isInteger(kpiId) || kpiId <= 0 || !month) throw new FinError(400, "Некоректний показник чи місяць");
  const k = (await db.query(`SELECT ref_source FROM fin_kpis WHERE id = $1 AND deleted_at IS NULL`, [kpiId])).rows[0];
  if (!k || !(PLAN_REFS as readonly string[]).includes(k.ref_source)) throw new FinError(400, "План задається лише для «Надходження загальні» і «Витрати загальні»");
  const raw = valueArg == null ? "" : String(valueArg).trim();
  if (!raw) { await db.query(`DELETE FROM fin_kpi_plans WHERE kpi_id = $1 AND month = $2::date`, [kpiId, month]); return { ok: true }; }
  const value = parseAmount(raw);
  if (value == null || value < 0) throw new FinError(400, "План — невідʼємне число");
  await db.query(`INSERT INTO fin_kpi_plans (kpi_id, month, value, set_by) VALUES ($1, $2::date, $3, $4)
    ON CONFLICT (kpi_id, month) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, set_at = now()`, [kpiId, month, value, actor]);
  return { ok: true };
}
