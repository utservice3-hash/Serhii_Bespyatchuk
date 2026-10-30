/**
 * 🧮 ВІДГУК НА РОЗРАХУНОК СТАВКИ (Роман 27.10.2026): «наскільки корисний був розрахунок» — щоб міряти, чи калькулятор
 * попадає в реальні ставки. Бачать зведення адмін, СЕО, ОД, КВП (право `view_rate_feedback`); повідомлень немає.
 *
 * Чому числа розрахунку зберігає СЕРВЕР (`lardi_usage.calc`), а відгук шле лише номер розрахунку: інакше відгук
 * порівнювався б із тим, що прислав браузер, а після зміни зонної карти старі відгуки «судили» б нові ставки.
 * Чисті функції без бази — тримають #2770–#2774.
 */

export const RATINGS = ["ok", "high", "low", "no"] as const;
export type Rating = (typeof RATINGS)[number];
export const RATING_LABEL: Record<Rating, string> = { ok: "Точно", high: "Завищено", low: "Занижено", no: "Не допоміг" };
const COMMENT_MAX = 1000;

export class RateFeedbackError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface FeedbackInput { usageId: number; rating: Rating; agreed: number | null; comment: string | null }

/** Тіло відгуку → перевірене значення; погоджена ставка — «44 000», «44000,50» чи порожньо. */
export function parseFeedback(b: Record<string, unknown>): FeedbackInput {
  const usageId = Number(b.usageId);
  if (!Number.isInteger(usageId) || usageId <= 0) throw new RateFeedbackError(400, "Невідомий розрахунок");
  const rating = String(b.rating ?? "");
  if (!(RATINGS as readonly string[]).includes(rating)) throw new RateFeedbackError(400, "Оберіть оцінку");
  const rawAgreed = String(b.agreed ?? "").replace(/[\s ₴]|грн/g, "").replace(",", ".");
  let agreed: number | null = null;
  if (rawAgreed) {
    agreed = Number(rawAgreed);
    if (!Number.isFinite(agreed) || agreed <= 0) throw new RateFeedbackError(400, "Погоджена ставка — число більше нуля");
  }
  const comment = String(b.comment ?? "").trim().slice(0, COMMENT_MAX) || null;
  return { usageId, rating: rating as Rating, agreed, comment };
}

/** Календарний день по-київськи: «YYYY-MM-DD». */
export function kyivDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Питати відгук, якщо ця людина сьогодні (по-київськи) ще не відгукувалась на ЦЕЙ маршрут. */
export function feedbackDue(prev: { frm: string; tox: string; at: Date }[], frm: string, tox: string, now: Date): boolean {
  const today = kyivDay(now);
  return !prev.some((p) => p.frm === frm && p.tox === tox && kyivDay(p.at) === today);
}

/** Що калькулятор показав — знімок у `lardi_usage.calc`. Головне число — зонна карта (рядок, обраний за вагою). */
export interface CalcSnapshot {
  mass_min: number | null; mass_max: number | null; body_type_ids: number[]; distance_km: number | null;
  zone: string | null; tonnage: string | null;
  client_min: number | null; client_max: number | null; carrier_min: number | null; carrier_max: number | null;
  margin: number | null; per_km_min: number | null; per_km_max: number | null;
  /** 🗺 Звідки км (29.10.2026): `road` — по дорогах, `approx` — пряма × 1,25, `manual` — менеджер виправив; і який варіант
   *  маршруту обрано. Старі знімки цих полів не мають — для них км бралися з пропозицій Lardi. */
  distance_source?: "road" | "approx" | "manual" | null; route_variant?: string | null; road_km?: number | null; moldova_km?: number | null;
}
/** Маршрутна частина знімка (`routes/rates.ts → routeInfo`). */
export type RouteInfo = { distance_source: "road" | "approx" | "manual"; route_variant: string; road_km: number | null; moldova_km: number };
type ZoneOpt = { tonnage: string; selected: boolean; client_min: number | null; client_max: number | null; total_min: number | null; total_max: number | null; margin: number | null; per_km_min: number; per_km_max: number };
export function snapshotOf(
  req: { mass_min: number | null; mass_max: number | null; body_type_ids: number[] },
  distanceKm: number | null,
  zone: { zone: string; options: ZoneOpt[] } | null | undefined,
  route?: RouteInfo,
): CalcSnapshot {
  const sel = zone?.options.find((o) => o.selected) ?? null;
  return {
    mass_min: req.mass_min, mass_max: req.mass_max, body_type_ids: req.body_type_ids, distance_km: distanceKm,
    zone: zone?.zone ?? null, tonnage: sel?.tonnage ?? null,
    client_min: sel?.client_min ?? null, client_max: sel?.client_max ?? null,
    carrier_min: sel?.total_min ?? null, carrier_max: sel?.total_max ?? null,
    margin: sel?.margin ?? null, per_km_min: sel?.per_km_min ?? null, per_km_max: sel?.per_km_max ?? null,
    distance_source: route?.distance_source ?? null, route_variant: route?.route_variant ?? null,
    road_km: route?.road_km ?? null, moldova_km: route?.moldova_km ?? null,
  };
}

export interface FeedbackRow {
  rating: Rating; agreed: number | null; comment: string | null; at: Date; author: string | null;
  frm: string; tox: string; calc: Partial<CalcSnapshot> | null;
}
interface Bucket { key: string; n: number; ok: number }

/**
 * Зведення: частка «Точно», середнє відхилення погодженої ставки від розрахованої (від середини діапазону клієнту),
 * розбивка за авто й зоною, останні коментарі. Відхилення «+» — погодили дорожче, тобто калькулятор занизив.
 */
export function feedbackStats(rows: FeedbackRow[], calculations: number) {
  const byRating = Object.fromEntries(RATINGS.map((r) => [r, 0])) as Record<Rating, number>;
  for (const r of rows) byRating[r.rating]++;
  const devs: number[] = [];
  for (const r of rows) {
    const lo = r.calc?.client_min, hi = r.calc?.client_max ?? lo;
    if (r.agreed == null || lo == null || hi == null) continue;
    const mid = (lo + hi) / 2;
    if (mid > 0) devs.push(((r.agreed - mid) / mid) * 100);
  }
  const bucket = (key: (r: FeedbackRow) => string): Bucket[] => {
    const m = new Map<string, Bucket>();
    for (const r of rows) {
      const k = key(r); const b = m.get(k) ?? { key: k, n: 0, ok: 0 };
      b.n++; if (r.rating === "ok") b.ok++; m.set(k, b);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    total: rows.length,
    calculations,
    coverage: calculations > 0 ? round1((rows.length / calculations) * 100) : null,
    byRating,
    okShare: rows.length ? round1((byRating.ok / rows.length) * 100) : null,
    deviation: devs.length ? { avg: round1(devs.reduce((a, x) => a + x, 0) / devs.length), n: devs.length } : null,
    byTonnage: bucket((r) => r.calc?.tonnage ?? "невідомо"),
    byZone: bucket((r) => r.calc?.zone ?? "невідомо"),
    comments: rows.filter((r) => r.comment).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 10)
      .map((r) => ({ at: r.at.toISOString(), author: r.author ?? "—", route: `${r.frm} → ${r.tox}`, rating: r.rating, agreed: r.agreed, comment: r.comment })),
  };
}
