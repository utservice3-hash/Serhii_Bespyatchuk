/**
 * 👥 КАРТКИ ЕКРАНА «ПОСТІЙНІ КЛІЄНТИ» (задача 5609, ТЗ Юлі 12.10.2026, розділ 3). Кожна картка клікабельна: клік
 * фільтрує таблицю. Число в картці і рядки після кліку беруть ОДНЕ правило (`CARD_MATCH`) — критерій приймання
 * «кількість у картці дорівнює кількості рядків після кліку» тримається побудовою. Позначки рядка — з сервера
 * (`core/repeatScreenRules.ts`); тут лише складання. Без React — гейт бекенду виконує цей модуль.
 */

export interface CardRow {
  orderedThisMonth: boolean; orderedBefore: boolean; delta: number;
  work: { noWork: boolean; noTask: boolean; overdue: boolean };
}

export type CardKey = "all" | "ordered" | "notOrdered" | "more" | "less" | "noWork" | "overdue";

export const CARD_MATCH: Record<CardKey, (r: CardRow) => boolean> = {
  all: () => true,
  ordered: (r) => r.orderedThisMonth,
  // «Замовляли раніше» = у 3 попередні повні місяці (відповідь на питання 2 ТЗ).
  notOrdered: (r) => r.orderedBefore && !r.orderedThisMonth,
  more: (r) => r.delta > 0,
  less: (r) => r.delta < 0,
  // ТЗ п.3: «Без роботи — об'єднуємо з «Без задачі» в одну картку».
  noWork: (r) => r.work.noWork || r.work.noTask,
  overdue: (r) => r.work.overdue,
};

export interface CardStats {
  all: number; ordered: number; notOrdered: number; noWork: number; noWorkOnly: number; noTaskOnly: number; overdue: number;
  more: { n: number; sum: number }; less: { n: number; sum: number };
  /** «Плюс / мінус до середнього» = Σ «купили більше» + Σ «купили менше» (друга сума відʼємна) — критерій приймання п.8. */
  delta: number;
}

export function cardStats(rows: readonly CardRow[]): CardStats {
  const cnt = (k: CardKey) => rows.filter(CARD_MATCH[k]).length;
  const sum = (k: "more" | "less") => rows.filter(CARD_MATCH[k]).reduce((a, r) => a + r.delta, 0);
  const more = { n: cnt("more"), sum: sum("more") }, less = { n: cnt("less"), sum: sum("less") };
  return {
    all: rows.length, ordered: cnt("ordered"), notOrdered: cnt("notOrdered"), overdue: cnt("overdue"),
    noWork: cnt("noWork"), noWorkOnly: rows.filter((r) => r.work.noWork).length, noTaskOnly: rows.filter((r) => r.work.noTask).length,
    more, less, delta: more.sum + less.sum,
  };
}

/** Клік по картці — фільтр; повторний клік по тій самій — знімає. «Клієнтів у вибірці» фільтра не має. */
export function toggleCard(cur: CardKey, k: CardKey): CardKey {
  return k === "all" || cur === k ? "all" : k;
}

/** «+12 500 ₴» / «−3 200 ₴» / «0 ₴»: знак завжди видно, бо картка саме про знак. */
export function signedUah(v: number): string {
  const n = Math.round(v);
  const abs = Math.abs(n).toLocaleString("uk-UA");
  return n > 0 ? `+${abs} ₴` : n < 0 ? `−${abs} ₴` : "0 ₴";
}
