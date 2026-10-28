/**
 * 🧾 Рахунок у 1С з вкладки «ТЕСТ ЗАКАЗ 1С» — `POST /createInvoice` (лист 1С від 25.10.2026, «Рахунок з CRM з позиціями,
 * валютою й PDF»). 1С сама рахує суму з позицій і одразу віддає PDF (`print_form.body`, base64).
 *
 * Правила вікна — від Сергія й бухгалтера Інни (макет погоджено 27.10.2026), і сервер перевіряє їх сам, вікну не довіряє:
 *   - організації ЮТС / Єлогіст / АвтоМув / ФОП, у 1С — КОДОМ (лист 1С «неоплачені рахунки», 25.10.2026);
 *   - ЮТС і Єлогіст — лише з ПДВ (типово «в тому числі», 20 %); АвтоМув і ФОП — лише без ПДВ;
 *   - послуги — зі списку, свого для кожної організації; «Содержание» = маршрут (1С друкує «послуга: маршрут»);
 *   - дата рахунку — лише сьогоднішня (ставить сервер); «Оплатити до» — не в минулому; «Дата акту» — необовʼязкова;
 *   - коментар у 1С — як у Genesis: «<менеджер>, Загружен из amoCRM по сделке №…».
 *
 * Чого 1С ще не вміє (ТЗ Андрію 28.10.2026) — того сервер у 1С не шле і не вдає, що шле:
 *   - другий рахунок в угоді (`deal_id` повертає наявний) → другий не створюємо, кажемо словами (`mount.ts`);
 *   - вибір банку → ФОП недоступний (у ФОП два рахунки, а 1С обрала б сама);
 *   - «Дата акту» й «Коментар СРМ» → зберігаємо в журналі, у 1С поки не йдуть (немає параметрів).
 *
 * Межа довіри: з браузера беремо лише те, що менеджер ОБРАВ у вікні. Контрагента (uid з `customerInfo` за кодом компанії
 * угоди) і менеджера сервер бере сам — інакше в режимі test можна було б підставити будь-кого.
 */
import type { Zakaz1cMode } from "./env.js";

export const CURRENCIES = ["UAH", "EUR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const VAT_TYPES = ["Без ПДВ", "ПДВ в тому числі", "ПДВ зверху"] as const;
export type VatType = (typeof VAT_TYPES)[number];

export type OrgKey = "uts" | "elogist" | "avtomuv" | "fop";
export interface OrgRule {
  key: OrgKey;
  short: string;
  name: string;
  /** Код організації в 1С. `null` — у вікні видно, але виставити не можна (`waits` пояснює чому). */
  code: string | null;
  /** «with» — лише з ПДВ; «without» — лише без. */
  vat: "with" | "without";
  /** Слово, за яким договір з `customerInfo` належить цій організації (там лише назва організації). */
  match: string;
  banks?: string[];
  waits?: string;
}

const CODE_RE = /^\d{1,9}$/;

/**
 * Коди — з листа 1С (25.10.2026): 000000002 ЮНАЙТЕД, 000000004 АвтоМув. Єлогіста в тому списку немає (питання Андрію),
 * тож його код — з env (`ZAKAZ1C_ELOGIST_CODE`), коли Андрій назве. ФОП у 1С три (05 Шевчук, 06 Яцик, 11 Беспятчук) —
 * котрий, скаже Сергій; але й тоді ФОП чекає вибору банку в `createInvoice`, тому поки недоступний за будь-якого коду.
 */
export function orgRules(env: NodeJS.ProcessEnv = process.env): OrgRule[] {
  const elogist = String(env.ZAKAZ1C_ELOGIST_CODE ?? "").trim();
  const elogistOk = CODE_RE.test(elogist);
  return [
    { key: "uts", short: "ЮТС", name: "ТОВ «ЮНАЙТЕД ТРАНСПОРТ СЕРВІС»", code: "000000002", vat: "with", match: "юнайтед" },
    { key: "elogist", short: "Єлогіст", name: "ТОВ «Єлогіст»", code: elogistOk ? elogist : null, vat: "with", match: "логіст",
      ...(elogistOk ? {} : { waits: "Єлогіста немає серед організацій 1С — чекаємо його код від Андрія." }) },
    { key: "avtomuv", short: "АвтоМув", name: "ТОВ «АвтоМув»", code: "000000004", vat: "without", match: "автомув" },
    { key: "fop", short: "ФОП", name: "ФОП (з 1С)", code: null, vat: "without", match: "фоп", banks: ["ПриватБанк", "monobank"],
      waits: "1С ще не приймає вибір банку (ПриватБанк / monobank) — ФОП відкриємо, щойно Андрій додасть." },
  ];
}

/** Послуги вікна: свій список для кожної організації (Сергій, 27.10.2026). Код — лише підтверджений відповіддю 1С. */
export const SERVICES: { name: string; orgs: OrgKey[] | "all"; code?: string }[] = [
  { name: "Організація перевезення в межах території України за маршрутом", orgs: ["uts", "elogist"] },
  { name: "Організація перевезення за маршрутом", orgs: ["avtomuv", "fop"] },
  { name: "Організація міжнародного перевезення", orgs: ["avtomuv"], code: "000000179" },
  { name: "Експедиторські послуги", orgs: "all" },
  { name: "Штрафні санкції за простій автомобільного транспорту", orgs: "all" },
];
export const servicesFor = (org: OrgKey) => SERVICES.filter((x) => x.orgs === "all" || x.orgs.includes(org));

export const vatTypesFor = (o: OrgRule): VatType[] => (o.vat === "with" ? ["ПДВ в тому числі", "ПДВ зверху"] : ["Без ПДВ"]);
export const itemVatsFor = (o: OrgRule): number[] => (o.vat === "with" ? [20, 14, 7] : [0]);

export interface InvoiceItem { service: string; route: string; qty: number; price: number; vat: number }

/** Те, що надсилає вікно. Дату рахунку, контрагента й менеджера сервер бере сам. */
export interface InvoiceForm {
  org: OrgKey;
  agreement: string;
  currency: Currency;
  vatType: VatType;
  discount: number;
  dueDate: string;
  actDate: string;
  bank: string;
  crmComment: string;
  stamp: boolean;
  items: InvoiceItem[];
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN);
const s = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Сьогодні по-київськи, `YYYY-MM-DD` (правило дашборда: дати завжди по Києву). */
export const kyivIso = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(d);

export type FormCheck = { ok: true; form: InvoiceForm } | { ok: false; why: string };

/** Розбір і перевірка тіла запиту за правилами організації. Помилки — словами для менеджера: їх показує вікно. */
export function parseInvoiceForm(body: unknown, ctx: { today: string; orgs: OrgRule[] }): FormCheck {
  const b = (body ?? {}) as Record<string, unknown>;
  const o = ctx.orgs.find((x) => x.key === s(b.org, 20));
  if (!o) return { ok: false, why: "Оберіть організацію зі списку." };
  if (!o.code) return { ok: false, why: o.waits ?? `${o.short}: виставити поки не можна.` };
  const currency = s(b.currency, 3).toUpperCase() as Currency;
  if (!CURRENCIES.includes(currency)) return { ok: false, why: "Валюта має бути UAH, EUR або USD." };
  const vatType = s(b.vatType, 40) as VatType;
  if (!vatTypesFor(o).includes(vatType)) {
    return { ok: false, why: o.vat === "with" ? `${o.short} виставляє рахунки лише з ПДВ.` : `${o.short} виставляє рахунки лише без ПДВ.` };
  }
  const bank = s(b.bank, 40);
  if (o.banks && !o.banks.includes(bank)) return { ok: false, why: `Оберіть рахунок ${o.short}: ${o.banks.join(" чи ")}.` };
  const allowed = servicesFor(o.key).map((x) => x.name);
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length === 0) return { ok: false, why: "Додайте хоча б одну послугу." };
  if (rawItems.length > 20) return { ok: false, why: "Забагато позицій (більше 20)." };
  const items: InvoiceItem[] = [];
  for (const [i, raw] of rawItems.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const service = s(r.service, 300), route = s(r.route, 1000);
    const qty = num(r.qty ?? 1), price = num(r.price), vat = num(r.vat ?? (o.vat === "with" ? 20 : 0));
    if (!allowed.includes(service)) return { ok: false, why: `Позиція ${i + 1}: послуга не зі списку ${o.short}.` };
    if (!(qty > 0)) return { ok: false, why: `Позиція ${i + 1}: кількість має бути більше 0.` };
    if (!(price > 0)) return { ok: false, why: `Позиція ${i + 1}: ціна має бути більше 0.` };
    if (!itemVatsFor(o).includes(vat)) return { ok: false, why: `Позиція ${i + 1}: ставка ПДВ ${itemVatsFor(o).join(", ")} %.` };
    items.push({ service, route, qty, price, vat });
  }
  const discount = num(b.discount ?? 0);
  const total = items.reduce((t, it) => t + it.qty * it.price, 0);
  if (!(discount >= 0)) return { ok: false, why: "Знижка не може бути відʼємною." };
  if (discount >= total) return { ok: false, why: "Знижка не може бути більшою за суму рахунку." };
  const dueDate = s(b.dueDate, 10), actDate = s(b.actDate, 10);
  if (dueDate && !DATE_RE.test(dueDate)) return { ok: false, why: "«Оплатити до» — у форматі РРРР-ММ-ДД." };
  if (dueDate && dueDate < ctx.today) return { ok: false, why: "«Оплатити до» не може бути в минулому." };
  if (actDate && !DATE_RE.test(actDate)) return { ok: false, why: "Дата акту — у форматі РРРР-ММ-ДД." };
  return {
    ok: true,
    form: { org: o.key, agreement: s(b.agreement, 200), currency, vatType, discount, dueDate, actDate, bank,
      crmComment: s(b.crmComment, 1000), stamp: b.stamp !== false, items },
  };
}

/** Режим + хто + який контрагент → можна чи ні. Окрема чиста функція, бо це головна межа тестового режиму. */
export function invoiceAllowed(mode: Zakaz1cMode, a: { edrpou: string; testEdrpou: string; userId: number; testers: Set<number> }):
  { ok: true } | { ok: false; why: string } {
  if (mode === "off") return { ok: false, why: "Виставлення рахунків вимкнено (ZAKAZ1C_MODE=off)." };
  if (!a.edrpou) return { ok: false, why: "У компанії угоди немає ЄДРПОУ / ІПН — заповніть поле в компанії." };
  if (mode === "test") {
    if (!a.testers.has(a.userId)) return { ok: false, why: "Тестовий режим: рахунки створюють лише тестувальники." };
    if (a.edrpou !== a.testEdrpou) {
      return { ok: false, why: `Тестовий режим: рахунок можна виставити лише тестовому контрагенту (ЄДРПОУ ${a.testEdrpou}).` };
    }
  }
  return { ok: true };
}

/** Коментар рахунку — дослівно як у Genesis (бухгалтерія просила саме так, 27.10.2026). */
export const genesisComment = (manager: string, dealId: number) =>
  `${manager ? `${manager}, ` : ""}Загружен из amoCRM по сделке №${dealId}`;

/**
 * Тіло `POST /createInvoice`. Чиста функція: гейт звіряє, що жодне поле вікна не загубилось дорогою.
 * `order_date` свідомо НЕ шлемо: 1С дописує його в коментар, а коментар має бути рівно як у Genesis.
 * «Дата акту», «Коментар СРМ», банк — не шлемо, бо 1С їх ще не приймає (ТЗ п. 2–3); вони лежать у журналі.
 */
export function buildCreateInvoiceBody(dealId: number, form: InvoiceForm, who: { customerUid: string; manager: string; today: string; orgCode: string }) {
  return {
    customer_uid: who.customerUid,
    organization: who.orgCode,
    agreement: form.agreement,
    currency: form.currency,
    vat_type: form.vatType,
    discount: form.discount,
    invoice_date: who.today,
    ...(form.dueDate ? { due_date: form.dueDate } : {}),
    manager: who.manager,
    comment: genesisComment(who.manager, dealId),
    deal_id: String(dealId),
    items: form.items.map((it) => ({ code: SERVICES.find((x) => x.name === it.service)?.code ?? "", article: "", name: it.service,
      unit: "Послуга", qty: it.qty, price: it.price, vat: it.vat, content: it.route })),
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
  /** Номенклатура, яку 1С поставила в рядки (за назвою; не знайшла — стандартну). */
  itemNames: string[];
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
      itemNames: Array.isArray(j.items) ? j.items.map((x: any) => String(x?.name ?? "")) : [],
      pdf: body ? { fileName: String(pf.file_name || `invoice_${j.invoice_number_print ?? j.invoice_number}.pdf`), bytes: Buffer.from(body, "base64") } : null,
    },
  };
}

/**
 * 1С не знайшла послугу за назвою → мовчки ставить стандартну (лист 1С, «Номенклатура позиції»). На вигляд рахунку
 * це не впливає, але в обліку послуга інша — тож кажемо менеджеру, а не ковтаємо.
 */
export function serviceSwaps(requested: string[], got: string[]): string[] {
  if (got.length !== requested.length) return [];
  return requested.flatMap((r, i) => (got[i] && got[i] !== r ? [`1С поставила послугу «${got[i]}» замість «${r}» — такої назви в 1С немає.`] : []));
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Гривневий рахунок з печаткою важить ~1,7 МБ (лист 1С); перший запит після рестарту 1С — до 5 с; контрагент — ~6 с. */
const ONEC_TIMEOUT_MS = 30_000;

export async function createInvoiceIn1c(base: string, body: unknown, doFetch: FetchLike = fetch): Promise<OneCInvoiceResult> {
  try {
    const r = await doFetch(`${base}/createInvoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ONEC_TIMEOUT_MS),
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
    const r = await doFetch(`${base}/invoicePdf?${q}`, { signal: AbortSignal.timeout(ONEC_TIMEOUT_MS) });
    if (r.status !== 200) return { ok: false, why: `1С відповіла ${r.status}.` };
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.subarray(0, 4).toString() !== "%PDF") return { ok: false, why: "1С віддала не PDF." };
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, why: (e as Error)?.name === "TimeoutError" ? "1С не відповіла за 30 с." : "1С недоступна." };
  }
}

/* ——— контрагент ——— */

/** Код компанії → параметр 1С: 8 цифр — юрособа (`edrpou`), 10 — ФОП (`inn`; лист 1С 04.10: ФОП шукати за `inn`). */
export function codeKind(code: string): "edrpou" | "inn" | null {
  return /^\d{8}$/.test(code) ? "edrpou" : /^\d{10}$/.test(code) ? "inn" : null;
}

export interface CustomerInfo {
  found: boolean;
  uid: string;
  name: string;
  agreements: { value: string; label: string; organization: string; currency: string }[];
  error?: string;
}

/** `customerInfo` за кодом компанії угоди. Помилка 1С не ламає вікно: показуємо її словами. */
export async function customerInfoFrom1c(base: string, code: string, doFetch: FetchLike = fetch): Promise<CustomerInfo> {
  const none: CustomerInfo = { found: false, uid: "", name: "", agreements: [] };
  const kind = codeKind(code);
  if (!kind) return code ? { ...none, error: "код компанії не 8 і не 10 цифр" } : none;
  try {
    const r = await doFetch(`${base}/customerInfo?${kind}=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(10_000) });
    const j: any = r.status === 200 ? await r.json().catch(() => null) : null;
    if (!j) return { ...none, error: `1С відповіла ${r.status}` };
    if (j.state !== true || !j.uid) return none;
    const list = Array.isArray(j.agreements) ? j.agreements : [];
    return {
      found: true,
      uid: String(j.uid),
      name: String(j.name ?? ""),
      agreements: list.map((a: any) => ({
        value: String(a?.uid ?? ""),
        label: [a?.name, a?.number && `№ ${a.number}`, a?.currency].filter(Boolean).join(" · "),
        organization: String(a?.organization ?? ""),
        currency: String(a?.currency ?? ""),
      })).filter((a: { value: string }) => a.value),
    };
  } catch {
    return { ...none, error: "1С недоступна" };
  }
}

/** Тіло `POST /createCustomer` з компанії угоди: назва + ЄДРПОУ або ІПН (лист 1С 04.10.2026, обовʼязкові поля). */
export function buildCreateCustomerBody(company: { name: string; code: string }, manager: string):
  { ok: true; body: Record<string, string> } | { ok: false; why: string } {
  const name = company.name.trim();
  if (!name) return { ok: false, why: "У компанії угоди немає назви." };
  const kind = codeKind(company.code);
  if (!kind) return { ok: false, why: "У компанії угоди ЄДРПОУ має бути 8 цифр, ІПН ФОП — 10." };
  return { ok: true, body: { name, [kind]: company.code, ...(manager ? { manager } : {}) } };
}

export async function createCustomerIn1c(base: string, body: unknown, doFetch: FetchLike = fetch):
  Promise<{ ok: true; uid: string; existed: boolean; warnings: string[] } | { ok: false; why: string }> {
  try {
    const r = await doFetch(`${base}/createCustomer`, {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(ONEC_TIMEOUT_MS),
    });
    if (r.status !== 200) return { ok: false, why: `1С відповіла ${r.status}.` };
    const j: any = await r.json().catch(() => null);
    if (!j || j.state !== true || !j.uid) return { ok: false, why: `1С: ${String(j?.message ?? "контрагента не створено").slice(0, 300)}` };
    return { ok: true, uid: String(j.uid), existed: j.existed === true, warnings: Array.isArray(j.warnings) ? j.warnings.map(String) : [] };
  } catch (e) {
    return { ok: false, why: (e as Error)?.name === "TimeoutError" ? "1С не відповіла за 30 с." : "1С недоступна." };
  }
}

/* ——— оплата рахунку і «Змінити» ——— */

/**
 * Стан оплати одного рахунку — з того, що дашборд уже тягне з 1С: `onec_unpaid_invoices` (знімок неоплачених рахунків
 * 2026 року, щогодини) і оплати угоди (`onec_deal_payments`).
 *   є у знімку → неоплачений / частково / прострочений — з `paid_sum`, `remaining`, `due_date`;
 *   немає, знімок НОВІШИЙ за рахунок і за угодою є оплата → оплачено;
 *   немає, знімок новіший, оплати не видно → «немає серед неоплачених» — не вигадуємо, що оплачено (міг бути видалений);
 *   знімок не новіший за рахунок → «ще не синхронізовано».
 */
export type PayKind = "unpaid" | "part" | "overdue" | "paid" | "missing" | "pending";
export interface PayState { k: PayKind; paid: number; remaining: number }

export function payStateOf(inv: { createdAt: Date; total: number }, unpaid: { paid: number; remaining: number; due: string | null } | null,
  ctx: { syncedAt: Date | null; dealPaid: number; today: string }): PayState {
  if (unpaid) {
    const k: PayKind = unpaid.paid > 0 ? "part" : unpaid.due && unpaid.due < ctx.today ? "overdue" : "unpaid";
    return { k, paid: unpaid.paid, remaining: unpaid.remaining };
  }
  if (!ctx.syncedAt || ctx.syncedAt.getTime() <= inv.createdAt.getTime()) return { k: "pending", paid: 0, remaining: inv.total };
  if (ctx.dealPaid > 0) return { k: "paid", paid: inv.total, remaining: 0 };
  return { k: "missing", paid: 0, remaining: 0 };
}

/**
 * «Змінити» — лише в день виставлення і лише без оплати (Сергій та Інна, 27.10.2026); далі — запит бухгалтерії.
 * «Немає серед неоплачених» не вважаємо «без оплати»: невідомо — значить через бухгалтерію.
 */
export function canEdit(createdDay: string, pay: PayState, today: string): boolean {
  return createdDay === today && pay.paid <= 0 && (pay.k === "unpaid" || pay.k === "overdue" || pay.k === "pending");
}
