/**
 * 🔁 ЧИСТІ ПРАВИЛА РЕАКТИВАЦІЇ — БЕЗ імпортів.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ. Пороги й формула цінності — це бізнес-рішення власника,
 * і перевіряти їх треба БЕЗ бази. Але `core/reactivation.ts` тягне `db/pool.js` →
 * `config.js`, який кидає без `DATABASE_URL` ще НА ІМПОРТІ, тобто раніше, ніж
 * спрацює skip. Перша версія гейтів #23 саме на цьому й упала: тест про чисту
 * арифметику вимагав живої БД. Той самий урок, що з `clientKeySql.ts`.
 */

/** Пороги — рішення власника 03.08.2026. Тут, бо на них стоїть гейт #23. */
export const SLEEPING_DAYS = 60;
export const LOST_DAYS = 180;

export type ClientState = "active" | "sleeping" | "lost";

/** Чиста функція: стан із кількості днів без замовлення. Тестується без БД. */
export function stateOf(daysSinceLastOrder: number): ClientState {
  if (daysSinceLastOrder >= LOST_DAYS) return "lost";
  if (daysSinceLastOrder >= SLEEPING_DAYS) return "sleeping";
  return "active";
}

/**
 * ЦІННІСТЬ = виручка за життя × свіжість. Свіжість спадає гіперболічно від
 * місяців простою: 12 міс. без замовлення важать удесятеро менше за свіжого.
 *
 * 🔴 Формула НАЗВАНА і живе в ядрі, а не в сортуванні на фронті: інакше два
 * екрани відсортують «за цінністю» по-різному, і жоден не буде неправильним.
 */
export function valueScore(lifetimeRevenue: number, daysSinceLastOrder: number): number {
  const months = Math.max(0, daysSinceLastOrder) / 30;
  return lifetimeRevenue / (1 + months);
}

/** Причини закриття реактиваційної задачі. Перелік закритий — «інше» вимагає тексту. */
export const CLOSE_REASONS = [
  { key: "price", label: "Ціна" },
  { key: "competitor", label: "Конкурент" },
  { key: "own_transport", label: "Власний транспорт" },
  { key: "seasonality", label: "Сезонність" },
  { key: "closed_down", label: "Закрились" },
  { key: "other", label: "Інше" },
] as const;
export const CLOSE_REASON_KEYS: string[] = CLOSE_REASONS.map((r) => r.key);

