/**
 * 📅 ФАКТ ПО ТИЖНЕВИХ БЛОКАХ — чиста функція складання денних сум (19.08.2026).
 *
 * 🔴 НАВІЩО ЦЕ ОКРЕМО, А НЕ `receivedByManagerBucket(…, "week")`.
 * Тижні Звіту — це `fixedWeekBlocks`: Пн–Нд, ОБРІЗАНІ межами місяця (перший блок
 * серпня 2026 — це 1–2 число, субота й неділя). А `date_trunc('week')` у Postgres
 * дає понеділок ISO-тижня, тобто для 1 серпня — 27 ЛИПНЯ. Тижневий бакет ядра
 * відніс би гроші першого блоку в місяць, якого в запиті немає, і перший рядок
 * розкриття стояв би порожнім при живих грошах — тихо, без жодної помилки.
 *
 * Тому денні бакети ядра (та сама каса ②, той самий анкер) складаються в блоки
 * ТУТ, у чистій функції, яку можна перевірити без БД. Власного SQL по виручці
 * тут немає й бути не може.
 */

export interface WeekBlock { idx: number; from: string; to: string }
export interface DaySum { day: string; value: number }

/**
 * Розкладає денні суми по блоках. Повертає суму на КОЖЕН блок (0, якщо порожній)
 * і `outside` — те, що не потрапило в жоден: воно НЕ зникає мовчки, бо саме так
 * втрачаються гроші на межах періоду.
 */
export function sumDaysIntoBlocks(days: DaySum[], blocks: WeekBlock[]): { byBlock: number[]; outside: number } {
  const byBlock = blocks.map(() => 0);
  let outside = 0;
  for (const d of days) {
    const i = blocks.findIndex((b) => d.day >= b.from && d.day <= b.to);
    if (i < 0) outside += d.value; else byBlock[i] += d.value;
  }
  return { byBlock, outside };
}
