/**
 * 📞 ДЗВІНКИ КЛІЄНТА ПО РОКАХ — ОДНЕ ДЖЕРЕЛО ДЛЯ КАРТКИ І ДЛЯ РЯДКА СПИСКУ
 * (ТЗ Юлі 22.09.2026, блок 1, п.1.4; задача 4310).
 *
 * 🔴 НАВІЩО ОКРЕМИЙ МОДУЛЬ. До 24.09.2026 рядок списку «Клієнти та реактивація»
 * показував «📞 0» ТЕКСТОМ, зашитим у верстку, а поруч у картці того самого клієнта
 * рахувались справжні дзвінки (Energy Group: у рядку 0, у картці 33). Щоб рядок і
 * картка не розійшлись удруге, обидва беруть число з ЦІЄЇ функції, а не кожен свій SQL.
 *
 * Звʼязка — `ringostat_calls.client_key` (канонічний ключ після злиттів), рівно як
 * було в картці. Перехід на «дзвінки на номери контактів клієнта» свідомо НЕ тут:
 * 7 662 номери з 75 008 належать кільком клієнтам одразу, і правило для спільного
 * номера — відкрите питання до Юлі (заміряно 24.09.2026).
 *
 * 🟢 РОЗМОВА vs СПРОБА: `billsec > 0` — розмова, решта — недодзвін. Два різні факти
 * (рішення власника 04.08.2026); показуються обидва, не сумою.
 *
 * ⚠️ Глибина памʼяті: найраніший дзвінок у базі — 01.09.2025. Порожній рік раніше
 * означає «даних не існує», а не «не дзвонили»; картка це підписує (`callsSince`).
 */

export interface CallYear {
  year: number;
  calls: number;
  talks: number;
  totalSec: number;
  lastAt: string | null;
}

/** SQL один на обидва екрани. `$1` — масив канонічних ключів. */
export const CALLS_BY_YEAR_SQL = `
  SELECT client_key,
         date_part('year', calldate AT TIME ZONE 'Europe/Kyiv')::int AS year,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE billsec > 0)::int AS talks,
         COALESCE(SUM(billsec), 0)::bigint AS total_sec,
         MAX(calldate)::text AS last_at
    FROM ringostat_calls
   WHERE client_key = ANY($1)
   GROUP BY client_key, 2
   ORDER BY client_key, 2 DESC`;

export async function callsByYear(keys: string[]): Promise<Map<string, CallYear[]>> {
  const out = new Map<string, CallYear[]>();
  if (keys.length === 0) return out;
  // Пул — лінивим імпортом: `db/pool.js` → `config.js` кидає без DATABASE_URL ще НА ІМПОРТІ,
  // а чисті частини модуля (`yearCell`, `CALLS_BY_YEAR_SQL`) гейт перевіряє без бази.
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ client_key: string; year: number; calls: number; talks: number; total_sec: string; last_at: string | null }>(
    CALLS_BY_YEAR_SQL, [keys]);
  for (const x of r.rows) {
    const list = out.get(x.client_key) ?? [];
    list.push({ year: Number(x.year), calls: Number(x.calls), talks: Number(x.talks), totalSec: Number(x.total_sec), lastAt: x.last_at });
    out.set(x.client_key, list);
  }
  return out;
}

/**
 * Число для рядка списку: рівно той рядок «розмов N із M», що картка показує за
 * поточний рік. Року в даних немає → нулі з тим самим роком: це справжній нуль
 * (глибина памʼяті з 2025 покриває весь поточний рік), а не «невідомо».
 */
export function yearCell(years: CallYear[] | undefined, year: number): { year: number; calls: number; talks: number } {
  const y = years?.find((v) => v.year === year);
  return { year, calls: y?.calls ?? 0, talks: y?.talks ?? 0 };
}
