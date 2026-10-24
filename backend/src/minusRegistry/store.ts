/** Реєстр мінусових угод — читання й запис у Postgres (таблиці — у db/schema.sql, блок «Реєстр мінусових угод»). */
import type { Pool, PoolClient } from 'pg';
import type { EventType, RegRequest, RegUser, Status } from './shared/minusRegistry.js';

export type Db = Pool | PoolClient;
/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (v: unknown) => new Date(v as string).toISOString();

export function toRequest(row: any): RegRequest {
  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    status: row.status as Status,
    comment: row.comment,
    crm: row.crm,
    grew: row.grew || null,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: iso(row.created_at),
    hist: (row.hist || []).map((e: any) => ({ type: e.type as EventType, by: e.by_id ?? null, byName: e.by_name ?? null, at: iso(e.at), note: e.note || '' })),
  };
}

const SELECT = `SELECT r.*, COALESCE((
    SELECT json_agg(json_build_object('type', e.type, 'by_id', e.by_id, 'by_name', e.by_name, 'note', e.note, 'at', e.at) ORDER BY e.at, e.id)
    FROM minus_deal_events e WHERE e.request_id = r.id), '[]'::json) AS hist
  FROM minus_deal_requests r`;

/** Список: свіжа дія — вище (за останньою зміною статусу). owners — лише запити цих користувачів (свої + команда тім-ліда). */
export async function listRequests(db: Db, owners?: string | string[]): Promise<RegRequest[]> {
  const ids = owners === undefined ? undefined : Array.isArray(owners) ? owners : [owners];
  const q = ids
    ? await db.query(`${SELECT} WHERE r.created_by = ANY($1::text[]) ORDER BY r.updated_at DESC, r.id DESC`, [ids])
    : await db.query(`${SELECT} ORDER BY r.updated_at DESC, r.id DESC`);
  return q.rows.map(toRequest);
}

export async function getRequest(db: Db, id: string): Promise<RegRequest | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const q = await db.query(`${SELECT} WHERE r.id = $1`, [id]);
  return q.rows[0] ? toRequest(q.rows[0]) : null;
}

export async function addEvent(db: Db, requestId: string | number, type: EventType, by: { id: string; name: string } | null, note = '', data?: unknown) {
  await db.query('INSERT INTO minus_deal_events (request_id, type, by_id, by_name, note, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [requestId, type, by ? by.id : null, by ? by.name : null, note, data === undefined ? null : JSON.stringify(data)]);
}

/** Скільки запитів чекає дії цього користувача — той самий підрахунок, що needsMe() у shared. */
export async function countForMe(db: Db, me: RegUser): Promise<number> {
  let q;
  if (me.role === 'approver') q = await db.query("SELECT count(*) FROM minus_deal_requests WHERE status = 'pending'");
  else if (me.role === 'accounting') q = await db.query("SELECT count(*) FROM minus_deal_requests WHERE status = 'approved'");
  else if (me.role === 'manager' || me.role === 'lead') q = await db.query("SELECT count(*) FROM minus_deal_requests WHERE status = 'returned' AND created_by = $1", [me.id]);
  else return 0;
  return Number(q.rows[0].count);
}

export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  finally { c.release(); }
}
