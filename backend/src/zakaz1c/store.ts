/**
 * 🗂 Журнал рахунків «ТЕСТ ЗАКАЗ 1С» (`zakaz_onec_invoices`). Джерело правди про рахунок — 1С; тут лише те, що
 * потрібно вікну: список рахунків угоди, кому й коли, де лежить PDF у Kommo і чим закінчилось прикріплення.
 *
 * Ключ — `invoice_uid` 1С: повторне натискання повертає ТОЙ САМИЙ рахунок (`existed: true` за `deal_id`), і запис
 * оновлюється, а не дублюється.
 */
import type { Pool } from "pg";
import type { CreatedInvoice } from "./invoice.js";
import type { Zakaz1cMode } from "./env.js";

export interface InvoiceRow {
  invoice_uid: string;
  number_print: string;
  invoice_date: string;
  organization: string;
  currency: string;
  total: string;
  existed: boolean;
  kommo_file_uuid: string | null;
  attach_error: string | null;
  created_at: string;
}

export async function saveInvoice(pool: Pool, r: {
  leadId: number; inv: CreatedInvoice; mode: Zakaz1cMode; kommoUserId: number; fileUuid: string | null; attachError: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO zakaz_onec_invoices (invoice_uid, lead_id, number, number_print, invoice_date, organization, agreement, currency,
       vat_type, total, existed, mode, kommo_user_id, kommo_file_uuid, attach_error, warnings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     ON CONFLICT (invoice_uid) DO UPDATE SET
       number_print = EXCLUDED.number_print, total = EXCLUDED.total, existed = EXCLUDED.existed,
       kommo_file_uuid = COALESCE(EXCLUDED.kommo_file_uuid, zakaz_onec_invoices.kommo_file_uuid),
       attach_error = EXCLUDED.attach_error, warnings = EXCLUDED.warnings, updated_at = now()`,
    [r.inv.uid, r.leadId, r.inv.number, r.inv.numberPrint, r.inv.date, r.inv.organization, r.inv.agreement, r.inv.currency,
      r.inv.vatType, r.inv.total, r.inv.existed, r.mode, r.kommoUserId, r.fileUuid, r.attachError, JSON.stringify(r.inv.warnings)],
  );
}

export async function listInvoices(pool: Pool, leadId: number): Promise<InvoiceRow[]> {
  const q = await pool.query<InvoiceRow>(
    `SELECT invoice_uid, number_print, invoice_date, organization, currency, total::text AS total, existed,
            kommo_file_uuid, attach_error, to_char(created_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM.YYYY HH24:MI') AS created_at
       FROM zakaz_onec_invoices i WHERE i.lead_id = $1 ORDER BY i.created_at DESC`, // `i.` — колонка часу, а не текстовий псевдонім вище
    [leadId],
  );
  return q.rows;
}

/** Рахунок належить цій угоді? «PDF ще раз» віддаємо лише по рахунку зі своєї угоди. */
export async function invoiceOfLead(pool: Pool, uid: string): Promise<number | null> {
  const q = await pool.query<{ lead_id: string }>(`SELECT lead_id::text AS lead_id FROM zakaz_onec_invoices WHERE invoice_uid = $1`, [uid]);
  return q.rows[0] ? Number(q.rows[0].lead_id) : null;
}
