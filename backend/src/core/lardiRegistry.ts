import { parseRegistry, type RegistryInfo } from "./lardiCheckRules.js";

/**
 * 🏛 ЄДР (YouControl) за кодом фірми з Ларді — для блока «Перевірити номер на Ларді» (24.11.2026). Правила розбору —
 * `lardiCheckRules.parseRegistry`; тут лише мережа й кеш.
 *
 * Чому НЕ `constructor/youscore.lookupRegistry`: той бере ДВІ транзакції (ЄДР + ПДВ) і кешує картку договору в
 * `youscore_cache`. Лідгену ПДВ не потрібен, а писати туди картку без ПДВ означало б на 30 днів залишити конструктору
 * порожнє поле «ІПН / ПДВ» — рівно та пастка, від якої його кеш застрахований. Тому окремий кеш і рівно один запит.
 *
 * Гроші: `/v1/usr` — 1 транзакція на код (заміряно для конструктора 30.09.2026). Повтор того самого коду в межах
 * `REGISTRY_CACHE_DAYS` у мережу не йде. Кешується лише успіх: 202 («оновлюється»), 404 і збої питаються знову.
 *
 * 🔴 202 НА ПЕРШОМУ ЗАПИТІ — НОРМА, А НЕ ВИНЯТОК. Заміряно 24.11.2026 на проді: юрособа з Ларді (код з профілю) →
 * `202 {status: "Update in progress", currentDataUrl}`. Без обходу лідген на кожну нову компанію бачив би «оновлюється,
 * спробуйте за хвилину». Тому на 202 одразу другий запит з `showCurrentData=true` — архівні дані YouControl без
 * оновлення реєстру (так само робить «Перевірка контрагента», `counterparty/server/youscore/client.ts`). КВЕД змінюються
 * рідко, тож архів для лідгена годиться; картка підписує, що дані з архіву. Ціна: до 2 транзакцій на новий код
 * (202 теж списується — так записано в клієнті «Перевірки контрагента»).
 * Ключ — той самий, що в конструктора (`YOUCONTROL_API_KEY`), запасний — ключ «Перевірки контрагента».
 */
export const REGISTRY_CACHE_DAYS = 30;
/** Скільки різних кодів за одну перевірку номера — стеля витрат (Ларді за номером знаходить до 5 користувачів). */
export const REGISTRY_MAX_CODES = 3;
const BASE = "https://api.youscore.com.ua";
const TIMEOUT_MS = 15_000;

export interface Db { query: <R = any>(text: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> } // eslint-disable-line @typescript-eslint/no-explicit-any
type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

export type RegistryLookup =
  | { state: "ok"; info: RegistryInfo; cached: boolean }
  | { state: "updating" }       // 202: ЄДР оновлює дані — повторити за хвилину
  | { state: "notFound" }       // 404: такого коду в ЄДР немає
  | { state: "unconfigured" }   // ключа немає на сервері — перевірка вимкнена, а не зламана
  | { state: "failed"; why: string };

export function registryKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (env.YOUCONTROL_API_KEY || env.YOUSCORE_API_KEY || "").trim() || undefined;
}

export async function registryByCode(db: Db, code: string, opts: { key?: string; doFetch?: FetchLike; now?: Date } = {}): Promise<RegistryLookup> {
  const now = opts.now ?? new Date();
  const hit = await db.query<{ info: RegistryInfo; fetched_at: string }>(
    `SELECT info, fetched_at FROM lardi_registry_cache WHERE code = $1`, [code]);
  const row = hit.rows[0];
  if (row && now.getTime() - new Date(row.fetched_at).getTime() < REGISTRY_CACHE_DAYS * 86_400_000) return { state: "ok", info: row.info, cached: true };

  const key = "key" in opts ? opts.key : registryKey();
  if (!key) return { state: "unconfigured" };
  const doFetch = opts.doFetch ?? (fetch as unknown as FetchLike);
  try {
    // Ключ — лише в заголовку (не в адресі, тож не в логах проксі); у тексті помилки — тільки статус.
    const get = (q: string) => doFetch(`${BASE}/v1/usr/${code}${q}`, { headers: { Authorization: `bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let r = await get("");
    let archived = false;
    if (r.status === 202) {
      r = await get("?showCurrentData=true");
      archived = true;
      // Архіву немає (YouControl цю компанію ще не бачив) або він теж оновлюється — чесне «оновлюється», не «немає в ЄДР».
      if (r.status !== 200) return { state: "updating" };
    }
    if (r.status === 404 || r.status === 204) return { state: "notFound" };
    if (r.status !== 200) return { state: "failed", why: `ЄДР відповів ${r.status}` };
    const parsed = parseRegistry(code, await r.json().catch(() => null));
    if (!parsed) return { state: "failed", why: "ЄДР віддав не картку компанії" };
    const info = { ...parsed, archived };
    await db.query(
      `INSERT INTO lardi_registry_cache (code, info, fetched_at) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET info = EXCLUDED.info, fetched_at = EXCLUDED.fetched_at`,
      [code, JSON.stringify(info), now.toISOString()]);
    return { state: "ok", info, cached: false };
  } catch (e) {
    return { state: "failed", why: (e as Error)?.name === "TimeoutError" ? "ЄДР не відповів за 15 с" : "ЄДР недоступний" };
  }
}
