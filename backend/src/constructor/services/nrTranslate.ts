/**
 * 🌍 Автопереклад української частини заявки нерезиденту в англійську (задача 5940; Роман 21.10.2026: Google, через IPv4).
 *
 * Кнопка «Перекласти англійською» заповнює ЛИШЕ ПОРОЖНІ англійські поля, вписане руками не чіпаємо. Два способи:
 *  - імена, адреси, міста, сторони — транслітерація КМУ №55 (`translit.ts`), без мережі: «Київ» завжди «Kyiv»;
 *  - вантаж, дати з поясненнями, вимоги, авто, додаткові умови — Google Cloud Translation API v2.
 * Ключ — `GOOGLE_TRANSLATE_API_KEY` у `.env` (обмежений IP сервера). Запит іде ЛИШЕ через IPv4: сервер має ще й IPv6, а
 * обмеження ключа — на IPv4 (заміряно 21.10: через IPv6 Google відповів 403 API_KEY_IP_ADDRESS_BLOCKED).
 * Без ключа чи при збої Google — транслітерація однаково заповнює своє, решта лишається порожньою з поясненням.
 */
import https from 'node:https';
import type { DocumentState } from './docgen.js';
import { nrUaValue, NR_EN_KEYS } from './nonresident.js';
import { translit, translitParty, hasCyrillic } from './translit.js';

/** Поля, які транслітеруємо (люди, компанії, адреси, міста). */
export const TRANSLIT_KEYS = new Set(['routeEn', 'loadAddrEn', 'custAddrEn', 'borderEn', 'decustAddrEn', 'unloadAddrEn', 'driverEn', 'mgrEn', 'otherRespEn']);
/** Сторони — орг. форма англійською, решта транслітерацією. */
export const PARTY_KEYS = new Set(['shipperEn', 'consigneeEn']);
/** Решта — переклад Google. */
export const GOOGLE_KEYS = new Set(NR_EN_KEYS.filter((k) => !TRANSLIT_KEYS.has(k) && !PARTY_KEYS.has(k)));

export type Translator = (texts: string[]) => Promise<string[]>;
export interface TranslateResult {
  fields: Record<string, string>;
  how: Record<string, 'translit' | 'google'>;
  /** Пояснення, якщо щось не заповнилось (немає ключа, Google не відповів). */
  note: string | null;
}

/** Що й як перекладати: лише порожні англійські поля, у чиїх українських значеннях є кирилиця. */
export async function translateNr(s: DocumentState, google: Translator | null): Promise<TranslateResult> {
  const fields: Record<string, string> = {}, how: TranslateResult['how'] = {};
  const toGoogle: Array<[string, string]> = [];
  for (const k of NR_EN_KEYS) {
    if ((s.trip[k] || '').trim()) continue;                  // вписане руками — не чіпаємо
    const ua = nrUaValue(s, k).trim();
    if (!ua || !hasCyrillic(ua)) continue;                   // латиниця, цифри, дати — підуть як є
    if (TRANSLIT_KEYS.has(k)) { fields[k] = translit(ua); how[k] = 'translit'; }
    else if (PARTY_KEYS.has(k)) { fields[k] = translitParty(ua); how[k] = 'translit'; }
    else toGoogle.push([k, ua]);
  }
  let note: string | null = null;
  if (toGoogle.length) {
    if (!google) note = 'Переклад Google не налаштовано — вантаж, вимоги й умови впишіть англійською самі.';
    else {
      try {
        const out = await google(toGoogle.map(([, ua]) => ua));
        toGoogle.forEach(([k], i) => { if (out[i]?.trim()) { fields[k] = out[i].trim(); how[k] = 'google'; } });
      } catch (e) {
        note = `Google зараз не відповів (${(e as Error).message}) — вантаж, вимоги й умови не перекладено, спробуйте ще раз.`;
      }
    }
  }
  return { fields, how, note };
}

/** HTML-сутності у відповіді Google (format=text їх не дає, але апостроф буває `&#39;`). */
const unescape = (t: string) => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** POST до Google Translate v2 — ЛИШЕ IPv4 (`family: 4`). Ключ — у параметрі запиту; у повідомлення помилок не потрапляє. */
export function googleTranslator(key: string, timeoutMs = 15_000): Translator {
  return (texts) => new Promise<string[]>((resolve, reject) => {
    const body = JSON.stringify({ q: texts, source: 'uk', target: 'en', format: 'text' });
    const req = https.request({
      host: 'translation.googleapis.com', path: `/language/translate/v2?key=${encodeURIComponent(key)}`, method: 'POST', family: 4,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw) as { data?: { translations?: Array<{ translatedText: string }> }; error?: { status?: string; message?: string } };
          if (res.statusCode !== 200 || !j.data?.translations) return reject(new Error(`Google ${res.statusCode}${j.error?.status ? ' ' + j.error.status : ''}`));
          resolve(j.data.translations.map((t) => unescape(t.translatedText)));
        } catch { reject(new Error(`Google ${res.statusCode}: незрозуміла відповідь`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('немає відповіді 15 с')));
    req.on('error', (e) => reject(new Error(e.message.replaceAll(key, '***'))));
    req.end(body);
  });
}
