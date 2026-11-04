/**
 * 👥 ЛЮДИ ТИЖНЯ ДЛЯ ПРЕЗЕНТАЦІЇ — ЧИСТІ ПРАВИЛА (04.11.2026, відповіді Даші). Без БД, щоб гейт #3464 виконував їх
 * по обидва боки кожної межі. Дати — київські `YYYY-MM-DD`; тиждень — понеділок…неділя номінованого тижня.
 *  · День народження — місяць-день народження потрапляє в номінований тиждень (з переходом через Новий рік);
 *  · «Новий у команді» — у номінованому тижні людині виповнюється 14 днів від прийому (Даша: «через 2 тижні після
 *    підписання оферу ми презентуємо людину»; офер у дашборді підписують рідко — беремо «Дату прийому» з «Найму»);
 *  · новачок для відзнаки — від 14 днів до місяця від прийому на кінець тижня («після місяця адаптація пройдена»).
 */
const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Той самий день місяця через місяць; якщо такого дня немає (31.01 → лютий) — останній день місяця. */
export const addMonthClamp = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
};

/** Дата дня народження в межах тижня (`YYYY-MM-DD`), або `null`. 29.02 у невисокосний рік — 28.02. */
export function birthdayInWeek(birth: string, weekFrom: string, weekTo: string): string | null {
  const md = birth.slice(5, 10);
  for (let day = weekFrom; day <= weekTo; day = addDays(day, 1)) {
    if (day.slice(5, 10) === md) return day;
    if (md === "02-29" && day.slice(5, 10) === "02-28" && addDays(day, 1).slice(5, 10) === "03-01") return day;
  }
  return null;
}

/** День, коли людині виповнюється 14 днів від прийому, — якщо він у тижні. */
export function newcomerDay(hired: string, weekFrom: string, weekTo: string): string | null {
  const d = addDays(hired, 14);
  return d >= weekFrom && d <= weekTo ? d : null;
}

/** Новачок для відзнаки: на кінець тижня від 14 днів від прийому включно і ще не минув місяць. */
export const isRookie = (hired: string, weekTo: string): boolean => addDays(hired, 14) <= weekTo && weekTo < addMonthClamp(hired);
