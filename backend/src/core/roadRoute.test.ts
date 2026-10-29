import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveRoutes, toVariants, parseKmOverride, parseVariant, RouteInputError, MOLDOVA_DETOUR_KM, UA_DETOUR_VIA,
  type CachedRoute, type RouteDeps, type RouteKey,
} from "./roadRoute.js";
import { orsRoute, failureOf, ORS_MOLDOVA, type LatLng, type OrsResult } from "./orsClient.js";
import { snapshotOf } from "./rateFeedback.js";

/**
 * 🗺 #2780–#2788 — ВІДСТАНЬ ДЛЯ СТАВКИ ПО ДОРОГАХ (Роман 29.10.2026, Сергій погодив). Чисті: мережа й база підмінені,
 * джерела читаються текстом. Жива проба (сервіс маршрутів, `road_routes`) — у прийманні на проді.
 */
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const RATES = SRC("../../src/routes/rates.ts");
const SCHEMA = SRC("../db/schema.sql");
const SCREEN = SRC("../../../frontend/src/pages/dashboard/sections/RatesSimple.tsx");
const MAP = SRC("../../../frontend/src/pages/dashboard/sections/RouteMap.tsx");
const ANALYZE = (() => { const at = RATES.indexOf('ratesRouter.post("/analyze"'); return RATES.slice(at, RATES.indexOf("\nratesRouter.", at + 10)); })();

const KYIV = { lat: 50.45003, lon: 30.52414 }, LVIV = { lat: 49.84195, lon: 24.03159 }, IZMAIL = { lat: 45.35113, lon: 28.83615 };
/** Однойменна «Одеса» в США — той самий випадок, що лежить у журналі маршрутів (14.10.2026). */
const ODESSA_US = { lat: 45.25969, lon: -96.32894 };
const leg = (km: number, moldovaKm = 0): OrsResult => ({ ok: true, leg: { km, minutes: km, moldovaKm, line: [[1, 1], [2, 2]] } });

/** Підмінені мережа й база: відповіді сервісу — чергою за типом запиту; лічильники — щоб бачити, хто кого кликав. */
function fakeDeps(answers: { main?: OrsResult; avoid?: OrsResult; via?: OrsResult }) {
  const store = new Map<string, CachedRoute>();
  const calls: string[] = [];
  const k = (key: RouteKey) => JSON.stringify(key);
  const deps: RouteDeps = {
    async route(points: LatLng[], opts) {
      const kind = points.length === 3 ? "via" : opts?.avoidMoldova ? "avoid" : "main";
      calls.push(kind);
      return answers[kind] ?? { ok: false, reason: "no_route" };
    },
    async cacheGet(key) { return store.get(k(key)) ?? null; },
    async cachePut(key, v) { store.set(k(key), v); },
  };
  return { deps, calls, store };
}

test("#2780 КМ — ЛИШЕ З МАРШРУТУ: медіана відстаней Lardi на км не впливає, ставка — на км обраного варіанта", () => {
  assert.doesNotMatch(ANALYZE, /median_distance|realDist/, "🔴 км знову підміняються медіаною відстаней із пропозицій Lardi");
  assert.match(ANALYZE, /const routeKm: number \| null = chosen\?\.distance_km \?\? null;/, "🔴 км розрахунку беруться не з обраного маршруту");
  assert.match(ANALYZE, /result\.zone_recommendation = chosen \? chosen\.zone_recommendation :/, "🔴 зонна ставка рахується не на км обраного варіанта");
  assert.match(ANALYZE, /const resolved = await resolveRoutes\(routeDeps\(\), frm, to\);/, "🔴 розрахунок не питає маршрут по дорогах");
});

test("#2781 МАРШРУТ ПИТАЄМО РАЗ: другий розрахунок тієї ж пари — з кешу; «приблизний» не кешується", async () => {
  const ok = fakeDeps({ main: leg(542) });
  const first = await resolveRoutes(ok.deps, KYIV, LVIV);
  const second = await resolveRoutes(ok.deps, KYIV, LVIV);
  assert.deepEqual(ok.calls, ["main"], "🔴 сервіс маршрутів кликали вдруге для тієї ж пари — кеш не працює");
  assert.equal(first[0].km, 542); assert.equal(second[0].km, 542, "🔴 з кешу прийшли інші км");
  assert.equal(second[0].source, "road");
  const down = fakeDeps({ main: { ok: false, reason: "quota" } });
  await resolveRoutes(down.deps, KYIV, LVIV);
  await resolveRoutes(down.deps, KYIV, LVIV);
  assert.equal(down.store.size, 0, "🔴 приблизну відстань записано в кеш — вона жила б там вічно");
  assert.deepEqual(down.calls, ["main", "main"], "🔴 після збою наступний розрахунок не пробує сервіс знову");
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS road_routes \([\s\S]*?PRIMARY KEY \(from_lat, from_lon, to_lat, to_lon, variant\)/, "🔴 немає таблиці маршрутів із ключем пари й варіанта");
});

test("#2782 ЗБІЙ СЕРВІСУ — НЕ ПАДІННЯ: будь-яка відмова дає «приблизно» (пряма × 1,25) з причиною", async () => {
  for (const reason of ["quota", "timeout", "denied", "no_key", "network", "http_500"] as const) {
    const { deps } = fakeDeps({ main: { ok: false, reason } });
    const r = await resolveRoutes(deps, KYIV, LVIV);
    assert.equal(r.length, 1, `🔴 ${reason}: варіантів не один`);
    assert.equal(r[0].source, "approx", `🔴 ${reason}: приблизні км показано як «по дорогах»`);
    assert.equal(r[0].failure, reason);
    assert.ok(r[0].km >= 580 && r[0].km <= 590, `🔴 ${reason}: пряма × 1,25 Київ–Львів має бути ~586, а не ${String(r[0].km)}`);
  }
  // Сервіс: відповіді → причини (форма відповідей заміряна 29.10.2026 живими запитами).
  assert.equal(failureOf(403, '{"error":"Quota exceeded"}'), "quota");
  assert.equal(failureOf(429, ""), "quota");
  assert.equal(failureOf(403, '{"error":"Access to this API has been disallowed"}'), "denied");
  assert.equal(failureOf(404, '{"error":{"code":2009,"message":"Route could not be found"}}'), "no_route");
  assert.equal(failureOf(500, "oops"), "http_500");
  const noKey = await orsRoute({ fetch: (() => { throw new Error("🔴 без ключа сервіс не кличемо"); }) as unknown as typeof fetch, key: "" }, [[1, 1], [2, 2]]);
  assert.deepEqual(noKey, { ok: false, reason: "no_key" });
  const slow = await orsRoute({ key: "k", timeoutMs: 20, fetch: ((_: unknown, init: RequestInit) => new Promise((_r, rej) => {
    init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })) as unknown as typeof fetch }, [[1, 1], [2, 2]]);
  assert.deepEqual(slow, { ok: false, reason: "timeout" }, "🔴 зависання сервісу не обривається таймаутом");
});

test("#2783 МОЛДОВА: довше 30 км Молдовою — варіант «через Україну»; рівно 30 — ні; без дороги в обхід — через Одесу", async () => {
  assert.equal(MOLDOVA_DETOUR_KM, 30, "🔴 поріг змінено без рішення (Роман 29.10.2026: 30 км)");
  const over = fakeDeps({ main: leg(683, 31), avoid: leg(791, 0) });
  const r1 = await resolveRoutes(over.deps, IZMAIL, LVIV);
  assert.deepEqual(r1.map((x) => x.id), ["main", "ua"], "🔴 31 км Молдовою — а варіанта через Україну немає");
  assert.equal(r1[1].via, null, "🔴 сервіс оминув Молдову сам — проміжна точка не потрібна");
  const edge = fakeDeps({ main: leg(683, 30), avoid: leg(791, 0) });
  assert.deepEqual((await resolveRoutes(edge.deps, IZMAIL, LVIV)).map((x) => x.id), ["main"], "🔴 короткий транзит (≤30 км) отримав зайвий варіант");
  assert.deepEqual(edge.calls, ["main"], "🔴 на короткому транзиті сервіс питали про об'їзд — витрачено ліміт");
  const budjak = fakeDeps({ main: leg(599, 402), avoid: { ok: false, reason: "no_route" }, via: leg(792, 8) });
  const r3 = await resolveRoutes(budjak.deps, IZMAIL, LVIV);
  assert.deepEqual(budjak.calls, ["main", "avoid", "via"], "🔴 без дороги в обхід Молдови не спробували через Одесу");
  assert.equal(r3[1].via?.name, UA_DETOUR_VIA.name);
  const out = toVariants(r3, { fromArea: "Одеська обл.", toArea: "Львівська обл.", mass: 20 }, null);
  assert.deepEqual(out.map((v) => v.label), ["Найкоротший", "Через Україну · через Одесу"]);
  assert.notEqual(out[0].zone_recommendation?.client_min, out[1].zone_recommendation?.client_min, "🔴 у варіантів одна ставка — км варіанта не враховано");
  assert.equal(ORS_MOLDOVA, 129, "🔴 код Молдови в сервісі маршрутів не той (заміряно 29.10.2026: 129)");
});

test("#2784 РУЧНІ КМ: 1…5 000 перераховують ставку лише обраного варіанта; 0, −5, 5 001, «abc» — 400", async () => {
  assert.equal(parseKmOverride(" 1 200 "), 1200); assert.equal(parseKmOverride("850"), 850);
  assert.equal(parseKmOverride("1"), 1); assert.equal(parseKmOverride(5000), 5000);
  assert.equal(parseKmOverride(""), null); assert.equal(parseKmOverride(undefined), null);
  for (const bad of ["0", -5, 5001, 99999, "abc"]) {
    assert.throws(() => parseKmOverride(bad), (e) => e instanceof RouteInputError && e.status === 400, `🔴 прийнято ${String(bad)} км`);
  }
  assert.equal(parseVariant(undefined, 2), 0); assert.equal(parseVariant("1", 2), 1);
  assert.throws(() => parseVariant(2, 2), (e) => e instanceof RouteInputError && e.status === 400, "🔴 прийнято неіснуючий варіант");
  const { deps } = fakeDeps({ main: leg(599, 402), avoid: leg(792, 8) });
  const routes = await resolveRoutes(deps, IZMAIL, LVIV);
  const ctx = { fromArea: "Одеська обл.", toArea: "Львівська обл.", mass: 20 };
  const plain = toVariants(routes, ctx, null), edited = toVariants(routes, ctx, { variant: 1, km: 850 });
  assert.deepEqual([edited[1].distance_km, edited[1].road_km, edited[1].source, edited[1].minutes], [850, 792, "manual", null], "🔴 ручні км не стали км варіанта");
  assert.notEqual(edited[1].zone_recommendation?.client_min, plain[1].zone_recommendation?.client_min, "🔴 ручні км не перерахували ставку");
  assert.deepEqual(edited[0], plain[0], "🔴 ручні км зачепили не той варіант");
});

test("#2785 ЧУЖА КРАЇНА: місто поза Європою — без сервісу й з позначкою; Київ–Львів — у сервіс", async () => {
  const bad = fakeDeps({ main: leg(8200) });
  const r = await resolveRoutes(bad.deps, KYIV, ODESSA_US);
  assert.deepEqual(bad.calls, [], "🔴 маршрут до «Одеси» в США пішов у сервіс маршрутів");
  assert.deepEqual([r[0].source, r[0].failure], ["approx", "outside_area"], "🔴 хибно обране місто не позначено");
  const good = fakeDeps({ main: leg(542) });
  assert.equal((await resolveRoutes(good.deps, KYIV, LVIV))[0].source, "road", "🔴 захист відсік і звичайний маршрут");
  assert.match(SCREEN, /rv\.failure === "outside_area"/, "🔴 екран не пояснює, що обрано, схоже, не те місто");
});

test("#2786 КЛЮЧ СЕРВІСУ — ЛИШЕ В ЗАГОЛОВКУ: ні в адресі, ні в причині відмови", async () => {
  const KEY = "SECRET-ORS-KEY-123";
  let url = "", auth = "";
  const res = await orsRoute({ key: KEY, fetch: (async (u: string, init: RequestInit) => {
    url = String(u); auth = String((init.headers as Record<string, string>).Authorization);
    return new Response(`{"error":"Quota exceeded for ${KEY}"}`, { status: 403 });
  }) as unknown as typeof fetch }, [[50, 30], [49, 24]]);
  assert.equal(auth, KEY, "🔴 ключ не в заголовку — сервіс відмовить");
  assert.ok(!url.includes(KEY), "🔴 ключ у адресі запиту — потрапить у логи проксі");
  assert.ok(!JSON.stringify(res).includes(KEY), "🔴 ключ просочився в причину відмови (а вона йде в лог і у відповідь)");
  assert.equal([...RATES.matchAll(/config\.ors\.key/g)].length, 1, "🔴 ключ сервісу вживається в routes/rates.ts ще десь, крім запиту");
});

test("#2787 ЗНІМОК ДЛЯ ВІДГУКУ знає джерело км і варіант; перерахунок — лише свого розрахунку того самого маршруту", () => {
  const zone = { zone: "green", options: [{ tonnage: "20 т (фура)", selected: true, client_min: 1, client_max: 2, total_min: 1, total_max: 1, margin: 5000, per_km_min: 70, per_km_max: 75 }] };
  const s = snapshotOf({ mass_min: 18, mass_max: 22, body_type_ids: [] }, 850, zone, { distance_source: "manual", route_variant: "ua", road_km: 792, moldova_km: 8 });
  assert.deepEqual([s.distance_km, s.distance_source, s.route_variant, s.road_km, s.moldova_km], [850, "manual", "ua", 792, 8], "🔴 знімок не знає, звідки км");
  assert.equal([...ANALYZE.matchAll(/routeInfo\(chosen\)\)/g)].length, 2, "🔴 знімок без маршрутної частини (і в розрахунку, і в перерахунку)");
  assert.match(ANALYZE, /SELECT frm, tox FROM lardi_usage WHERE id = \$1 AND user_id = \$2`, \[usageId, req\.auth!\.userId\]/, "🔴 перерахувати можна чужий розрахунок");
  assert.match(ANALYZE, /return res\.status\(409\)/, "🔴 перерахунок іншого маршруту під старим номером не відхиляється");
  assert.match(ANALYZE, /UPDATE lardi_usage SET calc = \$2 WHERE id = \$1 AND user_id = \$3/, "🔴 перерахунок не оновлює знімок свого розрахунку");
});

test("#2788 ЕКРАН: мапа в основному бандлі, відстань виправляється, правка км не закриває відгук", () => {
  assert.match(MAP, /^import \* as L from "\.\.\/\.\.\/\.\.\/vendor\/leaflet\/leaflet-src\.esm\.js";$/m, "🔴 мапа не з vendor — стенд не має npm-пакета");
  assert.doesNotMatch(MAP + SCREEN, /\blazy\(\s*\(\)\s*=>|import\(\s*["'][^"']*(RouteMap|leaflet)/, "🔴 мапа ліниво — другий JS-чанк (#225)");
  assert.match(MAP, /© OpenStreetMap/, "🔴 плитки OpenStreetMap без підпису — порушення умов");
  assert.match(SCREEN, /aria-label="Змінити км"/, "🔴 відстань не можна виправити");
  assert.match(SCREEN, /const recalcKm = \(km: number \| null\) => reprice\(vIdx, km\);/, "🔴 ручні км не йдуть на сервер — ставка рахувалась би в браузері");
  assert.match(SCREEN, /\}, \[runId\]\); \/\/ eslint-disable-line react-hooks\/exhaustive-deps/, "🔴 відгук перезапускається від правки км");
  assert.doesNotMatch(SCREEN, /label="Через"/, "🔴 поле «Через» повернулось (Роман 29.10.2026: прибрати)");
  assert.doesNotMatch(SCREEN, /По дорогах/, "🔴 повернувся підпис «По дорогах» (Роман 29.10.2026: прибрати)");
});
