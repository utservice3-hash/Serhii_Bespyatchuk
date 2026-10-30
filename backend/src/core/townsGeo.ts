import { inServiceArea } from "./roadRoute.js";

/**
 * 🏙 СЛОВНИК МІСТ → КООРДИНАТИ (`towns_geo`) для ринкової ціни (прохід A, Роман 30.10.2026).
 *
 * Навіщо окремий словник, коли в `lardi_routes` уже є координати: там вони — координати ЗАПИТУ, а не оголошення. Коли
 * пошук Lardi розширюється до області, оголошення з Брусилова лягає під координатами Житомира, і «схожі оголошення»
 * шукались би не там (заміряно 29–30.10.2026). Тож координати оголошення беруться за ЙОГО назвами міст — зі словника.
 *
 * Словник наповнюється сам: з назв у `lardi_routes` (разово, у схемі) і з кожної відповіді пошуку міст `/towns`.
 * 🔴 Місто поза Європою у словник не потрапляє: у журналі вже була «Одеса» з координатами США (#2803).
 */
export interface TownGeo { key: string; name: string; lat: number; lon: number; townId: number | null; area: string | null }

/** Ключ назви: без регістру, апострофів, зайвих пробілів; «ё» → «е». Та сама нормалізація в SQL бекфілу схеми. */
export function nameKey(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[’'`ʼ]/g, "").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/** Запис словника з відповіді `/towns`: без ключа, без координат або поза Європою — не беремо. */
export function townRow(t: { id?: unknown; name?: unknown; lat?: unknown; lon?: unknown; area?: unknown }): TownGeo | null {
  const key = nameKey(t.name), lat = Number(t.lat), lon = Number(t.lon);
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lon) || !inServiceArea({ lat, lon })) return null;
  const id = Number(t.id);
  return { key, name: String(t.name), lat, lon, townId: Number.isInteger(id) && id > 0 ? id : null, area: typeof t.area === "string" && t.area ? t.area : null };
}

export const TOWNS_UPSERT_SQL = `INSERT INTO towns_geo (name_key, name, lat, lon, town_id, area, source)
  VALUES ($1, $2, $3, $4, $5, $6, 'towns')
  ON CONFLICT (name_key) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, town_id = COALESCE(EXCLUDED.town_id, towns_geo.town_id),
    area = COALESCE(EXCLUDED.area, towns_geo.area), updated_at = now()`;

type Db = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
export async function upsertTowns(db: Db, rows: TownGeo[]): Promise<void> {
  for (const r of rows) await db.query(TOWNS_UPSERT_SQL, [r.key, r.name, r.lat, r.lon, r.townId, r.area]);
}
