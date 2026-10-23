/**
 * 🏁 «Результат місяця» — живі дані для ядра (`core/monthResult.ts`): поля угод із Kommo («Номер заказа», «Оплачено из
 * 1с», приходи, готівкові розходи — у базі їх немає) і платежі клієнтів у «Виписці» (та сама `findBankPayment`, що в
 * розборі запитів на оплату). Кеш на 10 хв на місяць: Kommo — ~4 запити на 1 000 угод. Excel — у форматі аркуша Тетяни.
 * Лише читає Kommo.
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { fetchLeadsByIds, type KommoDeal } from "../kommo/client.js";
import { MAIN_FIELDS, orderNoOf, cashExpenseOf, findBankPayment, type BankIn } from "../core/paymentRun.js";
import { FM_INCOME_FIELDS } from "../core/fmSums.js";
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
        income: inc.length ? inc.reduce((a, x) => a + x, 0) : null, cashExpense: cashExpenseOf((f) => cf(d, f)) });
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
  return new Set(deals.filter((d) => findBankPayment({ orderNo: d.orderNo, income: d.income, clientName: d.client }, payments)).map((d) => d.id));
}

const cache = new Map<string, { at: number; data: MonthResult }>();
const CACHE_MS = 10 * 60_000;
export const dropMonthResultCache = (months?: string[]) => { if (!months) cache.clear(); else for (const m of months) cache.delete(m.slice(0, 7)); };

export async function monthResult(monthArg: unknown, refresh = false): Promise<MonthResult> {
  const kyiv = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
  const ym = typeof monthArg === "string" && /^\d{4}-\d{2}/.test(monthArg) ? monthArg.slice(0, 7) : kyiv;
  const hit = cache.get(ym);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await loadMonthResult(pool as unknown as Db, `${ym}-01`, { live, bankPaid: (d) => bankPaid(`${ym}-01`, d), kommoBase: config.kommo.baseUrl });
  cache.set(ym, { at: Date.now(), data });
  return data;
}

/** Excel: «Результат» — колонки аркуша Тетяни (№, ПІБ, id менеджера, Кількість угод, Результат, Коментар, Угода) + усі угоди. */
export function monthResultXlsx(r: MonthResult): Buffer {
  const notes = (id: number | null) => r.deals.filter((d) => d.closer === id && d.override).map((d) => `${d.id} ${d.override!.action === "exclude" ? "не рахуємо" : d.override!.action === "move" ? `→ ${d.override!.targetMonth!.slice(5, 7)}.${d.override!.targetMonth!.slice(0, 4)}` : `профіт ${d.override!.profit}`} — ${d.override!.note}`).join("\n");
  const review = (id: number | null) => r.deals.filter((d) => d.closer === id && d.included && d.checks.length).map((d) => `${d.id}: ${d.checks.join("; ")}`).join("\n");
  return xlsxBook([
    { name: "Результат", rows: [["№", "ПІБ", "id менеджера", "Кількість угод", "Результат", "Коментар", "Угода", "На перевірці"],
      ...r.managers.map((m, i) => [i + 1, m.name, m.kommoUserId, m.deals, m.result, m.minus.n ? `мінусових ${m.minus.n} на ${m.minus.sum}` : "", notes(m.kommoUserId), review(m.kommoUserId)]),
      [null, "сума", null, r.totals.deals, r.totals.result, null, null, null]] },
    { name: "Угоди", rows: [["Угода", "Клієнт", "Закрито", "Хто закривав (id)", "Зараз (id)", "Бюджет", "Враховано", "У результаті", "Перевірити", "Рішення", "Примітка"],
      ...r.deals.map((d) => [d.id, d.client, d.closedAt.slice(0, 10), d.closer, d.current, d.price, d.profit, d.included ? "так" : "ні", d.checks.join("; "),
        d.override ? (d.override.action === "exclude" ? "не рахувати" : d.override.action === "move" ? `в ${d.override.targetMonth}` : "свій профіт") : "", d.override?.note ?? ""])] },
  ]);
}
