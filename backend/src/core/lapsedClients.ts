/**
 * 📉 «КУПУВАВ МИНУЛОГО МІСЯЦЯ, НЕ КУПИВ У ЦЬОМУ» — чисте правило, нуль імпортів (задача 3990, п.3).
 *
 * Вхід — помісячні бакети ЯДРА грошей по клієнтах (`money.successByClientBucket`, гроші ① за анкером
 * входу в етап), тобто ті самі числа, що на Звіті. Клієнт «випав», якщо в минулому місяці
 * revenue > 0, а в поточному бакета немає або revenue = 0. Групування по командах — за ефективним
 * менеджером клієнта (закріплення й передачі, `core/effectiveManager.ts`), не за менеджером угоди.
 * ⚠️ Поточний місяць НЕ завершений: у середині місяця список чесно більший, ніж буде 30-го.
 * Підпис на екрані мусить це казати — і каже (гейт #694b).
 */
export interface ClientMonth { clientKey: string; bucket: string; revenue: number }
export interface LapsedRow { clientKey: string; prevRevenue: number }

export function lapsedFrom(rows: ClientMonth[], prevYm: string, thisYm: string): LapsedRow[] {
  const prev = new Map<string, number>(), cur = new Map<string, number>();
  for (const r of rows) {
    const ym = r.bucket.slice(0, 7);
    if (ym === prevYm) prev.set(r.clientKey, (prev.get(r.clientKey) ?? 0) + r.revenue);
    else if (ym === thisYm) cur.set(r.clientKey, (cur.get(r.clientKey) ?? 0) + r.revenue);
  }
  return [...prev.entries()]
    .filter(([k, v]) => v > 0 && (cur.get(k) ?? 0) <= 0)
    .map(([clientKey, prevRevenue]) => ({ clientKey, prevRevenue: Math.round(prevRevenue) }))
    .sort((a, b) => b.prevRevenue - a.prevRevenue);
}

/** `YYYY-MM` попереднього місяця. */
export function prevMonthOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
