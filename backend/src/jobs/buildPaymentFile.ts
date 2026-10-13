/**
 * 💸 `buildPaymentFile` — файл на оплату перевізникам (готівка) щогодини о :40 + фінальний о 16:55 у будні.
 * Логіка перевірок — `core/paymentRun.ts`; тут лише збирання даних і запис.
 *
 * Джерела в мить запуску: черга з живого Kommo (Танин фільтр) + основні угоди (одним запитом по id) + наша база
 * (дублі й уже оплачені запити, неоплачені рахунки 1С угоди, платежі «Виписки», ліміти й борг клієнта).
 *
 * 🔴 У KOMMO НЕ ПИШЕ (паралельний тиждень). 🔴 НОМЕРИ КАРТОК І ПІБ У БАЗІ НЕ ЗБЕРІГАЮТЬСЯ: вони йдуть лише в таблицю
 * (`PAYMENTS_SHEET_ID`), а стан прогону (`payment_file_state`) знає id, суми й причини. Таблиці не задано — прогін
 * усе одно рахує й пише стан (видно, що джоба жива), а запис таблиці — пропущено з причиною.
 * ⏱ Прапорець «уже працює» має стелю (правило зони jobs-sync).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { kommoRequest, fetchLeadsByIds, type KommoDeal } from "../kommo/client.js";
import { writeSheetTab } from "../bankSources/googleSheets.js";
import { invoicePaymentsSql, toPayments, OPEN_UNIVERSE_SQL, toUniverse, matchAll, PAYMENT_LOOKBACK_DAYS, type OpenInvoice } from "../core/paymentMatch.js";
import {
  PAY_PIPELINE, PAY_STATUSES, PAY_RESPONSIBLE, PAY_URGENCY, REQ_FIELDS, MAIN_FIELDS,
  cashExpenseOf, judgeRequest, payRow, isNetworkDrop, type PayRequest, type MainDeal, type PayContext, type Verdict,
} from "../core/paymentRun.js";
import { jobSkip } from "./jobRuns.js";

const CEILING_MS = 10 * 60_000;
let running: number | null = null;

/** Один повтор на обрив зʼєднання з Kommo (`isNetworkDrop`, `core/paymentRun.ts`); відмову з кодом не повторюємо. */
async function once<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) { if (!isNetworkDrop(e)) throw e; await new Promise((r) => setTimeout(r, 3000)); return f(); }
}

const cf = (d: KommoDeal, id: number): string | null => {
  const v = d.custom_fields_values?.find((f) => f.field_id === id)?.values?.[0]?.value;
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};
const num = (s: string | null) => { const n = Number(String(s ?? "").replace(/[\s ]/g, "").replace(",", ".")); return s != null && Number.isFinite(n) ? n : null; };
const ttnCount = (d: KommoDeal) => (d.custom_fields_values?.find((f) => f.field_id === REQ_FIELDS.ttn)?.values ?? [])
  .filter((v) => { const f = v.value as { file_uuid?: unknown; is_deleted?: unknown } | null; return !!f && typeof f === "object" && !!f.file_uuid && f.is_deleted !== true; }).length;

/** Черга Тетяни: три етапи × відповідальна; терміновість — «Стандартная» (фільтром Kommo API по полю не відібрати). */
export async function fetchQueue(): Promise<KommoDeal[]> {
  const st = PAY_STATUSES.map((s, i) => `filter[statuses][${i}][pipeline_id]=${PAY_PIPELINE}&filter[statuses][${i}][status_id]=${s}`).join("&");
  const out: KommoDeal[] = [];
  for (let page = 1; page <= 4; page++) {
    const data = await kommoRequest<{ _embedded?: { leads?: KommoDeal[] } } | null>(`/api/v4/leads?limit=250&page=${page}&${st}&filter[responsible_user_id]=${PAY_RESPONSIBLE}`);
    const leads = data?._embedded?.leads ?? [];
    out.push(...leads);
    if (leads.length < 250) break;
  }
  return out.filter((d) => cf(d, REQ_FIELDS.urgency) === PAY_URGENCY);
}

export const toRequest = (d: KommoDeal): PayRequest => ({
  id: d.id, createdAt: new Date(Number(d.created_at ?? 0) * 1000),
  type: cf(d, REQ_FIELDS.type), urgency: cf(d, REQ_FIELDS.urgency),
  phone: cf(d, REQ_FIELDS.phone), card: cf(d, REQ_FIELDS.card), bank: cf(d, REQ_FIELDS.bank), recipient: cf(d, REQ_FIELDS.recipient),
  cash: num(cf(d, REQ_FIELDS.cash)), sourceDealId: num(cf(d, REQ_FIELDS.sourceDeal)), ttnFiles: ttnCount(d),
});
export const toMain = (d: KommoDeal): MainDeal => ({
  id: d.id, cashExpense: cashExpenseOf((id) => cf(d, id)),
  paid1c: cf(d, MAIN_FIELDS.paid1c) === "true", invoiceIssued: cf(d, MAIN_FIELDS.invoiceIssued) === "true",
});

export interface RunRow { id: number; mainId: number | null; amount: number | null; ok: boolean; paidBy: Verdict["paidBy"]; reasons: string[]; notes: string[] }
export interface RunResult { at: string; queue: number; ok: number; check: number; total: number; rows: RunRow[]; sheet: string }

/** Контекст для всіх запитів черги — пакетом (кілька запитів у БД на прогін, а не на кожен запит). */
async function contexts(reqs: PayRequest[], mains: Map<number, MainDeal>): Promise<Map<number, PayContext>> {
  const mainIds = [...mains.keys()];
  const sib = (await pool.query<{ kommo_id: string; source_deal_id: string; amount: string | null; status_id: string }>(
    `SELECT kommo_id::text, source_deal_id::text, carrier_pay_amount::text AS amount, status_id::text FROM deals
      WHERE pipeline_id = $1 AND source_deal_id = ANY($2::bigint[]) AND carrier_pay_type ILIKE 'готів%' AND status_id <> 143`,
    [PAY_PIPELINE, mainIds])).rows;
  const info = (await pool.query<{ kommo_id: string; client_key: string | null; mgr: string | null }>(
    `SELECT d.kommo_id::text, d.client_key, m.name AS mgr FROM deals d LEFT JOIN managers m ON m.id = d.manager_id WHERE d.kommo_id = ANY($1::bigint[])`,
    [mainIds])).rows;
  const keyOf = new Map(info.map((x) => [Number(x.kommo_id), x]));
  const keys = [...new Set(info.map((x) => x.client_key).filter((k): k is string => !!k))];
  const limits = new Map((await pool.query<{ client_key: string; limit_days: number; limit_amount: string | null }>(
    `SELECT client_key, limit_days, limit_amount::text FROM client_credit_limits WHERE client_key = ANY($1)`, [keys])).rows.map((x) => [x.client_key, x]));
  const debts = new Map((await pool.query<{ client_key: string; amount: string; age: number | null }>(
    `SELECT client_key, sum(amount)::text AS amount, max(overdue_days) AS age FROM receivables WHERE client_key = ANY($1) GROUP BY client_key`, [keys])).rows.map((x) => [x.client_key, x]));
  // Неоплачені рахунки 1С угоди: рахунок знає свою угоду через `service_url` (…/leads/detail/<id>, `syncReceivables`).
  const inv = (await pool.query<{ invoice_no: string; amount: string; edrpou: string | null; deal: string }>(
    `SELECT invoice_no, amount::text, edrpou, substring(service_url from '/leads/detail/([0-9]+)$') AS deal FROM receivable_invoices
      WHERE COALESCE(invoice_no, '') <> '' AND substring(service_url from '/leads/detail/([0-9]+)$') = ANY($1::text[])`, [mainIds.map(String)])).rows;
  const invByDeal = new Map<number, OpenInvoice[]>();
  for (const x of inv) { const k = Number(x.deal); invByDeal.set(k, [...(invByDeal.get(k) ?? []), { invoiceNo: x.invoice_no, amount: Number(x.amount), edrpou: x.edrpou }]); }
  const universe = toUniverse((await pool.query(OPEN_UNIVERSE_SQL)).rows);
  const payments = toPayments((await pool.query(invoicePaymentsSql(1), [PAYMENT_LOOKBACK_DAYS])).rows);
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const seen = matchAll([...invByDeal.values()].flat(), universe, payments, today);

  const out = new Map<number, PayContext>();
  for (const r of reqs) {
    const mid = r.sourceDealId ?? -1;
    const others = sib.filter((s) => Number(s.source_deal_id) === mid && Number(s.kommo_id) !== r.id);
    const dupOf = others.filter((s) => r.cash != null && s.amount != null && Math.abs(Number(s.amount) - r.cash) < 0.5).map((s) => Number(s.kommo_id));
    const paidBefore = others.filter((s) => Number(s.status_id) === 142).reduce((a, s) => a + Number(s.amount ?? 0), 0);
    const invs = invByDeal.get(mid) ?? [];
    const hit = invs.map((i) => ({ i, s: seen.get(i.invoiceNo) })).find((x) => x.s && (x.s.kind === "seen" || x.s.kind === "stale"));
    const ck = keyOf.get(mid)?.client_key ?? null;
    const lim = ck ? limits.get(ck) : undefined, dbt = ck ? debts.get(ck) : undefined;
    out.set(r.id, {
      dupOf, paidBefore, openInvoices: invs.map((i) => i.invoiceNo),
      bankSeen: hit ? { invoiceNo: hit.i.invoiceNo, bookedOn: hit.s!.bookedOn ?? "" } : null,
      limit: lim ? { days: lim.limit_days, amount: lim.limit_amount == null ? null : Number(lim.limit_amount) } : null,
      debt: dbt ? { amount: Number(dbt.amount), ageDays: dbt.age } : null,
      ttnExempt: /бесп.?ятчук/i.test(keyOf.get(mid)?.mgr ?? ""),
    });
  }
  return out;
}

/** Один прогін. `write=false` — лише порахувати (сухий прогін для звірки, без таблиці й без стану). */
export async function buildOnce(write = true): Promise<RunResult> {
  const now = new Date();
  const queue = await once(fetchQueue);
  const reqs = queue.map(toRequest);
  const ids = [...new Set(reqs.map((r) => r.sourceDealId).filter((x): x is number => x != null))];
  const mains = new Map((ids.length ? await once(() => fetchLeadsByIds(ids)) : []).map((d) => [d.id, toMain(d)]));
  const ctx = await contexts(reqs, mains);
  const rows: RunRow[] = [];
  const pay: (string | number)[][] = [], check: (string | number)[][] = [];
  for (const r of reqs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const m = r.sourceDealId != null ? mains.get(r.sourceDealId) ?? null : null;
    const v = judgeRequest(r, m, ctx.get(r.id)!, now);
    rows.push({ id: r.id, mainId: m?.id ?? r.sourceDealId, amount: r.cash, ok: v.ok, paidBy: v.paidBy, reasons: v.reasons, notes: v.notes });
    if (v.ok && m) pay.push(payRow(r, m));
    else check.push([m?.id ?? r.sourceDealId ?? "", r.id, r.cash ?? "", v.reasons.join("; "), v.notes.join("; ")]);
  }
  const total = Math.round(pay.reduce((a, x) => a + Number(x[3]), 0) * 100) / 100;
  const at = now.toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  let sheet = "не записано: сухий прогін";
  if (write) {
    if (!config.paymentsSheet.spreadsheetId) sheet = "не записано: таблицю не задано (PAYMENTS_SHEET_ID)";
    else {
      // «До оплати» — рівно Танин файл: у шапці колонки суми стоїть підсумок (як у неї).
      await writeSheetTab(config.paymentsSheet.spreadsheetId, "До оплати", [["ID", "Номер карти", "Власник карти", total, "Категорії"], ...pay]);
      await writeSheetTab(config.paymentsSheet.spreadsheetId, "Перевірити", [
        [`Сформовано ${at} · у черзі ${reqs.length}: до оплати ${pay.length} на ${total}, перевірити ${check.length}. Запити в CRM не закриваються (паралельний тиждень).`],
        ["ID угоди", "Запит", "Сума", "Причина", "Примітка"], ...check]);
      sheet = "записано";
    }
    await pool.query(`INSERT INTO payment_file_state (id, at, queue, ok, check_count, total, rows, sheet) VALUES (1, now(), $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET at = now(), queue = $1, ok = $2, check_count = $3, total = $4, rows = $5, sheet = $6`,
      [reqs.length, pay.length, check.length, total, JSON.stringify(rows), sheet]);
  }
  return { at, queue: reqs.length, ok: pay.length, check: check.length, total, rows, sheet };
}

/** Для крона: пропуск — пропуск (`jobSkip`), обсяг — у підсумку. Порожня черга — успіх із нулем (буває ввечері). */
export async function buildPaymentFile(): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Файл на оплату: попередній прогін ще йде");
  running = Date.now();
  try { const r = await buildOnce(true); return { queue: r.queue, ok: r.ok, check: r.check, total: r.total, sheet: r.sheet }; }
  finally { running = null; }
}

// Сухий прогін руками на сервері: `node dist/jobs/buildPaymentFile.js --dry` — без таблиці, без стану, без номерів карток.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes("--dry");
  buildOnce(!dry).then((r) => {
    console.log(`черга ${r.queue}: до оплати ${r.ok} на ${r.total}, перевірити ${r.check} · ${r.sheet}`);
    for (const x of r.rows) console.log(`${x.ok ? "✅" : "⚠️ "} запит #${x.id} угода #${x.mainId} ${x.amount ?? "—"} ₴ · ${x.paidBy ?? "—"} · ${[...x.reasons, ...x.notes].join("; ")}`);
  }).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
