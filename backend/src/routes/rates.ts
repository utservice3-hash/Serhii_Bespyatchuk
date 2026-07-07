import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { lardiGet, lardiPost, LANG, hasLardiToken } from "../lardi/client.js";

// «Калькулятор ставок» — ринкові ставки по маршруту з Lardi-Trans. Порт логіки
// Python-сервісу lardiweb у наш Node-бекенд (той сервер не тягне Python 3.10+).
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
function haversineKm(lat1: unknown, lon1: unknown, lat2: unknown, lon2: unknown): number | null {
  const a = Number(lat1), b = Number(lon1), c = Number(lat2), d = Number(lon2);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
  const dphi = rad(c - a), dl = rad(d - b);
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function summarize(nums: (number | null)[]): { n: number; min: number; median: number; avg: number; max: number } | null {
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
  return (asObj(p.town).name as string) || (asObj(p.area).name as string) || null;
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
  const dl = num(it.distanceLine); // приходить у метрах
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

type Offer = ReturnType<typeof toOffer>;
function toOffer(it: Any, routeKm: number | null) {
  const p = classifyPayment(it, routeKm);
  const bodies = asArr(it.cargoBodyTypes).map((b) => b.name).filter(Boolean) as string[];
  const dist = offerDistanceKm(it);
  return {
    id: it.id,
    cargo: (asObj(it.content).name as string) || "—",
    mass: p.mass,
    loadType: loadType(p.mass),
    total: p.total,
    perTon: p.isUah ? p.perTon : null,
    perKm: p.isUah ? p.perKm : null,
    isUah: p.isUah,
    currency: p.currency || (p.negotiable ? "договірна" : "?"),
    negotiable: p.negotiable,
    bodies,
    company: company(it),
    face: face(it),
    phones: phones(it),
    payform: payform(it),
    from: waypoint(it, "waypointListSource"),
    to: waypoint(it, "waypointListTarget"),
    distKm: dist ? Math.round(dist) : null,
    date: String((first(it, "dateFrom", "date") as string) || "").slice(0, 10),
    note: String(it.note || "").trim().slice(0, 160),
  };
}

function statsFrom(offs: Offer[]) {
  const other: Record<string, number[]> = {};
  for (const o of offs) if (o.total && !o.isUah) (other[o.currency || "?"] ??= []).push(o.total);
  const dists = offs.map((o) => o.distKm).filter((n): n is number => !!n).sort((a, b) => a - b);
  const medDist = dists.length ? Math.round(dists[Math.floor(dists.length / 2)]) : null;
  return {
    count: offs.length,
    negotiable: offs.filter((o) => o.negotiable).length,
    uah: summarize(offs.filter((o) => o.isUah).map((o) => o.total)),
    uahPerTon: summarize(offs.filter((o) => o.isUah).map((o) => o.perTon)),
    uahPerKm: summarize(offs.filter((o) => o.isUah).map((o) => o.perKm)),
    otherCurrencies: Object.fromEntries(
      Object.entries(other).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, summarize(v)])
    ),
    medianDistance: medDist,
  };
}

function parseOffers(content: Any[], routeKm: number | null) {
  const cargoNames: Record<string, number> = {};
  const bodyTypes: Record<string, number> = {};
  const offers = content.map((it) => {
    const o = toOffer(it, routeKm);
    cargoNames[o.cargo] = (cargoNames[o.cargo] ?? 0) + 1;
    for (const b of o.bodies) bodyTypes[b] = (bodyTypes[b] ?? 0) + 1;
    return o;
  });
  const full = offers.filter((o) => o.loadType === "full");
  const part = offers.filter((o) => o.loadType === "part");
  const topN = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    count: offers.length,
    classes: { all: statsFrom(offers), full: statsFrom(full), part: statsFrom(part) },
    classCounts: { full: full.length, part: part.length, unknown: offers.filter((o) => o.loadType === "unknown").length },
    topCargo: topN(cargoNames),
    topBody: topN(bodyTypes),
    offers,
  };
}

// ── Lardi search body builders ──
function direction(townId?: number | null, areaId?: number | null) {
  const row: Any = {};
  if (townId) row.townId = townId;
  else if (areaId) row.areaId = areaId;
  return { directionRows: [row] };
}
interface Point { townId: number; areaId?: number | null; lat?: number | null; lon?: number | null; label?: string }
interface AnalyzeBody { frm: Point; to: Point; massMin?: number | null; massMax?: number | null; bodyTypeIds?: number[]; pageSize?: number }

function buildFilter(req: AnalyzeBody, useArea: boolean): Any {
  const f: Any = {
    directionFrom: direction(useArea ? null : req.frm.townId, useArea ? req.frm.areaId : null),
    directionTo: direction(useArea ? null : req.to.townId, useArea ? req.to.areaId : null),
  };
  if (req.massMin) f.mass1 = req.massMin;
  if (req.massMax) f.mass2 = req.massMax;
  if (req.bodyTypeIds?.length) f.bodyTypeIds = req.bodyTypeIds;
  return f;
}
async function search(path: string, req: AnalyzeBody, useArea: boolean): Promise<{ code: number; content: Any[] | null; detail: string }> {
  const body = {
    filter: buildFilter(req, useArea),
    options: { pageNumber: 1, pageSize: Math.max(10, Math.min(req.pageSize ?? 100, 200)) },
  };
  const r = await lardiPost(`${path}?language=${LANG}`, body);
  if (r.status !== 200) return { code: r.status, content: null, detail: (await r.text().catch(() => "")).slice(0, 300) };
  const j = await r.json().catch(() => null);
  return { code: 200, content: asArr(asObj(j).content), detail: "" };
}

function recommend(cargo: Any | null, lorry: Any | null, routeKm: number | null) {
  const cls = (x: Any | null) => asObj(asObj(x?.classes).all);
  const rec: Any = { distanceKm: routeKm };
  const c = asObj(cls(cargo).uah), l = asObj(cls(lorry).uah);
  if (c.median) rec.cargoMedian = c.median;
  if (l.median) rec.lorryMedian = l.median;
  const meds = [rec.cargoMedian, rec.lorryMedian].filter((m): m is number => typeof m === "number");
  if (meds.length) { rec.bandLow = Math.min(...meds); rec.bandHigh = Math.max(...meds); }
  const pkC = asObj(cls(cargo).uahPerKm), pkL = asObj(cls(lorry).uahPerKm);
  const perKm = (pkC.median ?? pkL.median) as number | undefined;
  if (perKm) {
    rec.perKm = perKm;
    rec.perKmSrc = pkC.median ? "заказчики" : "перевозчики";
    if (routeKm) rec.perKmTotal = Math.round(perKm * routeKm);
  }
  return rec;
}

// ── endpoints ──
ratesRouter.get("/health", (_req, res) => {
  res.json({ ok: true, hasToken: hasLardiToken() });
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
        country: first(t, "countrySign", "country"),
        area: (first(t, "areaName", "regionName") as string) || (areaId ? areas[areaId] : "") || "",
        areaId: areaId ?? null,
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
  if (!b.frm?.townId || !b.to?.townId) return res.status(400).json({ error: "Оберіть міста звідки і куди" });
  const reqBody: AnalyzeBody = {
    frm: b.frm, to: b.to,
    massMin: num(b.massMin), massMax: num(b.massMax),
    bodyTypeIds: Array.isArray(b.bodyTypeIds) ? b.bodyTypeIds.map(Number).filter(Boolean) : [],
    pageSize: 100,
  };

  const hav = haversineKm(b.frm.lat, b.frm.lon, b.to.lat, b.to.lon);
  let routeKm = hav ? Math.round(hav * ROAD_FACTOR) : null;

  const result: Any = {
    route: { from: b.frm.label ?? "", to: b.to.label ?? "", distanceKm: routeKm },
    filterEcho: { massMin: reqBody.massMin, massMax: reqBody.massMax, bodyTypeIds: reqBody.bodyTypeIds },
  };

  for (const [side, path] of [["cargo", "/v2/proposals/search/cargo"], ["lorry", "/v2/proposals/search/lorry"]] as const) {
    try {
      const r = await search(path, reqBody, false);
      if (r.code !== 200 || r.content === null) { result[side] = { error: `Lardi ${r.code}`, detail: r.detail }; continue; }
      let content = r.content, scope = "town";
      const canArea = b.frm.areaId && b.to.areaId;
      if (content.length < MIN_TOWN_RESULTS && canArea) {
        const r2 = await search(path, reqBody, true);
        if (r2.code === 200 && r2.content && r2.content.length) { content = r2.content; scope = "area"; }
      }
      result[side] = { ...parseOffers(content, routeKm), scope };
    } catch (e) {
      result[side] = { error: "Lardi недоступний", detail: String(e).slice(0, 120) };
    }
  }

  // Реальна відстань з пропозицій точніша за haversine.
  const md = (side: string) => asObj(asObj(asObj(result[side]).classes).all).medianDistance as number | undefined;
  const realDist = md("cargo") || md("lorry");
  if (realDist) { routeKm = realDist; (result.route as Any).distanceKm = realDist; }

  result.recommendation = recommend(result.cargo as Any, result.lorry as Any, routeKm);
  res.json(result);
});
