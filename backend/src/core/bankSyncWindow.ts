/**
 * 🗓 З ЯКОЇ ДАТИ ТЯГНУТИ РУХИ РАХУНКУ (задача 6458, Роман 26.10.2026: ЄЛОГІСТ — «з сьогодні виписку з банку»).
 *
 * Без нижньої межі синк бере історію так: є рухи → від останнього мінус день; рухів немає → 60 днів назад. Друга гілка —
 * пастка для рахунку, що має стартувати з дати: поки на ньому порожньо (валютні рахунки ЄЛОГІСТ — 0 рухів за місяць),
 * КОЖЕН прохід знову тягнув би 60 днів, і вересень заїхав би в «Фінанси» заднім числом. Тому `sync_from` — постійна
 * нижня межа рахунку, а не лише старт першого синку, і рухи до неї не пишуться, навіть якщо банк їх віддав.
 * Межа — дата за Києвом (обидва кінці дня включно), як усі періоди дашборда. Чисті функції — тримає #2422.
 *
 * `resync_from` — РАЗОВЕ повторне завантаження з дати (26.10.2026): переказ між двома нашими рахунками Привату має однаковий
 * REF#NUM_DOC в обох виписках, і поки ключ був унікальним на всю таблицю, друга сторона переписувала першу (замір: переказ
 * Автомув → ФОП 01.10 — «надходження» з мінусом, списання Автомуву загублене). Ключ тепер у межах рахунку, а зачеплені
 * рахунки один раз перечитуються з дня до збою — upsert сам ставить обидві сторони на місце. Синк знімає позначку після
 * успіху. Нижньої межі `sync_from` повторне завантаження не перетинає (#2426).
 */

/** Історія нового рахунку без нижньої межі. */
export const INITIAL_LOOKBACK_DAYS = 60;
const DAY_MS = 24 * 3600 * 1000;

/** Дата за Києвом, `YYYY-MM-DD`. */
export function kyivDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Момент, від якого просити в банку рухи. Межу беремо з запасом у добу (UTC-північ дати мінус день): банки просять
 * дату або мітку часу, і так жодна година дня `syncFrom` за Києвом не випадає. Зайве відсікає `onOrAfterSyncFrom`.
 */
export function syncSince(lastBooked: Date | null, syncFrom: string | null, now: Date, resyncFrom: string | null = null): Date {
  let base = lastBooked ? new Date(lastBooked.getTime() - DAY_MS) : new Date(now.getTime() - INITIAL_LOOKBACK_DAYS * DAY_MS);
  // Разове повторне завантаження (`bank_accounts.resync_from`): тягнемо від нього, навіть якщо рухи вже є пізніше.
  if (resyncFrom) {
    const re = new Date(Date.parse(`${resyncFrom}T00:00:00Z`) - DAY_MS);
    if (re.getTime() < base.getTime()) base = re;
  }
  if (!syncFrom) return base;
  const floor = new Date(Date.parse(`${syncFrom}T00:00:00Z`) - DAY_MS);
  return base.getTime() < floor.getTime() ? floor : base;
}

/** Чи належить рух рахунку з нижньою межею: дата проведення за Києвом не раніша за `syncFrom`. */
export function onOrAfterSyncFrom(bookedAt: Date, syncFrom: string | null): boolean {
  return !syncFrom || kyivDate(bookedAt) >= syncFrom;
}
