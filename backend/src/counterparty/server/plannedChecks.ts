/**
 * Планова повторна перевірка клієнтів з лімітом — раз на 3 місяці (рішення Сергія 23.10: «300 діючих + до 100 нових, щоб ліміту YouControl вистачало»).
 * Хто: усі юрособи / ФОП з «Лімітів клієнтів» (нерезиденти — ні), чия остання перевірка старша за cycleDays (91).
 * Як: щодня о hour (06:00) не більше perDay (10) — 300 клієнтів розходяться по кварталу без піку; по одній, без паралельних запитів.
 * Ціна: 4 транзакції (ФОП — 3); перша перевірка клієнта без жодної попередньої — 5 (з історією змін).
 * Результат — як будь-яка перевірка клієнта з лімітом (server/limitFindings.ts): нова справа → призупинення; інші зміни → позначка.
 */
import type { Pool } from 'pg';
import { PLANNED_CYCLE_DAYS } from '../shared/cpCheck.js';
import type { CheckRunner } from './cpChecks.js';

export interface PlannedOptions {
  pool: Pool;
  runner: CheckRunner;
  /** Як часто перевіряти, днів. За замовчуванням 91 (раз на 3 місяці). */
  cycleDays?: number;
  /** Скільки перевірок на день, не більше. За замовчуванням 10. */
  perDay?: number;
  /** О котрій запускати (за часом сервера). За замовчуванням 6. */
  hour?: number;
  now?: () => Date;
}
export interface PlannedResult { day: string; skipped: boolean; checked: number; failed: number }

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Кого час перевірити: давно не перевіряли (або ніколи); нещодавно невдала спроба (тиждень) — не повторюємо щодня. */
export async function dueCodes(pool: Pool, now: Date, cycleDays: number, limit: number): Promise<string[]> {
  const q = await pool.query(`SELECT m.code,
      max(c.created_at) FILTER (WHERE c.status <> 'failed') AS last_ok,
      max(c.created_at) FILTER (WHERE c.status = 'failed') AS last_fail
    FROM client_limit_members m
    JOIN client_limits l ON l.id = m.limit_id AND l.active
    LEFT JOIN cp_checks c ON c.code = m.code AND c.src <> 'monitor'
    WHERE m.code ~ '^([0-9]{8}|[0-9]{10})$'
    GROUP BY m.code
    HAVING (max(c.created_at) FILTER (WHERE c.status <> 'failed') IS NULL OR max(c.created_at) FILTER (WHERE c.status <> 'failed') < $1)
       AND (max(c.created_at) FILTER (WHERE c.status = 'failed') IS NULL OR max(c.created_at) FILTER (WHERE c.status = 'failed') < $2)
    ORDER BY last_ok NULLS FIRST, m.code
    LIMIT $3`, [new Date(now.getTime() - cycleDays * 864e5), new Date(now.getTime() - 7 * 864e5), limit]);
  return q.rows.map((r: { code: string }) => r.code);
}

/** Скільки юросіб / ФОП на плановій перевірці і скільки з них «прострочені» — для прогнозу витрат. */
export async function plannedScope(pool: Pool): Promise<{ legal: number; fop: number }> {
  const q = await pool.query(`SELECT count(DISTINCT m.code) FILTER (WHERE m.code ~ '^[0-9]{8}$') AS legal, count(DISTINCT m.code) FILTER (WHERE m.code ~ '^[0-9]{10}$') AS fop
    FROM client_limit_members m JOIN client_limits l ON l.id = m.limit_id AND l.active`);
  return { legal: Number(q.rows[0].legal) || 0, fop: Number(q.rows[0].fop) || 0 };
}

export async function runPlannedChecks(o: PlannedOptions, opts: { force?: boolean } = {}): Promise<PlannedResult> {
  const now = (o.now || (() => new Date()))();
  const day = ymd(now);
  const empty = { day, skipped: true, checked: 0, failed: 0 };
  if (!opts.force && now.getHours() < (o.hour ?? 6)) return empty;
  const lockClient = await o.pool.connect();
  try {
    const lock = await lockClient.query("SELECT pg_try_advisory_lock(hashtext('cp_planned_checks')) AS ok");
    if (!lock.rows[0].ok) return empty;
    const run = await o.pool.query('INSERT INTO cl_monitor_runs (period) VALUES ($1) ON CONFLICT (period) DO NOTHING RETURNING id', ['planned-' + day + (opts.force ? '-' + now.getTime() : '')]);
    if (!run.rows[0]) return empty;
    const codes = await dueCodes(o.pool, now, o.cycleDays ?? PLANNED_CYCLE_DAYS, o.perDay ?? 10);
    let checked = 0, failed = 0, tx = 0;
    for (const code of codes) {
      const c = await o.runner.runNow(code, null, 'planned').catch(() => null);   // по одній: без піку запитів до YouScore
      if (!c || c.status !== 'done') failed++; else checked++;
      tx += c ? c.tx : 0;
    }
    await o.pool.query('UPDATE cl_monitor_runs SET finished_at = now(), checked = $2, tx = $3 WHERE id = $1', [run.rows[0].id, checked, tx]);
    return { day, skipped: false, checked, failed };
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('cp_planned_checks'))").catch(() => undefined);
    lockClient.release();
  }
}

/** Планувальник: раз на годину; після hour — одна порція на день. Повертає stop(). */
export function startPlannedChecks(o: PlannedOptions, everyMs = 60 * 60_000): { stop(): void } {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runPlannedChecks(o)
      .then(r => { if (!r.skipped && (r.checked || r.failed)) console.log(`[client-limits] планова перевірка ${r.day}: ${r.checked} перевірено, ${r.failed} не вдалося`); })
      .catch(e => console.error('[client-limits] планова перевірка:', e instanceof Error ? e.message : e))
      .finally(() => { busy = false; });
  };
  const first = setTimeout(tick, 90_000);
  const t = setInterval(tick, everyMs);
  return { stop() { clearTimeout(first); clearInterval(t); } };
}
