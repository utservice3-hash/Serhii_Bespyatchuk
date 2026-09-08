/**
 * 📊 GA4 — ЧИСТА ЧАСТИНА: форма рядка, розбір відповіді, вікно синку.
 *
 * 🔴 ЧОМУ ОКРЕМИЙ ФАЙЛ ВІД `client.ts`. Клієнт імпортує `config`, а той кидає на
 * відсутньому `DATABASE_URL` ЩЕ НА ІМПОРТІ — тобто раніше, ніж спрацює будь-який skip.
 * Тест, що імпортує клієнта, впав би ЦІЛИМ ФАЙЛОМ без бази, і гейти розбору не
 * виконувались би НІДЕ, де немає `.env`. Це не гіпотеза: рівно так падає сусідній
 * `core/leadgenStats.test.ts`, і рівно так мало не сталося тут.
 *
 * Правило, яке з цього лишається: чисте — окремо від того, що тягне конфіг, інакше
 * гейт стає наміром (див. `.claude/rules/testing.md`, «скіп, який ніколи не виконувався»).
 */

/** Один рядок звіту: день × кампанія. `cost`/`clicks` — з Google Ads через GA4. */
export interface Ga4AdsRow {
  day: string;          // YYYY-MM-DD (GA4 віддає YYYYMMDD)
  campaign: string;
  channelGroup: string;
  sessions: number;
  conversions: number;
  cost: number;
  clicks: number;
}

/** Розмірності й метрики запиту — назви GA4, вони ж ключі в заголовках відповіді. */
export const GA4_DIMENSIONS = ["date", "sessionCampaignName", "sessionDefaultChannelGroup"] as const;
export const GA4_METRICS = ["sessions", "conversions", "advertiserAdCost", "advertiserAdClicks"] as const;

/** `20260825` → `2026-08-25`. GA4 віддає день без роздільників. */
function ga4Date(v: string): string {
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 🔴 РОЗБІР ЗА ІМЕНАМИ ЗАГОЛОВКІВ, А НЕ ЗА ПОЗИЦІЄЮ. GA4 повертає
 * `dimensionHeaders`/`metricHeaders` окремо від значень, і порядок метрик у відповіді
 * не гарантований контрактом. Розбір «третє значення = cost» мовчки поїхав би, щойно
 * Google переставить метрики місцями або ми додамо ще одну — і на екрані зʼявились би
 * кліки під підписом «витрати». Тому позиція шукається за іменем щоразу.
 *
 * Чиста функція: гейт перевіряє її на фікстурі, без мережі й без ключів.
 */
export function parseGa4Report(json: unknown): Ga4AdsRow[] {
  const r = json as {
    dimensionHeaders?: { name?: string }[];
    metricHeaders?: { name?: string }[];
    rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  };
  const dimAt = (name: string) => (r.dimensionHeaders ?? []).findIndex((h) => h?.name === name);
  const metAt = (name: string) => (r.metricHeaders ?? []).findIndex((h) => h?.name === name);

  const iDay = dimAt("date");
  const iCampaign = dimAt("sessionCampaignName");
  const iChannel = dimAt("sessionDefaultChannelGroup");
  const iSessions = metAt("sessions");
  const iConversions = metAt("conversions");
  const iCost = metAt("advertiserAdCost");
  const iClicks = metAt("advertiserAdClicks");

  return (r.rows ?? []).map((row) => {
    const d = row.dimensionValues ?? [];
    const m = row.metricValues ?? [];
    return {
      day: ga4Date(d[iDay]?.value ?? ""),
      campaign: d[iCampaign]?.value ?? "",
      channelGroup: d[iChannel]?.value ?? "",
      sessions: num(m[iSessions]?.value),
      conversions: num(m[iConversions]?.value),
      cost: num(m[iCost]?.value),
      clicks: num(m[iClicks]?.value),
    };
  });
}

/** Σ витрат по рядках — одне місце, щоб екран і гейт рахували однаково. */
export const totalCost = (rows: Ga4AdsRow[]): number =>
  Math.round(rows.reduce((s, x) => s + x.cost, 0) * 100) / 100;

/** GA4 доуточнює дані до ~72 год — вікно синку бере з запасом. */
export const LOOKBACK_DAYS = 4;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Вікно синку: [сьогодні − lookback, сьогодні]. Чиста функція — гейт перевіряє межі
 * без мережі й без годинника процесу.
 */
export function syncWindow(today: Date, lookbackDays = LOOKBACK_DAYS): { from: string; to: string } {
  return { from: iso(new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000)), to: iso(today) };
}

/** Текст, який `health/jobErrorKind.ts` класифікує як вид `config`. */
export const GA4_NOT_CONFIGURED =
  "GA4 не налаштовано: порожній GA4_PROPERTY_ID або GA4_SERVICE_ACCOUNT_JSON";
