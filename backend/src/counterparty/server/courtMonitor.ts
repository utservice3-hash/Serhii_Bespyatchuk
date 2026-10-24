/**
 * Щомісячна перевірка судів — ЛИШЕ клієнти з лімітом, які зараз нам винні (рішення Сергія 23.10: «лише тим, хто зараз винен»),
 * по КОЖНІЙ юрособі (обʼєднаний клієнт — кілька). ФОП і нерезиденти — без автоперевірки.
 * Хто за останні 25 днів уже мав планову / ручну перевірку — пропускаємо (суди там свіжі).
 * Ціна: 1 транзакція на юрособу (одна сторінка /v1/courtCaseGroup, до 100 справ).
 *
 * Нова справа (за перевезення, клієнт — відповідач, ще не бачили):
 *   req       → погодження призупиняється: запит знову «На погодженні» з позначкою, рішення за Сергієм;
 *   debt, set → ліміт призупинено: Сергій «Лишити ліміт» або «Змінити ліміт».
 * Запуск — раз на місяць (day, hour), один на кластер (pg_try_advisory_lock), один на місяць (cl_monitor_runs.period).
 */
import type { Pool } from 'pg';
import { buildRows, isNoLimit, type ClientLimit } from '../shared/clientLimits.js';
import type { DebtSource } from './debtSource.js';
import { flagLimit, newCases } from './limitFindings.js';
import { listLimits, markCourtsSeen } from './limitsStore.js';
import type { Meter, YouScoreApi } from './youscore/client.js';
import { parseCourts } from './youscore/parse.js';

export interface MonitorOptions {
  pool: Pool;
  youscore: YouScoreApi | null;
  /** Борг з дебіторки — суди перевіряються лише тим, у кого він зараз є. Не передано — усім клієнтам з лімітом. */
  debts?: DebtSource;
  /** День місяця і година запуску (за часом сервера). За замовчуванням 1-ше число, 06:00. */
  day?: number;
  hour?: number;
  /** Пропускати юрособи, перевірені за останні N днів (планова / ручна перевірка вже має свіжі суди). */
  skipCheckedDays?: number;
  now?: () => Date;
}
export interface MonitorResult { period: string; skipped: boolean; checked: number; tx: number; found: number }

const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export const scheduledAt = (d: Date, day = 1, hour = 6) => new Date(d.getFullYear(), d.getMonth(), Math.min(day, 28), hour, 0, 0, 0);
/** Остання й наступна перевірка — для підпису «Суди — щомісяця, поки є борг; наступна …». */
export async function monitorInfo(pool: Pool, now: Date, day = 1, hour = 6): Promise<{ last: string | null; next: string }> {
  const q = await pool.query("SELECT period, finished_at FROM cl_monitor_runs WHERE finished_at IS NOT NULL AND period NOT LIKE 'planned-%' ORDER BY finished_at DESC LIMIT 1");
  const last = q.rows[0] ? new Date(q.rows[0].finished_at).toISOString() : null;
  const doneThis = q.rows[0] && q.rows[0].period === ym(now);
  const thisMonth = scheduledAt(now, day, hour);
  const next = doneThis || thisMonth <= now ? scheduledAt(new Date(now.getFullYear(), now.getMonth() + 1, 1), day, hour) : thisMonth;
  return { last, next: next.toISOString() };
}

/** Які ліміти перевіряти цього місяця: з боргом > 0 (якщо є дебіторка). */
export async function monitoredLimits(pool: Pool, debts: DebtSource | undefined, now: Date): Promise<ClientLimit[]> {
  const limits = await listLimits(pool, now);
  if (!debts) return limits;
  const d = await debts.debtors();
  const withDebt = new Set(buildRows(limits, d.list).rows.filter(r => !isNoLimit(r) && r.debt > 0).map(r => r.id));
  return limits.filter(l => withDebt.has(l.id));
}

export async function runCourtMonitor(o: MonitorOptions, opts: { force?: boolean; period?: string } = {}): Promise<MonitorResult> {
  const now = (o.now || (() => new Date()))();
  const period = opts.period || ym(now);
  const empty = { period, skipped: true, checked: 0, tx: 0, found: 0 };
  if (!o.youscore) return empty;
  if (!opts.force && now < scheduledAt(now, o.day, o.hour)) return empty;
  const lockClient = await o.pool.connect();
  try {
    const lock = await lockClient.query("SELECT pg_try_advisory_lock(hashtext('cl_court_monitor')) AS ok");
    if (!lock.rows[0].ok) return empty;
    const run = await o.pool.query('INSERT INTO cl_monitor_runs (period) VALUES ($1) ON CONFLICT (period) DO NOTHING RETURNING id', [period]);
    if (!run.rows[0]) return empty;
    const runId = run.rows[0].id;
    const m: Meter = { tx: 0 };
    let checked = 0, found = 0;
    try {
      const limits = await monitoredLimits(o.pool, o.debts, now);
      const recent = new Set((await o.pool.query("SELECT DISTINCT code FROM cp_checks WHERE status = 'done' AND src <> 'monitor' AND done_at > $1",
        [new Date(now.getTime() - (o.skipCheckedDays ?? 25) * 864e5)])).rows.map((x: { code: string }) => x.code));
      const byCode = new Map<string, ClientLimit[]>();
      for (const l of limits) for (const mb of l.members) if (/^\d{8}$/.test(mb.code) && !recent.has(mb.code)) byCode.set(mb.code, [...(byCode.get(mb.code) || []), l]);
      const flagged = new Set<string>();
      for (const [code, ls] of byCode) {
        let g;
        try { g = await o.youscore.courtCaseGroups(code, m, 1); } catch (e) { console.error('[client-limits] суди', code, e instanceof Error ? e.message : e); continue; }
        checked++;
        const { cases } = parseCourts(g.data, now);
        const fresh = await newCases(o.pool, code, cases, null, Math.min(...ls.map(l => Date.parse(l.at))));
        await markCourtsSeen(o.pool, code, cases.map(c => c.no));
        if (!fresh.length) continue;
        for (const l of ls) {
          if (flagged.has(l.id)) continue;
          if (await flagLimit(o.pool, l, code, fresh, now)) { flagged.add(l.id); found++; }
        }
      }
      await o.pool.query('UPDATE cl_monitor_runs SET finished_at = now(), checked = $2, tx = $3, found = $4 WHERE id = $1', [runId, checked, m.tx, found]);
    } catch (e) {
      await o.pool.query('UPDATE cl_monitor_runs SET finished_at = now(), checked = $2, tx = $3, found = $4, error = $5 WHERE id = $1', [runId, checked, m.tx, found, e instanceof Error ? e.message : String(e)]);
      throw e;
    }
    return { period, skipped: false, checked, tx: m.tx, found };
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('cl_court_monitor'))").catch(() => undefined);
    lockClient.release();
  }
}

/** Планувальник: раз на годину дивиться, чи настав час цьогомісячної перевірки. Повертає stop(). */
export function startCourtMonitor(o: MonitorOptions, everyMs = 60 * 60_000): { stop(): void } {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runCourtMonitor(o)
      .then(r => { if (!r.skipped) console.log(`[client-limits] суди ${r.period}: юросіб ${r.checked}, транзакцій ${r.tx}, нові справи в ${r.found} клієнтів`); })
      .catch(e => console.error('[client-limits] суди:', e instanceof Error ? e.message : e))
      .finally(() => { busy = false; });
  };
  const first = setTimeout(tick, 60_000);
  const t = setInterval(tick, everyMs);
  return { stop() { clearTimeout(first); clearInterval(t); } };
}
