// Тест пакета Сергія (24.10.2026) дослівно, vitest → `vitestShim`; гейт — `counterparty/counterparty.test.ts`.
import { describe, expect, it } from './vitestShim.js';
import {
  allowedActions, askedLines, canSee, checkCode, diffLines, inFilter, needsMe, normTerms, parseTerms, sameTerms, seesOthers, termsErr,
  type CpRequest, type CpUser, type Terms,
} from '../shared/counterparty.js';

const marina: CpUser = { id: 'u-marina', name: 'Марина', role: 'manager' };
const iryna: CpUser = { id: 'u-iryna', name: 'Ірина', role: 'lead', team: ['u-marina'] };
const oleh: CpUser = { id: 'u-oleh', name: 'Олег', role: 'manager' };
const serhii: CpUser = { id: 'u-serhii', name: 'Сергій', role: 'approver' };
const buh: CpUser = { id: 'u-buh', name: 'Бухгалтерія', role: 'accounting' };
const andrii: CpUser = { id: 'u-andrii', name: 'Андрій', role: 'staff' };
const terms: Terms = { cl: { days: 30, from: 'orig', pay: 'vat', rate: 34000, cur: 'uah' }, ca: { days: 7, from: 'orig', pay: 'novat', rate: 24500, cur: 'uah' }, trips: 12, ent: 'uts', limit: 550000 };
const Q = (o: Partial<CpRequest>): Pick<CpRequest, 'status' | 'change' | 'flag' | 'createdBy' | 'resident'> => ({ status: 'pending', change: null, flag: null, createdBy: 'u-marina', resident: true, ...o });

describe('права', () => {
  it('менеджер бачить свої, тім-лід — свої й команди, Сергій і бухгалтерія — усі', () => {
    expect(canSee(marina, { createdBy: 'u-marina' })).toBe(true);
    expect(canSee(marina, { createdBy: 'u-oleh' })).toBe(false);
    expect(canSee(iryna, { createdBy: 'u-marina' })).toBe(true);
    expect(canSee(iryna, { createdBy: 'u-oleh' })).toBe(false);
    expect(canSee(serhii, { createdBy: 'u-oleh' })).toBe(true);
    expect(canSee(buh, { createdBy: 'u-oleh' })).toBe(true);
    expect(seesOthers(iryna)).toBe(true); expect(seesOthers(marina)).toBe(false);
  });
  it('Сергій: на погодженні — погодити / змінити й погодити / повернути / відхилити / перевірити заново; нерезидента не перевіряємо', () => {
    expect(allowedActions(serhii, Q({}))).toEqual(['approve', 'approveChanged', 'return', 'reject', 'recheck']);
    expect(allowedActions(serhii, Q({ resident: false }))).toEqual(['approve', 'approveChanged', 'return', 'reject']);
    expect(allowedActions(serhii, Q({ status: 'approved', change: { terms, reason: 'x', by: 'u-oleh', byName: 'Олег', at: '' } }))).toEqual(['changeApprove', 'changeReject']);
    expect(allowedActions(serhii, Q({ status: 'approved' }))).toEqual([]);
    expect(allowedActions(serhii, Q({ status: 'checking' }))).toEqual([]);
  });
  it('менеджер: повернуте — надіслати повторно; погоджене — запросити зміну; тім-лід над чужим — нічого', () => {
    expect(allowedActions(marina, Q({ status: 'returned' }))).toEqual(['resubmit']);
    expect(allowedActions(marina, Q({ status: 'approved' }))).toEqual(['requestChange']);
    expect(allowedActions(marina, Q({ status: 'approved', change: { terms, reason: 'x', by: 'u-marina', byName: 'М', at: '' } }))).toEqual([]);
    expect(allowedActions(oleh, Q({ status: 'returned' }))).toEqual([]);
    expect(allowedActions(iryna, Q({ status: 'returned' }))).toEqual([]);
    expect(allowedActions(buh, Q({}))).toEqual([]);
    expect(allowedActions(andrii, Q({}))).toEqual([]);
  });
  it('лічильник: Сергію — на погодженні й зміни умов; менеджеру — свої повернуті', () => {
    expect(needsMe(serhii, Q({}))).toBe(true);
    expect(needsMe(serhii, Q({ status: 'approved', change: { terms, reason: '', by: '', byName: '', at: '' } }))).toBe(true);
    expect(needsMe(serhii, Q({ status: 'checking' }))).toBe(false);
    expect(needsMe(marina, Q({ status: 'returned' }))).toBe(true);
    expect(needsMe(iryna, Q({ status: 'returned' }))).toBe(false);
  });
  it('фільтр «На погодженні» включає запити на зміну умов', () => {
    expect(inFilter(Q({ status: 'approved', change: { terms, reason: '', by: '', byName: '', at: '' } }), 'pending')).toBe(true);
    expect(inFilter(Q({ status: 'approved' }), 'pending')).toBe(false);
  });
});

describe('перевірки вводу', () => {
  it('код: 8 або 10 цифр', () => {
    expect(checkCode('41234567')).toBeNull(); expect(checkCode('30 1234 5678')).toBeNull();
    expect(checkCode('1234')).toBe('Введіть ЄДРПОУ (8 цифр) або ІПН ФОП (10 цифр).');
  });
  it('чого бракує в умовах — тексти як у формі', () => {
    expect(termsErr({ cl: { days: '', from: 'orig', pay: 'vat', rate: '', cur: 'uah' }, ca: { days: '0', from: 'orig', pay: 'novat', rate: '1', cur: 'uah' }, trips: '', ent: 'uts', limit: '' }))
      .toEqual(['дні клієнта', 'ставка клієнта', 'рейсів на місяць', 'ліміт боргу']);
    expect(termsErr({ ...terms, cl: { ...terms.cl, days: '0' } })).toEqual(['дні клієнта']);
  });
  it('сервер: умови з JSON — числа з рядків, невідомі значення відхиляються', () => {
    const p = parseTerms({ ...terms, cl: { ...terms.cl, rate: '34 000' }, limit: '550000' });
    expect('terms' in p && p.terms.cl.rate).toBe(34000);
    expect(parseTerms({ ...terms, ent: 'xxx' })).toEqual({ error: 'Заповніть умови оплати.' });
    expect(parseTerms({ ...terms, trips: 0 })).toEqual({ error: 'Заповніть: рейсів на місяць.' });
  });
  it('що змінилось — рядки для історії', () => {
    const ok = normTerms({ ...terms, cl: { ...terms.cl, days: 21 }, limit: 420000 });
    expect(diffLines(terms, ok)).toEqual(['Клієнт платить: 30 днів від отримання оригіналів → 21 день від отримання оригіналів', 'Ліміт боргу: 550 000 грн → 420 000 грн']);
    expect(askedLines(ok, terms)).toEqual(['клієнт платить 30 днів від отримання оригіналів', 'ліміт боргу 550 000 грн']);
    expect(sameTerms(terms, { ...terms, limit: '550000' })).toBe(true);
  });
});
