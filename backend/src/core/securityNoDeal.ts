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

/**
 * 🔎 ФІЛЬТР ЕКРАНА (Роман 27.11.2026: «не вистачає фільтрів по датах… таку саму шапку, як і у звіті»; і того ж дня: «нам
 * потрібно просто, щоб в безпеці ми могли бачити рахунки, які не підкріплені до угоди, які міг виставити менеджер або
 * бухгалтерія… чому ми бачимо стільки грошей?»). Розклад списку з прода показав: з 46,3 млн ₴ оплат «без угоди» клієнтських
 * 3,7 млн, решта — організації «Облік сейфу» й «Підрядник», надходження без платника, нульові й тестові документи.
 * 🔴 РІШЕННЯ РОМАНА 27.11.2026 (картка, варіант «Лише клієнтські»): на вкладці лишаються ТІЛЬКИ клієнтські документи;
 * внутрішні, без платника, нульові й тестові з неї зникають зовсім. Тому екран завжди просить вид `client` (`SCREEN_SCOPE`),
 * і параметром запиту його розширити не можна. Фільтрів, якими керує людина, два: період і організація з документа 1С.
 * Дати — включно з обома кінцями (`date` тут уже календарна дата документа, без часу й поясу).
 *
 * 🔴 «КЛІЄНТСЬКИЙ» — ПРАВИЛО ПО ЧУЖОМУ ТЕКСТУ (назва організації, назва платника), тому разом із ним ЗАВЖДИ їде друге
 * число: скільки документів він НЕ визнав клієнтськими і чому (`reasons`). Самих документів екран не отримує, лише це
 * число під «?» — щоб нова внутрішня організація чи хвиля надходжень без платника не зникала мовчки.
 * Причина одна на документ, перша за порядком нижче, — інакше причини не сходились би в суму.
 * Чотири умови (є платник, організація не «Облік сейфу» і не «Підрядник», сума не нуль, платник не тестовий) стояли в
 * тексті картки, яку Роман підтвердив. Нова внутрішня організація — нове його рішення, а не рядок у переліку «бо схожа».
 */
export type NoDealScope = "client" | "other" | "all";
export type NoDealOtherReason = "test" | "zero" | "internal" | "unnamed";
export const NO_DEAL_REASONS: readonly NoDealOtherReason[] = ["test", "zero", "internal", "unnamed"];
/** Організації 1С, що ведуть внутрішній облік, а не продажі клієнтам. Назва порівнюється як є. */
export const INTERNAL_ORGS: readonly string[] = ["Облік сейфу", "Підрядник"];
/** Платник, якого заводять перевірки інтеграції з 1С. */
export const TEST_KONTRAGENT_RE = /^тест\s+інтеграція(?![а-яіїєґ])/i;
/** Чому документ НЕ клієнтський; `null` — клієнтський (є платник, організація не внутрішня, сума не нуль, платник не тестовий). */
export function nonClientReason(d: Pick<NoDealDoc, "kontragent" | "organization" | "sum">): NoDealOtherReason | null {
  if (TEST_KONTRAGENT_RE.test(d.kontragent.trim())) return "test";
  if (d.sum === 0) return "zero";
  if (INTERNAL_ORGS.includes(d.organization ?? "")) return "internal";
  if (d.kontragent.trim() === "") return "unnamed";
  return null;
}

export interface NoDealFilter { from: string | null; to: string | null; orgs: readonly string[] | null; scope: NoDealScope }
export const NO_FILTER: NoDealFilter = { from: null, to: null, orgs: null, scope: "all" };
/** Вид, який показує вкладка «Безпека» (рішення Романа 27.11.2026: лише клієнтські). */
export const SCREEN_SCOPE: NoDealScope = "client";
export interface NoDealCount { docs: number; uah: number }
export interface NoDealFacet extends NoDealCount { name: string }
/**
 * Список під фільтром. `totals` — із ТИХ САМИХ `docs` (плитка = Σ списку й під фільтром). Кожен перелік варіантів рахується
 * БЕЗ власного фільтра, інакше вибраний варіант прибирав би решту з екрана: `orgs` — без фільтра організації, `months` —
 * без періоду, `scopes` і `reasons` — без виду. Тому `scopes.client + scopes.other` = усі документи періоду й організації,
 * а Σ `reasons` = `scopes.other`. `all` — скільки документів у списку без жодного фільтра.
 */
export interface NoDealView extends NoDealBlock {
  orgs: NoDealFacet[]; months: ({ ym: string } & NoDealCount)[];
  scopes: Record<"client" | "other", NoDealCount>; reasons: ({ reason: NoDealOtherReason } & NoDealCount)[]; all: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Дата існує в календарі: «2026-02-30» рушій тихо перетворив би на 2 березня, і фільтр різав би не той день. */
const realDate = (v: string): boolean => {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};
/**
 * Розбір параметрів запиту екрана. Нерозбірлива дата — відмова словами, а не мовчазне «фільтр не застосовано».
 * Вид завжди `SCREEN_SCOPE`: із запиту він не читається взагалі, тож `?scope=all` не поверне на екран прибране.
 */
export function parseNoDealFilter(q: Record<string, unknown>): { filter: NoDealFilter } | { error: string } {
  const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")).trim();
  const from = one(q.from), to = one(q.to);
  for (const [k, v] of [["from", from], ["to", to]] as const)
    if (v && !realDate(v)) return { error: `${k}: дата у вигляді РРРР-ММ-ДД` };
  if (from && to && from > to) return { error: "from пізніше за to" };
  const orgs = (Array.isArray(q.org) ? q.org : q.org == null ? [] : [q.org]).map((x) => String(x)).filter((x) => x !== "");
  return { filter: { from: from || null, to: to || null, orgs: orgs.length ? orgs : null, scope: SCREEN_SCOPE } };
}

/** Чиста функція: усі документи списку + фільтр → те, що бачить екран. Назва організації порівнюється як є, порожня — "". */
export function noDealView(all: readonly NoDealDoc[], f: NoDealFilter): NoDealView {
  const inPeriod = (d: NoDealDoc) => (!f.from && !f.to) || (d.date != null && (!f.from || d.date >= f.from) && (!f.to || d.date <= f.to));
  const inOrg = (d: NoDealDoc) => !f.orgs?.length || f.orgs.includes(d.organization ?? "");
  const inScope = (d: NoDealDoc) => f.scope === "all" || (nonClientReason(d) == null) === (f.scope === "client");
  const facet = <K extends string>(rows: readonly NoDealDoc[], key: (d: NoDealDoc) => K | null) => {
    const m = new Map<K, NoDealCount>();
    for (const d of rows) {
      const k = key(d); if (k == null) continue;
      const g = m.get(k) ?? { docs: 0, uah: 0 };
      g.docs++; if (isUah(d.currency)) g.uah = r2(g.uah + d.sum);
      m.set(k, g);
    }
    return m;
  };
  const orgs = [...facet(all.filter((d) => inPeriod(d) && inScope(d)), (d) => d.organization ?? "")]
    .map(([name, g]) => ({ name, ...g })).sort((a, b) => b.uah - a.uah || b.docs - a.docs || a.name.localeCompare(b.name));
  const months = [...facet(all.filter((d) => inOrg(d) && inScope(d)), (d) => (d.date ? d.date.slice(0, 7) : null))]
    .map(([ym, g]) => ({ ym, ...g })).sort((a, b) => a.ym.localeCompare(b.ym));
  const noScope = all.filter((d) => inPeriod(d) && inOrg(d));
  const byScope = facet(noScope, (d) => (nonClientReason(d) == null ? "client" : "other"));
  const byReason = facet(noScope, (d) => nonClientReason(d));
  const zero: NoDealCount = { docs: 0, uah: 0 };
  const block = (docs: NoDealDoc[]): NoDealBlock => ({ totals: noDealTotals(docs), docs });
  return { ...block(noScope.filter(inScope)), orgs, months,
    scopes: { client: byScope.get("client") ?? zero, other: byScope.get("other") ?? zero },
    reasons: NO_DEAL_REASONS.filter((r) => byReason.has(r)).map((reason) => ({ reason, ...byReason.get(reason)! })), all: all.length };
}

export interface NoDealReport {
  from: string;
  /** Фільтр, з яким пораховано відповідь (після розбору) — екран показує саме його, а не те, що просив. */
  filter: NoDealFilter;
  /** Знімок реалізацій і оплат: коли записано, чому не записано, і скільки рядків без угоди лишилось ПОЗА екраном. */
  snapshot: { syncedAt: string | null; error: string | null; older: number | null; undated: number | null };
  /** Неоплачені рахунки пише інший синк (`syncUnpaidInvoices`) — свій час і своя помилка. */
  unpaidState: { syncedAt: string | null; error: string | null };
  lists: Record<NoDealList, NoDealView>;
}

export const NO_DEAL_ROWS_SQL = `SELECT kind, number, organization, COALESCE(kontragent, '') AS kontragent, edrpou, doc_on::text AS date, sum::float8 AS sum, currency,
    COALESCE(deal_raw, '') AS deal_raw, manager, comment
  FROM onec_no_deal_rows ORDER BY doc_on DESC, sum DESC`;
export const NO_DEAL_UNPAID_SQL = `SELECT number, organization, COALESCE(contractor, '') AS kontragent, edrpou, invoice_date::text AS date, remaining::float8 AS sum, currency,
    manager, comment
  FROM onec_unpaid_invoices WHERE deal_id IS NULL ORDER BY invoice_date DESC, remaining DESC`;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export async function loadNoDeal(db: Db, filter: NoDealFilter = NO_FILTER): Promise<NoDealReport> {
  const [rows, unpaid, st, ust] = await Promise.all([
    db.query<Record<string, any>>(NO_DEAL_ROWS_SQL),
    db.query<Record<string, any>>(NO_DEAL_UNPAID_SQL),
    db.query<Record<string, any>>(`SELECT synced_at, older, undated, error FROM onec_no_deal_state WHERE id = 1`),
    db.query<Record<string, any>>(`SELECT synced_at, error FROM onec_unpaid_state WHERE id = 1`),
  ]);
  const doc = (x: Record<string, any>, dealRaw: string | null): NoDealDoc => ({ number: x.number || null, organization: x.organization || null, kontragent: x.kontragent,
    edrpou: x.edrpou ?? null, date: x.date ?? null, sum: x.sum, currency: x.currency, dealRaw, manager: x.manager ?? null, comment: x.comment ?? null });
  const s = st.rows[0], u = ust.rows[0];
  return {
    from: NO_DEAL_FROM, filter,
    snapshot: { syncedAt: iso(s?.synced_at), error: s?.error ?? null, older: s?.older ?? null, undated: s?.undated ?? null },
    unpaidState: { syncedAt: iso(u?.synced_at), error: u?.error ?? null },
    lists: {
      invoice: noDealView(rows.rows.filter((x) => x.kind === "invoice").map((x) => doc(x, x.deal_raw)), filter),
      payment: noDealView(rows.rows.filter((x) => x.kind === "payment").map((x) => doc(x, x.deal_raw)), filter),
      unpaid: noDealView(unpaid.rows.map((x) => doc(x, null)), filter),
    },
  };
}
