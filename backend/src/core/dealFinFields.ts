/**
 * 💾 ФІНАНСОВІ ПОЛЯ УГОДИ З KOMMO — У БАЗІ, А НЕ НАЖИВО (задача #5583, 26.10.2026). Чистий модуль: як з полів угоди
 * Kommo вийти на те, що потрібно «Результату місяця» («Номер заказа», «Оплачено из 1с», «Приход 1–5», готівковий розхід,
 * приходи й розходи за типом оплати), і як рядок `deal_fin_fields` стає тими самими полями.
 * 📐 Чому: відкриття вересня займало 55 с, з них 54 с — запити до Kommo за полями 1 012 угод (пачка 250 ID — 10–14 с
 * на боці Kommo, і без контактів теж). Синк `syncDealFinance` тримає поля в базі (інкремент кожні 30 хв — кілька угод),
 * тож екран рахується з бази.
 */
import { MAIN_FIELDS, orderNoOf, cashExpenseOf } from "./paymentRun.js";
import { FM_INCOME_FIELDS } from "./fmSums.js";
import { kommoFlows, type Flows } from "./dealLedger.js";

export interface DealFin { orderNo: string | null; paid1c: boolean; income: number | null; cashExpense: number | null; flows: Flows & { untyped: number } }

const num = (s: string | null | undefined) => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[\s  ]/g, "").replace(",", "."));
  return String(s).trim() !== "" && Number.isFinite(n) ? n : null;
};

/** Поля угоди з `get(fieldId)` (значення Kommo як рядок; порожнє — `null`). Саме те, що раніше рахувалось наживо. */
export function finFieldsOf(get: (fieldId: number) => string | null | undefined): DealFin {
  const inc = FM_INCOME_FIELDS.map((f) => num(get(f))).filter((x): x is number => x != null);
  return {
    orderNo: orderNoOf(get(MAIN_FIELDS.orderNo)),
    paid1c: get(MAIN_FIELDS.paid1c) === "true",
    income: inc.length ? Math.round(inc.reduce((a, x) => a + x, 0) * 100) / 100 : null,
    cashExpense: cashExpenseOf(get),
    flows: kommoFlows(get),
  };
}

/** Рядок `deal_fin_fields` → ті самі поля (числа з Postgres приходять рядками). */
export function finFromRow(r: Record<string, unknown>): DealFin {
  const n = (k: string) => Number(r[k] ?? 0);
  const o = (k: string) => (r[k] == null ? null : Number(r[k]));
  return {
    orderNo: (r.order_no as string | null) ?? null, paid1c: !!r.paid1c, income: o("income"), cashExpense: o("cash_expense"),
    flows: { in: { vat: n("in_vat"), novat: n("in_novat"), cash: n("in_cash") }, out: { vat: n("out_vat"), novat: n("out_novat"), unload: n("out_unload"), cash: n("out_cash") }, untyped: n("untyped") },
  };
}

/** Колонки `deal_fin_fields` у порядку `unnest` запису (і значення з `DealFin`). */
export const FIN_COLS = ["kommo_id", "order_no", "paid1c", "income", "cash_expense", "in_vat", "in_novat", "in_cash", "out_vat", "out_novat", "out_unload", "out_cash", "untyped", "kommo_updated_at"] as const;
export function finRow(id: number, updatedAt: Date | null, f: DealFin): unknown[] {
  return [id, f.orderNo, f.paid1c, f.income, f.cashExpense, f.flows.in.vat, f.flows.in.novat, f.flows.in.cash,
    f.flows.out.vat, f.flows.out.novat, f.flows.out.unload, f.flows.out.cash, f.flows.untyped, updatedAt];
}
