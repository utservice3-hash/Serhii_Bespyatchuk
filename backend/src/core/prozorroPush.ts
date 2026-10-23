/**
 * 🏛 PROZORRO-ЛІДИ — ЗАПИС У KOMMO (задача #5299, прохід 2; рішення TOP Weekly 22.10.2026 + Роман).
 *
 * Куди (усе створено в Kommo 22.10.2026 через API, звірено):
 *  · воронка «Продзвін» 8921936, етап «Тендер AI» 113258624 — як холодна база, окремої воронки НЕ робимо;
 *  · «Источник клиента» = «AI тендер»: на угоді (поле 2098035, значення 6348927) і на КОНТАКТІ (поле 2097595, значення
 *    6348929) — Олександр: «тегати контакт», бо угода закриється, а контакт лишиться; плюс тег «AI тендер»;
 *  · веде ОДИН лідоген, вибраний у «Налаштуваннях» (`prozorro_settings`); не вибраний або неактивний — НЕ пишемо;
 *  · компанія з таким ЄДРПОУ вже є в Kommo — нову НЕ створюємо, угода нова («працюємо як з новою угодою»).
 *
 * Чого НЕ робимо: наявні компанії, контакти й угоди не змінюємо, відповідальних не міняємо, нічого не закриваємо й не
 * видаляємо. Бюджет угоди порожній: сума тендера — закупівля клієнта, а не наша маржа; вона в примітці.
 *
 * Модуль без мережі й пулу: Kommo і сховище приходять ззовні, гейти ганяють прохід без CRM.
 */

export const PZ_PIPELINE = 8921936;
export const PZ_TENDER_STATUS = 113258624;
export const LEAD_SOURCE_FIELD = 2098035;
export const LEAD_SOURCE_AI_TENDER = 6348927;
export const CONTACT_SOURCE_FIELD = 2097595;
export const CONTACT_SOURCE_AI_TENDER = 6348929;
export const COMPANY_EDRPOU_FIELD = 466493;
export const AI_TENDER_TAG = "AI тендер";
/** Після стількох невдалих спроб рядок більше не пробуємо — він лишається в таблиці з причиною. */
export const MAX_PUSH_ATTEMPTS = 3;
export const DEFAULT_PUSH_LIMIT = 50;

/** Режим із змінної `PROZORRO_LEADS`: «off» — нічого; «live» — збір + запис у Kommo; будь-що інше — пробний. */
export type PzMode = "off" | "dry" | "live";
export function pzMode(raw: string | null | undefined): PzMode {
  const v = (raw ?? "").trim();
  return v === "off" ? "off" : v === "live" ? "live" : "dry";
}

/** Рядок, що чекає запису в Kommo (з `prozorro_leads`). */
export interface PendingLead {
  id: number;
  edrpou: string;
  uaId: string;
  companyName: string;
  address: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  title: string | null;
  card: string;
  kommoCompanyExisting: number | null;
}

/** Хто веде: вибраний у налаштуваннях лідоген. Неактивний або без акаунта Kommo — як не вибраний. */
export interface Responsible { managerId: number; name: string; kommoUserId: number | null; active: boolean }
export function responsibleProblem(r: Responsible | null): string | null {
  if (!r) return "лідоген для тендерних лідів не вибраний у «Налаштуваннях»";
  if (!r.active) return `вибраний лідоген «${r.name}» неактивний — виберіть іншого в «Налаштуваннях»`;
  if (!r.kommoUserId) return `у лідогена «${r.name}» немає акаунта Kommo`;
  return null;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const leadName = (l: Pick<PendingLead, "title" | "companyName">): string =>
  cut(`Тендер: ${(l.title ?? "").replace(/\s+/g, " ").trim() || l.companyName}`, 250);

export function companyPayload(l: PendingLead, responsible: number): Record<string, unknown> {
  const cf: unknown[] = [{ field_id: COMPANY_EDRPOU_FIELD, values: [{ value: l.edrpou }] }];
  if (l.address) cf.push({ field_code: "ADDRESS", values: [{ value: l.address }] });
  return { name: cut(l.companyName, 250), responsible_user_id: responsible, custom_fields_values: cf };
}

export function contactPayload(l: PendingLead, responsible: number): Record<string, unknown> {
  const cf: unknown[] = [{ field_id: CONTACT_SOURCE_FIELD, values: [{ enum_id: CONTACT_SOURCE_AI_TENDER }] }];
  if (l.phone) cf.push({ field_code: "PHONE", values: [{ value: l.phone, enum_code: "WORK" }] });
  if (l.email) cf.push({ field_code: "EMAIL", values: [{ value: l.email, enum_code: "WORK" }] });
  return { name: cut(l.contactName ?? l.companyName, 250), responsible_user_id: responsible, custom_fields_values: cf,
    _embedded: { tags: [{ name: AI_TENDER_TAG }] } };
}

/** Угода: «Продзвін» → «Тендер AI», джерело «AI тендер», тег, компанія й контакт. Бюджету (`price`) свідомо НЕМАЄ. */
export function leadPayload(l: PendingLead, responsible: number, companyId: number, contactId: number): Record<string, unknown> {
  return {
    name: leadName(l), pipeline_id: PZ_PIPELINE, status_id: PZ_TENDER_STATUS, responsible_user_id: responsible,
    custom_fields_values: [{ field_id: LEAD_SOURCE_FIELD, values: [{ enum_id: LEAD_SOURCE_AI_TENDER }] }],
    _embedded: { tags: [{ name: AI_TENDER_TAG }], companies: [{ id: companyId }], contacts: [{ id: contactId }] },
  };
}

export interface KommoPushDeps {
  /** Компанія з цим ЄДРПОУ в самій Kommo (пошук), якщо в нашому довіднику її немає. */
  findCompany: (edrpou: string) => Promise<number | null>;
  createCompany: (body: Record<string, unknown>) => Promise<number>;
  createContact: (body: Record<string, unknown>) => Promise<number>;
  createLead: (body: Record<string, unknown>) => Promise<number>;
  addNote: (leadId: number, text: string) => Promise<void>;
}
export interface PushStore {
  saved: (id: number, r: { responsible: number; companyId: number; contactId: number; leadId: number }) => Promise<void>;
  failed: (id: number, error: string) => Promise<void>;
}
export interface PushTally { pending: number; pushed: number; failed: number; companiesReused: number; stoppedBy: string | null; lastError: string | null }

/** Відмова в доступі — про обліковий запис, а не про рядок: наступні дадуть те саме, тож зупиняємось. */
const ACCOUNT_WIDE = /\bfailed (401|402|403)\b/;

/**
 * Записати ліди. Порядок у межах ліда: компанія (наявна або нова) → контакт → угода → примітка. Збій на ліді — рядок
 * позначається невдалим і прохід іде далі; відмова Kommo в доступі — стоп усього проходу.
 * ⚠️ Збій ПІСЛЯ створення угоди (примітка) не робить рядок невдалим: угода вже є, повтор створив би дубль.
 */
export async function pushLeads(rows: readonly PendingLead[], responsible: number, kommo: KommoPushDeps, store: PushStore,
  limit: number = DEFAULT_PUSH_LIMIT): Promise<PushTally> {
  const t: PushTally = { pending: rows.length, pushed: 0, failed: 0, companiesReused: 0, stoppedBy: null, lastError: null };
  for (const l of rows.slice(0, Math.max(0, limit))) {
    let leadId: number | null = null;
    let companyId: number | null = null;
    let contactId: number | null = null;
    try {
      companyId = l.kommoCompanyExisting ?? (await kommo.findCompany(l.edrpou));
      if (companyId != null) t.companiesReused++;
      else companyId = await kommo.createCompany(companyPayload(l, responsible));
      contactId = await kommo.createContact(contactPayload(l, responsible));
      leadId = await kommo.createLead(leadPayload(l, responsible, companyId, contactId));
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      t.failed++; t.lastError = msg;
      await store.failed(l.id, msg);
      if (ACCOUNT_WIDE.test(msg)) { t.stoppedBy = msg; break; }
      continue;
    }
    await store.saved(l.id, { responsible, companyId, contactId, leadId });
    t.pushed++;
    await kommo.addNote(leadId, l.card).catch((e: unknown) => store.failed(l.id, `угоду створено, примітку не додано: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500)));
  }
  return t;
}
