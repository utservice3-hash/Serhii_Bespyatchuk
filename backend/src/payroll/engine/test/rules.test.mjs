// Правила зарплати — живі приклади (ті самі люди й суми, що в макеті v6). Читається як специфікація.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPayroll, nextStatus, luhn } from '../zarplata-engine.mjs';

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/maket-v6.json', import.meta.url), 'utf8'));
const nov = createPayroll(F.nov.state);   // 20 листопада: місяць іде
const adv = createPayroll(F.adv.state);   // 26 листопада: відкрито аванси
const dec = createPayroll(F.dec.state);   // 4 грудня: листопад закрито, фінансист перевіряє
const r = x => Math.round(x);

// Мінімальний знімок для окремих правил
const mini = (over = {}) => createPayroll({
  now: '2026-11-20', liveMonth: '2026-11', closedMonth: null,
  departments: { sales: { name: 'Відділ продажу', sales: true }, ops: { name: 'Операційний відділ', sales: false } },
  teams: { nw: { name: 'Нові клієнти' } }, plans: {}, deals: {}, kpi: {}, ttnAt: {},
  responsibles: { ba: { id: 'ba', name: 'Бізнес-асистент' }, acc: { id: 'acc', name: 'Бухгалтерія' }, hr: { id: 'hr', name: 'HR' }, od: { id: 'od', name: 'ОД' }, finance: ['fin'] },
  employees: [], ...over,
});

test('«Старт»: 10 %, а 20 % — лише якщо план ≥ 30 000 ₴ і виконаний', () => {
  assert.equal(nov.managerPct('start', 40000, 39999), 10);
  assert.equal(nov.managerPct('start', 40000, 40000), 20);
  assert.equal(nov.managerPct('start', 25000, 60000), 10);   // план менший за 30 000 — 20 % не дає
});

test('«Профі»: 25 % до 70 000 ₴, 30 % від 70 000 ₴, 35 % — план керівника виконано', () => {
  assert.equal(nov.managerPct('profi', 100000, 69999), 25);
  assert.equal(nov.managerPct('profi', 100000, 70000), 30);
  assert.equal(nov.managerPct('profi', 100000, 100000), 35);
  assert.equal(nov.managerPct('profi', 0, 80000), 30);       // плану керівника немає — 35 % недоступні
});

test('Бонус за КПІ — сходинка за конверсією: 12 / 15 / 20 / 25 / 30 % → 3 / 5 / 8 / 10 / 12 тис. ₴', () => {
  assert.equal(nov.kpiStep(11.9), null);
  assert.deepEqual(nov.kpiStep(12), [12, 3000]);
  assert.deepEqual(nov.kpiStep(17.07), [15, 5000]);
  assert.deepEqual(nov.kpiStep(31), [30, 12000]);
});

test('Марина, 20.11: «зараз» 13 240 ₴, «при виконанні плану» 17 900 ₴', () => {
  const c = nov.calc('mar', '2026-11');
  // ставка 5 000 + 10 % від 33 400 + бонус 5 000 (конверсія 14 з 82 = 17,1 %, норма дзвінків ще досяжна) − 100 (ДН Ірини)
  assert.deepEqual([c.now.rate, c.now.pctAmount, c.now.bonus, c.now.birthday, c.now.total], [5000, 3340, 5000, -100, 13240]);
  // план 40 000 → 20 % на всю маржу: 5 000 + 8 000 + 5 000 − 100
  assert.equal(c.atPlan.total, 17900);
});

test('Новий працівник: ставка пропорційно робочим дням; звільнення на випробувальному — ставки немає, % і бонус є', () => {
  const d = nov.days('and', '2026-11');
  assert.deepEqual([d.total, d.full], [15, 21]);              // вийшов 10.11: 15 з 21 робочого дня
  const c = dec.calc('and', '2026-11');                       // звільнення 30.11, тип «випробувальний»
  assert.deepEqual([c.now.rate, c.now.pct, c.now.pctAmount, c.now.bonus], [0, 10, 2400, 3000]);
});

test('Дні народження: колеги по 100 ₴; іменинник — збір + 400 ₴ (тім-лід — 600 ₴); стаж до року — 100 ₴ × місяці + 400 ₴', () => {
  const iry = nov.birthdayGift('iry', '2026-11');
  assert.deepEqual([iry.givers.length, iry.company, iry.amount], [13, 600, 1900]);      // 13 × 100 + 600
  const vik = nov.birthdayGift('vik', '2026-11');
  assert.deepEqual([vik.young, vik.months, vik.amount], [true, 10, 1400]);               // 10 × 100 + 400, без збору
  assert.deepEqual(nov.calc('mar', '2026-11').birthdays.map(b => [b.kind, b.amount, b.who]), [['give', -100, 'iry']]);
});

test('Офер команди Лілії: «Старт» — ставка 10 000 ₴, план 50 000 ₴ фіксовано, без бонусу за КПІ', () => {
  const c = nov.calc('sof', '2026-11');
  assert.deepEqual([c.offer, c.now.rate, c.plan, c.kpi], ['ls', 10000, 50000, null]);
});

test('Офер команди Лілії: «Профі» автоматично — маржа понад 50 000 ₴ два місяці поспіль (Дмитро: 56 400 і 58 700)', () => {
  assert.equal(dec.levelOf('dmy', '2026-11'), 'start');
  assert.equal(dec.levelOf('dmy', '2026-12'), 'profi');
  assert.deepEqual(F.autoLevel, [{ empId: 'dmy', from: '2026-12', m1: 56400, m2: 58700 }]);
});

test('Тім-лід: ставка + 3 % маржі команди, 6 % — план команди виконано (у закритому місяці — перевірена маржа)', () => {
  const c = nov.calc('iry', '2026-11');
  assert.deepEqual([c.margin, c.plan, c.now.pct], [98500, 105000, 3]);
  const f = dec.settlement('iry', '2026-11');
  assert.deepEqual([f.values.margin, f.values.pct, r(f.total)], [137000, 6, 20120]);    // 10 000 + 6 % × 137 000 + 1 900 (ДН)
});

test('Ставка + % маржі компанії (бізнес-асистент): 12 000 + 0,5 % × 466 800 = 14 334 − 100 ДН', () => {
  const c = dec.calc('yul', '2026-11');
  assert.deepEqual([c.now.rate, c.now.pctAmount, c.now.total], [12000, 2334, 14234]);
});

test('Закриття, Наталія: нараховано 19 400 → аванс −6 000 → офіційна ЗП −8 000 (вираховується) → до виплати 5 400', () => {
  const f = dec.settlement('nat', '2026-11');
  assert.deepEqual([r(f.total), f.extras, f.advance, f.officialDeducted, r(f.pay)], [19400, 1500, 6000, 8000, 5400]);
});

test('Офіційна ЗП «окремо» не вираховується (Ірина): до виплати = нараховано', () => {
  const f = dec.settlement('iry', '2026-11');
  assert.deepEqual([f.official.amount, f.official.deduct, f.officialDeducted, r(f.pay)], [8000, false, 0, 20120]);
});

test('Перевірка фінансиста: змінена маржа перераховує % за шкалою (Олег: 103 500 → 91 100 → 30 %)', () => {
  const c = dec.calc('ole', '2026-11'), f = dec.settlement('ole', '2026-11');
  assert.deepEqual([c.margin, c.now.pct], [103500, 35]);                                   // орієнтовно: план 100 000 виконано
  assert.deepEqual([f.values.margin, f.values.pct, r(f.total), f.advance, r(f.pay)], [91100, 30, 27230, 10000, 17230]);
});

test('ТТН: менше 70 % угод з ТТН у закритому місяці → −3 000 ₴ до закриття (Марина: 5 з 8)', () => {
  const t = dec.ttnStats('mar', '2026-11');
  assert.deepEqual([t.done, t.total, t.pct], [5, 8, 62.5]);
  assert.deepEqual(dec.ttnLines('mar', '2026-11').map(x => [x.kind, x.amount]), [['hold', -3000]]);
});

test('ТТН: утримання жовтня закрили 24.11 → +3 000 ₴ у виплаті за листопад (Тарас)', () => {
  assert.deepEqual(dec.ttnLines('tar', '2026-11').map(x => [x.kind, x.month, x.amount]), [['release', '2026-10', 3000]]);
});

test('Аванс: з 25-го; ліміт — 15 % маржі (менеджер / команда тім-ліда) або 50 % ставки, але не більше нарахованого', () => {
  assert.equal(nov.advanceWindowOpen('2026-11'), false);
  assert.equal(adv.advanceWindowOpen('2026-11'), true);
  const mar = adv.advanceLimit('mar', '2026-11'), nat = adv.advanceLimit('nat', '2026-11'), bog = adv.advanceLimit('bog', '2026-11');
  assert.deepEqual([mar.base, mar.amount], [38500, 5775]);                                // 15 % × 38 500
  assert.deepEqual([nat.base, nat.amount], [18000, 9000]);                                // 50 % ставки
  assert.deepEqual([bog.byRule, bog.cap, bog.amount, bog.capped], [33075, 11515, 11515, true]);   // запобіжник: не більше нарахованого
});

test('Форма на виплату: готівка + карти = «До виплати»; нова карта — номер за Луном і власник; без дублів', () => {
  const ok = dec.checkPayoutForm('olg', '2026-11', { cash: 0, cards: [{ no: '5168 7451 2290 4417', amount: 20000 }, { no: '4441 1144 9071 3352', amount: 7000 }] });
  assert.equal(ok.ok, true);
  const less = dec.checkPayoutForm('olg', '2026-11', { cash: 1000, cards: [{ no: '5168 7451 2290 4417', amount: 20000 }] });
  assert.deepEqual([less.ok, less.rest], [false, 6000]);
  const badNew = dec.checkPayoutForm('olg', '2026-11', { cash: 0, cards: [{ no: '1234 5678 9012 3456', who: 'Кравчук Ольга', amount: 27000, isNew: true }] });
  assert.deepEqual([badNew.ok, badNew.badCards.length], [false, 1]);
  const dup = dec.checkPayoutForm('olg', '2026-11', { cash: 0, cards: [{ no: '5168 7451 2290 4417', amount: 20000 }, { no: '5168745122904417', amount: 7000 }] });
  assert.equal(dup.duplicate, true);
  assert.equal(luhn('4111 1111 1111 1111'), true);
});

test('Обхідний лист: форма на виплату — після 8 підписів, виплата — після погодження ОД; підписує лише відповідальний', () => {
  const s = dec.clearanceState('and');
  assert.deepEqual([s.done, s.total, s.ok], [6, 8, false]);
  assert.deepEqual([dec.payBlocked('and', '2026-11'), dec.payNeedsOd('and', '2026-11')], [true, true]);
  assert.equal(dec.clearanceCanSign('and', 'trucks', 'iry'), true);      // п. 5 — тім-лід команди
  assert.equal(dec.clearanceCanSign('and', 'trucks', 'yul'), false);
  assert.equal(dec.clearanceCanSign('and', 'exit', 'kat'), true);        // п. 8 — HR
  assert.equal(dec.clearanceReady('and', 'pay'), false);                 // п. 9 (ОД) — лише після 1–8
});

test('Статуси закриття: review → verified → agreed → submitted → paid; незгода → відповідь фінансиста → verified', () => {
  assert.equal(nextStatus('review', 'verify'), 'verified');
  assert.equal(nextStatus('verified', 'agree'), 'agreed');
  assert.equal(nextStatus('verified', 'dispute'), 'disputed');
  assert.equal(nextStatus('disputed', 'verify'), 'verified');
  assert.equal(nextStatus('agreed', 'submitForm'), 'submitted');
  assert.equal(nextStatus('submitted', 'markPaid'), 'paid');
  assert.equal(nextStatus('submitted', 'verify'), null);                // після подання форми — лише корекція наступного місяця
  assert.equal(nextStatus('paid', 'verify'), null);
});

test('Аналітика, листопад: компанія 56 % ЗП до маржі; команди 56,1 / 35,3 / 34,9 %', () => {
  const s = dec.deptStats('2026-11', false);
  assert.equal(s.all.pct.toFixed(1), '56.0');
  assert.deepEqual(s.teams.map(t => [t.k, t.pct.toFixed(1)]), [['nw', '56.1'], ['rg', '35.3'], ['ls', '34.9']]);
});

test('Калькулятор «Ціль» (Марина, «Старт»): 20 000 ₴ → маржа 50 000 ₴ → 9 авто → 53 звернення', () => {
  const d = nov.goalDefaults('mar', '2026-11');
  const x = nov.goalRun('mar', '2026-11', { level: 'start', conv: d.conv, target: d.target, calls: true, regular: 0, avgCheck: d.avgCheck });
  assert.deepEqual([d.target, d.conv, x.margin, x.cars, x.leads], [20000, 17.1, 50000, 9, 53]);
});

test('Режим «лише оплачені»: неоплачена угода переходить на місяць оплати', () => {
  const emp = { id: 'm1', name: 'Тест', role: 'manager', title: 'Менеджер', dept: 'sales', team: 'nw', startDate: '2025-01-01', birthday: null, terms: [{ from: '2000-01', level: 'profi' }] };
  const deals = { m1: { '2026-11': [{ id: 'd1', date: '2026-11-02', client: 'А', margin: 10000, pay: 'paid' }, { id: 'd2', date: '2026-11-03', client: 'Б', margin: 6000, pay: 'wait' }] } };
  assert.equal(mini({ employees: [emp], deals }).calc('m1', '2026-11').margin, 16000);
  const zp = mini({ employees: [emp], deals, settings: { payMode: 'paid' } });
  assert.deepEqual([zp.calc('m1', '2026-11').margin, zp.calc('m1', '2026-11').held.length], [10000, 1]);
});

test('Робочі дні — пн–пт; свята компанії (якщо задані) не рахуються', () => {
  assert.equal(mini().workdays('2026-11'), 21);
  assert.equal(mini({ holidays: ['2026-11-02'] }).workdays('2026-11'), 20);
});
