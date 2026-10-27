/**
 * 📎 Kommo для «ТЕСТ ЗАКАЗ 1С»: прочитати угоду й компанію (ЄДРПОУ), імʼя менеджера, покласти PDF у файли угоди
 * й лишити примітку. Токен — свій (`ZAKAZ1C_KOMMO_TOKEN`, інтеграція з правом «Доступ до файлів»), а не
 * `KOMMO_API_TOKEN` дашборда: різні права й окремий ліміт запитів.
 *
 * У поля Genesis («Номер заказа», «Оплачено 1с»…) свідомо НЕ пишемо: їх пише Genesis, поки він працює поруч, і ми б
 * його перетерли. Перейдемо на ці поля, коли Genesis вимкнуть.
 *
 * Файли Kommo (документація amoCRM «Файли API»): `GET /api/v4/account?with=drive_url` → адреса сховища →
 * `POST {drive}/v1.0/sessions` → частини по `max_part_size` на `upload_url`, далі `next_url` → остання відповідь
 * має `uuid` → `PUT /api/v4/leads/{id}/files [{file_uuid}]` (202 без тіла).
 */
import { zakaz1cKommoBase, zakaz1cKommoToken } from "./env.js";

/** Поля Kommo, звідки вікно бере підстановку (заміряно через API 26.10.2026). */
export const KOMMO_FIELDS = {
  companyEdrpou: 466493, // компанія «ЕДРПОУ» (text) — той самий, що Genesis шле в 1С як «ИНН»
  companyInn: 463931, // компанія «ИНН» (numeric) — ФОП без ЄДРПОУ
  leadCar: 2096383, // «Марка і Номер автомобіля»
  leadCityFrom: 481280, // «Откуда город»
  leadCityTo: 481286, // «Куда город»
  // ⬇ Поля, які зараз пише Genesis (лише API). Ми пишемо їх тільки при ZAKAZ1C_FIELDS_MODE=live.
  leadOrderNo: 2096315, // «Номер заказа» (text) — номер рахунку 1С, як «000008587»
  leadPaid1c: 2096323, // «Оплачено 1с» (text) — сума оплат, як «28000»
  leadPaidFrom1c: 2096325, // «Оплачено из 1с» (checkbox) — повна оплата
} as const;

let last = 0;
/** Послідовно й не частіше ~4 запитів/с: ліміт Kommo — 7/с на інтеграцію, після IP-бану 08.07 тримаємо запас. */
async function throttle() {
  const wait = last + 250 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

async function kommo(path: string, init: RequestInit = {}): Promise<Response> {
  const token = zakaz1cKommoToken();
  if (!token) throw new Error("ZAKAZ1C_KOMMO_TOKEN не задано");
  await throttle();
  const url = path.startsWith("http") ? path : `${zakaz1cKommoBase()}${path}`;
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
}

async function kommoJson<T>(path: string): Promise<T> {
  const r = await kommo(path);
  if (r.status === 204) throw new Error(`Kommo ${path}: порожньо`);
  if (!r.ok) throw new Error(`Kommo ${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

type Cf = { field_id: number; values?: { value?: unknown }[] }[] | null | undefined;
const cfText = (cf: Cf, id: number) => String(cf?.find((f) => f.field_id === id)?.values?.[0]?.value ?? "").trim();

export interface LeadForInvoice {
  id: number;
  name: string;
  price: number;
  responsibleUserId: number;
  car: string;
  cityFrom: string;
  cityTo: string;
  company: { id: number; name: string; edrpou: string } | null;
}

/** Угода + головна компанія. ЄДРПОУ — з поля компанії; для ФОП без ЄДРПОУ — «ИНН» (10 цифр). */
export async function loadLead(leadId: number): Promise<LeadForInvoice> {
  const l = await kommoJson<any>(`/api/v4/leads/${leadId}?with=companies`);
  const companyId = Number(l?._embedded?.companies?.[0]?.id) || 0;
  let company: LeadForInvoice["company"] = null;
  if (companyId) {
    const c = await kommoJson<any>(`/api/v4/companies/${companyId}`);
    const edrpou = cfText(c.custom_fields_values, KOMMO_FIELDS.companyEdrpou).replace(/\D/g, "")
      || cfText(c.custom_fields_values, KOMMO_FIELDS.companyInn).replace(/\D/g, "");
    company = { id: companyId, name: String(c.name ?? ""), edrpou };
  }
  return {
    id: Number(l.id), name: String(l.name ?? ""), price: Number(l.price) || 0,
    responsibleUserId: Number(l.responsible_user_id) || 0,
    car: cfText(l.custom_fields_values, KOMMO_FIELDS.leadCar),
    cityFrom: cfText(l.custom_fields_values, KOMMO_FIELDS.leadCityFrom),
    cityTo: cfText(l.custom_fields_values, KOMMO_FIELDS.leadCityTo),
    company,
  };
}

export async function kommoUserName(userId: number): Promise<string> {
  try {
    const u = await kommoJson<any>(`/api/v4/users/${userId}`);
    return String(u?.name ?? "").trim();
  } catch {
    return "";
  }
}

/** PDF → файли угоди. Повертає uuid файлу Kommo. */
export async function attachPdfToLead(leadId: number, fileName: string, bytes: Buffer): Promise<string> {
  const acc = await kommoJson<any>("/api/v4/account?with=drive_url");
  const drive = String(acc?.drive_url ?? "").replace(/\/+$/, "");
  if (!drive) throw new Error("Kommo не віддав адресу файлового сховища (drive_url)");
  const sr = await kommo(`${drive}/v1.0/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, file_size: bytes.length, content_type: "application/pdf" }),
  });
  if (!sr.ok) throw new Error(`Kommo сесія завантаження: ${sr.status}`);
  const session = await sr.json() as { upload_url?: string; max_part_size?: number };
  let url = String(session.upload_url ?? "");
  const part = Number(session.max_part_size) || 524_288;
  let uuid = "";
  for (let off = 0; off < bytes.length && url; off += part) {
    const chunk = new Uint8Array(bytes.subarray(off, off + part));
    const r = await kommo(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: chunk });
    if (!r.ok) throw new Error(`Kommo частина файлу: ${r.status}`);
    const j = await r.json() as { next_url?: string; uuid?: string };
    if (j.uuid) { uuid = j.uuid; break; }
    url = String(j.next_url ?? "");
  }
  if (!uuid) throw new Error("Kommo не повернув uuid файлу після завантаження");
  const lr = await kommo(`/api/v4/leads/${leadId}/files`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ file_uuid: uuid }]),
  });
  if (!lr.ok) throw new Error(`Kommo прикріплення файлу до угоди: ${lr.status}`);
  return uuid;
}

export interface LeadPatch {
  id: number;
  custom_fields_values?: { field_id: number; values: { value: string | boolean }[] }[];
  status_id?: number;
  pipeline_id?: number;
}

/** Пакетне оновлення угод (до 50 за запит, як дозволяє Kommo). Помилка — разом із відповіддю Kommo. */
export async function patchLeads(batch: LeadPatch[]): Promise<void> {
  for (let i = 0; i < batch.length; i += 50) {
    const r = await kommo("/api/v4/leads", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch.slice(i, i + 50)),
    });
    if (!r.ok) throw new Error(`Kommo оновлення угод: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

/** Звичайна примітка в стрічці угоди. */
export async function addLeadNote(leadId: number, text: string): Promise<void> {
  const r = await kommo(`/api/v4/leads/${leadId}/notes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ note_type: "common", params: { text } }]),
  });
  if (!r.ok) throw new Error(`Kommo примітка: ${r.status}`);
}
