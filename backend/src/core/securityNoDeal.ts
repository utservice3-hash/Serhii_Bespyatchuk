/**
 * 🛡 «БЕЗПЕКА» · ОПЕРАЦІЇ 1С БЕЗ УГОДИ (задача 11231; Роман 27.11.2026: «давай додамо вкладку безпека тільки для адмінів і
 * оп дира, де будемо це рахувати»).
 *
 * Три списки документів 1С, у яких не вказано угоду CRM, — тобто гроші, які не привʼязані до жодної угоди й тому не
 * беруть участі в жодному звіті:
 *  · реалізації (`costinvoice`) і оплати клієнтів (`paydata`) — зі знімка `onec_no_deal_rows` (пише `syncOnecDeals`);
 *  · неоплачені рахунки — з `onec_unpaid_invoices`, де `deal_id IS NULL` (та сама таблиця, що живить «Валютну дебіторку»).
 *
 * 🔴 ПІДСУМОК ПЛИТКИ РАХУЄТЬСЯ З ТИХ САМИХ РЯДКІВ, ЩО ЙДУТЬ У СПИСОК, одним викликом (`noDealTotals`): другого запиту
 * «порахуй суму» немає, тож плитка й список не можуть розійтись (правило 18 кореня: інваріант одним викликом).
 * 🔴 ВАЛЮТА — ОКРЕМО. Євро під підписом «₴» було б вигаданим числом (те саме рішення, що в «Результаті місяця»).
 * Документ у валюті входить у кількість документів і у свій рядок валюти, але НЕ в гривневу суму.
 * Метрик тут немає: це перелік документів на розбір, у звіти він не входить і нічого в них не змінює.
 */
import type { Db } from "./finance.js";
import { isUah } from "./dealLedger.js";
import { NO_DEAL_FROM } from "./onecSync.js";

export type NoDealList = "invoice" | "payment" | "unpaid";
export interface NoDealDoc {
  number: string | null; organization: string | null; kontragent: string; edrpou: string | null; date: string | null; sum: number; currency: string;
  /** Що стоїть у полі «угода» в 1С: рядок (порожній — «порожньо») або `null`, коли джерело цього поля не зберігає. */
  dealRaw: string | null; manager: string | null; comment: string | null;
}
export interface NoDealTotals {
  docs: number; uah: number; fx: { currency: string; sum: number; docs: number }[];
  /** Скільки РІЗНИХ названих контрагентів; документи без назви — окремо в `unnamed`. */
  kontragents: number; unnamed: { docs: number; uah: number };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Підсумок списку: гривня окремо від валюти, документи без назви контрагента — окремим числом. */
export function noDealTotals(rows: readonly Pick<NoDealDoc, "kontragent" | "sum" | "currency">[]): NoDealTotals {
  const fx = new Map<string, { sum: number; docs: number }>();
  const names = new Set<string>();
  let uah = 0, unnamedDocs = 0, unnamedUah = 0;
  for (const r of rows) {
    const named = r.kontragent.trim() !== "";
    if (named) names.add(r.kontragent.trim()); else unnamedDocs++;
    if (!isUah(r.currency)) {
      const f = fx.get(r.currency) ?? { sum: 0, docs: 0 };
      fx.set(r.currency, { sum: r2(f.sum + r.sum), docs: f.docs + 1 });
      continue;
    }
    uah = r2(uah + r.sum);
    if (!named) unnamedUah = r2(unnamedUah + r.sum);
  }
  return { docs: rows.length, uah, fx: [...fx].map(([currency, f]) => ({ currency, ...f })).sort((a, b) => a.currency.localeCompare(b.currency)),
    kontragents: names.size, unnamed: { docs: unnamedDocs, uah: unnamedUah } };
}

export interface NoDealBlock { totals: NoDealTotals; docs: NoDealDoc[] }
export interface NoDealReport {
  from: string;
  /** Знімок реалізацій і оплат: коли записано, чому не записано, і скільки рядків без угоди лишилось ПОЗА екраном. */
  snapshot: { syncedAt: string | null; error: string | null; older: number | null; undated: number | null };
  /** Неоплачені рахунки пише інший синк (`syncUnpaidInvoices`) — свій час і своя помилка. */
  unpaidState: { syncedAt: string | null; error: string | null };
  lists: Record<NoDealList, NoDealBlock>;
}

export const NO_DEAL_ROWS_SQL = `SELECT kind, number, organization, COALESCE(kontragent, '') AS kontragent, edrpou, doc_on::text AS date, sum::float8 AS sum, currency,
    COALESCE(deal_raw, '') AS deal_raw, manager, comment
  FROM onec_no_deal_rows ORDER BY doc_on DESC, sum DESC`;
export const NO_DEAL_UNPAID_SQL = `SELECT number, organization, COALESCE(contractor, '') AS kontragent, edrpou, invoice_date::text AS date, remaining::float8 AS sum, currency,
    manager, comment
  FROM onec_unpaid_invoices WHERE deal_id IS NULL ORDER BY invoice_date DESC, remaining DESC`;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export async function loadNoDeal(db: Db): Promise<NoDealReport> {
  const [rows, unpaid, st, ust] = await Promise.all([
    db.query<Record<string, any>>(NO_DEAL_ROWS_SQL),
    db.query<Record<string, any>>(NO_DEAL_UNPAID_SQL),
    db.query<Record<string, any>>(`SELECT synced_at, older, undated, error FROM onec_no_deal_state WHERE id = 1`),
    db.query<Record<string, any>>(`SELECT synced_at, error FROM onec_unpaid_state WHERE id = 1`),
  ]);
  const doc = (x: Record<string, any>, dealRaw: string | null): NoDealDoc => ({ number: x.number || null, organization: x.organization || null, kontragent: x.kontragent,
    edrpou: x.edrpou ?? null, date: x.date ?? null, sum: x.sum, currency: x.currency, dealRaw, manager: x.manager ?? null, comment: x.comment ?? null });
  const block = (docs: NoDealDoc[]): NoDealBlock => ({ totals: noDealTotals(docs), docs });
  const s = st.rows[0], u = ust.rows[0];
  return {
    from: NO_DEAL_FROM,
    snapshot: { syncedAt: iso(s?.synced_at), error: s?.error ?? null, older: s?.older ?? null, undated: s?.undated ?? null },
    unpaidState: { syncedAt: iso(u?.synced_at), error: u?.error ?? null },
    lists: {
      invoice: block(rows.rows.filter((x) => x.kind === "invoice").map((x) => doc(x, x.deal_raw))),
      payment: block(rows.rows.filter((x) => x.kind === "payment").map((x) => doc(x, x.deal_raw))),
      unpaid: block(unpaid.rows.map((x) => doc(x, null))),
    },
  };
}
