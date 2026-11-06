/**
 * 🌱 «НА АДАПТАЦІЇ» (задача 7239 п.3, ТЗ Юлі 28.10.2026; Роман 06.11.2026 «2 а»): розмови менеджера в перші 4 тижні від
 * прийому — окремим блоком і НЕ в балі команди, скрізь, де «Перший дотик» рахується по команді (екран AI, звіт тімліда,
 * Звіт КВП, ціна у Звіті). Рахується від дати РОЗМОВИ, а не від сьогодні, тож минулі періоди показуються як були.
 *
 * Дата прийому — «Дата прийому» з «Найму» (`employees.hired_at`, звʼязок `employees.manager_id`); немає — `null`
 * («невідомо», у балі як усі: без дати ми не маємо підстави вилучати людину). Розмова ДО дати прийому (стажування) — теж
 * адаптація: вона раніше за кінець 4 тижнів.
 */
export const ADAPTATION_DAYS = 28;

const kyivDay = (iso: string): string => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
const plusDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** `true` — розмова в перші 28 днів (день прийому — день 0, 27-й — ще так, 28-й — уже ні); `null` — дати прийому немає. */
export function onAdaptation(hiredAt: string | null | undefined, calledAt: string): boolean | null {
  if (!hiredAt) return null;
  return kyivDay(calledAt) < plusDays(hiredAt.slice(0, 10), ADAPTATION_DAYS);
}

/** Дата прийому менеджера — латеральним підзапитом. Картка «Найму» на менеджера одна (`uq_employees_manager`). */
export const hiredAtJoin = (managerCol: string): string => `LEFT JOIN LATERAL (
        SELECT e.hired_at::text AS hired_at FROM employees e WHERE e.manager_id = ${managerCol} AND e.hired_at IS NOT NULL LIMIT 1) emp ON true`;
