/**
 * 💱 ВАЛЮТНА ДЕБІТОРКА ВСЕРЕДИНІ ОСНОВНОЇ (Сергій 28.10.2026: «валютна ніяким чином не поєднується з функціоналом
 * основної»; Роман 28.10 — «роби як пропонуєш»).
 *
 * Неоплачені валютні рахунки 1С (`onec_unpaid_invoices`, той самий список, що й рядок «Валютна дебіторка» у «Фінансах»)
 * щосинку лягають у `receivable_invoices` поруч із гривневими. Ключ клієнта — той самий `normalizeClientName`, що в рахунків
 * 361, тож склейка юросіб, відповідальний, домовленість, ліміти, списання й «Проблемний клієнт» працюють на них тим самим
 * кодом, без другої гілки.
 *
 * 🔴 ГРИВНЕВА ДЕБІТОРКА НЕ ЗМІНЮЄТЬСЯ ЗА ПОБУДОВОЮ: у валютного рахунку `amount = 0`. Плитки, Звіт КВП, Огляд і журнал
 * «Дебіторка 1С» у «Фінансах» сумують `amount` — валюта туди не потрапляє, і вирішувати це в кожному читачі не треба
 * (рішення А: окремо, не додаючи). Валюта — у `amount_fx`, ≈ ₴ за курсом НБУ синку — у `amount_fx_uah`.
 *
 * Де валюта ПОТРІБНА в гривні (рішення Б — стеля ліміту в ₴ проти валютного боргу за НБУ; вибір відповідального за сумою) —
 * читач додає `FX_UAH_SQL`. Один вираз на всіх: два вирази для одного числа розходяться мовчки.
 */
import { normalizeClientName } from "../utils/clientName.js";
import { INVOICE_ALIVE_SQL } from "./receivablesAge.js";

/** Σ ≈ ₴ ЖИВИХ (не списаних) валютних рахунків клієнта рядка `alias` таблиці `receivables`. */
export const FX_UAH_SQL = (alias: string): string =>
  `(SELECT COALESCE(SUM(ri.amount_fx_uah), 0) FROM receivable_invoices ri
     WHERE ri.client_key = ${alias}.client_key AND ri.currency IS NOT NULL AND ${INVOICE_ALIVE_SQL})`;

/** Те саме у валюті: `{"EUR": 1400, "USD": 0}` — живі валютні рахунки клієнта. */
export const FX_BY_CURRENCY_SQL = (alias: string): string =>
  `(SELECT COALESCE(jsonb_object_agg(x.currency, x.s), '{}'::jsonb) FROM (
      SELECT ri.currency, SUM(ri.amount_fx) AS s FROM receivable_invoices ri
       WHERE ri.client_key = ${alias}.client_key AND ri.currency IS NOT NULL AND ${INVOICE_ALIVE_SQL}
       GROUP BY ri.currency) x)`;

export interface UnpaidFxSource {
  number: string; date: string; contractor: string; edrpou: string | null; currency: string; remaining: number;
  manager: string | null; dealId: number | null; comment: string | null;
}
export interface FxInvoiceRow {
  clientKey: string; clientName: string; invoiceNo: string; invoiceDate: string; currency: string; amountFx: number;
  amountFxUah: number | null; edrpou: string | null; dealId: number | null; managerHint: string; comment: string | null;
}

/**
 * Валютні рахунки → рядки `receivable_invoices`. Гривневі пропускаються (їх веде 361). Курсу немає — `amountFxUah = null`:
 * рахунок на екрані у валюті, а в лімітах не бере участі (нуль читався б як «не винні»). Без назви контрагента — пропуск,
 * бо без ключа рядок не прив'язався б ні до чого.
 */
export function fxInvoiceRows(rows: readonly UnpaidFxSource[], rates: Record<string, number | null | undefined>): FxInvoiceRow[] {
  const out: FxInvoiceRow[] = [];
  for (const r of rows) {
    if (r.currency === "UAH") continue;
    const clientKey = normalizeClientName(r.contractor);
    if (!clientKey) continue;
    const rate = rates[r.currency];
    out.push({
      clientKey, clientName: r.contractor.trim(), invoiceNo: r.number, invoiceDate: r.date, currency: r.currency,
      amountFx: Math.round(r.remaining * 100) / 100, amountFxUah: rate ? Math.round(r.remaining * rate * 100) / 100 : null,
      edrpou: r.edrpou, dealId: r.dealId, managerHint: r.manager ?? "", comment: r.comment,
    });
  }
  return out;
}
