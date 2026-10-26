// Тест пакета Сергія (24.10.2026) дослівно, vitest → `vitestShim`; гейт — `counterparty/counterparty.test.ts`.
/** Відповіді YouScore (форма — за специфікацією swagger/v1, звірено 23.10) → що показуємо. */
import { describe, expect, it } from './vitestShim.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx = (n: string): any => JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'src', 'counterparty', 'pkgTests', 'fixtures', n), 'utf8'));
const usr = fx('youscore-usr-tov.json');
const history = fx('youscore-history-tov.json');
const courts = fx('youscore-courts.json');
const express = fx('youscore-express.json');
const enforcement = fx('youscore-enforcement.json');
import { baseFromUsr, courtCase, ownersToCount, parseCourts, parseEnforcement, parseExpress, parseOwnership, subjectFrom } from '../server/youscore/parse.js';
import { checkSummary, claimSatisfied, critOf, isTransport, ownFlags, verdict } from '../shared/cpCheck.js';

const NOW = new Date('2026-10-23T09:00:00');
const C = { total: courts.totalResults, results: courts.results };
const E = { total: enforcement.totalResults, results: enforcement.results };

describe('ЄДР', () => {
  it('юрособа: коротка назва з лапками «», форма, дата реєстрації, керівник', () => {
    expect(baseFromUsr('41234567', usr)).toEqual({
      code: '41234567', kind: 'ТОВ', name: 'ТОВ «ЛІСОСТЕП АГРОХОЛД»', reg: new Date('2015-11-03T00:00:00').toISOString(),
      head: 'КОВАЛЬЧУК АНДРІЙ СТЕПАНОВИЧ', addr: 'Україна, 22000, Вінницька обл., місто Хмільник, вул. Небесної Сотні, будинок 12', fop: false,
    });
  });
  it('ФОП (інша схема): ПІБ з «ФОП», без керівника', () => {
    const b = baseFromUsr('3012345678', { fullName: 'МЕЛЬНИК ОЛЕГ ВАСИЛЬОВИЧ', contractorType: 'Фізична особа-підприємець (ФОП)', registrationAfterLaw: { entryDate: '2012-04-17T00:00:00' }, address: 'Київська обл.' });
    expect(b).toMatchObject({ kind: 'ФОП', name: 'ФОП МЕЛЬНИК ОЛЕГ ВАСИЛЬОВИЧ', fop: true, head: '' });
    expect(b.reg).toBe(new Date('2012-04-17T00:00:00').toISOString());
  });
});

describe('суди: лише перевезення / експедирування, де контрагент — відповідач', () => {
  it('відкрита (є засідання) і програна (рішення в силі, позов задоволено); решта — лише кількість', () => {
    const r = parseCourts(C, NOW);
    expect(r.cases.map(c => [c.no, c.open, c.lost, c.next && c.next.slice(0, 10)])).toEqual([
      ['916/2231/26', true, false, '2026-11-12'],
      ['902/1180/25', false, true, null],
    ]);
    expect(r.cases[1]).toMatchObject({ court: 'Господарський суд Вінницької області', sum: 214500, url: 'https://youcontrol.com.ua/catalog/court-document/2/' });
    expect(r.other).toBe(3);   // позивач; не перевезення; відмовлено в позові
  });
  it('позов задоволено чи ні — за резолютивною частиною', () => {
    expect(claimSatisfied('Позов задовольнити повністю. Стягнути з ТОВ …')).toBe(true);
    expect(claimSatisfied('Позов задовольнити частково.')).toBe(true);
    expect(claimSatisfied('У задоволенні позову відмовити повністю.')).toBe(false);
    expect(claimSatisfied('Відмовити в задоволенні позовних вимог.')).toBe(false);
    expect(isTransport('стягнення заборгованості за договором транспортного експедирування')).toBe(true);
    expect(isTransport('стягнення орендної плати')).toBe(false);
  });
  it('справа без документів і без засідань, старша за ~18 міс., — не «відкрита»', () => {
    expect(courtCase({ caseNumber: 'x', sideType: 2, autoCases: [{ registrationDate: '2024-01-01', description: 'перевезення' }] }, NOW).open).toBe(false);
    expect(courtCase({ caseNumber: 'x', sideType: 2, autoCases: [{ registrationDate: '2026-06-01', description: 'перевезення' }] }, NOW).open).toBe(true);
  });
});

describe('виконавчі, експрес-аналіз, власники', () => {
  it('виконавчі: лише відкриті, де контрагент — боржник', () => { expect(parseEnforcement(E)).toBe(1); });
  it('експрес-аналіз: «зверніть увагу» + ключові «не виявлено»; порожні — ні', () => {
    expect(parseExpress(express)).toEqual({
      index: 'B',
      facts: [
        { name: 'Відкриті виконавчі провадження', value: '1 провадження', tone: 'warn' },
        { name: 'Податковий борг', value: 'Не виявлено', tone: 'ok' },
        { name: 'Масова адреса реєстрації', value: 'Ні', tone: 'ok' },
      ],
    });
  });
  it('власники: частки з внеску, бенефіціар позначено, остання зміна складу; компаній у власника', () => {
    const counts = new Map(ownersToCount(usr).map(o => [o.key, o.name.startsWith('КОВАЛЬЧУК А') ? 2 : 14]));
    const o = parseOwnership(usr, history, counts, '2015-11-03T00:00:00.000Z')!;
    expect(o.capital).toBe(2500000);
    expect(o.owners).toEqual([
      { name: 'КОВАЛЬЧУК АНДРІЙ СТЕПАНОВИЧ', code: null, kind: 'person', share: 70, ben: true, companies: 2 },
      { name: 'КОВАЛЬЧУК ОЛЕНА МИКОЛАЇВНА', code: null, kind: 'person', share: 30, ben: false, companies: 14 },
    ]);
    expect(o.bens).toEqual([]);
    expect(o.director).toEqual({ name: 'КОВАЛЬЧУК АНДРІЙ СТЕПАНОВИЧ', since: '2015-11-03T00:00:00.000Z' });
    expect(o.dirAt).toBeNull();
    expect(o.ownersAt).toBe(new Date('2018-04-11T00:00:00').toISOString());
    expect(o.ownersWhat).toBe('увійшов КОВАЛЬЧУК ОЛЕНА МИКОЛАЇВНА (30 %), змінено частку КОВАЛЬЧУК АНДРІЙ СТЕПАНОВИЧ');
    expect(ownFlags(o, NOW)).toEqual(['масовий власник']);
  });
  it('новий директор і нові власники за 6 місяців — позначки', () => {
    const h = { managerChanges: [{ dateChanges: '2024-02-19', name: 'САВЕНКО ДЕНИС ОЛЕГОВИЧ' }, { dateChanges: '2026-07-20', name: 'ЛИТВИН РОСТИСЛАВ ІГОРОВИЧ' }],
      foundersChanges: [{ dateChanges: '2024-02-19', founders: [{ name: 'САВЕНКО ДЕНИС ОЛЕГОВИЧ', capital: 5000, type: 1 }] }, { dateChanges: '2026-07-20', founders: [{ name: 'ЛИТВИН РОСТИСЛАВ ІГОРОВИЧ', capital: 5000, type: 1 }] }] };
    const u = { founders: [{ name: 'ЛИТВИН РОСТИСЛАВ ІГОРОВИЧ', code: null, capital: 5000, type: 1 }], foundingCapital: { sum: 5000 }, signers: [{ name: 'ЛИТВИН РОСТИСЛАВ ІГОРОВИЧ', role: 'керівник' }] };
    const o = parseOwnership(u, h, new Map(), '2024-02-19T00:00:00.000Z')!;
    expect(o.dirWhat).toBe('САВЕНКО ДЕНИС ОЛЕГОВИЧ → ЛИТВИН РОСТИСЛАВ ІГОРОВИЧ');
    expect(o.ownersWhat).toBe('вийшов САВЕНКО ДЕНИС ОЛЕГОВИЧ, увійшов ЛИТВИН РОСТИСЛАВ ІГОРОВИЧ (100 %)');
    expect(o.director!.since).toBe(new Date('2026-07-20').toISOString());
    expect(ownFlags(o, NOW)).toEqual(['нові власники', 'новий директор']);
  });
});

describe('оцінка й підсумок', () => {
  it('повний результат: 10 років, 1 відкрита й 1 програна справа, 1 виконавче → «Є зауваження»', () => {
    const s = subjectFrom('41234567', { usr, history, courts: C, enforcement: E, express }, new Map(), NOW, false);
    const c = critOf(s, NOW);
    expect([c.age.st, c.open.v, c.lost.v]).toEqual(['ok', '1 справа', '1 справа']);
    expect(verdict(s, NOW)).toBe('warn');
    expect(checkSummary(s, NOW)).toBe('Знайдено справ за перевезення: 2');
    expect(s.state).toBe('зареєстровано');
  });
  it('молода компанія без справ; ФОП — суди вручну', () => {
    const young = subjectFrom('43871205', { usr: { ...usr, registrationBeforeLaw: null, registrationAfterLaw: { entryDate: '2024-02-19' } }, history: null, courts: { total: 0, results: [] }, enforcement: { total: 0, results: [] }, express: null }, new Map(), NOW, false);
    expect(checkSummary(young, NOW)).toBe('Менше 3 років; справ за перевезення немає');
    const fop = subjectFrom('3012345678', { usr: { fullName: 'МЕЛЬНИК ОЛЕГ ВАСИЛЬОВИЧ', registrationAfterLaw: { entryDate: '2012-04-17' } }, history: null, courts: null, enforcement: { total: 0, results: [] }, express: null }, new Map(), NOW, false);
    expect([fop.fop, fop.own, checkSummary(fop, NOW), verdict(fop, NOW)]).toEqual([true, null, 'ФОП: суди — вручну', 'fop']);
  });
});
