/** «Ліміти клієнтів» — читання й запис у Postgres (migrations/004_client_limits.sql). */
import type { ClientLimit, LimitEvent, LimitEventType, Member } from '../shared/clientLimits.js';
import { NOTICE_DAYS } from '../shared/cpCheck.js';
import type { CpRequest, From, Terms } from '../shared/counterparty.js';
import type { Db } from './cpStore.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : '');
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const ev = (e: any): LimitEvent => ({ type: e.type as LimitEventType, by: e.by_id ?? null, byName: e.by_name ?? null, at: iso(e.at), note: e.note || '' });
/** Події запиту, які показуються в історії ліміту (як у макеті). */
export const REQ_LIMIT_EVENTS = ['approved', 'approvedChanged', 'changeApproved', 'limitChanged', 'suspended', 'changeRequested', 'changeRejected'];

export function toLimit(row: any, now: Date = new Date()): ClientLimit {
  const req = row.src === 'req';
  const pendingFlag = req && row.r_status === 'pending' && !!row.r_flag;
  const hist = [...(row.rhist || []).map(ev), ...(row.lhist || []).map(ev)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    id: String(row.id),
    src: row.src,
    requestId: row.request_id === null || row.request_id === undefined ? null : String(row.request_id),
    debtorKey: row.debtor_key ?? null,
    name: row.name,
    kind: row.kind || '',
    members: (row.members || []).map((m: any) => ({ code: m.code, name: m.name })),
    limit: numOrNull(row.limit_sum),
    days: numOrNull(row.days),
    from: row.count_from as From,
    ent: row.ent ?? null,
    pay: row.pay ?? null,
    terms: req ? row.r_ok ?? null : null,
    managerId: row.manager_id,
    managerName: row.manager_name || '',
    at: iso(row.at),
    note: row.note || '',
    flag: req ? (pendingFlag ? row.r_flag : null) : row.flag ?? null,
    suspended: req ? pendingFlag : !!row.flag,
    change: req && row.r_status === 'approved' ? row.r_change ?? null : null,
    notice: row.notice && now.getTime() - Date.parse(row.notice.at) <= NOTICE_DAYS * 864e5 ? row.notice : null,
    lastCheck: row.last_check ? { id: String(row.last_check.id), at: iso(row.last_check.at) } : null,
    hist,
  };
}

const SELECT_LIM = `SELECT l.*,
  COALESCE((SELECT json_agg(json_build_object('code', m.code, 'name', m.name) ORDER BY m.pos, m.code) FROM client_limit_members m WHERE m.limit_id = l.id), '[]'::json) AS members,
  COALESCE((SELECT json_agg(json_build_object('type', e.type, 'by_id', e.by_id, 'by_name', e.by_name, 'note', e.note, 'at', e.at) ORDER BY e.at, e.id)
    FROM client_limit_events e WHERE e.limit_id = l.id), '[]'::json) AS lhist,
  r.status AS r_status, r.flag AS r_flag, r.change AS r_change, r.ok AS r_ok,
  COALESCE((SELECT json_agg(json_build_object('type', e.type, 'by_id', e.by_id, 'by_name', e.by_name, 'note', e.note, 'at', e.at) ORDER BY e.at, e.id)
    FROM cp_events e WHERE l.request_id IS NOT NULL AND e.request_id = l.request_id AND e.type = ANY($1::text[])), '[]'::json) AS rhist,
  (SELECT json_build_object('id', c.id, 'at', COALESCE(c.done_at, c.created_at)) FROM cp_checks c
    WHERE c.status = 'done' AND c.src <> 'monitor'
      AND c.code = (SELECT m.code FROM client_limit_members m WHERE m.limit_id = l.id ORDER BY m.pos, m.code LIMIT 1)
    ORDER BY c.done_at DESC, c.id DESC LIMIT 1) AS last_check
  FROM client_limits l LEFT JOIN cp_requests r ON r.id = l.request_id`;

export async function listLimits(db: Db, now: Date = new Date()): Promise<ClientLimit[]> {
  const q = await db.query(`${SELECT_LIM} WHERE l.active ORDER BY l.name, l.id`, [REQ_LIMIT_EVENTS]);
  return q.rows.map(r => toLimit(r, now));
}
export async function getLimit(db: Db, id: string, now: Date = new Date()): Promise<ClientLimit | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const q = await db.query(`${SELECT_LIM} WHERE l.id = $2 AND l.active`, [REQ_LIMIT_EVENTS, id]);
  return q.rows[0] ? toLimit(q.rows[0], now) : null;
}
/** Діючі ліміти, де є ця юрособа (будь-яке джерело). */
export async function limitsByMember(db: Db, code: string, now: Date = new Date()): Promise<ClientLimit[]> {
  const q = await db.query(`${SELECT_LIM} WHERE l.active AND EXISTS (SELECT 1 FROM client_limit_members m WHERE m.limit_id = l.id AND m.code = $2) ORDER BY l.id`, [REQ_LIMIT_EVENTS, code]);
  return q.rows.map(r => toLimit(r, now));
}
export async function limitByMember(db: Db, code: string, now: Date = new Date()): Promise<ClientLimit | null> {
  return (await limitsByMember(db, code, now))[0] || null;
}

export async function addLimitEvent(db: Db, limitId: string | number, type: LimitEventType, by: { id: string; name: string } | null, note = '', data?: unknown) {
  await db.query('INSERT INTO client_limit_events (limit_id, type, by_id, by_name, note, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [limitId, type, by ? by.id : null, by ? by.name : null, note, data === undefined ? null : JSON.stringify(data)]);
}

async function setMembers(db: Db, limitId: string | number, members: Member[]) {
  for (const [i, m] of members.entries()) {
    await db.query('INSERT INTO client_limit_members (limit_id, code, name, pos) VALUES ($1, $2, $3, $4) ON CONFLICT (limit_id, code) DO UPDATE SET name = EXCLUDED.name, pos = EXCLUDED.pos', [limitId, m.code, m.name, i]);
  }
}

/** Справи, які вже бачили, — щоб щомісячна перевірка не вважала їх новими. '*' — базу знято. */
export async function markCourtsSeen(db: Db, code: string, caseNos: string[]) {
  if (!/^\d{8}$/.test(code)) return;
  for (const no of ['*', ...caseNos]) await db.query('INSERT INTO cl_court_seen (code, case_no) VALUES ($1, $2) ON CONFLICT DO NOTHING', [code, no]);
}

/**
 * Погоджено (чи погоджено зміну) → ліміт клієнта. Той самий запит — оновлює свій ліміт; є перенесений / заданий ліміт з цією юрособою —
 * він стає лімітом запиту (обʼєднані юрособи й ключ боржника зберігаються); інакше — новий ліміт.
 */
export async function upsertFromRequest(db: Db, r: CpRequest, terms: Terms, by: { id: string; name: string }): Promise<string> {
  const vals = [terms.limit, terms.cl.days, terms.cl.from, terms.ent, terms.cl.pay, r.createdBy, r.createdByName];
  const own = (await db.query('SELECT id FROM client_limits WHERE request_id = $1', [r.id])).rows[0];
  if (own) {
    await db.query(`UPDATE client_limits SET src = 'req', active = true, flag = NULL, limit_sum = $2, days = $3, count_from = $4, ent = $5, pay = $6,
      manager_id = $7, manager_name = $8, name = $9, kind = $10, at = now(), updated_at = now() WHERE id = $1`, [own.id, ...vals, r.name, r.kind]);
    return String(own.id);
  }
  const other = r.resident
    ? (await db.query(`SELECT l.id, l.src FROM client_limits l WHERE l.active AND l.request_id IS NULL
        AND EXISTS (SELECT 1 FROM client_limit_members m WHERE m.limit_id = l.id AND m.code = $1) ORDER BY l.id LIMIT 1`, [r.code])).rows[0]
    : null;
  if (other) {
    await db.query(`UPDATE client_limits SET src = 'req', request_id = $9, flag = NULL, limit_sum = $2, days = $3, count_from = $4, ent = $5, pay = $6,
      manager_id = $7, manager_name = $8, at = now(), updated_at = now() WHERE id = $1`, [other.id, ...vals, r.id]);
    await addLimitEvent(db, other.id, 'approved', by, `Нові умови погоджено запитом — ліміт тепер з запиту (раніше: ${other.src === 'debt' ? 'перенесено з дебіторки' : 'задано вручну'}).`);
    return String(other.id);
  }
  const ins = await db.query(`INSERT INTO client_limits (src, request_id, name, kind, limit_sum, days, count_from, ent, pay, manager_id, manager_name)
    VALUES ('req', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [r.id, r.name, r.kind, ...vals]);
  await setMembers(db, ins.rows[0].id, [{ code: r.code, name: r.name }]);
  return String(ins.rows[0].id);
}
/** Запит повернуто / відхилено після призупинення — ліміт знято. */
export async function endRequestLimit(db: Db, requestId: string, by: { id: string; name: string } | null, note: string) {
  const l = (await db.query('SELECT id FROM client_limits WHERE request_id = $1 AND active', [requestId])).rows[0];
  if (!l) return;
  await db.query('UPDATE client_limits SET active = false, updated_at = now() WHERE id = $1', [l.id]);
  await addLimitEvent(db, l.id, 'ended', by, note);
}

/** Імпорт наявних лімітів з дебіторки (одноразово, idempotent за debtorKey). */
export interface ImportRow {
  debtorKey: string; name: string; kind?: string; members: Member[];
  limit: number | null; days: number | null; from?: From; ent?: string | null; pay?: string | null;
  managerId: string; managerName?: string; note?: string; at?: string;
}
export async function importLimit(db: Db, x: ImportRow): Promise<'inserted' | 'skipped'> {
  const dup = (await db.query('SELECT id FROM client_limits WHERE debtor_key = $1', [x.debtorKey])).rows[0];
  if (dup) return 'skipped';
  const ins = await db.query(`INSERT INTO client_limits (src, debtor_key, name, kind, limit_sum, days, count_from, ent, pay, manager_id, manager_name, note, at)
    VALUES ('debt', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now())) RETURNING id`,
  [x.debtorKey, x.name, x.kind || '', x.limit, x.days, x.from || 'orig', x.ent || null, x.pay || null, x.managerId, x.managerName || '', x.note || '', x.at || null]);
  const id = ins.rows[0].id;
  await setMembers(db, id, x.members.length ? x.members : []);
  const what = [x.limit ? `${Math.round(x.limit).toLocaleString('uk-UA').replace(/\s/g, ' ')} грн` : 'суму не погоджено', x.days !== null ? `${x.days} дн.` : 'дні не погоджено'].join(', ');
  await addLimitEvent(db, id, 'migrated', null, `${what}${x.note ? ' — ' + x.note : ''}.`);
  return 'inserted';
}

/** Сергій задає ліміт боржнику без ліміту. */
export async function insertSetLimit(db: Db, x: { debtorKey: string; name: string; kind: string; members: Member[]; limit: number; days: number; from: From; managerId: string; managerName: string }): Promise<string> {
  const ins = await db.query(`INSERT INTO client_limits (src, debtor_key, name, kind, limit_sum, days, count_from, manager_id, manager_name)
    VALUES ('set', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [x.debtorKey, x.name, x.kind, x.limit, x.days, x.from, x.managerId, x.managerName]);
  await setMembers(db, ins.rows[0].id, x.members);
  return String(ins.rows[0].id);
}
