import { dedupeById } from "../jobs/dealContactPairs.js";
import { config } from "../config.js";

interface KommoListResponse<T> {
  _embedded?: Record<string, T[]>;
  _page?: number;
  _links?: { next?: { href: string } };
}

const MAX_RETRIES = 5;
// Hard ceiling per request: a silently-hung socket must not block a sync run
// forever (that froze the whole 5-min job). On timeout we abort and retry.
const REQUEST_TIMEOUT_MS = 60_000;

// Kommo's edge WAF (nginx) 403-bans requests that look automated. Node's fetch
// sends no User-Agent (or `undici`) — a classic WAF block trigger even when
// under the rate limit. Send a real browser-like UA + Accept on EVERY request.
const KOMMO_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// Global politeness throttle across ALL jobs: min gap between Kommo requests.
// Kommo's hard limit is 7 req/s and support confirmed the 08.07.2026 IP ban
// was for exceeding it — several jobs paginating at once easily spike past
// that. 350ms gap ≈ 3 req/s total (half the limit), applied before EVERY
// request; do not lower without re-reading developers.kommo.com/docs/limitations.
// 800ms ≈ 1.25 req/s — навмисно ДУЖЕ повільно (не 3, а ~1/с). Після IP-бану
// 08.07.2026 (WAF, зняли вручну) головна умова власника: тримати ОБСЯГ запитів
// малим, щоб не забанили знову. Темп + рідший полінг (index.ts) + менше вікно
// реконсиляції разом дають кратно менший потік. Довгостроково — вебхуки.
const MIN_REQUEST_GAP_MS = 800;
let throttleChain: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
  const slot = throttleChain.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS))
  );
  throttleChain = slot;
  return slot;
}

// Circuit breaker: after repeated 403s (Kommo WAF/account block) STOP sending —
// continued 403 traffic is what keeps an IP flagged and burns the support's
// patience. Back off for a cooldown, then let a few probe requests test the
// water. Any success clears it. This makes a block cost a handful of requests
// per COOLDOWN instead of a continuous stream.
const BAN_THRESHOLD = 5;
const BAN_COOLDOWN_MS = 15 * 60 * 1000;
let consecutive403 = 0;
let bannedUntil = 0;
// Лічильник 429 (rate-limit від Kommo). Поки 0 — глобальний лімітер не потрібен
// (домовленість: робимо його ЛИШЕ коли реально впремось у 429). Видно в /api/health.
let total429 = 0;
let last429At = 0;

export function kommoCircuitState(): {
  paused: boolean;
  bannedUntil: number;
  consecutive403: number;
  total429: number;
  last429At: number;
} {
  return { paused: Date.now() < bannedUntil, bannedUntil, consecutive403, total429, last429At };
}

async function kommoRequest<T>(path: string, attempt = 0): Promise<T> {
  if (Date.now() < bannedUntil) {
    const mins = Math.ceil((bannedUntil - Date.now()) / 60000);
    throw new Error(`Kommo circuit open: пауза ще ~${mins} хв після серії 403 (можлива блокування IP/акаунта)`);
  }
  await throttle();
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(`${config.kommo.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${config.kommo.token}`,
          "Content-Type": "application/json",
          ...KOMMO_HEADERS,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Kommo occasionally drops the HTTP/2 connection mid-request (or our abort
    // timeout fires); retry these transient network errors the same as a 429.
    if (attempt < MAX_RETRIES) {
      const delayMs = 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return kommoRequest<T>(path, attempt + 1);
    }
    throw err;
  }
  if (res.status === 204) {
    return {} as T;
  }
  if (res.status === 429) {
    // Rate-limit від Kommo. Логуємо ГУЧНО + рахуємо (домовленість: глобальний лімітер
    // робимо лише коли реально почнемо впиратись у 429). Retry-After, якщо є, інакше
    // експоненційний backoff.
    total429 += 1;
    last429At = Date.now();
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    console.warn(`Kommo 429 (rate limit) на ${path} — total429=${total429}, чекаю ${delayMs}мс (attempt ${attempt}).`);
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return kommoRequest<T>(path, attempt + 1);
    }
  }
  if (res.status === 403) {
    // WAF/account block. Trip the breaker after a short streak so we stop
    // generating 403 traffic instead of hammering a blocked endpoint.
    if (++consecutive403 >= BAN_THRESHOLD) {
      bannedUntil = Date.now() + BAN_COOLDOWN_MS;
      consecutive403 = 0;
      console.error(`Kommo 403 streak → circuit open for ${BAN_COOLDOWN_MS / 60000} min`);
    }
    throw new Error(`Kommo API error 403: ${await res.text()}`);
  }
  if (!res.ok) {
    throw new Error(`Kommo API error ${res.status}: ${await res.text()}`);
  }
  consecutive403 = 0;
  bannedUntil = 0;
  return res.json() as Promise<T>;
}

/** Throttled GET for one-off jobs that need raw paths — the ONLY sanctioned
 *  way to read Kommo outside the fetch* helpers below (keeps the rate cap). */
export async function kommoGet<T>(path: string): Promise<T> {
  return kommoRequest<T>(path);
}

/** POST/PATCH helper for Kommo writes (lead creation, notes, tags). */
export async function kommoWrite<T>(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST"
): Promise<T> {
  await throttle();
  const res = await fetch(`${config.kommo.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.kommo.token}`,
      "Content-Type": "application/json",
      ...KOMMO_HEADERS,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Kommo write ${method} ${path} failed ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export interface KommoFieldValue {
  field_id?: number;
  field_code?: string | null;
  values?: { value?: unknown }[];
}

export interface KommoDeal {
  id: number;
  name: string;
  price: number;
  pipeline_id: number;
  status_id: number;
  responsible_user_id: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  custom_fields_values?: KommoFieldValue[] | null;
  _embedded?: {
    contacts?: { id: number; is_main?: boolean }[];
    companies?: { id: number; is_main?: boolean }[];
  };
}

// Kommo custom-field ids for lead-source attribution (leads/custom_fields).
const FIELD_UTM_SOURCE = 481993;
const FIELD_LEAD_GENERATOR = 2098037; // "Лидогенератор"
const FIELD_CLIENT_SOURCE = 2098035; // "Источник клиента"
// "Приход 1 Тип оплаты": Наличные / Безнал с НДС / Безнал без НДС / ВАЛЮТА.
const FIELD_PAYMENT_TYPE = 2097629;
// "Розрахунок приходів" — the deal's total income (sum of all «Приход» lines),
// the real revenue vs. the calculator budget (`price`). Fallback: «Приход 1».
const FIELD_INCOME_TOTAL = 2097649;
const FIELD_INCOME_1 = 2097627;
// Фінансовий якір (Правило №1 глосарію): дата акту/розвантаження — коли
// послугу фактично надано. Kommo віддає date-поля юнікс-секундами (рядком).
const FIELD_UNLOAD_DATE = 463253; // «Дата выгрузки (Дата акта)»
const FIELD_LOAD_DATE = 473637; // «Дата загрузки» — операційне поле, НЕ якір
const FIELD_PLANNED_PAYMENT = 2097273; // «Запланована дата оплати» (Р2 — сума очікування)
// «Причина отказа» (select) — причина відмови ліда. Нецільові (owner) = ад ∩
// {«Дубль» enum 6340789, «Перевізник» enum 6343043}. Зберігаємо ТЕКСТ значення (label).
const FIELD_REJECT_REASON = 2097265;
// Web/гео-мітки реклами (КРОК 6 — конверсія реклами по каналах). field_id звірені
// з docs/CRM_SCHEMA.md §трекінг. TRAF_SRC/TRAF_TYPE — text-поля Kommo (не
// tracking_data), заповнюються і для органіки; TRAF_TYPE ∈ cpc/organic/referral/none.
const FIELD_UTM_MEDIUM = 481995; // utm_medium (tracking_data: cpc) — платний сигнал utm-покоління
const FIELD_UTM_CAMPAIGN = 481997; // utm_campaign (tracking_data)
const FIELD_ADV_CAMP = 2098331; // ADV_CAMP (text)
const FIELD_TRAF_SRC = 2098327; // TRAF_SRC (text)
const FIELD_TRAF_TYPE = 2098329; // TRAF_TYPE (text: cpc/organic/referral/none)
// «Мінусова угода» (select): «Мінус» = сторно/повернення. Kommo-бюджет завжди додатний;
// саме ЦЕ поле (не слово в назві) визначає знак: price = is_minus ? -abs(budget) : +abs.
const FIELD_MINUS = 2098529;
// Блок B (логістика). «Тип запиту» (напрямок): По Україні / Міжнародні / Домашній переїзд.
const FIELD_REQUEST_TYPE = 2097965;
// «Канал продажу»: Нові клієнти / Постійні клієнти / Тендерний напрямок.
const FIELD_SALES_CHANNEL = 2099549;

function fieldDate(deal: KommoDeal, fieldId: number): Date | null {
  const raw = fieldText(deal, fieldId);
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** «Дата выгрузки (Дата акта)» — фінансовий якір угоди. */
export function extractUnloadDate(deal: KommoDeal): Date | null {
  return fieldDate(deal, FIELD_UNLOAD_DATE);
}

/** «Запланована дата оплати» (2097273) — обіцяна клієнтом дата оплати (Р2). */
export function extractPlannedPaymentDate(deal: KommoDeal): Date | null {
  return fieldDate(deal, FIELD_PLANNED_PAYMENT);
}

/** «Дата загрузки» — операційна дата початку перевезення. */
export function extractLoadDate(deal: KommoDeal): Date | null {
  return fieldDate(deal, FIELD_LOAD_DATE);
}

/** Total income ("приход") of the deal — real revenue, not the budget. */
export function extractIncomeAmount(deal: KommoDeal): number | null {
  const total = Number(fieldText(deal, FIELD_INCOME_TOTAL) ?? "");
  if (Number.isFinite(total) && total > 0) return total;
  const first = Number(fieldText(deal, FIELD_INCOME_1) ?? "");
  return Number.isFinite(first) && first > 0 ? first : null;
}

/** Payment form of the deal ("форма расчета"), e.g. "Безнал с НДС". */
export function extractPaymentType(deal: KommoDeal): string | null {
  return fieldText(deal, FIELD_PAYMENT_TYPE);
}

/** «Причина отказа» (поле 2097265) — текст значення (напр. «Дубль», «Перевізник»). */
export function extractRejectReason(deal: KommoDeal): string | null {
  return fieldText(deal, FIELD_REJECT_REASON);
}

/** Блок B — «Тип запиту» (2097965): напрямок По Україні / Міжнародні / Домашній переїзд. */
export function extractRequestType(deal: KommoDeal): string | null {
  return fieldText(deal, FIELD_REQUEST_TYPE);
}

/** Блок B — «Канал продажу» (2099549): Нові / Постійні / Тендерний напрямок. */
export function extractSalesChannel(deal: KommoDeal): string | null {
  return fieldText(deal, FIELD_SALES_CHANNEL);
}

/**
 * «Мінусова угода» = «Мінус» (поле 2098529) → сторно/повернення: бюджет має відніматись.
 * ЄДИНЕ джерело знаку (не слово в назві). Порожнє/«Ні» → false.
 */
export function extractIsMinus(deal: KommoDeal): boolean {
  return (fieldText(deal, FIELD_MINUS) ?? "").trim().toLowerCase() === "мінус";
}
// "Продзвін" pipelines are run by the lead-generation department.
const LEADGEN_PIPELINES = new Set([8921936, 7337048]);
// "Источник клиента" values that represent paid/marketing inbound traffic.
const AD_CLIENT_SOURCES = new Set(["Google", "Реактивация ретаргетом"]);

function fieldText(deal: KommoDeal, fieldId: number): string | null {
  const f = deal.custom_fields_values?.find((v) => v.field_id === fieldId);
  const raw = f?.values?.[0]?.value;
  const text = raw == null ? "" : String(raw).trim();
  return text.length ? text : null;
}

export interface LeadSource {
  utmSource: string | null;
  leadGenerator: string | null;
  clientSource: string | null;
  channel: "ad" | "leadgen" | "other";
}

/**
 * Classifies a deal's lead origin into the two tracked channels the sales
 * team cares about — paid ads/targeting vs. the lead-generation department —
 * keeping the raw field values so the rule can be refined later in SQL.
 */
export function extractLeadSource(deal: KommoDeal): LeadSource {
  const utmSource = fieldText(deal, FIELD_UTM_SOURCE);
  const leadGenerator = fieldText(deal, FIELD_LEAD_GENERATOR);
  const clientSource = fieldText(deal, FIELD_CLIENT_SOURCE);

  let channel: LeadSource["channel"] = "other";
  if (leadGenerator || LEADGEN_PIPELINES.has(deal.pipeline_id)) {
    channel = "leadgen";
  } else if (utmSource || (clientSource && AD_CLIENT_SOURCES.has(clientSource))) {
    channel = "ad";
  }

  return { utmSource, leadGenerator, clientSource, channel };
}

export interface WebTags {
  utmMedium: string | null;
  utmCampaign: string | null;
  advCamp: string | null;
  trafSrc: string | null;
  trafType: string | null;
}

/**
 * Web/гео-мітки реклами угоди (utm_medium / utm_campaign / ADV_CAMP / TRAF_SRC /
 * TRAF_TYPE) — сирі значення з Kommo для майбутньої конверсії реклами (КРОК 6).
 * Два ВЗАЄМОВИКЛЮЧНІ покоління міток: utm-покоління (utm_*) і TRAF-покоління
 * (ADV_CAMP/TRAF_*). Платний сигнал живе в РІЗНИХ полях: utm_medium='cpc' АБО
 * traf_type='cpc'. Тут ЛИШЕ витягуємо; бізнес-правило (paid) — GLOSSARY.
 */
export function extractWebTags(deal: KommoDeal): WebTags {
  return {
    utmMedium: fieldText(deal, FIELD_UTM_MEDIUM),
    utmCampaign: fieldText(deal, FIELD_UTM_CAMPAIGN),
    advCamp: fieldText(deal, FIELD_ADV_CAMP),
    trafSrc: fieldText(deal, FIELD_TRAF_SRC),
    trafType: fieldText(deal, FIELD_TRAF_TYPE),
  };
}

/**
 * Fetches leads updated since `updatedAfter` (unix seconds). Pass undefined
 * only for a deliberate full historical import — on a large, long-lived
 * account this can mean tens of thousands of leads across many pages.
 */
async function fetchLeadsPage(page: number, limit: number, filter: string): Promise<KommoDeal[]> {
  const data = await kommoRequest<KommoListResponse<KommoDeal>>(
    `/api/v4/leads?page=${page}&limit=${limit}&with=contacts,companies${filter}`
  );
  return data._embedded?.leads ?? [];
}

const PAGE_FETCH_CONCURRENCY = 3;

/** Fetches specific leads by id (up to 250 per call) with their custom fields. */
export async function fetchLeadsByIds(ids: number[]): Promise<KommoDeal[]> {
  if (ids.length === 0) return [];
  const idFilter = ids.map((id) => `filter[id][]=${id}`).join("&");
  const data = await kommoRequest<KommoListResponse<KommoDeal>>(
    `/api/v4/leads?limit=250&with=contacts,companies&${idFilter}`
  );
  return data._embedded?.leads ?? [];
}

/**
 * Streams leads page-by-page, invoking `onBatch` for each batch instead of
 * accumulating everything in memory — required for full-history passes where
 * holding all leads at once is too heavy.
 */
export async function forEachDealPage(
  onBatch: (batch: KommoDeal[]) => Promise<void>,
  createdAfter?: number
): Promise<void> {
  const limit = 250;
  const filter = createdAfter
    ? `&${encodeURIComponent("filter[created_at][from]")}=${createdAfter}`
    : "";
  let page = 1;
  let exhausted = false;
  while (!exhausted) {
    const batch = await fetchLeadsPage(page, limit, filter);
    if (batch.length > 0) await onBatch(batch);
    if (batch.length < limit) exhausted = true;
    page += 1;
  }
}

export async function fetchAllDeals(
  updatedAfter?: number,
  createdAfter?: number
): Promise<KommoDeal[]> {
  const deals: KommoDeal[] = [];
  const limit = 250;
  let filter = updatedAfter
    ? `&${encodeURIComponent("filter[updated_at][from]")}=${updatedAfter}`
    : "";
  if (createdAfter) {
    filter += `&${encodeURIComponent("filter[created_at][from]")}=${createdAfter}`;
  }

  let page = 1;
  let exhausted = false;
  while (!exhausted) {
    const pageNumbers = Array.from({ length: PAGE_FETCH_CONCURRENCY }, (_, i) => page + i);
    const batches = await Promise.all(
      pageNumbers.map((p) => fetchLeadsPage(p, limit, filter))
    );
    for (const batch of batches) {
      deals.push(...batch);
      if (batch.length < limit) {
        exhausted = true;
      }
    }
    page += PAGE_FETCH_CONCURRENCY;
  }

  // 🔴 ДЕДУП ЗА id — ЦЕ ПРИЧИНА, А НЕ ПЕРЕСТРАХОВКА. Сторінки тягнуться ПАРАЛЕЛЬНО
  // (PAGE_FETCH_CONCURRENCY), а `filter[updated_at][from]` + пагінація не дають
  // стабільного знімка: угоду, яку оновили між запитами сусідніх сторінок, зсуває,
  // і вона потрапляє у ДВІ сторінки одразу. 03.08.2026 це поклало синк — дубльована
  // угода давала дубльовану пару (угода, контакт), а Postgres не дозволяє одному
  // `ON CONFLICT DO UPDATE` зачепити рядок двічі.
  //
  // Останнє входження перемагає: пізніша сторінка — свіжіший знімок.
  return dedupeById(deals);
}

export interface KommoUser {
  id: number;
  name: string;
  email?: string;
  rights: { is_active: boolean };
  _embedded?: {
    groups?: { id: number; name: string }[];
    roles?: { id: number; name: string }[];
  };
}

export async function fetchUsers(): Promise<KommoUser[]> {
  const data = await kommoRequest<KommoListResponse<KommoUser>>(
    "/api/v4/users?limit=250&with=group,role"
  );
  const users = data._embedded?.users ?? [];
  return users.filter((user) => user.rights?.is_active);
}

interface KommoCustomFieldValue {
  field_code: string | null;
  values: { value: string }[];
}

export interface KommoContact {
  id: number;
  name: string;
  custom_fields_values?: KommoCustomFieldValue[] | null;
}

export function extractPhone(contact: KommoContact): string | null {
  const phoneField = contact.custom_fields_values?.find((f) => f.field_code === "PHONE");
  return phoneField?.values?.[0]?.value ?? null;
}

async function fetchContactsPage(page: number, limit: number): Promise<KommoContact[]> {
  const data = await kommoRequest<KommoListResponse<KommoContact>>(
    `/api/v4/contacts?page=${page}&limit=${limit}`
  );
  return data._embedded?.contacts ?? [];
}

export async function fetchAllContacts(): Promise<KommoContact[]> {
  const contacts: KommoContact[] = [];
  const limit = 250;
  let page = 1;
  let exhausted = false;
  while (!exhausted) {
    const pageNumbers = Array.from({ length: PAGE_FETCH_CONCURRENCY }, (_, i) => page + i);
    const batches = await Promise.all(
      pageNumbers.map((p) => fetchContactsPage(p, limit))
    );
    for (const batch of batches) {
      contacts.push(...batch);
      if (batch.length < limit) {
        exhausted = true;
      }
    }
    page += PAGE_FETCH_CONCURRENCY;
  }
  return contacts;
}

/** Fetches specific contacts by id (up to 250 per call). */
export async function fetchContactsByIds(ids: number[]): Promise<KommoContact[]> {
  if (ids.length === 0) return [];
  const idFilter = ids.map((id) => `filter[id][]=${id}`).join("&");
  const data = await kommoRequest<KommoListResponse<KommoContact>>(
    `/api/v4/contacts?limit=250&${idFilter}`
  );
  return data._embedded?.contacts ?? [];
}

export interface KommoCompany {
  id: number;
  name: string;
  /**
   * 🏢 Кастом-поля компанії. Kommo віддає їх у ТІЙ САМІЙ відповіді, яку синк уже
   * отримує заради `name`, — тож читання коду (ЄДРПОУ/ІПН) не коштує жодного
   * додаткового запиту. Той самий прийом, що з `deal._embedded.contacts`.
   */
  custom_fields_values?: KommoFieldValue[] | null;
}

/** Кастом-поля компанії з кодами. Розбір і межі — `core/companyCode.ts`. */
export const COMPANY_FIELD_EDRPOU = 466493;
export const COMPANY_FIELD_IPN = 463931;

/** Значення кастом-поля компанії як рядок (перше зі списку). */
export function companyFieldValue(co: KommoCompany, fieldId: number): string | null {
  const f = co.custom_fields_values?.find((v) => v.field_id === fieldId);
  const v = f?.values?.[0]?.value;
  return v == null ? null : String(v);
}

/** Fetches specific companies by id (up to 250 per call). */
export async function fetchCompaniesByIds(ids: number[]): Promise<KommoCompany[]> {
  if (ids.length === 0) return [];
  const idFilter = ids.map((id) => `filter[id][]=${id}`).join("&");
  const data = await kommoRequest<KommoListResponse<KommoCompany>>(
    `/api/v4/companies?limit=250&${idFilter}`
  );
  return data._embedded?.companies ?? [];
}

async function fetchCompaniesPage(page: number, limit: number): Promise<KommoCompany[]> {
  const data = await kommoRequest<KommoListResponse<KommoCompany>>(
    `/api/v4/companies?page=${page}&limit=${limit}`
  );
  return data._embedded?.companies ?? [];
}

export interface KommoStatusEvent {
  entityId: number;
  statusId: number;
  pipelineId: number | null;
  changedAt: number; // unix seconds — when the status actually changed
}

interface KommoEvent {
  entity_id: number;
  created_at: number;
  value_after?: { lead_status?: { id: number; pipeline_id?: number } }[];
}

/**
 * Streams `lead_status_changed` events in [fromUnix, toUnix], invoking `onPage`
 * per page so a large backfill never holds the whole history in memory. This is
 * the authoritative source of stage-entry timestamps (Kommo records every
 * status move), used to count period metrics by entry date rather than close
 * date. Returns the total number of events processed.
 */
/** Задача Kommo — рівно ті поля, що зберігаються (без `text`/`result`). */
export interface KommoTask {
  id: number;
  entityId: number;
  entityType: string | null;
  createdBy: number;
  updatedBy: number;
  responsibleUserId: number | null;
  taskTypeId: number | null;
  isCompleted: boolean;
  createdAt: number;
  updatedAt: number;
  completeTill: number | null;
  duration: number | null;
}

interface KommoTaskRaw {
  id: number; entity_id: number; entity_type?: string | null;
  created_by?: number; updated_by?: number; responsible_user_id?: number;
  task_type_id?: number; is_completed?: boolean;
  created_at: number; updated_at: number; complete_till?: number; duration?: number;
  text?: string; result?: unknown;   // 🔒 оголошені, щоб було видно: ми їх НЕ беремо
}

/**
 * Задачі за вікном `updated_at`, посторінково.
 *
 * 🔴 ВІКНО САМЕ ПО `updated_at`, а не `created_at`: закриття задачі, створеної рік
 * тому, — це вчорашня дія. Заміряно: 76 таких задач за 14 днів, 52 активні угоди;
 * фільтр по `created_at` їх не бачить.
 *
 * ⚠️ ПОВНОТА ДОВОДИТЬСЯ КОРОТКОЮ СТОРІНКОЮ, а не довірою до ліміту. Перший замір
 * 11.08.2026 обрізав пагінацію на 40 сторінках і дав «0 задач за 14 днів» — тобто
 * стелю, подану як факт. Тут цикл іде, доки сторінка ПОВНА; захисна стеля названа
 * окремо й ГУЧНО, щоб її не можна було прочитати як «дані скінчились».
 */
export async function forEachTaskPage(
  fromUnix: number,
  toUnix: number,
  onPage: (tasks: KommoTask[]) => Promise<void>,
  maxPages = 2000
): Promise<number> {
  const limit = 250;
  let page = 1;
  let total = 0;
  for (;;) {
    const data = await kommoRequest<{ _embedded?: { tasks?: KommoTaskRaw[] } }>(
      `/api/v4/tasks?limit=${limit}&page=${page}` +
        `&${encodeURIComponent("filter[updated_at][from]")}=${fromUnix}` +
        `&${encodeURIComponent("filter[updated_at][to]")}=${toUnix}`
    );
    const raw = data._embedded?.tasks ?? [];
    if (raw.length) {
      await onPage(raw.map((t) => ({
        id: t.id,
        entityId: t.entity_id,
        entityType: t.entity_type ?? null,
        createdBy: t.created_by ?? 0,
        updatedBy: t.updated_by ?? 0,
        responsibleUserId: t.responsible_user_id ?? null,
        taskTypeId: t.task_type_id ?? null,
        isCompleted: t.is_completed === true,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        completeTill: t.complete_till ?? null,
        duration: t.duration ?? null,
      })));
      total += raw.length;
    }
    if (raw.length < limit) break;      // ← коротка сторінка = вибірку вичерпано
    if (++page > maxPages) {
      console.error(`🔴 forEachTaskPage: ${maxPages} сторінок у вікні ${fromUnix}..${toUnix} — `
        + "це СТЕЛЯ, а не кінець даних. Вибірка НЕПОВНА, звузь порцію.");
      break;
    }
  }
  return total;
}

export async function forEachStatusChangeEventPage(
  fromUnix: number,
  toUnix: number,
  onPage: (events: KommoStatusEvent[]) => Promise<void>
): Promise<number> {
  const limit = 100;
  let page = 1;
  let total = 0;
  for (;;) {
    const data = await kommoRequest<KommoListResponse<KommoEvent>>(
      `/api/v4/events?limit=${limit}&page=${page}` +
        `&filter[type]=lead_status_changed` +
        `&${encodeURIComponent("filter[created_at][from]")}=${fromUnix}` +
        `&${encodeURIComponent("filter[created_at][to]")}=${toUnix}`
    );
    const raw = data._embedded?.events ?? [];
    const events: KommoStatusEvent[] = [];
    for (const e of raw) {
      const st = e.value_after?.[0]?.lead_status;
      if (!st) continue;
      events.push({
        entityId: e.entity_id,
        statusId: st.id,
        pipelineId: st.pipeline_id ?? null,
        changedAt: e.created_at,
      });
    }
    if (events.length) {
      await onPage(events);
      total += events.length;
    }
    if (raw.length < limit || !data._links?.next) break;
    page += 1;
  }
  return total;
}

export interface KommoResponsibleEvent {
  entityId: number;
  toUserId: number | null;
  changedAt: number; // unix seconds
}

interface KommoRespRaw {
  entity_id: number;
  entity_type: string;
  created_at: number;
  value_after?: { responsible_user?: { id: number } }[];
}

/**
 * Streams entity_responsible_changed events (lead responsible reassignments) in
 * [fromUnix, toUnix] per page. This is how a lead-gen lead being "taken" by a
 * sales manager is detected — the same trigger as the Telegram alert.
 */
export async function forEachResponsibleChangeEventPage(
  fromUnix: number,
  toUnix: number,
  onPage: (events: KommoResponsibleEvent[]) => Promise<void>
): Promise<number> {
  const limit = 100;
  let page = 1;
  let total = 0;
  for (;;) {
    const data = await kommoRequest<KommoListResponse<KommoRespRaw>>(
      `/api/v4/events?limit=${limit}&page=${page}` +
        `&filter[type]=entity_responsible_changed` +
        `&${encodeURIComponent("filter[created_at][from]")}=${fromUnix}` +
        `&${encodeURIComponent("filter[created_at][to]")}=${toUnix}`
    );
    const raw = data._embedded?.events ?? [];
    const events: KommoResponsibleEvent[] = [];
    for (const e of raw) {
      if (e.entity_type !== "lead") continue;
      events.push({
        entityId: e.entity_id,
        toUserId: e.value_after?.[0]?.responsible_user?.id ?? null,
        changedAt: e.created_at,
      });
    }
    if (events.length) {
      await onPage(events);
      total += events.length;
    }
    if (raw.length < limit || !data._links?.next) break;
    page += 1;
  }
  return total;
}

export async function fetchAllCompanies(): Promise<KommoCompany[]> {
  const companies: KommoCompany[] = [];
  const limit = 250;
  let page = 1;
  let exhausted = false;
  while (!exhausted) {
    const pageNumbers = Array.from({ length: PAGE_FETCH_CONCURRENCY }, (_, i) => page + i);
    const batches = await Promise.all(
      pageNumbers.map((p) => fetchCompaniesPage(p, limit))
    );
    for (const batch of batches) {
      companies.push(...batch);
      if (batch.length < limit) {
        exhausted = true;
      }
    }
    page += PAGE_FETCH_CONCURRENCY;
  }
  return companies;
}

export interface KommoLeadNote {
  entityId: number;
  createdBy: number; // Kommo user id; 0 = system/Salesbot
  createdAt: number; // unix seconds
  noteType: string;
  /**
   * 🔴 ТРИВАЛІСТЬ РОЗМОВИ, с — для `call_in`/`call_out`; `null` там, де її немає.
   *
   * Kommo кладе її в `params.duration` (джерело Ringostat), а ми досі відкидали
   * `params` цілком. Наслідок був не косметичний: «застряглі угоди» зараховують
   * дзвінок активністю БЕЗ перевірки тривалості, тож дзвінок на **0 секунд**
   * («не додзвонився», `call_status: 6`) скидає лічильник застрягання й ХОВАЄ
   * угоду зі списку. Заміряно: 8 із 26 угод, де остання активність — дзвінок,
   * мали саме нульовий.
   *
   * ⚠️ `null` означає «НЕ ЗНАЄМО», а не «нуль». Не-Ringostat нотатки й нетелефонні
   * типи `params` не мають; читач зобов'язаний розрізняти ці випадки, інакше
   * «немає даних» тихо перетвориться на «дзвінка не було».
   */
  durationSec: number | null;
}

interface KommoNoteRaw {
  entity_id: number;
  created_by: number;
  created_at: number;
  note_type: string;
  params?: { duration?: number | string | null } | null;
}

/** `params.duration` → секунди. Нечислове/відсутнє → `null` («не знаємо»). */
function noteDuration(n: KommoNoteRaw): number | null {
  const d = n.params?.duration;
  if (d == null) return null;
  const v = typeof d === "string" ? Number(d) : d;
  return Number.isFinite(v) ? v : null;
}

/**
 * Streams lead notes (calls, texts, manual notes) updated in [fromUnix, toUnix]
 * per page. This is the real-activity signal for "stuck deals": a note made by
 * an actual user (created_by != 0) means a human worked the deal, independent of
 * whatever Salesbot does to the lead's updated_at. Returns total notes seen.
 */
export async function forEachLeadNotePage(
  fromUnix: number,
  toUnix: number,
  onPage: (notes: KommoLeadNote[]) => Promise<void>
): Promise<number> {
  return forEachNotePage("leads", fromUnix, toUnix, onPage);
}

// Спільне ядро пагінації нотаток (leads | contacts) — щоб два проходи не розʼїхались у
// поведінці (ліміт, умова виходу, форма KommoLeadNote). Бекоф/429/403 живе в kommoRequest.
type NoteEntity = "leads" | "contacts";
async function forEachNotePage(
  entity: NoteEntity,
  fromUnix: number,
  toUnix: number,
  onPage: (notes: KommoLeadNote[]) => Promise<void>
): Promise<number> {
  const limit = 250;
  let page = 1;
  let total = 0;
  for (;;) {
    const data = await kommoRequest<KommoListResponse<KommoNoteRaw>>(
      `/api/v4/${entity}/notes?limit=${limit}&page=${page}` +
        `&${encodeURIComponent("filter[updated_at][from]")}=${fromUnix}` +
        `&${encodeURIComponent("filter[updated_at][to]")}=${toUnix}`
    );
    const raw = data._embedded?.notes ?? [];
    const notes: KommoLeadNote[] = raw.map((n) => ({
      entityId: n.entity_id,
      createdBy: n.created_by,
      createdAt: n.created_at,
      noteType: n.note_type,
      durationSec: noteDuration(n),
    }));
    if (notes.length) {
      await onPage(notes);
      total += notes.length;
    }
    if (raw.length < limit || !data._links?.next) break;
    page += 1;
  }
  return total;
}

async function forEachNotePageByIds(
  entity: NoteEntity,
  ids: number[],
  onPage: (notes: KommoLeadNote[]) => Promise<void>
): Promise<number> {
  if (ids.length === 0) return 0;
  const limit = 250;
  const idFilter = ids.map((id) => `${encodeURIComponent("filter[entity_id][]")}=${id}`).join("&");
  let page = 1;
  let total = 0;
  for (;;) {
    const data = await kommoRequest<KommoListResponse<KommoNoteRaw>>(
      `/api/v4/${entity}/notes?limit=${limit}&page=${page}&${idFilter}`
    );
    const raw = data._embedded?.notes ?? [];
    const notes: KommoLeadNote[] = raw.map((n) => ({
      entityId: n.entity_id,
      createdBy: n.created_by,
      createdAt: n.created_at,
      noteType: n.note_type,
      durationSec: noteDuration(n),
    }));
    if (notes.length) {
      await onPage(notes);
      total += notes.length;
    }
    if (raw.length < limit || !data._links?.next) break;
    page += 1;
  }
  return total;
}

/**
 * Те саме для нотаток КОНТАКТІВ. Kommo вішає телефонію (Ringostat) на КОНТАКТ, а не на
 * лід — у стрічці угоди дзвінок видно лише через звʼязок. Тому `/leads/notes` їх не
 * повертає взагалі (перевірено 30.07.2026 на угоді 61986895: 0 дзвінків у нотатках ліда,
 * 5 call_out на її контакті). Дзеркало `forEachLeadNotePage` — та сама пагінація й фільтр.
 */
export async function forEachContactNotePage(
  fromUnix: number,
  toUnix: number,
  onPage: (notes: KommoLeadNote[]) => Promise<void>
): Promise<number> {
  return forEachNotePage("contacts", fromUnix, toUnix, onPage);
}

/** Нотатки КОНТАКТІВ по конкретних id — живить самолікування/бекфіл (батчами ≤100 id). */
export async function forEachContactNotePageByIds(
  ids: number[],
  onPage: (notes: KommoLeadNote[]) => Promise<void>
): Promise<number> {
  return forEachNotePageByIds("contacts", ids, onPage);
}

/**
 * Streams lead notes for a SPECIFIC set of lead ids (`filter[entity_id][]`), all
 * note types, paginated. Живить цільовий бекфіл last_call_at: замість сканувати рік
 * усіх нотаток компанії (~сотні тис.), тягнемо нотатки лише активних FC-угод по їхніх
 * id (обмежений набір). Kommo обмежує довжину URL — викликати БАТЧАМИ (≤100 id).
 */
export async function forEachLeadNotePageByIds(
  ids: number[],
  onPage: (notes: KommoLeadNote[]) => Promise<void>
): Promise<number> {
  return forEachNotePageByIds("leads", ids, onPage);
}
