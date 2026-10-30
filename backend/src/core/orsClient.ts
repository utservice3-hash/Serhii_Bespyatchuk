/**
 * 🛣 СЕРВІС МАРШРУТІВ (OpenRouteService, HeiGIT) — відстань по дорогах для калькулятора ставки (Роман 29.10.2026;
 * Сергій погодив того ж дня). Профіль — ЛЕГКОВИЙ: «вантажівка» на магістралях дає зайві 90–130 км, бо точки міст стоять
 * у центрі, куди вантажівкам заїзд заборонено (заміряно 29.10: Київ→Львів 634 проти 542, Google — 540).
 *
 * Будь-яка відмова — НЕ виняток, а результат з причиною: калькулятор тоді рахує «пряма × 1,25» з позначкою «приблизно».
 * 🔒 Ключ живе лише в заголовку запиту: у причини, лог і відповідь він не потрапляє (#2786).
 */
export type LatLng = [number, number];

/** Відрізок маршруту: км, хвилини, скільки км Молдовою, якими країнами (коди сервісу), лінія для мапи. */
export interface RoadLeg { km: number; minutes: number; moldovaKm: number; countries: number[]; line: LatLng[] }

export type OrsFailure = "no_key" | "no_route" | "quota" | "denied" | "timeout" | "network" | "bad_response" | `http_${number}`;
/** Денний ліміт сервісу, як він сам його повідомляє в заголовках відповіді (Роман 29.10.2026: «виводити, скільки лишилось»). */
export interface OrsQuota { limit: number; remaining: number; resetAt: string | null }
export type OrsResult = ({ ok: true; leg: RoadLeg } | { ok: false; reason: OrsFailure }) & { quota?: OrsQuota | null };

/**
 * Заголовки `x-ratelimit-*` → ліміт. Заміряно 29.10.2026: `limit 2000`, `remaining 1999`, `reset` — Unix-секунди.
 * Немає ліміту чи залишку — `null` («невідомо»), а НЕ нуль: нуль читався б як «ліміт вичерпано» (#2795).
 */
export function parseQuota(h: { get(name: string): string | null }): OrsQuota | null {
  const num = (v: string | null) => (v == null || v.trim() === "" ? NaN : Number(v));
  const limit = num(h.get("x-ratelimit-limit")), remaining = num(h.get("x-ratelimit-remaining")), reset = num(h.get("x-ratelimit-reset"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0 || remaining < 0) return null;
  return { limit, remaining, resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null };
}

export interface OrsDeps { fetch: typeof fetch; key: string; timeoutMs?: number }

/**
 * Адреса — `api.heigit.org`. Стару `api.openrouteservice.org` HeiGIT визнав застарілою 28.04.2026, урізав на ній ліміт
 * і вимикає 2–6.11.2026 (оголошення: ask.openrouteservice.org/t/7912). Заміряно 29.10.2026: стара адреса на будь-який
 * ключ — 403 «Quota exceeded», нова — 200, ліміт 2 000/день, той самий ключ (#2789).
 */
export const ORS_URL = "https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson";
/** Код Молдови в `countryinfo` сервісу (заміряно 29.10.2026: Ізмаїл→Хмельницький дав країни 211 і 129). */
export const ORS_MOLDOVA = 129;
/** Код України (заміряно 29.10.2026: маршрути по Україні дають рівно [211]). */
export const ORS_UKRAINE = 211;
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
  const summary = f?.properties?.extras?.countryinfo?.summary ?? [];
  const md = summary.filter((c) => Number(c.value) === ORS_MOLDOVA).reduce((s, c) => s + (Number(c.distance) || 0), 0);
  const countries = [...new Set(summary.map((c) => Number(c.value)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return { km: Math.round(dist / 1000), minutes: Math.round(dur / 60), moldovaKm: Math.round(md / 1000), countries, line: thinLine(coords as [number, number][]) };
}

/** Код відповіді + текст → причина. «Quota exceeded» сервіс віддає і як 403, і як 429. */
export function failureOf(status: number, body: string): OrsFailure {
  if (status === 429 || /quota/i.test(body)) return "quota";
  if (status === 401 || status === 403) return "denied";
  if (status === 404 || /"code"\s*:\s*20(09|10)/.test(body)) return "no_route";
  return `http_${status}`;
}

/**
 * Маршрут через точки (lat, lon). `noBorders` — не перетинати ЖОДНОГО кордону (варіант «через Україну»). Не «оминати
 * Молдову»: так сервіс об'їжджав Румунією (заміряно на проді 29.10.2026: Львів→Ізмаїл «через Україну» пішов через Сучаву).
 */
export async function orsRoute(deps: OrsDeps, points: LatLng[], opts: { noBorders?: boolean } = {}): Promise<OrsResult> {
  if (!deps.key) return { ok: false, reason: "no_key" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  try {
    const r = await deps.fetch(ORS_URL, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: deps.key, "Content-Type": "application/json", Accept: "application/geo+json, application/json" },
      body: JSON.stringify({ coordinates: points.map(([lat, lon]) => [lon, lat]), extra_info: ["countryinfo"],
        ...(opts.noBorders ? { options: { avoid_borders: "all" } } : {}) }),
    });
    const text = await r.text();
    const quota = r.headers ? parseQuota(r.headers) : null;
    if (r.status !== 200) return { ok: false, reason: failureOf(r.status, text), quota };
    let j: unknown;
    try { j = JSON.parse(text); } catch { return { ok: false, reason: "bad_response", quota }; }
    const leg = parseOrsGeojson(j);
    return leg ? { ok: true, leg, quota } : { ok: false, reason: "bad_response", quota };
  } catch (e) {
    return { ok: false, reason: (e as { name?: string })?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
