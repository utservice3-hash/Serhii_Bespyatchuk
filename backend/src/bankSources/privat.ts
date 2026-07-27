// PrivatBank «Приват24 для бізнесу» Autoclient — statements/transactions.
// Токен — process.env[account.env_key_name] (напр. PRIVAT_TOKEN_UTS); опційно merchant id
// у process.env[<env>_ID] (PRIVAT_TOKEN_UTS → PRIVAT_TOKEN_UTS_ID) або окремій PRIVAT_ID_*.
// Заголовки: token (+ id, якщо є). Параметри: acc (IBAN), startDate=dd-mm-yyyy.
import type { BankAccountRow, NormalizedTx } from "./types.js";

const BASE = "https://acp.privatbank.ua/api/statements/transactions";

interface PrivatItem {
  ID?: string; REF?: string; TRANTYPE?: "C" | "D"; CCY?: string;
  SUM?: string | number; SUM_E?: string | number; OSND?: string;
  AUT_CNTR_NAM?: string; AUT_CNTR_ACC?: string;
  DAT_KL?: string; DAT_OD?: string; TIM_P?: string;
}

function parseDate(dat?: string, tim?: string): Date | null {
  if (!dat) return null;
  // формат privat: dd.mm.yyyy (+ час HH:MM:SS)
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dat.trim());
  if (!m) { const d = new Date(dat); return isNaN(+d) ? null : d; }
  const iso = `${m[3]}-${m[2]}-${m[1]}T${(tim && /^\d{2}:\d{2}/.test(tim)) ? tim : "00:00:00"}Z`;
  const d = new Date(iso); return isNaN(+d) ? null : d;
}

/** Чистий нормалізатор (тестується без мережі). Знак — з TRANTYPE (C=надходження, D=списання). */
export function normalizePrivat(it: PrivatItem, accountCurrency: string): NormalizedTx {
  const sign = it.TRANTYPE === "C" ? 1 : -1;
  const abs = Math.abs(Number(it.SUM ?? 0));
  const sumE = it.SUM_E != null ? Math.abs(Number(it.SUM_E)) : null; // UAH-еквівалент (для валютних)
  const currency = (it.CCY || accountCurrency || "UAH").toUpperCase();
  const booked = parseDate(it.DAT_KL) ?? parseDate(it.DAT_OD, it.TIM_P) ?? new Date(0);
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
    const body = (await res.json()) as { transactions?: PrivatItem[]; exist_next_page?: boolean; next_page_id?: string };
    for (const it of body.transactions ?? []) all.push(normalizePrivat(it, account.currency));
    if (!body.exist_next_page || !body.next_page_id) break;
    followId = body.next_page_id;
  }
  return all;
}
