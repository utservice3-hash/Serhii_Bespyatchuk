/**
 * 🏦 ВИПИСКА У ФОРМАТІ БАНКУ — CSV, який бухгалтерія вантажить туди ж, куди файл із
 * клієнт-банку (прохання Тані 21.09.2026: «підходить csv, якщо воно буде таке саме як в
 * прикладі»). ЧИСТИЙ модуль: нуль імпортів, на вхід сирий запис банку (`raw_json`), на
 * вихід байти. БД, права й приховані отримувачі — у `core/bankStatement.ts` і роуті.
 *
 * 📐 ФОРМАТ ПРИВАТ24 ЗНЯТО ЗАМІРОМ, А НЕ ЗДОГАДОМ (21.09.2026): банківський файл по
 * рахунку ФОП за серпень 2026 проти нашої бази — 178 рядків із 178 ідентичні після ОДНІЄЇ
 * заміни. Властивості, кожну з яких стереже `#480`:
 *   · Windows-1251, переноси LF, кожен рядок (і заголовок) закінчується `;`;
 *   · 13 колонок у порядку `PRIVAT_HEADER`; лапки й коми в тексті НЕ екрануються;
 *   · сума: списання з мінусом, тисячі через ПРОБІЛ, дві цифри після крапки (`-70 000.00`);
 *   · 🔴 банк пише ЛАТИНСЬКІ `i`/`I` замість українських `і`/`І` — 371 символ у 178 рядках,
 *     і це єдина відмінність вмісту. Без заміни збігалось 38 рядків зі 178;
 *   · порядок: час проведення СПАДНО, далі ідентифікатор СПАДНО — 174 позиції зі 178.
 *     ⚠️ Решта 4 — операції з однаковим часом до секунди, які банк розставляє за ознакою,
 *     якої API не віддає. На зміст і на імпорт не впливає, але «побайтно» тут неправда.
 *
 * ФОРМАТ МОНО — за зразком виписки з застосунку (UTF-8, кома, текст у лапках, порожнє `—`,
 * новіші зверху). ⚠️ МЕЖІ, НАЗВАНІ ВГОЛОС: (1) зразок був із КАРТКИ, а не з рахунку ФОП —
 * виписка ФОП у Моно може мати інші колонки, побайтно НЕ звірялось; (2) колонку «Курс» банк
 * рахує сам із шістьма знаками, і вона не дорівнює `сума / сума операції` (у зразку
 * 45.030846 проти 45.0332) — API курсу не віддає, тож пишемо частку і НЕ видаємо її за
 * банківську. Заміряно 21.09.2026: на рахунку ФОП Моно всі 305 операцій гривневі, валютних
 * нуль, тобто в наших даних ця колонка завжди `—`.
 */

export type RawTx = Record<string, unknown>;

export const PRIVAT_HEADER = [
  "ЄДРПОУ", "МФО", "Рахунок", "Валюта", "Номер документу", "Дата операції", "МФО банку",
  "Назва банку", "Рахунок кореспондента", "ЄДРПОУ кореспондента", "Кореспондент", "Сума",
  "Призначення платежу",
] as const;

export const MONO_HEADER = [
  "Дата i час операції", "Деталі операції", "MCC", "Сума в валюті картки (UAH)",
  "Сума в валюті операції", "Валюта", "Курс", "Сума комісій (UAH)", "Сума кешбеку (UAH)",
  "Залишок після операції",
] as const;

const s = (v: unknown): string => (v == null ? "" : String(v));

/** Банк пише латинські `i`/`I` на місці українських — див. доккоментар файла. */
export const privatLetters = (t: string): string => t.replace(/і/g, "i").replace(/І/g, "I");

/** `-70 000.00`: мінус для списання, пробіл у тисячах, рівно дві цифри після крапки. */
export function privatAmount(sum: unknown, isDebit: boolean): string {
  const n = Math.abs(Number(String(sum ?? "0").replace(/\s/g, "").replace(",", ".")));
  const [int, frac] = (Number.isFinite(n) ? n : 0).toFixed(2).split(".");
  return `${isDebit ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}.${frac}`;
}

/** `dd.mm.yyyy hh:mm:ss` → число для сортування; нерозбірне — 0 (їде в кінець). */
function privatTime(j: RawTx): number {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    s(j.DATE_TIME_DAT_OD_TIM_P) || `${s(j.DAT_OD)} ${s(j.TIM_P)}`);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : 0;
}
const digits = (v: unknown): bigint => { const d = s(v).replace(/\D/g, ""); return d ? BigInt(d) : 0n; };

export function privatRow(j: RawTx): string[] {
  return [
    s(j.AUT_MY_CRF), s(j.AUT_MY_MFO), s(j.AUT_MY_ACC), s(j.CCY), s(j.NUM_DOC), s(j.DAT_OD),
    s(j.AUT_CNTR_MFO), s(j.AUT_CNTR_MFO_NAME), s(j.AUT_CNTR_ACC), s(j.AUT_CNTR_CRF),
    s(j.AUT_CNTR_NAM), privatAmount(j.SUM, s(j.TRANTYPE) === "D"), s(j.OSND),
  ].map(privatLetters);
}

/** Текст виписки Приват24 (ще не байти): заголовок + рядки, кожен із хвостовим `;`, LF. */
export function privatCsvText(rows: RawTx[]): string {
  const sorted = [...rows].sort((a, b) => {
    const t = privatTime(b) - privatTime(a);
    if (t !== 0) return t;
    const da = digits(a.ID), db = digits(b.ID);
    return da === db ? 0 : db > da ? 1 : -1;
  });
  const line = (cells: readonly string[]) => `${cells.join(";")};`;
  return [line(PRIVAT_HEADER), ...sorted.map((j) => line(privatRow(j)))].join("\n") + "\n";
}

/**
 * Windows-1251 без залежностей: таблицю будуємо з ДЕКОДЕРА платформи (він у Node є),
 * обертаючи байти 0x80–0xFF. Символ поза кодуванням → `?`, і їх КІЛЬКІСТЬ повертається
 * другим числом: тихо загублений символ у реквізитах гірший за названий.
 */
let cp1251: Map<string, number> | null = null;
export function encodeCp1251(text: string): { bytes: Uint8Array; lost: number } {
  if (!cp1251) {
    cp1251 = new Map();
    const dec = new TextDecoder("windows-1251");
    for (let b = 0x80; b <= 0xff; b++) {
      const ch = dec.decode(Uint8Array.of(b));
      if (ch !== "�" && !cp1251.has(ch)) cp1251.set(ch, b);
    }
  }
  const out = new Uint8Array(text.length);
  let n = 0, lost = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out[n++] = code;
    else { const b = cp1251.get(ch); if (b == null) { out[n++] = 0x3f; lost++; } else out[n++] = b; }
  }
  return { bytes: out.subarray(0, n), lost };
}

// ── Моно ────────────────────────────────────────────────────────────────────────────────
const ISO_CURRENCY: Record<string, string> = { "980": "UAH", "840": "USD", "978": "EUR", "826": "GBP", "985": "PLN" };
const DASH = "—";

/** Копійки → число «як у банку»: щонайменше одна цифра після крапки (`2000.0`, `-225.15`). */
export function monoAmount(minor: unknown): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return DASH;
  const v = n / 100;
  return Number.isInteger(v) ? `${v}.0` : String(Number(v.toFixed(2)));
}
const monoOptional = (minor: unknown): string => (Number(minor) ? monoAmount(minor) : DASH);
/** У зразку банку в лапках лише поля з пробілом: `"Переказ на картку"`, але `Railway`, `Валюта`, `Курс`. */
const q = (t: string): string => (/[\s",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

/** Unix-секунди → `dd.mm.yyyy hh:mm:ss` за Києвом. */
export function monoTime(unix: unknown): string {
  const d = new Date(Number(unix) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("day")}.${g("month")}.${g("year")} ${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}:${g("second")}`;
}

export function monoRow(j: RawTx): string[] {
  const amount = Number(j.amount), op = Number(j.operationAmount);
  const foreign = s(j.currencyCode) !== "980" && Number.isFinite(amount) && Number.isFinite(op) && op !== 0;
  return [
    q(monoTime(j.time)), q(s(j.description)), s(j.mcc), monoAmount(j.amount), monoAmount(j.operationAmount),
    ISO_CURRENCY[s(j.currencyCode)] ?? s(j.currencyCode),
    // ⚠️ частка, а НЕ банківський курс — див. доккоментар файла.
    foreign ? String(Number((amount / op).toFixed(6))) : DASH,
    monoOptional(j.commissionRate), monoOptional(j.cashbackAmount), monoAmount(j.balance),
  ];
}

export function monoCsvText(rows: RawTx[]): string {
  const sorted = [...rows].sort((a, b) => Number(b.time) - Number(a.time));
  return [MONO_HEADER.map(q).join(","), ...sorted.map((j) => monoRow(j).join(","))].join("\n") + "\n";
}

/**
 * МЕЖА ПРИХОВАНИХ — чиста, щоб її можна було довести без БД. Та сама, що у стрічці
 * `/outgoing`: ховаються лише ВИХІДНІ, за імʼям отримувача; роль із правом бачить усе.
 * Повертає І видимі, І кількість відкинутих: неповний файл мусить називати свою неповноту.
 */
export function excludeHidden<T extends { direction: string; counterparty_name: string | null }>(
  rows: T[], isHiddenName: (name: string | null) => boolean, canSeeHidden: boolean,
): { visible: T[]; hiddenExcluded: number } {
  const visible = canSeeHidden ? rows : rows.filter((x) => !(x.direction === "out" && isHiddenName(x.counterparty_name)));
  return { visible, hiddenExcluded: rows.length - visible.length };
}

export type StatementBank = "privat" | "mono";

/** Один вхід для роута: банк рахунку вирішує формат і кодування. */
export function statementFile(bank: StatementBank, rows: RawTx[]): { body: Uint8Array; charset: string; lost: number } {
  if (bank === "mono") return { body: new TextEncoder().encode(monoCsvText(rows)), charset: "utf-8", lost: 0 };
  const { bytes, lost } = encodeCp1251(privatCsvText(rows));
  return { body: bytes, charset: "windows-1251", lost };
}
