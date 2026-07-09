import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { lardiGet, lardiPost, LANG, hasLardiToken } from "../lardi/client.js";
import { recordRoute, recordOffers, recordUsage, history, usageStats } from "../lardi/history.js";

// «Калькулятор ставок» — точний порт Python-сервісу lardiweb у наш бекенд
// (прод — shared cPanel без Python 3.10+). Формат відповіді збережено 1:1 з
// оригіналом (snake_case), щоб фронтова логіка була дзеркалом оригінальної.
export const ratesRouter = Router();
ratesRouter.use(requireAuth);

const UAH_NAMES = new Set(["грн.", "грн", "uah", "₴"]);
const ROAD_FACTOR = 1.25; // повітряна відстань → дорожня
const MIN_TOWN_RESULTS = 6; // менше по місту → розширюємо до області
const FULL_TON_THRESHOLD = 18; // ≥ — «ціла машина», нижче — догруз

type Any = Record<string, unknown>;
const asObj = (v: unknown): Any => (v && typeof v === "object" ? (v as Any) : {});
const asArr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);

function num(x: unknown): number | null {
  const v = typeof x === "number" ? x : Number(x);
  return Number.isFinite(v) && v > 0 ? v : null;
}
function first(d: Any, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = d[k];
    if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) return v;
  }
  return undefined;
}
export function haversineKm(lat1: unknown, lon1: unknown, lat2: unknown, lon2: unknown): number | null {
  const a = Number(lat1), b = Number(lon1), c = Number(lat2), d = Number(lon2);
  if (![a, b, c, d].every(Number.isFinite) || (a === 0 && b === 0)) return null;
  const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
  const dphi = rad(c - a), dl = rad(d - b);
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function summarize(nums: (number | null)[]) {
  const xs = nums.filter((n): n is number => !!n && n > 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return {
    n: xs.length,
    min: Math.round(xs[0]),
    median: Math.round(median),
    avg: Math.round(xs.reduce((s, v) => s + v, 0) / xs.length),
    max: Math.round(xs[xs.length - 1]),
  };
}
function waypoint(it: Any, key: string): string | null {
  const lst = asArr(it[key]);
  if (!lst.length) return null;
  const p = asObj(lst[0]);
  return ((asObj(p.town).name as string) || (asObj(p.area).name as string)) ?? null;
}
const company = (it: Any) => (asObj(it.owner).name as string) || "";
const face = (it: Any) => String((asObj(it.owner).face as string) || "").trim();
function phones(it: Any): { n: string; m: unknown[] }[] {
  const out: { n: string; m: unknown[] }[] = [];
  for (const p of asArr(asObj(it.owner).phones)) {
    const n = String(p.number || "").trim();
    if (n) out.push({ n, m: asArr(p.messengers) });
  }
  return out;
}
function payform(it: Any): string {
  const pf = asArr(it.paymentForms);
  if (!pf.length) return "";
  const p0 = asObj(pf[0]);
  let name = String((asObj(p0.type).name as string) || "").trim();
  if (p0.vat === true) name = (name + " з ПДВ").trim();
  else if (p0.vat === false && name) name = name + " без ПДВ";
  return name;
}
const offerDistanceKm = (it: Any): number | null => {
  const dl = num(it.distanceLine); // метри
  return dl ? dl / 1000 : null;
};

function classifyPayment(it: Any, routeKm: number | null) {
  const pay = asObj(it.payment);
  const val = num(pay.value);
  const cur = String((first(asObj(pay.currency), "name") as string) || "").trim();
  const isUah = UAH_NAMES.has(cur.toLowerCase());
  const unit = String((asObj(pay.unit).name as string) || "").toLowerCase();
  const mass = num(asObj(it.size).mass);
  const dist = offerDistanceKm(it) ?? routeKm;

  let total: number | null = null, perKm: number | null = null, perTon: number | null = null;
  if (val) {
    if (unit.includes("км")) { perKm = Math.round(val); total = dist ? Math.round(val * dist) : null; }
    else if (unit.includes("тон")) { perTon = Math.round(val); total = mass ? Math.round(val * mass) : null; }
    else total = Math.round(val);
    if (total && mass && !perTon) perTon = Math.round(total / mass);
    if (total && dist && !perKm) perKm = Math.round(total / dist);
  }
  return { total, perKm, perTon, currency: cur, isUah, negotiable: !val, mass };
}
const loadType = (mass: number | null) => (!mass ? "unknown" : mass >= FULL_TON_THRESHOLD ? "full" : "part");

export function toOffer(it: Any, routeKm: number | null) {
  const p = classifyPayment(it, routeKm);
  const bodies = asArr(it.cargoBodyTypes).map((b) => b.name).filter(Boolean) as string[];
  const dist = offerDistanceKm(it);
  return {
    id: it.id as number,
    cargo: (asObj(it.content).name as string) || "—",
    mass: p.mass,
    load_type: loadType(p.mass),
    total: p.total,
    per_ton: p.isUah ? p.perTon : null,
    per_km: p.isUah ? p.perKm : null,
    is_uah: p.isUah,
    currency: p.currency || (p.negotiable ? "договірна" : "?"),
    negotiable: p.negotiable,
    bodies,
    company: company(it),
    face: face(it),
    phones: phones(it),
    payform: payform(it),
    from: waypoint(it, "waypointListSource"),
    to: waypoint(it, "waypointListTarget"),
    dist_km: dist ? Math.round(dist) : null,
    date: String((first(it, "dateFrom", "date") as string) || "").slice(0, 10),
    note: String(it.note || "").trim().slice(0, 160),
  };
}
type Offer = ReturnType<typeof toOffer>;

function statsFrom(offs: Offer[]) {
  const other: Record<string, number[]> = {};
  for (const o of offs) if (o.total && !o.is_uah) (other[o.currency || "?"] ??= []).push(o.total);
  const dists = offs.map((o) => o.dist_km).filter((n): n is number => !!n).sort((a, b) => a - b);
  const medDist = dists.length ? Math.round(dists[Math.floor(dists.length / 2)]) : null;
  return {
    count: offs.length,
    negotiable: offs.filter((o) => o.negotiable).length,
    uah: summarize(offs.filter((o) => o.is_uah).map((o) => o.total)),
    uah_per_ton: summarize(offs.filter((o) => o.is_uah).map((o) => o.per_ton)),
    uah_per_km: summarize(offs.filter((o) => o.is_uah).map((o) => o.per_km)),
    other_currencies: Object.fromEntries(
      Object.entries(other).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, summarize(v)])
    ),
    median_distance: medDist,
  };
}

export function parseOffers(content: Any[], routeKm: number | null) {
  const cargoNames: Record<string, number> = {};
  const bodyTypes: Record<string, number> = {};
  const offers = content.map((it) => {
    const o = toOffer(it, routeKm);
    cargoNames[o.cargo] = (cargoNames[o.cargo] ?? 0) + 1;
    for (const b of o.bodies) bodyTypes[b] = (bodyTypes[b] ?? 0) + 1;
    return o;
  });
  const full = offers.filter((o) => o.load_type === "full");
  const part = offers.filter((o) => o.load_type === "part");
  const topN = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    count: offers.length,
    classes: { all: statsFrom(offers), full: statsFrom(full), part: statsFrom(part) },
    class_counts: { full: full.length, part: part.length, unknown: offers.filter((o) => o.load_type === "unknown").length },
    top_cargo: topN(cargoNames),
    top_body: topN(bodyTypes),
    offers,
  };
}

// ── Lardi search ──
function direction(townId?: number | null, areaId?: number | null) {
  const row: Any = {};
  if (townId) row.townId = townId;
  else if (areaId) row.areaId = areaId;
  return { directionRows: [row] };
}
interface Point { town_id: number; area_id?: number | null; lat?: number | null; lon?: number | null; label?: string }
interface AnalyzeBody { frm: Point; to: Point; mass_min?: number | null; mass_max?: number | null; body_type_ids?: number[]; page_size?: number }

function buildFilter(req: AnalyzeBody, useArea: boolean): Any {
  const f: Any = {
    directionFrom: direction(useArea ? null : req.frm.town_id, useArea ? req.frm.area_id : null),
    directionTo: direction(useArea ? null : req.to.town_id, useArea ? req.to.area_id : null),
  };
  if (req.mass_min) f.mass1 = req.mass_min;
  if (req.mass_max) f.mass2 = req.mass_max;
  if (req.body_type_ids?.length) f.bodyTypeIds = req.body_type_ids;
  return f;
}
export async function lardiSearch(path: string, req: AnalyzeBody, useArea: boolean): Promise<{ code: number; content: Any[] | null; detail: string }> {
  const body = {
    filter: buildFilter(req, useArea),
    options: { pageNumber: 1, pageSize: Math.max(10, Math.min(req.page_size ?? 100, 200)) },
  };
  const r = await lardiPost(`${path}?language=${LANG}`, body);
  if (r.status !== 200) return { code: r.status, content: null, detail: (await r.text().catch(() => "")).slice(0, 300) };
  const j = await r.json().catch(() => null);
  if (j === null) return { code: 200, content: null, detail: "bad JSON" };
  return { code: 200, content: asArr(asObj(j).content), detail: "" };
}

// ── Зонна карта України (рекомендована ставка, коли в Ларді порожньо) ──────
// Зона маршруту = зона області ВІДПРАВЛЕННЯ (правило КВП: веземо з зеленої в
// червону → діапазон зеленої). Тарифи грн/км — з карти КВП (липень 2026).
// Помаранчеві області карти (Закарпаття/Прикарпаття/Буковина) → жовтий тариф;
// окуповані (Луганська/Донецька/Крим) зони не мають → фолбек на зону призначення.
type Zone = "green" | "yellow" | "red";
const ZONE_LABEL: Record<Zone, string> = { green: "🟢 зелена", yellow: "🟡 жовта", red: "🔴 червона" };
const AREA_ZONES: [RegExp, Zone][] = [
  [/волин/i, "green"], [/рівн|ровен/i, "green"], [/львів|львов/i, "green"],
  [/терноп/i, "green"], [/хмельни/i, "green"], [/вінни|винни/i, "green"],
  [/житомир/i, "green"], [/київ|киев/i, "green"],
  [/закарпат/i, "yellow"], [/франків|франков/i, "yellow"], [/чернівец|черновиц/i, "yellow"],
  [/одес/i, "yellow"], [/полтав/i, "yellow"], [/миколаїв|николаев/i, "yellow"],
  [/черніг|черниг/i, "red"], [/сумс|суми/i, "red"], [/харків|харьков/i, "red"],
  [/черкас/i, "red"], [/кіровоград|кировоград|кропивни/i, "red"],
  [/дніпр|днепр/i, "red"], [/запор/i, "red"], [/херсон/i, "red"],
];
const ZONE_RATES: { maxMass: number; label: string; rates: Record<Zone, [number, number]> }[] = [
  { maxMass: 2.5, label: "до 2,5 т", rates: { green: [25, 25], yellow: [30, 30], red: [35, 35] } },
  { maxMass: 5, label: "до 5 т", rates: { green: [30, 35], yellow: [35, 40], red: [40, 50] } },
  { maxMass: 10, label: "до 10 т", rates: { green: [38, 45], yellow: [45, 55], red: [55, 60] } },
  { maxMass: Infinity, label: "20 т (фура)", rates: { green: [55, 67], yellow: [67, 73], red: [73, 85] } },
];
function zoneOfArea(area: string | null | undefined): Zone | null {
  if (!area) return null;
  for (const [re, z] of AREA_ZONES) if (re.test(area)) return z;
  return null;
}
function zoneRecommendation(frmArea: string | null, toArea: string | null, mass: number | null, routeKm: number | null) {
  const zoneFrom = zoneOfArea(frmArea);
  const zoneTo = zoneOfArea(toArea);
  const zone = zoneFrom ?? zoneTo;
  if (!zone) return null;
  const bracket = ZONE_RATES.find((b) => (mass ?? 20) <= b.maxMass)!;
  const [lo, hi] = bracket.rates[zone];
  return {
    zone,
    zone_label: ZONE_LABEL[zone],
    zone_src: zoneFrom ? "за областю відправлення" : "за областю призначення (відправлення не розпізнано)",
    from_area: frmArea, to_area: toArea,
    tonnage: bracket.label,
    per_km_min: lo, per_km_max: hi,
    total_min: routeKm ? Math.round(lo * routeKm) : null,
    total_max: routeKm ? Math.round(hi * routeKm) : null,
    distance_km: routeKm,
  };
}

function recommend(cargo: Any | null, lorry: Any | null, routeKm: number | null) {
  const cls = (x: Any | null) => asObj(asObj(x?.classes).all);
  const rec: Any = { distance_km: routeKm };
  const c = asObj(cls(cargo).uah), l = asObj(cls(lorry).uah);
  if (c.median) rec.cargo_median = c.median;
  if (l.median) rec.lorry_median = l.median;
  const meds = [rec.cargo_median, rec.lorry_median].filter((m): m is number => typeof m === "number");
  if (meds.length) { rec.band_low = Math.min(...meds); rec.band_high = Math.max(...meds); }
  const pkC = asObj(cls(cargo).uah_per_km), pkL = asObj(cls(lorry).uah_per_km);
  const perKm = (pkC.median ?? pkL.median) as number | undefined;
  if (perKm) {
    rec.per_km = perKm;
    rec.per_km_src = pkC.median ? "заказчики" : "перевозчики";
    if (routeKm) rec.per_km_total = Math.round(perKm * routeKm);
  }
  return rec;
}

// ── endpoints (шляхи і формат — як в оригіналі) ──
ratesRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "lardiweb", version: "0.3.0-node", has_token: hasLardiToken() });
});

let areasCache: Record<number, string> | null = null;
async function areasMap(): Promise<Record<number, string>> {
  if (areasCache) return areasCache;
  const m: Record<number, string> = {};
  try {
    const r = await lardiGet("/v2/references/areas", { language: LANG });
    if (r.status === 200) for (const a of asArr(await r.json())) if (a.id && a.name) m[Number(a.id)] = String(a.name);
  } catch { /* ignore */ }
  areasCache = m;
  return m;
}

ratesRouter.get("/towns", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json([]);
  if (!hasLardiToken()) return res.status(503).json({ error: "LARDI_API_TOKEN не заданий на сервері" });
  try {
    const r = await lardiGet("/v2/references/towns", { query: q, language: LANG });
    if (r.status !== 200) return res.status(502).json({ error: `Lardi towns ${r.status}` });
    const data = asArr(await r.json());
    const areas = await areasMap();
    const out = data.map((t) => {
      const areaId = first(t, "areaId", "regionId") as number | undefined;
      return {
        id: t.id,
        name: t.name,
        country: first(t, "countrySign", "country") ?? null,
        area: (first(t, "areaName", "regionName") as string) || (areaId ? areas[areaId] : "") || "",
        area_id: areaId ?? null,
        lat: first(t, "latitude", "lat") ?? null,
        lon: first(t, "longitude", "lon", "lng") ?? null,
      };
    });
    out.sort((a, b) => (a.country === "UA" ? 0 : 1) - (b.country === "UA" ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
    res.json(out.slice(0, 30));
  } catch (e) {
    res.status(502).json({ error: "Lardi towns недоступний", detail: String(e).slice(0, 120) });
  }
});

const BODY_CANDIDATES = [
  "/v2/references/cargo/body/types",
  "/v2/references/transports/body/types",
  "/v2/references/body/types",
  "/v2/references/bodyTypes",
];
let bodyCache: { id: number; name: string }[] | null = null;
ratesRouter.get("/bodytypes", async (_req, res) => {
  if (bodyCache) return res.json(bodyCache);
  if (!hasLardiToken()) return res.json([]);
  for (const path of BODY_CANDIDATES) {
    try {
      const r = await lardiGet(path, { language: LANG });
      if (r.status !== 200) continue;
      const data = asArr(await r.json());
      if (data.length) {
        bodyCache = data.filter((x) => x.id && x.name).map((x) => ({ id: Number(x.id), name: String(x.name) }));
        return res.json(bodyCache);
      }
    } catch { /* try next */ }
  }
  bodyCache = [];
  res.json(bodyCache);
});

ratesRouter.post("/analyze", async (req, res) => {
  if (!hasLardiToken()) return res.status(503).json({ error: "LARDI_API_TOKEN не заданий на сервері" });
  const b = req.body ?? {};
  const frm: Point | undefined = b.frm, to: Point | undefined = b.to;
  if (!frm?.town_id || !to?.town_id) return res.status(400).json({ error: "Оберіть міста звідки і куди" });
  const reqBody: AnalyzeBody = {
    frm, to,
    mass_min: num(b.mass_min), mass_max: num(b.mass_max),
    body_type_ids: Array.isArray(b.body_type_ids) ? b.body_type_ids.map(Number).filter(Boolean) : [],
    page_size: 100,
  };

  const hav = haversineKm(frm.lat, frm.lon, to.lat, to.lon);
  let routeKm = hav ? Math.round(hav * ROAD_FACTOR) : null;

  const result: Any = {
    route: { from: frm.label ?? "", to: to.label ?? "", distance_km: routeKm },
    filter_echo: { mass_min: reqBody.mass_min, mass_max: reqBody.mass_max, body_type_ids: reqBody.body_type_ids },
  };

  for (const [side, path] of [["cargo", "/v2/proposals/search/cargo"], ["lorry", "/v2/proposals/search/lorry"]] as const) {
    try {
      const r = await lardiSearch(path, reqBody, false);
      if (r.code !== 200 || r.content === null) { result[side] = { error: `Lardi ${r.code}`, detail: r.detail }; continue; }
      let content = r.content, scope = "town";
      const canArea = frm.area_id && to.area_id;
      if (content.length < MIN_TOWN_RESULTS && canArea) {
        const r2 = await lardiSearch(path, reqBody, true);
        if (r2.code === 200 && r2.content && r2.content.length) { content = r2.content; scope = "area"; }
      }
      result[side] = { ...parseOffers(content, routeKm), scope };
    } catch (e) {
      result[side] = { error: "Lardi недоступний", detail: String(e).slice(0, 120) };
    }
  }

  // Реальна відстань з пропозицій точніша за haversine.
  const md = (side: string) => asObj(asObj(asObj(result[side]).classes).all).median_distance as number | undefined;
  const realDist = md("cargo") || md("lorry");
  if (realDist) { routeKm = realDist; (result.route as Any).distance_km = realDist; }

  // Архів: маршрут + пропозиції; історія за 31 день у кожну сторону.
  try {
    await recordRoute(frm, to);
    const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    await recordUsage(req.auth!.userId, ip, frm.label ?? "", to.label ?? "");
    for (const side of ["cargo", "lorry"] as const) {
      const sd = result[side] as Any;
      if (sd && !sd.error) {
        await recordOffers(frm.town_id, to.town_id, side, sd.offers as Offer[]);
        sd.history = await history(frm.town_id, to.town_id, side);
      }
    }
  } catch (e) {
    console.warn("lardi history record failed:", e);
  }

  result.recommendation = recommend(result.cargo as Any, result.lorry as Any, routeKm);

  // Зонна рекомендація (карта КВП) — головний орієнтир, коли пропозицій у Ларді
  // немає. Назва області: з тіла запиту (фронт шле town.area) або з довідника за id.
  try {
    const areas = await areasMap();
    const areaOf = (p: Any): string | null =>
      (typeof p?.area === "string" && p.area) || (p?.area_id ? areas[Number(p.area_id)] ?? null : null);
    const massForZone = reqBody.mass_max ?? reqBody.mass_min ?? null;
    result.zone_recommendation = zoneRecommendation(areaOf(frm as unknown as Any), areaOf(to as unknown as Any), massForZone, routeKm);
  } catch { result.zone_recommendation = null; }

  res.json(result);
});

// Статистика використання (адмін) — аналог /api/stats оригіналу.
ratesRouter.get("/stats", async (req, res) => {
  if (req.auth!.role !== "admin") return res.status(403).json({ error: "Лише адміністратор" });
  const days = Math.max(1, Math.min(Number(req.query.days) || 30, 90));
  try {
    res.json(await usageStats(days));
  } catch (e) {
    res.status(500).json({ error: `stats error: ${String(e).slice(0, 120)}` });
  }
});

// ── «Ціни по місту» (заміна ТГ-скритника): ціни, вантажники, контакти ──
import { pool } from "../db/pool.js";

const CITY_CATEGORIES = new Set(["price", "loaders", "contact"]);
const cityKey = (s: string) => s.trim().toLowerCase().replace(/[’'`ʼ]/g, "").replace(/\s+/g, " ");

ratesRouter.get("/city-info", async (req, res) => {
  const q = cityKey(String(req.query.q ?? ""));
  const params: unknown[] = [];
  let where = "";
  if (q) { params.push(`%${q}%`); where = `WHERE e.city_key LIKE $1`; }
  const r = await pool.query(
    `SELECT e.id, e.city, e.category, e.title, e.phone, e.price, e.comment,
            e.author_user_id AS "authorUserId",
            COALESCE(m.name, u.email) AS "authorName",
            to_char(e.updated_at AT TIME ZONE 'Europe/Kyiv', 'DD.MM.YYYY') AS "updatedAt"
       FROM city_info e
       LEFT JOIN users u ON u.id = e.author_user_id
       LEFT JOIN managers m ON m.id = u.manager_id
      ${where}
      ORDER BY e.city_key, e.category, e.updated_at DESC
      LIMIT 500`,
    params
  );
  res.json({ entries: r.rows });
});

ratesRouter.post("/city-info", async (req, res) => {
  const b = req.body ?? {};
  const city = String(b.city ?? "").trim();
  const category = String(b.category ?? "");
  if (!city) return res.status(400).json({ error: "Вкажіть місто" });
  if (!CITY_CATEGORIES.has(category)) return res.status(400).json({ error: "Невірна категорія" });
  const val = (v: unknown) => { const s = String(v ?? "").trim(); return s ? s.slice(0, 300) : null; };
  const r = await pool.query<{ id: number }>(
    `INSERT INTO city_info (city, city_key, category, title, phone, price, comment, author_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [city, cityKey(city), category, val(b.title), val(b.phone), val(b.price), val(b.comment), req.auth!.userId]
  );
  res.status(201).json({ id: r.rows[0].id });
});

ratesRouter.delete("/city-info/:id", async (req, res) => {
  const id = Number(req.params.id);
  const auth = req.auth!;
  const chk = await pool.query<{ author_user_id: number | null }>(`SELECT author_user_id FROM city_info WHERE id = $1`, [id]);
  if (!chk.rows[0]) return res.status(404).json({ error: "Не знайдено" });
  // Видаляти може автор запису або тімлід/адмін.
  if (auth.role === "manager" && chk.rows[0].author_user_id !== auth.userId) {
    return res.status(403).json({ error: "Лише свої записи" });
  }
  await pool.query(`DELETE FROM city_info WHERE id = $1`, [id]);
  res.status(204).send();
});

// ── Перевізники з CRM: пошук по місту (згадка в назві/маршруті угоди) ──
ratesRouter.get("/carriers", async (req, res) => {
  const q = String(req.query.city ?? "").trim();
  if (q.length < 2) return res.json({ carriers: [], processed: 0 });
  const r = await pool.query(
    `SELECT phone, (array_agg(name ORDER BY deal_date DESC NULLS LAST))[1] AS name,
            COUNT(DISTINCT deal_kommo_id) AS trips,
            to_char(MAX(deal_date), 'DD.MM.YYYY') AS "lastTrip",
            (array_agg(DISTINCT deal_name)) [1:4] AS routes
       FROM carrier_trips
      WHERE phone IS NOT NULL AND deal_name ILIKE $1
      GROUP BY phone
      ORDER BY trips DESC, MAX(deal_date) DESC NULLS LAST
      LIMIT 100`,
    [`%${q}%`]
  );
  const done = await pool.query<{ n: string }>(`SELECT count(*) n FROM carrier_sync_done`);
  res.json({
    carriers: r.rows.map((x) => ({
      name: x.name, phone: x.phone, trips: Number(x.trips), lastTrip: x.lastTrip, routes: x.routes ?? [],
    })),
    processed: Number(done.rows[0]?.n ?? 0),
  });
});
