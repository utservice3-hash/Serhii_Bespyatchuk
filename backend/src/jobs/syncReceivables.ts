import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { normalizeClientName } from "../utils/clientName.js";
import { parseCsv } from "../utils/csv.js";

// Cash ("готівка") clients tracked directly from CRM rather than the accounting
// sheet: they pay cash, so their debt isn't in the безнал receivables file. We
// surface every deal where an invoice was issued but the money HAS NOT arrived
// yet — i.e. anything before «Оплата отримана»/«Успішно». The row recomputes on
// every sync, so a deal drops off automatically once it reaches a paid stage.
// Keyed by every client_key variant the client appears under in CRM.
const CASH_RECEIVABLE_CLIENTS: { label: string; keys: string[] }[] = [
  { label: "МГЕР (готівка)", keys: ["мгер", "0668339283"] },
];
const FULL_CYCLE_PIPELINES = [8921932, 155304];
const PAID_STATUSES = [142, 69716460, 60412544]; // Успішно + Оплата отримана
const AVTO_STATUSES = [69716300, 98470988, 10937178];

/**
 * Inserts CRM cash clients' outstanding (invoice-issued, not-yet-paid) balances
 * into the receivables tables, alongside the sheet-derived rows. Runs inside the
 * sync transaction after the sheet load.
 */
async function insertCashReceivables(client: PoolClient): Promise<number> {
  let inserted = 0;
  for (const cc of CASH_RECEIVABLE_CLIENTS) {
    const deals = await client.query<{
      kommo_id: string; name: string | null; price: string; manager_id: number | null; created: string;
    }>(
      `SELECT d.kommo_id, d.name, d.price, d.manager_id,
              to_char((d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS created
         FROM deals d
         LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE d.client_key = ANY($1)
          AND d.pipeline_id = ANY($2)
          AND NOT (d.status_id = ANY($3))
          AND (psm.funnel_stage IN ('approved','invoiced') OR d.status_id = ANY($4))
          AND d.price > 0
        ORDER BY d.created_at_kommo`,
      [cc.keys, FULL_CYCLE_PIPELINES, PAID_STATUSES, AVTO_STATUSES]
    );
    if (deals.rowCount === 0) continue;

    const clientKey = cc.keys[0];
    const total = deals.rows.reduce((s, r) => s + Number(r.price), 0);
    // Attribute to the manager who owns the most unpaid deals.
    const byMgr = new Map<number, number>();
    for (const r of deals.rows) if (r.manager_id != null) byMgr.set(r.manager_id, (byMgr.get(r.manager_id) ?? 0) + 1);
    const managerId = [...byMgr.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const managerName = managerId != null
      ? (await client.query<{ name: string }>(`SELECT name FROM managers WHERE id = $1`, [managerId])).rows[0]?.name ?? ""
      : "";

    await client.query(
      `INSERT INTO receivables (client_key, client_name, manager_id, manager_name_raw, amount, limit_days, overdue_days)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL)`,
      [clientKey, cc.label, managerId, managerName, total]
    );
    for (const r of deals.rows) {
      await client.query(
        `INSERT INTO receivable_invoices
           (client_key, client_name, manager_id, manager_name_raw, invoice_no, invoice_date, amount, edrpou, service_url, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)`,
        [clientKey, cc.label, managerId, managerName, String(r.kommo_id), r.created, Number(r.price),
         `${config.kommo.baseUrl}/leads/detail/${r.kommo_id}`, r.name]
      );
    }
    inserted++;
  }
  return inserted;
}

interface ReceivableRow {
  clientKey: string;
  clientName: string;
  managerNameRaw: string;
  amount: number;
  invoiceNo: string | null;
  invoiceDate: string | null; // ISO YYYY-MM-DD
  edrpou: string | null;
  serviceUrl: string | null;
  note: string | null;
}

/** Extracts the invoice number and date from the "Счет" cell, e.g.
 *  "Счет на оплату покупателю 000005176 від 06.07.2026 14:54:08". */
function parseInvoice(cell: string | undefined): { no: string | null; date: string | null } {
  if (!cell) return { no: null, date: null };
  const noMatch = cell.match(/(\d{5,})/);
  const dateMatch = cell.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
  return { no: noMatch ? noMatch[1] : null, date };
}

/**
 * The sheet has no header row. Columns observed: 0 Контрагент, 1 Счет,
 * 2 "<Менеджер>, Загружен из amoCRM по сделке №...", 3 Сумма, 4 ЕДРПОУ,
 * 5 Сервіс (url), 6 (empty), 7 Пометка.
 */
function parseRow(cells: string[]): ReceivableRow | null {
  const rawClientName = cells[0]?.trim();
  const managerCell = cells[2]?.trim();
  const rawAmount = cells[3]?.trim();
  if (!rawClientName || !rawAmount) return null;

  const amount = Number(rawAmount.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(amount) || amount === 0) return null;

  const managerNameRaw = managerCell?.split(",")[0]?.trim() ?? "";
  const clientKey = normalizeClientName(rawClientName);
  if (!clientKey) return null;

  const inv = parseInvoice(cells[1]?.trim());
  return {
    clientKey, clientName: rawClientName, managerNameRaw, amount,
    invoiceNo: inv.no, invoiceDate: inv.date,
    edrpou: cells[4]?.trim() || null,
    serviceUrl: cells[5]?.trim() || null,
    note: cells[7]?.trim() || null,
  };
}

interface ClientLimit {
  limitDays: number | null;
  overdueDays: number | null;
  amount: number;
}

/**
 * "Лист20" tab: per-client agreed payment term ("Лимит дней") and how many
 * days the balance is currently overdue ("Макс дней"). Columns: 0 Контрагент,
 * 1 Менеджер, 2 Сумма, 3 Лимит компании, 4 Сумма (formatted), 5 Лимит дней,
 * 6 Макс дней, 7 Тим лид, 8 Примітка юриста. A client can repeat across rows
 * (one per invoice); we keep the figures from the row with the largest amount.
 */
function parseLimitRow(cells: string[]): { clientKey: string; limit: ClientLimit } | null {
  const rawClientName = cells[0]?.trim();
  if (!rawClientName) return null;
  const clientKey = normalizeClientName(rawClientName);
  if (!clientKey) return null;

  const amount = Number(cells[2]?.replace(/[^\d.-]/g, "")) || 0;
  const limitDays = cells[5]?.trim() ? Number(cells[5]) : null;
  const overdueDays = cells[6]?.trim() ? Number(cells[6]) : null;

  return {
    clientKey,
    limit: {
      limitDays: Number.isFinite(limitDays) ? limitDays : null,
      overdueDays: Number.isFinite(overdueDays) ? overdueDays : null,
      amount,
    },
  };
}

async function fetchClientLimits(): Promise<Map<string, ClientLimit>> {
  const res = await fetch(config.receivablesLimitsSheetUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch receivables limits sheet: ${res.status}`);
  }
  const csvText = await res.text();
  const limitsByKey = new Map<string, ClientLimit>();

  for (const cells of parseCsv(csvText)) {
    const parsed = parseLimitRow(cells);
    if (!parsed) continue;
    const existing = limitsByKey.get(parsed.clientKey);
    if (!existing || parsed.limit.amount > existing.amount) {
      limitsByKey.set(parsed.clientKey, parsed.limit);
    }
  }

  return limitsByKey;
}

export async function syncReceivables(): Promise<void> {
  const [res, limitsByKey] = await Promise.all([fetch(config.receivablesSheetUrl), fetchClientLimits()]);
  if (!res.ok) {
    throw new Error(`Failed to fetch receivables sheet: ${res.status}`);
  }
  const csvText = await res.text();
  const rows = parseCsv(csvText).map(parseRow).filter((r): r is ReceivableRow => r !== null);

  const managerRows = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM managers`
  );
  const managerIdByName = new Map(managerRows.rows.map((m) => [m.name, m.id]));

  const totalsByKey = new Map<
    string,
    { clientName: string; managerNameRaw: string; managerId: number | null; amount: number }
  >();

  for (const row of rows) {
    const managerId = managerIdByName.get(row.managerNameRaw) ?? null;
    const groupKey = `${row.clientKey}::${managerId ?? row.managerNameRaw}`;
    const existing = totalsByKey.get(groupKey);
    if (existing) {
      existing.amount += row.amount;
    } else {
      totalsByKey.set(groupKey, {
        clientName: row.clientName,
        managerNameRaw: row.managerNameRaw,
        managerId,
        amount: row.amount,
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE receivables");
    await client.query("TRUNCATE receivable_invoices");
    // Per-invoice detail rows (the "выгрузка" breakdown behind each balance).
    for (const row of rows) {
      const managerId = managerIdByName.get(row.managerNameRaw) ?? null;
      await client.query(
        `INSERT INTO receivable_invoices
           (client_key, client_name, manager_id, manager_name_raw, invoice_no, invoice_date, amount, edrpou, service_url, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.clientKey, row.clientName, managerId, row.managerNameRaw, row.invoiceNo, row.invoiceDate, row.amount, row.edrpou, row.serviceUrl, row.note]
      );
    }
    for (const [key, entry] of totalsByKey) {
      const clientKey = key.split("::")[0];
      const limit = limitsByKey.get(clientKey);
      await client.query(
        `INSERT INTO receivables (client_key, client_name, manager_id, manager_name_raw, amount, limit_days, overdue_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          clientKey,
          entry.clientName,
          entry.managerId,
          entry.managerNameRaw,
          entry.amount,
          limit?.limitDays ?? null,
          limit?.overdueDays ?? null,
        ]
      );
    }
    const cashClients = await insertCashReceivables(client);
    await client.query("COMMIT");
    console.log(`Synced ${totalsByKey.size} sheet balances + ${cashClients} CRM cash clients from ${rows.length} sheet rows.`);
    return;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncReceivables()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
