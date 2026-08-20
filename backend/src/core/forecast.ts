/**
 * 📈 ПРОГНОЗ МІСЯЦЯ — ОДНА ФОРМУЛА НА ВСІ ЕКРАНИ.
 *
 * 🟢 РІШЕННЯ ВЛАСНИКА 06.08.2026, дослівно: **прогноз = факт ② + очікування з
 * ПЛАНОВОЮ ДАТОЮ ОПЛАТИ в цьому ж місяці**. Добір нового бізнесу з формули СВІДОМО
 * виведено — контрольне число власника (Антипенко ≈68к) сходиться лише без нього:
 * 23 632 + 44 282 = 67 914. Добір лишається ВИДИМИМ полем поруч, але в прогноз не
 * входить.
 *
 * 🔴 ЧОМУ ЦЕ ОКРЕМИЙ МОДУЛЬ, А НЕ ДВА ВИРАЗИ В ДВОХ РОУТАХ. Рішення 06.08 доїхало
 * до картки менеджера й не доїхало до Звіту КВП, тож КВП рахував прогноз старою
 * формулою `факт + УСЯ зона + добір`. Заміряно на проді 20.08.2026: КВП показував
 * **2 748 167 ₴ (99.6% плану)**, тимчасом як формула картки давала **2 306 403 ₴
 * (84%)**, а темп — 2 083 448 ₴ (76%). Тобто екран КВП казав «майже виконаємо» там,
 * де темп давав три чверті, — і збіг прогнозу зі стратпланом (Δ 10 833 ₴) виглядав
 * як дубль плану, хоча був випадковим.
 *
 * Два екрани, два «прогнози» під одним словом — рівно те, від чого береже правило
 * «підписуй, якою метрикою рахуєш». Тепер формула тут, і обидві поверхні її кличуть.
 *
 * ⚠️ Модуль НІЧОГО не імпортує: `db/pool.js` → `config.js` кидає на відсутньому
 * `DATABASE_URL` ще НА ІМПОРТІ, тож гейт формули не встиг би навіть початись.
 */

/** Ключі поточного й наступного календарних місяців від КИЇВСЬКОГО «сьогодні». */
export function monthKeys(kyivToday: string): { curYm: string; nextYm: string } {
  const d = new Date(kyivToday + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return { curYm: kyivToday.slice(0, 7), nextYm: d.toISOString().slice(0, 7) };
}

/**
 * Розкладає очікувані оплати (рядки «менеджер × день планової дати») на поточний і
 * наступний календарні місяці. Дні поза цими двома місяцями НЕ втрачаються тихо —
 * вони просто не входять у прогноз, бо прогноз саме про ЦЕЙ місяць.
 */
export function expectedSplitByMonth(
  rows: { managerId: number; day: string; sum: number }[],
  kyivToday: string
): Map<number, { thisMonth: number; nextMonth: number }> {
  const { curYm, nextYm } = monthKeys(kyivToday);
  const out = new Map<number, { thisMonth: number; nextMonth: number }>();
  for (const r of rows) {
    const e = out.get(r.managerId) ?? { thisMonth: 0, nextMonth: 0 };
    if (r.day.slice(0, 7) === curYm) e.thisMonth += r.sum;
    else if (r.day.slice(0, 7) === nextYm) e.nextMonth += r.sum;
    out.set(r.managerId, e);
  }
  return out;
}

/**
 * ПРОГНОЗ = факт ② + очікування цього місяця (лише поки місяць НЕ завершився).
 *
 * 🔒 `monthInProgress = false` → прогноз дорівнює факту. Завершений місяць нічого
 * не «очікує»: додати туди зону означало б домалювати гроші в минуле.
 */
export function forecastMonth(fact: number, expectedThisMonth: number, monthInProgress: boolean): number {
  return fact + (monthInProgress ? expectedThisMonth : 0);
}

/**
 * ТЕМП — лінійна екстраполяція ФАКТУ на робочі дні місяця.
 *
 * 🔴 Це ІНШЕ питання, ніж прогноз, і плутати їх не можна. Прогноз каже «що вже
 * домовлено» (є рахунок і планова дата), темп — «що вийде, якщо нічого не зміниться».
 * Заміряно 20.08: темп 2 083 448 (76% плану) проти прогнозу 2 306 403 (84%) — і саме
 * розрив між ними є тим, заради чого КВП дивиться на екран.
 *
 * `null`, коли не минуло жодного робочого дня: ділити на нуль і показувати «0%
 * плану» першого числа — це вигадана тривога, а не замір.
 */
export function paceProjection(fact: number, elapsedWorkingDays: number, totalWorkingDays: number): number | null {
  if (elapsedWorkingDays <= 0 || totalWorkingDays <= 0) return null;
  return Math.round((fact / elapsedWorkingDays) * totalWorkingDays);
}
