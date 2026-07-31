import { pool } from "../db/pool.js";
export { MONITORED_JOBS } from "./monitoredJobs.js";

/**
 * DURABLE-ОБЛІК ПРОГОНІВ ДЖОБ — основа сигналізації (Крок 2, джерело №4).
 *
 * 🔴 НАВІЩО. Досі здоров'я джоб жило в пам'яті процесу і зникало при рестарті:
 * після кожного деплою «остання успішна робота» обнулялась, тож «джоба мертва вже
 * добу» було принципово невидимо. Відсутня колонка `description` одного разу тихо
 * вбила дві джоби — про це дізнались випадково.
 *
 * ПРАВИЛО: `last_success_at` рухається ЛИШЕ при успіху. Помилка пише `last_error`,
 * але НЕ зачіпає останній успіх — інакше історія «колись працювало» стерлась би
 * першим же збоєм, і ми втратили б саме те, що показує давність поломки.
 */
export async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    await pool.query(
      `INSERT INTO job_runs (name, last_success_at, last_error, last_duration_ms, updated_at)
       VALUES ($1, now(), NULL, $2, now())
       ON CONFLICT (name) DO UPDATE
         SET last_success_at = now(), last_error = NULL,
             last_duration_ms = EXCLUDED.last_duration_ms, updated_at = now()`,
      [name, Date.now() - started]
    ).catch((e) => console.error(`job_runs write failed for ${name}:`, e));
  } catch (err) {
    console.error(`${name} failed:`, err);
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await pool.query(
      `INSERT INTO job_runs (name, last_error, last_error_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (name) DO UPDATE
         SET last_error = EXCLUDED.last_error, last_error_at = now(), updated_at = now()`,
      [name, msg]
    ).catch((e) => console.error(`job_runs write failed for ${name}:`, e));
  }
}

