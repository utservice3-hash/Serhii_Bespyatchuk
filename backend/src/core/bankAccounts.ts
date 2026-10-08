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
