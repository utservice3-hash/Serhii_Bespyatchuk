// Звіт по виписці + СЕРВЕРНЕ приховування. Підсумки — у UAH (amount_uah).
import { pool } from "../db/pool.js";

export interface HiddenPayee { pattern: string; match_type: "exact" | "glob" }
export interface BankFilter { from?: string; to?: string; company?: string; account?: number; currency?: string; q?: string }

/** glob «*дивіденд*» → регекс (case-insensitive). Екрануємо все, крім '*'. */
function globToRe(p: string): RegExp {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
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
}

function whereClause(dir: "in" | "out", f: BankFilter, params: unknown[]): string {
  const c = [`t.direction = '${dir}'`, `a.is_active = true`];
  if (f.from) { params.push(f.from); c.push(`(t.booked_at AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`); }
  if (f.to) { params.push(f.to); c.push(`(t.booked_at AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`); }
  if (f.company) { params.push(f.company); c.push(`a.company = $${params.length}`); }
  if (f.account) { params.push(f.account); c.push(`t.account_id = $${params.length}`); }
  if (f.currency) { params.push(f.currency); c.push(`t.currency = $${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); c.push(`(t.counterparty_name ILIKE $${params.length} OR t.purpose ILIKE $${params.length} OR t.external_tx_id ILIKE $${params.length})`); }
  return c.join(" AND ");
}

async function fetchRows(dir: "in" | "out", f: BankFilter): Promise<Row[]> {
  const params: unknown[] = [];
  const where = whereClause(dir, f, params);
  const r = await pool.query<Row>(
    `SELECT t.id, t.account_id, a.company, a.label AS account_label, t.direction,
            t.booked_at, t.processed_at, t.counterparty_name, t.counterparty_iban, t.purpose,
            t.amount, t.currency, t.fx_rate, t.amount_uah, t.external_tx_id, t.unmatched_account
       FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
      WHERE ${where}
      ORDER BY t.booked_at DESC`, params);
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

export async function incoming(f: BankFilter) {
  const rows = await fetchRows("in", f);
  return { rows, summary: summarize(rows) };
}

/** Вихідні. canSeeHidden=false → приховані ВИКЛЮЧАЮТЬСЯ ще до підсумків (серверно). */
export async function outgoing(f: BankFilter, payees: HiddenPayee[], canSeeHidden: boolean) {
  const all = await fetchRows("out", f);
  if (!canSeeHidden) {
    const visible = all.filter((r) => !isHidden(r.counterparty_name, payees));
    return { rows: visible, summary: summarize(visible) };
  }
  const marked = all.map((r) => ({ ...r, hidden: isHidden(r.counterparty_name, payees) }));
  return { rows: marked, summary: summarize(marked) };
}

export async function getHiddenPayees(): Promise<HiddenPayee[]> {
  const r = await pool.query<HiddenPayee>(`SELECT pattern, match_type FROM bank_hidden_payees`);
  return r.rows;
}
