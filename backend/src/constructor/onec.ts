/**
 * 🧾 РЕКВІЗИТИ КОНТРАГЕНТА З 1С — для конструктора (06.10.2026, зустріч TOP Weekly 05.10, Сергій):
 * «перевіряємо ЄДРПОУ спочатку в 1С; є — заповнюємо все, з рахунком; немає (нова компанія) — тягнемо з реєстру».
 *
 * Джерело — метод 1С `customerInfo` (лист Андрія від 04.10.2026), той самий сервіс `…/rest-bk/hs/service/`,
 * з якого вже йдуть рахунки дебіторки. Лише ЧИТАННЯ: у 1С звідси не пишеться нічого (`createCustomer` — не ця задача).
 *
 * 📐 Заміряно на проді 06.10.2026 по всіх 67 відомих нам кодах (дебіторка + довідник конструктора):
 *  - знайдено 65; IBAN є лише у 28 (43%), і 4 з них НЕ у форматі `UA` + 27 цифр;
 *  - адреса 62, телефон 57, e-mail 35, контактна особа 61;
 *  - ДИРЕКТОРА 1С НЕ ВІДДАЄ ВЗАГАЛІ (поля немає) — тому директор, офіційна назва й стан лишаються за ЄДР;
 *  - відповідь — медіана 56 мс, перша (холодна) 2.7 с.
 * Звідси дві речі, на яких стоїть `mergeRequisites`: некоректний IBAN НЕ підставляємо (менеджер не помітить чужу
 * цифру в 29 знаках), а «у 1С рахунку немає» кажемо словами — порожнє поле читалось би як «ще не завантажилось».
 *
 * ⚠️ Модуль навмисно НЕ імпортує `config.js`: той кидає без `DATABASE_URL` ще на імпорті, а гейти ганяють
 * `fromOneC`/`mergeRequisites` без бази.
 */
import { shortOrgName } from "./services/docgen.js";
import { toGuillemets, type RegistryCard } from "./youscore.js";

export const ONEC_CUSTOMER_INFO_URL =
  process.env.ONEC_CUSTOMER_INFO_URL ?? "http://193.200.173.188:8010/rest-bk/hs/service/customerInfo";
/** Читання в 1С — частки секунди; холодний старт заміряно 2.7 с. 10 с — із запасом, але не тримає менеджера. */
const TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init: { signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** Картка з 1С у полях форми. `ibanRaw` — що лежить у 1С, навіть некоректне: його показуємо, але не підставляємо. */
export interface OneCCard {
  edrpou: string; name: string; ipn: string; addr: string; phone: string; email: string;
  iban: string; bank: string; ibanRaw: string; isFop: boolean;
}

export type OneCLookup =
  | { kind: "ok"; card: OneCCard }
  | { kind: "notFound" }
  | { kind: "failed"; why: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const IBAN_RE = /^UA\d{27}$/;

/** Відповідь `customerInfo` → поля форми. Чиста функція: гейти ганяють рівно її. */
export function fromOneC(code: string, j: any): OneCCard {
  const isFop = !str(j?.edrpou) && /^\d{10}$/.test(str(j?.inn) || code);
  const raw = str(j?.bank_account).replace(/\s+/g, "").toUpperCase();
  const valid = IBAN_RE.test(raw);
  // У 1С лапка буває впритул до слова: `КОМПАНІЯ"АРІЯ"` (заміряно на проді 06.10). `toGuillemets` вважає лапку
  // після літери закривною і дає `КОМПАНІЯ»АРІЯ»`; лапка МІЖ двома літерами може бути лише відкривною — додаємо пробіл.
  const full = str(j?.name).replace(/(\p{L})"(?=\p{L})/gu, '$1 "');
  return {
    edrpou: str(j?.edrpou) || str(j?.inn) || code,
    name: isFop ? full : toGuillemets(shortOrgName(full)),
    ipn: str(j?.vat_number),
    addr: str(j?.legal_address) || str(j?.actual_address),
    phone: str(j?.phones), email: str(j?.email),
    iban: valid ? raw : "", bank: valid ? str(j?.bank_name) : "", ibanRaw: raw, isFop,
  };
}

/** Один запит до 1С. Код 10 цифр — ФОП (`inn`), 8 — юрособа (`edrpou`), як у листі 1С. */
export async function lookup1c(code: string, opts: { doFetch?: FetchLike; url?: string } = {}): Promise<OneCLookup> {
  const doFetch = opts.doFetch ?? (fetch as unknown as FetchLike);
  const param = code.length === 10 ? "inn" : "edrpou";
  try {
    const r = await doFetch(`${opts.url ?? ONEC_CUSTOMER_INFO_URL}?${param}=${encodeURIComponent(code)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status !== 200) return { kind: "failed", why: `1С відповіла ${r.status}` };
    const j: any = await r.json().catch(() => null);
    if (!j || typeof j !== "object") return { kind: "failed", why: "1С віддала не JSON" };
    if (j.state !== true) return { kind: "notFound" };
    return { kind: "ok", card: fromOneC(code, j) };
  } catch (e) {
    return { kind: "failed", why: (e as Error)?.name === "TimeoutError" ? "1С не відповіла за 10 с" : "1С недоступна" };
  }
}

/** Рядок довідника конструктора — рівно ті поля, що потрібні для зведення. */
export interface BookRow { iban: string | null; bank: string | null; director?: string | null }

/** Звідки взято IBAN: 1С, довідник конструктора, або ніде (менеджер впише руками). */
export type IbanSource = "1c" | "book" | null;

export interface MergedCard {
  edrpou: string; name: string; ipn: string; addr: string; dir: string; phone: string; email: string;
  iban: string; bank: string; isFop: boolean;
  ibanSource: IbanSource;
  /** У 1С рахунок є, але не у форматі UA+27 цифр — показуємо текстом, не підставляємо. */
  ibanInvalid1c: string | null;
  /** У довіднику ІНШИЙ IBAN, ніж у 1С: підставлено 1С (рішення Романа 06.10), довідниковий — поруч кнопкою. */
  bookIban: { iban: string; bank: string } | null;
  warn: string | null;
}

const normIban = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * Зведення трьох джерел (рішення Романа 06.10.2026, обидва пункти — як запропоновано):
 *  - 1С — рахунок, банк, адреса, телефон, пошта, ІПН ПДВ (бухгалтерія: саме на цей рахунок підуть платежі);
 *  - ЄДР — директор, офіційна назва, стан (у 1С директора немає; без ЄДР поле, що сьогодні заповнюється само,
 *    стало б ручним — регрес); там, де 1С порожня, ЄДР теж підстраховує контакти й адресу;
 *  - довідник — IBAN лише тоді, коли в 1С коректного немає. Розходиться з 1С — НЕ перезаписуємо мовчки.
 */
export function mergeRequisites(one: OneCCard, reg: RegistryCard | null, book: BookRow | null): MergedCard {
  const bookIban = normIban(book?.iban);
  let iban = one.iban, bank = one.bank, ibanSource: IbanSource = one.iban ? "1c" : null;
  let conflict: MergedCard["bookIban"] = null;
  if (!iban && bookIban) { iban = bookIban; bank = (book?.bank ?? "").trim(); ibanSource = "book"; }
  else if (iban && bookIban && bookIban !== iban) conflict = { iban: bookIban, bank: (book?.bank ?? "").trim() };
  return {
    edrpou: one.edrpou,
    name: reg?.name || one.name,
    ipn: one.ipn || reg?.ipn || "",
    addr: one.addr || reg?.addr || "",
    dir: reg?.dir || (book?.director ?? "").trim(),
    phone: one.phone || reg?.phone || "",
    email: one.email || reg?.email || "",
    iban, bank, isFop: reg?.isFop ?? one.isFop, ibanSource,
    ibanInvalid1c: !one.iban && one.ibanRaw ? one.ibanRaw : null,
    bookIban: conflict,
    warn: reg?.warn ?? null,
  };
}

/** Рядок довідника, як його віддає роут (повний — для гілки «у 1С немає», де довідник іде як є). */
export type BookFull = BookRow & Record<string, unknown>;
type RegistryLookup = Awaited<ReturnType<typeof import("./youscore.js").lookupRegistry>>;

export type ResolveResult =
  | { kind: "json"; status: 200 | 202; body: Record<string, unknown> }
  | { kind: "error"; status: 404; message: string };

/**
 * 🔀 ПОРЯДОК ДЖЕРЕЛ ДЛЯ «ЗА ЄДРПОУ» — одна функція на роут і на гейти (залежності — параметрами).
 *  1. 1С знайшла → реквізити з 1С + директор/назва/стан з ЄДР + IBAN довідника як запасний або для розбіжності.
 *     ЄДР «оновлюється» (202) чи недоступний → 1С-частину віддаємо ОДРАЗУ (200), а не губимо: фронт допитає
 *     директора повтором і підставить лише в порожні поля.
 *  2. 1С не знайшла АБО недоступна → рівно як було до 06.10: довідник → ЄДР. Збій 1С лише ПІДПИСУЄТЬСЯ —
 *     автопідстановка не має лягти разом із сервером бухгалтерії.
 */
export async function resolveRequisites(code: string, deps: {
  oneC: () => Promise<OneCLookup>;
  registry: () => Promise<RegistryLookup>;
  book: () => Promise<BookFull | null>;
}): Promise<ResolveResult> {
  const [one, book] = await Promise.all([deps.oneC(), deps.book()]);
  const oneC = one.kind === "ok" ? "ok" : one.kind;
  const oneCWhy = one.kind === "failed" ? one.why : null;
  if (one.kind === "ok") {
    const reg = await deps.registry();
    const card = mergeRequisites(one.card, reg.kind === "ok" ? reg.card : null, book);
    return { kind: "json", status: 200, body: {
      source: "1c", card, registry: reg.kind, cached: reg.kind === "ok" ? reg.cached : false,
      registryWhy: reg.kind === "failed" ? reg.why : null,
    } };
  }
  if (book) return { kind: "json", status: 200, body: { source: "book", row: book, oneC, oneCWhy } };
  const r = await deps.registry();
  const tail1c = one.kind === "failed" ? ` ${oneCWhy} — перевірити в 1С не вдалося.` : "";
  const manual = `Заповніть реквізити — після формування контрагент збережеться в довіднику.${tail1c}`;
  if (r.kind === "ok") return { kind: "json", status: 200, body: { source: "youscore", card: r.card, cached: r.cached, oneC, oneCWhy } };
  if (r.kind === "updating") return { kind: "json", status: 202, body: { updating: true, error: "Реєстр оновлює дані цієї компанії — повторюю за 20 секунд." } };
  if (r.kind === "notFound") return { kind: "error", status: 404, message: `Коду ${code} немає ні в 1С, ні в довіднику, ні в ЄДР. Перевірте цифри. ${manual}` };
  if (r.kind === "unconfigured") return { kind: "error", status: 404, message: `У 1С і в довіднику такого коду немає, а пошук у ЄДР не налаштовано. ${manual}` };
  return { kind: "error", status: 404, message: `У 1С і в довіднику такого коду немає, а ЄДР зараз не відповідає (${r.why}). ${manual}` };
}
