import type {
  ReceivableAging, ReceivableCarrierPaid, ReceivableCarrierReason, ReceivableClient,
  ReceivableClientFacts, ReceivableEntity, ReceivableEntityReason, ReceivableTally,
} from "../../api";

/**
 * 🏷 ПІДПИСИ Й ФІЛЬТРИ ЕКРАНА ДЕБІТОРКИ — чисті функції, окремо від верстки.
 *
 * 🔴 Кожен «невідомо» тут МУСИТЬ мати власний підпис. Заміряно 24.08.2026:
 * невідомих юросіб три різні причини — 1С (14 рах. / 1 589 000 ₴), незаповнена
 * форма оплати (7 / 124 300 ₴) і битий лінк (1 / 4 700 ₴). Звести їх в одне
 * «—» означало б послати трьох різних людей робити три різні дії за однією
 * порожньою клітинкою.
 */

export const ENTITY_LABEL: Record<ReceivableEntity, string> = {
  uts: "ЮТС", avtomuv: "Автомув", fop: "ФОП", unknown: "невідомо",
};

export const ENTITY_REASON_LABEL: Record<ReceivableEntityReason, string> = {
  one_c: "виставлено через 1С",
  no_payment_type: "форма оплати не вказана",
  broken_link: "лінк не веде на угоду",
};

export const CARRIER_LABEL: Record<ReceivableCarrierPaid, string> = {
  paid: "перевізник оплачений", unpaid: "ще не оплачено", na: "н/д",
};

export const CARRIER_REASON_LABEL: Record<ReceivableCarrierReason, string> = {
  one_c: "виставлено через 1С",
  broken_link: "лінк не веде на угоду",
  out_of_map: "воронка поза мапою етапів",
};

export const AGING_ORDER: ReceivableAging[] = ["0-30", "31-60", "61-90", "90+"];
export const AGING_LABEL: Record<ReceivableAging, string> = {
  "0-30": "до 30 днів", "31-60": "31–60", "61-90": "61–90", "90+": "понад 90",
};

export const t = (x: ReceivableTally | undefined): ReceivableTally => x ?? { n: 0, amount: 0 };

// ───────────────────────────── ФІЛЬТРИ ─────────────────────────────

export type Tab = "all" | "overdue" | "aged";

export interface Filters {
  tab: Tab;
  entity: ReceivableEntity | "";
  carrier: ReceivableCarrierPaid | "";
  aging: ReceivableAging | "";
}

export const EMPTY_FILTERS: Filters = { tab: "all", entity: "", carrier: "", aging: "" };

/** Прострочка понад узгоджений ліміт — той самий вираз, що й досі малює червоне. */
export const isOverdue = (c: { overdueDays: number | null; limitDays: number | null }) =>
  c.overdueDays != null && c.limitDays != null && c.overdueDays > c.limitDays;

/**
 * Чи лишається клієнт у списку під фільтрами.
 *
 * 🔴 «Має ХОЧА Б ОДИН рахунок у цьому зрізі», а не «весь клієнт такий». У ПВК
 * АРСЕНАЛ 11 рахунків із 40 виставлені через 1С — тобто клієнти БУВАЮТЬ
 * змішані, і фільтр «юрособа = ЮТС» мусить показувати такого клієнта, а не
 * ховати його через ті 11. Ховання тут читалось би як «клієнта немає».
 *
 * 🔴 Фільтра «джерело = 1С» тут НЕМАЄ і бути не має (рішення власника
 * 24.08.2026): 1С — це ЯРЛИК на рядку, а не окремий зріз екрана.
 */
export function passesFilters(c: ReceivableClient & { facts: ReceivableClientFacts | null }, f: Filters): boolean {
  if (f.tab === "overdue" && !isOverdue(c)) return false;
  if (f.tab === "aged" && t(c.facts?.aging["90+"]).n === 0) return false;
  if (f.entity && t(c.facts?.entity[f.entity]).n === 0) return false;
  if (f.carrier && t(c.facts?.carrier[f.carrier]).n === 0) return false;
  if (f.aging && t(c.facts?.aging[f.aging]).n === 0) return false;
  return true;
}

export const hasActiveFilters = (f: Filters) =>
  f.tab !== "all" || f.entity !== "" || f.carrier !== "" || f.aging !== "";

// ───────────────────────────── ЯРЛИКИ РЯДКА ─────────────────────────────

export interface RowBadge { icon: string; text: string; hint: string; tone: "warn" | "muted" }

/**
 * Ярлики походження рахунків клієнта.
 *
 * 🔴 ЧОМУ З ЧИСЛОМ, А НЕ ПРОСТО ЯРЛИК. Клієнт буває ЗМІШАНИЙ: у ПВК АРСЕНАЛ
 * 11 із 40 рахунків через 1С, решта 29 — звичайні угоди Kommo. Ярлик без числа
 * стверджував би, що весь клієнт такий, — і це була б неправда рівно про той
 * випадок, заради якого категорію й заводили.
 */
export function originBadges(f: ReceivableClientFacts | null): RowBadge[] {
  if (!f) return [];
  const out: RowBadge[] = [];
  const oneC = t(f.link.one_c);
  if (oneC.n > 0) out.push({
    icon: "🧾", tone: "muted",
    text: oneC.n === f.invoices ? "виставлено через 1С" : `1С · ${oneC.n} із ${f.invoices}`,
    hint: `Рахунки виставлені напряму в 1С, повз CRM — угоди в Kommo для них немає за задумом. ${oneC.n} рах.`,
  });
  const broken = t(f.link.broken_link);
  if (broken.n > 0) out.push({
    icon: "⚠️", tone: "warn",
    text: broken.n === f.invoices ? "лінк не веде на угоду" : `битий лінк · ${broken.n} із ${f.invoices}`,
    hint: "№ угоди в рахунку є, але такої угоди в CRM немає: або одруківка в 1С, або угоду видалили. Це НЕ те саме, що «виставлено через 1С».",
  });
  return out;
}

/** Домінантна юрособа + чи їх кілька (клієнта могли обʼєднати). */
export function entitySummary(f: ReceivableClientFacts | null): { label: string; hint: string; mixed: boolean } | null {
  if (!f) return null;
  const rows = (Object.keys(ENTITY_LABEL) as ReceivableEntity[])
    .map((k) => ({ k, ...t(f.entity[k]) })).filter((x) => x.n > 0)
    .sort((a, b) => b.amount - a.amount);
  if (rows.length === 0) return null;
  const top = rows[0];
  const hint = rows.map((r) => `${ENTITY_LABEL[r.k]}: ${r.n} рах.`).join(" · ")
    + (f.entityReasons.length ? ` · невідомо тому, що ${f.entityReasons.map((r) => ENTITY_REASON_LABEL[r]).join(", ")}` : "");
  return { label: ENTITY_LABEL[top.k], hint, mixed: rows.length > 1 };
}
