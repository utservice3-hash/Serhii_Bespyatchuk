// Звіт по виписці + СЕРВЕРНЕ приховування. Підсумки — у UAH (amount_uah).
import { pool } from "../db/pool.js";

export interface HiddenPayee { pattern: string; match_type: "exact" | "glob" }
export interface BankFilter {
  from?: string; to?: string; company?: string; account?: number; currency?: string; q?: string;
  cursor?: string; limit?: number; // keyset-пагінація стрічки (нескінченне гортання)
}

interface Cursor { b: string; id: number } // booked_at ISO + id останнього рядка сторінки
export function parseCursor(s?: string): Cursor | null {
  if (!s) return null;
  const i = s.lastIndexOf("|"); // booked_at ISO не містить '|', тож ріжемо по останньому
  if (i < 0) return null;
  const b = s.slice(0, i), id = Number(s.slice(i + 1));
  return b && Number.isFinite(id) ? { b, id } : null;
}
// booked_iso — повна мікросекундна UTC-мітка з БД (JS Date губить <мс → пропускав рядки-ties).
const encodeCursor = (r: Row): string => `${r.booked_iso ?? new Date(r.booked_at).toISOString()}|${r.id}`;
const clampLimit = (n?: number): number => Math.min(Math.max(Number(n) || 100, 1), 500);

/** glob «*дивіденд*» → регекс (case-insensitive). Екрануємо все, крім '*'. */
function globToRe(p: string): RegExp {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

/** Службовий збір банку (комісія) — виключається з вихідних. name містить «ЗА ДЕБЕТУВАННЯ
 *  РАХУНК…»; purpose починається з «Комісія…». Викор. при інжесті (set is_bank_fee). */
export function isBankFee(name: string | null, purpose: string | null): boolean {
  const n = (name ?? "").toUpperCase();
  const p = (purpose ?? "").replace(/^\s+/, "").toLowerCase();
  return n.includes("ЗА ДЕБЕТУВАННЯ РАХУНК") || p.startsWith("комісія");
}

/** Чисте рішення: чи прихований отримувач (для out-транзакцій). Тестується без БД. */
export function isHidden(name: string | null, payees: HiddenPayee[]): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  for (const p of payees) {
    if (p.match_type === "exact") { if (n.toLowerCase() === p.pattern.trim().toLowerCase()) return true; }
    else if (globToRe(p.pattern).test(n)) return true;
  }
  return false;
}

interface Row {
  id: number; account_id: number; company: string; account_label: string; direction: string;
  booked_at: string; processed_at: string | null; counterparty_name: string | null;
  counterparty_iban: string | null; purpose: string | null; amount: string; currency: string;
  fx_rate: string | null; amount_uah: string; external_tx_id: string; unmatched_account: boolean;
  booked_iso?: string; // повна (мікросекундна) UTC-мітка ДЛЯ КУРСОРА (JS Date губить <мс) — не віддаємо клієнту
}
const stripCursorField = (r: Row): Row => { const { booked_iso: _drop, ...rest } = r; return rest; };

// opts.period: застосувати вікно from/to (для ПІДСУМКІВ). Без нього — уся утримана історія (стрічка).
// opts.cursor: keyset-межа «строго далі за курсором» ((booked_at,id) < курсор) — гортання без OFFSET.
function whereClause(dir: "in" | "out", f: BankFilter, params: unknown[], opts: { period: boolean; cursor?: Cursor | null }): string {
  const c = [`t.direction = '${dir}'`, `a.is_active = true`];
  if (dir === "out") c.push(`NOT COALESCE(t.is_bank_fee, false)`); // комісії банку не показуємо у вихідних (ні в списку, ні в Σ)
  if (opts.period && f.from) { params.push(f.from); c.push(`(t.booked_at AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`); }
  if (opts.period && f.to) { params.push(f.to); c.push(`(t.booked_at AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`); }
  if (f.company) { params.push(f.company); c.push(`a.company = $${params.length}`); }
  if (f.account) { params.push(f.account); c.push(`t.account_id = $${params.length}`); }
  if (f.currency) { params.push(f.currency); c.push(`t.currency = $${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); const i = params.length; c.push(`(t.counterparty_name ILIKE $${i} OR t.purpose ILIKE $${i} OR t.external_tx_id ILIKE $${i})`); }
  if (opts.cursor) { params.push(opts.cursor.b); const bi = params.length; params.push(opts.cursor.id); c.push(`(t.booked_at, t.id) < ($${bi}::timestamptz, $${params.length}::int)`); }
  return c.join(" AND ");
}

// Свіже зверху: booked_at несе реальний час (privat TIM_P / mono), id — детермінований тайбрейк
// (та ключ keyset-курсора). Індекс (account_id, booked_at DESC) / (direction, booked_at DESC).
async function fetchRows(dir: "in" | "out", f: BankFilter, opts: { period: boolean; cursor?: Cursor | null }, limit?: number): Promise<Row[]> {
  const params: unknown[] = [];
  const where = whereClause(dir, f, params, opts);
  let sql =
    `SELECT t.id, t.account_id, a.company, a.label AS account_label, t.direction,
            t.booked_at, t.processed_at, t.counterparty_name, t.counterparty_iban, t.purpose,
            t.amount, t.currency, t.fx_rate, t.amount_uah, t.external_tx_id, t.unmatched_account,
            to_char(t.booked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS booked_iso
       FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
      WHERE ${where}
      ORDER BY t.booked_at DESC, t.id DESC`;
  if (limit != null) { params.push(limit); sql += ` LIMIT $${params.length}`; }
  const r = await pool.query<Row>(sql, params);
  return r.rows;
}

function summarize(rows: (Row & { hidden?: boolean })[]) {
  let total = 0, maxPayment = 0;
  const byCompany: Record<string, number> = {};
  for (const r of rows) {
    const uah = Math.abs(Number(r.amount_uah));
    total += uah;
    byCompany[r.company] = (byCompany[r.company] ?? 0) + uah;
    if (uah > maxPayment) maxPayment = uah;
  }
  return { total: Math.round(total * 100) / 100, count: rows.length, byCompany, maxPayment };
}

/** Сторінка СТРІЧКИ (уся утримана історія, keyset-гортання). Приховані вихідні виключаються
 *  СЕРВЕРНО на КОЖНІЙ сторінці (не лише на першій). nextCursor рахується з останнього СИРОГО
 *  рядка сторінки → межа рухається коректно, навіть якщо його прибрали як прихований. */
export async function feedPage(dir: "in" | "out", f: BankFilter, payees: HiddenPayee[], canSeeHidden: boolean) {
  const limit = clampLimit(f.limit);
  const raw = await fetchRows(dir, f, { period: false, cursor: parseCursor(f.cursor) }, limit);
  const nextCursor = raw.length === limit ? encodeCursor(raw[raw.length - 1]) : null; // з СИРОГО останнього
  let rows: (Row & { hidden?: boolean })[];
  if (dir === "out" && !canSeeHidden) rows = raw.filter((r) => !isHidden(r.counterparty_name, payees)).map(stripCursorField);
  else if (dir === "out") rows = raw.map((r) => ({ ...stripCursorField(r), hidden: isHidden(r.counterparty_name, payees) }));
  else rows = raw.map(stripCursorField); // вхідні — приховування не застосовується
  return { rows, nextCursor };
}

/** Підсумки за ВИБРАНИЙ ПЕРІОД (from/to) + фільтри. Приховані вихідні виключено серверно. */
export async function periodSummary(dir: "in" | "out", f: BankFilter, payees: HiddenPayee[], canSeeHidden: boolean) {
  const raw = await fetchRows(dir, f, { period: true }); // усі рядки періоду, без limit
  const visible = dir === "out" && !canSeeHidden ? raw.filter((r) => !isHidden(r.counterparty_name, payees)) : raw;
  return summarize(visible);
}

export async function getHiddenPayees(): Promise<HiddenPayee[]> {
  const r = await pool.query<HiddenPayee>(`SELECT pattern, match_type FROM bank_hidden_payees`);
  return r.rows;
}
