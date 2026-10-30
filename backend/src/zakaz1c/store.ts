/**
 * 🗂 Журнал рахунків «ТЕСТ ЗАКАЗ 1С» (`zakaz_onec_invoices`). Джерело правди про рахунок — 1С; тут лише те, що
 * потрібно вікну: список рахунків угоди, кому й коли, де лежить PDF у Kommo, чим закінчилось прикріплення, і те, що
 * менеджер заповнив (позиції, договір, банк, дати, коментар) — щоб «Змінити» відкривало форму з тими самими даними.
 *
 * Ключ — `invoice_uid` 1С. Повтор тієї самої форми (`request_id`) повертає той самий рахунок (`existed: true`), і
 * запис оновлюється, а не дублюється. «Змінити» (`updateInvoice`) переписує поля форми й лічить `edits`.
 *
 * Оплата рахунку — НЕ тут: її читаємо зі знімка неоплачених рахунків 1С (`onec_unpaid_invoices`) і оплат угоди
 * (`onec_deal_payments`), правило — `payStateOf` (`invoice.ts`).
 */
import type { Pool } from "pg";
import { canEdit, payStateOf, type CreatedInvoice, type InvoiceForm, type PayState } from "./invoice.js";
import type { Zakaz1cMode } from "./env.js";

export interface InvoiceRow {
  invoice_uid: string;
  number: string;
  number_print: string;
  invoice_date: string;
  organization: string;
  org_key: string | null;
  currency: string;
  vat_type: string;
  total: number;
  existed: boolean;
  attach_error: string | null;
  items: unknown;
  agreement_uid: string | null;
  bank_uid: string | null;
  due_date: string | null;
  act_date: string | null;
  crm_comment: string | null;
  stamp: boolean;
  edits: number;
  created_at: string;
  pay: PayState;
  can_edit: boolean;
}

export async function saveInvoice(pool: Pool, r: {
  leadId: number; inv: CreatedInvoice; form: InvoiceForm | null; mode: Zakaz1cMode; kommoUserId: number; fileUuid: string | null;
  attachError: string | null; edit?: boolean;
}): Promise<void> {
  const f = r.form;
  await pool.query(
    `INSERT INTO zakaz_onec_invoices (invoice_uid, lead_id, number, number_print, invoice_date, organization, agreement, currency,
       vat_type, total, existed, mode, kommo_user_id, kommo_file_uuid, attach_error, warnings, org_key, items, due_date, act_date, bank,
       crm_comment, request_id, agreement_uid, bank_uid, stamp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb,$19,$20,$21,$22,$23,$24,$25,$26)
     ON CONFLICT (invoice_uid) DO UPDATE SET
       number_print = EXCLUDED.number_print, total = EXCLUDED.total, vat_type = EXCLUDED.vat_type, agreement = EXCLUDED.agreement,
       kommo_file_uuid = COALESCE(EXCLUDED.kommo_file_uuid, zakaz_onec_invoices.kommo_file_uuid),
       attach_error = EXCLUDED.attach_error, warnings = EXCLUDED.warnings, updated_at = now(),
       items = CASE WHEN $27 THEN EXCLUDED.items ELSE zakaz_onec_invoices.items END,
       due_date = CASE WHEN $27 THEN EXCLUDED.due_date ELSE zakaz_onec_invoices.due_date END,
       act_date = CASE WHEN $27 THEN EXCLUDED.act_date ELSE zakaz_onec_invoices.act_date END,
       crm_comment = CASE WHEN $27 THEN EXCLUDED.crm_comment ELSE zakaz_onec_invoices.crm_comment END,
       agreement_uid = CASE WHEN $27 THEN EXCLUDED.agreement_uid ELSE zakaz_onec_invoices.agreement_uid END,
       bank_uid = CASE WHEN $27 THEN EXCLUDED.bank_uid ELSE zakaz_onec_invoices.bank_uid END,
       stamp = CASE WHEN $27 THEN EXCLUDED.stamp ELSE zakaz_onec_invoices.stamp END,
       edits = zakaz_onec_invoices.edits + CASE WHEN $27 THEN 1 ELSE 0 END`,
    [r.inv.uid, r.leadId, r.inv.number, r.inv.numberPrint, r.inv.date, r.inv.organization, r.inv.agreement, r.inv.currency,
      r.inv.vatType, r.inv.total, r.inv.existed, r.mode, r.kommoUserId, r.fileUuid, r.attachError, JSON.stringify(r.inv.warnings),
      f?.org ?? null, JSON.stringify(f?.items ?? []), f?.dueDate || null, f?.actDate || null, null, f?.crmComment || null,
      f?.requestId || null, f?.agreement || null, f?.bankUid || null, f?.stamp ?? true, r.edit === true],
  );
}

/** Рахунки угоди разом зі станом оплати й «можна змінити». `today` — київське `YYYY-MM-DD`. */
export async function listInvoices(pool: Pool, leadId: number, today: string): Promise<InvoiceRow[]> {
  const [q, st, dp] = await Promise.all([
    pool.query<Record<string, any>>(
      `SELECT i.invoice_uid, i.number, i.number_print, i.invoice_date, i.organization, i.org_key, i.currency, i.vat_type,
              i.total::float8 AS total, i.existed, i.attach_error, i.items, i.agreement_uid, i.bank_uid, i.crm_comment, i.stamp, i.edits,
              to_char(i.due_date, 'YYYY-MM-DD') AS due_date, to_char(i.act_date, 'YYYY-MM-DD') AS act_date,
              i.created_at AS created_ts, to_char(i.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS created_day,
              to_char(i.created_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM.YYYY HH24:MI') AS created_at,
              u.uid AS u_uid, u.paid_sum::float8 AS u_paid, u.remaining::float8 AS u_remaining, to_char(u.due_date, 'YYYY-MM-DD') AS u_due
         FROM zakaz_onec_invoices i LEFT JOIN onec_unpaid_invoices u ON u.uid = i.invoice_uid
        WHERE i.lead_id = $1 ORDER BY i.created_at DESC`, // `i.` — колонка часу, а не текстовий псевдонім вище
      [leadId]),
    pool.query<{ synced_at: Date | null }>(`SELECT synced_at FROM onec_unpaid_state WHERE id = 1`),
    pool.query<{ paid: number }>(`SELECT COALESCE(sum(sum), 0)::float8 AS paid FROM onec_deal_payments WHERE deal_id = $1`, [leadId]),
  ]);
  const syncedAt = st.rows[0]?.synced_at ?? null;
  const dealPaid = Number(dp.rows[0]?.paid) || 0;
  return q.rows.map((r) => {
    const pay = payStateOf({ createdAt: new Date(r.created_ts), total: Number(r.total) || 0 },
      r.u_uid ? { paid: Number(r.u_paid) || 0, remaining: Number(r.u_remaining) || 0, due: r.u_due ?? null } : null,
      { syncedAt, dealPaid, today });
    return {
      invoice_uid: r.invoice_uid, number: r.number, number_print: r.number_print, invoice_date: r.invoice_date, organization: r.organization,
      org_key: r.org_key, currency: r.currency, vat_type: r.vat_type, total: Number(r.total) || 0, existed: r.existed,
      attach_error: r.attach_error, items: r.items, agreement_uid: r.agreement_uid, bank_uid: r.bank_uid, due_date: r.due_date,
      act_date: r.act_date, crm_comment: r.crm_comment, stamp: r.stamp !== false, edits: Number(r.edits) || 0, created_at: r.created_at,
      pay, can_edit: canEdit(r.created_day, pay, today),
    };
  });
}

/** Рахунок належить цій угоді? «PDF ще раз», акт, зміна й запит бухгалтерії — лише по рахунку зі своєї угоди. */
export async function invoiceOfLead(pool: Pool, uid: string): Promise<{ leadId: number; numberPrint: string; invoiceDate: string } | null> {
  const q = await pool.query<{ lead_id: string; number_print: string; invoice_date: string }>(
    `SELECT lead_id::text AS lead_id, number_print, invoice_date FROM zakaz_onec_invoices WHERE invoice_uid = $1`, [uid]);
  const r = q.rows[0];
  return r ? { leadId: Number(r.lead_id), numberPrint: r.number_print, invoiceDate: r.invoice_date } : null;
}

/** Номери ВСІХ рахунків 1С за угодою (`onec_deal_invoices`, синк щогодини) — для «хто веде угоду» (`owner.ts`). */
export async function onecNumbersOfDeal(pool: Pool, leadId: number): Promise<string[]> {
  const q = await pool.query<{ number: string | null }>(`SELECT number FROM onec_deal_invoices WHERE deal_id = $1`, [leadId]);
  return q.rows.map((r) => String(r.number ?? "")).filter(Boolean);
}

/** Акт уже лежить у файлах угоди? Кладемо його туди один раз, а не на кожне натискання. */
export async function actAttached(pool: Pool, uid: string): Promise<boolean> {
  const q = await pool.query<{ act_file_uuid: string | null }>(`SELECT act_file_uuid FROM zakaz_onec_invoices WHERE invoice_uid = $1`, [uid]);
  return !!q.rows[0]?.act_file_uuid;
}
export async function markActAttached(pool: Pool, uid: string, fileUuid: string): Promise<void> {
  await pool.query(`UPDATE zakaz_onec_invoices SET act_file_uuid = $2, updated_at = now() WHERE invoice_uid = $1`, [uid, fileUuid]);
}
