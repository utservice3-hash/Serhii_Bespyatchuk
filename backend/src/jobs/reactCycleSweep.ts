/**
 * 🔁 НІЧНИЙ ПРОХІД ЦИКЛУ РЕАКТИВАЦІЇ (ТЗ Юлі 22.09.2026, блок 4, п.4.3; задача 4313).
 *
 * Щоночі (00:40 за Києвом) і на старті:
 *  1. відкриті рядки пулу, чий клієнт ожив (зʼявився рахунок), закриваються з причиною `invoice` (4.4);
 *  2. клієнти в реактивації, у яких минув строк без рахунку й без дії (або минув строк «Реактивую сам»),
 *     кладуться в пул лідгенів (4.3).
 *
 * Ідемпотентно: повторний прогін тієї самої ночі нічого не змінює (#846). Щоденний, а не 1-го числа:
 * пропущена ніч (рестарт, падіння) лише зсуває передачу на добу, а не на місяць.
 *
 * Добір — ТОЙ САМИЙ, що екран «Клієнти та реактивація» (`clientsListSql` + `inClientsScreen`): у пул
 * потрапляє лише той, кого менеджер міг побачити у вкладці й натиснути кнопку.
 */
import { pool } from "../db/pool.js";
import { clientsListSql } from "../core/clientPlansList.js";
import { GENERIC_CLIENT_KEYS } from "../core/metrics.js";
import { loadClientSegments, factsFor, inClientsScreen } from "../core/clientSegments.js";
import { lastInvoiceByClientKey } from "../core/money.js";
import { kyivToday } from "../core/dates.js";
import { planSweep, type Candidate } from "../core/reactCycleRules.js";
import { cyclesFor, openPool, closeRevived, poolAuto } from "../core/reactCycle.js";

/** Добір екрана клієнтів + дата останнього рахунку + дебіторка — одним місцем для джоби й роутів. */
export async function reactCandidates(): Promise<Candidate[]> {
  const seg = await loadClientSegments();
  const base = await pool.query<{ client_key: string; manager_id: number }>(clientsListSql(""), [GENERIC_CLIENT_KEYS]);
  const rows = base.rows.filter((r) => inClientsScreen(factsFor(seg, r.client_key)));
  const keys = rows.map((r) => r.client_key);
  const [inv, debt] = await Promise.all([
    lastInvoiceByClientKey(keys),
    pool.query<{ client_key: string }>(
      `SELECT DISTINCT client_key FROM receivables WHERE overdue_days > 0 AND client_key = ANY($1)`, [keys]),
  ]);
  const debtKeys = new Set(debt.rows.map((r) => r.client_key));
  return rows.map((r) => ({ clientKey: r.client_key, lastInvoice: inv.get(r.client_key) ?? null,
    managerId: r.manager_id, debtHold: debtKeys.has(r.client_key) }));
}

export async function runReactCycleSweep(): Promise<{ pooled: number; closed: number }> {
  const nowYm = kyivToday().slice(0, 7);
  const candidates = await reactCandidates();
  const open = await openPool(pool);
  const openInv = await lastInvoiceByClientKey(open.map((o) => o.clientKey));
  const rows = await cyclesFor(pool, candidates.map((c) => c.clientKey));
  const actions = planSweep(candidates, rows,
    open.map((o) => ({ clientKey: o.clientKey, cycleMonth: o.cycleMonth, lastInvoice: openInv.get(o.clientKey) ?? null })), nowYm);
  const closed = await closeRevived(pool, actions.close);
  const pooled = await poolAuto(pool, actions.pool);
  console.log(`reactCycleSweep: у пул ${pooled}, закрито (ожили) ${closed}, кандидатів ${candidates.length}`);
  return { pooled, closed };
}
