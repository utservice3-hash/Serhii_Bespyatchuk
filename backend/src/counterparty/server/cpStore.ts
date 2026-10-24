/** «Узгодження» і «Перевірка контрагента» — читання й запис у Postgres (таблиці з migrations/003_counterparty.sql). */
import type { Pool, PoolClient } from 'pg';
import type { CpEventType, CpRequest, CpRequestView, CpUser, ReqStatus } from '../shared/counterparty.js';
import { RECHECK_MONTHS, type CpCheck } from '../shared/cpCheck.js';

export type Db = Pool | PoolClient;
/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : '');
const sid = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function toRequest(row: any): CpRequest {
  return {
    id: String(row.id),
    resident: !!row.resident,
    code: row.code,
    country: row.country ?? null,
    regNo: row.reg_no ?? null,
    name: row.name,
    kind: row.kind,
    status: row.status as ReqStatus,
    terms: row.terms,
    ok: row.ok ?? null,
    change: row.change ?? null,
    flag: row.flag ?? null,
    rates: row.rates,
    checkId: sid(row.check_id),
    checkSaved: !!row.check_saved,
    recheckId: sid(row.recheck_id),
    files: (row.files || []).map((f: any) => ({ id: String(f.id), name: f.name, size: Number(f.size) })),
    comment: row.comment || '',
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    hist: (row.hist || []).map((e: any) => ({ type: e.type as CpEventType, by: e.by_id ?? null, byName: e.by_name ?? null, at: iso(e.at), note: e.note || '' })),
  };
}

const SELECT_REQ = `SELECT r.*,
  COALESCE((SELECT json_agg(json_build_object('type', e.type, 'by_id', e.by_id, 'by_name', e.by_name, 'note', e.note, 'at', e.at) ORDER BY e.at, e.id)
    FROM cp_events e WHERE e.request_id = r.id), '[]'::json) AS hist,
  COALESCE((SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'size', f.size) ORDER BY f.id)
    FROM cp_files f WHERE f.request_id = r.id), '[]'::json) AS files
  FROM cp_requests r`;

/** Список: остання зміна — вище. owners — лише запити цих користувачів (свої + команда тім-ліда). */
export async function listRequests(db: Db, owners?: string[]): Promise<CpRequest[]> {
  const q = owners
    ? await db.query(`${SELECT_REQ} WHERE r.created_by = ANY($1::text[]) ORDER BY r.updated_at DESC, r.id DESC`, [owners])
    : await db.query(`${SELECT_REQ} ORDER BY r.updated_at DESC, r.id DESC`);
  return q.rows.map(toRequest);
}
export async function getRequest(db: Db, id: string): Promise<CpRequest | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const q = await db.query(`${SELECT_REQ} WHERE r.id = $1`, [id]);
  return q.rows[0] ? toRequest(q.rows[0]) : null;
}
export async function activeRequestByCode(db: Db, code: string): Promise<CpRequest | null> {
  const q = await db.query(`${SELECT_REQ} WHERE r.resident AND r.code = $1 AND r.status IN ('checking', 'pending', 'returned', 'approved') ORDER BY r.id DESC LIMIT 1`, [code]);
  return q.rows[0] ? toRequest(q.rows[0]) : null;
}
/** Найсвіжіший запит з цим кодом (будь-який статус) — для підказки в панелі перевірки. */
export async function lastRequestByCode(db: Db, code: string): Promise<CpRequest | null> {
  const q = await db.query(`${SELECT_REQ} WHERE r.code = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [code]);
  return q.rows[0] ? toRequest(q.rows[0]) : null;
}

export async function addEvent(db: Db, requestId: string | number, type: CpEventType, by: { id: string; name: string } | null, note = '', data?: unknown) {
  await db.query('INSERT INTO cp_events (request_id, type, by_id, by_name, note, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [requestId, type, by ? by.id : null, by ? by.name : null, note, data === undefined ? null : JSON.stringify(data)]);
}

/** Скільки запитів чекає дії цього користувача — той самий підрахунок, що needsMe() у shared. */
export async function countForMe(db: Db, me: CpUser): Promise<number> {
  let q;
  if (me.role === 'approver') q = await db.query("SELECT count(*) FROM cp_requests WHERE status = 'pending' OR (status = 'approved' AND change IS NOT NULL)");
  else if (me.role === 'manager' || me.role === 'lead') q = await db.query("SELECT count(*) FROM cp_requests WHERE status = 'returned' AND created_by = $1", [me.id]);
  else return 0;
  return Number(q.rows[0].count);
}

// ---------- перевірки ----------
export function toCheck(row: any): CpCheck {
  return {
    id: String(row.id), code: row.code, at: iso(row.done_at || row.created_at), by: row.created_by ?? null, byName: row.created_by_name ?? null,
    src: row.src, status: row.status, error: row.error ?? null, tx: Number(row.tx) || 0, pdf: !!row.pdf_key, base: row.base ?? null, subj: row.subj ?? null,
  };
}
export async function getCheck(db: Db, id: string | null): Promise<CpCheck | null> {
  if (!id || !/^\d{1,18}$/.test(id)) return null;
  const q = await db.query('SELECT * FROM cp_checks WHERE id = $1', [id]);
  return q.rows[0] ? toCheck(q.rows[0]) : null;
}
export async function checksByIds(db: Db, ids: Array<string | null>): Promise<Map<string, CpCheck>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const m = new Map<string, CpCheck>();
  if (!list.length) return m;
  const q = await db.query('SELECT * FROM cp_checks WHERE id = ANY($1::bigint[])', [list]);
  for (const r of q.rows) m.set(String(r.id), toCheck(r));
  return m;
}
/** Найновіша завершена перевірка коду (будь-ким). */
export async function latestDone(db: Db, code: string): Promise<CpCheck | null> {
  const q = await db.query("SELECT * FROM cp_checks WHERE code = $1 AND status = 'done' AND src <> 'monitor' ORDER BY done_at DESC, id DESC LIMIT 1", [code]);
  return q.rows[0] ? toCheck(q.rows[0]) : null;
}
/** Збережена перевірка, якій менше 2 місяців, — нова не потрібна. */
export async function freshCheck(db: Db, code: string, now: Date): Promise<CpCheck | null> {
  const c = await latestDone(db, code);
  if (!c) return null;
  const until = new Date(c.at); until.setMonth(until.getMonth() + RECHECK_MONTHS);
  return until > now ? c : null;
}
/** Перевірка цього коду, що триває (щоб не запускати другу паралельно). */
export async function runningCheck(db: Db, code: string): Promise<CpCheck | null> {
  const q = await db.query("SELECT * FROM cp_checks WHERE code = $1 AND status = 'running' AND src <> 'monitor' AND created_at > now() - interval '20 minutes' ORDER BY id DESC LIMIT 1", [code]);
  return q.rows[0] ? toCheck(q.rows[0]) : null;
}
/** Вкладка «Перевірка контрагента»: мої (або всі — Сергію). Без щомісячних. */
export async function listChecks(db: Db, by?: string, limit = 300): Promise<CpCheck[]> {
  const q = by
    ? await db.query("SELECT * FROM cp_checks WHERE created_by = $1 AND src <> 'monitor' AND status <> 'failed' ORDER BY created_at DESC, id DESC LIMIT $2", [by, limit])
    : await db.query("SELECT * FROM cp_checks WHERE src <> 'monitor' AND status <> 'failed' ORDER BY created_at DESC, id DESC LIMIT $1", [limit]);
  return q.rows.map(toCheck);
}

/** Запити з перевірками для відповіді API. */
export async function withChecks(db: Db, reqs: CpRequest[]): Promise<CpRequestView[]> {
  const m = await checksByIds(db, reqs.flatMap(r => [r.checkId, r.recheckId]));
  return reqs.map(r => ({ ...r, check: r.checkId ? m.get(r.checkId) || null : null, rechecking: !!r.recheckId && m.get(r.recheckId)?.status === 'running' }));
}

export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  finally { c.release(); }
}
