/**
 * 🏦 ПОЛЯ РАХУНКУ «ВИПИСКИ», ЯКІ ПИШЕ ЛЮДИНА (Роман 07.10.2026: «додавати будь-яку карту без програміста»).
 *
 * Один вхід для «створити» і «змінити», щоб правила не розійшлись між двома роутами:
 *  · назва змінної ключа — лише свого банку (`MONO_TOKEN_…` / `PRIVAT_TOKEN_…`, `bankSources/token.ts`); чужий секрет
 *    (`JWT_SECRET`, `KOMMO_API_TOKEN`) назвою ключа банку стати не може;
 *  · картка працівника (`staff`) — лише моно і лише з останніми 4 цифрами: під токеном людини лежать і її особисті
 *    рахунки, тож без цифр сервер не вгадує;
 *  · новий рахунок завжди ВИМКНЕНИЙ: вмикає людина, коли токен уже в `.env` (стан видно в панелі).
 * Чисті функції без бази — тримає #1224.
 */
import { FinError } from "./finance.js";
import { TOKEN_NAME } from "../bankSources/token.js";
import { normLast4, normIban } from "../bankSources/mono.js";

export const COMPANIES = ["uts", "automuv", "fop_privat", "fop_mono", "staff"] as const;
export const CURRENCIES = ["UAH", "USD", "EUR"] as const;
type Bank = "mono" | "privat";

/** Назва змінної ключа: порожньо → null (рахунок без ключа, «API ✗»); інакше — рівно шаблон свого банку. */
export function checkEnvKeyName(bank: string, raw: unknown): string | null {
  const name = String(raw ?? "").trim();
  if (!name) return null;
  if (bank !== "mono" && bank !== "privat") throw new FinError(400, "Ключ буває лише в рахунку monobank чи Привату");
  if (!TOKEN_NAME[bank as Bank].test(name)) {
    const prefix = bank === "mono" ? "MONO_TOKEN_" : "PRIVAT_TOKEN_";
    throw new FinError(400, `Назва змінної ключа — ${prefix}… (великі латинські літери, цифри, «_»), напр. ${prefix}SASHA`);
  }
  return name;
}

export interface NewAccount {
  company: string; bank: Bank; label: string; currency: string; envKeyName: string | null;
  monoPanLast4: string | null; iban: string | null; financeOnly: boolean; isActive: false;
}

/** Перевірка нового рахунку. Картка працівника: моно + 4 цифри; «лише фінанси» для неї — за замовчуванням так. */
export function validateNewAccount(b: Record<string, unknown>): NewAccount {
  const company = String(b.company ?? "");
  if (!(COMPANIES as readonly string[]).includes(company)) throw new FinError(400, "Невірна компанія");
  const bank = String(b.bank ?? "");
  if (bank !== "mono" && bank !== "privat") throw new FinError(400, "Банк — monobank або Приват");
  const label = String(b.label ?? "").trim();
  if (!label) throw new FinError(400, "Потрібна назва");
  const currency = String(b.currency ?? "UAH");
  if (!(CURRENCIES as readonly string[]).includes(currency)) throw new FinError(400, "Валюта — UAH, USD або EUR");
  const envKeyName = checkEnvKeyName(bank, b.envKeyName);
  const rawLast4 = String(b.monoPanLast4 ?? "").trim();
  const monoPanLast4 = normLast4(rawLast4);
  if (rawLast4 && !monoPanLast4) throw new FinError(400, "Останні цифри картки — рівно 4 цифри");
  if (monoPanLast4 && bank !== "mono") throw new FinError(400, "Останні 4 цифри картки — лише для monobank");
  if (company === "staff" && bank !== "mono") throw new FinError(400, "Картку працівника підключаємо лише з monobank (у Привату для фізосіб API немає)");
  const rawIban = String(b.iban ?? "").trim();
  const iban = rawIban ? normIban(rawIban) : null;
  if (rawIban && !iban) throw new FinError(400, "IBAN — UA і 27 цифр (пробіли можна)");
  // Картку працівника знаходимо за IBAN (надійніше: не міняється при перевипуску) або за 4 цифрами картки.
  if (company === "staff" && !monoPanLast4 && !iban) throw new FinError(400, "Для картки працівника потрібні останні 4 цифри картки або IBAN рахунку");
  const financeOnly = b.financeOnly == null ? company === "staff" : b.financeOnly === true;
  return { company, bank, label, currency, envKeyName, monoPanLast4, iban, financeOnly, isActive: false };
}

/** Поля, які панель керування може змінити: ключ запиту → колонка. Решта ключів ігнорується. */
const UPDATABLE: Record<string, string> = { label: "label", currency: "currency", externalAccountId: "external_account_id",
  isActive: "is_active", legalName: "legal_name", edrpouIpn: "edrpou_ipn", iban: "iban", bankName: "bank_name", mfo: "mfo", purpose: "purpose",
  envKeyName: "env_key_name", vatIpn: "vat_ipn", legalAddress: "legal_address", director: "director", bankEdrpou: "bank_edrpou", keyCard: "key_card" };

/**
 * `SET`-частина оновлення рахунку (#1239). Правила ті самі, що при створенні: ключ — лише свого банку; у картки
 * працівника IBAN — справжній; цифри картки — рівно 4. Зміна цифр чи IBAN картки скидає привʼязку до рахунку моно —
 * ОДНИМ виразом: 08.10.2026 панель слала цифри й IBAN разом, і два окремі `external_account_id = …` Postgres відкидав
 * («multiple assignments»), тож «Зберегти» мовчки не зберігало нічого.
 */
export function buildAccountUpdate(b: Record<string, unknown>, cur: { bank: string; company: string }): { sets: string[]; params: unknown[] } {
  const v: Record<string, unknown> = { ...b };
  if ("envKeyName" in v) v.envKeyName = checkEnvKeyName(cur.bank, v.envKeyName);
  if ("iban" in v && cur.company === "staff") {
    const raw = String(v.iban ?? "").trim();
    const iban = raw ? normIban(raw) : null;
    if (raw && !iban) throw new FinError(400, "IBAN — UA і 27 цифр (пробіли можна)");
    v.iban = iban;
  }
  const sets: string[] = []; const params: unknown[] = []; const rebind: string[] = [];
  for (const [k, col] of Object.entries(UPDATABLE)) if (k in v) {
    params.push(v[k]); sets.push(`${col} = $${params.length}`);
    if (k === "iban" && cur.company === "staff") rebind.push(`iban IS DISTINCT FROM $${params.length}`);
  }
  if ("monoPanLast4" in v) {
    const raw = String(v.monoPanLast4 ?? "").trim();
    const last4 = normLast4(raw);
    if (raw && !last4) throw new FinError(400, "Останні цифри картки — рівно 4 цифри");
    params.push(last4); sets.push(`mono_pan_last4 = $${params.length}`);
    rebind.push(`mono_pan_last4 IS DISTINCT FROM $${params.length}`);
  }
  if (rebind.length && !("externalAccountId" in v))
    sets.push(`external_account_id = CASE WHEN ${rebind.join(" OR ")} THEN NULL ELSE external_account_id END`);
  return { sets, params };
}
