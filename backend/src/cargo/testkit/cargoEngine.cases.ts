/**
 * Кейси Сергія й інваріанти рушія — людською мовою. Числа звірені з ним під час інтерв'ю (09–12.10).
 */
import { describe, expect, it } from './shim.js';
import {
  analyze, archObstacles, buildExisting, checkMove, orderBreaks, type AnalyzeInput, type Body, type ExistingSpec, type Item, type Obstacle, type Placed,
} from '../cargoEngine.js';
import { randomScenario } from './engineHarness.js';

const TENT: Body[] = [{ L: 13600, W: 2450, H: 2700 }];
const SPRINTER: Body[] = [{ L: 4307, W: 1787, H: 1974 }];
const SPR_ARCH = { between: 1350, len: 1000, x: 2270, h: 300 };
const pal = (id: string, ptype: string, qty: number, h = 1500, kg = 500, stop = 0): Item => ({ id, kind: 'pallet', name: id, ptype, qty, h, kg, stop });
function run(bodies: Body[], ex: ExistingSpec, items: Item[], extra: Partial<AnalyzeInput> & { arch?: typeof SPR_ARCH } = {}) {
  const existing = buildExisting(ex, bodies);
  const arches = archObstacles(bodies, extra.arch);
  const input: AnalyzeInput = { bodies, arches, existing, items, gap: 0, countType: 'euro', ...extra };
  return { r: analyze(input), existing, arches };
}

describe('кейси Сергія', () => {
  it('кейс 19: 7,2×2,4×2,4, вже є 5 євро → вільно 5,20 м, ще 13 впритул / 12 рівними, ≈30,0 м³', () => {
    const { r } = run([{ L: 7200, W: 2400, H: 2400 }], { mode: 'pallets', type: 'euro', qty: 5, h: 1500 }, []);
    expect(r.perBody[0].free1).toBe(5200);
    expect(r.max).toBe(13);
    expect(r.even).toBe(12);
    expect(r.freeVol.toFixed(1)).toBe('30.0');
  });
  it('кейс 19 + наші 12 євро → усі стали, ще 1 впритул / 0 рівними', () => {
    const { r } = run([{ L: 7200, W: 2400, H: 2400 }], { mode: 'pallets', type: 'euro', qty: 5, h: 1500 }, [pal('a', 'euro', 12)]);
    expect(r.unplaced).toHaveLength(0);
    expect([r.max, r.even]).toEqual([1, 0]);
  });
  it.each([
    ['тент 13,6', TENT, 0, 34, 34],
    ['тент 13,6, зазор 1 см', TENT, 10, 33, 33],
    ['3 т', [{ L: 4200, W: 2200, H: 2200 }], 0, 8, 6],
    ['10 т', [{ L: 7200, W: 2450, H: 2500 }], 0, 18, 18],
    ["контейнер 20'", [{ L: 5902, W: 2352, H: 2385 }], 0, 11, 8],
    ["контейнер 40'", [{ L: 11960, W: 2350, H: 2390 }], 0, 23, 18],
  ] as Array<[string, Body[], number, number, number]>)('%s порожній → впритул / рівними', (_n, bodies, gap, max, even) => {
    const { r } = run(bodies, { mode: 'empty' }, [], { gap });
    expect([r.max, r.even]).toEqual([max, even]);
  });
  it('Sprinter L3 з арками: порожній → 5 євро; 6 євро → одна не влазить, жодна не стоїть на арці', () => {
    expect(run(SPRINTER, { mode: 'empty' }, [], { arch: SPR_ARCH }).r.max).toBe(5);
    const { r, arches } = run(SPRINTER, { mode: 'empty' }, [pal('a', 'euro', 6, 1500, 250)], { arch: SPR_ARCH });
    expect(r.placed).toHaveLength(5);
    expect(r.unplaced).toHaveLength(1);
    for (const p of r.placed) for (const a of arches[0]) expect(overlap(p, a)).toBe(false);
  });
  it('водій: вільно 8 м і 5 м, 5 євро + 5 американок + гофра 12 м³ → без «зверху» не влізло ≈1,6 м³; із «зверху» — влазить', () => {
    const ex: ExistingSpec = { mode: 'meters', split: true, kind: 'free', s1: 8000, s2: 5000 };
    const items = (top: boolean): Item[] => [pal('e', 'euro', 5, 1600, 400), pal('a', 'amer', 5, 1600, 500), { id: 'g', kind: 'bulk', name: 'Гофра', m3: 12, kg: 900, top }];
    const no = run(TENT, ex, items(false)).r;
    expect(no.unplaced).toHaveLength(0);
    expect(no.bulk.left).toHaveLength(1);
    expect(no.bulk.left[0].m3.toFixed(1)).toBe('1.6');
    const yes = run(TENT, ex, items(true)).r;
    expect(yes.bulk.left).toHaveLength(0);
    expect(yes.bulk.tops.flat().length).toBeGreaterThan(0);
  });
  it('дві точки: те, що вивантажують першим (Львів, 1), стоїть ближче до дверей за Київ (2) — 0 порушень', () => {
    const { r } = run(TENT, { mode: 'empty' }, [pal('kyiv', 'euro', 14, 1600, 450, 2), pal('lviv', 'amer', 8, 1500, 600, 1)]);
    expect(r.mode).toBe('ordered');
    expect(r.unplaced).toHaveLength(0);
    let bad = 0;
    for (const a of r.placed.filter(p => p.gid === 'lviv')) for (const k of r.placed.filter(p => p.gid === 'kyiv')) if (laneOverlap(a, k) && a.x < k.x + k.l) bad++;
    expect(bad).toBe(0);
  });
  it('конфлікт: наявний вивантажують першим (точка 1), наш — 2 → за точками не влазить, щільно — влазить', () => {
    const ex: ExistingSpec = { mode: 'meters', split: true, kind: 'free', s1: 8000, s2: 5000, stop: 1 };
    const items = [pal('our', 'euro', 8, 1600, 400, 2)];
    const ordered = run(TENT, ex, items).r;
    expect(ordered.mode).toBe('ordered');
    expect(ordered.unplaced).toHaveLength(8);
    expect(ordered.alt).toEqual({ dense: 0, ordered: 8 });
    const dense = run(TENT, ex, items, { layoutMode: 'dense' }).r;
    expect(dense.mode).toBe('dense');
    expect(dense.unplaced).toHaveLength(0);
  });
  it('межа бортів: перетягнута на 0,8 м — смуги наявного вантажу 0,8 і 1,65 м', () => {
    const ex = buildExisting({ mode: 'meters', split: true, kind: 'free', s1: 8000, s2: 5000, splitY: 800 }, TENT);
    expect(ex[0].map(o => [o.y, o.w, o.l])).toEqual([[0, 800, 5600], [800, 1650, 8600]]);
  });
});

describe('вантажі різних видів', () => {
  it('коробки «ярусами до стелі»: у стосі floor(H / h) шарів', () => {
    const { r } = run([{ L: 6200, W: 2450, H: 2400 }], { mode: 'empty' }, [{ id: 'b', kind: 'box', name: 'Коробки', l: 600, w: 400, h: 400, qty: 13, kg: 15, stack: true }]);
    expect(r.units.map(u => u.layers)).toEqual([6, 6, 1]);
    expect(r.kgOur).toBe(13 * 15);
  });
  it('рулони, довші за висоту кузова: «стоячи» — «вищі за кузов», авто обирає лежачи', () => {
    const { r } = run([{ L: 7200, W: 2450, H: 2500 }], { mode: 'empty' }, [{ id: 'r', kind: 'roll', name: 'Рулони', d: 700, len: 2600, qty: 6, kg: 300, variant: 'auto' }]);
    const stand = r.variantInfo.r.find(v => v.v === 'stand')!;
    expect(stand.reason).toBe('вищі за кузов');
    expect(stand.left).toBe(6);
    expect(r.chosen.r).not.toBe('stand');
    expect(r.unplaced).toHaveLength(0);
  });
  it('палети без висоти рахуються, але простір над ними не відомий', () => {
    const { r } = run([{ L: 7200, W: 2450, H: 2500 }], { mode: 'empty' }, [pal('n', 'euro', 10, 0, 300)]);
    expect(r.placed).toHaveLength(10);
    expect(r.above).toBe(0);
  });
  it('вага: сума відомих; позиції без ваги рахуються окремо', () => {
    const { r } = run([{ L: 7200, W: 2450, H: 2500 }], { mode: 'empty' }, [pal('a', 'euro', 5, 1500, 0), pal('b', 'euro', 3, 1500, 400), { id: 'g', kind: 'bulk', name: 'М', m3: 1, kg: 250 }]);
    expect(r.kgOur).toBe(3 * 400 + 250);
    expect(r.kgMissing).toBe(5);
  });
  it('вищий за кузов — не влазить', () => {
    const { r } = run([{ L: 7200, W: 2450, H: 2500 }], { mode: 'empty' }, [pal('a', 'euro', 2, 2600, 300)]);
    expect(r.unplaced).toHaveLength(2);
  });
});

describe('ручне пересування', () => {
  const body = { L: 7200, W: 2450, H: 2500 };
  it('за межі кузова — «out», на інше місце — «hit», з урахуванням зазору', () => {
    expect(checkMove(body, { x: 6500, y: 0, l: 1200, w: 800 }, [], 0)).toEqual({ ok: false, why: 'out' });
    const other = { x: 1200, y: 0, l: 1200, w: 800 };
    expect(checkMove(body, { x: 0, y: 0, l: 1200, w: 800 }, [other], 0).ok).toBe(true);
    expect(checkMove(body, { x: 0, y: 0, l: 1200, w: 800 }, [other], 10).ok).toBe(false);
  });
  it('порушення порядку точок помічається', () => {
    const later = { x: 3000, y: 0, l: 1200, w: 800, stop: 2 };
    expect(orderBreaks({ x: 0, y: 0, l: 1200, w: 800 }, 1, [later])).toHaveLength(1);   // точка 1 глибше за точку 2
    expect(orderBreaks({ x: 4200, y: 0, l: 1200, w: 800 }, 1, [later])).toHaveLength(0);
    expect(orderBreaks({ x: 0, y: 1000, l: 1200, w: 800 }, 1, [later])).toHaveLength(0);  // інша смуга
  });
});

describe('арки', () => {
  it('дві арки біля бортів, ширина = (W − між арками) / 2', () => {
    const a = archObstacles(SPRINTER, SPR_ARCH)[0];
    expect(a.map(o => [o.x, o.y, o.l, o.w])).toEqual([[2270, 0, 1000, 219], [2270, 1568, 1000, 219]]);
  });
  it('арка не влазить у кузов (кузов коротший) — арок немає; без довідника — немає', () => {
    expect(archObstacles([{ L: 3000, W: 1787, H: 1974 }], SPR_ARCH)).toEqual([[]]);
    expect(archObstacles(SPRINTER, null)).toEqual([[]]);
  });
});

describe('інваріанти на 80 випадкових сценаріях', () => {
  for (let seed = 101; seed <= 180; seed++) {
    it(`зерно ${seed}`, () => {
      const s = randomScenario(seed);
      const existing = buildExisting(s.ex, s.bodies);
      const arches = archObstacles(s.bodies, s.arch);
      const r = analyze({ bodies: s.bodies, arches, existing, items: s.items, gap: s.gap, countType: s.countType, layoutMode: s.layoutMode, splitY: s.splitY });
      expect(r.placed.length + r.unplaced.length).toBe(r.units.length);
      const g = s.gap || 0;
      s.bodies.forEach((b, bi) => {
        const mine = r.placed.filter(p => p.body === bi);
        const obst: Obstacle[] = [...arches[bi], ...existing[bi]];
        for (const p of mine) {
          expect(p.x).toBeGreaterThanOrEqual(0); expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.x + p.l).toBeLessThanOrEqual(b.L); expect(p.y + p.w).toBeLessThanOrEqual(b.W);
          expect(p.h > b.H).toBe(false);
          for (const o of obst) expect(overlap(grow(p, g), grow(o, g))).toBe(false);
          for (const q of mine) if (q !== p) expect(overlap(grow(p, g), grow(q, g))).toBe(false);
        }
        if (r.mode === 'ordered') {
          const all = [...existing[bi].filter(o => o.stop), ...mine.filter(p => p.stop)] as Array<Obstacle & { stop?: number }>;
          for (const p of mine) if (p.stop) expect(orderBreaks(p, p.stop, all.filter(q => q !== p))).toHaveLength(0);
        }
      });
    });
  }
});

function overlap(a: { x: number; y: number; l: number; w: number }, b: { x: number; y: number; l: number; w: number }) {
  return a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.w && b.y < a.y + a.w;
}
const grow = (o: { x: number; y: number; l: number; w: number }, g: number) => ({ x: o.x, y: o.y, l: o.l + g, w: o.w + g });
const laneOverlap = (a: Placed, b: Placed) => a.y < b.y + b.w && b.y < a.y + a.w;
