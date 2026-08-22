import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { fetchLeadsByIds, extractIncomeAmount } from "../kommo/client.js";
import { normalizeClientName } from "../utils/clientName.js";
import { parseCsv } from "../utils/csv.js";
import { loadReceivables1c, resolveManagerId, type Receivable1cRow } from "../core/receivables1c.js";
import { recomputeOwners } from "../core/receivablesOwnerStore.js";

// Cash ("готівка") clients tracked directly from CRM rather than the accounting
// sheet: they pay cash, so their debt isn't in the безнал receivables file. We
// surface every deal where an invoice was issued but the money HAS NOT arrived
// yet — i.e. anything before «Оплата отримана»/«Успішно». The row recomputes on
// every sync, so a deal drops off automatically once it reaches a paid stage.
// Keyed by every client_key variant the client appears under in CRM.
// 🔴 ЕКСПОРТОВАНО НАВМИСНО: `receivables` = рядки з 1С ∪ ЦЕЙ реєстр, і гейт `#125`
// мусить знати обидві половини. Поки реєстр був приватним, гейт звіряв нотатки
// лише з 1С — і готівковий МГЕР, законно присутній у дебіторці й законно
// відсутній у 1С, давав хибне «45 ≠ 44» на цілком справному синку.
// Читати замість цього `receivables` було б «A == A»: таблиця перевіряла б саму
// себе, і зсув ключа в синку — те, заради чого гейт існує, — став би невидимим.
// Ключ рядка — `keys[0]` (див. `clientKey` нижче), решта варіантів лише збирають угоди.
export const CASH_RECEIVABLE_CLIENTS: { label: string; keys: string[] }[] = [
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
    // The debt amount is the deal's INCOME ("приход"), not the calculator budget
    // (`price`) — the budget badly understates cash-client revenue. Pull приход
    // from CRM; fall back to the stored budget if a deal has no приход field.
    const incomeById = new Map<number, number>();
    try {
      const leads = await fetchLeadsByIds(deals.rows.map((r) => Number(r.kommo_id)));
      for (const l of leads) { const inc = extractIncomeAmount(l); if (inc != null) incomeById.set(l.id, inc); }
    } catch (err) {
      console.warn(`insertCashReceivables: приход fetch failed for ${cc.label}, using budget`, err);
    }
    const amountOf = (r: { kommo_id: string; price: string }) =>
      incomeById.get(Number(r.kommo_id)) ?? Number(r.price);

    const total = deals.rows.reduce((s, r) => s + amountOf(r), 0);
    // Attribute to the manager who owns the most unpaid deals.
    const byMgr = new Map<number, number>();
    for (const r of deals.rows) if (r.manager_id != null) byMgr.set(r.manager_id, (byMgr.get(r.manager_id) ?? 0) + 1);
    const managerId = [...byMgr.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const managerName = managerId != null
      ? (await client.query<{ name: string }>(`SELECT name FROM managers WHERE id = $1`, [managerId])).rows[0]?.name ?? ""
      : "";

    await client.query(
      `INSERT INTO receivables (client_key, client_name, manager_id, manager_name_raw, amount, limit_days, overdue_days, source)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'cash')`,
      [clientKey, cc.label, managerId, managerName, total]
    );
    for (const r of deals.rows) {
      await client.query(
        `INSERT INTO receivable_invoices
           (client_key, client_name, manager_id, manager_name_raw, invoice_no, invoice_date, amount, edrpou, service_url, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)`,
        [clientKey, cc.label, managerId, managerName, String(r.kommo_id), r.created, amountOf(r),
         `${config.kommo.baseUrl}/leads/detail/${r.kommo_id}`, r.name]
      );
    }
    inserted++;
  }
  return inserted;
}

/**
 * Парсить грошову суму з комірки бухгалтерського експорту.
 * 🔴 ПІСЛЯ ПЕРЕХОДУ НА 1С ЦЕ ПОТРІБНО ЛИШЕ ДЛЯ АРКУША ЛІМІТІВ («Лист20»).
 * Рахунки більше не парсяться з тексту — 1С віддає `Sum` числом, тож клас помилки
 * «кома з'їдена → сума ×100» на шляху рахунків зник разом із парсингом. Прибрати
 * функцію ЗОВСІМ не можна: `parseLimitRow` читає нею колонку «Сумма» Лист20.
 * ⚠️ Кома — це ДЕСЯТКОВИЙ роздільник копійок ("26073,48" = 26 073,48 грн), пробіл/nbsp —
 * розряди тисяч. Старий код робив `.replace(/[^\d.-]/g,"")` — стирав кому як «сміття»,
 * тож "26073,48" → "2607348" → сума роздувалась РІВНО ×100 (Укрпошта: 2,68 млн замість
 * ~103 тис, +30% до всієї дебіторки). Тому: прибрати пробіли, кому → крапка, далі число.
 * НЕ повертати стрип коми.
 */
function parseAmount(raw: string | undefined): number {
  if (!raw) return NaN;
  const cleaned = raw.replace(/[\s ]/g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  return Number(cleaned);
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

  const amount = parseAmount(cells[2]) || 0;
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
  const previousRes = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM receivable_invoices`);
  // ⚠️ Лічильник НАВМИСНО грубий: у `receivable_invoices` крім рахунків 1С лежить
  // ще ~12 готівкових рядків із CRM, і відділити їх без нової колонки нічим.
  // Похибка б'є в БЕЗПЕЧНИЙ бік — база трохи БІЛЬША за 1С-частину, тож поріг
  // «половина минулого разу» виходить трохи СУВОРІШИМ, а не мʼякшим.
  const previousCount = Number(previousRes.rows[0]?.n ?? 0);

  const [rows, limitsByKey] = await Promise.all([
    loadReceivables1c(async () => {
      const res = await fetch(config.receivables1cUrl);
      if (!res.ok) throw new Error(`Failed to fetch 1C receivables: ${res.status}`);
      return res.json();
    }, previousCount),
    fetchClientLimits(),
  ]);

  const managerRows = await pool.query<{ id: number; name: string }>(`SELECT id, name FROM managers`);
  const managerIdByName = new Map(managerRows.rows.map((m) => [m.name, m.id]));

  // № угоди з коментаря 1С → менеджер угоди. ОДИН запит по всіх id одразу:
  // рахунків три сотні, і по одному це були б три сотні походів у БД.
  const dealIds = [...new Set(rows.map((r) => r.dealId).filter((d): d is number => d != null))];
  const dealRows = dealIds.length
    ? await pool.query<{ kommo_id: string; manager_id: number | null }>(
        `SELECT kommo_id, manager_id FROM deals WHERE kommo_id = ANY($1)`,
        [dealIds]
      )
    : { rows: [] as { kommo_id: string; manager_id: number | null }[] };
  const managerIdByDeal = new Map(dealRows.rows.map((d) => [Number(d.kommo_id), d.manager_id]));
  const ctx = { managerIdByDeal, managerIdByName };

  // Менеджера рахуємо РАЗ на рядок і носимо далі: агрегат і деталізація мусять
  // казати про людину те саме, а два виклики одного правила поруч — це той спосіб,
  // яким копії розходяться.
  const priced = rows.map((row) => ({ row, managerId: resolveManagerId(row, ctx) }));

  // ── ОДИН РЯДОК НА КЛІЄНТА (рішення власника 22.08.2026) ────────────────────
  // Групуємо ТІЛЬКИ по `client_key`. Раніше ключем була пара «клієнт::менеджер»,
  // успадкована від гугл-таблиці, — саме через неї 73 клієнти давали 80 рядків,
  // а борг клієнта ніде не показувався одним числом.
  //
  // 🔴 ВІДПОВІДАЛЬНОГО ТУТ НЕ РАХУЄМО. Він проставляється нижче тим самим
  // `recomputeOwners`, яким користується адмін-роут, — щоб правило не жило двічі
  // і щоб «після синку» і «після кнопки» не могли розійтись у принципі.
  const invByClient = new Map<string, { row: Receivable1cRow; managerId: number | null }[]>();
  for (const p of priced) {
    const a = invByClient.get(p.row.clientKey) ?? [];
    a.push(p);
    invByClient.set(p.row.clientKey, a);
  }
  const aggregates = [...invByClient.entries()].map(([clientKey, list]) => ({
    clientKey,
    clientName: list[0].row.clientName,
    amount: list.reduce((s, p) => s + p.row.amount, 0),
  }));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE receivables");
    await client.query("TRUNCATE receivable_invoices");
    for (const { row, managerId } of priced) {
      // «Лінк» у деталізації: раніше сюди лягав URL самого ендпоінта 1С (тобто
      // 🔗 вів на дамп JSON). Тепер — угода в Kommo, коли її № відомий; інакше
      // порожньо, і на екрані чесне «—», а не лінк, що нікуди не веде.
      const serviceUrl = row.dealId != null ? `${config.kommo.baseUrl}/leads/detail/${row.dealId}` : null;
      await client.query(
        `INSERT INTO receivable_invoices
           (client_key, client_name, manager_id, manager_name_raw, invoice_no, invoice_date, amount, edrpou, service_url, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.clientKey, row.clientName, managerId, row.managerHint, row.invoiceNo, row.invoiceDate,
         row.amount, row.edrpou, serviceUrl, row.comment]
      );
    }
    for (const entry of aggregates) {
      const limit = limitsByKey.get(entry.clientKey);
      await client.query(
        `INSERT INTO receivables (client_key, client_name, manager_id, manager_name_raw, amount, limit_days, overdue_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        // Відповідальний лишається NULL до `recomputeOwners` нижче — у ТІЙ САМІЙ
        // транзакції, тож зовні проміжного стану не існує.
        [entry.clientKey, entry.clientName, null, "", entry.amount,
         limit?.limitDays ?? null, limit?.overdueDays ?? null]
      );
    }
    // Відповідальний — ОДНИМ проходом, тим самим кодом, що й адмін-кнопка.
    // Стоїть ДО готівки навмисно: готівкові рядки перебудовує CRM щосинку, тож
    // ручне призначення там відкотилось би саме.
    const owners = await recomputeOwners(client);
    const cashClients = await insertCashReceivables(client);
    await client.query("COMMIT");
    // 🟢 ОБСЯГ У ЛОЗІ, А НЕ ЛИШЕ «відпрацювала»: для джоби-імпортера «успіх» без
    // числа привезеного нічого не означає (правило з CLAUDE.md, урок `syncCalls`).
    const byDeal = priced.filter((p) => p.row.dealId != null && managerIdByDeal.get(p.row.dealId!) != null).length;
    console.log(
      `Synced ${aggregates.length} клієнтів + ${cashClients} CRM cash clients from ${rows.length} 1C invoice rows ` +
      `(менеджер рахунку: за угодою ${byDeal}, без менеджера ${priced.filter((p) => p.managerId == null).length}; ` +
      `відповідальний: вручну ${owners.bySource.override}, мажоритар ${owners.bySource["auto-majority"]}, ` +
      `тімлід ${owners.bySource["auto-teamlead"]}, немає ${owners.bySource.none}).`
    );
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
