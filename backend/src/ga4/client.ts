import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { parseGa4Report, GA4_DIMENSIONS, GA4_METRICS, GA4_NOT_CONFIGURED, type Ga4AdsRow } from "./report.js";

/**
 * 📊 GA4 DATA API — витрати й кліки Google Ads по днях і кампаніях.
 *
 * 🔴 ЧОМУ GA4, А НЕ GOOGLE ADS API. Звʼязка Ads→GA4 уже працює й віддає `advertiserAdCost`
 * і `advertiserAdClicks` — доведено живим запитом 08.09.2026. Отже другий API, другий
 * доступ і другий набір ключів не потрібні: менше поверхні, менше того, що може протухнути.
 *
 * 🔴 ПІДПИС — `jsonwebtoken`, ЯКИЙ УЖЕ Є В ЗАЛЕЖНОСТЯХ (рішення власника 08.09.2026).
 * ТЗ пропонувало підписати RS256 вручну через `node:crypto`, «як у тесті». Такого тесту
 * не існує: заміряно `grep` по `createSign|crypto.sign|createPrivateKey|RS256` — нуль
 * збігів, а наявний JWT у проєкті це HS256 через цю саму бібліотеку. Тобто «без
 * бібліотек» довелося б писати з нуля рівно те, що бібліотека вже вміє.
 *
 * ⚠️ ЧОГО ТУТ НЕМАЄ ПРЕЦЕДЕНТУ: сервісно-акаунтний OAuth Google (assertion → token).
 * `fetch` із bearer до чужого API у нас скрізь (Kommo, mono, Ringostat), а саме цей
 * обмін — уперше. Тому він і винесений в окрему функцію з власним видом помилки.
 *
 * 🔴 СЕКРЕТ — ФАЙЛ НА ДИСКУ, НЕ ЗМІННА З КЛЮЧЕМ. `GA4_SERVICE_ACCOUNT_JSON` тримає
 * ШЛЯХ; приватний ключ у репозиторій не потрапляє й у лог не друкується.
 */

/**
 * Чи налаштовано GA4. Порожньо — це ШТАТНИЙ стан (як трекер і Ringostat), тож джоба
 * не падає, а чесно каже, що спить; вид помилки — `config`, не `data` і не `unknown`.
 */
export const ga4Configured = (): boolean =>
  Boolean(config.ga4.propertyId && config.ga4.serviceAccountJsonPath);

interface ServiceAccount { client_email: string; private_key: string }

function readServiceAccount(): ServiceAccount {
  const path = config.ga4.serviceAccountJsonPath;
  if (!path) throw new Error(GA4_NOT_CONFIGURED);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // ⚠️ Шлях у повідомленні є, вміст — ні: причина має бути названа, ключ — ні.
    throw new Error(`GA4 не налаштовано: файл ключа не читається (${path})`);
  }
  const sa = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GA4 не налаштовано: у файлі ключа немає client_email або private_key");
  }
  return { client_email: sa.client_email, private_key: sa.private_key };
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** Assertion сервісного акаунта → короткоживучий access_token. */
async function accessToken(): Promise<string> {
  const sa = readServiceAccount();
  const assertion = jwt.sign(
    { scope: SCOPE },
    sa.private_key,
    { algorithm: "RS256", issuer: sa.client_email, audience: TOKEN_URL, expiresIn: "1h" }
  );
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    // Тіло відповіді Google на помилку містить код і опис, але не наш ключ.
    throw new Error(`GA4 oauth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("GA4 oauth: у відповіді немає access_token");
  return j.access_token;
}

/**
 * Звіт день × кампанія за [from,to] включно. Дати — рядки `YYYY-MM-DD` (київські:
 * властивість GA4 налаштована на київський часовий пояс, тож зсуву тут не робимо).
 */
export async function fetchGa4Ads(from: string, to: string): Promise<Ga4AdsRow[]> {
  if (!ga4Configured()) throw new Error(GA4_NOT_CONFIGURED);
  const token = await accessToken();
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${config.ga4.propertyId}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: from, endDate: to }],
        dimensions: GA4_DIMENSIONS.map((name) => ({ name })),
        metrics: GA4_METRICS.map((name) => ({ name })),
        limit: 100_000,
      }),
    }
  );
  if (!res.ok) throw new Error(`GA4 runReport ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseGa4Report(await res.json());
}
