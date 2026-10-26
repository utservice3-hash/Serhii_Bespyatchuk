// Тест пакета Сергія (24.10.2026) дослівно, vitest → `vitestShim`; гейт — `counterparty/counterparty.test.ts`.
import { describe, expect, it } from './vitestShim.js';
import { blankTerms, type PayForm, type TermsInput } from '../shared/counterparty.js';
import { calc, calcNote, calcRows, profit, profitFormula } from '../shared/cpCalc.js';

const R8 = { eur: 50.35, usd: 44.98 };
type Cur = 'uah' | 'eur' | 'usd';
type S = [number, string, PayForm, number] | [number, string, PayForm, number, Cur];
const T = (cl: S, ca: S, trips: number, limit = 100000): TermsInput => ({
  cl: { days: cl[0], from: cl[1] as 'od', pay: cl[2], rate: cl[3], cur: cl[4] || 'uah' },
  ca: { days: ca[0], from: ca[1] as 'od', pay: ca[2], rate: ca[3], cur: ca[4] || 'uah' },
  trips, ent: 'uts', limit,
});

describe('профіт — «Формули для підрахунку ЗП» (Сергій, 23.10)', () => {
  // [клієнт, перевізник, прихід, розхід, очікуваний профіт]
  const cases: Array<[PayForm, PayForm, number, number, number]> = [
    ['cash', 'vat', 40000, 30000, 10000], ['cash', 'novat', 40000, 30000, 10000], ['cash', 'cash', 40000, 30000, 10000],   // 1. готівка (всі варіанти)
    ['vat', 'vat', 40000, 30000, 7600],                                                                                        // 2. (П − Р) − 24 %
    ['vat', 'novat', 40000, 30000, 400],                                                                                       // 3. П × 0,76 − Р
    ['vat', 'cash', 40000, 30000, -400],                                                                                       // 4. П − 26 % − Р
    ['novat', 'vat', 40000, 30000, 9400], ['novat', 'novat', 40000, 30000, 9400],                                             // 5. (П − Р) × 0,94
    ['novat', 'cash', 40000, 30000, 6800],                                                                                     // 6. П − 8 % − Р
  ];
  it.each(cases)('%s → %s: %d / %d → %d', (i, o, P, R, want) => { expect(profit(P, i, R, o)).toBeCloseTo(want, 6); });

  it('❗ розхід > прихід — % не віднімаємо, у всіх парах', () => {
    for (const i of ['vat', 'novat', 'cash'] as PayForm[]) for (const o of ['vat', 'novat', 'cash'] as PayForm[]) expect(profit(30000, i, 40000, o)).toBe(-10000);
  });
  it('рівні суми — % віднімається (строго «більше», як у формулі)', () => {
    expect(profit(40000, 'vat', 40000, 'novat')).toBeCloseTo(-9600, 6);
    expect(profit(40000, 'vat', 40000, 'vat')).toBe(0);
  });
  it('підпис формули — для пари і для «розхід більший»', () => {
    expect(profitFormula('vat', 'novat')).toBe('прихід − 24 % − розхід');
    expect(profitFormula('novat', 'vat')).toBe('(прихід − розхід) − 6 %');
    expect(profitFormula('cash', 'vat')).toBe('прихід − розхід');
    expect(profitFormula('vat', 'vat', 30000, 40000)).toBe('розхід більший за прихід — % не віднімаємо: прихід − розхід');
  });
});

describe('розрахунок у запиті', () => {
  it('фінансуємо, маржа за рейс і на місяць, борг — як у макеті (k3: 38 000 з ПДВ → 27 000 без ПДВ, 9 рейсів)', () => {
    const o = calc(T([30, 'orig', 'vat', 38000], [7, 'orig', 'novat', 27000], 9), R8);
    expect(o.tc).toBe(40); expect(o.tk).toBe(17); expect(o.gap).toBe(23);
    expect(o.margin).toBe(1880);                          // 38 000 × 0,76 − 27 000
    expect(o.marginM).toBe(16920);
    expect(o.debt).toBe(456000);                          // 9 × 38 000 × 40 / 30, до тисяч
  });
  it('валюта — за курсом НБУ (k5: 2 100 € і 1 650 € без ПДВ)', () => {
    const o = calc(T([45, 'od', 'novat', 2100, 'eur'], [14, 'orig', 'novat', 1650, 'eur'], 4), R8);
    expect(o.margin).toBe(21300);                         // (2 100 − 1 650) × 50,35 × 0,94 ≈ 21 298 → до десятків
    expect(o.debt).toBe(634000);                          // 4 × 2 100 × 50,35 × 45 / 30 = 634 410 → до тисяч
  });
  it('курсу немає — маржу й борг у валюті не рахуємо', () => {
    const o = calc(T([45, 'od', 'novat', 2100, 'eur'], [14, 'orig', 'novat', 1650, 'eur'], 4), { eur: 0, usd: 0 });
    expect(o.margin).toBeUndefined(); expect(o.debt).toBeUndefined(); expect(o.gap).toBe(21);   // 45 від вивантаження − (14 + 10 від оригіналів)
  });
  it('клієнт платить раніше за нас — «не фінансуємо»', () => {
    expect(calcRows(T([5, 'od', 'vat', 40000], [7, 'orig', 'vat', 30000], 2), R8)[0].slice(0, 2)).toEqual(['Фінансуємо', 'не фінансуємо']);
  });
  it('порожня форма — підказки замість чисел; підпис формули ЗП', () => {
    const rows = calcRows(blankTerms(true), R8);
    expect(rows.map(r => r[1])).toEqual(['—', '—', '—']);
    expect(rows[1][2]).toBe('заповніть обидві ставки');
    expect(calcNote(blankTerms(true), R8)).toBe('Маржа — за формулою ЗП «безготівка з ПДВ → безготівка без ПДВ»: прихід − 24 % − розхід. '
      + 'Оригінали — через 10 днів після вивантаження, рахунок — у день вивантаження. € і $ — за курсом НБУ.');
  });
  it('мінусова маржа — «рейси будуть мінусові»', () => {
    const r = calcRows(T([14, 'od', 'vat', 30000], [7, 'od', 'cash', 23000], 5), R8)[1];
    expect(r[1]).toBe('мінус ≈ 800 грн за рейс'); expect(r[3]).toBe('neg');   // 30 000 × 0,74 − 23 000 = −800
  });
  it('оригінали — налаштування (lag)', () => {
    expect(calc(T([30, 'orig', 'vat', 38000], [7, 'od', 'novat', 27000], 9), R8, { od: 0, inv: 0, orig: 14 }).tc).toBe(44);
  });
});
