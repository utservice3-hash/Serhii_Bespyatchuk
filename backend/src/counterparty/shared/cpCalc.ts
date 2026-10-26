/**
 * Розрахунок у запиті на погодження: скільки днів фінансуємо, маржа за рейс і на місяць, орієнтовний борг клієнта.
 *
 * Маржа — «Формули для підрахунку ЗП» (Сергій, 23.10). Пара «форма оплати клієнта (прихід) → форма оплати перевізнику (розхід)»:
 *   1. Готівка (клієнт платить готівкою, перевізнику — будь-як): прихід − розхід
 *   2. Б/г з ПДВ → б/г з ПДВ:       (прихід − розхід) − 24 %       = (прихід × 0,76) − (розхід × 0,76)
 *   3. Б/г з ПДВ → б/г без ПДВ:     (прихід − 24 %) − розхід       = (прихід × 0,76) − розхід
 *   4. Б/г з ПДВ → готівка:         (прихід − 26 %) − розхід
 *   5. Б/г без ПДВ → б/г з ПДВ / без ПДВ (однаково): (прихід − розхід) − 6 % = (прихід − розхід) × 0,94
 *   6. Б/г без ПДВ → готівка:       (прихід − 8 %) − розхід
 *   ❗ Якщо розхід > прихід → % не віднімаємо: прихід − розхід.
 * Суми — у гривнях: € і $ переводимо за курсом НБУ (rates). «Розхід > прихід» — строго більше, як у формулі.
 */
import { num, type Cur, type From, type PayForm, type Rates, type TermsInput } from './counterparty.js';
import { dayW, money, rate2, tripsW } from './cpFormat.js';

/** Через скільки днів після вивантаження настає подія, від якої рахують дні. Оригінали — налаштування (за замовчуванням 10). */
export type Lag = Record<From, number>;
export const DEFAULT_LAG: Lag = { od: 0, inv: 0, orig: 10 };

/** Профіт (маржа) за формулами ЗП. P — прихід (що платить клієнт), R — розхід (що платимо перевізнику), обидва в грн. */
export function profit(P: number, inPay: PayForm, R: number, outPay: PayForm): number {
  if (R > P || inPay === 'cash') return P - R;
  if (inPay === 'vat') return outPay === 'vat' ? (P - R) * 0.76 : outPay === 'novat' ? P * 0.76 - R : P * 0.74 - R;
  return outPay === 'cash' ? P * 0.92 - R : (P - R) * 0.94;
}
/** Яка формула застосована — підпис під розрахунком. */
export function profitFormula(inPay: PayForm, outPay: PayForm, P?: number, R?: number): string {
  if (P !== undefined && R !== undefined && P > 0 && R > 0 && R > P) return 'розхід більший за прихід — % не віднімаємо: прихід − розхід';
  if (inPay === 'cash') return 'прихід − розхід';
  if (inPay === 'vat') return outPay === 'vat' ? '(прихід − розхід) − 24 %' : outPay === 'novat' ? 'прихід − 24 % − розхід' : 'прихід − 26 % − розхід';
  return outPay === 'cash' ? 'прихід − 8 % − розхід' : '(прихід − розхід) − 6 %';
}

/** Сума в гривнях. Курсу немає (НБУ недоступний) → NaN: маржу й борг у валюті не рахуємо, а не рахуємо неправильно. */
export const toUah = (x: number, cur: Cur, rates: Pick<Rates, 'eur' | 'usd'>) => (cur === 'uah' ? x : rates[cur] > 0 ? x * rates[cur] : NaN);

export interface Calc {
  tc?: number;       // днів, доки платить клієнт (від вивантаження)
  tk?: number;       // днів, доки платимо перевізнику (від вивантаження)
  gap?: number;      // скільки днів фінансуємо: tc − tk
  margin?: number;   // маржа за рейс, грн (округлено до 10)
  marginM?: number;  // маржа на місяць
  debt?: number;     // орієнтовний борг клієнта: рейсів × ставка клієнта × tc / 30 (округлено до 1 000)
}
export function calc(t: TermsInput, rates: Pick<Rates, 'eur' | 'usd'>, lag: Lag = DEFAULT_LAG): Calc {
  const cd = num(t.cl.days), kd = num(t.ca.days), cr = num(t.cl.rate), kr = num(t.ca.rate), tr = num(t.trips), o: Calc = {};
  if (Number.isInteger(cd) && Number.isInteger(kd) && cd >= 0 && kd >= 0) { o.tc = cd + lag[t.cl.from]; o.tk = kd + lag[t.ca.from]; o.gap = o.tc - o.tk; }
  const P = toUah(cr, t.cl.cur, rates), R = toUah(kr, t.ca.cur, rates);
  if (P > 0 && R > 0) o.margin = Math.round(profit(P, t.cl.pay, R, t.ca.pay) / 10) * 10;
  const trOk = Number.isInteger(tr) && tr > 0;
  if (o.margin !== undefined && trOk) o.marginM = o.margin * tr;
  if (P > 0 && trOk && o.tc !== undefined) o.debt = Math.round(tr * P * o.tc / 30 / 1000) * 1000;
  return o;
}

export const gapText = (o: Calc) => (o.gap === undefined ? '—' : o.gap > 0 ? `≈ ${dayW(o.gap)}` : 'не фінансуємо');
export const debtText = (o: Calc) => (o.debt === undefined ? '—' : `до ≈ ${money(o.debt)}`);

/** Три рядки розрахунку (як у макеті): [підпис, значення, пояснення, тон]. */
export function calcRows(t: TermsInput, rates: Pick<Rates, 'eur' | 'usd'>, lag: Lag = DEFAULT_LAG): Array<[string, string, string, '' | 'okv' | 'neg']> {
  const o = calc(t, rates, lag), tr = num(t.trips), cl = t.cl;
  return [
    ['Фінансуємо', gapText(o),
      o.gap === undefined ? 'заповніть дні з обох боків' : o.gap > 0 ? `платимо перевізнику на ${dayW(o.gap)} раніше, ніж платить клієнт` : 'клієнт платить не пізніше, ніж ми перевізнику',
      o.gap !== undefined && o.gap <= 0 ? 'okv' : ''],
    ['Маржа', o.margin === undefined ? '—' : o.margin > 0 ? `≈ ${money(o.margin)} за рейс` : `мінус ≈ ${money(o.margin)} за рейс`,
      o.margin === undefined ? 'заповніть обидві ставки' : o.margin <= 0 ? 'рейси з цим клієнтом будуть мінусові' : o.marginM !== undefined ? `≈ ${money(o.marginM)} на місяць` : 'вкажіть рейсів на місяць',
      o.margin !== undefined && o.margin <= 0 ? 'neg' : ''],
    ['Борг клієнта', debtText(o), o.debt === undefined ? 'заповніть дні, ставку клієнта й рейси'
      : `${tripsW(tr)} × ${money(num(cl.rate), cl.cur)}${cl.cur !== 'uah' ? ` × ${rate2(rates[cl.cur])}` : ''} × ${o.tc} дн. / 30`, ''],
  ];
}
/** Підпис під розрахунком: яка формула маржі, як рахуються дні, курс. */
export function calcNote(t: TermsInput, rates: Pick<Rates, 'eur' | 'usd'>, lag: Lag = DEFAULT_LAG): string {
  const P = num(t.cl.rate) > 0 ? toUah(num(t.cl.rate), t.cl.cur, rates) : undefined;
  const R = num(t.ca.rate) > 0 ? toUah(num(t.ca.rate), t.ca.cur, rates) : undefined;
  const pay = { vat: 'безготівка з ПДВ', novat: 'безготівка без ПДВ', cash: 'готівка' };
  return `Маржа — за формулою ЗП «${pay[t.cl.pay]} → ${pay[t.ca.pay]}»: ${profitFormula(t.cl.pay, t.ca.pay, P, R)}. `
    + `Оригінали — через ${dayW(lag.orig)} після вивантаження, рахунок — ${lag.inv ? `через ${dayW(lag.inv)} після вивантаження` : 'у день вивантаження'}. € і $ — за курсом НБУ.`;
}
