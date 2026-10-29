/**
 * 🛣 СЕРВІС МАРШРУТІВ (OpenRouteService, HeiGIT) — відстань по дорогах для калькулятора ставки (Роман 29.10.2026;
 * Сергій погодив того ж дня). Профіль — ЛЕГКОВИЙ: «вантажівка» на магістралях дає зайві 90–130 км, бо точки міст стоять
 * у центрі, куди вантажівкам заїзд заборонено (заміряно 29.10: Київ→Львів 634 проти 542, Google — 540).
 *
 * Будь-яка відмова — НЕ виняток, а результат з причиною: калькулятор тоді рахує «пряма × 1,25» з позначкою «приблизно».
 * 🔒 Ключ живе лише в заголовку запиту: у причини, лог і відповідь він не потрапляє (#2786).
 */
export type LatLng = [number, number];

/** Відрізок маршруту: км, хвилини, скільки км Молдовою, лінія для мапи. */
export interface RoadLeg { km: number; minutes: number; moldovaKm: number; line: LatLng[] }

export type OrsFailure = "no_key" | "no_route" | "quota" | "denied" | "timeout" | "network" | "bad_response" | `http_${number}`;
export type OrsResult = { ok: true; leg: RoadLeg } | { ok: false; reason: OrsFailure };

export interface OrsDeps { fetch: typeof fetch; key: string; timeoutMs?: number }

export const ORS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
/** Код Молдови в `countryinfo` сервісу (заміряно 29.10.2026: Ізмаїл→Хмельницький дав країни 211 і 129). */
export const ORS_MOLDOVA = 129;
const TIMEOUT_MS = 8000;
/** Скільки точок лінії лишаємо: мапі досить, а рядок у базі не роздувається (~5–15 КБ). */
export const LINE_MAX_POINTS = 400;

/** Проріджує лінію до `max` точок рівним кроком; перша й остання — завжди. Координати — 5 знаків (~1 м). */
export function thinLine(coords: [number, number][], max = LINE_MAX_POINTS): LatLng[] {
  const pts: LatLng[] = coords.map(([lon, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]);
}

/** Відповідь сервісу → відрізок; будь-яка невідповідність формі — `null`, а не нулі. */
export function parseOrsGeojson(j: unknown): RoadLeg | null {
  const f = (j as { features?: { geometry?: { coordinates?: unknown }; properties?: { summary?: { distance?: unknown; duration?: unknown };
    extras?: { countryinfo?: { summary?: { value?: unknown; distance?: unknown }[] } } } }[] })?.features?.[0];
  const dist = Number(f?.properties?.summary?.distance), dur = Number(f?.properties?.summary?.duration);
  const coords = f?.geometry?.coordinates;
  if (!Number.isFinite(dist) || dist <= 0 || !Number.isFinite(dur) || !Array.isArray(coords) || coords.length < 2) return null;
  const md = (f?.properties?.extras?.countryinfo?.summary ?? [])
    .filter((c) => Number(c.value) === ORS_MOLDOVA).reduce((s, c) => s + (Number(c.distance) || 0), 0);
  return { km: Math.round(dist / 1000), minutes: Math.round(dur / 60), moldovaKm: Math.round(md / 1000), line: thinLine(coords as [number, number][]) };
}

/** Код відповіді + текст → причина. «Quota exceeded» сервіс віддає і як 403, і як 429. */
export function failureOf(status: number, body: string): OrsFailure {
  if (status === 429 || /quota/i.test(body)) return "quota";
  if (status === 401 || status === 403) return "denied";
  if (status === 404 || /"code"\s*:\s*20(09|10)/.test(body)) return "no_route";
  return `http_${status}`;
}

/** Маршрут через точки (lat, lon). `avoidMoldova` — оминати Молдову (для варіанта «через Україну»). */
export async function orsRoute(deps: OrsDeps, points: LatLng[], opts: { avoidMoldova?: boolean } = {}): Promise<OrsResult> {
  if (!deps.key) return { ok: false, reason: "no_key" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  try {
    const r = await deps.fetch(ORS_URL, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: deps.key, "Content-Type": "application/json", Accept: "application/geo+json, application/json" },
      body: JSON.stringify({ coordinates: points.map(([lat, lon]) => [lon, lat]), extra_info: ["countryinfo"],
        ...(opts.avoidMoldova ? { options: { avoid_countries: [ORS_MOLDOVA] } } : {}) }),
    });
    const text = await r.text();
    if (r.status !== 200) return { ok: false, reason: failureOf(r.status, text) };
    let j: unknown;
    try { j = JSON.parse(text); } catch { return { ok: false, reason: "bad_response" }; }
    const leg = parseOrsGeojson(j);
    return leg ? { ok: true, leg } : { ok: false, reason: "bad_response" };
  } catch (e) {
    return { ok: false, reason: (e as { name?: string })?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
