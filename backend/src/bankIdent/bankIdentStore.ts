/**
 * SQL «Виписки»: стан ідентифікації (bank_tx_ident), історія (bank_tx_ident_events), коментарі до вихідних (bank_tx_comments).
 * Гонки: номер фіксується INSERT … ON CONFLICT DO NOTHING — з двох одночасних «Зберегти» виграє один, другий отримує 409.
 * Зміни фінансиста — UPDATE … WHERE invoice_no = очікуваний (що бачив на екрані), інакше 409 «номер змінився».
 */
import type { Pool, PoolClient } from 'pg';
import type { CommentSummary, IdentAct, IdentEvent, IdentRow, OutComment, Person, StoredStatus } from './bankIdent.js';

// [дашборд] явні колонки замість `*` (правило #17e: нова колонка не їде у відповідь сама)
const IDENT_COLS = 'tx_id, account_id, booked_at, status, invoice_no, first_by, first_by_name, first_at, set_by, set_by_name, set_role, set_at, reason, note, unid_kind, deadline_at, changed';
const EVENT_COLS = 'id, tx_id, at, actor_id, actor_name, actor_role, act, from_no, to_no, reason, note';
const COMMENT_COLS = 'id, tx_id, author_id, author_name, author_role, body, created_at';

type Q = Pool | PoolClient;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const person = (id: unknown, name: unknown, role: unknown): Person | null =>
  id === null || id === undefined || id === '' ? null : { id: String(id), name: String(name || ''), role: String(role || '') };

function rowOf(r: R): IdentRow {
  return {
    txId: Number(r.tx_id),
    accountId: Number(r.account_id),
    bookedAt: iso(r.booked_at)!,
    status: r.status,
    invoiceNo: r.invoice_no ?? null,
    firstBy: person(r.first_by, r.first_by_name, null),
    firstAt: iso(r.first_at),
    by: person(r.set_by, r.set_by_name, r.set_role),
    at: iso(r.set_at)!,
    reason: r.reason ?? null,
    note: r.note ?? null,
    unidKind: r.unid_kind ?? null,
    deadlineAt: iso(r.deadline_at)!,
    changed: !!r.changed,
  };
}

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Момент запуску правила з bank_ident_settings (міграція ставить «зараз»); null — міграцію не запущено. */
export async function getIdentFrom(q: Q): Promise<number | null> {
  const r = await q.query("SELECT value FROM bank_ident_settings WHERE key = 'ident_from'");
  const v = r.rows[0] ? Date.parse(r.rows[0].value) : NaN;
  return Number.isFinite(v) ? v : null;
}

export async function rowsByIds(q: Q, ids: number[], forUpdate = false): Promise<Map<number, IdentRow>> {
  const out = new Map<number, IdentRow>();
  if (!ids.length) return out;
  const r = await q.query(`SELECT ${IDENT_COLS} FROM bank_tx_ident WHERE tx_id = ANY($1::bigint[])${forUpdate ? ' FOR UPDATE' : ''}`, [ids]);
  for (const x of r.rows) out.set(Number(x.tx_id), rowOf(x));
  return out;
}

export async function eventCounts(q: Q, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const r = await q.query('SELECT tx_id, count(*)::int AS n FROM bank_tx_ident_events WHERE tx_id = ANY($1::bigint[]) GROUP BY tx_id', [ids]);
  for (const x of r.rows) out.set(Number(x.tx_id), x.n);
  return out;
}

async function addEvent(q: Q, txId: number, act: IdentAct, by: Person | null, at: number,
  f: { fromNo?: string | null; toNo?: string | null; reason?: string | null; note?: string | null } = {}) {
  await q.query(
    `INSERT INTO bank_tx_ident_events (tx_id, at, actor_id, actor_name, actor_role, act, from_no, to_no, reason, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [txId, new Date(at), by?.id ?? null, by?.name ?? null, by?.role ?? null, act, f.fromNo ?? null, f.toNo ?? null, f.reason ?? null, f.note ?? null]);
}

export interface NewRow { txId: number; accountId: number; bookedAt: number; deadline: number }

/** Зафіксувати номер (один раз). null — хтось уже встиг (рядок є). */
export async function insertIdentified(q: Q, t: NewRow, no: string, by: Person, now: number): Promise<IdentRow | null> {
  const r = await q.query(
    `INSERT INTO bank_tx_ident (tx_id, account_id, booked_at, status, invoice_no, first_by, first_by_name, first_at,
                                set_by, set_by_name, set_role, set_at, deadline_at)
     VALUES ($1, $2, $3, 'identified', $4, $5, $6, $7, $5, $6, $8, $7, $9)
     ON CONFLICT (tx_id) DO NOTHING RETURNING ${IDENT_COLS}`,
    [t.txId, t.accountId, new Date(t.bookedAt), no, by.id, by.name, new Date(now), by.role, new Date(t.deadline)]);
  if (!r.rows[0]) return null;
  await addEvent(q, t.txId, 'set', by, now, { toNo: no });
  return rowOf(r.rows[0]);
}

/** «Не оплата клієнта». null — рядок уже є. */
export async function insertNotClient(q: Q, t: NewRow, reason: string, note: string, by: Person, now: number): Promise<IdentRow | null> {
  const r = await q.query(
    `INSERT INTO bank_tx_ident (tx_id, account_id, booked_at, status, set_by, set_by_name, set_role, set_at, reason, note, deadline_at)
     VALUES ($1, $2, $3, 'not_client', $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tx_id) DO NOTHING RETURNING ${IDENT_COLS}`,
    [t.txId, t.accountId, new Date(t.bookedAt), by.id, by.name, by.role, new Date(now), reason, note || null, new Date(t.deadline)]);
  if (!r.rows[0]) return null;
  await addEvent(q, t.txId, 'not_client', by, now, { reason, note: note || null });
  return rowOf(r.rows[0]);
}

/** Строк минув без номера — «неідентифікований» назавжди (система). Повертає, скільки записано вперше. */
export async function insertExpired(q: Q, list: NewRow[]): Promise<number> {
  if (!list.length) return 0;
  const r = await q.query(
    `INSERT INTO bank_tx_ident (tx_id, account_id, booked_at, status, unid_kind, set_at, deadline_at)
     SELECT x.tx_id, x.account_id, x.booked_at, 'unidentified', 'expired', x.deadline_at, x.deadline_at
       FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[], $4::timestamptz[]) AS x(tx_id, account_id, booked_at, deadline_at)
     ON CONFLICT (tx_id) DO NOTHING RETURNING tx_id, deadline_at`,
    [list.map(x => x.txId), list.map(x => x.accountId), list.map(x => new Date(x.bookedAt)), list.map(x => new Date(x.deadline))]);
  if (r.rows.length) {
    await q.query(
      `INSERT INTO bank_tx_ident_events (tx_id, at, act) SELECT x.tx_id, x.at, 'expired' FROM unnest($1::bigint[], $2::timestamptz[]) AS x(tx_id, at)`,
      [r.rows.map((x: R) => x.tx_id), r.rows.map((x: R) => x.deadline_at)]);
  }
  return r.rows.length;
}

/** Фінансист міняє номер. null — номера вже немає або він не той, що бачив фінансист. */
export async function updateFix(q: Q, txId: number, expected: string, no: string, reason: string, by: Person, now: number): Promise<IdentRow | null> {
  const r = await q.query(
    `UPDATE bank_tx_ident SET invoice_no = $3, set_by = $4, set_by_name = $5, set_role = $6, set_at = $7, changed = true, updated_at = now()
      WHERE tx_id = $1 AND status = 'identified' AND invoice_no = $2 RETURNING ${IDENT_COLS}`,
    [txId, expected, no, by.id, by.name, by.role, new Date(now)]);
  if (!r.rows[0]) return null;
  await addEvent(q, txId, 'change', by, now, { fromNo: expected, toNo: no, reason });
  return rowOf(r.rows[0]);
}

/** Фінансист визнає неідентифікованим (номер вигаданий тощо). Остаточно. */
export async function updateUnidentify(q: Q, txId: number, expected: string, reason: string, by: Person, now: number): Promise<IdentRow | null> {
  const r = await q.query(
    `UPDATE bank_tx_ident SET status = 'unidentified', unid_kind = 'finance', invoice_no = NULL, reason = $3,
                              set_by = $4, set_by_name = $5, set_role = $6, set_at = $7, updated_at = now()
      WHERE tx_id = $1 AND status = 'identified' AND invoice_no = $2 RETURNING ${IDENT_COLS}`,
    [txId, expected, reason, by.id, by.name, by.role, new Date(now)]);
  if (!r.rows[0]) return null;
  await addEvent(q, txId, 'unidentify', by, now, { fromNo: expected, reason });
  return rowOf(r.rows[0]);
}

export async function history(q: Q, txId: number): Promise<IdentEvent[]> {
  const r = await q.query(`SELECT ${EVENT_COLS} FROM bank_tx_ident_events WHERE tx_id = $1 ORDER BY at, id`, [txId]);
  return r.rows.map((x: R) => ({
    id: Number(x.id), at: iso(x.at)!, by: person(x.actor_id, x.actor_name, x.actor_role), act: x.act,
    fromNo: x.from_no ?? null, toNo: x.to_no ?? null, reason: x.reason ?? null, note: x.note ?? null,
  }));
}

/** id платежів зі статусом (нові спершу) і скільки їх усього. */
export async function idsByStatus(q: Q, status: StoredStatus, accountIds: number[], limit: number, offset: number): Promise<{ ids: number[]; total: number }> {
  const [r, n] = await Promise.all([
    q.query('SELECT tx_id FROM bank_tx_ident WHERE status = $1 AND account_id = ANY($2::bigint[]) ORDER BY booked_at DESC, tx_id DESC LIMIT $3 OFFSET $4',
      [status, accountIds, limit, offset]),
    q.query('SELECT count(*)::int AS n FROM bank_tx_ident WHERE status = $1 AND account_id = ANY($2::bigint[])', [status, accountIds]),
  ]);
  return { ids: r.rows.map((x: R) => Number(x.tx_id)), total: n.rows[0].n };
}

export async function statusTotals(q: Q, accountIds: number[]): Promise<Record<StoredStatus, number>> {
  const r = await q.query('SELECT status, count(*)::int AS n FROM bank_tx_ident WHERE account_id = ANY($1::bigint[]) GROUP BY status', [accountIds]);
  const out: Record<StoredStatus, number> = { identified: 0, not_client: 0, unidentified: 0 };
  for (const x of r.rows) out[x.status as StoredStatus] = x.n;
  return out;
}

// ───────────── коментарі до вихідних ─────────────

const commentOf = (x: R): OutComment => ({ id: Number(x.id), at: iso(x.created_at)!, by: person(x.author_id, x.author_name, x.author_role)!, body: x.body });

export async function comments(q: Q, txId: number): Promise<OutComment[]> {
  const r = await q.query(`SELECT ${COMMENT_COLS} FROM bank_tx_comments WHERE tx_id = $1 ORDER BY created_at, id`, [txId]);
  return r.rows.map(commentOf);
}

export async function addComment(q: Q, txId: number, by: Person, body: string, now: number): Promise<OutComment> {
  const r = await q.query(
    'INSERT INTO bank_tx_comments (tx_id, author_id, author_name, author_role, body, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ' + COMMENT_COLS,
    [txId, by.id, by.name, by.role, body, new Date(now)]);
  return commentOf(r.rows[0]);
}

export async function commentSummaries(q: Q, ids: number[]): Promise<Map<number, CommentSummary>> {
  const out = new Map<number, CommentSummary>();
  if (!ids.length) return out;
  const r = await q.query(
    `SELECT DISTINCT ON (tx_id) ${COMMENT_COLS}, count(*) OVER (PARTITION BY tx_id)::int AS n
       FROM bank_tx_comments WHERE tx_id = ANY($1::bigint[]) ORDER BY tx_id, created_at DESC, id DESC`, [ids]);
  for (const x of r.rows) out.set(Number(x.tx_id), { count: x.n, last: commentOf(x) });
  return out;
}
