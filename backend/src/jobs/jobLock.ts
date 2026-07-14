import { pool } from "../db/pool.js";

/**
 * КРОК 5 — замок важких Kommo-джоб через БД з heartbeat.
 *
 * Навіщо: замість глобального rate-лімітера (передчасно — у 429 ще не впирались)
 * простіший фікс — поки біжить важка джоба (звірка / бекфіл / auto-heal), `syncKommo`
 * пропускає прохід. Так важкий 12-міс потік не накладається на 30-хв синк і разом
 * вони не перевищують ліміт Kommo (~7 req/s).
 *
 * Чому в БД, а не in-process лічильник: важкі джоби часто запускаються ОКРЕМИМ
 * процесом (`nohup node dist/jobs/…`), не всередині Express — прапорець у пам'яті
 * бекенда їх би не побачив. БД бачать усі процеси.
 *
 * Чому heartbeat, а не просто рядок-замок: якщо джоба впаде (OOM/kill), рядок-замок
 * лишився б навічно і задушив синк (рівно як забутий файл `KOMMO_PAUSED` колись поклав
 * прод у `sync:null`). Heartbeat раз на 30с + поріг свіжості 2 хв → мертвий замок
 * протухає і знімається САМ.
 */
const HEARTBEAT_MS = 30_000; // писати heartbeat раз на 30с, поки джоба біжить
const FRESH_MS = 120_000; // замок «живий», якщо heartbeat молодший за 2 хв

/** Чи біжить ЗАРАЗ якась важка Kommo-джоба (свіжий heartbeat). syncKommo зве це
 *  перед проходом. Помилка БД → false (не блокуємо синк через збій перевірки). */
export async function isHeavyJobActive(): Promise<boolean> {
  try {
    const r = await pool.query<{ name: string }>(
      `SELECT name FROM job_locks WHERE heartbeat_at > now() - ($1 || ' milliseconds')::interval LIMIT 1`,
      [FRESH_MS]
    );
    return r.rows.length > 0;
  } catch (e) {
    console.error("isHeavyJobActive check failed:", e);
    return false;
  }
}

/**
 * Виконати `fn` під замком `name`: узяти замок (upsert), бити heartbeat раз на 30с,
 * ГАРАНТОВАНО зняти в finally. Замок один на ім'я — повторний запуск тієї ж джоби
 * оновлює heartbeat (не плодить рядків). Interval `.unref()` — щоб CLI-процес не
 * лишався живим через таймер.
 */
export async function withHeavyJobLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await pool.query(
    `INSERT INTO job_locks (name, started_at, heartbeat_at) VALUES ($1, now(), now())
     ON CONFLICT (name) DO UPDATE SET started_at = now(), heartbeat_at = now()`,
    [name]
  );
  const timer = setInterval(() => {
    pool
      .query(`UPDATE job_locks SET heartbeat_at = now() WHERE name = $1`, [name])
      .catch((e) => console.error(`job_locks heartbeat (${name}) failed:`, e));
  }, HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await pool.query(`DELETE FROM job_locks WHERE name = $1`, [name]).catch(() => {});
  }
}
