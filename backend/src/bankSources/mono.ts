// monobank Personal API. Токен — process.env[account.env_key_name] (напр. MONO_TOKEN_FOP).
// GET /personal/statement/{account}/{from}/{to} (unix сек, ≤31 день/запит), заголовок X-Token.
import type { BankAccountRow, NormalizedTx } from "./types.js";

const BASE = "https://api.monobank.ua";
const CCY: Record<string, string> = { "980": "UAH", "840": "USD", "978": "EUR" };

interface MonoItem {
  id: string; time: number; description?: string; comment?: string;
  amount: number; operationAmount?: number; currencyCode?: number;
  counterEdrpou?: string; counterIban?: string; counterName?: string;
}

/** Чистий нормалізатор (тестується без мережі). amount monobank — у копійках, signed. */
export function normalizeMono(it: MonoItem, accountCurrency: string): NormalizedTx {
  const amount = (it.amount ?? 0) / 100; // копійки → одиниці, знак зберігається
  const currency = it.currencyCode != null ? (CCY[String(it.currencyCode)] ?? accountCurrency) : accountCurrency;
  const when = new Date((it.time ?? 0) * 1000);
  return {
    externalTxId: `mono:${it.id}`,
    direction: amount >= 0 ? "in" : "out",
    bookedAt: when,
    processedAt: when,
    counterpartyName: it.counterName ?? it.description ?? null,
    counterpartyIban: it.counterIban ?? null,
    purpose: it.comment ?? it.description ?? null,
    amount, // signed, у валюті рахунку
    currency,
    fxRate: null, // Personal API дає суму у валюті рахунку без UAH-крос → фолбек НБУ
    raw: it,
  };
}

export async function fetchTransactions(account: BankAccountRow, since: Date): Promise<NormalizedTx[]> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) throw new Error(`monobank: немає env ${account.env_key_name}`);
  const acc = account.external_account_id ?? "0"; // '0' = дефолтний рахунок токена
  const from = Math.floor(since.getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);
  const res = await fetch(`${BASE}/personal/statement/${acc}/${from}/${to}`, {
    headers: { "X-Token": token }, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`monobank ${res.status}`);
  const items = (await res.json()) as MonoItem[];
  return (Array.isArray(items) ? items : []).map((it) => normalizeMono(it, account.currency));
}
