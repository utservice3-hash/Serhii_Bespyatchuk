/**
 * 🌐 HTTP ДО ЗОВНІШНІХ ПОСТАЧАЛЬНИКІВ AI-АНАЛІЗУ (Ringostat-запис, ElevenLabs, Gemini).
 *
 * ТЗ «AI-аналіз дзвінків по рекламних лідах» (22.09.2026), прохід A, коміт ③.
 *
 * 🔴 МОДУЛЬ ЧИСТИЙ: без `db/pool.js`, без `config.js`. `fetch`, `sleep` і годинник приходять
 * ззовні — гейти ганяють повтори, таймаути й 429 без мережі і без справжнього очікування.
 *
 * 🔒 ЩО НІКОЛИ НЕ ПОТРАПЛЯЄ В ТЕКСТ ПОМИЛКИ:
 *   • ключ API — він їде ЛИШЕ заголовком, а не в URL, тож у рядку запиту його немає;
 *   • URL запису Ringostat — він відкривається БЕЗ логіна (`docs/RINGOSTAT_CALLS.md`), тобто
 *     сам URL і є доступом до розмови; у помилці лишається тільки хост;
 *   • `cause` — помилка мережі з undici несе в `cause` адресу й опції запиту, а `util.inspect`
 *     розгортає `cause` на будь-яку глибину. Тому `VendorError` будується З НУЛЯ, без `cause`.
 * Шматок тіла відповіді постачальника береться (там справжня причина: «insufficient_credits»),
 * але проходить `scrubText`: URL → `[url]`, довгі токени → `[…]`, названі секрети → `[ключ]`.
 *
 * ⚖️ ВИД ПОМИЛКИ — НАШ СЛОВНИК, А НЕ HTTP-КОД. Код лишається в рядку стану дзвінка, але в
 * помилку ПОРЦІЇ (ту, що йде в `job_runs`) не потрапляє: `classifyJobError` читає `403/429` як
 * «Kommo відмовляє» і порадив би знижувати темп CRM, до якої цей запит не має стосунку.
 */

export type VendorFailureKind =
  | "rate_limit"   // 429 / зайнято: повторювати з паузою
  | "auth"         // 401 / 403: ключ неправильний або без дозволу — повтор не допоможе
  | "payment"      // 402: кредити скінчились — повтор не допоможе
  | "bad_input"    // 400 / 413 / 422: запит або файл не приймають
  | "not_found"    // 404 / 410
  | "server"       // 5xx
  | "network"      // зʼєднання не встановилось / обірвалось
  | "timeout"      // не вклались у свій таймаут
  | "bad_response"; // відповідь прийшла, але не тієї форми

export const VENDOR_FAILURE_UA: Record<VendorFailureKind, string> = {
  rate_limit: "постачальник обмежив частоту запитів",
  auth: "ключ відхилено або в нього немає дозволу",
  payment: "на рахунку постачальника скінчились кошти",
  bad_input: "постачальник не прийняв запит або файл",
  not_found: "не знайдено",
  server: "збій на боці постачальника",
  network: "мережа не зʼєдналась",
  timeout: "не вклались у таймаут",
  bad_response: "відповідь незрозумілої форми",
};

/** Помилки, після яких повтор цього ж запиту має сенс. */
export const RETRYABLE: ReadonlySet<VendorFailureKind> = new Set(["rate_limit", "server", "network", "timeout"]);
/**
 * Помилки, що стосуються не ДЗВІНКА, а всього рахунку: після них порція зупиняється, а
 * дзвінки повертаються в чергу без витрати спроби — інакше вичерпаний баланс «спалив» би
 * стелю спроб у кожного дзвінка черги за один тік.
 */
export const ACCOUNT_WIDE: ReadonlySet<VendorFailureKind> = new Set(["auth", "payment"]);

export class VendorError extends Error {
  readonly vendor: string;
  readonly kind: VendorFailureKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(vendor: string, kind: VendorFailureKind, status: number | null, detail?: string, retryAfterMs: number | null = null) {
    super(`${vendor}: ${VENDOR_FAILURE_UA[kind]}${status != null ? ` (HTTP ${String(status)})` : ""}${detail ? ` — ${detail}` : ""}`);
    this.name = "VendorError";
    this.vendor = vendor;
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** URL у тексті помилки лишає лише хост: сам URL запису Ringostat — це доступ до розмови. */
export function redactUrl(u: string): string {
  try { return `[url ${new URL(u).host}]`; } catch { return "[url]"; }
}

/**
 * Прибирає з довільного тексту все, що може бути доступом: URL, названі секрети, довгі
 * токени. Обрізає до `max` символів ПІСЛЯ очищення — інакше обрізка могла б розрізати секрет
 * так, що його хвіст не впізнається.
 */
export function scrubText(text: string, secrets: readonly string[] = [], max = 200): string {
  let s = text;
  for (const k of secrets) if (k && k.length >= 4) s = s.split(k).join("[ключ]");
  s = s.replace(/https?:\/\/[^\s"'<>)]+/g, (m) => redactUrl(m));
  s = s.replace(/[A-Za-z0-9_\-]{24,}/g, "[…]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function kindForStatus(status: number): VendorFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 404 || status === 410) return "not_found";
  if (status >= 500) return "server";
  return "bad_input";
}

/** `Retry-After`: секунди або HTTP-дата. Невідоме / відʼємне → null. */
export function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (!v) return null;
  if (/^\s*\d+(\.\d+)?\s*$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - nowMs);
}

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
}

export interface RetryPolicy {
  /** Скільки ПОВТОРІВ після першої спроби (0 = лише одна спроба). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export interface VendorRequest {
  vendor: string;
  url: string;
  /** Будується наново на кожну спробу: тіло-потік не можна прочитати двічі. */
  init: () => RequestInit;
  /** Секрети цього запиту — вичищаються з тексту помилки. */
  secrets?: readonly string[];
}

/**
 * Запит із повторами. Повторює лише `RETRYABLE`; пауза — `Retry-After` постачальника, якщо
 * він її назвав, інакше експонента від `baseDelayMs`; обидві обмежені `maxDelayMs`.
 * Повертає відповідь з кодом 2xx; усе інше — `VendorError` без URL і без `cause`.
 */
export async function fetchWithRetry(deps: HttpDeps, req: VendorRequest, policy: RetryPolicy): Promise<Response> {
  let last: VendorError | null = null;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (attempt > 0 && last) {
      const exp = policy.baseDelayMs * 2 ** (attempt - 1);
      await deps.sleep(Math.min(policy.maxDelayMs, last.retryAfterMs ?? exp));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), policy.timeoutMs);
    let res: Response;
    try {
      res = await deps.fetch(req.url, { ...req.init(), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      const aborted = ctrl.signal.aborted || (e as { name?: string })?.name === "AbortError";
      last = new VendorError(req.vendor, aborted ? "timeout" : "network", null);
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return res;
    const kind = kindForStatus(res.status);
    let detail = "";
    try { detail = scrubText(await res.text(), req.secrets ?? []); } catch { /* тіло не прочиталось — лишаємо код */ }
    last = new VendorError(req.vendor, kind, res.status, detail || undefined,
      parseRetryAfter(res.headers.get("retry-after"), deps.nowMs()));
    if (!RETRYABLE.has(kind)) throw last;
  }
  throw last ?? new VendorError(req.vendor, "network", null);
}

/**
 * Мінімальний проміжок між запитами до одного постачальника. Ringostat віддає 429 на
 * частих запитах — тож записи тягнемо по одному з паузою, а не пачкою.
 */
export function createMinInterval(minMs: number, deps: Pick<HttpDeps, "sleep" | "nowMs">): () => Promise<void> {
  let lastAt = -Infinity;
  return async () => {
    const wait = lastAt + minMs - deps.nowMs();
    if (wait > 0) await deps.sleep(wait);
    lastAt = deps.nowMs();
  };
}
