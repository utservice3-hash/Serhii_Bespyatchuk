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

// client-info віддає ВСІ рахунки під токеном, зокрема особисті картки власника
// (black/white/platinum/iron/yellow…) і банки-jars. Синкаємо ЛИШЕ ФОП (type='fop').
interface MonoAccount { id: string; type?: string; currencyCode?: number; iban?: string }
interface MonoClientInfo { accounts?: MonoAccount[]; jars?: unknown[] }

async function fetchClientInfo(token: string): Promise<MonoClientInfo> {
  const res = await fetch(`${BASE}/personal/client-info`, {
    headers: { "X-Token": token }, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`monobank client-info ${res.status}`);
  return (await res.json()) as MonoClientInfo;
}

/** Знаходить ФОП-рахунок під токеном (type='fop'); особисті картки та jars ігноруються.
 *  Кілька ФОП-рахунків (мультивалюта) → беремо той, що збігається з валютою рядка, інакше
 *  перший. Повертає id або null. Викликається ЛИШЕ поки external_account_id не збережено —
 *  щоб не бити ліміт mono «1 запит / 60с» client-info щоциклу. */
export async function resolveAccountId(account: BankAccountRow): Promise<string | null> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) throw new Error(`monobank: немає env ${account.env_key_name}`);
  const info = await fetchClientInfo(token);
  const fops = (info.accounts ?? []).filter((a) => a.type === "fop");
  if (fops.length === 0) return null;
  const match = fops.find((a) => CCY[String(a.currencyCode)] === account.currency);
  return (match ?? fops[0]).id;
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
  // ⚠️ НІКОЛИ не '0' (дефолт = особиста картка власника, її бачили б усі ролі). Синкаємо лише
  // явний ФОП-рахунок: збережений external_account_id або резолв через client-info (type='fop').
  const acc = account.external_account_id ?? (await resolveAccountId(account));
  if (!acc) throw new Error(`monobank: не знайдено ФОП-рахунок під токеном ${account.env_key_name}`);
  // monobank statement — максимум 31 доба + 1 год за запит. Клампимо `from`, щоб перший
  // (широкий) прохід не падав 400; глибший бекфіл — не потрібен (виписка за поточний період).
  const MONO_MAX_SEC = 31 * 24 * 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const from = Math.max(Math.floor(since.getTime() / 1000), nowSec - MONO_MAX_SEC);
  const to = nowSec;
  const res = await fetch(`${BASE}/personal/statement/${acc}/${from}/${to}`, {
    headers: { "X-Token": token }, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`monobank ${res.status}`);
  const items = (await res.json()) as MonoItem[];
  return (Array.isArray(items) ? items : []).map((it) => normalizeMono(it, account.currency));
}
