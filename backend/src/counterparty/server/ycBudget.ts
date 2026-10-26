/**
 * Бюджет транзакцій YouControl (рішення Сергія 23.10): щоб вистачало на планові перевірки 300 діючих клієнтів раз на 3 місяці
 * + щомісячні суди боржникам + до 100 нових.
 *   • витрати за місяць по видах (запити на нових клієнтів, перевірки співробітників, планові, щомісячні суди);
 *   • резерв — скільки треба на планові перевірки й суди на 60 днів наперед;
 *   • залишок < резерву → «Перевірка контрагента» для співробітників зупиняється (Сергій — може), запити на нових клієнтів працюють;
 *   • прогноз: на скільки місяців вистачить залишку.
 */
import type { Pool } from 'pg';
import { PLANNED_CYCLE_DAYS, TX_EST, type BudgetInfo } from '../shared/cpCheck.js';
import type { DebtSource } from './debtSource.js';
import { monitoredLimits } from './courtMonitor.js';
import type { YouScoreApi } from './youscore/client.js';

export type { BudgetInfo };

export interface BudgetOptions { pool: Pool; youscore: YouScoreApi | null; debts?: DebtSource; cycleDays?: number; now?: () => Date; cacheMs?: number }

async function spent(pool: Pool, from: Date): Promise<BudgetInfo['month']> {
  const q = await pool.query("SELECT src, COALESCE(sum(tx), 0) AS tx FROM cp_checks WHERE created_at >= $1 GROUP BY src", [from]);
  const by = Object.fromEntries(q.rows.map((r: { src: string; tx: string }) => [r.src, Number(r.tx)]));
  const mon = await pool.query("SELECT COALESCE(sum(tx), 0) AS tx FROM cl_monitor_runs WHERE started_at >= $1 AND period NOT LIKE 'planned-%'", [from]);
  const m = { req: by.req || 0, tool: by.tool || 0, planned: by.planned || 0, monitor: Number(mon.rows[0].tx) + (by.monitor || 0), total: 0 };
  m.total = m.req + m.tool + m.planned + m.monitor;
  return m;
}

/** Скільки знадобиться на 60 днів: планові, що настануть, + суди боржникам двічі. */
async function reserveOf(pool: Pool, debts: DebtSource | undefined, now: Date, cycleDays: number): Promise<{ reserve: number; perMonth: number }> {
  const q = await pool.query(`SELECT m.code, max(c.created_at) FILTER (WHERE c.status = 'done') AS last
    FROM client_limit_members m JOIN client_limits l ON l.id = m.limit_id AND l.active
    LEFT JOIN cp_checks c ON c.code = m.code AND c.src <> 'monitor'
    WHERE m.code ~ '^([0-9]{8}|[0-9]{10})$' GROUP BY m.code`);
  let soon = 0, perCycle = 0;
  for (const r of q.rows as Array<{ code: string; last: string | null }>) {
    const fop = r.code.length === 10;
    const cost = fop ? TX_EST.fop : r.last ? TX_EST.repeat : TX_EST.full;
    perCycle += fop ? TX_EST.fop : TX_EST.repeat;
    if (!r.last || Date.parse(r.last) + cycleDays * 864e5 < now.getTime() + 60 * 864e5) soon += cost;
  }
  let courts = 0;
  try {
    const ls = await monitoredLimits(pool, debts, now);
    courts = new Set(ls.flatMap(l => l.members.map(x => x.code)).filter(c => /^\d{8}$/.test(c))).size;
  } catch { courts = 0; }
  return { reserve: soon + courts * 2, perMonth: Math.round(perCycle / (cycleDays / 30.4) + courts) };
}

/** Інфо для Сергія + прапорець «мало» для ручних перевірок. Кеш — cacheMs (5 хв), щоб не смикати YouScore на кожен запит. */
export function ycBudget(o: BudgetOptions): () => Promise<BudgetInfo> {
  let at = 0, val: BudgetInfo | null = null;
  return async () => {
    if (val && Date.now() - at < (o.cacheMs ?? 5 * 60_000)) return val;
    const now = (o.now || (() => new Date()))();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [balance, month, last30, r] = await Promise.all([
      o.youscore ? o.youscore.balance() : Promise.resolve(null),
      spent(o.pool, monthStart),
      spent(o.pool, new Date(now.getTime() - 30 * 864e5)).then(x => x.total),
      reserveOf(o.pool, o.debts, now, o.cycleDays ?? PLANNED_CYCLE_DAYS),
    ]);
    const rate = Math.max(last30, r.perMonth);
    val = {
      balance, month, last30, reserve: r.reserve, plannedPerMonth: r.perMonth,
      months: balance === null || !rate ? null : Math.floor((balance / rate) * 10) / 10,
      low: balance !== null && balance < r.reserve,
    };
    at = Date.now();
    return val;
  };
}
