/**
 * 🔎 ЄДР через YouScore (API YouControl) — реквізити контрагента за ЄДРПОУ / ІПН ФОП для конструктора (30.09.2026).
 *
 * Специфікація — публічна: https://api.youscore.com.ua/swagger/v1/swagger.json. Беремо рівно два запити:
 *  - `GET /v1/usr/{код}` — ЄДР: назва, адреса, керівник, контакти, стан (припинення, банкрутство);
 *  - `GET /v1/vat/{код}` — реєстр платників ПДВ: індивідуальний податковий номер (поле «ІПН / ПДВ»).
 * Кожен запит — ТРАНЗАКЦІЯ тарифу, тому відповідь кешується (`youscore_cache`, 30 днів) і повторний пошук того
 * самого коду в мережу не йде.
 *
 * Заміряно на проді 30.09.2026 (3 пробні транзакції з дозволу Романа):
 *  - юрособа (ЮТС) — 200 за 0,34 с, `name` — обʼєкт `{fullName, shortName}`, керівник у `signers[].role = "керівник"`;
 *  - ФОП — перше звернення дало 202 «Update in progress» + `currentDataUrl`, повтор через 20 с — 200; `name` —
 *    РЯДОК (ПІБ), коду в тілі немає, `contractorType = "Фізична особа-підприємець (ФОП)"`.
 *  Тому 202 — не помилка й не «немає»: фронт повторює сам, а в кеш такий стан не кладеться.
 *
 * 🔒 Ключ (`YOUCONTROL_API_KEY`) — лише в заголовку `Authorization: bearer …` (не в адресі, тож не в логах проксі),
 * жодна відповідь і жоден текст помилки його не несуть. У кеші — лише перекладена картка, без засновників і
 * бенефіціарів: нам потрібні реквізити для договору, а не персональні дані власників.
 */
import { shortOrgName } from "./services/docgen.js";

export const YOUSCORE_BASE = "https://api.youscore.com.ua";
/** Скільки днів вважаємо картку з реєстру свіжою. Реквізити змінюються рідко, а кожен запит коштує транзакцію. */
export const CACHE_DAYS = 30;
const TIMEOUT_MS = 15_000;

export interface Db { query: <R = any>(text: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> }
type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** Картка контрагента з реєстру — у тих самих полях, що форма конструктора, плюс стан і дата актуальності. */
export interface RegistryCard {
  edrpou: string; name: string; ipn: string; addr: string; dir: string; phone: string; email: string;
  isFop: boolean; actualDate: string | null; status: string | null;
  /** Непорожнє — компанія припиняється, припинена або банкрутує: фронт показує червоне попередження. */
  warn: string | null;
}

export type Lookup =
  | { kind: "ok"; card: RegistryCard; cached: boolean }
  | { kind: "updating" }          // 202: реєстр оновлює дані — повторити пізніше
  | { kind: "notFound" }
  | { kind: "unconfigured" }      // ключа немає — пошук у реєстрі вимкнено, а не зламано
  | { kind: "failed"; why: string };

/** Прямі лапки реєстру → ялинки, як пишуть у договорах: відкривна — на початку чи після пробілу/дужки/лапки. */
export function toGuillemets(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '"') { out += ch; continue; }
    const prev = i === 0 ? " " : s[i - 1];
    out += /[\s(«]/.test(prev) ? "«" : "»";
  }
  return out;
}

/** ПІБ ВЕЛИКИМИ (так віддає ЄДР для ФОП) → «Прізвище Імʼя По батькові». Уже нормальний регістр не чіпаємо. */
export function personName(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Відповідь ЄДР (+ ПДВ) → картка конструктора. Чиста функція: усі гейти ганяють рівно її. */
export function toCounterparty(code: string, usr: any, vat: any): RegistryCard {
  const isFop = /ФОП|підприєм/i.test(str(usr?.contractorType)) || typeof usr?.name === "string";
  let name: string; let dir: string;
  if (isFop) {
    const person = personName(str(usr?.name));
    name = person ? `ФОП ${person}` : "";
    dir = person;
  } else {
    const full = str(usr?.name?.fullName) || str(usr?.legalPersonName);
    name = toGuillemets(shortOrgName(full));
    const signers: any[] = Array.isArray(usr?.signers) ? usr.signers : [];
    const head = signers.find((x) => /керівник/i.test(str(x?.role))) ?? signers[0];
    dir = personName(str(head?.name));
  }
  const terminated = str(usr?.registrationOfTermination?.status) || str(usr?.terminationStatus?.status)
    || (/припинен/i.test(str(usr?.status)) && !/не перебуває/i.test(str(usr?.status)) ? str(usr?.status) : "");
  const bankrupt = str(usr?.bankruptcyStatus?.event) || (usr?.bankruptcyStatus ? "банкрутство" : "");
  const warn = [terminated && `Стан у ЄДР: ${terminated}`, bankrupt && `Банкрутство: ${bankrupt}`].filter(Boolean).join(" · ") || null;
  return {
    edrpou: str(usr?.code) || code, name, ipn: str(vat?.code), addr: str(usr?.address), dir,
    phone: str(usr?.contacts?.phone), email: str(usr?.contacts?.email),
    isFop, actualDate: str(usr?.actualDate) || null, status: str(usr?.status) || null, warn,
  };
}

/** Один GET до YouScore. Ключ — лише в заголовку; у тексті помилки — тільки статус. */
async function get(path: string, key: string, doFetch: FetchLike): Promise<{ status: number; body: any }> {
  const r = await doFetch(`${YOUSCORE_BASE}${path}`, { headers: { Authorization: `bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = r.status === 200 ? await r.json().catch(() => null) : null;
  return { status: r.status, body };
}

/**
 * Пошук у реєстрі з кешем. `key`/`doFetch`/`now` — параметри, щоб гейти ганяли без мережі й без справжнього ключа.
 * Кешується лише успіх: 202/404/збій наступного разу питаються знову.
 */
export async function lookupRegistry(db: Db, code: string, opts: {
  key?: string | undefined; doFetch?: FetchLike; now?: Date; userId?: number | null;
} = {}): Promise<Lookup> {
  const now = opts.now ?? new Date();
  const hit = await db.query<{ card: RegistryCard; fetched_at: string }>(
    `SELECT card, fetched_at FROM youscore_cache WHERE code = $1`, [code]);
  const row = hit.rows[0];
  if (row && now.getTime() - new Date(row.fetched_at).getTime() < CACHE_DAYS * 86400000) return { kind: "ok", card: row.card, cached: true };

  const key = opts.key ?? process.env.YOUCONTROL_API_KEY;
  if (!key) return { kind: "unconfigured" };
  const doFetch = opts.doFetch ?? (fetch as unknown as FetchLike);
  try {
    const usr = await get(`/v1/usr/${code}`, key, doFetch);
    if (usr.status === 202) return { kind: "updating" };
    if (usr.status === 404) return { kind: "notFound" };
    if (usr.status !== 200 || !usr.body) return { kind: "failed", why: `ЄДР відповів ${usr.status}` };
    // ПДВ — друга транзакція; не платник ПДВ (404) чи збій — не причина відмовляти в реквізитах.
    const vat = await get(`/v1/vat/${code}`, key, doFetch).catch(() => ({ status: 0, body: null }));
    // 🔴 202 від реєстру ПДВ — «оновлюється», а НЕ «не платник». Заміряно на проді 30.09.2026: ЮТС (платник ПДВ)
    // на першому запиті лишився без номера, а повтор за хвилину віддав його. Кешувати таку картку — на 30 днів
    // зберегти порожнє поле, тож уся відповідь — «оновлюється», фронт повторить сам.
    if (vat.status === 202) return { kind: "updating" };
    const card = toCounterparty(code, usr.body, vat.status === 200 ? vat.body : null);
    if (!card.name) return { kind: "failed", why: "ЄДР віддав запис без назви" };
    await db.query(
      `INSERT INTO youscore_cache (code, card, fetched_at, fetched_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET card = EXCLUDED.card, fetched_at = EXCLUDED.fetched_at, fetched_by = EXCLUDED.fetched_by`,
      [code, JSON.stringify(card), now.toISOString(), opts.userId ?? null]);
    return { kind: "ok", card, cached: false };
  } catch (e) {
    // Лише клас помилки — не текст: у тексті мережевої помилки може опинитись будь-що з запиту.
    return { kind: "failed", why: (e as Error)?.name === "TimeoutError" ? "ЄДР не відповів за 15 с" : "ЄДР недоступний" };
  }
}
