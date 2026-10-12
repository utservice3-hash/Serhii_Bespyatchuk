/** Схема зверху — чиста функція: перевіряємо те, що бачить перевізник на PNG і менеджер на екрані. */
import { describe, expect, it } from './shim.js';
import { analyze, archObstacles, buildExisting, type Body, type Item } from '../cargoEngine.js';
import { drawTopView } from './frontTopView.js'; // [дашборд] джерело фронту

const TENT: Body[] = [{ L: 13600, W: 2450, H: 2700 }];
function view(bodies: Body[], items: Item[], o: { ex?: Parameters<typeof buildExisting>[0]; multi?: boolean; exp?: boolean; width?: number; arch?: { between: number; len: number; x: number; h: number } } = {}) {
  const existing = buildExisting(o.ex || { mode: 'empty' }, bodies), arches = archObstacles(bodies, o.arch);
  const result = analyze({ bodies, arches, existing, items, gap: 0, countType: 'euro' });
  return drawTopView({ bodies, arches, existing, result, items, sel: null, multi: !!o.multi, lane: false, width: o.width || 1100, exp: !!o.exp, idp: 'cc9-' });
}
const pal = (id: string, name: string, ptype: string, qty: number, h: number, stop = 0, c = 1): Item => ({ id, kind: 'pallet', name, ptype, qty, h, kg: 400, stop, c });

describe('схема зверху', () => {
  it('кейс 19: наявні палети підписані «є», вільна довжина — 5,20 м', () => {
    const { svg } = view([{ L: 7200, W: 2400, H: 2400 }], [], { ex: { mode: 'pallets', type: 'euro', qty: 5, h: 1500 } });
    expect(svg.match(/class="u ex"/g)).toHaveLength(5);
    expect(svg).toContain('>є<');
    expect(svg).toContain('>5,20 м<');
  });
  it('назва й висота — прямо на місці; кружечки точок лише з «кілька точок»', () => {
    const items = [pal('k', 'Палети Київ', 'euro', 14, 1600, 2, 1), pal('l', 'Американки Львів', 'amer', 8, 1500, 1, 2)];
    const on = view(TENT, items, { multi: true }).svg, off = view(TENT, items.map(i => ({ ...i, stop: 0 }))).svg;
    expect(on).toContain('>Палети Київ<');
    expect(on).toContain('>1,60 м<');
    expect(on.match(/<circle [^>]*r="6.5"/g)!.length).toBe(22);
    expect(off).not.toMatch(/r="6.5"/);
  });
  it('дрібне — номером позиції, і номер іде в розшифровку PNG', () => {
    const { svg, nums } = view(TENT, [pal('a', 'Дуже довга назва позиції', 'half', 6, 1000)], { width: 700 });
    expect([...nums]).toEqual(['a']);
    expect(svg).toMatch(/font-weight="700"[^>]*>1<\/text>/);
  });
  it('PNG-режим: світлі кольори літералами, Arial, біле тло; на екрані — змінні теми', () => {
    const items = [pal('a', 'Палети', 'euro', 4, 1500)];
    const png = view(TENT, items, { exp: true }).svg, scr = view(TENT, items).svg;
    expect(png).not.toContain('var(--');
    expect(png).toContain('font-family="Arial, Helvetica, sans-serif"');
    expect(png).toContain('fill="#ffffff"');
    expect(scr).toContain('var(--c1)');
  });
  it('арки Sprinter намальовано й підписано', () => {
    const { svg } = view([{ L: 4307, W: 1787, H: 1974 }], [], { arch: { between: 1350, len: 1000, x: 2270, h: 300 } });
    expect(svg.match(/>арка</g)).toHaveLength(2);
  });
  it('візерунки мають префікс екземпляра (id не конфліктують з дашбордом)', () => {
    const { svg } = view(TENT, [{ id: 'g', kind: 'bulk', name: 'Гофра', m3: 5, kg: 0, c: 3 }]);
    expect(svg).toContain('id="cc9-hx"');
    expect(svg).toContain('url(#cc9-hb3)');
    expect(svg).not.toMatch(/id="h[xbt]/);
  });
});
