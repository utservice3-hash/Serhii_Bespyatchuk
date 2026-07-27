// PrivatBank «Приват24 для бізнесу» Autoclient — statements/transactions.
// Токен — process.env[account.env_key_name] (напр. PRIVAT_TOKEN_UTS); опційно merchant id
// у process.env[<env>_ID] (PRIVAT_TOKEN_UTS → PRIVAT_TOKEN_UTS_ID) або окремій PRIVAT_ID_*.
// Заголовки: token (+ id, якщо є). Параметри: acc (IBAN), startDate=dd-mm-yyyy.
import type { AccountBalance, BankAccountRow, NormalizedTx } from "./types.js";

const BASE = "https://acp.privatbank.ua/api/statements/transactions";
const BALANCE_URL = "https://acp.privatbank.ua/api/statements/balance";

// ⚠️ ПриватБанк Autoclient віддає тіло у cp1251 (Windows-1251), НЕ UTF-8. res.text()/res.json()
// припускають UTF-8 → кирилиця перетворюється на U+FFFD («◆◆◆»). Декодуємо сирі байти cp1251.
// ASCII (синтаксис JSON) у cp1251 ідентичний, тож JSON.parse після декоду коректний. mono — UTF-8.
const CP1251 = new TextDecoder("windows-1251");

interface PrivatItem {
  ID?: string; REF?: string; TRANTYPE?: "C" | "D"; CCY?: string;
  SUM?: string | number; SUM_E?: string | number; OSND?: string;
  AUT_CNTR_NAM?: string; AUT_CNTR_ACC?: string;
  DAT_KL?: string; DAT_OD?: string; TIM_P?: string;
}

/** Київська «стінка» (y/mo/d/h/mi у часі Києва) → правильний UTC-інстант. DST-безпечно через
 *  Intl (без хардкоду +2/+3): Privat віддає час по-київськи. */
function kyivWallToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi); // наближення: трактуємо як UTC
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hh = get("hour") === 24 ? 0 : get("hour"); // Intl інколи дає 24:00
  const kyivAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hh, get("minute"));
  return new Date(guess - (kyivAsUtc - guess)); // віднімаємо зсув Києва для цього інстанту
}

function parseDate(dat?: string, tim?: string): Date | null {
  if (!dat) return null;
  // формат privat: dd.mm.yyyy (+ час HH:MM[:SS]) у КИЇВСЬКОМУ часі
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dat.trim());
  if (!m) { const d = new Date(dat); return isNaN(+d) ? null : d; }
  const tm = (tim && /^(\d{2}):(\d{2})/.exec(tim.trim())) || null;
  const H = tm ? Number(tm[1]) : 0, M = tm ? Number(tm[2]) : 0;
  return kyivWallToUtc(Number(m[3]), Number(m[2]), Number(m[1]), H, M);
}

/** Чистий нормалізатор (тестується без мережі). Знак — з TRANTYPE (C=надходження, D=списання). */
export function normalizePrivat(it: PrivatItem, accountCurrency: string): NormalizedTx {
  const sign = it.TRANTYPE === "C" ? 1 : -1;
  const abs = Math.abs(Number(it.SUM ?? 0));
  const sumE = it.SUM_E != null ? Math.abs(Number(it.SUM_E)) : null; // UAH-еквівалент (для валютних)
  const currency = (it.CCY || accountCurrency || "UAH").toUpperCase();
  // booked_at несе РЕАЛЬНИЙ час операції (TIM_P), а не лише дату (інакше всі рядки = 00:00/«03:00»).
  const booked = parseDate(it.DAT_KL, it.TIM_P) ?? parseDate(it.DAT_OD, it.TIM_P) ?? new Date(0);
  const processed = parseDate(it.DAT_OD, it.TIM_P);
  const fxRate = currency !== "UAH" && sumE != null && abs > 0 ? sumE / abs : null;
  return {
    externalTxId: `privat:${it.REF ?? it.ID ?? `${it.DAT_OD}-${abs}-${it.AUT_CNTR_ACC ?? ""}`}`,
    direction: sign > 0 ? "in" : "out",
    bookedAt: booked,
    processedAt: processed,
    counterpartyName: it.AUT_CNTR_NAM ?? null,
    counterpartyIban: it.AUT_CNTR_ACC ?? null,
    purpose: it.OSND ?? null,
    amount: sign * abs,
    currency,
    fxRate,
    raw: it,
  };
}

export async function fetchTransactions(account: BankAccountRow, since: Date): Promise<NormalizedTx[]> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) throw new Error(`privat: немає env ${account.env_key_name}`);
  const id = (account.env_key_name && process.env[`${account.env_key_name}_ID`]) || undefined;
  const acc = account.external_account_id ?? account.iban;
  if (!acc) throw new Error(`privat: немає IBAN/рахунку для ${account.label}`);
  const p = (n: number) => String(n).padStart(2, "0");
  const startDate = `${p(since.getUTCDate())}-${p(since.getUTCMonth() + 1)}-${since.getUTCFullYear()}`;
  const all: NormalizedTx[] = [];
  let followId: string | undefined;
  for (let page = 0; page < 50; page++) { // пагінація exist_next_page/next_page_id, стеля 50 стор
    const url = new URL(BASE);
    url.searchParams.set("acc", acc);
    url.searchParams.set("startDate", startDate);
    url.searchParams.set("limit", "500");
    if (followId) url.searchParams.set("followId", followId);
    const headers: Record<string, string> = { token };
    if (id) headers.id = id;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`privat ${res.status}`);
    // cp1251 → UTF-8 на сирих байтах (НЕ res.json(), що припускає UTF-8 і псує кирилицю)
    const body = JSON.parse(CP1251.decode(new Uint8Array(await res.arrayBuffer()))) as
      { transactions?: PrivatItem[]; exist_next_page?: boolean; next_page_id?: string };
    for (const it of body.transactions ?? []) all.push(normalizePrivat(it, account.currency));
    if (!body.exist_next_page || !body.next_page_id) break;
    followId = body.next_page_id;
  }
  return all;
}

interface PrivatBalance { balanceOut?: string | number; balanceOutEq?: string | number; currency?: string; ccy?: string }

/** Closing-balance рахунку (Autoclient /statements/balance). 403/помилка → null («—»). */
export async function fetchBalance(account: BankAccountRow): Promise<AccountBalance | null> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) return null;
  const id = (account.env_key_name && process.env[`${account.env_key_name}_ID`]) || undefined;
  const acc = account.external_account_id ?? account.iban;
  if (!acc) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const since = new Date(Date.now() - 24 * 3600 * 1000); // вчора → свіжий залишок на сьогодні
  const startDate = `${p(since.getUTCDate())}-${p(since.getUTCMonth() + 1)}-${since.getUTCFullYear()}`;
  const url = new URL(BALANCE_URL);
  url.searchParams.set("acc", acc);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("limit", "1");
  const headers: Record<string, string> = { token };
  if (id) headers.id = id;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null; // 403 (нема доступу) / помилка → баланс недоступний
  const body = JSON.parse(CP1251.decode(new Uint8Array(await res.arrayBuffer()))) as { balances?: PrivatBalance[] };
  const b = body.balances?.[0];
  if (!b) return null;
  const amount = Number(b.balanceOut ?? b.balanceOutEq);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: (b.currency || b.ccy || account.currency || "UAH").toUpperCase() };
}
