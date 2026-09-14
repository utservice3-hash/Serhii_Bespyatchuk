/**
 * 📋 РЕЄСТР ЗАЯВОК НА ОПЛАТУ ПЕРЕВІЗНИКАМ — ЧИСТИЙ МОДУЛЬ, БЕЗ БД І БЕЗ config.
 *
 * Рішення власника 07.09.2026 (зустріч, 14:27–16:14): «створити реєстр заявок на
 * оплату у вкладці дебіторки: для компанії такої-то менеджер подав таку-то суму для
 * такого-то перевізника; менеджер бачить лише свої заявки. Спочатку просто історія».
 *
 * 📐 Заміряно на проді 14.09.2026: заявка в Kommo = угода-«Автосделка» у воронці
 * «Оплата перевозчикам» (7341740). За 30 днів 1 476 заявок, менеджер є в усіх,
 * клієнт у 1 455. Сума і тип оплати вже синкались (`carrier_pay_amount`/`_type`),
 * назва перевізника і «хто подав» — з 14.09 (`carrier_name`, `source_deal_id`, `source_responsible`).
 *
 * 🔴 ЦІ УГОДИ ВСЮДИ ЗАХОВАНІ ЯК СЛУЖБОВІ (`notAutodealSql`, гейт #34). Реєстр — єдине
 * місце, що бере їх ЯВНО, по воронці, а не по префіксу назви. Тому `PIPELINE_ID` тут,
 * а не в роуті: гейт #401 стереже, що SQL реєстру фільтрує саме по ній.
 *
 * Етапи воронки — з живого Kommo 14.09.2026 (`/leads/pipelines/7341740`). Реєстр
 * звіряє їх з ЖИВИМ Kommo гейтом #401c: новий етап у воронці, якого тут немає, —
 * червоне, а не мовчазний «інше».
 */

export const PAYMENT_REQUEST_PIPELINE = 7341740;

export type PaymentRequestKind = "unsorted" | "pending" | "accepted" | "problem" | "paid" | "rejected";

export const PAYMENT_REQUEST_STATUSES: Record<number, { label: string; kind: PaymentRequestKind }> = {
  60434920: { label: "Нерозібране", kind: "unsorted" },
  60434924: { label: "Заявка на оплату", kind: "pending" },
  60436036: { label: "Прийнято до оплати", kind: "accepted" },
  104209016: { label: "Проблемна / до вирішення", kind: "problem" },
  142: { label: "Оплачено", kind: "paid" },
  143: { label: "Відмовлено в оплаті", kind: "rejected" },
};

/** Невідомий етап називає себе числом, а не ховається під «інше». */
export function requestStatusOf(statusId: number): { label: string; kind: PaymentRequestKind | "unknown" } {
  return PAYMENT_REQUEST_STATUSES[statusId] ?? { label: `етап #${statusId}`, kind: "unknown" };
}

/**
 * SQL реєстру. `cond` — умова скоупу/фільтрів, що починається з `AND` і посилається
 * на `d.` (угода) або `m.` (менеджер); параметри $1 = from, $2 = to (дата подачі за
 * Києвом, включно з обома кінцями — правило проєкту), далі — параметри `cond`.
 * Дата подачі = `created_at_kommo`: окремого поля «коли подано» в Kommo немає,
 * а Автосделка створюється в момент подачі заявки.
 */
export function paymentRequestsSql(cond: string): string {
  return `
    SELECT d.kommo_id, d.name,
           to_char(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS submitted_on,
           d.client_key, d.client_name,
           d.carrier_name, d.carrier_edrpou,
           d.carrier_pay_type, d.carrier_pay_amount,
           d.status_id,
           d.source_deal_id,
           m.id AS manager_id, COALESCE(m.name, d.source_responsible) AS manager_name, m.team_id
      FROM deals d
      -- 🧑 ХТО ПОДАВ: менеджер ВИХІДНОЇ угоди; коли її в базі немає — за ПІБ із заявки.
      -- Відповідальний за саму Автосделку — бухгалтерія, і скоуп по ньому показав би
      -- менеджерам порожній реєстр (заміряно 14.09.2026).
      LEFT JOIN deals src ON src.kommo_id = d.source_deal_id
      LEFT JOIN managers m ON m.id = COALESCE(
        src.manager_id,
        (SELECT mm.id FROM managers mm WHERE mm.name = d.source_responsible ORDER BY mm.is_active DESC NULLS LAST, mm.id LIMIT 1))
     WHERE d.pipeline_id = ${PAYMENT_REQUEST_PIPELINE}
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2
       ${cond}
     ORDER BY d.created_at_kommo DESC, d.kommo_id DESC`;
}

export interface PaymentRequestRow {
  kommoId: number;
  submittedOn: string;
  clientKey: string | null;
  clientName: string | null;
  carrierName: string | null;
  carrierEdrpou: string | null;
  payType: string | null;
  amount: number | null;
  statusId: number;
  status: string;
  kind: PaymentRequestKind | "unknown";
  managerId: number | null;
  managerName: string | null;
  sourceDealId: number | null;
  crmUrl: string;
}

export interface RawPaymentRequestRow {
  kommo_id: number | string; name: string | null; submitted_on: string;
  client_key: string | null; client_name: string | null;
  carrier_name: string | null; carrier_edrpou: string | null;
  carrier_pay_type: string | null; carrier_pay_amount: string | number | null;
  status_id: number | string; source_deal_id: number | string | null; manager_id: number | null; manager_name: string | null; team_id: number | null;
}

export function toPaymentRequestRows(rows: RawPaymentRequestRow[], crmBase: string): PaymentRequestRow[] {
  return rows.map((r) => {
    const st = requestStatusOf(Number(r.status_id));
    return {
      kommoId: Number(r.kommo_id),
      submittedOn: r.submitted_on,
      clientKey: r.client_key, clientName: r.client_name,
      carrierName: r.carrier_name, carrierEdrpou: r.carrier_edrpou,
      payType: r.carrier_pay_type,
      amount: r.carrier_pay_amount == null ? null : Number(r.carrier_pay_amount),
      statusId: Number(r.status_id), status: st.label, kind: st.kind,
      managerId: r.manager_id, managerName: r.manager_name,
      sourceDealId: r.source_deal_id == null ? null : Number(r.source_deal_id),
      crmUrl: `${crmBase.replace(/\/$/, "")}/leads/detail/${r.kommo_id}`,
    };
  });
}

/** Підсумок для шапки: кількість і сума по кожному стану. Порожній стан — нуль, а не відсутність. */
export function summarize(rows: PaymentRequestRow[]): Record<PaymentRequestKind | "unknown", { n: number; amount: number }> {
  const out = {} as Record<PaymentRequestKind | "unknown", { n: number; amount: number }>;
  for (const k of ["unsorted", "pending", "accepted", "problem", "paid", "rejected", "unknown"] as const) out[k] = { n: 0, amount: 0 };
  for (const r of rows) { out[r.kind].n += 1; out[r.kind].amount += r.amount ?? 0; }
  return out;
}
