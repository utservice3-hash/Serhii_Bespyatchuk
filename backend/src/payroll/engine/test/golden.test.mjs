// «Золотий» тест: новий рушій на тих самих даних, що й макет v6, дає ті самі числа й тексти.
// Дані й очікування — test/fixtures/maket-v6.json (створює tools/make-fixtures.mjs з рушія макета).
// Три дати макета: 20.11 (місяць іде), 26.11 (відкрито аванси), 4.12 (листопад закрито, перевірка й виплата).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPayroll, prevMonth } from '../zarplata-engine.mjs';
import { createNotifier } from '../notify.mjs';

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/maket-v6.json', import.meta.url), 'utf8'));
const R6 = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);
const ALL_MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];
const LABEL = { nov: '20.11 — місяць іде', adv: '26.11 — аванси', dec: '04.12 — листопад закрито' };

// ---------- ті самі зрізи, що й у make-fixtures.mjs, але з нового рушія ----------
const part = x => [x.rate, x.pct, x.pctAmount, x.bonus, x.birthday, x.total].map(R6);
const sumCalc = c => ({
  kind: c.kind, level: c.level || null, margin: R6(c.margin), marginPlan: R6(c.marginPlan), plan: R6(c.plan), planDone: c.planDone,
  days: [c.days.total, c.days.elapsed, c.days.full, c.days.left], held: c.held ? c.held.length : 0,
  kpi: c.kpi ? { need: c.kpi.need, conv: R6(c.kpi.conv), step: c.kpi.step ? c.kpi.step[0] : null, reach: c.kpi.reach, done: c.kpi.done, noBonus: c.kpi.noBonus, waived: c.kpi.waived, bonusNow: c.kpi.bonusNow, bonusPlan: c.kpi.bonusPlan } : null,
  birthdays: c.birthdays.map(b => [b.kind, b.amount, b.kind === 'give' ? b.who : null]),
  members: c.members ? c.members.map(m => [m.empId, R6(m.margin), m.changed]) : null,
  now: part(c.now), atPlan: part(c.atPlan),
});
const sumTtn = t => [t.total, t.done, R6(t.pct), t.missing.map(d => d.id)];

function summarize(zp, state) {
  const live = zp.liveMonth, cm = zp.closedMonth, months = [live, cm].filter(Boolean), E = zp.employees, X = {};
  X.calc = {}; E.forEach(p => months.forEach(mk => { if (zp.employedIn(p, mk)) X.calc[p.id + '|' + mk] = sumCalc(zp.calc(p, mk)); }));
  X.advance = { open: zp.advanceWindowOpen(live), rows: {} };
  E.filter(p => zp.employedIn(p, live)).forEach(p => { const L = zp.advanceLimit(p, live), a = zp.advanceOf(p.id, live); X.advance.rows[p.id] = [L.byRule, L.cap, L.amount, a ? zp.advanceStatus(a) : null, a ? a.amount : null, zp.advancePaid(p.id, live)]; });
  X.settlement = {};
  if (cm) E.filter(p => zp.record(p.id, cm)).forEach(p => {
    const f = zp.settlement(p, cm), pl = zp.payoutLines(p, cm);
    X.settlement[p.id] = { status: f.record.status, values: [f.values.margin, f.values.pct, f.values.rate, f.values.bonus].map(R6), extras: R6(f.extras), birthday: R6(f.birthday), total: R6(f.total), autoTotal: R6(f.autoTotal),
      advance: f.advance, officialDeducted: f.officialDeducted, ttn: f.ttnLines.map(x => [x.kind, x.month, x.amount]), pay: R6(f.pay),
      payout: pl ? { cash: pl.cash, cards: pl.cards.map(c => [c.no, c.amount]), diff: pl.diff } : null, blocked: zp.payBlocked(p, cm), needsOd: zp.payNeedsOd(p, cm) };
  });
  X.ttn = {};
  E.filter(p => p.role === 'manager').forEach(p => ['2026-10', '2026-11', '2026-12'].filter(mk => mk <= live).forEach(mk => {
    const pv = zp.ttnPrev(p, mk);
    X.ttn[p.id + '|' + mk] = { stats: sumTtn(zp.ttnStats(p, mk)), fixedAt: zp.ttnFixedAt(p, mk), prev: pv ? [pv.month, pv.released, pv.at] : null };
  }));
  X.gifts = {}; E.forEach(p => ALL_MONTHS.forEach(mk => { const g = zp.birthdayGift(p, mk); if (g) X.gifts[p.id + '|' + mk] = [g.date, g.months, g.young, g.company, g.givers.length, g.amount]; }));
  X.official = {}; E.forEach(p => ALL_MONTHS.forEach(mk => { const o = zp.officialOf(p, mk); if (o) X.official[p.id + '|' + mk] = [o.amount, o.deduct]; }));
  X.clearance = {};
  E.filter(p => p.leave).forEach(p => {
    const s = zp.clearanceState(p), lm = p.leave.date.slice(0, 7), c = zp.clearanceOf(p);
    const roles = Object.fromEntries(['lead', 'ba', 'acc', 'hr', 'od'].map(r => { const x = zp.clearanceResponsible(p, r); return [r, [x.id, x.name]]; }));
    const ready = {}, readyFull = {}, canSign = {}, clients = zp.clearanceClients(p), heirs = zp.clearanceHeirs(p);
    ['clients', 'crm', 'notify', 'reconcile', 'trucks', 'chats', 'tech', 'exit', 'pay'].forEach(k => {
      canSign[k] = ['iry', 'bog', 'yul', 'acc', 'kat', 'ser', 'olen'].filter(v => zp.clearanceCanSign(p, k, v));
      if (!c) return;
      ready[k] = zp.clearanceReady(p, k, undefined);
      const full = k === 'clients' ? Object.fromEntries(clients.map(cl => [cl, heirs[0] || 'x'])) : [1, 2, 3].slice(0, ({ crm: 2, reconcile: 2, trucks: 1, chats: 1, tech: 3, exit: 1 })[k] || 0).map(() => true);
      readyFull[k] = zp.clearanceReady(p, k, full);
    });
    X.clearance[p.id] = { exists: !!c, done: s ? s.done : null, ok: s ? s.ok : null, final: s ? !!s.final : null, blocked: zp.payBlocked(p, lm), needsOd: zp.payNeedsOd(p, lm), isFinal: zp.isFinal(p, lm),
      roles, clients, heirs, ready, readyFull, canSign, shots: c ? (zp.clearanceShots(c) ? zp.clearanceShots(c).n : null) : null };
  });
  const sumFc = fc => ({
    fundNow: R6(fc.fundNow), fundPlan: R6(fc.fundPlan), advPaid: fc.advPaid, advRequested: fc.advRequested, advLeft: fc.advLeft, officialDeducted: fc.officialDeducted, officialSeparate: fc.officialSeparate,
    margin: R6(fc.margin), plan: fc.plan, payNow: R6(fc.payNow), payPlan: R6(fc.payPlan),
    risks: fc.risks.map(r => [r.kind, r.empId, r.loss === undefined ? null : R6(r.loss)]),
    teams: fc.teams.map(t => [t.team, t.n, R6(t.margin), R6(t.plan), R6(t.fundNow), R6(t.fundPlan), t.offer]),
  });
  X.forecast = Object.fromEntries(months.map(mk => [mk, sumFc(zp.forecast(mk))]));
  X.analyticsMonths = zp.analyticsMonths();
  X.analytics = {};
  zp.analyticsMonths().forEach(mk => [false, true].forEach(pl => {
    const s = zp.deptStats(mk, pl);
    X.analytics[mk + '|' + pl] = { comp: R6(s.comp), all: [s.all.n, R6(s.all.pay), R6(s.all.margin), R6(s.all.pct)], teams: s.teams.map(t => [t.k, t.n, R6(t.pay), R6(t.margin), R6(t.pct)]),
      depts: s.depts.map(d => [d.k, d.n, R6(d.pay), R6(d.pct)]), support: [s.support.n, R6(s.support.pay)] };
  }));
  X.marginOfMonth = {};
  E.filter(p => p.role === 'manager').forEach(p => ALL_MONTHS.filter(mk => mk <= live).forEach(mk => { X.marginOfMonth[p.id + '|' + mk] = R6(zp.marginOfMonth(p, mk)); }));
  X.goal = {};
  E.filter(p => p.role === 'manager' && zp.employedIn(p, live) && !zp.isFinal(p, live)).forEach(p => {
    const d = zp.goalDefaults(p, live), R = d.regular.selected.reduce((s, cl) => s + (d.regular.expected[cl] || 0), 0), runs = [];
    ['start', 'profi'].forEach(level => [true, false].forEach(calls => { const x = zp.goalRun(p, live, { level, conv: d.conv, target: d.target, calls, regular: R, avgCheck: d.avgCheck }); runs.push([level, calls, x.margin, R6(x.fromRegular), R6(x.fromNew), x.cars, x.leads, R6(x.salary.total), x.salary.pct, x.salary.rate, x.salary.bonus]); }));
    X.goal[p.id] = { defaults: [d.target, R6(d.conv), d.avgCheck, d.source.cars, R6(d.source.margin), d.source.leads, d.source.targetDeals, [...d.regular.selected].sort(), Object.entries(d.regular.expected).sort()], regular: R, runs };
  });
  return X;
}

// ---------- сповіщення: ті самі події, що засіяно в макеті (seedNotes / seedClosed) ----------
function replayA(zp, nt, state) {   // до 1 грудня
  const b = nt.build, out = [];
  out.push(...b.birthdays('2026-11', '2026-11-01T08:00'));
  out.push(...b.ttnHold('tar', '2026-10', '2026-11-05T12:00'));
  out.push(...b.ttnFixed('tar', '2026-10', '2026-11-24T16:20', true));
  const t1 = state.tasks.find(t => t.id === 't1');
  out.push(...b.offerTask('vik', t1));
  out.push(...b.offerSigned('vik', t1, '2026-11-27T11:30'));
  const c = state.clearances.and;
  out.push(...b.clearanceCreated('and', '2026-11-13T10:05'));
  out.push(...b.clearanceShots('and', c.shots.at, c.shots.n));
  Object.entries(c.signatures).sort((x, y) => x[1].at.localeCompare(y[1].at)).forEach(([k, g], i) => out.push(...b.clearanceSigned('and', k, g.at, i + 1)));
  Object.entries(state.advances['2026-11']).forEach(([id, a]) => { out.push(...b.advanceRequested(id, '2026-11')); if (a.paidAt) out.push(...b.advancePaid(id, '2026-11')); });
  return out;
}
function replayB(zp, nt, state) {   // закриття листопада (1–3 грудня)
  const b = nt.build, mk = '2026-11', out = [];
  zp.employees.filter(x => x.role === 'manager').forEach(x => { if (!zp.ttnOk(zp.ttnStats(x, mk, '2026-12-01'))) out.push(...b.ttnHold(x.id, mk, '2026-12-01T00:10')); });
  out.push(...b.offerTask('olg', state.tasks.find(t => t.id === 't2')));
  out.push(...b.monthClosed(mk, '2026-12-01T00:05'));
  F.autoLevel.forEach(a => out.push(...b.levelAuto(a.empId, '2026-12-01T00:05', { from: a.from, m1: zp.marginOfMonth(a.empId, prevMonth(prevMonth(a.from))), m2: zp.marginOfMonth(a.empId, prevMonth(a.from)) })));
  out.push(...b.birthdays('2026-12', '2026-12-01T08:00'));
  zp.employees.forEach(x => { const r = zp.record(x.id, mk); if (r && r.status !== 'review' && r.verifiedAt) out.push(...b.verificationReady(x.id, mk, r.verifiedAt)); });
  const ole = zp.record('ole', mk);
  out.push(...b.dispute('ole', mk, ole.dispute.at, ole.dispute.text));
  ['nat', 'olg'].forEach(id => out.push(...b.payoutForm(id, mk, zp.record(id, mk).form.at)));
  return out;
}
const sumNote = n => ({ type: n.type, at: n.at, to: n.to, act: n.act, empId: n.empId || null, cta: n.cta || null, title: n.title, text: n.text, go: n.go });

for (const ck of ['nov', 'adv', 'dec']) {
  const { state, expected } = F[ck];
  const zp = createPayroll(state), got = summarize(zp, state);
  for (const key of Object.keys(expected).filter(k => k !== 'notesDone')) {
    test(`${LABEL[ck]}: ${key}`, () => assert.deepEqual(got[key], expected[key]));
  }
  test(`${LABEL[ck]}: сповіщення — тексти, адресати, «потрібна дія» виконана`, () => {
    const nt = createNotifier(zp, state);
    const notes = [...replayA(zp, nt, state), ...(ck === 'dec' ? replayB(zp, nt, state) : [])];
    const want = F.notes.slice(0, ck === 'dec' ? F.notes.length : F.seedA);
    assert.deepEqual(notes.map(sumNote), want);
    const done = notes.map((n, i) => (zp.seen(n.at) ? [i, nt.notificationDoneAt(n)] : null)).filter(Boolean);
    assert.deepEqual(done, expected.notesDone);
  });
}

test('04.12: автоперехід на «Профі» (офер Лілії) — рушій знаходить того самого працівника з тими самими сумами', () => {
  const st = structuredClone(F.dec.state);
  st.employees.forEach(e => { e.terms = e.terms.filter(t => !t.auto); });
  const zp = createPayroll(st);
  const found = zp.employees.map(e => ({ e, a: zp.autoProfi(e, '2026-11') })).filter(x => x.a).map(x => ({ empId: x.e.id, from: x.a.from, m1: x.a.m1, m2: x.a.m2 }));
  assert.deepEqual(found, F.autoLevel);
});
