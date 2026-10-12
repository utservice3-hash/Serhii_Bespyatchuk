/**
 * 📗 ЧИТАННЯ GOOGLE-ТАБЛИЦІ СЕРВІСНИМ АКАУНТОМ (Сейф, 12.10.2026). Той самий ключ, що для GA4
 * (`GA4_SERVICE_ACCOUNT_JSON` — шлях до файлу на сервері, у репо ключа немає): `uts-dashboard@dashboard-uts-507913…`.
 * Таблиця НЕ публікується — їй дано доступ «Читач» саме цьому акаунту, а в проєкті ввімкнено Google Sheets API
 * (обидва кроки перевірено живим запитом 12.10.2026). Лише читання: scope `spreadsheets.readonly`, писати в таблицю
 * цей код не вміє за побудовою.
 */
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
let cached: { token: string; until: number } | null = null;

export const sheetsConfigured = (): boolean => Boolean(config.ga4.serviceAccountJsonPath && config.safeSheet.spreadsheetId);

async function token(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  let sa: { client_email?: string; private_key?: string };
  try { sa = JSON.parse(readFileSync(config.ga4.serviceAccountJsonPath, "utf8")); }
  catch { throw new Error(`Google: файл ключа сервісного акаунта не читається (${config.ga4.serviceAccountJsonPath})`); }
  if (!sa.client_email || !sa.private_key) throw new Error("Google: у файлі ключа немає client_email або private_key");
  const assertion = jwt.sign({ scope: SCOPE }, sa.private_key, { algorithm: "RS256", issuer: sa.client_email, audience: TOKEN_URL, expiresIn: "1h" });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }), signal: AbortSignal.timeout(20000) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new Error(`Google: токен не видано (${res.status})`);
  cached = { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
  return body.access_token;
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
