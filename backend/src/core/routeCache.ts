import type { CachedRoute, RouteKey } from "./roadRoute.js";

/**
 * 🗺 КЕШ МАРШРУТІВ (`road_routes`): сервіс маршрутів питаємо РАЗ на пару міст і варіант (у сервісу денний ліміт; заміряно
 * 29.10.2026 — «Quota exceeded» після ~200 запитів за день). Рядок без строку дії — рішення Романа 29.10.2026.
 */
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export const CACHE_GET_SQL = `SELECT km, minutes, moldova_km, countries, via, line FROM road_routes
  WHERE from_lat = $1 AND from_lon = $2 AND to_lat = $3 AND to_lon = $4 AND variant = $5`;
export const CACHE_PUT_SQL = `INSERT INTO road_routes (from_lat, from_lon, to_lat, to_lon, variant, km, minutes, moldova_km, via, line, countries)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (from_lat, from_lon, to_lat, to_lon, variant) DO NOTHING`;

const keyParams = (k: RouteKey) => [k.from[0], k.from[1], k.to[0], k.to[1], k.variant];

export function routeCache(db: Db) {
  return {
    async cacheGet(k: RouteKey): Promise<CachedRoute | null> {
      const r = (await db.query(CACHE_GET_SQL, keyParams(k))).rows[0];
      if (!r) return null;
      return { km: Number(r.km), minutes: Number(r.minutes), moldovaKm: Number(r.moldova_km), via: (r.via as CachedRoute["via"]) ?? null,
        countries: ((r.countries as number[] | null) ?? []).map(Number), line: r.line as CachedRoute["line"] };
    },
    async cachePut(k: RouteKey, v: CachedRoute): Promise<void> {
      await db.query(CACHE_PUT_SQL, [...keyParams(k), v.km, v.minutes, v.moldovaKm, v.via ? JSON.stringify(v.via) : null, JSON.stringify(v.line), v.countries]);
    },
  };
}
