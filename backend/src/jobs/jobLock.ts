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
  return (await heavyJobHolder()) !== null;
}

/**
 * ХТО САМЕ тримає замок і СКІЛЬКИ вже — щоб пропуск синку можна було пояснити
 * (аварія 10.08.2026). Раніше `syncKommo` логував безіменне «важка джоба активна»,
 * і з логу неможливо було відрізнити законні 2 хвилини звірки від мертвого замка,
 * що душить синк годинами. Ім'я + тривалість перетворюють рядок логу на діагноз.
 */
export async function heavyJobHolder(): Promise<{ name: string; heldSec: number } | null> {
  try {
    const r = await pool.query<{ name: string; held_sec: string }>(
      `SELECT name, EXTRACT(EPOCH FROM now() - started_at)::int AS held_sec
         FROM job_locks
        WHERE heartbeat_at > now() - ($1 || ' milliseconds')::interval
        ORDER BY started_at LIMIT 1`,
      [FRESH_MS]
    );
    const x = r.rows[0];
    return x ? { name: x.name, heldSec: Number(x.held_sec) } : null;
  } catch (e) {
    console.error("heavyJobHolder check failed:", e);
    return null;
  }
}

/**
 * Виконати `fn` під замком `name`: узяти замок (upsert), бити heartbeat раз на 30с,
 * ГАРАНТОВАНО зняти в finally. Замок один на ім'я — повторний запуск тієї ж джоби
 * оновлює heartbeat (не плодить рядків). Interval `.unref()` — щоб CLI-процес не
 * лишався живим через таймер.
 */
/**
 * 🔴 СТЕЛЯ ТРИВАЛОСТІ ВАЖКОЇ ДЖОБИ (додано 10.08.2026). Її не було ВЗАГАЛІ: поки
 * процес живий, heartbeat оновлювався кожні 30 с, тож зависла джоба тримала б
 * замок нескінченно й тихо душила `syncKommo` — і виглядало б це як «замок
 * законно зайнятий». Мертвий замок протухав сам лише коли ПРОЦЕС помирав; зависла
 * джоба в живому процесі — ні. 45 хв із запасом: найдовша реальна (12-міс звірка
 * з auto-heal) вкладається в одиниці хвилин.
 */
const MAX_HEAVY_MS = 45 * 60_000;

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
    // Гонка «робота проти стелі»: хто перший. Таймер сам себе не тримає (`unref`),
    // тож нормальне завершення не чекає на нього.
    let bomb: NodeJS.Timeout | undefined;
    const ceiling = new Promise<never>((_, rej) => {
      bomb = setTimeout(
        () => rej(new Error(`${name}: перевищено стелю ${MAX_HEAVY_MS / 60000} хв — джобу визнано завислою`)),
        MAX_HEAVY_MS
      );
      bomb.unref?.();
    });
    try {
      return await Promise.race([fn(), ceiling]);
    } finally {
      if (bomb) clearTimeout(bomb);
    }
  } finally {
    clearInterval(timer);
    // ⚠️ Замок знімаємо В БУДЬ-ЯКОМУ разі, включно з підривом стелі. Сама `fn`
    // може й далі висіти у фоні — але вона більше НЕ блокує синк, і це головне:
    // одна зависла джоба не має зупиняти дані для всієї компанії.
    await pool.query(`DELETE FROM job_locks WHERE name = $1`, [name]).catch(() => {});
  }
}
