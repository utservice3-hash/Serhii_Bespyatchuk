/**
 * Спільне для тестів рушія: прогін сценарію будь-яким рушієм з тим самим API (еталон макета v2 або shared/cargoEngine.ts)
 * і «проєкція» результату — усе, що бачить менеджер: де стоїть кожне місце, що не влізло, насипом, «ще влізе», вільно, вага.
 */
import { archObstacles, type ArchSpec, type Body, type ExistingSpec, type Item } from '../cargoEngine.js';

export interface Scenario {
  key: string; note?: string;
  bodies: Body[]; arch?: ArchSpec | null; ex: ExistingSpec; items: Item[];
  gap?: number; countType?: string; layoutMode?: 'auto' | 'dense'; splitY?: number | null;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EngineLike { buildExisting(ex: any, bodies: any): any[][]; analyze(input: any): any }

const r9 = (v: number) => Math.round(v * 1e9) / 1e9;

export function runScenario(E: EngineLike, s: Scenario) {
  const existing = E.buildExisting(s.ex, s.bodies);
  const arches = archObstacles(s.bodies, s.arch);
  const r = E.analyze({
    bodies: s.bodies, arches, existing, items: s.items, gap: s.gap || 0,
    countType: s.countType || 'euro', layoutMode: s.layoutMode || 'auto', splitY: s.splitY ?? null,
  });
  return project(existing, r);
}

export function project(existing: any[][], r: any) {
  return {
    existing: existing.map(list => list.map((o: any) => [o.x, o.y, o.l, o.w, o.h ?? null, o.stop || 0, o.label ?? null])),
    placed: r.placed.map((p: any) => [p.uid, p.body, p.x, p.y, p.l, p.w, p.h, p.rotated ? 1 : 0, p.stop || 0]),
    unplaced: r.unplaced.map((u: any) => u.uid),
    units: r.units.length,
    strat: r.strat,
    bulk: {
      rects: r.bulk.rects.map((l: any[]) => l.map(b => [b.gid, b.x, b.y, b.l, b.w, b.h])),
      tops: r.bulk.tops.map((l: any[]) => l.map(t => [t.gid, t.x, t.y, t.l, t.w, r9(t.z0), r9(t.z1)])),
      left: r.bulk.left.map((b: any) => [b.gid, r9(b.m3)]),
    },
    variantInfo: r.variantInfo, chosen: r.chosen,
    countType: r.countType.name, maxExtra: r.maxExtra, hasStops: r.hasStops, mode: r.mode, alt: r.alt,
    perBody: r.perBody.map((p: any) => ({ ...p, freeVol: r9(p.freeVol), above: r9(p.above) })),
    even: r.even, max: r.max, freeVol: r9(r.freeVol), above: r9(r.above), kgOur: r.kgOur, kgMissing: r.kgMissing,
  };
}

// ---------- випадкові сценарії для «живої» звірки двох рушіїв ----------
export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const BODIES: Array<{ bodies: Body[]; arch?: ArchSpec }> = [
  { bodies: [{ L: 13600, W: 2450, H: 2700 }] }, { bodies: [{ L: 7200, W: 2450, H: 2500 }] }, { bodies: [{ L: 6200, W: 2450, H: 2400 }] },
  { bodies: [{ L: 4200, W: 2200, H: 2200 }] }, { bodies: [{ L: 5902, W: 2352, H: 2385 }] }, { bodies: [{ L: 7200, W: 2400, H: 2400 }] },
  { bodies: [{ L: 4307, W: 1787, H: 1974 }], arch: { between: 1350, len: 1000, x: 2270, h: 300 } },
  { bodies: [{ L: 3855, W: 1789, H: 1885 }], arch: { between: 1380, len: 1000, x: 2250, h: 300 } },
  { bodies: [{ L: 7700, W: 2450, H: 3000 }, { L: 7700, W: 2450, H: 3000 }] },
];
export function randomScenario(seed: number): Scenario {
  const rnd = mulberry32(seed), pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)], int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const base = pick(BODIES);
  const bodies = base.bodies.map(b => ({ ...b }));
  const multi = rnd() < 0.35, stop = () => multi ? int(1, 3) : 0;
  const L = bodies.reduce((s, b) => s + b.L, 0);
  const exModes: ExistingSpec[] = [
    { mode: 'empty' },
    { mode: 'pallets', type: pick(['euro', 'amer', 'finn']), qty: int(1, 8), h: pick([0, 1200, 1500]), stop: stop() },
    { mode: 'meters', split: false, kind: pick(['occupied', 'free'] as const), all: int(5, Math.floor(L / 100) - 5) * 100, stop: stop() },
    { mode: 'meters', split: true, kind: 'occupied', s1: int(0, Math.floor(L / 200)) * 100, s2: int(0, Math.floor(L / 200)) * 100, splitY: pick([null, 800, 1600]), stop: stop() },
    { mode: 'volume', kind: 'pct', pct: int(5, 60), stop: stop() },
    { mode: 'dims', rows: [{ l: int(5, 20) * 100, w: int(5, 12) * 100, h: int(5, 20) * 100, qty: int(1, 3) }], stop: stop() },
  ];
  const ex = pick(exModes);
  const items: Item[] = [];
  const n = int(0, 4);
  for (let k = 0; k < n; k++) {
    const id = 'i' + k, kind = pick(['pallet', 'pallet', 'pallet', 'box', 'roll', 'barrel', 'long', 'bigbag', 'bulk'] as const);
    if (kind === 'pallet') items.push({ id, kind, name: 'P' + k, ptype: pick(['euro', 'euro', 'amer', 'finn', 'half', 'square']), qty: int(1, 18), h: pick([0, 1200, 1600, 1900]), kg: pick([0, 300, 500]), stop: stop() });
    if (kind === 'box') items.push({ id, kind, name: 'B' + k, l: int(3, 12) * 100, w: int(3, 8) * 100, h: int(2, 8) * 100, qty: int(1, 60), kg: int(0, 30), stack: rnd() < 0.5, stop: stop() });
    if (kind === 'roll') items.push({ id, kind, name: 'R' + k, d: int(3, 8) * 100, len: int(10, 26) * 100, qty: int(1, 12), kg: 200, variant: pick(['auto', 'stand', 'lieX', 'lieY'] as const), stop: stop() });
    if (kind === 'barrel') items.push({ id, kind, name: 'D' + k, d: int(4, 7) * 100, hgt: int(6, 12) * 100, qty: int(1, 10), kg: 200, variant: pick(['auto', 'stand', 'lieX'] as const), stop: stop() });
    if (kind === 'long') items.push({ id, kind, name: 'L' + k, l: int(20, 70) * 100, w: int(2, 6) * 100, h: int(2, 5) * 100, qty: int(1, 6), kg: 100, variant: pick(['auto', 'along', 'across'] as const), stop: stop() });
    if (kind === 'bigbag') items.push({ id, kind, name: 'G' + k, onPallet: rnd() < 0.5, ptype: 'euro', l: 900, w: 900, h: pick([0, 1000]), qty: int(1, 8), kg: 800, stop: stop() });
    if (kind === 'bulk') items.push({ id, kind, name: 'M' + k, m3: int(1, 25), kg: 500, top: rnd() < 0.5 });
  }
  const splitY = ex.mode === 'meters' && ex.split ? (ex.splitY ?? null) : null;
  return { key: 'rnd' + seed, bodies, arch: base.arch, ex, items, gap: pick([0, 0, 0, 10, 20]), countType: pick(['euro', 'euro', 'amer']), layoutMode: pick(['auto', 'auto', 'dense'] as const), splitY };
}
