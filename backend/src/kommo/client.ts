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

async function kommoRequest<T>(path: string, attempt = 0): Promise<T> {
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(`${config.kommo.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${config.kommo.token}`,
          "Content-Type": "application/json",
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
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const delayMs = 1000 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return kommoRequest<T>(path, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Kommo API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** POST/PATCH helper for Kommo writes (lead creation, notes, tags). */
export async function kommoWrite<T>(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST"
): Promise<T> {
  const res = await fetch(`${config.kommo.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.kommo.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Kommo write ${method} ${path} failed ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

interface KommoFieldValue {
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

/** Payment form of the deal ("форма расчета"), e.g. "Безнал с НДС". */
export function extractPaymentType(deal: KommoDeal): string | null {
  return fieldText(deal, FIELD_PAYMENT_TYPE);
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

  return deals;
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
}

interface KommoNoteRaw {
  entity_id: number;
  created_by: number;
  created_at: number;
  note_type: string;
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
  const limit = 250;
  let page = 1;
  let total = 0;
  for (;;) {
    const data = await kommoRequest<KommoListResponse<KommoNoteRaw>>(
      `/api/v4/leads/notes?limit=${limit}&page=${page}` +
        `&${encodeURIComponent("filter[updated_at][from]")}=${fromUnix}` +
        `&${encodeURIComponent("filter[updated_at][to]")}=${toUnix}`
    );
    const raw = data._embedded?.notes ?? [];
    const notes: KommoLeadNote[] = raw.map((n) => ({
      entityId: n.entity_id,
      createdBy: n.created_by,
      createdAt: n.created_at,
      noteType: n.note_type,
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
