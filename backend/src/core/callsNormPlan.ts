import { pool } from "../db/pool.js";

/**
 * 📞 НОРМА ДЗВІНКІВ НА ДЕНЬ — У «ПЛАНАХ» (ТЗ 4632 п.2.5; Юля 10.10.2026: «рахуємо розмови + спроби, як у новій
 * мотивації з 01.10; норма одна на всіх менеджерів — 45 на день»; Роман 10.10.2026: «в Планах», «КВП сама ставить
 * норму», «до наступної зміни»).
 *
 * Норма діє З МІСЯЦЯ й ДО НАСТУПНОЇ ЗМІНИ. Кожна зміна — новий рядок (історія не затирається), тож минулий місяць
 * завжди читається зі СВОЄЮ нормою: нова норма не переписує те, за що людям уже порахували дні з нормою.
 * До 10.10.2026 норма жила в «Налаштуваннях» (`callsDailyNorm`) і так і не була задана — переносити нічого.
 */

import { effectiveNorm, type CallsNormRow } from "./callsNormRules.js";
export { effectiveNorm, canSetCallsNorm, callsNormVerdict, type CallsNormRow } from "./callsNormRules.js";

export async function callsNormHistory(): Promise<CallsNormRow[]> {
  const r = await pool.query<{ from_month: string; norm: number; set_by: string | null; set_at: string }>(
    `SELECT to_char(n.from_month, 'YYYY-MM-DD') AS from_month, n.norm, COALESCE(u.full_name, u.email) AS set_by,
            to_char(n.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS set_at
       FROM calls_norm_plan n LEFT JOIN users u ON u.id = n.set_by
      ORDER BY n.from_month DESC, n.set_at DESC, n.id DESC`);
  return r.rows.map((x) => ({ fromMonth: x.from_month, norm: Number(x.norm), setBy: x.set_by, setAt: x.set_at }));
}

/** Чинна норма на місяць дати `day` (YYYY-MM-DD). Одне джерело для Звіту, Статистик і «Налаштувань». */
export async function callsNormFor(day: string): Promise<number | null> {
  return effectiveNorm(await callsNormHistory(), `${day.slice(0, 7)}-01`);
}

export async function setCallsNorm(norm: number, fromMonth: string, userId: number | null): Promise<void> {
  await pool.query(`INSERT INTO calls_norm_plan (from_month, norm, set_by) VALUES ($1, $2, $3)`, [fromMonth, norm, userId]);
}
