import type { MarketOffer } from "./marketPrice.js";
import { WINDOW_DAYS } from "./marketPrice.js";

/**
 * 🧠 ПУЛ ОГОЛОШЕНЬ У ПАМʼЯТІ для ринкової ціни: оголошення замовників за 30 днів з координатами обох кінців
 * (`lardi_offers.from_lat…`, зі словника міст). Перечитується раз на годину — ринок рухається помісячно, не щохвилини,
 * а читати ~15–20 тис. рядків на кожен розрахунок — зайве. Один і той самий `offer_id` під різними маршрутами — раз.
 */
export const POOL_TTL_MS = 60 * 60_000;
/** Санітарні межі грн/км — як у досліді: нижче — не ціна рейсу, вище — помилка введення. */
export const PER_KM_MIN = 3, PER_KM_MAX = 800;

export const POOL_SQL = `SELECT DISTINCT ON (offer_id) from_lat::float AS flat, from_lon::float AS flon, to_lat::float AS tlat, to_lon::float AS tlon,
    mass::float AS mass, dist_km::float AS km, total::float AS total
  FROM lardi_offers
  WHERE side = 'cargo' AND is_uah AND total > 0 AND mass > 0 AND dist_km >= 5
    AND from_lat IS NOT NULL AND to_lat IS NOT NULL
    AND total / dist_km BETWEEN $1 AND $2
    AND first_seen >= now() - make_interval(days => $3)
  ORDER BY offer_id, first_seen`;

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
let cache: { at: number; pool: MarketOffer[] } | null = null;

export async function getMarketPool(db: Db, clock: () => number = Date.now): Promise<MarketOffer[]> {
  if (cache && clock() - cache.at < POOL_TTL_MS) return cache.pool;
  const r = await db.query(POOL_SQL, [PER_KM_MIN, PER_KM_MAX, WINDOW_DAYS]);
  const pool = r.rows.map((x) => ({ flat: Number(x.flat), flon: Number(x.flon), tlat: Number(x.tlat), tlon: Number(x.tlon), mass: Number(x.mass), km: Number(x.km), total: Number(x.total) }));
  cache = { at: clock(), pool };
  return pool;
}

export function invalidateMarketPool(): void { cache = null; }
