import type { FeedbackRow, Rating } from "./rateFeedback.js";

/**
 * 📐 «ПОРАХУВАЛИ → ВИЙШЛО» (Роман 30.10.2026: «статистика нічого не дає — немає ціни, яка була в момент розрахунку;
 * зберігай, що порахувала система, і що вийшло насправді, і зроби екран інформативним — щоб розуміти, де покращуватись»).
 *
 * Що порахувала система — знімок `lardi_usage.calc` у мить розрахунку (показана ставка клієнту/перевізнику, тариф, ринок,
 * джерело, км, авто, зона). Що вийшло — погоджені ставки з відгуку: клієнту (`rate_feedback.agreed_rate`) і перевізнику
 * (`agreed_carrier`, з 30.10). Тут лише чисті функції над уже прочитаними рядками — тримають #2807–#2811.
 *
 * Чому МЕДІАНА, а не середнє: відгуків одиниці, і одна міжнародна поїздка (Тарган → Колін, +23% на 100 тис.) чи один
 * догруз (+58%) тягли б середнє за собою. Медіана каже, де калькулятор помиляється СИСТЕМНО, а не де трапився виняток.
 */
export type PriceSource = "market" | "tariff" | "before";
/** Знімки до проходу A (30.10) джерела не мають — там ставка завжди з тарифу. */
export const SOURCE_LABEL: Record<PriceSource, string> = { market: "ринок", tariff: "тариф КВП", before: "до 30.10 (тариф)" };
export const UNKNOWN = "невідомо";

/** Смуги відстані — межі з досліду 29–30.10: до 200 км тариф занижував найсильніше, від 450 км ринок і тариф рівні. */
export function distanceBand(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return "км невідомі";
  if (km < 200) return "до 200 км";
  if (km <= 500) return "200–500 км";
  return "понад 500 км";
}

export function priceSource(calc: FeedbackRow["calc"]): PriceSource {
  const s = calc?.price_source;
  return s === "market" || s === "tariff" ? s : "before";
}

const mid = (lo: number | null | undefined, hi: number | null | undefined): number | null => {
  if (lo == null) return null;
  const m = (lo + (hi ?? lo)) / 2;
  return m > 0 ? m : null;
};
/** Відхилення погодженого від середини порахованого діапазону, % зі знаком: «+» — погодили дорожче (калькулятор занизив). */
export function deviationPct(agreed: number | null | undefined, lo: number | null | undefined, hi: number | null | undefined): number | null {
  const m = mid(lo, hi);
  return agreed == null || m == null ? null : Math.round(((agreed - m) / m) * 100);
}

export interface AccuracyPair {
  at: string; author: string; route: string; tonnage: string | null; km: number | null; source: PriceSource;
  client_min: number; client_max: number; carrier_min: number | null; carrier_max: number | null;
  agreed: number | null; agreed_carrier: number | null; dev_pct: number | null; dev_carrier_pct: number | null;
  rating: Rating; comment: string | null;
}

/** Пари «порахували → погодили»: лише відгуки зі знімком і хоч однією погодженою ставкою; найновіші зверху. */
export function pairsOf(rows: FeedbackRow[]): AccuracyPair[] {
  const out: AccuracyPair[] = [];
  for (const r of rows) {
    const c = r.calc;
    if (c?.client_min == null || (r.agreed == null && r.agreedCarrier == null)) continue;
    out.push({
      at: r.at.toISOString(), author: r.author ?? "—", route: `${r.frm} → ${r.tox}`, tonnage: c.tonnage ?? null,
      km: c.distance_km == null ? null : Math.round(c.distance_km), source: priceSource(c),
      client_min: c.client_min, client_max: c.client_max ?? c.client_min, carrier_min: c.carrier_min ?? null, carrier_max: c.carrier_max ?? null,
      agreed: r.agreed, agreed_carrier: r.agreedCarrier ?? null,
      dev_pct: deviationPct(r.agreed, c.client_min, c.client_max), dev_carrier_pct: deviationPct(r.agreedCarrier, c.carrier_min, c.carrier_max),
      rating: r.rating, comment: r.comment,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export interface AccuracyGroup {
  key: string; n: number;
  /** Скільки з них із погодженою ставкою клієнту — лише за ними медіани. */
  priced: number; median_dev: number | null; median_abs: number | null;
  ok: number; high: number; low: number; no: number;
}
const median = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Групи за ключем: оцінки — за всіма відгуками, медіани — за тими, де є погоджена ставка. Найгірша (найбільша |медіана|) — перша. */
export function groupAccuracy(rows: FeedbackRow[], key: (r: FeedbackRow) => string): AccuracyGroup[] {
  const m = new Map<string, { g: AccuracyGroup; devs: number[] }>();
  for (const r of rows) {
    const k = key(r);
    const e = m.get(k) ?? { g: { key: k, n: 0, priced: 0, median_dev: null, median_abs: null, ok: 0, high: 0, low: 0, no: 0 }, devs: [] };
    e.g.n++; e.g[r.rating]++;
    const d = deviationPct(r.agreed, r.calc?.client_min, r.calc?.client_max);
    if (d != null) { e.g.priced++; e.devs.push(d); }
    m.set(k, e);
  }
  return [...m.values()]
    .map(({ g, devs }) => ({ ...g, median_dev: median(devs), median_abs: median(devs.map(Math.abs)) }))
    .sort((a, b) => (b.median_abs ?? -1) - (a.median_abs ?? -1) || b.n - a.n);
}

export interface AccuracyReport {
  priced: number; median_dev: number | null; median_abs: number | null;
  pairs: AccuracyPair[];
  bySource: AccuracyGroup[]; byTonnage: AccuracyGroup[]; byDistance: AccuracyGroup[]; byZone: AccuracyGroup[];
}

export function accuracyReport(rows: FeedbackRow[]): AccuracyReport {
  const devs = rows.map((r) => deviationPct(r.agreed, r.calc?.client_min, r.calc?.client_max)).filter((d): d is number => d != null);
  return {
    priced: devs.length, median_dev: median(devs), median_abs: median(devs.map(Math.abs)),
    pairs: pairsOf(rows),
    bySource: groupAccuracy(rows, (r) => SOURCE_LABEL[priceSource(r.calc)]),
    byTonnage: groupAccuracy(rows, (r) => r.calc?.tonnage ?? UNKNOWN),
    byDistance: groupAccuracy(rows, (r) => distanceBand(r.calc?.distance_km)),
    byZone: groupAccuracy(rows, (r) => r.calc?.zone ?? UNKNOWN),
  };
}
