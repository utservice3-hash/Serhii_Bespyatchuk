/**
 * 📞 ДЗВІНКИ КЛІЄНТА ЗА МІСЯЦЬ — число в рядку екрана «Клієнти та реактивація»
 * (ТЗ Юлі 22.09.2026, п.3.3 «кількість дзвінків за місяць»; задача 4312).
 *
 * 🧾 ІСТОРІЯ. До 24.09.2026 рядок показував «📞 0» ТЕКСТОМ у верстці (задача 4310). Тоді число
 * стало «за рік» і рахувалось тим самим ядром, що рядок «Дзвінки по роках» у картці. Блок 3
 * прибрав «Дзвінки по роках» (п.3.4) і попросив «за місяць» — тож модуль переїхав з року на
 * місяць, а річного підрахунку більше немає ніде (гейти #712/#712b/#712c зняті, їх заміна —
 * #774/#774b).
 *
 * Місяць — той, що обраний на екрані (`YYYY-MM`), межі — за КИЄВОМ. Звʼязка —
 * `ringostat_calls.client_key` (канонічний ключ після злиттів). Спільні номери не розводимо:
 * рішення Юлі 24.09.2026 «нічого не чіпаємо».
 *
 * 🟢 РОЗМОВА vs СПРОБА: `billsec > 0` — розмова, решта — недодзвін (рішення власника 04.08.2026);
 * показуються обидва числа, не сумою.
 */

export interface CallsMonth {
  month: string;
  calls: number;
  talks: number;
}

/** SQL один. `$1` — масив канонічних ключів, `$2` — місяць `YYYY-MM`. */
export const CALLS_BY_MONTH_SQL = `
  SELECT client_key,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE billsec > 0)::int AS talks
    FROM ringostat_calls
   WHERE client_key = ANY($1)
     -- Діапазон за КИЇВСЬКИМ часом, а не to_char(...) = $2: так працює індекс (client_key, calldate).
     -- Заміряно 28.09.2026 на 1 187 клієнтах: to_char — 1 126 мс. Межі стереже #774c.
     AND calldate >= (($2 || '-01')::date::timestamp AT TIME ZONE 'Europe/Kyiv')
     AND calldate <  ((($2 || '-01')::date + interval '1 month')::timestamp AT TIME ZONE 'Europe/Kyiv')
   GROUP BY client_key`;

export async function callsByMonth(keys: string[], month: string): Promise<Map<string, { calls: number; talks: number }>> {
  const out = new Map<string, { calls: number; talks: number }>();
  if (keys.length === 0) return out;
  // Пул — лінивим імпортом: `db/pool.js` → `config.js` кидає без DATABASE_URL ще НА ІМПОРТІ,
  // а чисті частини модуля гейт перевіряє без бази.
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ client_key: string; calls: number; talks: number }>(CALLS_BY_MONTH_SQL, [keys, month]);
  for (const x of r.rows) out.set(x.client_key, { calls: Number(x.calls), talks: Number(x.talks) });
  return out;
}

/** Клітинка рядка: дзвінків у місяці немає → справжні нулі з тим самим місяцем, а не «невідомо». */
export function monthCell(m: { calls: number; talks: number } | undefined, month: string): CallsMonth {
  return { month, calls: m?.calls ?? 0, talks: m?.talks ?? 0 };
}
