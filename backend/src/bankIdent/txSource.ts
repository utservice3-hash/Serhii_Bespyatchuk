/**
 * Адаптер пакета «Виписка — № рахунку» до НАШОЇ виписки (`bank_transactions` + `bank_accounts`).
 *
 * Пакет Сергія (`server/txSource.ts`) читав таблицю через `t.*` і не знав трьох наших меж, тож тут — свій адаптер з тим
 * самим інтерфейсом (`TxSource`, `toLite`, `publicRow`), але:
 *  - колонки ті самі, що віддає стрічка «Виписки» (`core/bankReport.ts → fetchRows`), плюс прапорці видимості рахунку;
 *  - видалений ручний рядок (`deleted_at`) не існує ні для кого — як у стрічці;
 *  - `canSeeTx` — ТА САМА межа, що в `/api/bank/incoming|outgoing`: неактивний рахунок і рахунок «лише фінанси» —
 *    лише з `view_private_finance`; вихідні робочої картки (`out_private`) — теж; прихований отримувач вихідних —
 *    лише з `view_hidden_payments`. Інакше фільтр «Чекають №» чи коментарі показали б те, чого людина у виписці не бачить.
 * «Зʼявився у виписці» = `created_at` (момент запису синком): строк рахується від пізнішого з «банк» і «у нас».
 */
import type { Pool } from 'pg';
import type { TxLite } from './bankIdent.js';
import { isHidden, type HiddenPayee } from '../core/bankReport.js';

/** Рядок виписки — поля стрічки «Виписки» + службові для правила й видимості. */
export interface BankTx {
  id: number | string;
  account_id: number | string;
  direction?: string | null;
  booked_at: string | Date;
  seen_at?: string | Date | null;
  counterparty_name?: string | null;
  counterparty_iban?: string | null;
  purpose?: string | null;
  amount?: string | number | null;
  finance_only?: boolean;
  out_private?: boolean;
  account_active?: boolean;
  [k: string]: unknown;
}

export interface TxSource {
  byIds(ids: number[]): Promise<BankTx[]>;
  openIncoming(accountIds: number[], since: Date, limit?: number): Promise<BankTx[]>;
  ownIbans(): Promise<string[]>;
}

const COLS = `t.id, t.account_id, a.company, a.label AS account_label, t.direction, t.booked_at, t.processed_at,
  t.counterparty_name, t.counterparty_iban, t.purpose, t.amount, t.currency, t.fx_rate, t.amount_uah, t.external_tx_id,
  t.unmatched_account, t.created_at AS seen_at, a.finance_only, a.out_private, a.is_active AS account_active`;

export function ourTxSource(pool: Pool): TxSource {
  return {
    async byIds(ids) {
      if (!ids.length) return [];
      const r = await pool.query(
        `SELECT ${COLS} FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
          WHERE t.id = ANY($1::int[]) AND t.deleted_at IS NULL`, [ids]);
      return r.rows;
    },
    async openIncoming(accountIds, since, limit = 2000) {
      const r = await pool.query(
        `SELECT ${COLS} FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
          WHERE t.account_id = ANY($1::int[]) AND t.direction = 'in' AND t.deleted_at IS NULL AND t.booked_at >= $2
            AND NOT EXISTS (SELECT 1 FROM bank_tx_ident i WHERE i.tx_id = t.id)
          ORDER BY t.booked_at DESC LIMIT $3`,
        [accountIds, since, limit]);
      return r.rows;
    },
    async ownIbans() {
      const r = await pool.query(`SELECT iban FROM bank_accounts WHERE iban IS NOT NULL AND iban <> ''`);
      return r.rows.map((x: { iban: string }) => x.iban);
    },
  };
}

/** Межа видимості рядка — та сама, що у стрічці «Виписки» (чиста функція, гейт ганяє саме її). */
export function canSeeTxRow(t: BankTx, p: { privateFinance: boolean; hiddenPayments: boolean }, payees: HiddenPayee[]): boolean {
  if (!p.privateFinance && (t.account_active === false || t.finance_only)) return false;
  const out = String(t.direction) === 'out';
  if (out && !p.privateFinance && t.out_private) return false;
  if (out && !p.hiddenPayments && isHidden((t.counterparty_name as string | null) ?? null, payees)) return false;
  return true;
}

const ms = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));
export const isIncoming = (t: BankTx) => (t.direction ? String(t.direction) === 'in' : Number(t.amount) > 0);

export function toLite(t: BankTx): TxLite {
  return {
    id: Number(t.id),
    accountId: Number(t.account_id),
    incoming: isIncoming(t),
    bookedAt: ms(t.booked_at),
    seenAt: t.seen_at ? ms(t.seen_at) : null,
    counterpartyName: t.counterparty_name ?? null,
    counterpartyIban: t.counterparty_iban ?? null,
    purpose: t.purpose ?? null,
  };
}

/** Поля рядка для клієнта — рівно ті, що віддає `/api/bank/incoming` (без службових прапорців видимості). */
export const PUBLIC_FIELDS = ['id', 'account_id', 'company', 'account_label', 'direction', 'booked_at', 'processed_at', 'counterparty_name',
  'counterparty_iban', 'purpose', 'amount', 'currency', 'fx_rate', 'amount_uah', 'external_tx_id', 'unmatched_account'];
export function publicRow(t: BankTx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_FIELDS) if (k in t) out[k] = t[k];
  return out;
}
