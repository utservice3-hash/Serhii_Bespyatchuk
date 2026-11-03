/**
 * 💳 Розшифровка вихідних ФОП і картки — SQL (правила — `outBreakdown.ts`). Окремо від роуту, щоб живий гейт ганяв
 * рівно ці запити проти тимчасової бази. Записи — разом з історією в ОДНІЙ транзакції (`withTx`): зміна без сліду
 * в історії зробила б «Відкориговані» неперевірними.
 */
import type { Pool, PoolClient } from "pg";
import type { Person } from "./bankIdent.js";
import type { OutLine, OutRow, OutStored } from "./outBreakdown.js";

export interface OutStoredRow extends OutRow {
  txId: number;
  setByName: string | null;
  setAt: string;
  reason: string | null;
}

type Raw = { tx_id: string; status: OutStored; lines: OutLine[]; corrected: boolean; set_by_name: string | null; set_at: Date; reason: string | null };
const map = (x: Raw): OutStoredRow => ({
  txId: Number(x.tx_id), status: x.status, lines: (x.lines || []).map((l) => ({ deal: Number(l.deal), amount: Number(l.amount) })),
  corrected: x.corrected, setByName: x.set_by_name, setAt: new Date(x.set_at).toISOString(), reason: x.reason,
});

export async function outRowsByIds(db: Pool | PoolClient, ids: number[]): Promise<Map<number, OutStoredRow>> {
  if (!ids.length) return new Map();
  const r = await db.query<Raw>(
    `SELECT tx_id, status, lines, corrected, set_by_name, set_at, reason FROM bank_out_breakdown WHERE tx_id = ANY($1::bigint[])`, [ids]);
  return new Map(r.rows.map((x) => [Number(x.tx_id), map(x)]));
}

/**
 * Кандидати для фільтра й лічильників: вихідні рахунків зі `scope` від `from` (за датою банку) — плюс будь-який
 * платіж, у якого вже є розшифровка (старіший теж: його розписали руками, і «Відкориговані» мусять його бачити).
 */
export async function outCandidateIds(db: Pool, scope: number[], from: string, limit = 3000): Promise<number[]> {
  if (!scope.length) return [];
  const r = await db.query<{ id: number }>(
    `SELECT t.id FROM bank_transactions t
      WHERE t.account_id = ANY($1::int[]) AND t.direction = 'out' AND t.deleted_at IS NULL
        AND (t.booked_at >= $2::date OR EXISTS (SELECT 1 FROM bank_out_breakdown b WHERE b.tx_id = t.id))
      ORDER BY t.booked_at DESC, t.id DESC LIMIT $3`, [scope, from, limit]);
  return r.rows.map((x) => Number(x.id));
}

/** Угоди з CRM для підписів біля номера: назва й менеджер. Немає в базі — рядок без підпису (не блокує). */
export async function dealLabels(db: Pool, deals: number[]): Promise<Map<number, { name: string | null; manager: string | null }>> {
  if (!deals.length) return new Map();
  const r = await db.query<{ kommo_id: string; name: string | null; manager: string | null }>(
    `SELECT d.kommo_id, d.name, m.name AS manager FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE d.kommo_id = ANY($1::bigint[])`, [deals]);
  return new Map(r.rows.map((x) => [Number(x.kommo_id), { name: x.name, manager: x.manager }]));
}

/** Записати новий стан і подію історії (у транзакції викликача). */
export async function saveOut(c: PoolClient, p: {
  txId: number; accountId: number; bookedAt: Date; status: OutStored; lines: OutLine[]; corrected: boolean;
  act: "set" | "change" | "unidentify"; before: OutRow | null; reason: string | null; me: Person;
}): Promise<void> {
  await c.query(
    `INSERT INTO bank_out_breakdown (tx_id, account_id, booked_at, status, lines, corrected, set_by, set_by_name, set_role, set_at, reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, now(), $10)
     ON CONFLICT (tx_id) DO UPDATE SET status = EXCLUDED.status, lines = EXCLUDED.lines, corrected = EXCLUDED.corrected,
       set_by = EXCLUDED.set_by, set_by_name = EXCLUDED.set_by_name, set_role = EXCLUDED.set_role, set_at = now(), reason = EXCLUDED.reason`,
    [p.txId, p.accountId, p.bookedAt, p.status, JSON.stringify(p.lines), p.corrected, p.me.id, p.me.name || null, p.me.role || null, p.reason]);
  await c.query(
    `INSERT INTO bank_out_breakdown_events (tx_id, actor_id, actor_name, actor_role, act, status_before, lines_before, status_after, lines_after, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)`,
    [p.txId, p.me.id, p.me.name || null, p.me.role || null, p.act, p.before?.status ?? null,
     p.before ? JSON.stringify(p.before.lines) : null, p.status, JSON.stringify(p.lines), p.reason]);
}

/** Рядок для блокування перед зміною: двоє одночасно не перезапишуть одне одного мовчки. */
export async function outRowForUpdate(c: PoolClient, txId: number): Promise<OutStoredRow | null> {
  const r = await c.query<Raw>(
    `SELECT tx_id, status, lines, corrected, set_by_name, set_at, reason FROM bank_out_breakdown WHERE tx_id = $1 FOR UPDATE`, [txId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

export async function outHistory(db: Pool, txId: number) {
  const r = await db.query<{ id: string; at: Date; actor_name: string | null; act: string; status_before: string | null; lines_before: OutLine[] | null; status_after: string; lines_after: OutLine[]; reason: string | null }>(
    `SELECT id, at, actor_name, act, status_before, lines_before, status_after, lines_after, reason
       FROM bank_out_breakdown_events WHERE tx_id = $1 ORDER BY at DESC, id DESC LIMIT 100`, [txId]);
  return r.rows.map((x) => ({
    id: Number(x.id), at: new Date(x.at).toISOString(), by: x.actor_name, act: x.act,
    statusBefore: x.status_before, linesBefore: x.lines_before, statusAfter: x.status_after, linesAfter: x.lines_after, reason: x.reason,
  }));
}
