/**
 * 📗 ЧИТАННЯ GOOGLE-ТАБЛИЦІ СЕРВІСНИМ АКАУНТОМ (Сейф, 12.10.2026). Той самий ключ, що для GA4
 * (`GA4_SERVICE_ACCOUNT_JSON` — шлях до файлу на сервері, у репо ключа немає): `uts-dashboard@dashboard-uts-507913…`.
 * Таблиця НЕ публікується — їй дано доступ «Читач» саме цьому акаунту, а в проєкті ввімкнено Google Sheets API
 * (обидва кроки перевірено живим запитом 12.10.2026). Читання — scope `spreadsheets.readonly`.
 * ✍️ ЗАПИС (13.10.2026) — ЛИШЕ для файлу на оплату перевізникам (`writeSheetTab`), окремим токеном зі scope
 * `spreadsheets`: Сейф і далі читається readonly-токеном. Писати акаунт може лише в таблиці, якими з ним поділились
 * як із редактором.
 */
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const cached = new Map<string, { token: string; until: number }>();

export const sheetsConfigured = (): boolean => Boolean(config.ga4.serviceAccountJsonPath && config.safeSheet.spreadsheetId);

async function token(scope = SCOPE): Promise<string> {
  const hit = cached.get(scope);
  if (hit && hit.until > Date.now()) return hit.token;
  let sa: { client_email?: string; private_key?: string };
  try { sa = JSON.parse(readFileSync(config.ga4.serviceAccountJsonPath, "utf8")); }
  catch { throw new Error(`Google: файл ключа сервісного акаунта не читається (${config.ga4.serviceAccountJsonPath})`); }
  if (!sa.client_email || !sa.private_key) throw new Error("Google: у файлі ключа немає client_email або private_key");
  const assertion = jwt.sign({ scope }, sa.private_key, { algorithm: "RS256", issuer: sa.client_email, audience: TOKEN_URL, expiresIn: "1h" });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }), signal: AbortSignal.timeout(20000) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new Error(`Google: токен не видано (${res.status})`);
  cached.set(scope, { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 });
  return body.access_token;
}

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
  const auth = { Authorization: `Bearer ${await token(WRITE_SCOPE)}`, "Content-Type": "application/json" };
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

/** Значення діапазону як рядки (так, як їх бачить людина в таблиці). Відмову Google називає словами. */
export async function readSheetRange(spreadsheetId: string, range: string): Promise<string[][]> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const why = res.status === 403 ? "немає доступу (чи поділились таблицею з сервісним акаунтом?)"
      : res.status === 404 ? "таблицю не знайдено" : res.status === 400 ? "вкладку не знайдено (перейменували?)" : `помилка ${res.status}`;
    throw new Error(`Google Sheets: ${why}${e.error?.message ? ` — ${e.error.message.slice(0, 160)}` : ""}`);
  }
  const body = (await res.json()) as { values?: string[][] };
  return body.values ?? [];
}
