import type { Db } from "./adCallFacts.js";

/**
 * 📅 КАЛЕНДАР КОМАНДИ ДЛЯ ТАЙМ-ТРЕКЕРА (04.11.2026, контракт погоджено з трекером того ж дня). Наступник
 * `trackerVacations`: замість самих відпусток — усі відсутності, чергування і свята за період. Старий `vacations`
 * лишається, доки трекер не скаже, що перейшов.
 *
 * Дашборд — єдине джерело, трекер лише читає (кеш 15 хв у нього). Правила відповіді (погоджено з трекером):
 *  · відсутності — погоджені Й «на погодженні», зі `status`: трекер рахує лише `approved`, а `pending` показує
 *    керівнику «очікує погодження» (інакше людина з непогодженим лікарняним виглядає прогульником). Відхилені — ні;
 *  · кожен запис, що ПЕРЕТИНАЄ період, з повними датами (не обрізаними), обидва кінці включно, київські календарні дні;
 *  · `hours` — на скільки годин день КОРОТШИЙ (так його вводять у календарі: «скороч. −N год»), лише для `short_day`;
 *  · `until` — кінець вечірньої зміни: «Вечір 18–21» (так підписано в календарі), для решти змін `null`;
 *  · звільнені й вимкнені — віддаємо з `active: false` (історія: звіт за минулий місяць мусить показати відпустку,
 *    а не прогул), рішення трекера;
 *  · людина — `dashboardUserId` = users.id (той самий, що в `/auth/tracker-users`), email у нижньому регістрі.
 *    Чергування зберігається лише з `manager_id` → акаунт за `users.manager_id` (активний першим, як у відпустках).
 *    Записи людей без акаунта не віддаємо: у трекері таких немає.
 */

/** Кінець вечірньої зміни (`duty_schedule.shift = 'evening'`, «Вечір 18–21»). Окремої колонки в базі немає. */
export const EVENING_UNTIL = "21:00";

/** Акаунт для рядка, записаного з `manager_id`: активний першим, потім найменший id. */
const OWNER_BY_MANAGER = (col: string) =>
  `(SELECT u2.id FROM users u2 WHERE u2.manager_id = ${col} ORDER BY u2.is_active DESC, u2.id LIMIT 1)`;

export const TRACKER_ABSENCES_SQL = `
  SELECT a.id, u.id AS user_id, lower(u.email) AS email, u.is_active, a.kind, a.status,
         to_char(a.start_date, 'YYYY-MM-DD') AS from_date, to_char(a.end_date, 'YYYY-MM-DD') AS until_date, a.hours
    FROM team_calendar_absences a
    JOIN users u ON u.id = COALESCE(a.user_id, ${OWNER_BY_MANAGER("a.manager_id")})
   WHERE a.status IN ('approved', 'pending')
     AND a.start_date <= $2::date AND a.end_date >= $1::date
   ORDER BY a.start_date, a.id`;

export const TRACKER_DUTY_SQL = `
  SELECT d.id, u.id AS user_id, lower(u.email) AS email, u.is_active,
         to_char(d.duty_date, 'YYYY-MM-DD') AS duty_date, d.shift
    FROM duty_schedule d
    JOIN users u ON u.id = ${OWNER_BY_MANAGER("d.manager_id")}
   WHERE d.duty_date BETWEEN $1::date AND $2::date
   ORDER BY d.duty_date, d.id`;

export const TRACKER_HOLIDAYS_SQL = `
  SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name
    FROM company_holidays
   WHERE holiday_date BETWEEN $1::date AND $2::date
   ORDER BY holiday_date`;

export interface AbsenceRow { id: number; user_id: number; email: string; is_active: boolean; kind: string; status: string; from_date: string; until_date: string; hours: string | number | null }
export interface DutyRow { id: number; user_id: number; email: string; is_active: boolean; duty_date: string; shift: string }
export interface HolidayRow { holiday_date: string; name: string }

export interface TrackerCalendar {
  absences: { id: number; dashboardUserId: number; email: string; kind: string; status: string; from: string; until: string; hours: number | null; active: boolean }[];
  duty: { id: number; dashboardUserId: number; email: string; date: string; shift: string; until: string | null; active: boolean }[];
  holidays: { date: string; name: string }[];
}

/** Рядки бази → відповідь трекеру. Чиста функція: контракт (`#3352b`) звіряє її з прикладом для трекера. */
export function trackerCalendarFrom(abs: readonly AbsenceRow[], duty: readonly DutyRow[], hol: readonly HolidayRow[]): TrackerCalendar {
  return {
    absences: abs.map((a) => ({
      id: a.id, dashboardUserId: a.user_id, email: a.email, kind: a.kind, status: a.status,
      from: a.from_date, until: a.until_date,
      hours: a.kind === "short_day" && a.hours != null ? Number(a.hours) : null,
      active: a.is_active,
    })),
    duty: duty.map((d) => ({
      id: d.id, dashboardUserId: d.user_id, email: d.email, date: d.duty_date, shift: d.shift,
      until: d.shift === "evening" ? EVENING_UNTIL : null,
      active: d.is_active,
    })),
    holidays: hol.map((h) => ({ date: h.holiday_date, name: h.name })),
  };
}

/** Календар за [from, to]; період уже перевірено `trackerPeriodError`. */
export async function trackerCalendar(db: Db, from: string, to: string): Promise<TrackerCalendar> {
  const [a, d, h] = await Promise.all([
    db.query<AbsenceRow>(TRACKER_ABSENCES_SQL, [from, to]),
    db.query<DutyRow>(TRACKER_DUTY_SQL, [from, to]),
    db.query<HolidayRow>(TRACKER_HOLIDAYS_SQL, [from, to]),
  ]);
  return trackerCalendarFrom(a.rows, d.rows, h.rows);
}
