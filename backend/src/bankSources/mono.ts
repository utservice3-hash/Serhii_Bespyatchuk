// monobank Personal API. Токен — process.env[account.env_key_name] (напр. MONO_TOKEN_FOP).
// GET /personal/statement/{account}/{from}/{to} (unix сек, ≤31 день/запит), заголовок X-Token.
import type { AccountBalance, BankAccountRow, NormalizedTx } from "./types.js";

const BASE = "https://api.monobank.ua";
const CCY: Record<string, string> = { "980": "UAH", "840": "USD", "978": "EUR" };

interface MonoItem {
  id: string; time: number; description?: string; comment?: string;
  amount: number; operationAmount?: number; currencyCode?: number;
  counterEdrpou?: string; counterIban?: string; counterName?: string;
}

// client-info віддає ВСІ рахунки під токеном, зокрема особисті картки власника
// (black/white/platinum/iron/yellow…) і банки-jars. Рахунок рядка `bank_accounts` обирається ЯВНО:
// `mono_type` IS NULL → ФОП (type='fop'), інакше — картка цього типу (прохід 2г фінансів, 05.10.2026; такі
// рядки мають `finance_only`, тож їх операції не бачать ролі без `view_cashflow`). Банки-jars не беремо ніколи.
interface MonoAccount { id: string; type?: string; currencyCode?: number; iban?: string; balance?: number; maskedPan?: string[] }
interface MonoClientInfo { accounts?: MonoAccount[]; jars?: unknown[] }

/**
 * Обирає рахунок рядка під валюту: ФОП (`mono_type` порожній) або картку свого типу. Кілька однакових
 * (мультивалюта) → той, що збігається з валютою, інакше перший. Спільна логіка резолву й балансу.
 */
export function pickAccount(info: MonoClientInfo, currency: string, monoType: string | null | undefined = null,
  panLast4: string | null | undefined = null): MonoAccount | null {
  // Останні 4 цифри картки (картка працівника, 07.10.2026) точніші за тип: під одним токеном буває дві black.
  const same = panLast4
    ? (info.accounts ?? []).filter((a) => (a.maskedPan ?? []).some((p) => p.endsWith(panLast4)))
    : (info.accounts ?? []).filter((a) => a.type === (monoType ?? "fop"));
  if (same.length === 0) return null;
  return same.find((a) => CCY[String(a.currencyCode)] === currency) ?? same[0];
}

/** Рівно 4 цифри або нічого: «1234» → «1234», «**** 1234»/«12345»/«» → null. Спільне для роута й адаптера. */
export function normLast4(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}$/.test(s) ? s : null;
}

/**
 * Рахунок рядка під токеном. Картка працівника (`company = 'staff'`) — ЛИШЕ за останніми 4 цифрами: без них під його
 * токеном лежать і особисті рахунки, і «перший ФОП чи black» був би вгадуванням. Тоді null — рядок не привʼязується.
 */
export function accountFor(info: MonoClientInfo, account: BankAccountRow): MonoAccount | null {
  const last4 = normLast4(account.mono_pan_last4);
  if (account.company === "staff" && !last4) return null;
  return pickAccount(info, account.currency, account.mono_type, last4);
}

// 🕐 Ліміт моно — «1 запит / 60 с» НА ТОКЕН. Під одним токеном тепер кілька рахунків (ФОП + картки), тож запити
// одного токена розводимо в часі, а `client-info` (баланси всіх рахунків разом) кешуємо на хвилину.
const MONO_GAP_MS = 61_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lastCall = new Map<string, number>();
const infoCache = new Map<string, { at: number; info: MonoClientInfo }>();
async function paced<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const wait = (lastCall.get(token) ?? 0) + MONO_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try { return await fn(); } finally { lastCall.set(token, Date.now()); }
}

async function fetchClientInfo(token: string): Promise<MonoClientInfo> {
  const hit = infoCache.get(token);
  // 5 хв: одного `client-info` вистачає на весь цикл синку (баланси всіх рахунків токена разом); інакше кожен
  // рахунок платив би ще хвилиною очікування.
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.info;
  const info = await paced(token, async () => {
    const res = await fetch(`${BASE}/personal/client-info`, {
      headers: { "X-Token": token }, signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`monobank client-info ${res.status}`);
    return (await res.json()) as MonoClientInfo;
  });
  infoCache.set(token, { at: Date.now(), info });
  return info;
}

/** Знаходить ФОП-рахунок під токеном (type='fop'); особисті картки та jars ігноруються.
 *  Кілька ФОП-рахунків (мультивалюта) → беремо той, що збігається з валютою рядка, інакше
 *  перший. Повертає id або null. Викликається ЛИШЕ поки external_account_id не збережено —
 *  щоб не бити ліміт mono «1 запит / 60с» client-info щоциклу. */
export async function resolveAccountId(account: BankAccountRow): Promise<string | null> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) throw new Error(`monobank: немає env ${account.env_key_name}`);
  return accountFor(await fetchClientInfo(token), account)?.id ?? null;
}

/** IBAN привʼязаного рахунку з того самого `client-info` (кеш 5 хв — без зайвого запиту). Потрібен, щоб поповнення
 *  картки з наших рахунків впізнавались як «між своїми» (`bankTotals`). null — банк не дав. */
export async function resolveIban(account: BankAccountRow): Promise<string | null> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) return null;
  return accountFor(await fetchClientInfo(token), account)?.iban ?? null;
}

/** Залишок ФОП-рахунку з client-info (balance — у копійках). null → «—» (нема ключа / нема ФОП). */
export async function fetchBalance(account: BankAccountRow): Promise<AccountBalance | null> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) return null;
  const fop = accountFor(await fetchClientInfo(token), account);
  if (!fop) return null;
  return { amount: (fop.balance ?? 0) / 100, currency: CCY[String(fop.currencyCode)] ?? account.currency };
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

// statement monobank — максимум 31 доба+1год/запит. Беремо запас під межу. Бекфіл на 60 днів
// → 2 вікна. Пауза між чанками — під ліміт «1 запит/60с» (429), лише КОЛИ є наступний чанк.
const MONO_WINDOW_SEC = 30 * 24 * 3600; // ≤31 доба на одне вікно виписки
async function fetchWindow(acc: string, token: string, from: number, to: number, currency: string): Promise<NormalizedTx[]> {
  const res = await paced(token, () => fetch(`${BASE}/personal/statement/${acc}/${from}/${to}`, {
    headers: { "X-Token": token }, signal: AbortSignal.timeout(30000),
  }));
  if (!res.ok) throw new Error(`monobank ${res.status}`);
  const items = (await res.json()) as MonoItem[];
  return (Array.isArray(items) ? items : []).map((it) => normalizeMono(it, currency));
}

export async function fetchTransactions(account: BankAccountRow, since: Date): Promise<NormalizedTx[]> {
  const token = account.env_key_name ? process.env[account.env_key_name] : undefined;
  if (!token) throw new Error(`monobank: немає env ${account.env_key_name}`);
  // ⚠️ НІКОЛИ не '0' (дефолт = особиста картка власника, її бачили б усі ролі). Синкаємо лише
  // явний рахунок рядка: збережений external_account_id або резолв через client-info (ФОП чи картка
  // свого `mono_type`; картки — лише в рядках `finance_only`, які ролям без `view_cashflow` не видно).
  const acc = account.external_account_id ?? (await resolveAccountId(account));
  if (!acc) throw new Error(`monobank: не знайдено ФОП-рахунок під токеном ${account.env_key_name}`);
  const nowSec = Math.floor(Date.now() / 1000);
  let from = Math.floor(since.getTime() / 1000);
  const all: NormalizedTx[] = [];
  for (let guard = 0; from < nowSec && guard < 6; guard++) { // чанкуємо вперед вікнами ≤31 доба
    const to = Math.min(from + MONO_WINDOW_SEC, nowSec);
    all.push(...(await fetchWindow(acc, token, from, to, account.currency)));
    if (to >= nowSec) break;
    from = to + 1; // наступний чанк сам дочекається ліміту токена (`paced`)
  }
  return all;
}
