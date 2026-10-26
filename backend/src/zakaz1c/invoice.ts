/**
 * 🧾 Рахунок у 1С з вікна «ТЕСТ ЗАКАЗ 1С» — `POST /createInvoice` (лист 1С від 25.10.2026, «Рахунок з CRM з позиціями,
 * валютою й PDF»). Те саме, що Genesis кладе в «Сделка»: організація, договір, валюта, ПДВ, знижка, позиції; 1С сама
 * рахує суму з позицій і одразу віддає PDF (`print_form.body`, base64).
 *
 * Межа довіри: з браузера беремо лише те, що менеджер ОБРАВ у вікні. Контрагента (ЄДРПОУ) і менеджера сервер бере
 * сам — з компанії угоди та користувача Kommo, — інакше в режимі test можна було б підставити будь-кого.
 *
 * `deal_id` = ID угоди Kommo ЗАВЖДИ: 1С за ним не створює дубль, а повертає наявний рахунок з `existed: true`.
 * Саме це робить кнопку безпечною для повторного натискання (у червні 2026 дублі 000004223–245 видаляли руками).
 */
import type { Zakaz1cMode } from "./env.js";

export const CURRENCIES = ["UAH", "EUR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const VAT_TYPES = ["Без ПДВ", "ПДВ в тому числі", "ПДВ зверху"] as const;
export type VatType = (typeof VAT_TYPES)[number];
export const ITEM_VAT = [20, 14, 7, 0] as const;

/**
 * Наші юрособи. `value` — те, що йде в 1С полем `organization` (назва, код або uid; порожньо = ЮНАЙТЕД, як у
 * `GET /createInvoice`). ⚠️ ВІДКРИТЕ ПИТАННЯ: точна назва ФОП у 1С не названа в листі — додамо, коли Андрій її дасть;
 * до того ФОП у списку немає, щоб рахунок не пішов не від тієї юрособи.
 */
export const ORGANIZATIONS: { label: string; value: string }[] = [
  { label: "ТОВ «ЮНАЙТЕД ТРАНСПОРТ СЕРВІС»", value: "" },
  { label: "ТОВ «АвтоМув»", value: "ТОВ АвтоМув" },
];

export interface InvoiceItem { name: string; content: string; qty: number; price: number; vat: number }

/** Те, що надсилає вікно. Усе інше сервер бере сам. */
export interface InvoiceForm {
  organization: string;
  agreement: string;
  currency: Currency;
  vatType: VatType;
  discount: number;
  invoiceDate: string;
  dueDate: string;
  comment: string;
  stamp: boolean;
  items: InvoiceItem[];
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN);
const s = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FormCheck = { ok: true; form: InvoiceForm } | { ok: false; why: string };

/** Розбір і перевірка тіла запиту. Помилки — словами для менеджера: їх показує вікно. */
export function parseInvoiceForm(body: unknown): FormCheck {
  const b = (body ?? {}) as Record<string, unknown>;
  const organization = s(b.organization, 200);
  if (!ORGANIZATIONS.some((o) => o.value === organization)) return { ok: false, why: "Оберіть організацію зі списку." };
  const currency = s(b.currency, 3).toUpperCase() as Currency;
  if (!CURRENCIES.includes(currency)) return { ok: false, why: "Валюта має бути UAH, EUR або USD." };
  const vatType = s(b.vatType, 40) as VatType;
  if (!VAT_TYPES.includes(vatType)) return { ok: false, why: "Оберіть тип ПДВ." };
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length === 0) return { ok: false, why: "Додайте хоча б одну позицію." };
  if (rawItems.length > 50) return { ok: false, why: "Забагато позицій (більше 50)." };
  const items: InvoiceItem[] = [];
  for (const [i, raw] of rawItems.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const name = s(r.name, 300), content = s(r.content, 1000);
    const qty = num(r.qty ?? 1), price = num(r.price), vat = num(r.vat ?? (currency === "UAH" ? 20 : 0));
    if (!name && !content) return { ok: false, why: `Позиція ${i + 1}: вкажіть найменування або зміст.` };
    if (!(qty > 0)) return { ok: false, why: `Позиція ${i + 1}: кількість має бути більше 0.` };
    if (!(price > 0)) return { ok: false, why: `Позиція ${i + 1}: ціна має бути більше 0.` };
    if (!ITEM_VAT.includes(vat as (typeof ITEM_VAT)[number])) return { ok: false, why: `Позиція ${i + 1}: ставка ПДВ 20, 14, 7 або 0.` };
    items.push({ name, content, qty, price, vat });
  }
  const discount = num(b.discount ?? 0);
  const total = items.reduce((t, it) => t + it.qty * it.price, 0);
  if (!(discount >= 0)) return { ok: false, why: "Знижка не може бути відʼємною." };
  if (discount >= total) return { ok: false, why: "Знижка не може бути більшою за суму рахунку." };
  const invoiceDate = s(b.invoiceDate, 10), dueDate = s(b.dueDate, 10);
  if (invoiceDate && !DATE_RE.test(invoiceDate)) return { ok: false, why: "Дата рахунку — у форматі РРРР-ММ-ДД." };
  if (dueDate && !DATE_RE.test(dueDate)) return { ok: false, why: "Дата оплати — у форматі РРРР-ММ-ДД." };
  return {
    ok: true,
    form: { organization, agreement: s(b.agreement, 200), currency, vatType, discount, invoiceDate, dueDate,
      comment: s(b.comment, 1000), stamp: b.stamp !== false, items },
  };
}

/** Режим + хто + який контрагент → можна чи ні. Окрема чиста функція, бо це головна межа тестового режиму. */
export function invoiceAllowed(mode: Zakaz1cMode, a: { edrpou: string; testEdrpou: string; userId: number; testers: Set<number> }):
  { ok: true } | { ok: false; why: string } {
  if (mode === "off") return { ok: false, why: "Виставлення рахунків вимкнено (ZAKAZ1C_MODE=off)." };
  if (!a.edrpou) return { ok: false, why: "У компанії угоди немає ЄДРПОУ — заповніть поле «ЕДРПОУ» в компанії." };
  if (mode === "test") {
    if (!a.testers.has(a.userId)) return { ok: false, why: "Тестовий режим: рахунки створюють лише тестувальники." };
    if (a.edrpou !== a.testEdrpou) {
      return { ok: false, why: `Тестовий режим: рахунок можна виставити лише тестовому контрагенту (ЄДРПОУ ${a.testEdrpou}).` };
    }
  }
  return { ok: true };
}

/** Тіло `POST /createInvoice`. Чиста функція: гейт звіряє, що жодне поле вікна не загубилось дорогою. */
export function buildCreateInvoiceBody(dealId: number, form: InvoiceForm, who: { edrpou: string; manager: string; orderDate: string }) {
  return {
    customer_edrpou: who.edrpou,
    organization: form.organization,
    agreement: form.agreement,
    currency: form.currency,
    vat_type: form.vatType,
    discount: form.discount,
    ...(form.invoiceDate ? { invoice_date: form.invoiceDate } : {}),
    ...(form.dueDate ? { due_date: form.dueDate } : {}),
    order_date: who.orderDate,
    manager: who.manager,
    comment: form.comment,
    deal_id: String(dealId),
    items: form.items.map((it) => ({ code: "", article: "", name: it.name, unit: "Послуга", qty: it.qty, price: it.price,
      vat: it.vat, content: it.content })),
    pdf: true,
    stamp: form.stamp,
  };
}

export interface CreatedInvoice {
  existed: boolean;
  number: string;
  numberPrint: string;
  date: string;
  uid: string;
  organization: string;
  agreement: string;
  currency: string;
  vatType: string;
  total: number;
  warnings: string[];
  pdf: { fileName: string; bytes: Buffer } | null;
}

export type OneCInvoiceResult = { ok: true; invoice: CreatedInvoice } | { ok: false; why: string };

/** Відповідь 1С → наш вигляд. Чиста; `state:false` — помилка 1С словами (HTTP у 1С тоді все одно 200). */
export function fromCreateInvoiceReply(j: any): OneCInvoiceResult {
  if (!j || typeof j !== "object") return { ok: false, why: "1С віддала не JSON." };
  if (j.state !== true) return { ok: false, why: `1С: ${String(j.message ?? "рахунок не створено").slice(0, 300)}` };
  if (!j.invoice_uid || !j.invoice_number) return { ok: false, why: "1С не повернула номер рахунку." };
  const pf = j.print_form;
  const body = typeof pf?.body === "string" ? pf.body.replace(/\s+/g, "") : "";
  return {
    ok: true,
    invoice: {
      existed: j.existed === true,
      number: String(j.invoice_number),
      numberPrint: String(j.invoice_number_print ?? j.invoice_number),
      date: String(j.invoice_date_iso ?? j.invoice_date ?? ""),
      uid: String(j.invoice_uid),
      organization: String(j.organization?.name ?? ""),
      agreement: String(j.agreement?.name ?? ""),
      currency: String(j.currency ?? ""),
      vatType: String(j.vat_type ?? ""),
      total: Number(j.total) || 0,
      warnings: Array.isArray(j.warnings) ? j.warnings.map(String) : [],
      pdf: body ? { fileName: String(pf.file_name || `invoice_${j.invoice_number_print ?? j.invoice_number}.pdf`), bytes: Buffer.from(body, "base64") } : null,
    },
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Гривневий рахунок з печаткою важить ~1,7 МБ (лист 1С); перший запит після рестарту 1С — до 5 с. */
const CREATE_TIMEOUT_MS = 30_000;

export async function createInvoiceIn1c(base: string, body: unknown, doFetch: FetchLike = fetch): Promise<OneCInvoiceResult> {
  try {
    const r = await doFetch(`${base}/createInvoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
    if (r.status !== 200) return { ok: false, why: `1С відповіла ${r.status}.` };
    return fromCreateInvoiceReply(await r.json().catch(() => null));
  } catch (e) {
    return { ok: false, why: (e as Error)?.name === "TimeoutError" ? "1С не відповіла за 30 с." : "1С недоступна." };
  }
}

/** PDF уже створеного рахунку (`GET /invoicePdf?uid=…&format=file`) — для «PDF ще раз» після правок бухгалтерії. */
export async function invoicePdfFrom1c(base: string, uid: string, stamp: boolean, doFetch: FetchLike = fetch):
  Promise<{ ok: true; bytes: Buffer } | { ok: false; why: string }> {
  try {
    const q = new URLSearchParams({ uid, format: "file", ...(stamp ? {} : { stamp: "0" }) });
    const r = await doFetch(`${base}/invoicePdf?${q}`, { signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) });
    if (r.status !== 200) return { ok: false, why: `1С відповіла ${r.status}.` };
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.subarray(0, 4).toString() !== "%PDF") return { ok: false, why: "1С віддала не PDF." };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, why: (e as Error)?.name === "TimeoutError" ? "1С не відповіла за 30 с." : "1С недоступна." };
  }
}
