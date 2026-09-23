/**
 * 🧭 ФІЛЬТРИ Й ПІДСУМКИ ЕКРАНА РЕАКТИВАЦІЇ — чисті правила, нуль імпортів (ТЗ 3989, п.3, 5, 6).
 *
 * «ПОВЕРНУТО» = перша оплата клієнта в місяці після паузи ≥ RETURN_GAP_DAYS від попередньої.
 * ⚠️ Поріг 60 днів — МІЙ, у глосарії його немає; названо як ВІДКРИТЕ ПИТАННЯ власнику
 * (задача 3989). Замір 23.09.2026 за вересень: 25 клієнтів, 130 590 ₴.
 * «МАРЖА» тут = `price` угоди: у цьому продукті price — уже маржа (`core/money.ts`,
 * schema 25.08.2026); «Расход 1» для неї не потрібен.
 * «СТОП ЧЕРЕЗ ДЕБІТОРКУ» = у клієнта є прострочений рядок дебіторки (overdue_days > 0).
 * Автоматично з прострочення, ручного перемикача немає (план 23.09).
 */
export const RETURN_GAP_DAYS = 60;
export const VIP_SLEEP_DAYS = 14;

export type RowForFilter = {
  lastTalk: string | null; nextStepState: "none" | "planned" | "today" | "overdue" | "done" | null;
  segment: string | null; daysSince: number | null; managerId: number | null; debtHold: boolean;
};
export type ReactFilter = "all" | "no_talk" | "step_overdue" | "vip_sleeping" | "debt_hold";

export function passesFilter(r: RowForFilter, f: ReactFilter, managerId: number | null): boolean {
  if (managerId != null && r.managerId !== managerId) return false;
  switch (f) {
    case "all": return true;
    case "no_talk": return r.lastTalk == null;
    case "step_overdue": return r.nextStepState === "overdue";
    case "vip_sleeping": return r.segment === "vip" && (r.daysSince ?? 0) >= VIP_SLEEP_DAYS;
    case "debt_hold": return r.debtHold;
  }
}

/** Сортування за маржею (price = маржа): більша зверху; без грошей — унизу, а не «0 зверху». */
export function byMarginDesc<T extends { margin6m: number | null }>(a: T, b: T): number {
  const A = a.margin6m, B = b.margin6m;
  if (A == null && B == null) return 0;
  if (A == null) return 1;
  if (B == null) return -1;
  return B - A;
}

/** Чи вважати клієнта повернутим: перша оплата місяця після паузи ≥ порога. Без попередньої оплати — не «повернутий», а новий. */
export function isReturned(firstPaidThisMonth: string, lastPaidBefore: string | null, gapDays = RETURN_GAP_DAYS): boolean {
  if (!lastPaidBefore) return false;
  const ms = Date.parse(firstPaidThisMonth) - Date.parse(lastPaidBefore);
  return ms / 86_400_000 >= gapDays;
}
