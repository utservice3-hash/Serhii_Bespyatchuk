/**
 * Звірка відкритих запитів із Kommo.
 *  - Перевізник з'являється в CRM, коли менеджер відправляє заявку на оплату → знімок оновлюється, назва підтягується.
 *  - «Мінус зріс» (рішення 20.10): погоджений запит, у якого бюджет у CRM став меншим, ніж при погодженні,
 *    знову стає «На погодженні» з позначкою «було → стало». Доплата клієнта (бюджет зріс) погодження не знімає.
 *  - «Оплачено» й «Відхилено» не звіряються — це кінцеві статуси.
 * Запуск: джоба `minusRegistrySync` у нашому розкладі (index.ts, раз на 10 хв, під наглядом job_runs) — замість setInterval пакета.
 * Роутер ще й звіряє «свої» запити Сергія й бухгалтерії при відкритті реєстру.
 */
import type { Pool } from 'pg';
import { describeChange, minusGrew, revokeNote, type CrmDeal, type Status } from './shared/minusRegistry.js';
import type { DealSource } from './kommoSource.js';
import { addEvent, tx } from './store.js';

export const OPEN_STATUSES: Status[] = ['pending', 'returned', 'approved'];
export type SyncOutcome = 'revoked' | 'updated' | 'missing' | 'skipped' | 'failed';

/** Звірити один запит. Kommo питаємо поза транзакцією; рішення — під блокуванням рядка. */
export async function syncOne(pool: Pool, deals: DealSource, id: string): Promise<SyncOutcome> {
  const row = (await pool.query('SELECT deal_id, status FROM minus_deal_requests WHERE id = $1', [id])).rows[0];
  if (!row || !OPEN_STATUSES.includes(row.status)) return 'skipped';
  let fresh: CrmDeal | null;
  try { fresh = await deals.fetchDeal(String(row.deal_id)); }
  catch { return 'failed'; }
  return tx(pool, async c => {
    const cur = (await c.query('SELECT status, crm, approved_crm FROM minus_deal_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur || !OPEN_STATUSES.includes(cur.status)) return 'skipped';
    if (!fresh) { await c.query('UPDATE minus_deal_requests SET synced_at = now() WHERE id = $1', [id]); return 'missing'; }
    const approved = cur.approved_crm as CrmDeal | null;
    if (cur.status === 'approved' && approved && minusGrew(approved.budget, fresh)) {
      await c.query(`UPDATE minus_deal_requests SET status = 'pending', crm = $2, grew = $3, approved_crm = NULL, updated_at = now(), synced_at = now() WHERE id = $1`,
        [id, JSON.stringify(fresh), JSON.stringify({ budget: approved.budget, what: describeChange(approved, fresh) })]);
      await addEvent(c, id, 'revoked', null, revokeNote(approved.budget, approved, fresh), { before: approved.budget, after: fresh.budget });
      return 'revoked';
    }
    await c.query('UPDATE minus_deal_requests SET crm = $2, synced_at = now() WHERE id = $1', [id, JSON.stringify(fresh)]);
    return 'updated';
  });
}

export interface SyncOptions {
  statuses?: Status[];   // які статуси звіряти (за замовчуванням усі відкриті)
  maxAgeMs?: number;     // лише ті, що звіряли раніше, ніж maxAgeMs тому
  budgetMs?: number;     // не довше за стільки (решта — наступного разу)
  limit?: number;
  concurrency?: number;  // Kommo дозволяє ~7 запитів/с; одна угода — 2–3 запити
}
export async function syncStale(pool: Pool, deals: DealSource, o: SyncOptions = {}) {
  const started = Date.now();
  const ids: string[] = (await pool.query(
    `SELECT id FROM minus_deal_requests WHERE status = ANY($1) AND synced_at < now() - make_interval(secs => $2::double precision / 1000)
     ORDER BY synced_at LIMIT $3`, [o.statuses || OPEN_STATUSES, o.maxAgeMs ?? 0, o.limit ?? 200])).rows.map(r => String(r.id));
  const res: Record<SyncOutcome, number> = { revoked: 0, updated: 0, missing: 0, skipped: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < ids.length && (o.budgetMs === undefined || Date.now() - started < o.budgetMs)) {
      const id = ids[next++];
      res[await syncOne(pool, deals, id)]++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 2, ids.length || 1)) }, worker));
  return { checked: ids.length, ...res };
}

/** Один тік фонової звірки для нашої джоби (index.ts) — те саме, що робив `startMinusRegistrySync` пакета раз на 10 хв. */
export const SYNC_EVERY_MS = 10 * 60_000;
export function runMinusRegistrySync(pool: Pool, deals: DealSource) {
  return syncStale(pool, deals, { maxAgeMs: SYNC_EVERY_MS / 2 });
}
