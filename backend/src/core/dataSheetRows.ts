/**
 * 📤 Банківські операції → вкладка «Data» таблиці «💰UTS (CF, PL, BS)» (18.11.2026, Роман; погоджено з фінансистом Олександром).
 * Чисте ядро без мережі й БД: відбір (SQL-рядок), правило «операція → рядок Data» і склад запиту до Google.
 * Джоба — `jobs/exportDataSheet.ts`, запис — `bankSources/googleSheetsWrite.ts` (`insertDataRows`).
 *
 * Що пишемо (як разовий перенос 01.07–17.11.2026, рядки 13853–25101): D «Період» = 1-ше число місяця (ДАТА, не текст —
 * CF рахує SUMIFS по даті), E дата, G сума у валюті рахунку, H валюта, M рахунок, N legal entity, O контрагент,
 * Q призначення (ЗАВЖДИ текстом). B, C, I–L, S — формули, копіюються з рядка над вставкою. Решту веде фінансист.
 *
 * 🔴 ТРИ ПАСТКИ, КУПЛЕНІ НА РАЗОВОМУ ПЕРЕНОСІ 18.11.2026:
 *  1. `deleted_at` — Сейф видаляє рядки позначкою; перенос без фільтра заніс у Data 20 видалених рядків Сейфу.
 *  2. Межі формул CF обмежені номером рядка (`Data!$N$2:$N$20638`) — рядки ВСТАВЛЯЮТЬСЯ після останнього заповненого,
 *     тоді Google сам розсуває межі. Дописаний у кінець рядок CF не бачить.
 *  3. Призначення з самих цифр («62586299») Google робить числом → формула ПДВ (REGEXMATCH) дає #VALUE!.
 */

/** Перший день, з якого Data веде система (до нього — ручне ведення фінансиста). */
export const DATA_SHEET_FROM = "2026-07-01";

/** Скільки рядків пишемо за прогін — запас від ліміту розміру запиту Google; решта піде наступного дня. */
export const DATA_SHEET_MAX_ROWS = 3000;

export type AccountRule = { m: string; n: string } | { safe: true };

/**
 * Рахунок дашборда (`bank_accounts.id`) → M «Рахунок» і N «Legal entity» у Data. Назви — як у живій Data.
 * Беспятчук — назви тимчасові (у списку M їх ще немає; Роман 18.11: «ігноруй»).
 */
export const DATA_SHEET_ACCOUNTS: Readonly<Record<number, AccountRule>> = {
  1: { m: 'ТОВ "ЮТС"', n: "ТОВ ЮТС" },
  2: { m: 'ТОВ "Автомув" (UAH)', n: "ТОВ Автомув" },
  5: { m: 'ТОВ "Автомув" (USD)', n: "ТОВ Автомув" },
  6: { m: 'ТОВ "Автомув" (EUR)', n: "ТОВ Автомув" },
  3: { m: "Беспятчук Приват", n: "ФОП Беспятчук" },
  4: { m: "Беспятчук Моно", n: "ФОП Беспятчук" },
  9: { m: "Беспятчук white", n: "ФОП Беспятчук" },
  11: { m: "Ступаківський Моно", n: "ФОП Ступаківський" },
  7: { safe: true },
};

/**
 * Рахунки, які свідомо НЕ йдуть у Data — з причиною. Решта невідомих рахунків (новий рахунок у «Виписці») — НЕ мовчки:
 * джоба називає їх помилкою прогону, поки хтось не впише рахунок сюди чи в `DATA_SHEET_ACCOUNTS`.
 */
export const DATA_SHEET_EXCLUDED: Readonly<Record<number, string>> = {
  8: "Картка black — неактивна, у Data такого рахунку немає; у разовий перенос 18.11.2026 не входила",
  10: "Картка «Зроблено в Україні» — неактивна, операцій немає",
};

/** Хвіст «· угода N», який Сейф додає до призначення у дашборді — у Data його немає. */
export const SAFE_DEAL_SUFFIX = /\s*·\s*угода\s*\d+\s*$/;

/**
 * Відбір: не видалені, з `DATA_SHEET_FROM` ($1) і лише ПОВНІ дні (до вчора за Києвом), ще не записані в Data.
 * Запізнілі операції (Сейф доїжджає до ~10 днів, картка white до ~35) підхоплюються наступним прогоном — тому відбір
 * «ще не записане», а не «за вчора».
 */
export const EXPORT_SELECT_SQL = `
  SELECT t.id, t.account_id, to_char((t.booked_at AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS day,
         t.amount::text AS amount, t.currency AS currency, t.counterparty_name AS counterparty_name, t.purpose AS purpose
    FROM bank_transactions t
   WHERE t.deleted_at IS NULL
     AND t.booked_at IS NOT NULL
     AND (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date >= $1::date
     AND (t.booked_at AT TIME ZONE 'Europe/Kyiv')::date < (now() AT TIME ZONE 'Europe/Kyiv')::date
     AND NOT EXISTS (SELECT 1 FROM data_sheet_exports x WHERE x.tx_id = t.id)
   ORDER BY t.booked_at, t.id`;

export interface ExportTx {
  id: number;
  account_id: number;
  /** День операції за Києвом, `YYYY-MM-DD`. */
  day: string;
  amount: string | number;
  currency: string;
  counterparty_name: string | null;
  purpose: string | null;
}

export interface DataRow {
  txId: number;
  /** D «Період»: серійний номер дати 1-го числа місяця. */
  d: number;
  /** E «Дата платежу»: серійний номер дати. */
  e: number;
  g: number;
  h: string;
  m: string;
  n: string;
  o: string;
  q: string;
}

/** День `YYYY-MM-DD` → серійний номер дати Google Sheets (днів від 30.12.1899). */
export function sheetSerial(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Data: дата «${day}» не у форматі YYYY-MM-DD`);
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** Операція → рядок Data; `null` — рахунок не описаний у `DATA_SHEET_ACCOUNTS`. */
export function toDataRow(tx: ExportTx): DataRow | null {
  const rule = DATA_SHEET_ACCOUNTS[tx.account_id];
  if (!rule) return null;
  const g = Number(tx.amount);
  if (!Number.isFinite(g)) throw new Error(`Data: сума операції ${tx.id} не число («${tx.amount}»)`);
  const purpose = String(tx.purpose ?? "");
  const [m, n, o, q] = "safe" in rule
    ? [`Сейф ${tx.currency}`, "Сейф", "", purpose.replace(SAFE_DEAL_SUFFIX, "")]
    : [rule.m, rule.n, String(tx.counterparty_name ?? ""), purpose];
  return { txId: tx.id, d: sheetSerial(`${tx.day.slice(0, 7)}-01`), e: sheetSerial(tx.day), g, h: tx.currency, m, n, o, q };
}

export interface Split {
  rows: DataRow[];
  /** Невідомі рахунки — помилка прогону (не мовчимо). */
  unmapped: { accountId: number; count: number }[];
  /** Свідомо виключені — лише лічильник у підсумку. */
  excluded: { accountId: number; count: number }[];
}

export function splitForExport(txs: ExportTx[]): Split {
  const rows: DataRow[] = [];
  const un = new Map<number, number>(), ex = new Map<number, number>();
  for (const tx of txs) {
    if (DATA_SHEET_EXCLUDED[tx.account_id]) { ex.set(tx.account_id, (ex.get(tx.account_id) ?? 0) + 1); continue; }
    const row = toDataRow(tx);
    if (row) rows.push(row); else un.set(tx.account_id, (un.get(tx.account_id) ?? 0) + 1);
  }
  const list = (m: Map<number, number>) => [...m].map(([accountId, count]) => ({ accountId, count })).sort((a, b) => a.accountId - b.accountId);
  return { rows, unmapped: list(un), excluded: list(ex) };
}

/** Колонки Data (0-based): B=1 … Y=24. */
export const COL = { B: 1, C: 2, D: 3, H: 7, I: 8, L: 11, M: 12, Q: 16, S: 18 } as const;

/** Колонки, де в кожному рядку Data стоять формули — копіюються з рядка над вставкою. */
export const FORMULA_SPANS: readonly { from: number; to: number }[] = [
  { from: COL.B, to: COL.C }, { from: COL.I, to: COL.L }, { from: COL.S, to: COL.S },
];

type CellValue = { userEnteredValue?: { numberValue?: number; stringValue?: string } };
const num = (v: number): CellValue => ({ userEnteredValue: { numberValue: v } });
const str = (v: string): CellValue => (v === "" ? {} : { userEnteredValue: { stringValue: v } });

/**
 * Один атомарний `batchUpdate`: вставити `rows.length` рядків ПІСЛЯ останнього заповненого (`lastRow`, 1-based),
 * з форматом рядка вище; записати D–H і M–Q; скопіювати формули B–C, I–L, S з рядка `lastRow`.
 * Google виконує batchUpdate цілком або ніяк — половини вставки не буває.
 */
export function buildInsertRequests(sheetId: number, lastRow: number, rows: DataRow[]): object[] {
  if (!rows.length) return [];
  const start = lastRow, end = lastRow + rows.length; // 0-based: нові рядки = [lastRow, lastRow+n)
  const grid = (r0: number, r1: number, c0: number, c1: number) =>
    ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
  return [
    { insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: start, endIndex: end }, inheritFromBefore: true } },
    { updateCells: { start: { sheetId, rowIndex: start, columnIndex: COL.D }, fields: "userEnteredValue",
      rows: rows.map((r) => ({ values: [num(r.d), num(r.e), {}, num(r.g), str(r.h)] })) } },
    { updateCells: { start: { sheetId, rowIndex: start, columnIndex: COL.M }, fields: "userEnteredValue",
      rows: rows.map((r) => ({ values: [str(r.m), str(r.n), str(r.o), {}, str(r.q)] })) } },
    ...FORMULA_SPANS.map((s) => ({ copyPaste: {
      source: grid(start - 1, start, s.from, s.to + 1), destination: grid(start, end, s.from, s.to + 1), pasteType: "PASTE_FORMULA" } })),
  ];
}

/**
 * 🛡 Запит лише ДОДАЄ: дозволені тільки вставка рядків і запис/копіювання В НОВІ рядки. Видалення, очищення, запис
 * у наявні рядки — помилка ДО відправки. Перевіряється в рантаймі, а не лише тестом: сервісний акаунт має право
 * редагувати весь файл фінансів, і помилка в індексі не повинна мати змоги переписати чуже.
 */
export function assertAppendOnly(requests: object[], lastRow: number, count: number): void {
  const end = lastRow + count;
  for (const r of requests as Record<string, any>[]) {
    const [kind] = Object.keys(r);
    const body = r[kind];
    if (kind === "insertDimension") {
      if (body.range.dimension !== "ROWS" || body.range.startIndex !== lastRow || body.range.endIndex !== end || body.inheritFromBefore !== true)
        throw new Error("Data: вставка рядків не там, де закінчуються дані");
    } else if (kind === "updateCells") {
      const row = body.start?.rowIndex;
      if (typeof row !== "number" || row < lastRow || row + (body.rows?.length ?? 0) > end) throw new Error("Data: запис поза новими рядками");
    } else if (kind === "copyPaste") {
      const d = body.destination;
      if (body.pasteType !== "PASTE_FORMULA" || d.startRowIndex !== lastRow || d.endRowIndex !== end || body.source.endRowIndex !== lastRow)
        throw new Error("Data: копіювання формул поза новими рядками");
    } else {
      throw new Error(`Data: заборонений вид запиту «${kind}» — джоба лише додає рядки`);
    }
  }
}
