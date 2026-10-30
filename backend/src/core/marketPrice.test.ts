import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { marketQuote, priceView, marketIsMain, MIN_N, K_NEAREST, KM_EXPONENT, MARKET_MAIN_MIN_MASS, TARIFF_DIFF_FLAG_PCT, MARKET_SANITY_PCT, type MarketOffer } from "./marketPrice.js";
import { getMarketPool, invalidateMarketPool, POOL_TTL_MS, POOL_SQL } from "./marketCache.js";
import { nameKey, townRow } from "./townsGeo.js";
import { snapshotOf } from "./rateFeedback.js";
import { zoneRecommendation } from "./zoneRates.js";

/**
 * 📈 #2800–#2806 — РИНКОВА ЦІНА МАРШРУТУ зі схожих оголошень (прохід A; Роман 29–30.10.2026). Чисті: пул оголошень —
 * фікстура, база — підмінена, джерела читаються текстом. Жива проба (пул з `lardi_offers`, Київ→Житомир ≈ ринок) — у прийманні.
 */
const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const RATES = SRC("../../src/routes/rates.ts");
const SCHEMA = SRC("../db/schema.sql");
const HISTORY = SRC("../../src/lardi/history.ts");
const SCREEN = SRC("../../../frontend/src/pages/dashboard/sections/RatesSimple.tsx");

const KYIV = { lat: 50.45, lon: 30.52 }, ZHYT = { lat: 50.25, lon: 28.66 }, LVIV = { lat: 49.84, lon: 24.03 };
/** Оголошення Київ→Житомир (139 км): фура 15 000, догруз 1,5 т — 4 000; плюс «шум» далеко звідси (Львів) і чужа вага. */
const offer = (from: { lat: number; lon: number }, to: { lat: number; lon: number }, mass: number, km: number, total: number): MarketOffer =>
  ({ flat: from.lat, flon: from.lon, tlat: to.lat, tlon: to.lon, mass, km, total });
const POOL: MarketOffer[] = [
  ...[14000, 15000, 15500, 14500, 16000, 15000, 13500].map((t) => offer(KYIV, ZHYT, 20, 139, t)),
  ...[3800, 4000, 4200, 4100, 3900].map((t) => offer(KYIV, ZHYT, 1.5, 139, t)),
  ...[35000, 36000, 37000, 34000, 35500].map((t) => offer(KYIV, LVIV, 20, 540, t)),
  offer(KYIV, ZHYT, 20, 139, 150000), // помилка введення — далеко за чвертями, медіана не рухається
];

test("#2800 СХОЖІ ОГОЛОШЕННЯ: ≥5 поруч → медіана, перерахована на наші км; 4 — немає ціни; чужі міста й вага не рахуються", () => {
  const fura = marketQuote(POOL, { from: KYIV, to: ZHYT, mass: 22, km: 139 });
  assert.ok(fura, "🔴 Київ→Житомир фура: ринкової ціни немає, хоч схожих 8");
  assert.equal(fura.n, 8, "🔴 взято не ті оголошення: Львів або догруз потрапили у «схожі» до фури");
  assert.equal(fura.carrier_median, 15000, "🔴 медіана не 15 000 — помилкове 150 000 зрушило ціну або схожі взяті не ті");
  assert.ok(fura.carrier_p25 >= 14000 && fura.carrier_p75 <= 16000, `🔴 діапазон ${String(fura.carrier_p25)}–${String(fura.carrier_p75)} не між чвертями`);
  const bus = marketQuote(POOL, { from: KYIV, to: ZHYT, mass: 1.5, km: 139 })!;
  assert.ok(bus.carrier_median < fura.carrier_median, "🔴 фура дешевша за 1,5 т на тому ж маршруті — вага не враховується");
  // Перерахунок на км: той самий маршрут, але 200 км замість 139 → ціна × (200/139)^0,7, а не × 1 і не × 1,44.
  const longer = marketQuote(POOL, { from: KYIV, to: ZHYT, mass: 22, km: 200 })!;
  assert.equal(longer.carrier_median, Math.round(15000 * Math.pow(200 / 139, KM_EXPONENT)), "🔴 ціна не перерахована на наші км");
  assert.ok(longer.carrier_median > 15000 && longer.carrier_median < 15000 * (200 / 139), "🔴 200 км коштує як 139 або лінійно як 500");
  // Замало: 4 схожих — немає ціни (тариф із позначкою), не ціна з двох.
  assert.equal(marketQuote(POOL.filter((o) => !(o.mass === 20 && o.km === 139)).concat(POOL.filter((o) => o.mass === 20 && o.km === 139).slice(0, MIN_N - 1)),
    { from: KYIV, to: ZHYT, mass: 22, km: 139 }), null, "🔴 ринкова ціна з 4 оголошень");
  assert.equal(marketQuote(POOL, { from: LVIV, to: { lat: 46.48, lon: 30.73 }, mass: 22, km: 790 }), null, "🔴 Львів→Одеса отримав ціну з київських оголошень");
  assert.ok(K_NEAREST >= 10 && MIN_N === 5, "🔴 K або мінімум змінено без досліду (K=15, min=5 — замір 30.10.2026)");
});

test("#2801 ЩО ПОКАЗУЄМО: ринок — головний для авто > 5 т; до 5 т і «замало» — тариф із причиною; клієнту = перевізнику + маржа", () => {
  const zone = zoneRecommendation("Київська обл.", "Житомирська обл.", 22, 139);
  const market = marketQuote(POOL, { from: KYIV, to: ZHYT, mass: 22, km: 139 });
  const p = priceView(zone, market, 22)!;
  assert.equal(p.source, "market", "🔴 для фури головним лишився тариф");
  assert.equal(p.client_min, p.carrier_min + p.margin, "🔴 клієнту ≠ перевізнику + маржа");
  assert.equal(p.margin, 5000, "🔴 маржа фури не 5 000 — маржу чіпати не домовлялись");
  assert.ok(p.tariff_diff_pct != null && p.tariff_diff_pct > TARIFF_DIFF_FLAG_PCT, `🔴 Київ→Житомир: ринок 15 000 проти тарифу ~10 000 мав дати > ${String(TARIFF_DIFF_FLAG_PCT)}%, дав ${String(p.tariff_diff_pct)}`);
  const light = priceView(zoneRecommendation("Київська обл.", "Житомирська обл.", 1.5, 139), marketQuote(POOL, { from: KYIV, to: ZHYT, mass: 1.5, km: 139 }), 1.5)!;
  assert.deepEqual([light.source, light.tariff_reason], ["tariff", "light_class"], "🔴 для 1,5 т головним став ринок догрузу (відкрите питання Романа 30.10 не вирішене)");
  const few = priceView(zone, null, 22)!;
  assert.deepEqual([few.source, few.tariff_reason, few.client_min], ["tariff", "few_offers", zone!.client_min], "🔴 без ринку не повернувся тариф із причиною «замало»");
  assert.equal(priceView(null, null, 22), null, "🔴 без тарифу й без ринку — вигадана ціна");
  // Запобіжник шуму: ринок 2,5× тарифу (живий випадок «до 10 т» Київ→Житомир, +148%) — тариф із причиною; 1,5× — ще ринок.
  const noisy = { ...market!, carrier_median: Math.round((zone!.total_min! + zone!.total_max!) / 2 * 2.5) };
  assert.deepEqual([priceView(zone, noisy, 22)!.source, priceView(zone, noisy, 22)!.tariff_reason], ["tariff", "market_outlier"], "🔴 ринок у 2,5 раза від тарифу став головним — шум рідких даних пішов менеджеру");
  const plausible = { ...market!, carrier_median: Math.round((zone!.total_min! + zone!.total_max!) / 2 * 1.5) };
  assert.equal(priceView(zone, plausible, 22)!.source, "market", "🔴 запобіжник відсік і справжню розбіжність у 1,5×");
  assert.equal(MARKET_SANITY_PCT, 60, "🔴 межа запобіжника змінена без заміру");
  assert.ok(marketIsMain(5.1) && !marketIsMain(5) && !marketIsMain(null) && MARKET_MAIN_MIN_MASS === 5, "🔴 межа «ринок головний» зрушила з 5 т");
});

test("#2802 ЗНІМОК ДЛЯ ВІДГУКУ: client_* — ПОКАЗАНА ставка, поруч тариф, джерело і ринок; без ціни — як раніше", () => {
  const zone = zoneRecommendation("Київська обл.", "Житомирська обл.", 22, 139)!;
  const market = marketQuote(POOL, { from: KYIV, to: ZHYT, mass: 22, km: 139 })!;
  const p = priceView(zone, market, 22)!;
  const s = snapshotOf({ mass_min: 18, mass_max: 22, body_type_ids: [] }, 139, zone, undefined, { ...p, market: { carrier_median: market.carrier_median, n: market.n } });
  assert.deepEqual([s.client_min, s.client_max, s.price_source, s.market_n, s.market_carrier_median], [p.client_min, p.client_max, "market", 8, 15000], "🔴 знімок зберіг не показану ставку");
  assert.deepEqual([s.tariff_client_min, s.tariff_client_max], [zone.client_min, zone.client_max], "🔴 тариф у знімку загублено — відгук не порівняти з ним");
  const old = snapshotOf({ mass_min: 18, mass_max: 22, body_type_ids: [] }, 139, zone);
  assert.deepEqual([old.client_min, old.price_source], [zone.client_min, null], "🔴 без ціни знімок більше не дорівнює тарифу");
  assert.equal([...RATES.matchAll(/priceInfo\(chosen\)/g)].length, 2, "🔴 знімок без показаної ставки (у розрахунку або перерахунку)");
});

test("#2803 СЛОВНИК МІСТ: ключ без регістру й апострофів; поза Європою — не беремо; схема: таблиця, координати оголошень, бекфіл лише порожніх", () => {
  assert.equal(nameKey("  Кам’янець-Подільський "), "камянець-подільський");
  assert.equal(nameKey("ОДЕСА"), nameKey("одеса"));
  assert.equal(townRow({ id: 1, name: "Odessa", lat: 45.25969, lon: -96.32894 }), null, "🔴 «Одеса» зі США потрапила у словник (журнал 14.10.2026)");
  assert.equal(townRow({ id: 7, name: "Одеса", lat: 46.48253, lon: 30.72331, area: "Одеська обл." })?.key, "одеса");
  assert.equal(townRow({ name: "Київ" }), null, "🔴 місто без координат у словнику");
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS towns_geo \([\s\S]*?lat NUMERIC\(8,5\) NOT NULL CHECK \(lat BETWEEN 34 AND 72\)/, "🔴 словник без межі Європи в схемі");
  for (const c of ["from_lat", "from_lon", "to_lat", "to_lon"]) assert.match(SCHEMA, new RegExp(`ALTER TABLE lardi_offers ADD COLUMN IF NOT EXISTS ${c} NUMERIC`), `🔴 немає колонки ${c}`);
  assert.match(SCHEMA, /UPDATE lardi_offers o SET from_lat = t\.lat, from_lon = t\.lon FROM towns_geo t\s+WHERE o\.from_lat IS NULL/, "🔴 бекфіл перетирає вже заповнені координати");
  assert.match(SCHEMA, /UPDATE lardi_offers o SET to_lat = t\.lat, to_lon = t\.lon FROM towns_geo t\s+WHERE o\.to_lat IS NULL/, "🔴 бекфіл «куди» не лише порожніх");
  assert.match(HISTORY, /UPDATE lardi_offers o SET from_lat = f\.lat, from_lon = f\.lon, to_lat = t\.lat, to_lon = t\.lon/, "🔴 нові оголошення пишуться без координат — пул не росте");
  assert.match(HISTORY, /nameKey\(o\.from\), nameKey\(o\.to\)/, "🔴 координати оголошення беруться не за ЙОГО містами");
  assert.match(RATES, /upsertTowns\(pool, out\.map\(townRow\)/, "🔴 відповіді /towns не поповнюють словник");
});

test("#2804 ПУЛ У ПАМʼЯТІ: читається раз на годину, лише оголошення замовників за 30 днів із координатами й здоровим грн/км", async () => {
  invalidateMarketPool();
  let reads = 0; let t = 0;
  const db = { query: async () => { reads++; return { rows: [{ flat: 50.45, flon: 30.52, tlat: 50.25, tlon: 28.66, mass: "20", km: "139", total: "15000" }] }; } };
  const a = await getMarketPool(db, () => t);
  t += POOL_TTL_MS - 1; await getMarketPool(db, () => t);
  assert.equal(reads, 1, "🔴 пул перечитується з бази на кожен розрахунок");
  t += 2; const b = await getMarketPool(db, () => t);
  assert.equal(reads, 2, "🔴 пул не оновлюється після години — ринок застиг");
  assert.deepEqual(a[0], { flat: 50.45, flon: 30.52, tlat: 50.25, tlon: 28.66, mass: 20, km: 139, total: 15000 }); assert.equal(b.length, 1);
  assert.match(POOL_SQL, /side = 'cargo' AND is_uah AND total > 0 AND mass > 0 AND dist_km >= 5/, "🔴 у пул ідуть не лише оголошення замовників у грн");
  assert.match(POOL_SQL, /from_lat IS NOT NULL AND to_lat IS NOT NULL/, "🔴 у пулі оголошення без координат");
  assert.match(POOL_SQL, /total \/ dist_km BETWEEN \$1 AND \$2/, "🔴 без санітарних меж грн/км — помилки введення в пулі");
  assert.match(POOL_SQL, /DISTINCT ON \(offer_id\)/, "🔴 те саме оголошення під кількома маршрутами рахується кілька разів");
  invalidateMarketPool();
});

test("#2805 РОЗРАХУНОК: ринкова ціна — на км КОЖНОГО варіанта, показана ставка і в розрахунку, і в перерахунку; ринок без маршруту не вигадується", () => {
  assert.match(RATES, /const variants = await priceVariants\(toVariants\(resolved, zoneCtx/, "🔴 варіанти маршруту без ринкової ціни");
  assert.match(RATES, /marketQuote\(marketPool, \{ from: \{ lat: frm\.lat, lon: frm\.lon \}, to: \{ lat: to\.lat, lon: to\.lon \}, mass: mass \?\? 20, km: v\.distance_km \}\)/, "🔴 ринок рахується не на км варіанта");
  assert.match(RATES, /result\.price = chosen\?\.price \?\? priceView\(result\.zone_recommendation as Parameters<typeof priceView>\[0\], null, zoneCtx\.mass\);/, "🔴 без маршруту (немає координат) не повернувся тариф");
  assert.match(RATES, /price: chosen\?\.price \?\? null, market_price: chosen\?\.market_price \?\? null,/, "🔴 перерахунок (ручні км / варіант) не віддає показану ставку");
  assert.match(RATES, /hasPoint\(frm\) && hasPoint\(to\) \? await getMarketPool\(pool\)/, "🔴 пул читається й тоді, коли координат немає");
});

test("#2806 ЕКРАН: головне число — з показаної ставки (ринок або тариф), поруч джерело, тариф і позначка розбіжності > 20%", () => {
  assert.match(SCREEN, /const price = rv\?\.price \?\? data\?\.price \?\? null;/, "🔴 екран бере ставку не з сервера");
  assert.match(SCREEN, /useCountUp\(price\?\.client_min, runId\), cMax = useCountUp\(price\?\.client_max, runId\)/, "🔴 головне число знову з зонної карти, а не з показаної ставки");
  assert.match(SCREEN, /const on = v === rv, o = v\.price;/, "🔴 картки варіантів показують тариф, а не ставку варіанта");
  assert.match(SCREEN, /data-price-source=\{price\.source\}/, "🔴 джерело ставки не показується");
  assert.match(SCREEN, /Ринкова ціна<\/b> — за \{market\?\.n \?\? "—"\} схожими оголошеннями/, "🔴 немає підпису «за N схожими оголошеннями»");
  assert.match(SCREEN, /Схожих оголошень на ринку замало/, "🔴 немає пояснення, чому тариф");
  assert.match(SCREEN, /const TARIFF_DIFF_FLAG_PCT = 20;/, "🔴 поріг позначки розбіжності на екрані не 20%");
  assert.match(SCREEN, /className=\{`rs-note \$\{diffFlag \? "warn" : "info"\}`\}/, "🔴 велика розбіжність ринку з тарифом не підсвічується");
});
