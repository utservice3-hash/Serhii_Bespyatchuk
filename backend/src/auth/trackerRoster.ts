/**
 * 🧾 РЕЄСТР ЛЮДЕЙ ДЛЯ ТРЕКЕРА — ФОРМА ВІДПОВІДІ, І НІЧОГО БІЛЬШЕ.
 *
 * 🔴 ЧОМУ ОКРЕМИЙ МОДУЛЬ, А НЕ СУСІД У `trackerSso.ts`. Той імпортує `config`, а `config`
 * кидає на відсутньому `JWT_SECRET` ЩЕ НА ІМПОРТІ. Гейт `#323`, що просто лежав поруч,
 * падав у `npm test` без `.env` — тобто зачервонив би крок 0 усім чатам, рівно як мало не
 * зробив `#308` (спіймано на собі 02.09.2026, третій випадок цього класу за два дні).
 * Тут конфігу немає, тож гейт біжить УСЮДИ: і в стенді без `.env`, і в `test:prod`.
 */
/** Рядок реєстру, як його віддає SQL у `/tracker-users`. */
export interface RosterRow {
  id: number; email: string; name: string | null; is_active: boolean;
  tracker_enabled: boolean; team_name: string | null; data_scope: string | null;
}

/**
 * 🔴 БІЛИЙ СПИСОК ПОЛІВ РЕЄСТРУ — ОДНЕ МІСЦЕ, І ВОНО ПЕРЕВІРЯЄТЬСЯ ВЛАСТИВІСТЮ.
 *
 * Винесено з роута НЕ заради охайності. `#323` у першій редакції стверджував «роль за межі
 * дашборду не їде», а перевіряв ОРФОГРАФІЮ — заборону підрядка `role_override }`. Заміряно
 * 01.09.2026: я додав у SELECT `COALESCE(u.role_override, u.role) AS role_key` і в відповідь
 * `roleKey`, викликав обробник — прийшло
 * `{"id":7,…,"scope":"company","roleKey":"hr"}`, а гейт лишився ЗЕЛЕНИМ.
 *
 * Поки формування відповіді жило всередині роута, перевірити МНОЖИНУ ключів було нічим.
 * Тепер це чиста функція: гейт звіряє набір ключів точно, і будь-яке зайве поле червонить
 * незалежно від того, як його написали.
 *
 * ⚠️ Функція — БІЛИЙ СПИСОК, а не копія рядка: зайва колонка в SELECT не додає ключа сама
 * собою. Саме це й перевіряє дзеркало `#323b` — інакше «whitelist» був би на слово.
 */
export function rosterPerson(r: RosterRow): {
  id: number; email: string; name: string; active: boolean;
  trackerEnabled: boolean; team: string | null; scope: "company" | "team" | "own";
} {
  return {
    id: r.id,
    email: r.email,
    name: r.name ?? r.email,
    active: r.is_active,
    trackerEnabled: r.tracker_enabled === true,
    team: r.team_name,
    // Невідома роль означає НАЙМЕНШІ права, ніколи не найбільші: роль, видалену з таблиці,
    // не можна мовчки підвищити.
    scope: r.data_scope === "company" || r.data_scope === "team" ? r.data_scope : "own",
  };
}
