/**
 * 📄 SQL конструктора документів — окремо від роуту, щоб живий гейт #1123b ганяв РІВНО ці рядки проти
 * тимчасової бази, не тягнучи пул прода (імпорт роуту вимагав би DATABASE_URL).
 */

/**
 * ПІБ і телефон автора для рядка «Відповідальна особа Експедитора». Картка співробітника прив'язана
 * або до логіна (`user_id`), або до менеджера CRM (`manager_id`) — беремо свою, діючу першою.
 * Заміряно 30.09.2026: 149 зі 153 прив'язаних карток мають телефон.
 */
export const MANAGER_CONTACT_SQL = `
  SELECT COALESCE(e.full_name, m.name, u.full_name, u.email) AS name, COALESCE(e.phone, '') AS phone
    FROM users u
    LEFT JOIN managers m ON m.id = u.manager_id
    LEFT JOIN LATERAL (
      SELECT full_name, phone FROM employees e
       WHERE e.user_id = u.id OR (u.manager_id IS NOT NULL AND e.manager_id = u.manager_id)
       ORDER BY (e.user_id = u.id) DESC, (e.status = 'active') DESC, (e.phone IS NOT NULL) DESC, e.id DESC
       LIMIT 1) e ON true
   WHERE u.id = $1`;

/**
 * Лічильник «чи користуються функціоналом» (рішення Сергія 30.09.2026). По днях за Києвом, включно
 * з днями без жодного документа — щоб нуль читався як нуль, а не як «дня не було».
 */
export const POOL_STATS_SQL = `
  WITH days AS (
    SELECT generate_series((now() AT TIME ZONE 'Europe/Kyiv')::date - ($1::int - 1),
                           (now() AT TIME ZONE 'Europe/Kyiv')::date, interval '1 day')::date AS day)
  SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
         count(d.id)::int AS docs,
         count(DISTINCT d.created_by)::int AS authors,
         count(d.id) FILTER (WHERE d.doc_kind = 'once')::int AS once,
         count(d.id) FILTER (WHERE d.doc_kind = 'carr')::int AS carr,
         count(d.id) FILTER (WHERE d.doc_kind = 'main')::int AS main
    FROM days
    LEFT JOIN constructor_documents d ON (d.created_at AT TIME ZONE 'Europe/Kyiv')::date = days.day
   GROUP BY days.day ORDER BY days.day DESC`;
