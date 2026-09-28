/**
 * 💼 ВІДГУКИ З WORK.UA → «КАНДИДАТИ» (28.09.2026, прохід 7; інструкцію дала менеджерка work.ua Дарʼя Цибуля).
 *
 * API `https://api.work.ua/`, вхід HTTP Basic логіном і паролем користувача кабінету (`WORKUA_LOGIN`,
 * `WORKUA_PASSWORD` — окремий користувач-адміністратор `work.ua.admin.api@uts.ua`, щоб пароль Івана не лежав
 * на сервері). Беремо РІВНО два читання: `GET /jobs/my` (наші вакансії) і `GET /jobs/responses` (відгуки),
 * плюс файл відгуку `GET /response_files/<job>/<id>`.
 *
 * 🔴 `GET /resumes` І `GET /resume` ЗАБОРОНЕНІ. За інструкцією work.ua вони не просто віддають кандидатів, а
 * ВІДКРИВАЮТЬ КОНТАКТИ й списують платні відкриття з пакета компанії. Один випадковий виклик у циклі — і пакет
 * з'їдено. Тому всі запити йдуть через `workuaUrl`, який такі шляхи відкидає, а #806 стереже, що в коді їх немає.
 *
 * Читання через API НЕ позначає відгук прочитаним у кабінеті (перевірено 28.09.2026: після читання 50 відгуків
 * червоні крапки й лічильник 4097 непрочитаних лишились) — Іван працює в кабінеті як раніше.
 * Тримають #804–#807.
 */
export const WORKUA_BASE = "https://api.work.ua";
export const WORKUA_UA = "UTS Dashboard (work.ua.admin.api@uts.ua)";
/** Шляхи, що витрачають платні відкриття контактів. Звертатись до них не можна ніколи. */
export const WORKUA_FORBIDDEN = ["/resumes", "/resume"] as const;
/** Скільки днів відгуків беремо при першому підключенні (рішення Романа 28.09.2026: «за 14 днів»). */
export const WORKUA_BACKFILL_DAYS = 14;

/** Адреса запиту. Шлях, що відкриває платні контакти, не проходить ніколи — навіть якщо його передали помилкою. */
export function workuaUrl(p: string): string {
  const pathOnly = `/${p.split("?")[0].replace(/^\/+|\/+$/g, "")}`;
  if ((WORKUA_FORBIDDEN as readonly string[]).includes(pathOnly))
    throw new Error(`work.ua: запит ${pathOnly} витрачає платні відкриття контактів — заборонено`);
  return `${WORKUA_BASE}${p.startsWith("/") ? p : `/${p}`}`;
}

export function workuaHeaders(login: string, password: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
    "User-Agent": WORKUA_UA, "X-Locale": "uk_UA",
  };
}

export interface WorkuaResponse {
  id: number; jobId: number | null; date: string | null; fio: string | null; email: string | null; phone: string | null;
  type: "resume" | "file" | "easy" | string; withFile: boolean; text: string | null; cover: string | null;
}
export interface WorkuaJob { id: number; name: string; active: boolean; date: string | null }

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Відповідь `/jobs/responses` → наші поля. Чужий формат розбираємо в ОДНОМУ місці. */
export function parseResponses(body: unknown): WorkuaResponse[] {
  const items = (body as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  return items.map((x) => {
    const r = x as Record<string, unknown>;
    return {
      id: n(r.id) ?? 0, jobId: n(r.job_id), date: s(r.date), fio: s(r.fio), email: s(r.email), phone: s(r.phone),
      type: s(r.type) ?? "resume", withFile: Number(r.with_file) === 1, text: s(r.text), cover: s(r.cover),
    };
  }).filter((r) => r.id > 0);
}

export function parseJobs(body: unknown): WorkuaJob[] {
  const items = (body as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  return items.map((x) => {
    const r = x as Record<string, unknown>;
    return { id: n(r.id) ?? 0, name: s(r.name) ?? "без назви", active: Number(r.active) === 1, date: s(r.date) };
  }).filter((j) => j.id > 0);
}

/** Коментар картки з відгуку: супровідний лист і (обрізаний) текст резюме. Порожнє — нічого. */
export function responseComment(r: WorkuaResponse, max = 3000): string | null {
  const parts = [r.cover ? `Супровідний лист: ${r.cover}` : null, r.text ? `Резюме: ${r.text}` : null].filter(Boolean) as string[];
  if (!parts.length) return null;
  const all = parts.join("\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n");
  return all.length > max ? `${all.slice(0, max)}…` : all;
}
