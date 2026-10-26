/**
 * 💱 НЕОПЛАЧЕНІ РАХУНКИ З 1С — сервіс `unpaid-invoices` (1С, 25.10.2026; задача #5297) — чистий модуль. Звідси з 26.10.2026
 * рахується «Валютна дебіторка» замість рахунку 362: 362 бачить лише рахунки з ПРОВЕДЕНОЮ реалізацією, а свіжі валютні
 * рахунки АвтоМув її ще не мають (заміряно 26.10: 7 валютних рахунків 2026 року, 6 073 EUR, 6 з них без реалізації — у
 * нотатках Тетяни за жовтень 6 060 EUR; 362 віддавав застиглі 247 007 ₴ з 05.10).
 * 📌 РІШЕННЯ Романа 26.10.2026: «роби лише 2026 рік і щоб можна було глянути, що там не так». Без межі сервіс віддає
 * висячі рахунки з 2021-го (EUR: 37 рахунків на 122 182, з них ~116 тис. — 2022–2025), тож межа — і в запиті, і тут.
 */
export const UNPAID_FROM = "2026-01-01";

export interface UnpaidInvoice {
  uid: string; number: string; date: string; organization: string; contractor: string; edrpou: string | null; currency: string;
  invoiceSum: number; paidSum: number; remaining: number; realized: boolean; partiallyPaid: boolean;
  debtAccount: string | null; dueDate: string | null; manager: string | null; dealId: number | null; comment: string | null;
}

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const s = (v: unknown) => { const t = String(v ?? "").trim(); return t ? t : null; };

/**
 * Відповідь сервісу → рахунки 2026 року із залишком > 0. `state: false` (кривий параметр) чи немає масиву — помилка, а не
 * «боргів немає»: порожньо через збій і порожньо, бо все оплачено, на екрані мусять відрізнятись.
 */
export function parseUnpaid(json: unknown, from = UNPAID_FROM): UnpaidInvoice[] {
  const j = json as { state?: unknown; message?: unknown; invoices?: unknown };
  if (!j || j.state !== true) throw new Error(`1С, неоплачені рахунки: ${String(j?.message ?? "сервіс відповів без state: true")}`);
  if (!Array.isArray(j.invoices)) throw new Error("1С, неоплачені рахунки: у відповіді немає списку рахунків");
  const out: UnpaidInvoice[] = [];
  for (const x of j.invoices as Record<string, unknown>[]) {
    const date = String(x.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || !(n(x.remaining) > 0)) continue;
    const deal = String(x.id_amo ?? "").trim();
    out.push({ uid: String(x.uid ?? ""), number: String(x.number ?? "").trim(), date, organization: String(x.organization ?? "").trim(),
      contractor: String(x.contractor ?? "").trim(), edrpou: s(x.edrpou), currency: String(x.currency ?? "UAH").trim().toUpperCase(),
      invoiceSum: n(x.invoice_sum), paidSum: n(x.paid_sum), remaining: n(x.remaining), realized: x.realization_status === "realized",
      partiallyPaid: x.payment_status === "partially_paid", debtAccount: s(x.debt_account), dueDate: s(x.due_date)?.slice(0, 10) ?? null,
      manager: s(x.manager), dealId: /^\d{8}$/.test(deal) ? Number(deal) : null, comment: s(x.comment) });
  }
  return out;
}

/**
 * Підсумок валютної дебіторки (лише не-гривневі рахунки): у валюті — USD / EUR; гривневий еквівалент — за курсом НБУ.
 * Курсу немає — валюта лишається у своєму числі, а рахунки рахуються в `zeroUah` («є борг у валюті без ₴»), не нулем.
 */
export function unpaidFxTotals(rows: readonly UnpaidInvoice[], nbu: { USD?: number; EUR?: number }): {
  rows: number; totalUah: number; totalVal: number; zeroUah: number; usd: number; eur: number; unknownVal: number;
} {
  const c = (v: number) => Math.round(v * 100);
  let uah = 0, usd = 0, eur = 0, unk = 0, zero = 0, cnt = 0;
  for (const r of rows) {
    if (r.currency === "UAH") continue;
    cnt++;
    if (r.currency === "USD") usd += c(r.remaining); else if (r.currency === "EUR") eur += c(r.remaining); else unk += c(r.remaining);
    const rate = r.currency === "USD" ? nbu.USD : r.currency === "EUR" ? nbu.EUR : undefined;
    if (rate) uah += Math.round(c(r.remaining) * rate); else zero++;
  }
  return { rows: cnt, totalUah: uah / 100, totalVal: (usd + eur + unk) / 100, zeroUah: zero, usd: usd / 100, eur: eur / 100, unknownVal: unk / 100 };
}
