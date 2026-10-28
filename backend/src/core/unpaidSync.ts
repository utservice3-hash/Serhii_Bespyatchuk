/**
 * 🗄 ЗАПИС НЕОПЛАЧЕНИХ РАХУНКІВ 1С (з 2026 року) у `onec_unpaid_invoices` + підсумок валютної дебіторки в журнал
 * `receivables_fx_totals` (джерело `unpaid-2026`) — ОДНІЄЮ транзакцією, щоб список і число не розходились. Вміст
 * замінюється цілком. Нуль рахунків 2026 року — відмова: гривневих неоплачених рахунків завжди сотні (26.10 — 488), тож
 * нуль означає збій, а не «все оплачено». Відмова нічого не пише, крім причини в `onec_unpaid_state`.
 */
import type { Db } from "./finance.js";
import type { UnpaidInvoice } from "./unpaidInvoices.js";
import { unpaidFxTotals } from "./unpaidInvoices.js";

export const FX_SOURCE = "unpaid-2026";

export async function replaceUnpaid(db: Db, rows: readonly UnpaidInvoice[], nbu: { USD?: number; EUR?: number }): Promise<{ rows: number; fx: number }> {
  if (!rows.length) throw new Error("1С, неоплачені рахунки: жодного рахунку 2026 року — нічого не змінено (схоже на збій сервісу)");
  await db.query(`DELETE FROM onec_unpaid_invoices`);
  for (let i = 0; i < rows.length; i += 1000) {
    const p = rows.slice(i, i + 1000);
    const col = <K extends keyof UnpaidInvoice>(k: K) => p.map((x) => x[k]);
    await db.query(`INSERT INTO onec_unpaid_invoices (uid, number, invoice_date, organization, contractor, edrpou, currency, invoice_sum, paid_sum, remaining,
        realized, partially_paid, debt_account, due_date, manager, deal_id, comment)
      SELECT * FROM unnest($1::text[], $2::text[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[],
        $11::bool[], $12::bool[], $13::text[], $14::date[], $15::text[], $16::bigint[], $17::text[])`,
    [col("uid"), col("number"), col("date"), col("organization"), col("contractor"), col("edrpou"), col("currency"), col("invoiceSum"), col("paidSum"), col("remaining"),
      col("realized"), col("partiallyPaid"), col("debtAccount"), col("dueDate"), col("manager"), col("dealId"), col("comment")]);
  }
  const t = unpaidFxTotals(rows, nbu);
  await db.query(`INSERT INTO receivables_fx_totals (rows, total_uah, total_val, zero_uah, usd, eur, unknown_val, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [t.rows, t.totalUah, t.totalVal, t.zeroUah, t.usd, t.eur, t.unknownVal, FX_SOURCE]);
  // Курс — той самий, з яким пораховано підсумок: «Дебіторка» рахує ≈ грн по рахунку саме за ним (задача 7136).
  await db.query(`INSERT INTO onec_unpaid_state (id, synced_at, rows, error, error_at, rate_eur, rate_usd) VALUES (1, now(), $1, NULL, NULL, $2, $3)
    ON CONFLICT (id) DO UPDATE SET synced_at = now(), rows = EXCLUDED.rows, error = NULL, error_at = NULL, rate_eur = EXCLUDED.rate_eur, rate_usd = EXCLUDED.rate_usd`,
  [rows.length, nbu.EUR ?? null, nbu.USD ?? null]);
  return { rows: rows.length, fx: t.rows };
}

export async function saveUnpaidError(db: Db, message: string): Promise<void> {
  await db.query(`INSERT INTO onec_unpaid_state (id, error, error_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, error_at = now()`,
    [message.slice(0, 500)]);
}

/** Рядок списку «що висить» під «Валютною дебіторкою». */
export interface UnpaidFxRow {
  number: string; date: string; organization: string; contractor: string; currency: string; invoiceSum: number; paidSum: number; remaining: number;
  realized: boolean; partiallyPaid: boolean; debtAccount: string | null; dueDate: string | null; manager: string | null; dealId: number | null; comment: string | null;
}
/**
 * Список валютних неоплачених рахунків 2026 року (найсвіжіші зверху) + стан синку — для «глянути, що там не так».
 * Стан окремо від списку: порожній список при помилці синку — це «не знаємо», і екран мусить це сказати.
 */
export async function loadUnpaidFx(db: Db, kommoBase: string): Promise<{ syncedAt: string | null; error: string | null; from: string; rowsAll: number | null; kommoBase: string; invoices: UnpaidFxRow[] }> {
  const st = (await db.query(`SELECT synced_at, rows, error FROM onec_unpaid_state WHERE id = 1`)).rows[0];
  const invoices = (await db.query(`SELECT number, invoice_date::text AS date, organization, contractor, currency, invoice_sum::float8 AS invoice_sum, paid_sum::float8 AS paid_sum,
      remaining::float8 AS remaining, realized, partially_paid, debt_account, due_date::text AS due_date, manager, deal_id::text AS deal_id, comment
    FROM onec_unpaid_invoices WHERE currency <> 'UAH' ORDER BY invoice_date DESC, number DESC`)).rows.map((x: Record<string, any>) => ({
    number: x.number, date: x.date, organization: x.organization, contractor: x.contractor, currency: x.currency, invoiceSum: x.invoice_sum, paidSum: x.paid_sum,
    remaining: x.remaining, realized: x.realized, partiallyPaid: x.partially_paid, debtAccount: x.debt_account, dueDate: x.due_date, manager: x.manager,
    dealId: x.deal_id == null ? null : Number(x.deal_id), comment: x.comment }));
  return { syncedAt: st?.synced_at ? new Date(st.synced_at).toISOString() : null, error: st?.error ?? null, from: "2026-01-01", rowsAll: st?.rows ?? null, kommoBase, invoices };
}
