/** 🎯 Правило цілі сер. чека (4632) — чисте, без бази: щоб гейт перевіряв його в будь-якому оточенні. Пояснення — `avgCheckTarget.ts`. */
export const AVG_CHECK_MIN_DEALS = 30;
export const AVG_CHECK_UPLIFT = 1.05;
const pad = (n: number) => String(n).padStart(2, "0");

/** Три повні місяці перед місяцем `month` (YYYY-MM-01): жовтень → липень–вересень, січень → жовтень–грудень. */
export function avgCheckBase(month: string): { from: string; to: string } {
  const y = Number(month.slice(0, 4)), m0 = Number(month.slice(5, 7)) - 1;
  const start = new Date(Date.UTC(y, m0 - 3, 1));
  const end = new Date(Date.UTC(y, m0, 0));
  return { from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`,
    to: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}` };
}

/** Ціль за базою: менше 30 угод — `null` (лише факт), інакше чек бази + 5%, округлено до гривні. */
export function avgCheckTargetOf(revenue: number, deals: number): number | null {
  if (deals < AVG_CHECK_MIN_DEALS || deals <= 0) return null;
  return Math.round((revenue / deals) * AVG_CHECK_UPLIFT);
}

