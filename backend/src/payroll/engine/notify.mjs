// =====================================================================================
// Центр сповіщень — спільний для всього дашборда («Зарплата» — перший модуль).
// Подія → правило «кому» → одне сповіщення на групу адресатів. «Потрібна дія» закривається сама,
// щойно дію виконано: правило done (серіалізоване, можна зберегти в БД) → notificationDoneAt().
// Тексти — 1:1 з макетом v6 (перевіряє test/golden.test.mjs). Тексти — простий текст, екранувати при виведенні.
// =====================================================================================
import { CLEARANCE_ITEMS, LEAVE_TYPES, ceilE, nextMonth, prevMonth, sum } from './zarplata-engine.mjs';
import { nf, uah, pct, dd, ddy, plural, capFirst, monthName, monthGen, monthLow } from './format.mjs';

/** Тип: [модуль, потрібна дія, подія, кому] — так само в налаштуваннях «Сповіщення» */
export const NOTIFICATION_TYPES = Object.freeze({
  'clr.sign': ['Обхідний лист', true, 'Звільнення — створено обхідний лист; усі пункти підписано', 'тім-лід, бізнес-асистент, бухгалтерія, HR — кожному свої пункти; ОД — останній: «Розрахунок та видача ЗП»'],
  'clr.info': ['Обхідний лист', false, 'Обхідний лист створено; кожен підпис; скріншоти від менеджера', 'працівник — його дії; фінансисти й ОД — до відома; тім-лід — скріншоти'],
  'clr.done': ['Обхідний лист', false, 'Підписано всіма; розрахунок погоджено ОД', 'фінансисти, працівник'],
  'month': ['Зарплата', true, 'Місяць закрито', 'фінансисти — перевірити до 6-го'],
  'ver.ready': ['Зарплата', true, 'Розрахунковий лист перевірено', 'працівник — погодити або написати, з чим не згоден'],
  'ver.disp': ['Зарплата', true, 'Працівник не погоджується', 'фінансисти; не домовились — вирішує ОД'],
  'form': ['Зарплата', true, 'Форма на виплату подана', 'фінансисти — у відомість, виплата до 8-го'],
  'paid': ['Зарплата', false, 'Виплачено', 'працівник'],
  'adv.req': ['Аванс', true, 'Заявка на аванс', 'фінансисти'],
  'adv.res': ['Аванс', false, 'Аванс виплачено або відхилено', 'працівник'],
  'ttn.hold': ['ТТН', true, 'ТТН менше 70 % — утримано 3 000 ₴', 'менеджер; бізнес-асистент — до відома'],
  'ttn.fix': ['ТТН', false, 'ТТН закрито — утримання знято', 'менеджер'],
  'bday': ['Дні народження', false, 'Місяць дня народження', 'іменинник; фінансисти — до відома'],
  'lvl': ['Рівень', false, 'Перехід на «Профі», новий офер', 'менеджер; фінансисти — до відома'],
  'offer': ['Документи', true, 'Новий офер — перепідписати', 'рекрутер — задача'],
});

export const OFFER_TITLES = Object.freeze({ start: 'Офер «Старт»', profi: 'Офер «Профі»', ls: 'Офер команди Лілії Шаврової' });

/** «готівкою 2 000 ₴, на карту •••• 2216 — 5 000 ₴» */
export const payHow = x => {
  const cards = x.cards || [], many = cards.length + (x.cash ? 1 : 0) > 1;
  const parts = [...(x.cash ? [`готівкою${many ? ' ' + uah(x.cash) : ''}`] : []), ...cards.map(c => `на карту •••• ${c.no.slice(-4)}${many ? ' — ' + uah(c.amount) : ''}`)];
  return parts.join(', ') || '—';
};

/** Посилання всередину кабінету «Моя зарплата» (вкладка, якір) */
const inCab = (tab, focus) => ({ tab: 'cab', mz: focus ? { tab, focus } : { tab } });

/**
 * @param {ReturnType<import('./zarplata-engine.mjs').createPayroll>} zp
 * @param {import('./zarplata-engine.mjs').State} state
 */
export function createNotifier(zp, state) {
  const R = state.responsibles, FIN = R.finance, S = zp.settings;
  const P = id => zp.person(id);
  const make = (type, at, to, o) => ({ type, at, to: [...new Set(to)].filter(Boolean), act: NOTIFICATION_TYPES[type][1], ...o });
  const leaveText = p => `${ddy(p.leave.date)} — ${LEAVE_TYPES[p.leave.type][0]}`;
  const TASKS = CLEARANCE_ITEMS.filter(x => !x.final);

  const build = {
    /** Обхідний лист створено: кожному відповідальному — його пункти одним завданням; працівнику — його дії; фінансистам і ОД — до відома */
    clearanceCreated(empId, at) {
      const p = P(empId), go = { tab: 'clr', focus: `#clr-${p.id}` }, by = {}, out = [];
      TASKS.forEach(x => { const vid = zp.clearanceResponsible(p.id, x.role).id; (by[vid] = by[vid] || []).push(x); });
      Object.entries(by).forEach(([vid, xs]) => out.push(make('clr.sign', at, [vid], { empId: p.id, cta: 'Підписати',
        title: `Обхідний лист — ${p.name}: ${xs.length > 1 ? `ваші пункти (${xs.length})` : 'ваш пункт'}`,
        text: `Звільнення ${leaveText(p)}. ${xs.map(x => `${CLEARANCE_ITEMS.indexOf(x) + 1}. ${x.t}`).join('; ')}.`, go,
        done: { kind: 'clr.items', empId: p.id, keys: xs.map(x => x.k) } })));
      out.push(make('clr.info', at, [...FIN, R.od.id], { empId: p.id, title: `Обхідний лист створено — ${p.name}`,
        text: `Звільнення ${leaveText(p)}. ${TASKS.length} пунктів підписують тім-лід, бізнес-асистент, бухгалтерія й HR; розрахунок і видачу ЗП погоджує ОД — після всіх підписів.`, go }));
      out.push(make('clr.info', at, [p.id], { empId: p.id, act: true, cta: 'Що зробити', title: 'Ваш обхідний лист створено',
        text: 'Повідомте клієнтів письмово (месенджер) і надішліть скріншоти тім-ліду; допоможіть новому відповідальному з машинами; поверніть техніку бізнес-асистенту. Розрахунок — після всіх підписів.',
        go: inCab('home', '#leave'), done: { kind: 'clr.shots', empId: p.id } }));
      return out;
    },
    clearanceShots(empId, at, n) {
      const p = P(empId);
      return [make('clr.info', at, [zp.clearanceResponsible(p.id, 'lead').id], { empId: p.id, title: `${p.name} надіслав скріншоти повідомлень клієнтам`,
        text: `${n} з ${zp.clearanceClients(p.id).length} клієнтів. Заархівуйте й підпишіть п. 3 обхідного листа.`, go: { tab: 'clr', focus: `#clr-${p.id}` } })];
    },
    /** n — скільки з 8 пунктів уже підписано (разом з цим) */
    clearanceSigned(empId, k, at, n) {
      const p = P(empId), x = CLEARANCE_ITEMS.find(i => i.k === k), total = TASKS.length, idx = CLEARANCE_ITEMS.indexOf(x) + 1;
      if (x.final) return [
        make('clr.done', at, FIN, { empId: p.id, title: `ОД погодив розрахунок — ${p.name}`, text: 'Обхідний лист закрито — фінальний розрахунок можна виплачувати.', go: { tab: 'stmt' } }),
        make('clr.done', at, [p.id], { empId: p.id, title: 'Розрахунок погоджено', text: 'Обхідний лист закрито — фінансист виплатить за вашою формою.', go: inCab('home', '#close') }),
      ];
      const out = [make('clr.info', at, [p.id], { empId: p.id, title: `Обхідний лист — підписано п. ${idx}`, text: `${x.t}. ${n >= total ? 'Підписано всіма — можна подавати форму на виплату.' : `Підписано ${n} з ${total}.`}`, go: inCab('home', '#close') })];
      if (n >= total) {
        out.push(make('clr.sign', at, [R.od.id], { empId: p.id, cta: 'Погодити', title: `Погодити розрахунок — ${p.name}`,
          text: `Усі ${total} пунктів обхідного листа підписано. Останній пункт — «Розрахунок та видача заробітної плати».`, go: { tab: 'clr', focus: `#clr-${p.id}` },
          done: { kind: 'clr.final', empId: p.id } }));
        out.push(make('clr.done', at, FIN, { empId: p.id, title: `Обхідний лист підписано всіма — ${p.name}`, text: 'Форму на виплату відкрито; виплата — після погодження ОД.', go: { tab: 'ver', ver: p.id } }));
      }
      return out;
    },
    monthClosed(mk, at) {
      const n = zp.employees.filter(x => zp.record(x.id, mk)).length;
      return [make('month', at, FIN, { cta: 'До перевірки', title: `${monthName(mk)} закрито — перевірте до ${S.verifyByDay} ${monthGen(nextMonth(mk))}`,
        text: `У черзі — ${n} ${plural(n, 'працівник', 'працівники', 'працівників')}. ТТН, дні народження й аванси вже враховано.`, go: { tab: 'ver' },
        done: { kind: 'month.verified', month: mk } })];
    },
    verificationReady(empId, mk, at, reply) {
      const p = P(empId), f = zp.settlement(p.id, mk);
      return [make('ver.ready', at, [p.id], { empId: p.id, cta: 'Переглянути', title: reply ? `Фінансист відповів — ${monthLow(mk)}` : `Розрахунковий лист за ${monthLow(mk)} готовий`,
        text: `${reply ? `«${reply}» ` : ''}Нараховано ${uah(f.total)}, до виплати ${uah(f.pay)}. Погодьте або напишіть, з чим не згодні.`, go: inCab('home', '#close'),
        done: { kind: 'rec.answered', empId: p.id, month: mk, since: at } })];
    },
    dispute(empId, mk, at, text) {
      const p = P(empId);
      return [make('ver.disp', at, FIN, { empId: p.id, cta: 'Відповісти', title: `${p.name} не погоджується — ${monthLow(mk)}`, text: `«${text}»`, go: { tab: 'ver', ver: p.id },
        done: { kind: 'rec.resolved', empId: p.id, month: mk } })];
    },
    payoutForm(empId, mk, at) {
      const p = P(empId), fm = zp.record(p.id, mk).form;
      return [make('form', at, FIN, { empId: p.id, cta: 'До відомості', title: `Форма на виплату — ${p.name}`,
        text: `${uah((fm.cash || 0) + sum((fm.cards || []).map(c => c.amount)))}: ${payHow(fm)}. Виплата до ${S.payByDay} ${monthGen(nextMonth(mk))}.`, go: { tab: 'stmt' },
        done: { kind: 'rec.paid', empId: p.id, month: mk } })];
    },
    paid(empId, mk, at) {
      const p = P(empId), f = zp.settlement(p.id, mk), pl = zp.payoutLines(p.id, mk);
      return [make('paid', at, [p.id], { empId: p.id, title: `ЗП за ${monthLow(mk)} виплачено`, text: `${uah(f.pay)} — ${payHow(pl || (f.record && f.record.form) || {})}.`, go: inCab('pay') })];
    },
    advanceRequested(empId, mk) {
      const p = P(empId), a = state.advances[mk][empId];
      return [make('adv.req', a.requestedAt, FIN, { empId: p.id, cta: 'До авансів', title: `Заявка на аванс — ${p.name}`, text: `${uah(a.amount)}: ${payHow(a)}.`, go: { tab: 'adv' },
        done: { kind: 'adv.closed', empId: p.id, month: mk } })];
    },
    advancePaid(empId, mk) {
      const p = P(empId), a = state.advances[mk][empId];
      return [make('adv.res', a.paidAt, [p.id], { empId: p.id, title: `Аванс ${uah(a.amount)} виплачено`, text: `${capFirst(payHow(a))}. Вирахуємо із ЗП за ${monthLow(mk)} при закритті місяця.`, go: inCab('pay', '#adv') })];
    },
    advanceRejected(empId, mk) {
      const p = P(empId), a = state.advances[mk][empId];
      return [make('adv.res', a.rejectedAt, [p.id], { empId: p.id, title: `Заявку на аванс ${uah(a.amount)} відхилено`, text: `${a.reason || ''} Можна подати нову.`, go: inCab('pay', '#adv') })];
    },
    ttnHold(empId, mk, at) {
      const p = P(empId), t = zp.ttnStats(p.id, mk, at), need = Math.max(1, ceilE(S.ttn.minPct * t.total / 100) - t.done), live = !t.legacy;   // місяць до запуску — виплата вже пішла
      return [
        make('ttn.hold', at, [p.id], { empId: p.id, cta: 'Що зробити', title: `Утримано ${uah(S.ttn.hold)} до закриття ТТН — ${monthLow(mk)}`,
          text: `ТТН є в ${t.done} з ${t.total} угод (${pct(t.pct)}), потрібно від ${S.ttn.minPct} % — ще ${need}. ${live ? 'Додасте ТТН до виплати — сума піде в цю виплату.' : 'Закриєте ТТН — сума додасться до найближчої виплати.'}`,
          go: inCab('home', '#ttnclose'), done: { kind: 'ttn.fixed', empId: p.id, month: mk } }),
        make('ttn.hold', at, [R.ba.id], { empId: p.id, act: false, title: `ТТН ${monthGen(mk)}: ${p.name} — ${t.done} з ${t.total}`,
          text: `Утримано ${uah(S.ttn.hold)} до закриття ТТН; без ТТН — ${t.total - t.done} ${plural(t.total - t.done, 'угода', 'угоди', 'угод')}.`, go: { toast: 'У дашборді відкриється «Бізнес-асистент → ТТН моніторинг»' } }),
      ];
    },
    ttnFixed(empId, mk, at, toNext) {
      const p = P(empId), t = zp.ttnStats(p.id, mk, at);
      return [make('ttn.fix', at, [p.id], { empId: p.id, title: `ТТН ${monthGen(mk)} закрито — ${t.done} з ${t.total}`,
        text: toNext ? `Утримані ${uah(S.ttn.hold)} додамо до виплати за ${monthLow(nextMonth(mk))}.` : `${uah(S.ttn.hold)} підуть у цю виплату.`, go: inCab('home') })];
    },
    birthdays(mk, at) {
      const gs = zp.employees.map(p => ({ p, g: zp.birthdayGift(p, mk) })).filter(x => x.g), out = [];
      const how = g => (g.young ? `стаж ${g.months} ${plural(g.months, 'місяць', 'місяці', 'місяців')}: ${g.months} × ${nf(S.birthday.perMonth)} + ${nf(g.company)} ₴ від компанії` : `збір колег ${g.givers.length} × ${nf(S.birthday.each)} ₴ + ${nf(g.company)} ₴ від компанії`);
      gs.forEach(({ p, g }) => out.push(make('bday', at, [p.id], { empId: p.id, title: `${dd(g.date)} — ваш день народження`,
        text: `За день народження буде нараховано +${uah(g.amount)} — автоматично, у виплаті за ${monthLow(mk)}. ${capFirst(how(g))}.`, go: inCab('home', '#bday') })));
      if (gs.length) out.push(make('bday', at, FIN, { title: `Дні народження: ${monthLow(mk)}`,
        text: `${gs.map(({ p, g }) => `${p.name} — ${dd(g.date)}, +${uah(g.amount)}${g.young ? ' (стаж до року, без збору)' : ''}`).join('; ')}. З колег — по ${S.birthday.each} ₴; рядки додано автоматично.`, go: { tab: 'acc' } }));
      return out;
    },
    /** Зміна рівня → задача рекрутеру, поки не підписано; менеджеру — до відома. task: {id, level, from, due, why, created} */
    offerTask(empId, task) {
      const p = P(empId);
      return [
        make('offer', task.created, [R.hr.id], { empId: p.id, cta: 'До задач', title: `Перепідписати офер — ${p.name}`, text: `${OFFER_TITLES[task.level]} з ${ddy(task.from)} (${task.why}). Підписати до ${ddy(task.due)}.`, go: { tab: 'tasks' },
          done: { kind: 'task.closed', taskId: task.id } }),
        make('lvl', task.created, [p.id], { empId: p.id, title: `З ${ddy(task.from)} — ${task.level === 'profi' ? '«Профі»' : '«Старт»'}`, text: `Новий офер — у ваших документах; рекрутер ${R.hr.name} зв’яжеться для підпису.`, go: inCab('terms') }),
      ];
    },
    offerSigned(empId, task, at) {
      return [make('lvl', at, [empId], { empId, title: 'Новий офер підписано', text: `${OFFER_TITLES[task.level]} — діє з ${ddy(task.from)}.`, go: inCab('terms') })];
    },
    /** Автоперехід на «Профі» (офер команди Лілії). change — результат zp.autoProfi(): {from, m1, m2} */
    levelAuto(empId, at, change) {
      const p = P(empId), mk = prevMonth(change.from), A = zp.offerOf(p).autoProfiFrom;
      const why = `маржа понад ${nf(A)} ₴ два місяці поспіль: ${monthLow(prevMonth(mk))} ${uah(change.m1)}, ${monthLow(mk)} ${uah(change.m2)}`;
      const txt = `${capFirst(why)}. Офер той самий — новий підпис не потрібен.`;
      return [
        make('lvl', at, [p.id], { empId: p.id, title: `З ${ddy(change.from + '-01')} — «Профі» автоматично`, text: txt, go: inCab('terms') }),
        make('lvl', at, FIN, { empId: p.id, title: `${p.name}: «Профі» з ${ddy(change.from + '-01')} — автоматично`, text: txt, go: { tab: 'acc' } }),
      ];
    },
  };

  /** Коли «потрібну дію» виконано: ISO-дата, true (виконано, дата невідома) або null (ще ні) */
  function notificationDoneAt(n) {
    if (!n.act || !n.done) return null;
    const d = evalRule(n.done);
    return d === true ? true : d && zp.seen(d) ? d : null;
  }
  function evalRule(r) {
    const clr = (state.clearances || {})[r.empId];
    switch (r.kind) {
      case 'clr.items': { if (!clr) return null; const ats = r.keys.map(k => clr.signatures[k] && clr.signatures[k].at); return ats.every(Boolean) ? ats.sort().pop() : null; }
      case 'clr.shots': return clr && clr.shots ? clr.shots.at : null;
      case 'clr.final': return clr && clr.signatures.pay ? clr.signatures.pay.at : null;
      case 'month.verified': return zp.employees.some(x => { const y = zp.record(x.id, r.month); return y && y.status === 'review'; }) ? null : true;
      case 'rec.answered': { const x = zp.record(r.empId, r.month); if (!x) return null; if (['agreed', 'submitted', 'paid'].includes(x.status)) return x.agreedAt || true; return x.status === 'disputed' && x.dispute && x.dispute.at >= r.since ? x.dispute.at : null; }
      case 'rec.resolved': { const x = zp.record(r.empId, r.month); return x && x.status !== 'disputed' ? x.verifiedAt || true : null; }
      case 'rec.paid': { const x = zp.record(r.empId, r.month); return x && x.status === 'paid' ? x.paidAt : null; }
      case 'adv.closed': { const a = (state.advances || {})[r.month] && state.advances[r.month][r.empId]; if (!a) return null; return a.cancelledAt && zp.seen(a.cancelledAt) ? a.cancelledAt : a.rejectedAt && zp.seen(a.rejectedAt) ? a.rejectedAt : a.paidAt && zp.seen(a.paidAt) ? a.paidAt : null; }
      case 'ttn.fixed': return zp.ttnOk(zp.ttnStats(r.empId, r.month)) ? zp.ttnFixedAt(r.empId, r.month) || true : null;
      case 'task.closed': { const t = (state.tasks || []).find(x => x.id === r.taskId); if (!t) return null; return t.voidAt && zp.seen(t.voidAt) ? t.voidAt : t.doneAt && zp.seen(t.doneAt) ? t.doneAt : null; }
      default: return null;
    }
  }
  /** Скільки днів чекає (для позначки «чекає N днів» — з 2 днів) */
  const daysWaiting = at => Math.max(0, Math.round((Date.parse(zp.today + 'T12:00:00Z') - Date.parse(at.slice(0, 10) + 'T12:00:00Z')) / 864e5));

  return { build, notificationDoneAt, daysWaiting, types: NOTIFICATION_TYPES };
}
