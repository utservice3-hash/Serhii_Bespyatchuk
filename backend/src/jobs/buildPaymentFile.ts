/**
 * 💸 `buildPaymentFile` — файл на оплату перевізникам (готівка) щогодини о :40 + фінальний о 16:55 у будні.
 * Логіка перевірок — `core/paymentRun.ts`; тут лише збирання даних і запис.
 *
 * Джерела в мить запуску: запити Тетяни з живого Kommo за її вікном (17:00 вчора — 17:00 сьогодні, разом із уже
 * закритими «Оплачено»: вона закриває запит, щойно вносить у файл) + основні угоди (одним запитом по id) + наша база
 * (дублі й уже оплачені запити, платежі «Виписки», ліміти й борг клієнта).
 *
 * 🔴 У KOMMO НЕ ПИШЕ (паралельний тиждень). 🔴 НОМЕРИ КАРТОК І ПІБ У БАЗІ НЕ ЗБЕРІГАЮТЬСЯ: вони йдуть лише в таблицю
 * (`PAYMENTS_SHEET_ID`), а стан прогону (`payment_file_state`) знає id, суми й причини. Таблиці не задано — прогін
 * усе одно рахує й пише стан (видно, що джоба жива), а запис таблиці — пропущено з причиною.
 * ⏱ Прапорець «уже працює» має стелю (правило зони jobs-sync).
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { kommoRequest, fetchLeadsByIds, type KommoDeal } from "../kommo/client.js";
import { writeSheetTab } from "../bankSources/googleSheetsWrite.js";
import { FM_INCOME_FIELDS } from "../core/fmSums.js";
import {
  PAY_PIPELINE, PAY_STATUSES, PAY_RESPONSIBLE, PAY_URGENCY, PAY_LOOKBACK_DAYS, REQ_FIELDS, MAIN_FIELDS,
  cashExpenseOf, judgeRequest, payRow, isNetworkDrop, orderNoOf, findBankPayment, payWindow, dupsOf,
  type PayRequest, type MainDeal, type PayContext, type Verdict, type BankIn,
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

async function leadsPaged(query: string): Promise<KommoDeal[]> {
  const out: KommoDeal[] = [];
  for (let page = 1; page <= 4; page++) {
    const data = await kommoRequest<{ _embedded?: { leads?: KommoDeal[] } } | null>(`/api/v4/leads?limit=250&page=${page}&${query}`);
    const leads = data?._embedded?.leads ?? [];
    out.push(...leads);
    if (leads.length < 250) break;
  }
  return out;
}

/**
 * Запити Тетяни для файлу: (а) усі, що висять у її трьох етапах, створені до кінця вікна (старші — з позначкою
 * «висить N дн.»), + (б) закриті «Оплачено», створені у вікні. Терміновість — «Стандартная» (полем Kommo API не відібрати).
 */
export async function fetchQueue(win: { from: Date; to: Date }): Promise<KommoDeal[]> {
  const st = (ids: readonly number[]) => ids.map((s, i) => `filter[statuses][${i}][pipeline_id]=${PAY_PIPELINE}&filter[statuses][${i}][status_id]=${s}`).join("&");
  const who = `filter[responsible_user_id]=${PAY_RESPONSIBLE}`;
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);
  const open = await leadsPaged(`${st(PAY_STATUSES)}&${who}`);
  const paid = await leadsPaged(`${st([142])}&${who}&filter[created_at][from]=${sec(win.from)}&filter[created_at][to]=${sec(win.to) - 1}`);
  const seen = new Set<number>();
  return [...open, ...paid].filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return cf(d, REQ_FIELDS.urgency) === PAY_URGENCY && Number(d.created_at ?? 0) < sec(win.to);
  });
}

export const toRequest = (d: KommoDeal): PayRequest => ({
  id: d.id, createdAt: new Date(Number(d.created_at ?? 0) * 1000),
  type: cf(d, REQ_FIELDS.type), urgency: cf(d, REQ_FIELDS.urgency),
  phone: cf(d, REQ_FIELDS.phone), card: cf(d, REQ_FIELDS.card), bank: cf(d, REQ_FIELDS.bank), recipient: cf(d, REQ_FIELDS.recipient),
  cash: num(cf(d, REQ_FIELDS.cash)), sourceDealId: num(cf(d, REQ_FIELDS.sourceDeal)), ttnFiles: ttnCount(d),
});
export const toMain = (d: KommoDeal, clientName: string | null): MainDeal => {
  const inc = FM_INCOME_FIELDS.map((id) => num(cf(d, id))).filter((x): x is number => x != null && x > 0);
  return {
    id: d.id, cashExpense: cashExpenseOf((id) => cf(d, id)),
    paid1c: cf(d, MAIN_FIELDS.paid1c) === "true", invoiceIssued: cf(d, MAIN_FIELDS.invoiceIssued) === "true",
    orderNo: orderNoOf(cf(d, MAIN_FIELDS.orderNo)), income: inc.length ? inc.reduce((a, x) => a + x, 0) : null, clientName,
  };
};

export interface RunRow { id: number; mainId: number | null; amount: number | null; ok: boolean; paidBy: Verdict["paidBy"]; reasons: string[]; notes: string[] }
export interface RunResult { at: string; day: string; queue: number; ok: number; check: number; total: number; rows: RunRow[]; sheet: string }

/** «Квитанція…» серед вкладень угоди — лише для угод без доведеної оплати (кілька запитів на прогін). */
async function hasReceipt(dealId: number): Promise<boolean> {
  const data = await kommoRequest<{ _embedded?: { notes?: { params?: { original_name?: string; text?: string } }[] } } | null>(
    `/api/v4/leads/${dealId}/notes?limit=100&filter[note_type]=attachment`);
  return (data?._embedded?.notes ?? []).some((n) => /квитанц/i.test(`${n.params?.original_name ?? ""} ${n.params?.text ?? ""}`));
}

/** Контекст для всіх запитів — пакетом (кілька запитів у БД на прогін, а не на кожен запит). */
async function contexts(reqs: PayRequest[], mains: Map<number, MainDeal>, clientKey: Map<number, { key: string | null; mgr: string | null }>): Promise<Map<number, PayContext>> {
  const mainIds = [...mains.keys()];
  const sib = (await pool.query<{ kommo_id: string; source_deal_id: string; amount: string | null; status_id: string }>(
    `SELECT kommo_id::text, source_deal_id::text, carrier_pay_amount::text AS amount, status_id::text FROM deals
      WHERE pipeline_id = $1 AND source_deal_id = ANY($2::bigint[]) AND carrier_pay_type ILIKE 'готів%' AND status_id <> 143`,
    [PAY_PIPELINE, mainIds])).rows;
  const keys = [...new Set([...clientKey.values()].map((x) => x.key).filter((k): k is string => !!k))];
  const limits = new Map((await pool.query<{ client_key: string; limit_days: number; limit_amount: string | null }>(
    `SELECT client_key, limit_days, limit_amount::text FROM client_credit_limits WHERE client_key = ANY($1)`, [keys])).rows.map((x) => [x.client_key, x]));
  const debts = new Map((await pool.query<{ client_key: string; amount: string; age: number | null }>(
    `SELECT client_key, sum(amount)::text AS amount, max(overdue_days) AS age FROM receivables WHERE client_key = ANY($1) GROUP BY client_key`, [keys])).rows.map((x) => [x.client_key, x]));
  // Вхідні платежі клієнтів: без Сейфу й карток («лише фінанси», `staff`), без видалених і комісій.
  const payments: BankIn[] = (await pool.query<{ booked_on: string; amount: string; purpose: string | null; payer: string | null }>(
    `SELECT to_char(t.booked_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS booked_on, t.amount::text, t.purpose, t.counterparty_name AS payer
       FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
      WHERE t.direction = 'in' AND NOT t.is_bank_fee AND NOT a.finance_only AND a.company <> 'staff' AND t.deleted_at IS NULL
        AND t.booked_at >= now() - ($1 || ' days')::interval`, [PAY_LOOKBACK_DAYS])).rows
    .map((x) => ({ bookedOn: x.booked_on, amount: Number(x.amount), purpose: x.purpose ?? "", payer: x.payer ?? "" }));

  // Картки сусідніх запитів (для правила дубля) — одним запитом до Kommo; у базі карток немає навмисно.
  const sibIds = sib.map((s) => Number(s.kommo_id)).filter((id) => !reqs.some((r) => r.id === id));
  const sibCard = new Map<number, string | null>(reqs.map((r) => [r.id, r.card]));
  if (sibIds.length) for (const d of await once(() => fetchLeadsByIds(sibIds.slice(0, 250)))) sibCard.set(d.id, cf(d, REQ_FIELDS.card));
  const bankByDeal = new Map([...mains.values()].map((m) => [m.id, findBankPayment(m, payments)]));
  const receiptByDeal = new Map<number, boolean>();
  for (const m of mains.values()) if (!m.paid1c && !bankByDeal.get(m.id)) receiptByDeal.set(m.id, await once(() => hasReceipt(m.id)).catch(() => false));

  const out = new Map<number, PayContext>();
  for (const r of reqs) {
    const mid = r.sourceDealId ?? -1;
    const others = sib.filter((s) => Number(s.source_deal_id) === mid && Number(s.kommo_id) !== r.id);
    const dupOf = dupsOf(r, others.map((s) => ({ id: Number(s.kommo_id), amount: s.amount == null ? null : Number(s.amount), status: Number(s.status_id), card: sibCard.get(Number(s.kommo_id)) ?? null })));
    // «Уже оплачено» — лише ІНШІ запити, закриті «Оплачено» РАНІШЕ за цей (інакше два сьогоднішні рахували б один одного).
    const paidBefore = others.filter((s) => Number(s.status_id) === 142 && Number(s.kommo_id) < r.id).reduce((a, s) => a + Number(s.amount ?? 0), 0);
    const ck = clientKey.get(mid)?.key ?? null;
    const lim = ck ? limits.get(ck) : undefined, dbt = ck ? debts.get(ck) : undefined;
    out.set(r.id, {
      dupOf, paidBefore, bankSeen: bankByDeal.get(mid) ?? null, receipt: receiptByDeal.get(mid) ?? false,
      limit: lim ? { days: lim.limit_days, amount: lim.limit_amount == null ? null : Number(lim.limit_amount) } : null,
      debt: dbt ? { amount: Number(dbt.amount), ageDays: dbt.age } : null,
      ttnExempt: /бесп.?ятчук/i.test(clientKey.get(mid)?.mgr ?? ""),
    });
  }
  return out;
}

/** Один прогін. `write=false` — лише порахувати (сухий прогін для звірки, без таблиці й без стану). `day` — звірка заднім числом. */
export async function buildOnce(write = true, day?: string): Promise<RunResult> {
  const now = new Date();
  const win = payWindow(now, day);
  const reqs = (await once(() => fetchQueue(win))).map(toRequest);
  const ids = [...new Set(reqs.map((r) => r.sourceDealId).filter((x): x is number => x != null))];
  const info = new Map((await pool.query<{ kommo_id: string; client_key: string | null; client_name: string | null; mgr: string | null }>(
    `SELECT d.kommo_id::text, d.client_key, d.client_name, m.name AS mgr FROM deals d LEFT JOIN managers m ON m.id = d.manager_id WHERE d.kommo_id = ANY($1::bigint[])`,
    [ids])).rows.map((x) => [Number(x.kommo_id), x]));
  const mains = new Map((ids.length ? await once(() => fetchLeadsByIds(ids)) : []).map((d) => [d.id, toMain(d, info.get(d.id)?.client_name ?? null)]));
  const ctx = await contexts(reqs, mains, new Map([...info].map(([k, v]) => [k, { key: v.client_key, mgr: v.mgr }])));
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
        [`Файл на ${win.day} · сформовано ${at} · запитів ${reqs.length}: до оплати ${pay.length} на ${total}, перевірити ${check.length}. Запити в CRM не закриваються (паралельний тиждень).`],
        ["ID угоди", "Запит", "Сума", "Причина", "Примітка"], ...check]);
      sheet = "записано";
    }
    await pool.query(`INSERT INTO payment_file_state (id, at, queue, ok, check_count, total, rows, sheet) VALUES (1, now(), $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET at = now(), queue = $1, ok = $2, check_count = $3, total = $4, rows = $5, sheet = $6`,
      [reqs.length, pay.length, check.length, total, JSON.stringify(rows), sheet]);
    // 📒 Журнал по днях: рішення кожного запиту файлу цього дня — для звірки з файлом Тетяни за будь-який день.
    for (const x of rows)
      await pool.query(`INSERT INTO payment_file_log (day, request_id, main_id, amount, ok, paid_by, reasons, notes, first_at, last_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
        ON CONFLICT (day, request_id) DO UPDATE SET main_id = $3, amount = $4, ok = $5, paid_by = $6, reasons = $7, notes = $8, last_at = now()`,
        [win.day, x.id, x.mainId, x.amount, x.ok, x.paidBy, JSON.stringify(x.reasons), JSON.stringify(x.notes)]);
  }
  return { at, day: win.day, queue: reqs.length, ok: pay.length, check: check.length, total, rows, sheet };
}

/** Для крона: пропуск — пропуск (`jobSkip`), обсяг — у підсумку. Порожня черга — успіх із нулем (буває ввечері). */
export async function buildPaymentFile(): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("Файл на оплату: попередній прогін ще йде");
  running = Date.now();
  try { const r = await buildOnce(true); return { day: r.day, queue: r.queue, ok: r.ok, check: r.check, total: r.total, sheet: r.sheet }; }
  finally { running = null; }
}

// Сухий прогін руками на сервері: `node dist/jobs/buildPaymentFile.js --dry [--day=YYYY-MM-DD]` — без таблиці, без стану, без номерів карток.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes("--dry");
  const day = process.argv.find((a) => a.startsWith("--day="))?.slice(6);
  buildOnce(!dry, day).then((r) => {
    console.log(`файл на ${r.day}: запитів ${r.queue}, до оплати ${r.ok} на ${r.total}, перевірити ${r.check} · ${r.sheet}`);
    for (const x of r.rows) console.log(`${x.ok ? "✅" : "⚠️ "} угода #${x.mainId} запит #${x.id} ${x.amount ?? "—"} ₴ · ${x.paidBy ?? "—"} · ${[...x.reasons, ...x.notes].join("; ")}`);
  }).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
