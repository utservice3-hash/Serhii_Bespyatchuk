/** Довідник «стандарт», сід міграції, перевірка й підпис збережених розрахунків. */
import { describe, expect, it } from './shim.js';
import { readFileSync } from 'node:fs';
import { DEFAULT_PALLETS, DEFAULT_VEHICLES, palletMap } from '../cargoDefaults.js';
import { PALLETS } from '../cargoEngine.js';
import { checkCalcState, checkLayout, checkPalletRows, checkVehicles, summarize, type CalcState } from '../cargoState.js';
import { join } from 'node:path';
import { seedBlockOf, seedSql } from '../cargoSeed.js';
// [дашборд] міграція пакета живе в нашій schema.sql — сід звіряється з нею
const MIGRATION = join(import.meta.dirname, '..', '..', '..', 'src', 'db', 'schema.sql');

describe('довідник «стандарт»', () => {
  it('сід у міграції = shared/cargoDefaults.ts (у дашборді — блок SEED у schema.sql = cargoSeed.seedSql())', () => {
    expect(seedBlockOf(readFileSync(MIGRATION, 'utf8'))).toBe(seedSql());
  });
  it('палети рушія за замовчуванням = довідник', () => { expect(PALLETS).toEqual(palletMap(DEFAULT_PALLETS)); });
  it('стандартні авто проходять перевірку сервера', () => {
    expect(checkVehicles(DEFAULT_VEHICLES)).toBeNull();
    expect(checkPalletRows(DEFAULT_PALLETS, DEFAULT_PALLETS.map(p => p.key))).toBeNull();
  });
  it('рішення інтерв\'ю: Sprinter/Master-тент 2–2,5 т; мега, реф, зчіпка 22 т; тент 20 т; Master-тент 4,8 × 2,2 × 2,5', () => {
    const v = Object.fromEntries(DEFAULT_VEHICLES.map(x => [x.id, x]));
    for (const id of ['spr-l3', 'spr-l4', 'master-tent']) expect([v[id].kg, v[id].kgMax]).toEqual([2000, 2500]);
    for (const id of ['mega', 'ref', 'jumbo']) expect(v[id].kg).toBe(22000);
    expect(v.tent.kg).toBe(20000);
    expect(v['master-tent'].bodies).toEqual([{ L: 4800, W: 2200, H: 2500 }]);
    expect(v.jumbo.bodies).toHaveLength(2);
    expect(DEFAULT_PALLETS.map(p => p.key)).toEqual(['euro', 'amer', 'finn', 'half', 'square']);
  });
});

const base: CalcState = {
  veh: 'tent', bodies: [{ L: 13600, W: 2450, H: 2700 }], kg: 20000, kgMax: null, arch: null,
  ex: { mode: 'meters', split: true, kind: 'free', s1: 8000, s2: 5000, splitY: 1700, kg: 3000, stop: 1 },
  items: [{ id: 'i1', kind: 'pallet', name: 'Палети Київ', ptype: 'euro', l: 1200, w: 800, h: 1600, qty: 8, kg: 400, stop: 2, c: 1 },
    { id: 'i2', kind: 'roll', name: 'Рулони', d: 600, len: 2200, qty: 4, kg: 300, variant: 'auto', c: 2 },
    { id: 'i3', kind: 'bulk', name: 'Гофра', m3: 12, kg: 900, top: true, c: 3 }],
  gap: 10, multi: true, stops: { 1: 'Рівне', 2: 'Київ' },
};
describe('перевірка розрахунку перед збереженням', () => {
  it('нормальний розрахунок проходить', () => { expect(checkCalcState(base)).toBeNull(); });
  it.each([
    ['3 кузови', { ...base, bodies: [base.bodies[0], base.bodies[0], base.bodies[0]] }],
    ['кузов 40 м', { ...base, bodies: [{ L: 40000, W: 2450, H: 2700 }] }],
    ['невідомий вид', { ...base, items: [{ ...base.items[0], kind: 'ракета' }] }],
    ['кількість −1', { ...base, items: [{ ...base.items[0], qty: -1 }] }],
    ['точка 7', { ...base, stops: { 7: 'Одеса' } }],
    ['61 позиція', { ...base, items: Array.from({ length: 61 }, (_, i) => ({ ...base.items[0], id: 'x' + i })) }],
    ['невідомий спосіб «вже в авто»', { ...base, ex: { mode: 'kubometry' } }],
    ['варіант «боком»', { ...base, items: [{ ...base.items[1], variant: 'bokom' }] }],
  ])('%s → помилка', (_n, s) => { expect(checkCalcState(s)).toMatch(/\S/); });
  it('розкладка: формат і межі', () => {
    expect(checkLayout(null)).toBeNull();
    expect(checkLayout({ placed: [{ uid: 'i1-0', x: 0, y: 0, l: 1200, w: 800, body: 0 }], exr: [[]], manual: true, mode: 'dense' })).toBeNull();
    expect(checkLayout({ placed: [{ uid: 'i1-0', x: 0, y: 0, l: 1200, w: 800, body: 2 }], exr: [[]], manual: true, mode: 'auto' })).toMatch(/місце/);
    expect(checkLayout({ placed: [], exr: [[]], manual: 'так', mode: 'auto' })).toMatch(/формат/);
  });
});

describe('підпис рядка історії', () => {
  it('авто з довідника + позиції; насипом — у м³', () => {
    expect(summarize(base, 'Тент 13,6 м')).toEqual({ vehicle: 'Тент 13,6 м', items: '8 × палети київ, 4 × рулони, гофра 12,0 м³' });
  });
  it('свої розміри й порожньо', () => {
    expect(summarize({ ...base, veh: 'custom', bodies: [{ L: 7200, W: 2400, H: 2400 }], items: [] })).toEqual({ vehicle: '7,20 × 2,40 × 2,40 м', items: 'вільне місце' });
  });
});
