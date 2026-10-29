import { zoneRecommendation } from "./zoneRates.js";
import { ORS_MOLDOVA, ORS_UKRAINE, type LatLng, type OrsResult, type RoadLeg } from "./orsClient.js";

/**
 * 🗺 ВІДСТАНЬ ДЛЯ СТАВКИ — ПО ДОРОГАХ (Роман 29.10.2026, Сергій погодив того ж дня).
 *
 * Було: км = медіана відстаней із пропозицій Lardi, а коли їх у місті мало — з пропозицій ІНШИХ міст області. Заміряно
 * 29.10.2026 на 111 розрахунках: ~14% мали явно хибні км (Стрижавка→Вінниця 170 замість 12, Львів→Брусилів 1 222 замість
 * 470) — і разом із ними хибну ставку. Стало: маршрут по дорогах від сервісу маршрутів, ОДИН раз на пару міст (кеш у
 * `road_routes`), запасний варіант — «пряма × 1,25» з позначкою «приблизно». Медіана Lardi на км більше не впливає (#2780).
 *
 * Варіанти: основний маршрут і — якщо він іде Молдовою довше за поріг — «через Україну» (сервіс оминає Молдову сам;
 * з Ізмаїла/Рені дороги без Молдови немає взагалі, тоді — через Одесу). Ставка в кожного варіанта своя: зонна карта
 * на його км. Менеджер може виправити км (`km_override`) — ставка перераховується, джерело стає «вручну».
 *
 * Чисте ядро: мережа й база — через `RouteDeps`, тож логіку тримають гейти без жодного з них (#2780–#2785).
 */

export const ROAD_FACTOR = 1.25;
/** Рішення Романа 29.10.2026 («так» на поріг із плану): маршрут, що йде Молдовою ДОВШЕ за це, отримує варіант через
 *  Україну. Короткий транзит біля Паланки (8–10 км) — норма для Одещини, варіанта не потребує. */
export const MOLDOVA_DETOUR_KM = 30;
/** Ручні км: менше 1 чи більше цього — помилка введення, а не маршрут (найдовший реальний у журналі — ~2 600 км). */
export const KM_OVERRIDE_MAX = 5000;
/**
 * Де сервіс маршрутів узагалі має сенс: Європа. Місто за межами (у журналі 14.10: «Одеса» з координатами в США) — це
 * хибно обране місто, а не маршрут на 8 000 км: такий розрахунок іде без сервісу, з позначкою (#2785).
 */
export const SERVICE_AREA = { latMin: 34, latMax: 72, lonMin: -11, lonMax: 45 } as const;
/** Об'їзд Молдови, коли сервіс не знаходить дороги без неї (Ізмаїл, Рені — заміряно 29.10.2026). */
export const UA_DETOUR_VIA = { name: "Одеса", acc: "Одесу", lat: 46.48253, lon: 30.72331 } as const;

export type Via = { name: string; acc: string; lat: number; lon: number };
export type VariantId = "main" | "ua";
export interface CachedRoute extends RoadLeg { via: Via | null }
export interface RouteKey { from: LatLng; to: LatLng; variant: VariantId }
export interface RouteDeps {
  route(points: LatLng[], opts?: { noBorders?: boolean }): Promise<OrsResult>;
  cacheGet(key: RouteKey): Promise<CachedRoute | null>;
  cachePut(key: RouteKey, r: CachedRoute): Promise<void>;
  log?(msg: string): void;
}

/** Маршрут, як його бачить розрахунок: по дорогах або приблизно, і чому приблизно. */
export interface ResolvedRoute extends CachedRoute {
  id: VariantId;
  source: "road" | "approx";
  /** Чому не по дорогах: причина сервісу (`quota`, `timeout`…) або `outside_area`. */
  failure: string | null;
}

export class RouteInputError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** Ключ кешу — координати з точністю ~100 м: та сама пара міст дає той самий рядок незалежно від назви. */
export const keyPoint = (p: { lat: number; lon: number }): LatLng => [r3(p.lat), r3(p.lon)];

export function hasPoint(p: { lat?: unknown; lon?: unknown } | null | undefined): p is { lat: number; lon: number } {
  const lat = Number(p?.lat), lon = Number(p?.lon);
  return p?.lat != null && p?.lon != null && Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

export function inServiceArea(p: { lat: number; lon: number }): boolean {
  const a = SERVICE_AREA;
  return p.lat >= a.latMin && p.lat <= a.latMax && p.lon >= a.lonMin && p.lon <= a.lonMax;
}

export function straightKm(a: LatLng, b: LatLng): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Запасний варіант: пряма × 1,25, без часу в дорозі, лінія — два кінці (на мапі пунктир). */
export function approxRoute(a: LatLng, b: LatLng, failure: string): ResolvedRoute {
  return { id: "main", source: "approx", failure, via: null, km: Math.round(straightKm(a, b) * ROAD_FACTOR), minutes: 0, moldovaKm: 0, countries: [], line: [a, b] };
}

/** Рейс внутрішній: маршрут іде лише Україною й Молдовою (транзитом). Для міжнародного «через Україну» не має сенсу. */
const domestic = (countries: number[]) => countries.length > 0 && countries.every((c) => c === ORS_UKRAINE || c === ORS_MOLDOVA);
export const needsUaDetour = (r: ResolvedRoute) => r.source === "road" && r.moldovaKm > MOLDOVA_DETOUR_KM && domestic(r.countries);
/** Варіант «через Україну» годиться, лише якщо він справді Україною: жодної третьої країни, Молдовою — не довше порогу. */
export const isUaRoute = (l: RoadLeg) => domestic(l.countries) && l.moldovaKm <= MOLDOVA_DETOUR_KM;

async function cached(deps: RouteDeps, key: RouteKey, fetchIt: () => Promise<CachedRoute | string>): Promise<CachedRoute | string> {
  const hit = await deps.cacheGet(key).catch((e) => { deps.log?.(`road_routes: читання не вдалось — ${String(e).slice(0, 120)}`); return null; });
  if (hit) return hit;
  const got = await fetchIt();
  if (typeof got !== "string") await deps.cachePut(key, got).catch((e) => deps.log?.(`road_routes: запис не вдався — ${String(e).slice(0, 120)}`));
  return got;
}

/**
 * Маршрути для пари міст: [основний] або [основний, «через Україну»]. Немає координат — порожньо (розрахунок без км,
 * як і раніше). Сервіс не відповів — основний «приблизно» (і НЕ кешується: наступний розрахунок спробує знову).
 */
export async function resolveRoutes(deps: RouteDeps, frm: { lat?: unknown; lon?: unknown }, to: { lat?: unknown; lon?: unknown }): Promise<ResolvedRoute[]> {
  if (!hasPoint(frm) || !hasPoint(to)) return [];
  const a = keyPoint(frm), b = keyPoint(to);
  if (!inServiceArea(frm) || !inServiceArea(to)) return [approxRoute(a, b, "outside_area")];
  const main = await cached(deps, { from: a, to: b, variant: "main" }, async () => {
    const r = await deps.route([a, b]);
    return r.ok ? { ...r.leg, via: null } : r.reason;
  });
  if (typeof main === "string") { deps.log?.(`маршрути: сервіс не відповів (${main}) — приблизна відстань`); return [approxRoute(a, b, main)]; }
  const first: ResolvedRoute = { ...main, id: "main", source: "road", failure: null };
  if (!needsUaDetour(first)) return [first];
  const ua = await cached(deps, { from: a, to: b, variant: "ua" }, async () => {
    const inside = await deps.route([a, b], { noBorders: true });
    if (inside.ok) return isUaRoute(inside.leg) ? { ...inside.leg, via: null } : "not_ukraine";
    if (inside.reason !== "no_route") return inside.reason;
    const v = UA_DETOUR_VIA;
    const via = await deps.route([a, [v.lat, v.lon], b]);
    if (!via.ok) return via.reason;
    return isUaRoute(via.leg) ? { ...via.leg, via: { ...v } } : "not_ukraine";
  });
  if (typeof ua === "string") { deps.log?.(`маршрути: варіант через Україну не отримано (${ua})`); return [first]; }
  return [first, { ...ua, id: "ua", source: "road", failure: null }];
}

/** Ручні км із тіла запиту: порожньо — `null`; інакше ціле 1…5 000, решта — 400. */
export function parseKmOverride(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n < 1 || n > KM_OVERRIDE_MAX) throw new RouteInputError(400, `Відстань — число від 1 до ${String(KM_OVERRIDE_MAX)} км`);
  return Math.round(n);
}

/** Номер обраного варіанта: порожньо — 0; інакше лише наявний варіант. */
export function parseVariant(raw: unknown, count: number): number {
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= Math.max(count, 1)) throw new RouteInputError(400, "Невідомий варіант маршруту");
  return n;
}

type Zone = ReturnType<typeof zoneRecommendation>;
/** Варіант маршруту у відповіді `/analyze` (формат — snake_case, як решта відповіді калькулятора). */
export interface RouteVariantOut {
  id: VariantId; label: string; via: Via | null;
  distance_km: number; road_km: number | null; minutes: number | null;
  source: "road" | "approx" | "manual"; failure: string | null; moldova_km: number;
  line: LatLng[]; zone_recommendation: Zone;
}

/** Підпис варіанта людською мовою. Основний — «Найшвидший», не «найкоротший»: сервіс будує маршрут за ЧАСОМ, і об'їзд
 *  буває коротшим (заміряно 29.10.2026: Львів→Ізмаїл 803 км через Молдову проти 788 км Україною). */
export function variantLabel(r: ResolvedRoute, count: number): string {
  if (r.id === "ua") return r.via ? `Через Україну · через ${r.via.acc}` : "Через Україну";
  return count > 1 ? "Найшвидший" : "Маршрут";
}

/**
 * Маршрути → варіанти відповіді: у кожного своя зонна ставка на його км. `override` — менеджер виправив км обраного
 * варіанта: км стають його, ставка перераховується, «за маршрутом» зберігається в `road_km`.
 */
export function toVariants(routes: ResolvedRoute[], zone: { fromArea: string | null; toArea: string | null; mass: number | null },
  override: { variant: number; km: number } | null): RouteVariantOut[] {
  return routes.map((r, i) => {
    const manual = override && override.variant === i ? override.km : null;
    const km = manual ?? r.km;
    return {
      id: r.id, label: variantLabel(r, routes.length), via: r.via,
      distance_km: km, road_km: manual != null ? r.km : null, minutes: r.source === "road" && manual == null ? r.minutes : null,
      source: manual != null ? "manual" : r.source, failure: r.failure, moldova_km: r.moldovaKm, line: r.line,
      zone_recommendation: zoneRecommendation(zone.fromArea, zone.toArea, zone.mass, km),
    };
  });
}
