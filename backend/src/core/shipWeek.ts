import type { DispatchCohortRow } from "./reportCuts.js";

/**
 * 🚚 ЗВІТ КВП, РЕЖИМ «ВІДПРАВЛЕНІ АВТО» (задача 7185) — згортка днів когорти в тиждень. Окремий модуль без БД:
 * `reportCuts.ts` тягне пул, а ця арифметика мусить перевірятись без бази (гейт #3320).
 */
/** Тиждень «🚚 Відправлені авто» Звіту КВП: авто з «Датою загрузки» в тижні і що з ними ЗАРАЗ. */
export interface ShipWeek {
  deals: number; sum: number;
  paidDeals: number; paidSum: number;  // оплачено: «Успішно» або «Оплата отримана»
  waitDeals: number; waitSum: number;  // чекаємо: решта, крім «Не реалізовано»
  lostDeals: number; lostSum: number;  // без оплати: «Закрито і не реалізовано»
}
export const SHIP_ZERO: ShipWeek = { deals: 0, sum: 0, paidDeals: 0, paidSum: 0, waitDeals: 0, waitSum: 0, lostDeals: 0, lostSum: 0 };
export const addShip = (a: ShipWeek, b: ShipWeek): ShipWeek => ({
  deals: a.deals + b.deals, sum: a.sum + b.sum, paidDeals: a.paidDeals + b.paidDeals, paidSum: a.paidSum + b.paidSum,
  waitDeals: a.waitDeals + b.waitDeals, waitSum: a.waitSum + b.waitSum, lostDeals: a.lostDeals + b.lostDeals, lostSum: a.lostSum + b.lostSum,
});
/**
 * 🚚 ДНІ КОГОРТИ → ТИЖДЕНЬ (задача 7185). Три частини дають ціле за побудовою:
 * `paid + wait + lost == deals` — бо `wait` = `await − lost`, а `await` = усе, що не `paid`.
 * Межі тижня — київські дні рядка (`day` уже київський у SQL), включно з обома кінцями.
 */
export function shipWeekOf(rows: DispatchCohortRow[], from: string, to: string): ShipWeek {
  let w = SHIP_ZERO;
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    w = addShip(w, {
      deals: r.deals, sum: r.sum, paidDeals: r.paidDeals, paidSum: r.paidSum,
      waitDeals: r.awaitDeals - r.lostDeals, waitSum: r.awaitSum - r.lostSum,
      lostDeals: r.lostDeals, lostSum: r.lostSum,
    });
  }
  return w;
}
