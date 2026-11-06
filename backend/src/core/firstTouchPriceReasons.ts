/**
 * 💬 «ЧОМУ НЕ ОЗВУЧЕНО ЦІНУ» — ПЕРЕЛІК ПРИЧИН (задача 7239 п.2, ТЗ Юлі 28.10.2026; Роман 06.11.2026 «роби»).
 *
 * До 06.11.2026 причину писали вільним текстом (309 записів з 02.10) — порахувати, ЧОМУ не називають ціну, було
 * неможливо. Тепер причина — значення з переліку; текст — пояснення, обовʼязковий лише для «Інше». Старі записи без
 * причини не розкладаються автоматично: на екрані вони окремим рядком «без причини (старі записи)».
 *
 * Перелік ОДИН: його читають роут (перевірка), схема (`CHECK` у `first_touch_notes.reason`) і фронт (дзеркало в
 * `aiCallsView.ts`) — розбіжність стереже гейт.
 */
export const PRICE_REASONS = ["no_data", "rookie_rate", "find_car", "hung_up", "other"] as const;
export type PriceReason = typeof PRICE_REASONS[number];
export const PRICE_REASON_UA: Readonly<Record<PriceReason, string>> = {
  no_data: "Клієнт не дав даних",
  rookie_rate: "Новачок уточнює ставку",
  find_car: "Треба знайти машину",
  hung_up: "Клієнт поклав слухавку",
  other: "Інше",
};

/**
 * Що можна записати в «Чому не озвучено ціну». Порожньо й без причини — прибрати запис. Новий запис — лише з причиною
 * з переліку; «Інше» — лише з текстом. Текст до інших причин — за бажанням (тоді в записі стоїть назва причини).
 */
export function checkPriceNote(reason: unknown, text: string): { ok: true; reason: PriceReason | null } | { ok: false; why: string } {
  const t = text.trim();
  if (reason == null || reason === "") return t ? { ok: false, why: "Оберіть причину зі списку" } : { ok: true, reason: null };
  if (typeof reason !== "string" || !(PRICE_REASONS as readonly string[]).includes(reason)) return { ok: false, why: "Невідома причина" };
  if (reason === "other" && !t) return { ok: false, why: "Для «Інше» напишіть причину" };
  return { ok: true, reason: reason as PriceReason };
}
