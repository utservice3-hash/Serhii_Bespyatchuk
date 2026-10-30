/**
 * 🧾 Рахунок у 1С з вкладки «ТЕСТ ЗАКАЗ 1С» — `POST /createInvoice` (лист 1С від 25.10.2026, «Рахунок з CRM з позиціями,
 * валютою й PDF»). 1С сама рахує суму з позицій і одразу віддає PDF (`print_form.body`, base64).
 *
 * Правила вікна — від Сергія й бухгалтера Інни (макет погоджено 27.10.2026), і сервер перевіряє їх сам, вікну не довіряє:
 *   - організації ЮТС / Єлогіст / АвтоМув / ФОП, у 1С — КОДОМ (лист 1С «неоплачені рахунки», 25.10.2026);
 *   - ЮТС і Єлогіст — лише «ПДВ в тому числі» (ставка типово 20 %); АвтоМув і ФОП — лише без ПДВ;
 *     «ПДВ зверху» і знижки у вікні немає (Сергій, 28.10.2026): `discount` завжди 0;
 *   - послуги — зі списку, свого для кожної організації; «Содержание» = маршрут (1С друкує «послуга: маршрут»);
 *   - дата рахунку — лише сьогоднішня (ставить сервер); «Оплатити до» — не в минулому; «Дата акту» — необовʼязкова;
 *   - коментар у 1С — як у Genesis: «<менеджер>, Загружен из amoCRM по сделке №…».
 *
 * Доробки 1С від 29.10.2026 (лист «Віджет "Заказ 1С": що зроблено в 1С»):
 *   - `request_id` — кілька рахунків в угоді; захист від дубля — за ключем ВІДКРИТОЇ ФОРМИ, а не за угодою;
 *   - `bank_account` + `GET /organizations` — ФОП Беспятчук: менеджер обирає ПриватБанк чи monobank;
 *   - `deal_fields` — «Дата акта» (+ «від менеджера») і «Коментар CRM»; решта полів угоди чекає відповідності Kommo → 1С;
 *   - `POST /updateInvoice` — зміна рахунку (1С сама відмовляє, якщо є оплата чи реалізація);
 *   - `GET /realizationPdf?form=act` — акт, коли бухгалтерія провела реалізацію.
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
  /** ФОП приймає оплату на кілька рахунків — без явного банку 1С обрала б будь-який (основний не вказано). */
  needsBank?: boolean;
  waits?: string;
}

/**
 * Коди організацій 1С: 000000002 ЮНАЙТЕД, 000000004 АвтоМув (лист 1С 25.10.2026), 000000012 ТОВ «ЄЛОГІСТ» (Роман,
 * 28.10.2026), 000000011 ФОП Беспятчук (Сергій, 28.10.2026: «Яцик не працює — тільки Беспятчук»). Банки ФОП — з
 * `GET /organizations`, а не з коду: їх веде бухгалтерія в 1С.
 */
export function orgRules(): OrgRule[] {
  return [
    { key: "uts", short: "ЮТС", name: "ТОВ «ЮНАЙТЕД ТРАНСПОРТ СЕРВІС»", code: "000000002", vat: "with", match: "юнайтед" },
    { key: "elogist", short: "Єлогіст", name: "ТОВ «ЄЛОГІСТ»", code: "000000012", vat: "with", match: "логіст" },
    { key: "avtomuv", short: "АвтоМув", name: "ТОВ «АвтоМув»", code: "000000004", vat: "without", match: "автомув" },
    { key: "fop", short: "ФОП", name: "ФОП Беспятчук С. С.", code: "000000011", vat: "without", match: "беспятчук", needsBank: true },
  ];
}

/**
 * Послуги вікна: свій список для кожної організації (Сергій, 27.10.2026). Коди — з відповіді 1С на ТЗ (28.10.2026):
 * у 1С шлемо КОДОМ, бо за назвою «Експедиторські послуги» не знаходяться (у назві в 1С латинська «i»), а невідомий
 * код 1С тепер відхиляє, а не підміняє стандартною послугою.
 */
export const SERVICES: { name: string; orgs: OrgKey[] | "all"; code: string }[] = [
  { name: "Організація перевезення в межах території України за маршрутом", orgs: ["uts", "elogist"], code: "000000092" },
  { name: "Організація перевезення за маршрутом", orgs: ["avtomuv", "fop"], code: "000000008" },
  { name: "Організація міжнародного перевезення", orgs: ["avtomuv"], code: "000000179" },
  { name: "Експедиторські послуги", orgs: "all", code: "000000252" },
  { name: "Штрафні санкції за простій автомобільного транспорту", orgs: "all", code: "000000180" },
];
export const servicesFor = (org: OrgKey) => SERVICES.filter((x) => x.orgs === "all" || x.orgs.includes(org));

export const vatTypesFor = (o: OrgRule): VatType[] => (o.vat === "with" ? ["ПДВ в тому числі"] : ["Без ПДВ"]);
export const itemVatsFor = (o: OrgRule): number[] => (o.vat === "with" ? [20, 14, 7] : [0]);

export interface InvoiceItem { service: string; route: string; qty: number; price: number; vat: number }

/** Те, що надсилає вікно. Дату рахунку, контрагента й менеджера сервер бере сам. */
export interface InvoiceForm {
  org: OrgKey;
  agreement: string;
  currency: Currency;
  vatType: VatType;
  dueDate: string;
  actDate: string;
  /** uid банківського рахунку організації з `/organizations` (лише ФОП). */
  bankUid: string;
  /** Ключ відкритої форми (UUID): повтор того самого «Виставити» дає той самий рахунок, нова форма — новий. */
  requestId: string;
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

/** Банківський рахунок організації з `GET /organizations`. */
export interface BankAccount { uid: string; name: string; iban: string; currency: string; bank: string; isMain: boolean }
const REQ_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Розбір і перевірка тіла запиту за правилами організації. Помилки — словами для менеджера: їх показує вікно. */
export function parseInvoiceForm(body: unknown, ctx: { today: string; orgs: OrgRule[]; banksOf?: (orgCode: string) => BankAccount[] }): FormCheck {
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
  let bankUid = "";
  if (o.needsBank) {
    bankUid = s(b.bankUid, 64);
    const own = (ctx.banksOf?.(o.code) ?? []).filter((x) => x.currency === currency);
    if (!own.length) return { ok: false, why: `У ${o.short} в 1С немає рахунку у ${currency}.` };
    if (!own.some((x) => x.uid === bankUid)) return { ok: false, why: `Оберіть рахунок ${o.short}, на який платить клієнт: ${own.map((x) => x.bank || x.name).join(" чи ")}.` };
  }
  const requestId = s(b.requestId, 50);
  if (requestId && !REQ_RE.test(requestId)) return { ok: false, why: "Некоректний ключ форми — відкрийте форму ще раз." };
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
  const dueDate = s(b.dueDate, 10), actDate = s(b.actDate, 10);
  if (dueDate && !DATE_RE.test(dueDate)) return { ok: false, why: "«Оплатити до» — у форматі РРРР-ММ-ДД." };
  if (dueDate && dueDate < ctx.today) return { ok: false, why: "«Оплатити до» не може бути в минулому." };
  if (actDate && !DATE_RE.test(actDate)) return { ok: false, why: "Дата акту — у форматі РРРР-ММ-ДД." };
  return {
    ok: true,
    form: { org: o.key, agreement: s(b.agreement, 200), currency, vatType, dueDate, actDate, bankUid, requestId,
      crmComment: s(b.crmComment, 150), stamp: b.stamp !== false, items },
  };
}

/** Режим + хто + який контрагент → можна чи ні. Окрема чиста функція, бо це головна межа тестового режиму. */
export function invoiceAllowed(mode: Zakaz1cMode, a: { edrpou: string; testEdrpou: string; userId: number; testers: Set<number> }):
  { ok: true } | { ok: false; why: string } {
  if (mode === "off") return { ok: false, why: "Виставлення рахунків вимкнено (ZAKAZ1C_MODE=off)." };
  if (!a.edrpou) return { ok: false, why: "У компанії угоди немає ЄДРПОУ / ІПН — заповніть поле в компанії." };
  if (mode === "test") {
    // Порожній список — будь-хто (Роман, 28.10.2026: вкладка всім); межу тримає тестовий ЄДРПОУ нижче.
    if (a.testers.size > 0 && !a.testers.has(a.userId)) return { ok: false, why: "Тестовий режим: рахунки створюють лише тестувальники." };
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
 * Поля угоди в рахунку (`deal_fields`, 1С 29.10.2026). Поки — лише те, що менеджер вводить у вікні: «Дата акта» (тоді
 * й «Дата акта от менеджера» ☑) і «Коментар CRM». Порожня дата → поле не шлемо, і 1С лишає реквізит порожнім, а
 * позначку не ставить. Решта («Документооборот», «Розходи») — коли буде відповідність полів Kommo → реквізити.
 */
export function dealFieldsOf(form: Pick<InvoiceForm, "actDate" | "crmComment">) {
  return {
    ...(form.actDate ? { act_date: form.actDate, act_date_by_manager: true } : {}),
    ...(form.crmComment ? { crm_comment: form.crmComment } : {}),
  };
}

const itemsOf = (form: InvoiceForm) => form.items.map((it) => ({ code: SERVICES.find((x) => x.name === it.service)?.code ?? "", article: "",
  name: it.service, unit: "Послуга", qty: it.qty, price: it.price, vat: it.vat, content: it.route }));

/**
 * Тіло `POST /createInvoice`. Чиста функція: гейт звіряє, що жодне поле вікна не загубилось дорогою.
 * `order_date` свідомо НЕ шлемо: коментар має бути рівно як у Genesis.
 */
export function buildCreateInvoiceBody(dealId: number, form: InvoiceForm, who: { customerUid: string; manager: string; today: string; orgCode: string }) {
  const df = dealFieldsOf(form);
  return {
    customer_uid: who.customerUid,
    organization: who.orgCode,
    agreement: form.agreement,
    currency: form.currency,
    vat_type: form.vatType,
    discount: 0, // знижки у вікні немає (Сергій, 28.10.2026); 0 явно — щоб 1С не взяла її звідкись іще
    invoice_date: who.today,
    ...(form.dueDate ? { due_date: form.dueDate } : {}),
    manager: who.manager,
    comment: genesisComment(who.manager, dealId),
    deal_id: String(dealId),
    ...(form.requestId ? { request_id: form.requestId } : {}),
    ...(form.bankUid ? { bank_account: form.bankUid } : {}),
    ...(Object.keys(df).length ? { deal_fields: df } : {}),
    items: itemsOf(form),
    pdf: true,
    stamp: form.stamp,
  };
}

/**
 * Тіло `POST /updateInvoice` (1С 29.10.2026): ті самі поля + `invoice_uid`; позиції замінюються повністю. Організацію
 * й валюту 1С змінити не дасть — шлемо ті самі, а розбіжність сервер відсікає ще до запиту (`mount.ts`).
 * У `deal_fields` порожнє поле = очистити реквізит: менеджер міг стерти дату акту, тож шлемо обидва поля явно.
 */
export function buildUpdateInvoiceBody(invoiceUid: string, form: InvoiceForm, who: { manager: string; dealId: number; orgCode: string }) {
  return {
    invoice_uid: invoiceUid,
    organization: who.orgCode,
    agreement: form.agreement,
    currency: form.currency,
    vat_type: form.vatType,
    discount: 0,
    ...(form.dueDate ? { due_date: form.dueDate } : {}),
    comment: genesisComment(who.manager, who.dealId),
    ...(form.bankUid ? { bank_account: form.bankUid } : {}),
    deal_fields: { act_date: form.actDate || null, act_date_by_manager: !!form.actDate, crm_comment: form.crmComment || null },
    items: itemsOf(form),
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
  /** Номенклатура, яку 1С поставила в рядки: назва і код. */
  itemNames: string[];
  itemCodes: string[];
  updated: boolean;
  requestId: string;
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
      itemCodes: Array.isArray(j.items) ? j.items.map((x: any) => String(x?.code ?? "")) : [],
      updated: j.updated === true,
      requestId: String(j.request_id ?? ""),
      pdf: body ? { fileName: String(pf.file_name || `invoice_${j.invoice_number_print ?? j.invoice_number}.pdf`), bytes: Buffer.from(body, "base64") } : null,
    },
  };
}

/**
 * 1С поставила в рядок не ту послугу, що просили → кажемо менеджеру, а не ковтаємо. Звіряємо КОДИ, а не назви: назва
 * «Експедиторські послуги» в 1С має латинську «i» (лист 1С 28.10.2026), і порівняння назв кричало б щоразу хибно.
 */
const codeNorm = (c: string) => c.replace(/^0+/, "");
export function serviceSwaps(requested: { name: string; code: string }[], got: { name: string; code: string }[]): string[] {
  if (got.length !== requested.length) return [];
  return requested.flatMap((r, i) => (got[i] && got[i].code && r.code && codeNorm(got[i].code) !== codeNorm(r.code)
    ? [`1С поставила послугу «${got[i].name}» (${got[i].code}) замість «${r.name}» (${r.code}).`] : []));
}
export const codeOfService = (name: string) => SERVICES.find((x) => x.name === name)?.code ?? "";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Гривневий рахунок з печаткою важить ~1,7 МБ (лист 1С); перший запит після рестарту 1С — до 5 с; контрагент — ~6 с. */
const ONEC_TIMEOUT_MS = 30_000;

export async function createInvoiceIn1c(base: string, body: unknown, doFetch: FetchLike = fetch): Promise<OneCInvoiceResult> {
  return invoiceCall(base, "createInvoice", body, doFetch);
}
export async function updateInvoiceIn1c(base: string, body: unknown, doFetch: FetchLike = fetch): Promise<OneCInvoiceResult> {
  return invoiceCall(base, "updateInvoice", body, doFetch);
}
async function invoiceCall(base: string, method: "createInvoice" | "updateInvoice", body: unknown, doFetch: FetchLike): Promise<OneCInvoiceResult> {
  try {
    const r = await doFetch(`${base}/${method}`, {
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

/* ——— організації й банки (`GET /organizations`) ——— */

/** Відповідь 1С → банківські рахунки за кодом організації. Чиста. Лише поточні рахунки — 1С інші й не віддає. */
export function parseOrganizations(j: any): Map<string, BankAccount[]> | null {
  if (!j || j.state !== true || !Array.isArray(j.organizations)) return null;
  const out = new Map<string, BankAccount[]>();
  for (const o of j.organizations) {
    const code = String(o?.code ?? "");
    if (!code) continue;
    out.set(code, (Array.isArray(o.bank_accounts) ? o.bank_accounts : []).map((b: any) => ({
      uid: String(b?.uid ?? ""), name: String(b?.name ?? ""), iban: String(b?.iban ?? ""), currency: String(b?.currency ?? ""),
      bank: String(b?.bank ?? ""), isMain: b?.is_main === true,
    })).filter((b: BankAccount) => b.uid));
  }
  return out;
}

let orgCache: { at: number; data: Map<string, BankAccount[]> } | null = null;
/** Банки рідко міняються, а вікно відкривають часто — тримаємо 10 хв. Збій 1С → `null`, і ФОП у вікні недоступний. */
export async function organizationsFrom1c(base: string, doFetch: FetchLike = fetch, now = Date.now()): Promise<Map<string, BankAccount[]> | null> {
  if (orgCache && now - orgCache.at < 10 * 60_000) return orgCache.data;
  try {
    const r = await doFetch(`${base}/organizations`, { signal: AbortSignal.timeout(15_000) });
    const data = r.status === 200 ? parseOrganizations(await r.json().catch(() => null)) : null;
    if (data) orgCache = { at: now, data };
    return data;
  } catch {
    return null;
  }
}

/* ——— акт (`GET /realizationPdf?form=act`) ——— */

export type ActResult = { ok: true; bytes: Buffer } | { ok: false; notYet: boolean; why: string };

/**
 * PDF акту за рахунком — одним файлом (`format=file`): акт з печаткою важить ~2 МБ, а в JSON іде двічі (лист 1С).
 * Реалізації ще немає (`not_realized`) — це не помилка, а «ще рано»: вікно каже словами. Кілька реалізацій
 * (`multiple_realizations`) у `format=file` 1С не віддає — кажемо звернутись до бухгалтерії.
 */
export async function actPdfFrom1c(base: string, uid: string, stamp: boolean, doFetch: FetchLike = fetch): Promise<ActResult> {
  try {
    const q = new URLSearchParams({ invoice_uid: uid, form: "act", format: "file", ...(stamp ? {} : { stamp: "0" }) });
    const r = await doFetch(`${base}/realizationPdf?${q}`, { signal: AbortSignal.timeout(ONEC_TIMEOUT_MS) });
    if (r.status !== 200) return { ok: false, notYet: false, why: `1С відповіла ${r.status}.` };
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.subarray(0, 4).toString() === "%PDF") return { ok: true, bytes };
    return actRefusal(JSON.parse(bytes.toString("utf8") || "null"));
  } catch (e) {
    return { ok: false, notYet: false, why: (e as Error)?.name === "TimeoutError" ? "1С не відповіла за 30 с." : "1С недоступна." };
  }
}
export function actRefusal(j: any): ActResult {
  const code = String(j?.code ?? "");
  if (code === "not_realized") return { ok: false, notYet: true, why: "Акт ще не сформовано: бухгалтерія не провела реалізацію за цим рахунком." };
  if (code === "multiple_realizations") return { ok: false, notYet: false, why: "За рахунком кілька реалізацій — акти візьміть у бухгалтерії." };
  return { ok: false, notYet: false, why: `1С: ${String(j?.message ?? "акт не сформовано").slice(0, 300)}` };
}
