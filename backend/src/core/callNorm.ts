/**
 * 📞 НОРМА ДЗВІНКІВ НА ДЕНЬ (ТЗ Сергія 23.09.2026, п.2: «Розрахунок ЗП: колонка
 * „дзвінки за день“ по Ringostat — з жовтня ставка тільки за дні з нормою»).
 *
 * 🔴 ЩО ТУТ Є І ЧОГО НЕМАЄ. Розрахунку ЗП у дашборді немає взагалі, тож «ставка» тут
 * не рахується. Є рівно те, що можна порахувати з CRM/Ringostat: скільки днів людина
 * зробила не менше норми дзвінків. Саме число норми — рішення власника, у глосарії його
 * немає, і ми його НЕ вигадуємо: поки норму не задано в Налаштуваннях, колонка каже
 * «норму не задано», а не «0 днів».
 *
 * Дзвінок дня = розмова + спроба, ТЕ САМЕ `n`, що в колонці «Дзвінки того дня» Звіту
 * (`cellDefs`, `kind: "calls"`), з тією самою склейкою плечей (`callsByManagerDay`).
 * Складати розмови і спроби для ПОКАЗУ заборонено (рішення 04.08) — тут вони складаються
 * лише як ПОРІГ для порівняння з нормою, і на екрані обидві цифри лишаються окремо.
 *
 * Знаменник — робочі дні Пн–Пт у періоді до сьогодні включно (`workingDaysBetween`);
 * день з нормою рахується будь-який календарний, бо робота у вихідний — теж робота.
 * ⏳ Свята з `company_holidays` тут НЕ враховані — той самий борг №2 у CLAUDE.md
 * (два календарі робочих днів); лікувати треба разом із планом тижня, не окремо.
 */
import { workingDaysBetween } from "./dates.js";

export interface CallDay { day: string; talks: number; attempts: number }

export interface CallNormCell {
  /** Норма з Налаштувань; `null` = не задана — тоді `daysWithNorm` теж `null`. */
  norm: number | null;
  /** Днів, у які розмови+спроби ≥ норми. `null`, поки норми немає. */
  daysWithNorm: number | null;
  /** Робочих днів Пн–Пт від початку періоду до `today` (не далі `to`). */
  workDays: number;
}

/** Межі норми: 0 заборонений (означав би «кожен день з нормою»), стеля — від хибного вводу. */
export const CALLS_NORM_BOUNDS = { min: 1, max: 500 } as const;

/** Кінець знаменника: не пізніше сьогодні й не пізніше кінця періоду. */
export function elapsedTo(from: string, to: string, today: string): string {
  const end = to < today ? to : today;
  return end < from ? from : end;
}

export function callNormCell(days: CallDay[], norm: number | null, from: string, to: string, today: string): CallNormCell {
  const end = elapsedTo(from, to, today);
  // Період ще не почався — робочих днів 0, а не 1 (elapsedTo клампить до `from`).
  const workDays = today < from ? 0 : workingDaysBetween(from, end);
  if (norm == null) return { norm: null, daysWithNorm: null, workDays };
  let n = 0;
  for (const d of days) if (d.day >= from && d.day <= end && d.talks + d.attempts >= norm) n++;
  return { norm, daysWithNorm: n, workDays };
}
