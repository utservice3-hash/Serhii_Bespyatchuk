// Тест пакета Сергія (24.10.2026) дослівно, vitest → `vitestShim`; гейт — `counterparty/counterparty.test.ts`.
import { describe, expect, it } from './vitestShim.js';
import { changesSince, type CheckSubject, type Ownership } from '../shared/cpCheck.js';
import { mergeOwnership } from '../server/youscore/parse.js';

const now = new Date('2026-10-23T10:00:00Z');
const own = (o: Partial<Ownership>): Ownership => ({
  capital: 25000, owners: [{ name: 'Сидоренко Людмила Андріївна', code: null, kind: 'person', share: 100, ben: true, companies: 2 }], bens: [], benNote: '',
  director: { name: 'Сидоренко Людмила Андріївна', since: '2016-11-02T00:00:00Z' }, ownersAt: '2018-01-10T00:00:00Z', ownersWhat: 'увійшла Сидоренко Людмила Андріївна (100 %)',
  dirAt: null, dirWhat: '', ...o,
});
const subj = (o: Partial<CheckSubject> = {}, yc: Partial<CheckSubject['yc']> = {}): CheckSubject => ({
  code: '40998877', kind: 'ТОВ', name: 'ТОВ «Укрпаперпак»', reg: '2016-11-02T00:00:00Z', head: '', addr: '', fop: false, state: 'зареєстровано', own: own({}),
  yc: { cases: [], other: 0, enf: 0, express: [], index: null, checkedAt: now.toISOString(), archived: false, ...yc }, ...o,
});

describe('повторна (планова) перевірка без «історії змін»', () => {
  it('власники не змінились — дати й опис останньої зміни переносяться з попередньої', () => {
    const cur = own({ ownersAt: null, ownersWhat: '', director: { name: 'Сидоренко Людмила Андріївна', since: '2016-11-02T00:00:00Z' } });
    const m = mergeOwnership(own({}), cur, '2026-07-20T00:00:00Z', now)!;
    expect([m.ownersAt, m.ownersWhat, m.dirAt]).toEqual(['2018-01-10T00:00:00Z', 'увійшла Сидоренко Людмила Андріївна (100 %)', null]);
  });
  it('новий власник і новий директор — «між перевірками …», дата — сьогодні', () => {
    const cur = own({ owners: [{ name: 'Сидоренко Людмила Андріївна', code: null, kind: 'person', share: 60, ben: true, companies: 2 }, { name: 'Мороз Ігор Петрович', code: null, kind: 'person', share: 40, ben: false, companies: 12 }],
      ownersAt: null, ownersWhat: '', director: { name: 'Мороз Ігор Петрович', since: '2016-11-02T00:00:00Z' } });
    const m = mergeOwnership(own({}), cur, '2026-07-20T00:00:00Z', now)!;
    expect(m.ownersAt).toBe(now.toISOString());
    expect(m.ownersWhat).toBe('увійшов Мороз Ігор Петрович (40 %), змінено частку Сидоренко Людмила Андріївна: 100 → 60 % (між перевірками 20.07.2026 і 23.10.2026)');
    expect(m.dirWhat).toBe('Сидоренко Людмила Андріївна → Мороз Ігор Петрович (між перевірками 20.07.2026 і 23.10.2026)');
  });
});

describe('«зміни в YouControl» для ліміту', () => {
  it('без попередньої: свіжа зміна власників, виконавчі, «особлива увага» в експрес-аналізі', () => {
    const s = subj({ own: own({ ownersAt: '2026-08-20T00:00:00Z', ownersWhat: 'увійшов Мороз Ігор Петрович (40 %)' }) }, { enf: 1, express: [{ name: 'Податковий борг', value: 'є', tone: 'bad' }] });
    expect(changesSince(null, s, now)).toEqual(['нові власники: увійшов Мороз Ігор Петрович (40 %)', 'виконавчі провадження: 1', 'експрес-аналіз: Податковий борг']);
  });
  it('з попередньою: лише нове (виконавчих побільшало, стан у ЄДР, масовий власник); незмінне — ні', () => {
    const prev = subj({}, { enf: 1 });
    const cur = subj({ state: 'в стані припинення', own: own({ owners: [{ name: 'Сидоренко Людмила Андріївна', code: null, kind: 'person', share: 100, ben: true, companies: 14 }] }) }, { enf: 2 });
    expect(changesSince(prev, cur, now)).toEqual(['нові виконавчі провадження: 1 → 2', 'стан у ЄДР: в стані припинення', 'масовий власник: Сидоренко Людмила Андріївна (14)']);
    expect(changesSince(prev, prev, now)).toEqual([]);
  });
});
