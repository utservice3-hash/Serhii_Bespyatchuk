/**
 * 🏁 «Результат місяця» — живі дані для ядра (`core/monthResult.ts`): поля угод із Kommo («Номер заказа», «Оплачено из
 * 1с», приходи, готівкові розходи — у базі їх немає) і платежі клієнтів у «Виписці» (та сама `findBankPayment`, що в
 * розборі запитів на оплату). Кеш на 10 хв на місяць: Kommo — ~4 запити на 1 000 угод. Excel — у форматі аркуша Тетяни.
 * Лише читає Kommo.
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { fetchLeadsByIds, type KommoDeal } from "../kommo/client.js";
import { MAIN_FIELDS, orderNoOf, cashExpenseOf, findBankPayment, paymentsByOrderNo, type BankIn } from "../core/paymentRun.js";
import { FM_INCOME_FIELDS } from "../core/fmSums.js";
import { kommoFlows } from "../core/dealLedger.js";
import { loadMonthResult, type LiveFields, type MonthResult } from "../core/monthResult.js";
import { xlsxBook } from "../core/xlsx.js";
import type { Db } from "../core/finance.js";

const cf = (d: KommoDeal, id: number): string | null => {
  const v = d.custom_fields_values?.find((f) => f.field_id === id)?.values?.[0]?.value;
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};
const num = (s: string | null) => { const n = Number(String(s ?? "").replace(/[\s ]/g, "").replace(",", ".")); return s != null && Number.isFinite(n) ? n : null; };

async function live(ids: number[]): Promise<Map<number, LiveFields>> {
  const out = new Map<number, LiveFields>();
  for (let i = 0; i < ids.length; i += 250) {
    for (const d of await fetchLeadsByIds(ids.slice(i, i + 250))) {
      const inc = FM_INCOME_FIELDS.map((f) => num(cf(d, f))).filter((x): x is number => x != null);
      out.set(Number(d.id), { orderNo: orderNoOf(cf(d, MAIN_FIELDS.orderNo)), paid1c: cf(d, MAIN_FIELDS.paid1c) === "true",
        income: inc.length ? inc.reduce((a, x) => a + x, 0) : null, cashExpense: cashExpenseOf((f) => cf(d, f)), flows: kommoFlows((f) => cf(d, f)) });
    }
  }
  return out;
}

/** Платежі клієнтів у «Виписці» з початку місяця мінус 180 днів (оплата буває раніше закриття) — як у розборі оплат. */
async function bankPaid(month: string, deals: { id: number; orderNo: string | null; income: number | null; client: string | null }[]): Promise<Set<number>> {
  const payments: BankIn[] = (await pool.query<{ booked_on: string; amount: string; purpose: string | null; payer: string | null }>(
    `SELECT to_char(t.booked_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS booked_on, t.amount::text, t.purpose, t.counterparty_name AS payer
       FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
      WHERE t.direction = 'in' AND NOT t.is_bank_fee AND NOT a.finance_only AND a.company <> 'staff' AND t.deleted_at IS NULL
        AND t.booked_at >= $1::date - interval '180 days'`, [month])).rows
    .map((x) => ({ bookedOn: x.booked_on, amount: Number(x.amount), purpose: x.purpose ?? "", payer: x.payer ?? "" }));
  const idx = paymentsByOrderNo(payments);
  return new Set(deals.filter((d) => d.orderNo && findBankPayment({ orderNo: d.orderNo, income: d.income, clientName: d.client }, idx.get(d.orderNo) ?? [])).map((d) => d.id));
}

const cache = new Map<string, { at: number; data: MonthResult }>();
const CACHE_MS = 10 * 60_000;
export const dropMonthResultCache = (months?: string[]) => { if (!months) cache.clear(); else for (const m of months) cache.delete(m.slice(0, 7)); };

const inflight = new Map<string, Promise<MonthResult>>();
const ymOf = (monthArg: unknown) => {
  const kyiv = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
  return typeof monthArg === "string" && /^\d{4}-\d{2}/.test(monthArg) ? monthArg.slice(0, 7) : kyiv;
};
/** Розрахунок місяця з кешем і ОДНИМ розрахунком на місяць одночасно (другий запит чекає перший, а не рахує вдруге). */
export function monthResult(monthArg: unknown, refresh = false): Promise<MonthResult> {
  const ym = ymOf(monthArg);
  const hit = cache.get(ym);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
  const running = inflight.get(ym);
  if (running) return running;
  const p = loadMonthResult(pool as unknown as Db, `${ym}-01`, { live, bankPaid: (d) => bankPaid(`${ym}-01`, d), kommoBase: config.kommo.baseUrl })
    .then((data) => { cache.set(ym, { at: Date.now(), data }); return data; })
    .finally(() => inflight.delete(ym));
  inflight.set(ym, p);
  return p;
}
/**
 * Для HTTP: сервер обриває запит на 20 с (`REQ_TIMEOUT_MS`), а перший розрахунок місяця (поля ~1 000 угод з Kommo +
 * «Виписка») буває довшим. Тому чекаємо до `waitMs`; не встигли — `{ pending: true }`, розрахунок іде далі у фоні й
 * ляже в кеш, екран перепитує. Помилку фонового розрахунку не ковтаємо: наступний запит почне заново і поверне її.
 */
export async function monthResultOrPending(monthArg: unknown, refresh = false, waitMs = 15_000): Promise<MonthResult | { pending: true; month: string }> {
  const ym = ymOf(monthArg);
  const p = monthResult(ym, refresh);
  p.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); });
  try { return (await Promise.race([p, late])) ?? { pending: true, month: `${ym}-01` }; } finally { clearTimeout(timer); }
}
/** Прогрів після синку 1С: поточний і минулий місяць за Києвом перераховуються у фоні, щоб екран відкривався одразу. */
export function warmMonthResults(now = new Date()): void {
  const ym = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
  const d = new Date(`${ym}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  for (const m of [d.toISOString().slice(0, 7), ym]) monthResult(m, true).catch((e) => console.error(`warmMonthResults ${m}:`, (e as Error).message));
}

/** Колонки аркуша «Угоди» — у порядку вкладки «Сделки» Тетяни (те, що відтворюємо), далі наші: хто закривав, рішення. */
export const DEAL_HEAD = ["Сделка", "Дата создания", "Дата закрытия", "Дата акта", "ID відповідального",
  "Бюджет Коммо", "Прихід: Безнал с НДС", "Прихід: Безнал без НДС", "Прихід: Наличные", "Розхід: Безнал с НДС", "Розхід: Безнал без НДС", "Розхід: Оплата на выгрузке", "Розхід: Наличные",
  "Бюджет Коммо-1С", "Organization", "1С прихід: Безнал с НДС", "1С прихід: Безнал без НДС", "1С прихід: Наличные", "1С розхід: Безнал с НДС", "1С розхід: Безнал без НДС", "1С розхід: Оплата на выгрузке", "1С розхід: Наличные",
  "Оплати клієнтів з 1С: з ПДВ", "Оплати клієнтів з 1С: без ПДВ", "Оплати клієнтів з 1С: нал", "Плановий профіт PNL",
  "Клієнт", "Зараз відповідальний (id)", "У результаті", "Враховано", "Перевірити", "Рішення", "Примітка"] as const;
const dmy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric" }) : "");
const dmyD = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "-");
function dealRow(d: MonthResult["deals"][number]): (string | number | null)[] {
  const k = d.kommo, o = d.onec?.flows;
  return [d.id, dmy(d.createdAt), dmy(d.closedAt), dmyD(d.onec?.actOn ?? null), d.closer,
    d.price, k?.in.vat ?? null, k?.in.novat ?? null, k?.in.cash ?? null, k?.out.vat ?? null, k?.out.novat ?? null, k?.out.unload ?? null, k?.out.cash ?? null,
    d.onec?.budget ?? null, d.onec?.organization ?? "", o?.in.vat ?? null, o?.in.novat ?? null, o?.in.cash ?? null, o?.out.vat ?? null, o?.out.novat ?? null, o?.out.unload ?? null, o?.out.cash ?? null,
    d.paid?.vat ?? null, d.paid?.novat ?? null, d.paid?.cash ?? null, d.planPnl,
    d.client, d.current, d.included ? d.profit : null, d.included ? "так" : "ні", d.checks.join("; "),
    d.override ? (d.override.action === "exclude" ? "не рахувати" : d.override.action === "move" ? `в ${d.override.targetMonth}` : "свій профіт") : "", d.override?.note ?? ""];
}

/** Excel: «Результат» — колонки аркуша Тетяни (№, ПІБ, id менеджера, Кількість угод, Результат, Коментар, Угода) + усі угоди. */
export function monthResultXlsx(r: MonthResult): Buffer {
  const notes = (id: number | null) => r.deals.filter((d) => d.closer === id && d.override).map((d) => `${d.id} ${d.override!.action === "exclude" ? "не рахуємо" : d.override!.action === "move" ? `→ ${d.override!.targetMonth!.slice(5, 7)}.${d.override!.targetMonth!.slice(0, 4)}` : `профіт ${d.override!.profit}`} — ${d.override!.note}`).join("\n");
  const review = (id: number | null) => r.deals.filter((d) => d.closer === id && d.included && d.checks.length).map((d) => `${d.id}: ${d.checks.join("; ")}`).join("\n");
  return xlsxBook([
    { name: "Результат", rows: [["№", "ПІБ", "id менеджера", "Кількість угод", "Результат", "Коментар", "Угода", "На перевірці"],
      ...r.managers.map((m, i) => [i + 1, m.name, m.kommoUserId, m.deals, m.result, m.minus.n ? `мінусових ${m.minus.n} на ${m.minus.sum}` : "", notes(m.kommoUserId), review(m.kommoUserId)]),
      [null, "сума", null, r.totals.deals, r.totals.result, null, null, null]] },
    { name: "Угоди", rows: [[...DEAL_HEAD], ...r.deals.map(dealRow)] },
  ]);
}
