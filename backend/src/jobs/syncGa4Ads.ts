import { pool } from "../db/pool.js";
import { fetchGa4Ads, ga4Configured } from "../ga4/client.js";
import { syncWindow, GA4_NOT_CONFIGURED, type Ga4AdsRow } from "../ga4/report.js";

/**
 * 📊 РЕКЛАМА З GA4 — день × кампанія у `ad_ga4_daily` (08.09.2026).
 *
 * 🔴 ВІКНО ЗАХОПЛЮЄ МИНУЛЕ, І ЦЕ НЕ ПЕРЕСТРАХОВКА. GA4 доуточнює дані до ~72 годин
 * після події, тож «за вчора» знімає ще неостаточні числа. Тому щодоби перезнімаємо
 * останні `LOOKBACK_DAYS` днів і переписуємо їх (`ON CONFLICT DO UPDATE`) — рядок за
 * день завжди відображає найсвіжіше, що GA4 про нього знає.
 *
 * 🔴 «НЕ НАЛАШТОВАНО» — ШТАТНИЙ ВИХІД, А НЕ АВАРІЯ. Як трекер і Ringostat: порожній
 * ключ означає, що інтеграцію ще не ввімкнули. Джоба кидає з текстом, який
 * `classifyJobError` розпізнає як вид `config` — тривога тоді каже «дивитись .env»,
 * а не «дивитись значення полів» (це і був сенс окремого виду).
 *
 * ⚠️ ОБСЯГ ЗАВЖДИ НАЗИВАЄТЬСЯ ЧИСЛОМ. Правило зони джоб, куплене `syncCalls`: джоба,
 * яка «відпрацювала» й привезла нуль, виглядає так само зелено, як робоча. Тому в лог
 * іде «привезла N рядків за M днів», а не «готово».
 */

/**
 * Запис рядків у `ad_ga4_daily`. Винесено, щоб бекфіл і щоденний прогін писали ОДНАКОВО.
 *
 * 🔴 КЛЮЧ КОНФЛІКТУ — ТРИ КОЛОНКИ, І ЦЕ НЕ КОСМЕТИКА. GA4 віддає рядок на
 * (`date`, `sessionCampaignName`, `sessionDefaultChannelGroup`), тож одна кампанія
 * за один день приходить КІЛЬКОМА рядками, якщо живе в кількох каналах (Performance
 * Max — одночасно `Cross-network` і `Paid Search`). Поки `ON CONFLICT` був на
 * (day, campaign), другий рядок ЗАТИРАВ перший: витрати зникали, і — гірше — сума
 * ставала недетермінованою, бо перемагав той рядок, який GA4 віддав останнім.
 * 📐 Заміряно на бойових даних між двома бекфілами: 25.08 9 563 → 8 504,
 * 01.09 8 369 → 6 985. Той самий день, той самий код, різні числа.
 *
 * ⚠️ `channelGroup` нормалізується до `""`, а не лишається NULL: у складеному ключі
 * NULL ніколи не дорівнює NULL, тож рядки без каналу не ловились би `ON CONFLICT`
 * і плодили б дублікати — те саме затирання, тільки навпаки.
 */
export async function upsertGa4Rows(rows: Ga4AdsRow[]): Promise<number> {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO ad_ga4_daily (day, campaign, channel_group, sessions, conversions, cost, clicks, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (day, campaign, channel_group) DO UPDATE SET
         sessions = EXCLUDED.sessions,
         conversions = EXCLUDED.conversions,
         cost = EXCLUDED.cost,
         clicks = EXCLUDED.clicks,
         synced_at = now()`,
      [r.day, r.campaign, r.channelGroup ?? "", r.sessions, r.conversions, r.cost, r.clicks]
    );
  }
  return rows.length;
}

export async function syncGa4Ads(now = new Date()): Promise<void> {
  if (!ga4Configured()) throw new Error(GA4_NOT_CONFIGURED);
  const { from, to } = syncWindow(now);
  const rows = await fetchGa4Ads(from, to);
  if (rows.length === 0) {
    // Порожньо — це ПРОВАЛ, доки не доведено, що не було чого привозити. Не мовчимо.
    console.warn(`syncGa4Ads: GA4 віддав 0 рядків за ${from}..${to} — перевірити властивість і звʼязку Ads→GA4.`);
    return;
  }
  const n = await upsertGa4Rows(rows);
  const days = new Set(rows.map((r) => r.day)).size;
  const spend = Math.round(rows.reduce((s, r) => s + r.cost, 0));
  console.log(`GA4 ads synced: ${n} рядків за ${days} днів (${from}..${to}), витрати ${spend} ₴.`);
}

/**
 * Разовий бекфіл за N днів назад. Кличеться руками, не з крону:
 *   node dist/jobs/syncGa4Ads.js --backfill-days=90
 * ⚠️ GA4 тримає історію за налаштуванням retention властивості. Якщо воно коротше за
 * запитаний період, GA4 віддасть менше днів — і це буде видно числом у лозі, а не тишею.
 */
export async function backfillGa4Ads(days: number, now = new Date()): Promise<void> {
  const { from, to } = syncWindow(now, days);
  const rows = await fetchGa4Ads(from, to);
  const n = await upsertGa4Rows(rows);
  const got = new Set(rows.map((r) => r.day)).size;
  console.log(`GA4 backfill: ${n} рядків за ${got} днів із запитаних ${days + 1} (${from}..${to}).`);
  if (got < days) {
    console.warn(`⚠️ GA4 віддав ${got} днів замість ${days + 1} — імовірно retention властивості коротший за період.`);
  }
}

if (process.argv[1]?.endsWith("syncGa4Ads.js")) {
  const arg = process.argv.find((a) => a.startsWith("--backfill-days="));
  const run = arg ? backfillGa4Ads(Number(arg.slice(16))) : syncGa4Ads();
  run
    .then(async () => pool.end())
    .catch((e) => { console.error(String(e)); process.exit(1); });
}
