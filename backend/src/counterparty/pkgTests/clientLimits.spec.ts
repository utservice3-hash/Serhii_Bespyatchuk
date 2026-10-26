// Тест пакета Сергія (24.10.2026) дослівно, vitest → `vitestShim`; гейт — `counterparty/counterparty.test.ts`.
import { describe, expect, it } from './vitestShim.js';
import { buildRows, cellsFor, dueDate, isNoLimit, limIn, limitActions, limitsBadge, overdueKind, overdueSplit, parseLimitInput, type ClientLimit, type Debtor, type LimitRow } from '../shared/clientLimits.js';
import type { CpUser } from '../shared/counterparty.js';

const L = (o: Partial<ClientLimit>): ClientLimit => ({
  id: '1', src: 'debt', requestId: null, debtorKey: null, name: 'ТОВ «А»', kind: 'ТОВ', members: [{ code: '11111111', name: 'ТОВ «А»' }],
  limit: 300000, days: 30, from: 'inv', ent: 'uts', pay: 'vat', terms: null, managerId: 'u-marina', managerName: 'Марина', at: '2026-10-22T08:00:00Z', note: '',
  flag: null, suspended: false, change: null, notice: null, lastCheck: null, hist: [], ...o,
});
const D = (o: Partial<Debtor>): Debtor => ({ key: 'd1', name: 'ТОВ «А»', codes: ['11111111'], managerId: 'u-marina', debt: 0, odDays: 0, odSum: 0, ageDays: 0, ...o });
const marina: CpUser = { id: 'u-marina', name: 'Марина', role: 'manager' };
const iryna: CpUser = { id: 'u-iryna', name: 'Ірина', role: 'lead', team: ['u-marina'] };
const serhii: CpUser = { id: 'u-serhii', name: 'Сергій', role: 'approver' };
const buh: CpUser = { id: 'u-buh', name: 'Бухгалтерія', role: 'accounting' };

describe('ліміти + дебіторка', () => {
  it('обʼєднаний клієнт: борг двох юросіб — разом; боржник без ліміту — окремим рядком; клітинки для колонки «Ліміти»', () => {
    const lim = L({ id: '1', members: [{ code: '38123456', name: 'ТОВ «Рівне-Агротрейд»' }, { code: '42001133', name: 'ТОВ «Рівне-Агро Логістик»' }] });
    const { rows, cells } = buildRows([lim], [
      D({ key: 'rivne', codes: ['38123456', '42001133'], debt: 355000 }),
      D({ key: 'tekh', name: 'ТОВ «Техноген-Пак»', codes: ['39445566'], debt: 252000, ageDays: 17 }),
      D({ key: 'zero', codes: ['99999999'], debt: 0 }),
    ]);
    const r = rows[0] as LimitRow;
    expect([r.debt, r.over, r.use, r.alert]).toEqual([355000, true, 118, true]);
    expect(rows.filter(isNoLimit).map(x => [x.id, x.debt, x.ageDays])).toEqual([['D-tekh', 252000, 17]]);
    expect(cells.rivne).toMatchObject({ limitId: '1', status: 'over', limit: 300000, days: 30 });
    expect(cells.tekh.status).toBe('none');
    expect(cells.zero.status).toBe('none');
  });
  it('звʼязок за ключем боржника, навіть без ЄДРПОУ в дебіторці', () => {
    const { rows } = buildRows([L({ debtorKey: 'k-7', members: [] })], [D({ key: 'k-7', codes: [], debt: 92000, odDays: 9, odSum: 41000 })]);
    expect(rows.length).toBe(1);
    expect((rows[0] as LimitRow).odDays).toBe(9);
  });
  it('фільтри й лічильник: перевищено + прострочено + нова справа; бухгалтерії — без лічильника', () => {
    const { rows } = buildRows([L({ id: '1' }), L({ id: '2', members: [{ code: '22222222', name: 'Б' }], flag: { at: '', what: '' }, suspended: true }), L({ id: '3', src: 'req', members: [{ code: '33333333', name: 'В' }] })],
      [D({ key: 'a', codes: ['11111111'], debt: 100 }), D({ key: 'b', codes: ['22222222'], debt: 0 })]);
    expect(rows.filter(x => limIn(x, 'court')).map(x => x.id)).toEqual(['2']);
    expect(rows.filter(x => limIn(x, 'debt')).map(x => x.id)).toEqual(['1', '2']);
    expect(limitsBadge(serhii, rows)).toBe(1);
    expect(limitsBadge(buh, rows)).toBe(0);
  });
  it('дії: Сергій — змінити / лишити / задати; менеджер — через запит; тім-лід — перегляд', () => {
    const r = (o: Partial<ClientLimit>) => buildRows([L(o)], []).rows[0];
    expect(limitActions(serhii, r({}))).toEqual(['edit']);
    expect(limitActions(serhii, r({ suspended: true, flag: { at: '', what: '' } }))).toEqual(['keep', 'edit']);
    expect(limitActions(serhii, r({ src: 'req', suspended: true }))).toEqual(['openReq']);
    expect(limitActions(marina, r({}))).toEqual(['apply']);
    expect(limitActions(marina, r({ src: 'req' }))).toEqual(['requestChange']);
    expect(limitActions(iryna, r({}))).toEqual([]);
    const none = buildRows([], [D({ key: 'n', debt: 5 })]).rows[0];
    expect(limitActions(serhii, none)).toEqual(['set']);
    expect(limitActions(marina, none)).toEqual(['applyNew']);
  });
  it('введення ліміту: сума, дні, від чого, причина', () => {
    expect(parseLimitInput({ limit: '150 000', days: '14', from: 'orig', reason: 'Платить вчасно' })).toEqual({ limit: 150000, days: 14, from: 'orig', reason: 'Платить вчасно' });
    expect(parseLimitInput({ limit: '', days: '14', from: 'orig', reason: 'x' })).toEqual({ error: 'Вкажіть ліміт і дні відтермінування.' });
    expect(parseLimitInput({ limit: 1, days: 14, from: 'orig', reason: ' ' })).toEqual({ error: 'Напишіть причину.' });
  });
  it('термін оплати рахунку: від вивантаження / рахунку / оригіналів (немає дати оригіналів — вивантаження + 10)', () => {
    const inv = { unloadedAt: '2026-10-01T00:00:00', invoiceAt: '2026-10-02T00:00:00' };
    expect(dueDate(inv, { days: 14, from: 'od' })!.getDate()).toBe(15);
    expect(dueDate(inv, { days: 14, from: 'inv' })!.getDate()).toBe(16);
    expect(dueDate(inv, { days: 14, from: 'orig' })!.getDate()).toBe(25);
    expect(dueDate({ ...inv, originalsAt: '2026-10-05T00:00:00' }, { days: 14, from: 'orig' })!.getDate()).toBe(19);
    expect(dueDate({}, { days: 14, from: 'od' })).toBeNull();
  });

  it('«Активна дебіторка»: «Запросити зміну» — лише свій клієнт менеджера / тім-ліда; плитки й червоні дні — з «Лімітів клієнтів»', () => {
    const { cells } = buildRows([L({ id: 'a', days: 14, from: 'od', limit: 150000 }), L({ id: 'b', members: [{ code: '22222222', name: 'ТОВ «Б»' }], managerId: 'u-iryna', days: null })], [
      D({ key: 'a', debt: 92000, odDays: 9, ageDays: 23 }),
      D({ key: 'b', codes: ['22222222'], managerId: 'u-iryna', debt: 50000 }),
      D({ key: 'c', codes: ['33333333'], managerId: 'u-marina', debt: 252000, ageDays: 17 }),
      D({ key: 'z', codes: ['44444444'], debt: 400000 }),
      D({ key: 'q', codes: ['55555555'], debt: 0 }),
    ]);
    expect([cells.a.managerId, cells.c.managerId]).toEqual(['u-marina', 'u-marina']);
    expect(Object.entries(cellsFor(marina, cells)).filter(([, c]) => c.canRequest).map(([k]) => k)).toEqual(['a', 'c', 'z', 'q']);
    expect(Object.entries(cellsFor(iryna, cells)).filter(([, c]) => c.canRequest).map(([k]) => k)).toEqual(['b']);
    expect(Object.values(cellsFor(serhii, cells)).some(c => c.canRequest)).toBe(false);
    expect(Object.values(cellsFor(buh, cells)).some(c => c.canRequest)).toBe(false);
    // прострочка: понад узгоджені дні — 'over'; дні не узгоджено (немає ліміту або лише сума) — 'none'
    expect([overdueKind({ debt: 92000, odDays: 9 }, cells.a), overdueKind({ debt: 50000, odDays: 0 }, cells.b), overdueKind({ debt: 252000, odDays: 0 }, cells.c), overdueKind({ debt: 0, odDays: 0 }, cells.q)])
      .toEqual(['over', 'none', 'none', null]);
    const s = overdueSplit([D({ key: 'a', debt: 92000, odDays: 9 }), D({ key: 'b', debt: 50000 }), D({ key: 'c', debt: 252000 }), D({ key: 'z', debt: 400000 }), D({ key: 'q', debt: 0 })], cells);
    expect(s.total).toEqual({ n: 4, sum: 794000 });
    expect([s.within.n, s.overdue.n, s.overLimit.n, s.noLimit.n, s.overdue.sum]).toEqual([0, 4, 1, 3, 794000]);
    const ok = overdueSplit([D({ key: 'a', debt: 92000 })], cells);
    expect([ok.within, ok.overdue.n]).toEqual([{ n: 1, sum: 92000 }, 0]);
  });
  // «комірка «Ліміти»» (limitCellHtml) — фронтовий модуль (client/clientLimits/debtorLimitMount.ts), бекенд його не збирає;
  // її тексти тримає скріншот приймання й гейт фронту `#2407`.
});
