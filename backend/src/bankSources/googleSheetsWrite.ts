/**
 * ✍️ ЗАПИС У GOOGLE-ТАБЛИЦЮ — ЛИШЕ ДЛЯ ФАЙЛУ НА ОПЛАТУ ПЕРЕВІЗНИКАМ (13.10.2026). Окремий модуль навмисно: `googleSheets.ts`
 * читає Сейф і писати не вміє за побудовою (#1249), тож писар не може опинитись у шляху Сейфу випадково (#1268).
 * Писати сервісний акаунт може лише в таблиці, якими з ним поділились як із редактором.
 */
import { googleToken } from "./googleSheets.js";

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

