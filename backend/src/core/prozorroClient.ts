import { MIN_INTERVAL_MS, PAGE_SIZE, SEARCH_STATUSES, SEARCH_URL, summaryUrl, tenderApiUrl, type PzSearchItem, type PzTender } from "./prozorroRules.js";

/**
 * 🌐 PROZORRO — HTTP (задача #5299, прохід 1). Публічне API, без ключа.
 *
 * Модуль чистий: `fetch`, `sleep` і годинник приходять ззовні — гейти ганяють повтори й паузи без мережі.
 *  · запити йдуть ПОСЛІДОВНО з паузою не менше `MIN_INTERVAL_MS` (2 на секунду; на ~4/с Prozorro вже віддає 429);
 *  · 429 / 5xx / збій мережі — повтор із наростаючою паузою, до `maxRetries` разів;
 *  · інший код — одразу відповідь «не вдалось» із кодом: повтор не допоможе;
 *  · без заголовка User-Agent пошук Prozorro відповідає 503 на кожен запит (заміряно 21.10.2026) — тому він обовʼязковий.
 * Помилка НЕ ковтається: кожна відповідь каже `ok`, і прохід рахує невдалі — вирок робить `runVerdict`.
 */

export const USER_AGENT = "Mozilla/5.0 (compatible; uts-dashboard/1.0; +https://dashboard.uts.ua)";
const RETRYABLE = (status: number): boolean => status === 429 || status >= 500;

export interface PzDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  minIntervalMs?: number;
  maxRetries?: number;
}
export type PzResult<T> = { ok: true; data: T } | { ok: false; status: number | null; error: string };

export function makeProzorroClient(d: PzDeps) {
  const gap = d.minIntervalMs ?? MIN_INTERVAL_MS;
  const maxRetries = d.maxRetries ?? 5;
  let lastAt = -Infinity;

  async function request<T>(url: string, body?: unknown): Promise<PzResult<T>> {
    let last: { status: number | null; error: string } = { status: null, error: "не виконано" };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await d.sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
      const wait = lastAt + gap - d.nowMs();
      if (wait > 0) await d.sleep(wait);
      lastAt = d.nowMs();
      let res: Response;
      try {
        res = await d.fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(40_000),
        });
      } catch (e) {
        last = { status: null, error: e instanceof Error ? e.message : String(e) };
        continue;
      }
      if (res.ok) {
        try { return { ok: true, data: (await res.json()) as T }; } catch (e) {
          return { ok: false, status: res.status, error: `відповідь не JSON: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      last = { status: res.status, error: `HTTP ${String(res.status)}` };
      if (!RETRYABLE(res.status)) break;
    }
    return { ok: false, ...last };
  }

  return {
    /** Сторінка пошуку тендерів із визначеним переможцем. */
    async search(text: string, page: number): Promise<PzResult<PzSearchItem[]>> {
      const r = await request<{ data?: PzSearchItem[] }>(SEARCH_URL, { text, page, status: [...SEARCH_STATUSES] });
      if (!r.ok) return r;
      const items = Array.isArray(r.data.data) ? r.data.data : null;
      if (!items) return { ok: false, status: null, error: "у відповіді пошуку немає поля data" };
      return { ok: true, data: items.slice(0, PAGE_SIZE * 2) };
    },
    /** Повні дані тендера за людським номером: summary → внутрішній id → public-api. */
    async tender(uaId: string): Promise<PzResult<PzTender>> {
      const s = await request<{ id?: string }>(summaryUrl(uaId));
      if (!s.ok) return s;
      if (!s.data.id) return { ok: false, status: null, error: `summary ${uaId} без id` };
      const f = await request<{ data?: PzTender }>(tenderApiUrl(s.data.id));
      if (!f.ok) return f;
      return f.data.data ? { ok: true, data: f.data.data } : { ok: false, status: null, error: `тендер ${uaId} без даних` };
    },
  };
}
export type ProzorroClient = ReturnType<typeof makeProzorroClient>;
