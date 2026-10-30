import { marginFor } from "./zoneRates.js";
import { straightKm } from "./roadRoute.js";

/**
 * 📈 РИНКОВА ЦІНА МАРШРУТУ — «схожі оголошення за 30 днів» (прохід A; Роман 29–30.10.2026: «ринкова ціна маршруту —
 * головна», «одна формула для всіх, точно»).
 *
 * Дослід 29–30.10.2026 на 77 743 оголошеннях Lardi (чесна перевірка: модель лише на попередніх 60 днях, перевірка —
 * 4 останні тижні, 13 760 оголошень): тариф × км помиляється на 26% (фура 18%, короткі −19%, довгі +27%); «схожі
 * оголошення» — 17% (фура 12%) без перекосу; межа самого ринку (той самий маршрут/авто/тиждень) — 12%.
 *
 * Як рахуємо: з оголошень замовників за 30 днів беремо ті, чиї кінці лежать поблизу наших (кожен — у межах `NEAR_KM`),
 * вага в межах ×2 і відстань у межах ×1,65; з них — `K` найближчих за сумарною відстанню; ціну кожного перераховуємо
 * на наші км (ціна рейсу росте повільніше за км: показник 0,7 — з досліду); ставка перевізнику — медіана, діапазон —
 * чверті. Менше `MIN_N` схожих — ринкової ціни немає, лишається тариф КВП із позначкою (#2800).
 *
 * ❓ ВІДКРИТЕ ПИТАННЯ (Роман 30.10.2026, не вирішено): «до 2,5 т» і «до 5 т» — окрема машина чи догруз? На Lardi вага —
 * ВАНТАЖУ, тож дрібні оголошення — це ціни догрузу. Доки не вирішено, для цих класів головною лишається ставка за
 * тарифом КВП, ринок — довідково (`marketIsMain`, #2801).
 */
export const WINDOW_DAYS = 30;
export const K_NEAREST = 15;
export const MIN_N = 5;
/** Кінці схожого оголошення — не далі за це від наших (км по прямій). */
export const NEAR_KM = 120;
/** Вага: у межах ×2 в обидва боки; відстань: ×1,65 (ln 0,69 і 0,5 — як у досліді). */
export const MASS_LN = 0.69, KM_LN = 0.5;
/** Ціна рейсу ~ км^0,7 (з досліду): подача й завантаження коштують незалежно від відстані. */
export const KM_EXPONENT = 0.7;
/** Ринок головний лише для авто важчих за 5 т (див. відкрите питання вище). */
export const MARKET_MAIN_MIN_MASS = 5;
/** Ринок і тариф розійшлись більше — позначка на екрані. */
export const TARIFF_DIFF_FLAG_PCT = 20;
/**
 * Запобіжник від шуму рідких даних: ринок, що розходиться з тарифом сильніше, — не головний, а довідковий. Заміряно
 * 30.10.2026 на живому пулі: «до 10 т» Київ→Житомир з 28 оголошень дав 19 797 — дорожче за фуру (12 136) і +148% до
 * тарифу; справжні розбіжності (фура Київ→Житомир +20%, Київ→Львів −23%) значно менші. Межа — технічна, не бізнесова.
 */
export const MARKET_SANITY_PCT = 60;

export interface MarketOffer { flat: number; flon: number; tlat: number; tlon: number; mass: number; km: number; total: number }
export interface MarketReq { from: { lat: number; lon: number }; to: { lat: number; lon: number }; mass: number; km: number }
export interface MarketPrice {
  carrier_median: number; carrier_p25: number; carrier_p75: number;
  /** Скільки схожих узято (≤ K) і скільки взагалі пройшло межі. */
  n: number; pool: number; window_days: number; km: number; mass: number;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

/** Ринкова ставка перевізнику для запиту за пулом оголошень; `null` — схожих замало. */
export function marketQuote(pool: readonly MarketOffer[], req: MarketReq): MarketPrice | null {
  if (!(req.km >= 5) || !(req.mass > 0)) return null;
  const cand: { d: number; price: number }[] = [];
  for (const o of pool) {
    if (!(o.km >= 5) || !(o.mass > 0) || !(o.total > 0)) continue;
    const dm = Math.abs(Math.log(o.mass / req.mass)) / MASS_LN; if (dm > 1) continue;
    const dk = Math.abs(Math.log(o.km / req.km)) / KM_LN; if (dk > 1) continue;
    const df = straightKm([req.from.lat, req.from.lon], [o.flat, o.flon]) / NEAR_KM; if (df > 1) continue;
    const dt = straightKm([req.to.lat, req.to.lon], [o.tlat, o.tlon]) / NEAR_KM; if (dt > 1) continue;
    cand.push({ d: Math.sqrt(df * df + dt * dt + dm * dm + dk * dk), price: o.total * Math.pow(req.km / o.km, KM_EXPONENT) });
  }
  if (cand.length < MIN_N) return null;
  const near = cand.sort((a, b) => a.d - b.d).slice(0, K_NEAREST).map((c) => c.price);
  return { carrier_median: Math.round(median(near)), carrier_p25: Math.round(quantile(near, 0.25)), carrier_p75: Math.round(quantile(near, 0.75)),
    n: near.length, pool: cand.length, window_days: WINDOW_DAYS, km: req.km, mass: req.mass };
}

export const marketIsMain = (mass: number | null) => mass != null && mass > MARKET_MAIN_MIN_MASS;

type ZoneLike = { options: { selected: boolean; total_min: number | null; total_max: number | null; client_min: number | null; client_max: number | null; margin: number | null; per_km_min: number; per_km_max: number }[] } | null | undefined;
/** Що показуємо як ставку: ринок (для авто > 5 т, коли схожих досить) або тариф КВП; поруч — розбіжність між ними. */
export interface PriceView {
  source: "market" | "tariff";
  client_min: number; client_max: number; carrier_min: number; carrier_max: number; margin: number;
  per_km_min: number; per_km_max: number;
  /** На скільки % ринок відрізняється від тарифу (перевізнику, середини); null — ринку немає або тарифу немає. */
  tariff_diff_pct: number | null;
  /** Чому не ринок: замало схожих (пул), клас авто, для якого ринок лише довідково, або ринок надто далеко від тарифу (шум). */
  tariff_reason: "few_offers" | "light_class" | "market_outlier" | null;
}

export function priceView(zone: ZoneLike, market: MarketPrice | null, mass: number | null): PriceView | null {
  const sel = zone?.options.find((o) => o.selected) ?? null;
  const margin = sel?.margin ?? marginFor(mass ?? 20);
  const tariffMid = sel && sel.total_min != null && sel.total_max != null ? (sel.total_min + sel.total_max) / 2 : null;
  const diff = market && tariffMid ? Math.round((market.carrier_median / tariffMid - 1) * 100) : null;
  if (market && marketIsMain(mass) && (diff == null || Math.abs(diff) <= MARKET_SANITY_PCT)) {
    const km = Math.max(market.km, 1);
    return { source: "market", client_min: market.carrier_p25 + margin, client_max: market.carrier_p75 + margin,
      carrier_min: market.carrier_p25, carrier_max: market.carrier_p75, margin,
      per_km_min: Math.round(market.carrier_p25 / km), per_km_max: Math.round(market.carrier_p75 / km), tariff_diff_pct: diff, tariff_reason: null };
  }
  if (!sel || sel.client_min == null || sel.client_max == null || sel.total_min == null || sel.total_max == null) return null;
  return { source: "tariff", client_min: sel.client_min, client_max: sel.client_max, carrier_min: sel.total_min, carrier_max: sel.total_max,
    margin, per_km_min: sel.per_km_min, per_km_max: sel.per_km_max, tariff_diff_pct: diff,
    tariff_reason: !market ? "few_offers" : !marketIsMain(mass) ? "light_class" : "market_outlier" };
}
