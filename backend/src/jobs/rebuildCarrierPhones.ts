import { pool } from "../db/pool.js";
import { rebuildCarrierPhones as rebuild } from "../core/carrierPhones.js";

/**
 * 📵 ПЕРЕБУДОВА ДОВІДНИКА НОМЕРІВ ПЕРЕВІЗНИКІВ (задача 7359). Щогодини (:22) + старт: джерела — архів Lardi
 * (`collectLardi`, раз на 3 год) і угоди (`syncKommo`, раз на 30 хв); година — щоб новий «Перевізник» доходив до
 * екрана клієнтів за той самий день. Прохід ~2 с (заміряно 03.11.2026 на проді). Під наглядом (`monitoredJobs.ts`):
 * мовчання = довідник застиг, і нові перевізники рахуються розмовами з клієнтом.
 */
export async function rebuildCarrierPhones(): Promise<{ phones: number }> {
  const c = await pool.connect();
  try {
    return { phones: await rebuild(c) };
  } finally {
    c.release();
  }
}
