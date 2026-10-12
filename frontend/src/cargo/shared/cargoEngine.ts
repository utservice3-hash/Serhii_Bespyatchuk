/**
 * Рушій розкладки вантажу в кузові — чисті функції, без DOM і без залежностей.
 * Працює однаково в браузері (вкладка «Конфігуратор вантажу в авто») і на сервері (перевірка, тести).
 * Це 1:1 порт рушія з затвердженого макета (mockup/konfigurator-vantazhu.html, v2 від 12.10);
 * тест tests/engineParity.test.ts звіряє результати з макетом на еталонних сценаріях.
 *
 * Одиниці — міліметри (цілі). Система координат кузова: x — уздовж, від кабіни (0) до дверей (L);
 * y — упоперек, від борту 1 (0) до борту 2 (W).
 * Вільне місце — MaxRects (список максимальних порожніх прямокутників). Ставимо «ближче до кабіни»
 * (мінімум x+довжина); для однакових місць додатково перебираємо шаблони рядів і колон
 * (напр. 1 ряд по 3 + 5 рядів по 2 = 13 у 5,2 м — кейс Сергія).
 * Зазор g — «роздуваємо» кожне місце й перешкоду на g, а кузов — на g (біля стінок зазору немає).
 * Точки вивантаження (stop: 1 — вивантажують першою): місце, яке вивантажують раніше, не може стояти
 * «за» місцем, яке вивантажують пізніше (ближче до кабіни в тій самій смузі по ширині).
 */

export interface Rect { x: number; y: number; l: number; w: number }
export interface Body { L: number; W: number; H: number }
export interface Obstacle extends Rect { h?: number; stop?: number; arch?: boolean; block?: boolean; label?: string; pallet?: boolean }
export type Shape = 'pallet' | 'bag' | 'bag-pallet' | 'box' | 'long' | 'cyl-up' | 'cyl-x' | 'cyl-y';
export interface Unit {
  uid: string; gid: string; l: number; w: number; h: number; rot: boolean; kg: number; stop: number; shape: Shape;
  layers?: number; lh?: number;
}
export interface Placed extends Unit { x: number; y: number; rotated: boolean; body: number }
export type ItemKind = 'pallet' | 'bigbag' | 'box' | 'long' | 'roll' | 'barrel' | 'bulk';
export type Variant = 'auto' | 'along' | 'across' | 'stand' | 'lieX' | 'lieY';
export interface Item {
  id: string; kind: ItemKind; name: string; c?: number;
  qty?: number; kg?: number; stop?: number;
  ptype?: string; l?: number; w?: number; h?: number;      // палети, біг-беги, коробки, довгомір
  d?: number; len?: number; hgt?: number;                  // рулони (d, len), бочки (d, hgt)
  onPallet?: boolean; stack?: boolean; top?: boolean; m3?: number; variant?: Variant;
}
export type ExistingMode = 'empty' | 'pallets' | 'meters' | 'volume' | 'dims';
export interface ExistingSpec {
  mode: ExistingMode; stop?: number; kg?: number;
  type?: string; qty?: number; h?: number; l?: number; w?: number;                       // pallets
  split?: boolean; kind?: 'occupied' | 'free' | 'm3' | 'pct'; all?: number; s1?: number; s2?: number; splitY?: number | null; // meters / volume
  m3?: number; pct?: number;
  rows?: Array<{ l: number; w: number; h: number; qty: number; stop?: number }>;        // dims
}
export interface Pallet { l: number; w: number; name: string }
export interface BulkSpec { gid: string; m3: number; kg: number; top: boolean }
export interface TopRect extends Rect { gid: string; z0: number; z1: number }
export interface BulkResult { rects: Array<Array<Rect & { gid: string; h: number; bulk: true }>>; tops: TopRect[][]; left: Array<{ gid: string; m3: number }> }
export interface PackResult { placed: Placed[]; unplaced: Unit[]; strat: string }
export interface VariantInfo { v: Variant; placed: number; left: number; all: number; used: number; usedAll: number; reason: string }
export interface AnalyzeInput {
  bodies: Body[]; arches?: Obstacle[][]; existing?: Obstacle[][]; items: Item[]; gap?: number;
  countType?: string; layoutMode?: 'auto' | 'dense' | 'ordered'; splitY?: number | null;
}
export interface PerBody { free1: number; free2: number; split: number; freeVol: number; above: number; even: number; now: number }
export interface Recount { perBody: PerBody[]; even: number; max: number; freeVol: number; above: number; kgOur: number; kgMissing: number }
export interface AnalyzeResult extends Recount {
  units: Unit[]; placed: Placed[]; unplaced: Unit[]; strat: string; bulk: BulkResult;
  variantInfo: Record<string, VariantInfo[]>; chosen: Record<string, Variant>; countType: Pallet; maxExtra: number;
  hasStops: boolean; mode: 'ordered' | 'dense'; alt: { dense: number; ordered: number } | null;
}

/** Стандартні палети (адмін може змінити в довіднику — тоді передається свій об'єкт у PALLETS через setPallets). */
export const PALLETS: Record<string, Pallet> = {
  euro: { l: 1200, w: 800, name: 'Євро 1,2×0,8' },
  amer: { l: 1200, w: 1200, name: 'Американка 1,2×1,2' },
  finn: { l: 1200, w: 1000, name: 'Фінська 1,2×1,0' },
  half: { l: 800, w: 600, name: 'Напівпалета 0,8×0,6' },
  square: { l: 1000, w: 1000, name: 'Квадратна 1,0×1,0' },
};
/** Підставити палети з довідника БД (ключі й розміри). */
export function setPallets(p: Record<string, Pallet>): void {
  for (const k of Object.keys(PALLETS)) delete PALLETS[k];
  Object.assign(PALLETS, p);
}

// ---------- геометрія ----------
const inter = (a: Rect, b: Rect) => a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.w && b.y < a.y + a.w;
const contains = (a: Rect, b: Rect) => b.x >= a.x && b.y >= a.y && b.x + b.l <= a.x + a.l && b.y + b.w <= a.y + a.w;
const lexLess = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; };

function prune(list: Rect[]): Rect[] {
  const l = list.filter(f => f.l > 0 && f.w > 0), keep: Rect[] = [];
  for (let i = 0; i < l.length; i++) {
    let dead = false;
    for (let j = 0; j < l.length && !dead; j++) {
      if (i !== j && contains(l[j], l[i]) && (!contains(l[i], l[j]) || j < i)) dead = true;
    }
    if (!dead) keep.push(l[i]);
  }
  return keep;
}
function splitFree(free: Rect[], r: Rect): Rect[] {
  const out: Rect[] = [];
  for (const f of free) {
    if (!inter(f, r)) { out.push(f); continue; }
    if (r.x > f.x) out.push({ x: f.x, y: f.y, l: r.x - f.x, w: f.w });
    if (r.x + r.l < f.x + f.l) out.push({ x: r.x + r.l, y: f.y, l: f.x + f.l - r.x - r.l, w: f.w });
    if (r.y > f.y) out.push({ x: f.x, y: f.y, l: f.l, w: r.y - f.y });
    if (r.y + r.w < f.y + f.w) out.push({ x: f.x, y: r.y + r.w, l: f.l, w: f.y + f.w - r.y - r.w });
  }
  return prune(out);
}
const grow = (o: Rect, g: number): Rect => ({ x: o.x, y: o.y, l: o.l + g, w: o.w + g });
function initFree(body: Body, obst: Rect[], g: number): Rect[] {
  let free: Rect[] = [{ x: 0, y: 0, l: body.L + g, w: body.W + g }];
  for (const o of obst) free = splitFree(free, grow(o, g));
  return free;
}

// ---------- порядок вивантаження ----------
interface OrderCtx { stop: number; placed: Array<Rect & { stop: number }> }
/** Для місця з точкою con.stop у смузі [y, y+w): мінімальний x і максимальний кінець за порядком вивантаження. */
function xRange(y: number, w: number, con: OrderCtx | null): [number, number] {
  let minX = 0, maxEnd = Infinity;
  if (!con || !con.stop) return [minX, maxEnd];
  for (const q of con.placed) {
    if (!q.stop || q.stop === con.stop) continue;
    if (!(y < q.y + q.w && q.y < y + w)) continue;
    if (q.stop > con.stop) minX = Math.max(minX, q.x + q.l);
    else maxEnd = Math.min(maxEnd, q.x);
  }
  return [minX, maxEnd];
}

/** Найближче до кабіни місце для прямокутника l×w (уже з зазором). rot — можна повернути на 90°. */
function findBL(free: Rect[], l: number, w: number, rot: boolean, g: number, con: OrderCtx | null): Rect | null {
  let best: Rect | null = null, s0 = 0, s1 = 0, s2 = 0;
  const tryO = (ll: number, ww: number, o: number) => {
    for (const f of free) {
      if (ll > f.l || ww > f.w) continue;
      let x = f.x;
      if (con && con.stop) {
        const [minX, maxEnd] = xRange(f.y, ww - g, con);
        x = Math.max(f.x, minX);
        if (x + ll > f.x + f.l || x + ll - g > maxEnd) continue;
      }
      const a = x + ll, b = f.y;
      if (!best || a < s0 || (a === s0 && (b < s1 || (b === s1 && o < s2)))) { best = { x, y: f.y, l: ll, w: ww }; s0 = a; s1 = b; s2 = o; }
    }
  };
  tryO(l, w, 0);
  if (rot && l !== w) tryO(w, l, 1);
  return best;
}

// ---------- шаблони для однакових місць у прямокутнику R ----------
interface Pattern { slots: Rect[]; kind: 'rows' | 'cols'; uniform: boolean; take?: number; used?: number }
/** a — довжина місця вздовж кузова, b — ширина (обидва з зазором); rot — чи можна повертати. */
export function patterns(R: Rect, a: number, b: number, rot: boolean): Pattern[] {
  const out: Pattern[] = [];
  const nP = Math.floor(R.w / b), nQ = rot && a !== b ? Math.floor(R.w / a) : 0;
  const row = (x0: number, P: boolean) => {
    const s: Rect[] = [], n = P ? nP : nQ, ll = P ? a : b, ww = P ? b : a;
    for (let k = 0; k < n; k++) s.push({ x: x0, y: R.y + k * ww, l: ll, w: ww });
    return s;
  };
  const iMax = nP > 0 ? Math.floor(R.l / a) : 0;
  for (let i = 0; i <= iMax; i++) {
    const j = nQ > 0 ? Math.floor((R.l - i * a) / b) : 0;
    if (i === 0 && j === 0) continue;
    const orders = i > 0 && j > 0 ? [true, false] : [i > 0];
    for (const pFirst of orders) {
      const slots: Rect[] = []; let x = R.x;
      const seq: Array<[boolean, number]> = pFirst ? [[true, i], [false, j]] : [[false, j], [true, i]];
      for (const [P, cnt] of seq) for (let r = 0; r < cnt; r++) { slots.push(...row(x, P)); x += P ? a : b; }
      out.push({ slots, kind: 'rows', uniform: i === 0 || j === 0 });
    }
  }
  const mP = Math.floor(R.l / a), mQ = rot && a !== b ? Math.floor(R.l / b) : 0;
  const col = (y0: number, P: boolean) => {
    const s: Rect[] = [], m = P ? mP : mQ, ll = P ? a : b, ww = P ? b : a;
    for (let k = 0; k < m; k++) s.push({ x: R.x + k * ll, y: y0, l: ll, w: ww });
    return s;
  };
  for (let cP = 0; cP <= Math.floor(R.w / b); cP++) {
    const cQ = mQ > 0 ? Math.floor((R.w - cP * b) / a) : 0;
    if ((cP === 0 || mP === 0) && cQ === 0) continue;
    const orders = cP > 0 && cQ > 0 ? [true, false] : [cP > 0];
    for (const pFirst of orders) {
      const slots: Rect[] = []; let y = R.y;
      const seq: Array<[boolean, number]> = pFirst ? [[true, cP], [false, cQ]] : [[false, cQ], [true, cP]];
      for (const [P, cnt] of seq) for (let c = 0; c < cnt; c++) { slots.push(...col(y, P)); y += P ? b : a; }
      out.push({ slots, kind: 'cols', uniform: cP === 0 || cQ === 0 });
    }
  }
  for (const p of out) p.slots.sort((u, v) => (u.x + u.l) - (v.x + v.l) || u.y - v.y || u.x - v.x);
  return out;
}
/** Найкращий шаблон під qty місць: більше місць → коротше по довжині → рівні ряди → ряди раніше за колони. */
export function bestPattern(R: Rect, a: number, b: number, rot: boolean, qty: number): (Pattern & { take: number; used: number }) | null {
  let best: (Pattern & { take: number; used: number }) | null = null, key: number[] | null = null;
  for (const p of patterns(R, a, b, rot)) {
    const take = Math.min(qty, p.slots.length);
    if (!take) continue;
    let used = 0;
    for (let k = 0; k < take; k++) used = Math.max(used, p.slots[k].x + p.slots[k].l);
    const kk = [-take, used, p.uniform ? 0 : 1, p.kind === 'rows' ? 0 : 1];
    if (!key || lexLess(kk, key)) { best = { ...p, take, used }; key = kk; }
  }
  return best;
}

// ---------- розміщення ----------
function placeAt(u: Unit, s: Rect, g: number): Placed {
  const l = s.l - g, w = s.w - g;
  return { ...u, x: s.x, y: s.y, l, w, rotated: l !== u.l, body: 0 };
}
interface GroupRes { free: Rect[]; placed: Placed[]; rest: Unit[] }
function groupBL(free: Rect[], units: Unit[], g: number, con: OrderCtx | null): GroupRes {
  const placed: Placed[] = [], rest: Unit[] = [];
  for (const u of units) {
    const s = findBL(free, u.l + g, u.w + g, u.rot, g, con);
    if (!s) { rest.push(u); continue; }
    free = splitFree(free, s);
    placed.push(placeAt(u, s, g));
  }
  return { free, placed, rest };
}
function slotOK(s: Rect, g: number, con: OrderCtx | null): boolean {
  if (!con || !con.stop) return true;
  const [minX, maxEnd] = xRange(s.y, s.w - g, con);
  return s.x >= minX && s.x + s.l - g <= maxEnd;
}
function groupPattern(free: Rect[], units: Unit[], g: number, bodyL: number, con: OrderCtx | null): GroupRes {
  if (!units.length) return { free, placed: [], rest: [] };
  const u0 = units[0], a = u0.l + g, b = u0.w + g;
  const cands = [...free].sort((p, q) => q.l * q.w - p.l * p.w).slice(0, 4);
  const tail = free.filter(f => f.x + f.l >= bodyL).sort((p, q) => q.l * q.w - p.l * p.w)[0];
  if (tail && !cands.includes(tail)) cands.push(tail);
  let best: (Pattern & { take: number; used: number }) | null = null, key: number[] | null = null;
  for (const R of cands) {
    const p = bestPattern(R, a, b, u0.rot, units.length);
    if (!p) continue;
    let ok = true;
    for (let k = 0; k < p.take && ok; k++) ok = slotOK(p.slots[k], g, con);
    if (!ok) continue;
    const kk = [-p.take, R.x, p.used];
    if (!key || lexLess(kk, key)) { best = p; key = kk; }
  }
  if (!best) return groupBL(free, units, g, con);
  const placed: Placed[] = [];
  for (let k = 0; k < best.take; k++) { free = splitFree(free, best.slots[k]); placed.push(placeAt(units[k], best.slots[k], g)); }
  const r = groupBL(free, units.slice(best.take), g, con);
  return { free: r.free, placed: placed.concat(r.placed), rest: r.rest };
}
const maxX = (list: Rect[]) => list.reduce((m, p) => Math.max(m, p.x + p.l), 0);
const areaOf = (list: Rect[]) => list.reduce((s, p) => s + p.l * p.w, 0);

/** Групи за слідом на підлозі (не за позицією): однакові палети різних позицій плануються одним шаблоном. */
function groupsOf(units: Unit[]): Unit[][] {
  const m = new Map<string, Unit[]>();
  for (const u of units) { const k = u.l + 'x' + u.w + '|' + (u.rot ? 1 : 0); if (!m.has(k)) m.set(k, []); m.get(k)!.push(u); }
  return [...m.values()];
}
const byArea = (p: Unit[], q: Unit[]) => q[0].l * q[0].w - p[0].l * p[0].w;

/** Одна стратегія на одному кузові. ordered — враховувати точки вивантаження. */
function packBody(body: Body, obst: Obstacle[], units: Unit[], g: number, strat: string, ordered: boolean): { placed: Placed[]; rest: Unit[] } {
  const tooHigh = units.filter(u => u.h > body.H);
  const ok = units.filter(u => !(u.h > body.H));
  let free = initFree(body, obst, g);
  const L = body.L + g;
  let placed: Placed[] = [], rest: Unit[] = [...tooHigh];
  const stops: Array<number | null> = ordered ? [...new Set(ok.map(u => u.stop || 0))].sort((a, b) => (b || -1) - (a || -1)) : [null];
  const con: OrderCtx | null = ordered ? { stop: 0, placed: obst.filter(o => o.stop).map(o => ({ x: o.x, y: o.y, l: o.l, w: o.w, stop: o.stop as number })) } : null;
  for (const st of stops) {
    const part = st === null ? ok : ok.filter(u => (u.stop || 0) === st);
    if (con) con.stop = st as number;
    if (strat === 'bl' || strat === 'bl-area') {
      const list = strat === 'bl' ? part : [...part].sort((p, q) => q.l * q.w - p.l * p.w);
      const r = groupBL(free, list, g, con); free = r.free; placed = placed.concat(r.placed); rest = rest.concat(r.rest);
      if (con) con.placed.push(...r.placed.map(p => ({ x: p.x, y: p.y, l: p.l, w: p.w, stop: p.stop })));
    } else {
      let gs = groupsOf(part);
      if (strat === 'grp-area') gs = gs.sort(byArea);
      for (const grp of gs) {
        const A = groupPattern(free, grp, g, L, con), B = groupBL(free, grp, g, con);
        const pick = (A.placed.length > B.placed.length || (A.placed.length === B.placed.length && maxX(A.placed) <= maxX(B.placed))) ? A : B;
        free = pick.free; placed = placed.concat(pick.placed); rest = rest.concat(pick.rest);
        if (con) con.placed.push(...pick.placed.map(p => ({ x: p.x, y: p.y, l: p.l, w: p.w, stop: p.stop })));
      }
    }
  }
  return { placed, rest };
}
const STRATS = ['grp', 'bl', 'grp-area', 'bl-area'];
/** Усі кузови (зчіпка — два): кожна стратегія проходить кузови по черзі; беремо найкращу. */
export function packAll(bodies: Body[], obstByBody: Obstacle[][], units: Unit[], g: number, ordered: boolean): PackResult {
  let best: PackResult | null = null, key: number[] | null = null;
  for (const st of STRATS) {
    let rest = units; const byBody: Placed[][] = [];
    for (let bi = 0; bi < bodies.length; bi++) {
      const r = packBody(bodies[bi], obstByBody[bi] || [], rest, g, st, ordered);
      byBody.push(r.placed.map(p => ({ ...p, body: bi }))); rest = r.rest;
    }
    const all = byBody.flat();
    const used = byBody.reduce((s, b) => s + maxX(b), 0);
    const kk = [-all.length, -areaOf(all), used];
    if (!key || lexLess(kk, key)) { key = kk; best = { placed: all, unplaced: rest, strat: st }; }
  }
  const order = new Map(units.map((u, i) => [u.uid, i]));
  best!.placed.sort((p, q) => order.get(p.uid)! - order.get(q.uid)!);
  best!.unplaced.sort((p, q) => order.get(p.uid)! - order.get(q.uid)!);
  return best!;
}

// ---------- наявний вантаж (що вже стоїть в авто) ----------
/** Повертає масив по кузовах: [{x,y,l,w,h,label,stop}] — менеджер може пересувати їх на схемі. */
export function buildExisting(ex: ExistingSpec | null, bodies: Body[]): Obstacle[][] {
  const out: Obstacle[][] = bodies.map(() => []);
  if (!ex || ex.mode === 'empty') return out;
  const stop = +(ex.stop || 0) || 0;
  const total = bodies.reduce((s, b) => s + b.L, 0);
  const byLength = (occ: number, y0: (b: Body) => number, w: (b: Body) => number, label: string) => {
    let rest = Math.max(0, Math.min(occ, total));
    bodies.forEach((b, bi) => {
      const o = Math.min(rest, b.L); rest -= o;
      if (o > 0) out[bi].push({ x: 0, y: y0(b), l: o, w: w(b), h: b.H, label, block: true, stop });
    });
  };
  if (ex.mode === 'meters') {
    const conv = (v: number) => ex.kind === 'free' ? total - v : v;
    if (!ex.split) byLength(conv(ex.all || 0), () => 0, b => b.W, 'зайнято');
    else {
      const sy = (b: Body) => Math.max(100, Math.min(b.W - 100, ex.splitY || Math.floor(b.W / 2)));
      byLength(conv(ex.s1 || 0), () => 0, b => sy(b), 'зайнято');
      byLength(conv(ex.s2 || 0), b => sy(b), b => b.W - sy(b), 'зайнято');
    }
  } else if (ex.mode === 'volume') {
    const b0 = bodies[0];
    const occ = ex.kind === 'pct' ? Math.round(total * (ex.pct || 0) / 100) : Math.round((ex.m3 || 0) * 1e9 / (b0.W * b0.H));
    byLength(occ, () => 0, b => b.W, ex.kind === 'pct' ? ex.pct + '%' : ex.m3 + ' м³');
  } else if (ex.mode === 'pallets') {
    const t = PALLETS[ex.type || ''] || { l: ex.l || 1200, w: ex.w || 800 };
    let left = ex.qty || 0;
    bodies.forEach((b, bi) => {
      if (left <= 0) return;
      const p = bestPattern({ x: 0, y: 0, l: b.L, w: b.W }, t.l, t.w, true, left);
      if (!p) return;
      for (let k = 0; k < p.take; k++) { const s = p.slots[k]; out[bi].push({ x: s.x, y: s.y, l: s.l, w: s.w, h: ex.h || 0, label: 'є', pallet: true, stop }); }
      left -= p.take;
    });
  } else if (ex.mode === 'dims') {
    const units: Unit[] = [];
    (ex.rows || []).forEach((r, ri) => { for (let k = 0; k < r.qty; k++) units.push({ uid: 'e' + ri + '-' + k, gid: 'e' + ri, l: r.l, w: r.w, h: r.h, rot: true, kg: 0, stop: +(r.stop || 0) || stop, shape: 'box' }); });
    const res = packAll(bodies, bodies.map(() => []), units, 0, false);
    for (const p of res.placed) out[p.body].push({ x: p.x, y: p.y, l: p.l, w: p.w, h: p.h, label: 'є', stop: p.stop });
  }
  return out;
}

// ---------- наш вантаж → місця ----------
export const VARIANTS: Partial<Record<ItemKind, Variant[]>> = { long: ['along', 'across'], roll: ['stand', 'lieX', 'lieY'], barrel: ['stand', 'lieX', 'lieY'] };
export function variantDims(it: Item, v: Variant): { l: number; w: number; h: number; shape: Shape; rot: false } {
  if (it.kind === 'long') return v === 'across' ? { l: it.w || 0, w: it.l || 0, h: it.h || 0, shape: 'long', rot: false } : { l: it.l || 0, w: it.w || 0, h: it.h || 0, shape: 'long', rot: false };
  const D = it.d || 0, len = (it.kind === 'roll' ? it.len : it.hgt) || 0;
  if (v === 'stand') return { l: D, w: D, h: len, shape: 'cyl-up', rot: false };
  if (v === 'lieY') return { l: D, w: len, h: D, shape: 'cyl-y', rot: false };
  return { l: len, w: D, h: D, shape: 'cyl-x', rot: false };   // lieX — лежачи вздовж кузова
}
export function buildUnits(items: Item[], H: number, variantOf: (it: Item) => Variant): { units: Unit[]; bulk: BulkSpec[] } {
  const units: Unit[] = [], bulk: BulkSpec[] = [];
  for (const it of items) {
    const kg = +(it.kg || 0) || 0, stop = +(it.stop || 0) || 0, qty = it.qty || 0;
    const push = (n: number, d: { l: number; w: number; h: number; rot: boolean; shape: Shape }) => { for (let k = 0; k < n; k++) units.push({ uid: it.id + '-' + k, gid: it.id, kg, stop, ...d }); };
    if (it.kind === 'pallet') {
      const t = PALLETS[it.ptype || ''] || { l: it.l || 0, w: it.w || 0 };
      push(qty, { l: t.l, w: t.w, h: +(it.h || 0) || 0, rot: true, shape: 'pallet' });
    } else if (it.kind === 'bigbag') {
      const t = it.onPallet ? (PALLETS[it.ptype || ''] || PALLETS.euro) : { l: it.l || 0, w: it.w || 0 };
      push(qty, { l: t.l, w: t.w, h: it.h ? it.h + (it.onPallet ? 150 : 0) : 0, rot: true, shape: it.onPallet ? 'bag-pallet' : 'bag' });
    } else if (it.kind === 'box') {
      const h = it.h || 0;
      const per = it.stack && h ? Math.max(1, Math.floor(H / h)) : 1;
      let left = qty, k = 0;
      while (left > 0) {
        const n = Math.min(per, left); left -= n;
        units.push({ uid: it.id + '-' + k++, gid: it.id, l: it.l || 0, w: it.w || 0, h: n * h, layers: n, lh: h, kg: kg * n, rot: true, shape: 'box', stop });
      }
    } else if (VARIANTS[it.kind]) {
      push(qty, variantDims(it, variantOf(it)));
    } else if (it.kind === 'bulk') {
      bulk.push({ gid: it.id, m3: +(it.m3 || 0) || 0, kg, top: !!it.top });
    }
  }
  return { units, bulk };
}

// ---------- насипом ----------
/** Спершу (якщо позиції дозволено) — зверху на вантаж, від кабіни до дверей; решту — на вільну підлогу на всю висоту. */
export function fillBulk(bodies: Body[], occByBody: Rect[][], bulk: BulkSpec[], above?: Array<Array<Rect & { h0: number }>>): BulkResult {
  const cx = 100, cy = 50;
  const res: BulkResult['rects'] = bodies.map(() => []), tops: TopRect[][] = bodies.map(() => []), left: BulkResult['left'] = [];
  const need = bulk.map(b => b.m3 * 1e9);
  const sp = bodies.map((b, bi) => (above && above[bi] ? above[bi] : []).filter(a => a.h0 > 0 && a.h0 < b.H).map(a => ({ ...a, z: a.h0 })).sort((p, q) => p.x - q.x || p.y - q.y));
  bulk.forEach((b, k) => {
    if (!b.top) return;
    bodies.forEach((body, bi) => {
      for (const a of sp[bi]) {
        if (need[k] <= 0) return;
        if (a.z >= body.H) continue;
        const take = Math.min((body.H - a.z) * a.l * a.w, need[k]);
        const z1 = a.z + take / (a.l * a.w);
        tops[bi].push({ gid: b.gid, x: a.x, y: a.y, l: a.l, w: a.w, z0: a.z, z1 });
        a.z = z1; need[k] -= take;
      }
    });
  });
  const queue = bulk.map((_, k) => k).filter(k => need[k] > 0);
  let qi = 0;
  bodies.forEach((b, bi) => {
    if (qi >= queue.length) return;
    const nx = Math.ceil(b.L / cx), ny = Math.ceil(b.W / cy);
    const occ = new Uint8Array(nx * ny);
    for (const r of occByBody[bi]) {
      const x0 = Math.max(0, Math.floor(r.x / cx)), x1 = Math.min(nx, Math.ceil((r.x + r.l) / cx));
      const y0 = Math.max(0, Math.floor(r.y / cy)), y1 = Math.min(ny, Math.ceil((r.y + r.w) / cy));
      for (let i = x0; i < x1; i++) for (let j = y0; j < y1; j++) occ[i * ny + j] = 1;
    }
    for (let i = 0; i < nx && qi < queue.length; i++) {
      const runs: Array<Rect & { gid: string }> = [];
      for (let j = 0; j < ny && qi < queue.length; j++) {
        if (occ[i * ny + j]) continue;
        const k = queue[qi], gid = bulk[k].gid;
        const cl = Math.min(cx, b.L - i * cx), cw = Math.min(cy, b.W - j * cy);
        need[k] -= cl * cw * b.H;
        const last = runs[runs.length - 1];
        if (last && last.gid === gid && last.y + last.w === j * cy) last.w += cw; else runs.push({ gid, x: i * cx, y: j * cy, l: cl, w: cw });
        if (need[k] <= 0) qi++;
      }
      for (const r of runs) {
        const prev = res[bi].find(p => p.gid === r.gid && p.y === r.y && p.w === r.w && p.x + p.l === r.x);
        if (prev) prev.l += r.l; else res[bi].push({ ...r, h: b.H, bulk: true });
      }
    }
  });
  bulk.forEach((b, k) => { if (need[k] > 0) left.push({ gid: b.gid, m3: need[k] / 1e9 }); });
  return { rects: res, tops, left };
}

// ---------- аналіз вільного місця ----------
export function unionArea(rects: Rect[], body: Body): number {
  if (!rects.length) return 0;
  const xs = [...new Set(rects.flatMap(r => [Math.max(0, r.x), Math.min(body.L, r.x + r.l)]).concat([0, body.L]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(r => [Math.max(0, r.y), Math.min(body.W, r.y + r.w)]).concat([0, body.W]))].sort((a, b) => a - b);
  let s = 0;
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    const mx = (xs[i] + xs[i + 1]) / 2, my = (ys[j] + ys[j + 1]) / 2;
    if (rects.some(r => mx > r.x && mx < r.x + r.l && my > r.y && my < r.y + r.w)) s += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
  }
  return s;
}
/** Скільки місць t ще стане на вільну підлогу при поточній розкладці. fixed: 'P'|'Q' — лише одна орієнтація. */
export function fillCount(body: Body, occ: Rect[], t: { l: number; w: number }, g: number, fixed: 'P' | 'Q' | null): number {
  let free = initFree(body, occ, g); let n = 0;
  const a = fixed === 'Q' ? t.w : t.l, b = fixed === 'Q' ? t.l : t.w;
  for (;;) {
    const s = findBL(free, a + g, b + g, !fixed, g, null);
    if (!s) break;
    free = splitFree(free, s); n++;
    if (n > 500) break;
  }
  return n;
}
function tailPatternCount(body: Body, occ: Rect[], t: { l: number; w: number }, g: number): number {
  const free = initFree(body, occ, g); const L = body.L + g;
  const tail = free.filter(f => f.x + f.l >= L).sort((p, q) => q.l * q.w - p.l * p.w)[0];
  if (!tail) return 0;
  const p = bestPattern(tail, t.l + g, t.w + g, true, Infinity);
  if (!p) return 0;
  let fr = free; for (const s of p.slots) fr = splitFree(fr, s);
  let n = p.slots.length;
  for (;;) { const s = findBL(fr, t.l + g, t.w + g, true, g, null); if (!s) break; fr = splitFree(fr, s); n++; if (n > 500) break; }
  return n;
}
/** Колісні арки буса → перешкоди на підлозі кожного кузова (дві однакові, біля обох бортів). Як archesOf() у макеті. */
export interface ArchSpec { between: number; len: number; x: number; h: number }
export function archObstacles(bodies: Body[], arch: ArchSpec | null | undefined): Obstacle[][] {
  return bodies.map(b => {
    if (!arch) return [];
    const side = Math.max(0, Math.round((b.W - arch.between) / 2));
    if (!side || arch.x + arch.len > b.L) return [];
    return [{ x: arch.x, y: 0, l: arch.len, w: side, h: arch.h, arch: true }, { x: arch.x, y: b.W - side, l: arch.len, w: side, h: arch.h, arch: true }];
  });
}

export const aboveOf = (bodies: Body[], existing: Obstacle[][], placed: Placed[]): Array<Array<Rect & { h0: number }>> => bodies.map((_, bi) => [
  ...existing[bi].filter(r => !r.block && (r.h || 0) > 0),
  ...placed.filter(p => p.body === bi && p.h > 0),
].map(r => ({ x: r.x, y: r.y, l: r.l, w: r.w, h0: r.h || 0 })));

/** Повний розрахунок: розкладка, насипом, «ще влізе», варіанти довгоміру/рулонів/бочок, порядок точок. */
export function analyze(input: AnalyzeInput): AnalyzeResult {
  const { bodies } = input; const g = input.gap || 0;
  const arches = input.arches || bodies.map(() => []);
  const existing = input.existing || bodies.map(() => []);
  const obst = bodies.map((_, bi) => [...arches[bi], ...existing[bi]]);
  const H = Math.min(...bodies.map(b => b.H));
  const stopsSeen = new Set([...input.items.map(i => +(i.stop || 0) || 0), ...existing.flat().map(r => r.stop || 0)].filter(Boolean));
  const hasStops = stopsSeen.size >= 2;
  const useOrdered = hasStops && input.layoutMode !== 'dense';

  const chosen: Record<string, Variant> = {}, variantInfo: Record<string, VariantInfo[]> = {};
  const baseVariant = (it: Item): Variant => chosen[it.id] || (it.variant && it.variant !== 'auto' ? it.variant : VARIANTS[it.kind]![0]);
  for (const it of input.items.filter(x => VARIANTS[x.kind])) {
    variantInfo[it.id] = [];
    for (const v of VARIANTS[it.kind]!) {
      const { units } = buildUnits(input.items, H, x => x.id === it.id ? v : baseVariant(x));
      const r = packAll(bodies, obst, units, g, useOrdered);
      const mine = r.placed.filter(p => p.gid === it.id);
      const d = variantDims(it, v);
      const reason = d.h > H ? 'вищі за кузов' : (d.l > Math.max(...bodies.map(b => b.L)) || d.w > Math.max(...bodies.map(b => b.W))) ? 'довші за кузов' : '';
      const usedAll = bodies.reduce((sum, _, bi) => sum + maxX(r.placed.filter(q => q.body === bi)), 0);
      variantInfo[it.id].push({ v, placed: mine.length, left: r.unplaced.filter(p => p.gid === it.id).length, all: r.unplaced.length, used: maxX(mine), usedAll, reason });
    }
    const best = [...variantInfo[it.id]].sort((p, q) => p.all - q.all || p.left - q.left || p.usedAll - q.usedAll || p.used - q.used)[0];
    chosen[it.id] = !it.variant || it.variant === 'auto' ? best.v : it.variant;
  }
  const variantOf = (it: Item): Variant => chosen[it.id] || VARIANTS[it.kind]![0];
  const { units, bulk } = buildUnits(input.items, H, variantOf);
  const dense = packAll(bodies, obst, units, g, false);
  const ordered = hasStops ? packAll(bodies, obst, units, g, true) : null;
  const pk = useOrdered ? ordered! : dense;
  const placedBy = bodies.map((_, bi) => pk.placed.filter(p => p.body === bi));
  const bulkRes = fillBulk(bodies, bodies.map((_, bi) => [...obst[bi], ...placedBy[bi]]), bulk, aboveOf(bodies, existing, pk.placed));

  // «ще влізе впритул»: скільки палет типу t можна додати, якщо система розкладе все заново (і насипом теж влізе)
  const t = PALLETS[input.countType || 'euro'] || PALLETS.euro || { l: 1200, w: 800, name: 'Євро' };
  const basePlaced = pk.placed.length;
  const fits = (n: number) => {
    const extra: Unit[] = []; for (let k = 0; k < n; k++) extra.push({ uid: 'x' + k, gid: '__extra', l: t.l, w: t.w, h: 0, rot: true, kg: 0, stop: 0, shape: 'pallet' });
    const r = packAll(bodies, obst, units.concat(extra), g, useOrdered);
    if (r.placed.filter(p => p.gid === '__extra').length < n || r.placed.filter(p => p.gid !== '__extra').length < basePlaced) return false;
    if (!bulk.length) return true;
    const br = fillBulk(bodies, bodies.map((_, bi) => [...obst[bi], ...r.placed.filter(p => p.body === bi)]), bulk, aboveOf(bodies, existing, r.placed.filter(p => p.gid !== '__extra')));
    return !br.left.length;
  };
  let maxExtra = 0;
  if (!pk.unplaced.length && !bulkRes.left.length) {
    let freeArea = 0;
    bodies.forEach((b, bi) => { freeArea += b.L * b.W - unionArea([...obst[bi], ...placedBy[bi]], b); });
    let lo = 0, hi = Math.floor(freeArea / (t.l * t.w));
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
    maxExtra = lo;
  }
  const base = {
    units, placed: pk.placed, unplaced: pk.unplaced, strat: pk.strat, bulk: bulkRes, variantInfo, chosen, countType: t, maxExtra,
    hasStops, mode: (useOrdered ? 'ordered' : 'dense') as 'ordered' | 'dense',
    alt: hasStops ? { dense: dense.unplaced.length, ordered: ordered!.unplaced.length } : null,
  };
  return { ...base, ...recount(input, base) };
}

/** Перерахунок «що лишилось» для поточної розкладки (після ручного пересування теж). */
export function recount(input: AnalyzeInput, res: { placed: Placed[]; bulk: BulkResult; countType: Pallet; maxExtra?: number }): Recount {
  const { bodies } = input; const g = input.gap || 0;
  const arches = input.arches || bodies.map(() => []);
  const existing = input.existing || bodies.map(() => []);
  const t = res.countType;
  const perBody = bodies.map((b, bi): PerBody => {
    const mine = res.placed.filter(p => p.body === bi);
    const bulkR = res.bulk.rects[bi] || [];
    const cargo: Rect[] = [...existing[bi], ...mine, ...bulkR];          // для «вільно по довжині» арки не рахуємо
    const occAll: Rect[] = [...arches[bi], ...cargo];
    const split = Math.max(100, Math.min(b.W - 100, input.splitY || Math.floor(b.W / 2)));
    const laneEnd = (y0: number, y1: number) => cargo.filter(r => r.y < y1 && r.y + r.w > y0).reduce((m, r) => Math.max(m, r.x + r.l), 0);
    const free1 = b.L - laneEnd(0, split), free2 = b.L - laneEnd(split, b.W);
    const freeArea = b.L * b.W - unionArea(occAll, b);
    const aboveAll = [...existing[bi].filter(r => !r.block && (r.h || 0) > 0), ...mine.filter(p => p.h > 0)].reduce((s, r) => s + Math.max(0, b.H - (r.h || 0)) * r.l * r.w, 0);
    const topUsed = (res.bulk.tops && res.bulk.tops[bi] || []).reduce((s, r) => s + (r.z1 - r.z0) * r.l * r.w, 0);
    const even = Math.max(fillCount(b, occAll, t, g, 'P'), fillCount(b, occAll, t, g, 'Q'));
    const now = Math.max(fillCount(b, occAll, t, g, null), tailPatternCount(b, occAll, t, g));
    return { free1, free2, split, freeVol: freeArea * b.H / 1e9, above: Math.max(0, aboveAll - topUsed) / 1e9, even, now };
  });
  const even = perBody.reduce((s, p) => s + p.even, 0);
  const now = perBody.reduce((s, p) => s + p.now, 0);
  const kgOur = res.placed.reduce((s, p) => s + (p.kg || 0), 0) + (input.items || []).filter(i => i.kind === 'bulk').reduce((s, i) => s + (+(i.kg || 0) || 0), 0);
  const kgMissing = (input.items || []).filter(i => i.kind !== 'bulk' && !(+(i.kg || 0))).reduce((s, i) => s + (+(i.qty || 0) || 0), 0);
  return {
    perBody, even, max: Math.max(res.maxExtra || 0, now, even),
    freeVol: perBody.reduce((s, p) => s + p.freeVol, 0), above: perBody.reduce((s, p) => s + p.above, 0),
    kgOur, kgMissing,
  };
}

/** Перевірка ручного пересування: у кузові, без перетину з іншими (з урахуванням зазору). */
export function checkMove(body: Body, rect: Rect, others: Rect[], g: number): { ok: true } | { ok: false; why: 'out' | 'hit'; with?: Rect } {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.l > body.L || rect.y + rect.w > body.W) return { ok: false, why: 'out' };
  const r = grow(rect, g);
  for (const o of others) if (inter(r, grow(o, g))) return { ok: false, why: 'hit', with: o };
  return { ok: true };
}
/** Хто порушує порядок вивантаження відносно місця rect з точкою stop (для попередження після ручного пересування). */
export function orderBreaks(rect: Rect, stop: number, others: Array<Rect & { stop?: number }>): Array<Rect & { stop?: number }> {
  if (!stop) return [];
  return others.filter(q => q.stop && q.stop !== stop && rect.y < q.y + q.w && q.y < rect.y + rect.w &&
    ((q.stop > stop && rect.x < q.x + q.l) || (q.stop < stop && rect.x + rect.l > q.x)));
}
