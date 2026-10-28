/**
 * 💱 ВАЛЮТНА ДЕБІТОРКА В РОЗДІЛІ «ДЕБІТОРКА» (задача 7136; Сергій на TOP Weekly 26.10.2026 — «виведи цю дебіторку окремо в
 * лист дебіторки»; Роман 28.10.2026 — «роби як пропонуєш»).
 *
 * Джерело — ТЕ САМЕ, що рядок «Валютна дебіторка» у «Фінансах»: неоплачені рахунки 1С з 2026 року не в гривні
 * (`onec_unpaid_invoices`, синк `syncUnpaidInvoices`). Тож суми тут і там розійтись не можуть: інший підсумок — інший
 * перелік рахунків, а не інша формула. Гривня — лише довідково, за курсом НБУ, з яким синк рахував підсумок; до загальної
 * гривневої дебіторки НЕ додається (рішення Романа 28.10: «окремо», як просив Сергій).
 *
 * Хто що бачить — той самий скоуп, що в усій вкладці (`receivablesScope`): менеджер — свої, тімлід — команда, керівництво
 * й фінансист — усе. «Свій» рахунок — за угодою CRM (`deal_id` → `deals.manager_id`). Як і в гривневій дебіторці (рішення
 * власника 27.08.2026), скоуп вирішує, ЯКИХ КЛІЄНТІВ показати, а відкритий клієнт показує ВСІ свої валютні рахунки — інакше
 * рядок клієнта й розкриття розповідали б різне.
 */
import type { Db } from "./finance.js";

export interface FxRaw {
  number: string; date: string; organization: string; contractor: string; edrpou: string | null; currency: string;
  invoiceSum: number; paidSum: number; remaining: number; realized: boolean; partiallyPaid: boolean; dueDate: string | null;
  manager1c: string | null; dealId: number | null; managerId: number | null; managerName: string | null; teamId: number | null;
}
export interface FxInvoice {
  number: string; date: string; organization: string; currency: string; invoiceSum: number; paidSum: number; remaining: number;
  uah: number | null; days: number; realized: boolean; partiallyPaid: boolean; dueDate: string | null; manager: string | null; dealId: number | null;
}
export interface FxClient {
  key: string; name: string; edrpou: string | null; managers: string[]; organizations: string[]; days: number;
  remaining: Record<string, number>; uah: number | null; invoices: FxInvoice[];
}
export interface FxTotals { byCurrency: Record<string, number>; uah: number; uahMissing: number; invoices: number; notRealized: number; clients: number }
export interface FxScope { managerId: number | null; teamId: number | null }

const P = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const cents = (v: number) => Math.round(v * 100) / 100;

/** Рахунок «мій» у скоупі: обидві умови скоупу — через І (тімлід звужується до свого менеджера, а не розширюється). */
export function inScope(r: Pick<FxRaw, "managerId" | "teamId">, sc: FxScope): boolean {
  return (sc.managerId == null || r.managerId === sc.managerId) && (sc.teamId == null || r.teamId === sc.teamId);
}

/**
 * Клієнти й підсумок. Клієнт — за ЄДРПОУ (немає — за назвою контрагента 1С); видно, якщо хоч один його рахунок у скоупі,
 * і тоді — з усіма рахунками. Днів — від дати рахунку; клієнт сортується за найдовшим. Гривня — за курсом синку; курсу
 * немає — `null` і лічильник `uahMissing`, а не нуль (нуль читався б як «нічого не винні»).
 */
export function groupFx(rows: readonly FxRaw[], sc: FxScope, rates: Record<string, number | null>, today: string): { clients: FxClient[]; totals: FxTotals } {
  const byKey = new Map<string, FxRaw[]>();
  for (const r of rows) {
    const key = r.edrpou?.trim() ? `edrpou:${r.edrpou.trim()}` : `name:${r.contractor.trim().toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const clients: FxClient[] = [];
  for (const [key, list] of byKey) {
    if (!list.some((r) => inScope(r, sc))) continue;
    const invoices = list.map((r): FxInvoice => {
      const rate = rates[r.currency] ?? null;
      return { number: r.number, date: r.date, organization: r.organization, currency: r.currency, invoiceSum: r.invoiceSum, paidSum: r.paidSum,
        remaining: r.remaining, uah: rate ? Math.round(r.remaining * rate) : null, days: Math.max(0, Math.round((P(today) - P(r.date)) / 864e5)),
        realized: r.realized, partiallyPaid: r.partiallyPaid, dueDate: r.dueDate, manager: r.managerName ?? r.manager1c, dealId: r.dealId };
    }).sort((a, b) => b.days - a.days || (a.number < b.number ? -1 : 1));
    const remaining: Record<string, number> = {};
    for (const i of invoices) remaining[i.currency] = cents((remaining[i.currency] ?? 0) + i.remaining);
    clients.push({
      key, name: list[0].contractor, edrpou: list[0].edrpou, days: Math.max(...invoices.map((i) => i.days)), remaining,
      managers: [...new Set(invoices.map((i) => i.manager).filter((m): m is string => !!m))],
      organizations: [...new Set(invoices.map((i) => i.organization))],
      uah: invoices.some((i) => i.uah == null) ? null : invoices.reduce((a, i) => a + (i.uah ?? 0), 0),
      invoices,
    });
  }
  clients.sort((a, b) => b.days - a.days || a.name.localeCompare(b.name, "uk"));
  const all = clients.flatMap((c) => c.invoices);
  const byCurrency: Record<string, number> = {};
  for (const i of all) byCurrency[i.currency] = cents((byCurrency[i.currency] ?? 0) + i.remaining);
  return {
    clients,
    totals: { byCurrency, uah: all.reduce((a, i) => a + (i.uah ?? 0), 0), uahMissing: all.filter((i) => i.uah == null).length,
      invoices: all.length, notRealized: all.filter((i) => !i.realized).length, clients: clients.length },
  };
}

export interface ReceivablesFx { syncedAt: string | null; error: string | null; from: string; rates: Record<string, number | null>; clients: FxClient[]; totals: FxTotals }

export async function loadReceivablesFx(db: Db, sc: FxScope, today: string): Promise<ReceivablesFx> {
  const st = (await db.query(`SELECT synced_at, error, rate_eur::float8 AS eur, rate_usd::float8 AS usd FROM onec_unpaid_state WHERE id = 1`)).rows[0];
  const rows = (await db.query(`SELECT u.number, u.invoice_date::text AS date, u.organization, u.contractor, u.edrpou, u.currency,
      u.invoice_sum::float8 AS invoice_sum, u.paid_sum::float8 AS paid_sum, u.remaining::float8 AS remaining, u.realized, u.partially_paid,
      u.due_date::text AS due_date, u.manager AS manager_1c, u.deal_id::text AS deal_id, d.manager_id, m.name AS manager_name, m.team_id
    FROM onec_unpaid_invoices u LEFT JOIN deals d ON d.kommo_id = u.deal_id LEFT JOIN managers m ON m.id = d.manager_id
    WHERE u.currency <> 'UAH'`)).rows.map((x: Record<string, any>): FxRaw => ({
    number: x.number, date: x.date, organization: x.organization, contractor: x.contractor, edrpou: x.edrpou ?? null, currency: x.currency,
    invoiceSum: x.invoice_sum, paidSum: x.paid_sum, remaining: x.remaining, realized: !!x.realized, partiallyPaid: !!x.partially_paid, dueDate: x.due_date ?? null,
    manager1c: x.manager_1c ?? null, dealId: x.deal_id == null ? null : Number(x.deal_id), managerId: x.manager_id ?? null, managerName: x.manager_name ?? null, teamId: x.team_id ?? null,
  }));
  const rates = { EUR: st?.eur ?? null, USD: st?.usd ?? null };
  const g = groupFx(rows, sc, rates, today);
  return { syncedAt: st?.synced_at ? new Date(st.synced_at).toISOString() : null, error: st?.error ?? null, from: "2026-01-01", rates, clients: g.clients, totals: g.totals };
}
