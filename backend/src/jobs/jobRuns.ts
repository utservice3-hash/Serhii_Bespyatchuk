import { pool } from "../db/pool.js";
export { MONITORED_JOBS } from "./monitoredJobs.js";

/**
 * 🚨 ПРОПУСК — ЦЕ НЕ УСПІХ (аварія 10.08.2026, 14 год 52 хв).
 *
 * Джоба, що вийшла рано (замок зайнятий, попередній прохід «ще біжить»), поверне
 * цей об'єкт замість `undefined`. `runJob` запише його як ПРОПУСК, а не як успіх.
 *
 * 🔴 ЧОМУ ЦЕ КОШТУВАЛО 15 ГОДИН. `syncKommo` залипла на in-process прапорці
 * `syncRunning=true` і кожні 30 хв виходила ПЕРШИМ рядком функції. `runJob` бачив
 * «проміс виконався без помилки» і писав `last_success_at = now()`,
 * `last_duration_ms = 0`. Тобто **джерело правди про здоров'я джоби 30 разів
 * поспіль повідомляло «все добре» саме тому, що вона не працювала**. Ані звірка,
 * ані вартовий свіжості не мали шансу — вони дивились на успіх.
 */
export interface JobSkip { skipped: true; reason: string }
export const jobSkip = (reason: string): JobSkip => ({ skipped: true, reason });
const isSkip = (v: unknown): v is JobSkip =>
  typeof v === "object" && v !== null && (v as JobSkip).skipped === true;

/** Скільки пропусків поспіль терпимо, поки не назвемо це аварією. */
export const SKIP_ALERT_THRESHOLD = 3;

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
 *
 * 🔴 І ДЗЕРКАЛЬНЕ ПРАВИЛО (10.08.2026): УСПІХ НЕ СТИРАЄ `last_error`. Раніше тут
 * стояло `last_error = NULL` при кожному успіху. Помилка о 18:00:28, що почала
 * аварію, була затерта наступним же «успіхом за 0 мс» — і текст причини ми
 * втратили НАЗАВЖДИ, ще до того, як дізнались про аварію. Тепер свіжість помилки
 * визначається порівнянням `last_error_at` із `last_success_at`, а не її
 * знищенням. Дешевше зберегти рядок, ніж удруге втратити причину.
 */
export async function runJob(name: string, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    const res = await fn();
    if (isSkip(res)) {
      // Пропуск: успіх НЕ рухається, лічильник пропусків росте. Саме цей лічильник
      // і перетворює «тихо нічого не роблю» на видиму аварію.
      const r = await pool.query<{ consecutive_skips: number }>(
        `INSERT INTO job_runs (name, last_skip_at, last_skip_reason, consecutive_skips, updated_at)
         VALUES ($1, now(), $2, 1, now())
         ON CONFLICT (name) DO UPDATE
           SET last_skip_at = now(), last_skip_reason = EXCLUDED.last_skip_reason,
               consecutive_skips = job_runs.consecutive_skips + 1, updated_at = now()
         RETURNING consecutive_skips`,
        [name, res.reason.slice(0, 300)]
      );
      const n = r.rows[0]?.consecutive_skips ?? 1;
      console.warn(`${name}: ПРОПУСК #${n} — ${res.reason}`);
      if (n === SKIP_ALERT_THRESHOLD || (n > SKIP_ALERT_THRESHOLD && n % 10 === 0)) {
        const { sendAdminAlert } = await import("../bot/notify.js");
        await sendAdminAlert(
          `🚨 <b>${name}: ${n} пропусків поспіль</b>\nПричина: ${res.reason}\n`
          + `Джоба НЕ працює, хоч і не падає. Саме так минув простій 14 год 52 хв 10.08.2026.`
        ).catch(() => {});
      }
      return;
    }
    await pool.query(
      `INSERT INTO job_runs (name, last_success_at, last_duration_ms, consecutive_skips, updated_at)
       VALUES ($1, now(), $2, 0, now())
       ON CONFLICT (name) DO UPDATE
         SET last_success_at = now(),
             last_duration_ms = EXCLUDED.last_duration_ms, consecutive_skips = 0, updated_at = now()`,
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

