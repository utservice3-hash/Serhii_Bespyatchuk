/**
 * ✍️ ЗАПИС У GOOGLE-ТАБЛИЦЮ — файл на оплату перевізникам (13.10.2026) і вкладка «Data» фінансів (18.11.2026,
 * `insertDataRows`). Окремий модуль навмисно: `googleSheets.ts` читає Сейф і писати не вміє за побудовою (#1249), тож
 * писар не може опинитись у шляху Сейфу випадково (#1268).
 * Писати сервісний акаунт може лише в таблиці, якими з ним поділились як із редактором.
 */
import { googleToken } from "./googleSheets.js";
import { buildInsertRequests, assertAppendOnly, FORMULA_COLS, type DataRow } from "../core/dataSheetRows.js";

const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** Відмову Google — словами (спільне для читання й запису). */
async function sheetsError(res: Response): Promise<Error> {
  const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  const why = res.status === 403 ? "немає доступу (чи поділились таблицею з сервісним акаунтом як із редактором?)"
    : res.status === 404 ? "таблицю не знайдено" : res.status === 400 ? "запит відхилено (вкладка чи діапазон?)" : `помилка ${res.status}`;
  return new Error(`Google Sheets: ${why}${e.error?.message ? ` — ${e.error.message.slice(0, 160)}` : ""}`);
}

/**
 * ✍️ Перезаписати вкладку цілком: немає вкладки — створити; стерти старе; записати `values` з A1 (RAW — без
 * автоперетворень: номер картки лишається текстом, а не числом у науковому форматі).
 */
export async function writeSheetTab(spreadsheetId: string, tab: string, values: (string | number)[][]): Promise<void> {
  const auth = { Authorization: `Bearer ${await googleToken(WRITE_SCOPE)}`, "Content-Type": "application/json" };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const meta = await fetch(`${base}?fields=sheets.properties.title`, { headers: auth, signal: AbortSignal.timeout(30000) });
  if (!meta.ok) throw await sheetsError(meta);
  const titles = (((await meta.json()) as { sheets?: { properties?: { title?: string } }[] }).sheets ?? []).map((s) => s.properties?.title);
  if (!titles.includes(tab)) {
    const add = await fetch(`${base}:batchUpdate`, { method: "POST", headers: auth, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
    if (!add.ok) throw await sheetsError(add);
  }
  const range = encodeURIComponent(`${tab}!A:Z`);
  const clr = await fetch(`${base}/values/${range}:clear`, { method: "POST", headers: auth, body: "{}", signal: AbortSignal.timeout(30000) });
  if (!clr.ok) throw await sheetsError(clr);
  if (!values.length) return;
  const put = await fetch(`${base}/values/${encodeURIComponent(`${tab}!A1`)}?valueInputOption=RAW`, { method: "PUT", headers: auth,
    signal: AbortSignal.timeout(30000), body: JSON.stringify({ range: `${tab}!A1`, majorDimension: "ROWS", values }) });
  if (!put.ok) throw await sheetsError(put);
}


/**
 * Відмова запису в Data з відповіддю на головне питання обліку: чи МОГЛИ рядки лягти в таблицю.
 * `no` — точно ні (відмова до запиту або Google відповів помилкою; batchUpdate атомарний). `unknown` — запит пішов і
 * обірвався без відповіді: рядки могли лягти, тож повторювати їх наосліп не можна (дубль у фінансах).
 */
export class DataSheetWriteError extends Error {
  constructor(message: string, readonly applied: "no" | "unknown") { super(message); }
}

/** Номер колонки (0-based) → літера. */
const colLetter = (i: number): string => String.fromCharCode(65 + i);

/**
 * 📤 Дописати рядки у вкладку `tab` (Data): ВСТАВКОЮ після останнього рядка з датою в E — так межі формул CF,
 * обмежені номером рядка, розсуваються самі. Формули B–C, I–L, S беруться з того самого останнього рядка (зі зсувом
 * номера рядка, без copyPaste — той не працює під фільтром фінансиста); якщо там
 * формул немає — відмова ДО запису (рядки без формул тихо випали б із CF). Один атомарний batchUpdate.
 */
export async function insertDataRows(spreadsheetId: string, tab: string, rows: DataRow[]): Promise<{ lastRow: number; inserted: number }> {
  if (!rows.length) return { lastRow: 0, inserted: 0 };
  let auth: Record<string, string>;
  try { auth = { Authorization: `Bearer ${await googleToken(WRITE_SCOPE)}`, "Content-Type": "application/json" }; }
  catch (e) { throw new DataSheetWriteError((e as Error).message, "no"); }
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const get = async (url: string) => {
    const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(60000) }).catch((e) => { throw new DataSheetWriteError(`Google Sheets: ${(e as Error).message}`, "no"); });
    if (!res.ok) throw new DataSheetWriteError((await sheetsError(res)).message, "no");
    return res.json() as Promise<any>;
  };
  const meta = await get(`${base}?fields=sheets.properties(sheetId,title)`);
  const sheet = (meta.sheets ?? []).find((s: any) => s.properties?.title === tab);
  if (!sheet) throw new DataSheetWriteError(`Google Sheets: вкладки «${tab}» немає`, "no");
  const sheetId = Number(sheet.properties.sheetId);
  const colE = await get(`${base}/values/${encodeURIComponent(`${tab}!E1:E`)}?majorDimension=COLUMNS`);
  const e: unknown[] = colE.values?.[0] ?? [];
  let lastRow = e.length;
  while (lastRow > 0 && String(e[lastRow - 1] ?? "").trim() === "") lastRow--;
  if (lastRow < 3) throw new DataSheetWriteError(`Google Sheets: у «${tab}» немає рядків із датою — не знаю, куди вставляти`, "no");
  // Шаблон читаємо ТИМ САМИМ каналом, яким пишемо (`userEnteredValue.formulaValue` у batchUpdate), — тоді вигляд формули
  // (роздільники, десяткова кома локалі) на читанні й на записі збігається за побудовою, а не за припущенням.
  const tpl = await get(`${base}?ranges=${encodeURIComponent(`${tab}!A${lastRow}:S${lastRow}`)}&fields=sheets.data.rowData.values.userEnteredValue`);
  const cells: { userEnteredValue?: { formulaValue?: string } }[] = tpl.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values ?? [];
  const template: Record<number, string> = {};
  for (const c of FORMULA_COLS) { const f = cells[c]?.userEnteredValue?.formulaValue; if (f) template[c] = f; }
  const missing = FORMULA_COLS.filter((c) => !template[c]);
  if (missing.length) throw new DataSheetWriteError(`Google Sheets: у рядку ${lastRow} «${tab}» немає формул у ${missing.map(colLetter).join(", ")} — `
    + "нові рядки не мали б звідки їх узяти; вставку не роблю", "no");
  let requests: object[];
  try { requests = buildInsertRequests(sheetId, lastRow, rows, template); assertAppendOnly(requests, lastRow, rows.length); }
  catch (err) { throw new DataSheetWriteError((err as Error).message, "no"); }
  let res: Response;
  try {
    res = await fetch(`${base}:batchUpdate`, { method: "POST", headers: auth, signal: AbortSignal.timeout(120000), body: JSON.stringify({ requests }) });
  } catch (err) { throw new DataSheetWriteError(`Google Sheets: запит обірвався без відповіді — ${(err as Error).message}`, "unknown"); }
  if (!res.ok) throw new DataSheetWriteError((await sheetsError(res)).message, "no");
  return { lastRow, inserted: rows.length };
}
