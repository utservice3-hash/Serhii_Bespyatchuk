// =====================================================================================
// «Зарплата» UTS — рушій розрахунку (чисті функції, без DOM, мережі й глобальних даних).
//
// Як користуватись:
//   import { createPayroll } from './zarplata-engine.mjs';
//   const zp = createPayroll(state);          // state — знімок даних на момент state.now (див. typedef State)
//   zp.calc('mar', '2026-11')                 // нараховано «зараз» і «при виконанні плану»
//   zp.settlement('mar', '2026-11')           // закриття місяця: нараховано → аванс → офіційна ЗП → ТТН → до виплати
//
// Логіка 1:1 з макетом v6 (UTS_Zarplata_maket_v6.html / UTS_Moya_zarplata.html) — перевіряє test/golden.test.mjs.
// Усі функції рахують «станом на state.now»: події з датою пізніше (аванс, підпис, ТТН) не враховуються.
// =====================================================================================

/** @typedef {'start'|'profi'} Level */
/** @typedef {'manager'|'lead'|'staff'} Role */
/** @typedef {'own'|'ownNow'|'probation'|'company'|'gross'} LeaveType */
/**
 * @typedef {Object} Employee
 * @property {string} id                 id користувача дашборда
 * @property {string} name
 * @property {Role} role                 manager — менеджер з продажу; lead — тім-лід; staff — ставка (+ % за правилом)
 * @property {string} title
 * @property {string} dept               код відділу (оргструктура)
 * @property {string|null} team          код команди продажу (менеджер / тім-лід)
 * @property {string|null} [leadsTeam]   тім-лід: команда, яку веде
 * @property {string} startDate          'YYYY-MM-DD' — перший робочий день
 * @property {string|null} birthday      'MM-DD'
 * @property {Array<Term>} terms         умови з місяця (рівень / ставка / відсоток); діє останній запис з from ≤ місяць
 * @property {Array<{from:string, amount:number, deduct:boolean}>} [official]  офіційна ЗП з місяця; amount 0 — більше немає
 * @property {{date:string, type:LeaveType}|null} [leave]  звільнення
 * @property {boolean} [isFinance]       фінансист (його ЗП перевіряє ОД)
 * @property {string} [offer]            код оферу; якщо не задано — за командою (settings.teamOffers), інакше 'std'
 */
/** @typedef {{from:string, level?:Level, rate?:number, pct?:({base:'company', value:number}|null)}} Term */
/** @typedef {{id:string, date:string, client:string, margin:number, pay:'paid'|'wait'|'over', note?:string}} Deal */
/** @typedef {{normDays:number, leads:number, targetDeals:number}} Kpi */
/**
 * @typedef {Object} PayrollRecord   закриття місяця по працівнику (створюється при закритті місяця)
 * @property {'review'|'verified'|'disputed'|'agreed'|'submitted'|'paid'} status
 * @property {{margin?:number, pct?:number, rate?:number, bonus?:number}} overrides   «істинне» значення фінансиста
 * @property {Object<string,string>} notes                                         внутрішні коментарі до змін
 * @property {Array<{kind:keyof EXTRA_KINDS, amount:number, note:string}>} extras  премії, утримання, корекції, податки
 * @property {string} [verifiedAt] @property {string} [verifiedBy] @property {string} [agreedAt]
 * @property {{text:string, at:string}} [dispute] @property {string} [reply]
 * @property {{cash:number, cards:Array<{no:string, who:string, amount:number}>, at:string}} [form]
 * @property {string} [paidAt] @property {string} [paidBy]
 */
/**
 * @typedef {Object} Advance
 * @property {number} amount @property {number} cash @property {Array<{no:string, who:string, amount:number}>} cards
 * @property {string} requestedAt @property {string} [paidAt] @property {string} [paidBy]
 * @property {string} [rejectedAt] @property {string} [rejectedBy] @property {string} [reason] @property {string} [cancelledAt]
 */
/**
 * @typedef {Object} Clearance       електронний обхідний лист
 * @property {string} createdAt @property {string} createdBy
 * @property {{at:string, n:number}|null} [shots]                 скріншоти повідомлень клієнтам від менеджера
 * @property {Object<string,{at:string, by:string, data:any}>} signatures   ключ пункту → підпис (знімок позначок)
 */
/**
 * @typedef {Object} State
 * @property {string} now                 'YYYY-MM-DD' або 'YYYY-MM-DDTHH:MM' (Europe/Kyiv)
 * @property {string} liveMonth           поточний місяць 'YYYY-MM'
 * @property {string|null} closedMonth    закритий місяць, що перевіряється / виплачується (null — немає)
 * @property {Object} [settings]          часткові налаштування поверх DEFAULT_SETTINGS
 * @property {Employee[]} employees
 * @property {Object<string,{name:string, sales:boolean}>} departments
 * @property {Object<string,{name:string}>} teams
 * @property {Object<string,Object<string,number>>} plans          plans[month][empId] — затверджений план (₴ маржі)
 * @property {Object<string,Object<string,Deal[]>>} deals          deals[empId][month] — угоди «Успішно реалізовано»
 * @property {Object<string,Object<string,Kpi>>} kpi                kpi[empId][month] — на зараз (поточний) / підсумок (закритий)
 * @property {Object<string,string|null>} ttnAt                      ttnAt[dealId] — коли з’явилась ТТН; null — немає
 * @property {Object} [ttnLegacy]       ttnLegacy[empId][month] = {total, done, held, fix:{at, n}} — місяці до запуску
 * @property {Object<string,Object<string,PayrollRecord>>} [records] records[month][empId]
 * @property {Object<string,Object<string,Advance>>} [advances]     advances[month][empId]
 * @property {Object<string,Array<{month:string, level:Level|null, margin:number, fund:number}>>} [archive]  імпорт Excel
 * @property {Object<string,Array<{client:string, byMonth:Object<string,number>}>>} [clientHistory]  маржа за клієнтом до запуску
 * @property {Object<string,Clearance>} [clearances]
 * @property {{ba:{id:string,name:string}, acc:{id:string,name:string}, hr:{id:string,name:string}, od:{id:string,name:string}, finance:string[]}} responsibles
 * @property {Array} [tasks]            задачі рекрутера (для «потрібна дія» у сповіщеннях)
 * @property {string[]} [holidays]      дні, що не є робочими (якщо компанія їх задає); за замовчуванням — лише пн–пт
 */

// ---------- налаштування за замовчуванням (рішення Сергія 25.10–03.11) ----------
export const DEFAULT_SETTINGS = Object.freeze({
  payMode: 'success',          // 'success' — маржа в місяці «Успішно реалізовано»; 'paid' — лише оплачені; 'overdue' — без прострочених
  verifyByDay: 6, payByDay: 8, // фінансист перевіряє до 6-го, виплата до 8-го
  start: { rate: 5000, pctLow: 10, pctHigh: 20, minPlanForHigh: 30000 },
  profi: { threshold: 70000, pct1: 25, pct2: 30, pct3: 35 },
  kpi: { normCalls: 45, missDaysAllowed: 2, waiveFrom: 50000, ladder: [[12, 3000], [15, 5000], [20, 8000], [25, 10000], [30, 12000]] },
  lead: { pctLow: 3, pctHigh: 6 },
  advance: { fromDay: 25, managerPct: 15, leadPct: 15, staffPct: 50 },
  birthday: { each: 100, company: 400, lead: 600, perMonth: 100 },
  ttn: { minPct: 70, hold: 3000 },
  offers: {
    std: { name: 'Стандартний офер', kpi: true, startRate: null, startPlan: null, autoProfiFrom: null, regularOnProfi: false },
    ls: { name: 'Офер команди Лілії Шаврової', kpi: false, startRate: 10000, startPlan: 50000, autoProfiFrom: 50000, regularOnProfi: true },
  },
  teamOffers: { ls: 'ls' },    // команда → офер (решта — 'std')
});

/** «Премії, утримання» у вікні фінансиста: назва і знак */
export const EXTRA_KINDS = Object.freeze({
  prem: ['Премія', 1], corrP: ['Корекція +', 1], ded: ['Утримання', -1], corrM: ['Корекція −', -1], tax: ['Податки', -1],
});

/** Звільнення (п. 11 оферу) */
export const LEAVE_TYPES = Object.freeze({
  own: ['за власним бажанням (з попередженням)', 'ставка за неповний місяць не нараховується — лише відсоток від маржі'],
  ownNow: ['за власним бажанням, без 2 тижнів', 'лише відсоток від маржі; розрахунок — після обхідного листа'],
  probation: ['під час / після випробувального', 'ставка за перший місяць не нараховується; відсоток і бонус — за відпрацьований період'],
  company: ['з ініціативи компанії', 'ставка — пропорційно відпрацьованим дням'],
  gross: ['грубе порушення', 'лише відсоток від маржі'],
});

/** Обхідний лист — бланк компанії: 8 пунктів підписують відповідальні; 9-й — ОД, лише після всіх */
export const CLEARANCE_ITEMS = Object.freeze([
  { k: 'clients', role: 'lead', t: 'Вигрузити інформацію по клієнтах з бухгалтерії', d: 'Реєстр постійних клієнтів: тім-лід призначає нового відповідального по кожному клієнту — скрізь у дашборді в цих клієнтів новий відповідальний.' },
  { k: 'crm', role: 'ba', t: 'В усіх активних угодах у CRM відповідальний — тім-лід; паролі й доступи менеджера змінено', checks: ['Активні угоди в CRM переведено на тім-ліда', 'Паролі й доступи менеджера змінено'] },
  { k: 'notify', role: 'lead', t: 'Менеджер письмово (месенджер) повідомив клієнтів', d: 'Скріншоти — тім-ліду: він архівує й передає.' },
  { k: 'reconcile', role: 'acc', t: 'Звірка з бухгалтерією', d: 'Відсутність заборгованостей і наявність усіх оригіналів документів.', checks: ['Заборгованостей немає', 'Оригінали всіх документів є'] },
  { k: 'trucks', role: 'lead', t: 'Машини по кожному клієнту ставить новий відповідальний', d: 'Попередній менеджер допомагає йому до дня звільнення.', checks: ['Новий відповідальний ставить машини сам'] },
  { k: 'chats', role: 'ba', t: 'Видалити працівника з усіх чатів і каналів компанії', checks: ['Видалено з усіх чатів і каналів'] },
  { k: 'tech', role: 'ba', t: 'Передача й перевірка робочої техніки', d: 'За актом приймання-передачі ТМЦ.', checks: ['Ноутбук / комп’ютер', 'Навушники', 'Телефон'] },
  { k: 'exit', role: 'hr', t: 'Exit-інтерв’ю', checks: ['Exit-інтерв’ю проведено'] },
  { k: 'pay', role: 'od', t: 'Розрахунок та видача заробітної плати', d: 'Після всіх підписів вище: ОД погоджує фінальний розрахунок, фінансист виплачує.', final: true },
]);
export const CLEARANCE_ROLES = Object.freeze({ lead: 'Тім-лід', ba: 'Бізнес-асистент', acc: 'Бухгалтерія', hr: 'HR', od: 'ОД' });
const CLEARANCE_TASKS = CLEARANCE_ITEMS.filter(x => !x.final);

/** Статуси закриття місяця і хто що може (див. ТЗ, розділ «Закриття місяця») */
export const RECORD_FLOW = Object.freeze({
  review: { verify: 'verified' },
  verified: { verify: 'verified', agree: 'agreed', dispute: 'disputed' },
  disputed: { verify: 'verified', resolveKeep: 'verified', resolveAuto: 'verified' },
  agreed: { verify: 'verified', submitForm: 'submitted' },
  submitted: { markPaid: 'paid' },
  paid: {},
});
/** Наступний статус або null, якщо дія з цього статусу недоступна */
export const nextStatus = (status, action) => (RECORD_FLOW[status] && RECORD_FLOW[status][action]) || null;

// ---------- дати й гроші ----------
export const sum = a => a.reduce((s, x) => s + (Number(x) || 0), 0);
export const ceilE = x => Math.ceil(x - 1e-9);   // вгору без хвостів плаваючої коми
export const nextMonth = mk => { const [y, m] = mk.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
export const prevMonth = mk => { const [y, m] = mk.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
export const lastDay = mk => { const [y, m] = mk.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const addDays = (iso, n) => { const t = new Date(iso.slice(0, 10) + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
/** Номер карти: 16–19 цифр і контрольна сума Луна */
export const luhn = s => { const d = String(s).replace(/\D/g, ''); if (d.length < 16 || d.length > 19) return false; let t = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } t += n; } return t % 10 === 0; };

const merge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k]; return o; };
const EMPTY_KPI = Object.freeze({ normDays: 0, leads: 0, targetDeals: 0 });

/**
 * Створює рушій над знімком даних.
 * @param {State} state
 */
export function createPayroll(state) {
  const S = merge(DEFAULT_SETTINGS, state.settings || {});
  const now = state.now, today = now.slice(0, 10);
  const liveMonth = state.liveMonth, closedMonth = state.closedMonth || null;
  const E = state.employees, byId = Object.fromEntries(E.map(e => [e.id, e]));
  const DEPTS = state.departments, TEAMS = state.teams;
  const holidays = new Set(state.holidays || []);
  const R = state.responsibles;

  const seen = iso => !!iso && iso.slice(0, 10) <= today;                  // подія вже сталася (з точністю до дня)
  const upTo = (iso, asOf) => !!iso && iso <= (asOf.length > 10 ? asOf : asOf + 'T23:59');   // з точністю до хвилини
  const isLive = mk => mk === liveMonth;
  const person = id => byId[id] || null;

  // ---------- офер, умови, оргструктура ----------
  const offerCode = e => e.offer || S.teamOffers[e.team] || 'std';
  const offerOf = e => S.offers[offerCode(e)] || S.offers.std;
  const startRateOf = e => (offerOf(e).startRate != null ? offerOf(e).startRate : S.start.rate);
  const hasKpi = e => offerOf(e).kpi !== false;
  const regularAllowed = (e, lv) => lv === 'start' || !!offerOf(e).regularOnProfi;   // калькулятор: постійні клієнти
  function termsOf(e, mk) {
    const t = {};
    (e.terms || []).filter(x => x.from <= mk).sort((a, b) => a.from.localeCompare(b.from)).forEach(x => Object.assign(t, x));
    return t;
  }
  const levelOf = (e, mk) => termsOf(e, mk).level || null;
  const rateOf = (e, mk) => termsOf(e, mk).rate || 0;
  const pctRuleOf = (e, mk) => termsOf(e, mk).pct || null;
  /** Наступна зміна рівня після місяця mk (напр. «з грудня — Профі») */
  const levelChangeAfter = (e, mk) => (e.terms || []).filter(x => x.from > mk && x.level && x.level !== levelOf(e, mk)).sort((a, b) => a.from.localeCompare(b.from))[0] || null;
  const deptOf = e => e.dept;
  const isSimple = e => !(DEPTS[deptOf(e)] && DEPTS[deptOf(e)].sales);     // не продає — простий кабінет
  const leadOf = e => (e.role === 'manager' ? E.find(x => x.role === 'lead' && x.leadsTeam === e.team) || null : null);
  const teamOf = lead => E.filter(x => x.role === 'manager' && x.team === lead.leadsTeam);
  const planOf = (id, mk) => ((state.plans || {})[mk] || {})[id] || 0;

  // ---------- робочі дні: з дня виходу до звільнення або кінця місяця; «минуло» — до сьогодні ----------
  function workdays(mk, from = 1, to = 31) {
    const [y, m] = mk.split('-').map(Number); let n = 0;
    for (let d = from; d <= to; d++) {
      const t = new Date(Date.UTC(y, m - 1, d)); if (t.getUTCMonth() !== m - 1) break;
      const w = t.getUTCDay(); if (w > 0 && w < 6 && !holidays.has(t.toISOString().slice(0, 10))) n++;
    }
    return n;
  }
  const employedIn = (e, mk) => e.startDate.slice(0, 7) <= mk && !(e.leave && e.leave.date.slice(0, 7) < mk);
  const leaveIn = (e, mk) => (e.leave && e.leave.date.slice(0, 7) === mk ? e.leave : null);
  function days(e, mk) {
    const full = workdays(mk), lv = leaveIn(e, mk);
    const from = e.startDate.slice(0, 7) === mk ? +e.startDate.slice(8, 10) : 1, to = lv ? +lv.date.slice(8, 10) : 31;
    const total = workdays(mk, from, to);
    const elapsed = isLive(mk) ? Math.min(total, workdays(mk, from, Math.min(to, +today.slice(8, 10)))) : total;
    return { total, elapsed, full, left: total - elapsed };
  }

  // ---------- угоди й КПІ з ядра ----------
  const counts = d => S.payMode === 'success' || (S.payMode === 'paid' ? d.pay === 'paid' : d.pay !== 'over');
  const allDeals = (id, mk) => ((state.deals || {})[id] && state.deals[id][mk]) || [];
  const dealsOf = (id, mk) => allDeals(id, mk).filter(d => d.date <= today);
  const kpiOf = (id, mk) => ((state.kpi || {})[id] && state.kpi[id][mk]) || EMPTY_KPI;
  const kpiStep = conv => S.kpi.ladder.reduce((a, s) => (conv >= s[0] ? s : a), null);
  function managerPct(lv, plan, m) {
    if (lv === 'start') return plan >= S.start.minPlanForHigh && m >= plan ? S.start.pctHigh : S.start.pctLow;
    return plan && m >= plan ? S.profi.pct3 : m >= S.profi.threshold ? S.profi.pct2 : S.profi.pct1;
  }

  // ---------- дні народження: рядки нараховуються автоматично ----------
  const birthdayIn = (e, mk) => (e.birthday && e.birthday.slice(0, 2) === mk.slice(5) && employedIn(e, mk) ? `${mk}-${e.birthday.slice(3)}` : null);
  function tenureMonths(e, iso) {
    const [sy, sm, sd] = e.startDate.split('-').map(Number), [y, m, d] = iso.split('-').map(Number);
    return Math.max(0, (y - sy) * 12 + (m - sm) - (d < sd ? 1 : 0));
  }
  /** Іменинник: стаж від року — збір колег + від компанії; до року — 100 ₴ × місяці + від компанії (без збору) */
  function birthdayGift(e, mk) {
    const iso = birthdayIn(e, mk); if (!iso) return null;
    const months = tenureMonths(e, iso), young = months < 12;
    const company = e.role === 'lead' ? S.birthday.lead : S.birthday.company;
    const givers = young ? [] : E.filter(x => x !== e && employedIn(x, mk)).map(x => x.id);
    const fromTeam = givers.length * S.birthday.each, fromMonths = young ? months * S.birthday.perMonth : 0;
    return { date: iso, months, young, company, givers, fromTeam, fromMonths, amount: fromTeam + fromMonths + company };
  }
  function birthdayLines(e, mk) {
    const out = [], g = birthdayGift(e, mk);
    if (g) out.push({ kind: 'gift', amount: g.amount, gift: g });
    E.forEach(x => { if (x === e) return; const gx = birthdayGift(x, mk); if (gx && gx.givers.includes(e.id)) out.push({ kind: 'give', amount: -S.birthday.each, who: x.id, date: gx.date }); });
    return out;
  }

  // ---------- закриття: записи фінансиста ----------
  const record = (id, mk) => ((state.records || {})[mk] && state.records[mk][id]) || null;
  const verifiedMargin = (id, mk) => { const r = record(id, mk); return r && r.status !== 'review' && r.overrides && r.overrides.margin !== undefined ? r.overrides.margin : null; };

  // ---------- розрахунок: «зараз» і «при виконанні плану» (маржа = max(факт, план)) ----------
  function calcManager(e, mk) {
    const live = isLive(mk), lv = levelOf(e, mk), dy = days(e, mk), of = offerOf(e);
    const all = dealsOf(e.id, mk), used = all.filter(counts), held = all.filter(d => !counts(d));
    const margin = sum(used.map(d => d.margin));
    const plan = lv === 'start' && of.startPlan != null ? of.startPlan : planOf(e.id, mk);
    const marginPlan = Math.max(margin, plan);
    const lt = leaveIn(e, mk) ? e.leave.type : null;   // звільнення цього місяця — п. 11 оферу
    const rate = lv === 'start' && (!lt || lt === 'company') ? Math.round(startRateOf(e) * dy.total / dy.full) : 0;
    let kpi = null;
    if (lv === 'start' && hasKpi(e)) {
      const k = kpiOf(e.id, mk), need = Math.max(0, dy.total - S.kpi.missDaysAllowed), conv = k.leads ? k.targetDeals / k.leads * 100 : 0, step = kpiStep(conv);
      const reach = k.normDays + dy.left >= need;                    // норму дзвінків ще можна набрати
      const noBonus = lt === 'own' || lt === 'ownNow' || lt === 'gross';
      const amt = step ? step[1] : 0, ok = m => m >= S.kpi.waiveFrom || reach;
      kpi = { normDays: k.normDays, leads: k.leads, targetDeals: k.targetDeals, need, conv, step, reach, left: dy.left, done: k.normDays >= need, noBonus, waived: margin >= S.kpi.waiveFrom,
        bonusNow: !noBonus && ok(margin) ? amt : 0, bonusPlan: !noBonus && ok(marginPlan) ? amt : 0 };
    }
    const birthdays = birthdayLines(e, mk), bday = sum(birthdays.map(b => b.amount));
    const pctNow = managerPct(lv, plan, margin), pctPlan = managerPct(lv, plan, marginPlan);
    const nowP = { rate, pct: pctNow, pctAmount: margin * pctNow / 100, bonus: kpi ? kpi.bonusNow : 0, birthday: bday };
    const planP = { rate, pct: pctPlan, pctAmount: marginPlan * pctPlan / 100, bonus: kpi ? kpi.bonusPlan : 0, birthday: bday };
    nowP.total = nowP.rate + nowP.pctAmount + nowP.bonus + bday; planP.total = planP.rate + planP.pctAmount + planP.bonus + bday;
    return { kind: 'manager', empId: e.id, month: mk, live, level: lv, offer: offerCode(e), days: dy, deals: all, held, margin, marginPlan, plan, planDone: plan > 0 && margin >= plan, kpi, birthdays, now: nowP, atPlan: planP };
  }
  function calcLead(e, mk) {
    const live = isLive(mk), dy = days(e, mk);
    const members = teamOf(e).filter(x => employedIn(x, mk)).map(x => { const c = calcManager(x, mk); const v = live ? null : verifiedMargin(x.id, mk); return { empId: x.id, calc: c, margin: v !== null ? v : c.margin, changed: v !== null }; });
    const margin = sum(members.map(m => m.margin)), plan = sum(members.map(m => m.calc.plan)), marginPlan = Math.max(margin, plan);
    const pctFor = m => (plan && m >= plan ? S.lead.pctHigh : S.lead.pctLow);
    const rate = Math.round(rateOf(e, mk) * dy.total / dy.full);
    const birthdays = birthdayLines(e, mk), bday = sum(birthdays.map(b => b.amount));
    const nowP = { rate, pct: pctFor(margin), pctAmount: margin * pctFor(margin) / 100, bonus: 0, birthday: bday };
    const planP = { rate, pct: pctFor(marginPlan), pctAmount: marginPlan * pctFor(marginPlan) / 100, bonus: 0, birthday: bday };
    nowP.total = nowP.rate + nowP.pctAmount + bday; planP.total = planP.rate + planP.pctAmount + bday;
    return { kind: 'lead', empId: e.id, month: mk, live, days: dy, members, margin, marginPlan, plan, planDone: plan > 0 && margin >= plan, birthdays, now: nowP, atPlan: planP };
  }
  /** Маржа компанії = сума маржі менеджерів (у закритому місяці — перевірена фінансистом) */
  function companyMargin(mk) {
    return sum(E.filter(x => x.role === 'manager' && employedIn(x, mk)).map(x => { const c = calcManager(x, mk); const v = c.live ? null : verifiedMargin(x.id, mk); return v !== null ? v : c.margin; }));
  }
  const companyPlan = mk => sum(E.filter(x => x.role === 'manager' && employedIn(x, mk)).map(x => planOf(x.id, mk)));
  function calcStaff(e, mk) {
    const live = isLive(mk), dy = days(e, mk), r = pctRuleOf(e, mk);
    const rate = Math.round(rateOf(e, mk) * dy.total / dy.full);
    const base = r ? companyMargin(mk) : 0, plan = r ? companyPlan(mk) : 0, basePlan = Math.max(base, plan);   // база відсотка — маржа компанії
    const birthdays = birthdayLines(e, mk), bday = sum(birthdays.map(b => b.amount));
    const nowP = { rate, pct: r ? r.value : 0, pctAmount: r ? base * r.value / 100 : 0, bonus: 0, birthday: bday };
    const planP = { rate, pct: r ? r.value : 0, pctAmount: r ? basePlan * r.value / 100 : 0, bonus: 0, birthday: bday };
    nowP.total = nowP.rate + nowP.pctAmount + bday; planP.total = planP.rate + planP.pctAmount + bday;
    return { kind: 'staff', empId: e.id, month: mk, live, days: dy, margin: base, marginPlan: basePlan, plan, planDone: !!r && plan > 0 && base >= plan, pctRule: r, birthdays, now: nowP, atPlan: planP };
  }
  const calcE = (e, mk) => (e.role === 'manager' ? calcManager(e, mk) : e.role === 'lead' ? calcLead(e, mk) : calcStaff(e, mk));

  // ---------- офіційна ЗП: статична, щомісяця, поки фінансист або ОД не змінить ----------
  const officialOf = (e, mk) => { const o = (e.official || []).filter(x => x.from <= mk).sort((a, b) => a.from.localeCompare(b.from)).pop(); return o && o.amount > 0 ? o : null; };

  // ---------- аванс: заявка з 25-го, ліміт на сьогодні, вираховується при закритті ----------
  const advanceOf = (id, mk) => { const a = (state.advances || {})[mk] && state.advances[mk][id]; return a && seen(a.requestedAt) && !(a.cancelledAt && seen(a.cancelledAt)) ? a : null; };
  const advanceStatus = a => (!a ? null : a.rejectedAt && seen(a.rejectedAt) ? 'rejected' : a.paidAt && seen(a.paidAt) ? 'paid' : 'requested');
  const advancePaid = (id, mk) => { const a = advanceOf(id, mk); return a && advanceStatus(a) === 'paid' ? a.amount : 0; };
  const advanceWindowOpen = mk => isLive(mk) && +today.slice(8, 10) >= S.advance.fromDay;
  /** Ліміт: менеджер — % маржі «Успішно реалізовано», тім-лід — % маржі команди, ставка — % ставки; не більше нарахованого */
  function advanceLimit(e, mk) {
    const c = calcE(e, mk);
    const [base, pct, basis] = c.kind === 'manager' ? [c.margin, S.advance.managerPct, 'margin'] : c.kind === 'lead' ? [c.margin, S.advance.leadPct, 'teamMargin'] : [c.now.rate, S.advance.staffPct, 'rate'];
    const byRule = Math.max(0, Math.floor(base * pct / 100)), cap = Math.max(0, Math.floor(c.now.total));
    return { basis, base, pct, byRule, cap, amount: Math.min(byRule, cap), capped: cap < byRule, calc: c };
  }

  // ---------- ТТН: частка угод місяця з ТТН («Бізнес-асистент → ТТН моніторинг») ----------
  const legacyTtn = (id, mk) => (state.ttnLegacy || {})[id] && state.ttnLegacy[id][mk] || null;
  const ttnDate = d => ((state.ttnAt || {})[d.id] !== undefined ? state.ttnAt[d.id] : null);
  function ttnStats(e, mk, asOf = today) {
    const past = legacyTtn(e.id, mk);
    if (past) { const done = past.done + (past.fix && upTo(past.fix.at, asOf) ? past.fix.n : 0); return { total: past.total, done, pct: done / past.total * 100, missing: [], legacy: past }; }
    const ds = allDeals(e.id, mk).filter(d => upTo(d.date, asOf)), has = d => upTo(ttnDate(d), asOf);
    const done = ds.filter(has).length;
    return { total: ds.length, done, pct: ds.length ? done / ds.length * 100 : 100, missing: ds.filter(d => !has(d)) };
  }
  const ttnOk = t => !t.total || t.pct >= S.ttn.minPct;
  const ttnFixedAt = (e, mk) => { const past = legacyTtn(e.id, mk); if (past) return past.fix && seen(past.fix.at) ? past.fix.at : null; return allDeals(e.id, mk).map(ttnDate).filter(x => x && seen(x)).sort().pop() || null; };
  /** Утримання попереднього місяця, з яким уже пішла виплата: повертаємо, щойно ТТН закрито; ні — переходить далі */
  function ttnPrev(e, mk, asOf = today) {
    if (e.role !== 'manager') return null;
    const pm = prevMonth(mk), past = legacyTtn(e.id, pm), r = record(e.id, pm);
    const held = past ? !!past.held : !!(r && r.status === 'paid' && r.paidAt && !ttnOk(ttnStats(e, pm, r.paidAt)));
    if (!held) return null;
    const t = ttnStats(e, pm, asOf);
    return { month: pm, ttn: t, released: ttnOk(t), at: ttnOk(t) ? ttnFixedAt(e, pm) : null };
  }
  /** Рядки ТТН у закритті: стан фіксується в момент ВИПЛАТИ — закрили до виплати → у цій виплаті, після → у наступному місяці */
  function ttnLines(e, mk) {
    if (e.role !== 'manager' || isLive(mk)) return [];
    const r = record(e.id, mk), asOf = r && r.status === 'paid' && r.paidAt ? r.paidAt : today, t = ttnStats(e, mk, asOf), out = [];
    if (!ttnOk(t)) out.push({ kind: 'hold', month: mk, amount: -S.ttn.hold, ttn: t });
    const pv = ttnPrev(e, mk, asOf);
    if (pv) out.push(pv.released ? { kind: 'release', month: pv.month, amount: S.ttn.hold, ttn: pv.ttn, at: pv.at } : { kind: 'carry', month: pv.month, amount: 0, ttn: pv.ttn });
    return out;
  }

  // ---------- офер команди Лілії: «Профі» автоматично — маржа понад поріг два місяці поспіль ----------
  function marginOfMonth(e, mk) {
    const h = ((state.archive || {})[e.id] || []).find(x => x.month === mk); if (h) return h.margin;
    if (!(state.deals || {})[e.id] || !state.deals[e.id][mk]) return null;
    const v = isLive(mk) ? null : verifiedMargin(e.id, mk);
    return v !== null ? v : calcManager(e, mk).margin;
  }
  /** Перевірка при закритті місяця mk: повертає новий запис умов {from, level:'profi', why} або null */
  function autoProfi(e, mk) {
    const A = offerOf(e).autoProfiFrom;
    if (!A || e.role !== 'manager' || levelOf(e, mk) !== 'start' || levelChangeAfter(e, mk)) return null;
    const m1 = marginOfMonth(e, prevMonth(mk)), m2 = marginOfMonth(e, mk);
    return m1 > A && m2 > A ? { from: nextMonth(mk), level: 'profi', m1, m2 } : null;
  }

  // ---------- підсумок місяця: нараховано → аванс → офіційна ЗП → ТТН → до виплати ----------
  const EMPTY_REC = Object.freeze({ status: null, overrides: {}, notes: {}, extras: [] });
  function settlement(e, mk) {
    const c = calcE(e, mk), r0 = record(e.id, mk), r = r0 ? { overrides: {}, notes: {}, extras: [], ...r0 } : EMPTY_REC;
    const auto = { margin: c.margin, pct: c.now.pct, rate: c.now.rate, bonus: c.now.bonus };
    const v = { ...auto, ...r.overrides };
    if (r.overrides.margin !== undefined && r.overrides.pct === undefined && c.kind === 'manager') v.pct = managerPct(c.level, c.plan, v.margin);
    if (c.kind === 'lead' && r.overrides.pct === undefined) v.pct = c.plan && v.margin >= c.plan ? S.lead.pctHigh : S.lead.pctLow;
    const extras = sum(r.extras.map(x => EXTRA_KINDS[x.kind][1] * x.amount)), bday = c.now.birthday;
    const pctAmount = v.margin * v.pct / 100;
    const total = v.rate + pctAmount + v.bonus + bday + extras;
    const autoTotal = auto.rate + auto.margin * auto.pct / 100 + auto.bonus + bday;
    const advance = advancePaid(e.id, mk), official = officialOf(e, mk), officialDeducted = official && official.deduct ? official.amount : 0;
    const tl = ttnLines(e, mk), ttn = sum(tl.map(x => x.amount));
    return { calc: c, record: r0, auto, values: v, pctAmount, birthday: bday, extras, total, autoTotal, advance, official, officialDeducted, ttnLines: tl, ttn, pay: total - advance - officialDeducted + ttn };
  }
  /** Форма на виплату: готівка + карти разом мають дорівнювати «До виплати»; нова карта (isNew) — номер за Луном і власник */
  function checkPayoutForm(e, mk, form) {
    const lines = (form.cards || []).filter(c => c.amount), digits = c => String(c.no).replace(/\D/g, '');
    const due = Math.round(settlement(e, mk).pay), got = Math.round((form.cash || 0) + sum(lines.map(c => c.amount)));
    const badCards = lines.filter(c => c.isNew && (!luhn(c.no) || !String(c.who || '').trim())).map(c => c.no);
    const negative = (form.cash || 0) < 0 || lines.some(c => c.amount < 0);
    const duplicate = new Set(lines.map(digits)).size !== lines.length;     // одна карта двічі — об’єднати суми
    return { ok: due === got && !badCards.length && !negative && !duplicate, due, got, rest: due - got, badCards, negative, duplicate };
  }
  /** Виплата за поданою формою: ТТН закрили після подання форми, але до виплати — різницю додаємо на першу карту (або готівку) */
  function payoutLines(e, mk) {
    const f = settlement(e, mk), fm = f.record && f.record.form; if (!fm) return null;
    const cards = (fm.cards || []).map(c => ({ ...c })), diff = Math.round(f.pay) - Math.round((fm.cash || 0) + sum(cards.map(c => c.amount)));
    let cash = fm.cash || 0;
    if (diff) { if (cards.length) cards[0].amount += diff; else cash += diff; }
    return { cash, cards, diff };
  }

  // ---------- обхідний лист ----------
  /** Відповідальний за роль пункту: {id, name}; команда без тім-ліда — ОД («за тім-ліда») */
  function clearanceResponsible(e, role) {
    if (role === 'lead') { const l = leadOf(e); return l ? { id: l.id, name: l.name } : { id: R.od.id, name: `${R.od.name} (за тім-ліда)` }; }
    return R[role];
  }
  /** Клієнти працівника для передачі (п. 1): з угод і історії клієнтів */
  const clearanceClients = e => [...new Set([...Object.values((state.deals || {})[e.id] || {}).flat().map(d => d.client), ...((state.clientHistory || {})[e.id] || []).map(h => h.client)])];
  /** Кому можна передати клієнтів — менеджери тієї ж команди, що не звільняються */
  const clearanceHeirs = e => E.filter(x => x.role === 'manager' && x.team === e.team && x !== e && !x.leave).map(x => x.id);
  const clearanceOf = e => { const c = (state.clearances || {})[e.id]; return e.leave && c && seen(c.createdAt) ? c : null; };
  const clearanceSigned = (c, k) => (c.signatures[k] && seen(c.signatures[k].at) ? c.signatures[k] : null);
  const clearanceShots = c => (c.shots && seen(c.shots.at) ? c.shots : null);
  function clearanceState(e) {
    const c = clearanceOf(e); if (!c) return null;
    const done = CLEARANCE_TASKS.filter(x => clearanceSigned(c, x.k)).length;
    return { clearance: c, done, total: CLEARANCE_TASKS.length, ok: done === CLEARANCE_TASKS.length, final: clearanceSigned(c, 'pay') };
  }
  /** Чи можна підписати пункт з такими даними (позначки / клієнт → новий відповідальний) */
  function clearanceReady(e, k, data) {
    const x = CLEARANCE_ITEMS.find(i => i.k === k), c = clearanceOf(e); if (!x || !c) return false;
    if (x.final) return clearanceState(e).ok;
    if (k === 'clients') { const d = data || {}; return clearanceClients(e).every(cl => d[cl]); }
    if (k === 'notify') { const sh = clearanceShots(c); return !!(sh && sh.n >= clearanceClients(e).length); }
    const d = data || (x.checks || []).map(() => false);
    return d.length === (x.checks || []).length && d.every(Boolean);
  }
  const clearanceCanSign = (e, k, userId) => { const x = CLEARANCE_ITEMS.find(i => i.k === k); return !!x && clearanceResponsible(e, x.role).id === userId; };
  const isFinal = (e, mk) => !!(e.leave && e.leave.date.slice(0, 7) === mk);        // місяць звільнення — фінальний розрахунок
  const payBlocked = (e, mk) => { const s = isFinal(e, mk) ? clearanceState(e) : null; return !!(s && !s.ok); };   // форма — після 8 підписів
  const payNeedsOd = (e, mk) => { const s = isFinal(e, mk) ? clearanceState(e) : null; return !!(s && !s.final); }; // виплата — після погодження ОД

  // ---------- прогноз для ОД: фонд, готівка, ризики, команди ----------
  function forecast(mk) {
    const rows = E.filter(e => employedIn(e, mk)).map(e => { const a = advanceOf(e.id, mk); return { e, c: calcE(e, mk), a, as: advanceStatus(a), o: officialOf(e, mk), t: e.role === 'manager' ? ttnStats(e, mk) : null, L: advanceLimit(e, mk) }; });
    const fundNow = sum(rows.map(x => x.c.now.total)), fundPlan = sum(rows.map(x => x.c.atPlan.total));
    const advPaid = sum(rows.filter(x => x.as === 'paid').map(x => x.a.amount)), advRequested = sum(rows.filter(x => x.as === 'requested').map(x => x.a.amount));
    const advLeft = sum(rows.filter(x => !x.a || x.as === 'rejected').map(x => x.L.amount));
    const officialDeducted = sum(rows.map(x => (x.o && x.o.deduct ? x.o.amount : 0))), officialSeparate = sum(rows.map(x => (x.o && !x.o.deduct ? x.o.amount : 0)));
    const late = x => x.t && !ttnOk(x.t) && x.t.missing.some(d => addDays(d.date, 7) < today);
    const risks = [];
    rows.filter(x => x.e.role === 'manager' && x.c.plan > x.c.margin && x.c.days.left > 0 && x.c.days.elapsed >= 5).forEach(x => {   // з першого тижня — замало даних
      const c = x.c, need = (c.plan - c.margin) / c.days.left, avg = c.margin / Math.max(1, c.days.elapsed);
      if (need > avg * 1.15) risks.push({ kind: 'plan', empId: x.e.id, need, avg, gap: c.plan - c.margin, loss: c.atPlan.total - c.now.total });
    });
    rows.filter(x => x.c.kpi && !x.c.kpi.reach && !x.c.kpi.waived && x.c.kpi.step).forEach(x => risks.push({ kind: 'calls', empId: x.e.id, kpi: x.c.kpi, loss: x.c.kpi.step[1] }));
    rows.filter(late).forEach(x => risks.push({ kind: 'ttn', empId: x.e.id, ttn: x.t, loss: S.ttn.hold }));
    E.filter(e => { const s = clearanceState(e); return s && !s.ok; }).forEach(e => risks.push({ kind: 'clearance', empId: e.id, state: clearanceState(e) }));
    const teams = Object.keys(TEAMS).map(tm => {
      const xs = rows.filter(x => x.e.team === tm), ms = xs.filter(x => x.e.role === 'manager');
      return { team: tm, n: ms.length, margin: sum(ms.map(x => x.c.margin)), plan: sum(ms.map(x => x.c.plan)), fundNow: sum(xs.map(x => x.c.now.total)), fundPlan: sum(xs.map(x => x.c.atPlan.total)), offer: S.teamOffers[tm] || 'std' };
    });
    return { month: mk, rows: rows.map(x => ({ empId: x.e.id, calc: x.c, advance: x.a, advanceStatus: x.as, official: x.o, ttn: x.t, limit: x.L })), fundNow, fundPlan, advPaid, advRequested, advLeft, officialDeducted, officialSeparate,
      margin: companyMargin(mk), plan: companyPlan(mk), risks, teams, payNow: fundNow - advPaid - advRequested - officialDeducted, payPlan: fundPlan - advPaid - advRequested - officialDeducted };
  }

  // ---------- аналітика: ЗП до результату по відділах і командах ----------
  // Команда — до маржі її менеджерів; відділ продажу, відділи, що не продають, і компанія — до маржі компанії.
  // Фонд = нараховано (ставка, %, бонуси, ДН, премії / утримання) + офіційна ЗП, що виплачується окремо. Податки не враховано.
  const officialSeparateOf = (e, mk) => { const o = officialOf(e, mk); return o && !o.deduct ? o.amount : 0; };
  function payOfMonth(e, mk, plan) {
    const h = ((state.archive || {})[e.id] || []).find(x => x.month === mk); if (h) return { pay: h.fund, margin: h.margin };
    if (mk > liveMonth || !employedIn(e, mk)) return null;
    if (isLive(mk)) { const c = calcE(e, mk); return { pay: (plan ? c.atPlan.total : c.now.total) + officialSeparateOf(e, mk), margin: c.kind === 'manager' ? (plan ? c.marginPlan : c.margin) : 0 }; }
    if (!record(e.id, mk)) return null;
    const f = settlement(e, mk); return { pay: f.total + officialSeparateOf(e, mk), margin: f.calc.kind === 'manager' ? f.values.margin : 0 };
  }
  const ratio = (pay, res) => (res > 0 ? pay / res * 100 : null);
  function deptStats(mk, plan) {
    const rows = E.map(e => ({ e, x: payOfMonth(e, mk, plan) })).filter(r => r.x);
    const g = f => { const xs = rows.filter(f); return { n: xs.length, people: xs.map(r => r.e.id), pay: sum(xs.map(r => r.x.pay)), margin: sum(xs.filter(r => r.e.role === 'manager').map(r => r.x.margin)) }; };
    const all = g(() => true), comp = all.margin;
    const teams = Object.keys(TEAMS).map(k => { const t = g(r => r.e.team === k); return { k, name: TEAMS[k].name, ...t, res: t.margin, pct: ratio(t.pay, t.margin) }; }).filter(t => t.n);
    const depts = Object.keys(DEPTS).map(k => { const t = g(r => deptOf(r.e) === k); return { k, name: DEPTS[k].name, sales: DEPTS[k].sales, ...t, res: comp, pct: ratio(t.pay, comp) }; }).filter(t => t.n);
    return { month: mk, plan: !!plan, comp, all: { ...all, pct: ratio(all.pay, comp) }, teams, depts, support: depts.filter(d => !d.sales).reduce((a, d) => ({ n: a.n + d.n, pay: a.pay + d.pay }), { n: 0, pay: 0 }) };
  }

  // ---------- калькулятор «Ціль» (менеджер): бажана сума → маржа → постійні клієнти + нові → авто → звернення ----------
  /** Маржа за клієнтами за 3 місяці перед поточним (угоди «Успішно реалізовано»; до запуску — історія клієнтів) */
  function clientHistory3(e, mk) {
    const ms = [prevMonth(prevMonth(prevMonth(mk))), prevMonth(prevMonth(mk)), prevMonth(mk)], by = {};
    const add = (cl, i, v) => { (by[cl] = by[cl] || [0, 0, 0])[i] += v; };
    ms.forEach((m, i) => {
      if ((state.deals || {})[e.id] && state.deals[e.id][m]) dealsOf(e.id, m).filter(counts).forEach(d => add(d.client, i, d.margin));
      else ((state.clientHistory || {})[e.id] || []).forEach(h => { if (h.byMonth[m]) add(h.client, i, h.byMonth[m]); });
    });
    const rows = Object.entries(by).map(([client, a]) => ({ client, a, avg: Math.round(sum(a) / 3 / 100) * 100, n: a.filter(x => x > 0).length })).sort((x, y) => y.n - x.n || y.avg - x.avg);
    return { months: ms, rows };
  }
  /** Початкові поля калькулятора: ціль, конверсія й середній чек — за попередній + поточний місяць */
  function goalDefaults(e, mk) {
    const c = calcManager(e, mk), pm = prevMonth(mk);
    const prevDeals = dealsOf(e.id, pm).filter(counts), deals = [...prevDeals, ...c.deals.filter(counts)];
    const kp = ((state.kpi || {})[e.id] && state.kpi[e.id][pm]) || null, k = kpiOf(e.id, mk);   // попередній місяць — підсумок
    const leads = k.leads + (kp ? kp.leads : 0), tgt = k.targetDeals + (kp ? kp.targetDeals : 0), m = sum(deals.map(d => d.margin));
    const H = clientHistory3(e, mk);
    return {
      level: c.level, calls: true,
      target: Math.max(5000, Math.ceil((c.atPlan.total - c.atPlan.birthday + 1) / 5000) * 5000),
      conv: leads ? Math.round(tgt / leads * 1000) / 10 : 15, avgCheck: deals.length ? Math.round(m / deals.length) : 8000,
      source: { cars: deals.length, margin: m, leads, targetDeals: tgt, months: prevDeals.length || kp ? [pm, mk] : [mk] },
      regular: { history: H, selected: H.rows.filter(r => r.n >= 2).map(r => r.client), expected: Object.fromEntries(H.rows.map(r => [r.client, r.avg])) },
    };
  }
  function salaryAt(lv, plan, M, step, calls, rate) {
    const pct = managerPct(lv, plan, M);
    if (lv === 'profi') return { pct, rate: 0, bonus: 0, total: M * pct / 100 };
    const bonus = step && (calls || M >= S.kpi.waiveFrom) ? step[1] : 0;
    return { pct, rate, bonus, total: rate + bonus + M * pct / 100 };
  }
  /** Найменша маржа, з якою ЗП ≥ цілі: на кожному відрізку між порогами відсоток і бонус сталі */
  function solveMargin(lv, plan, target, step, calls, rate) {
    const bps = [...new Set([0, plan, S.profi.threshold, S.kpi.waiveFrom, S.start.minPlanForHigh])].filter(x => x >= 0).sort((a, b) => a - b);
    for (let i = 0; i < bps.length; i++) {
      const lo = bps[i], hi = i + 1 < bps.length ? bps[i + 1] : Infinity, s = salaryAt(lv, plan, lo, step, calls, rate);
      if (s.total >= target) return lo;
      if (!s.pct) continue;
      const M = ceilE((target - s.rate - s.bonus) / s.pct * 100);
      if (M < hi) return Math.max(lo, M);
    }
    return null;
  }
  /** Розрахунок цілі для рівня lv. regular — маржа з постійних клієнтів; avgCheck — маржа з одного авто */
  function goalRun(e, mk, { level, conv, target, calls, regular = 0, avgCheck }) {
    const c = calcManager(e, mk), of = offerOf(e);
    const plan = level === c.level ? c.plan : level === 'start' ? (of.startPlan != null ? of.startPlan : planOf(e.id, mk)) : 0;
    const rate = level === 'start' ? Math.round(startRateOf(e) * c.days.total / c.days.full) : 0, step = level === 'start' && hasKpi(e) ? kpiStep(conv) : null;
    const M = solveMargin(level, plan, target, step, calls, rate), s = salaryAt(level, plan, M, step, calls, rate);
    const MR = regularAllowed(e, level) ? Math.min(regular, M) : 0, ML = Math.max(0, M - MR), cars = ML > 0 ? ceilE(ML / avgCheck) : 0;
    return { margin: M, fromRegular: MR, fromNew: ML, salary: s, step, plan, cars, leads: cars ? ceilE(cars / (conv / 100)) : 0 };
  }
  /** Звідки клієнти: стандартний офер — «Старт» реклама, «Профі» лідгени; команда Лілії — за її офером */
  function clientSources(e, lv) {
    if (offerCode(e) === 'ls') return lv === 'start'
      ? { leads: 'Звернення: холодна база й лідогенерація', cars: 'Авто з нових клієнтів', margin: 'Маржа з нових клієнтів', short: 'холодна база й лідогенерація', regular: 'постійні клієнти компанії' }
      : { leads: 'Клієнти з таблиці реактивації', cars: 'Авто з реактивації', margin: 'Маржа з реактивації', short: 'таблиця реактивації', regular: 'власна база постійних' };
    return lv === 'start'
      ? { leads: 'Звернення з реклами', cars: 'Авто з реклами', margin: 'Маржа з реклами', short: 'реклама', regular: 'постійні клієнти' }
      : { leads: 'Лідгени', cars: 'Авто з лідгенів', margin: 'Маржа з лідгенів', short: 'лідгени', regular: null };
  }

  /** Місяці для аналітики: від першого місяця архіву (або запуску) до поточного */
  function analyticsMonths() {
    const ms = new Set([liveMonth]);
    Object.values(state.archive || {}).flat().forEach(h => ms.add(h.month));
    Object.keys(state.records || {}).forEach(m => ms.add(m));
    const sorted = [...ms].filter(m => m <= liveMonth).sort(), out = [];
    for (let m = sorted[0]; m <= liveMonth; m = nextMonth(m)) out.push(m);
    return out;
  }

  // Публічні функції приймають працівника як id або як об’єкт
  const W = f => (x, ...rest) => f(typeof x === 'string' ? person(x) : x, ...rest);
  return {
    settings: S, now, today, liveMonth, closedMonth, isLive, seen, upTo, person, employees: E,
    // умови, оргструктура, дні
    offerCode: W(offerCode), offerOf: W(offerOf), startRateOf: W(startRateOf), hasKpi: W(hasKpi), regularAllowed: W(regularAllowed),
    termsOf: W(termsOf), levelOf: W(levelOf), rateOf: W(rateOf), pctRuleOf: W(pctRuleOf), levelChangeAfter: W(levelChangeAfter),
    deptOf: W(deptOf), isSimple: W(isSimple), leadOf: W(leadOf), teamOf: W(teamOf), planOf, workdays, employedIn: W(employedIn), leaveIn: W(leaveIn), days: W(days),
    // угоди, КПІ, відсоток
    dealsOf, allDeals, kpiOf, kpiStep, managerPct, counts,
    // дні народження
    birthdayIn: W(birthdayIn), tenureMonths: W(tenureMonths), birthdayGift: W(birthdayGift), birthdayLines: W(birthdayLines),
    // розрахунок
    record, verifiedMargin, companyMargin, companyPlan, calc: W(calcE),
    // офіційна ЗП, аванс
    officialOf: W(officialOf), officialSeparateOf: W(officialSeparateOf), advanceOf, advanceStatus, advancePaid, advanceWindowOpen, advanceLimit: W(advanceLimit),
    // ТТН
    ttnDate, ttnStats: W(ttnStats), ttnOk, ttnFixedAt: W(ttnFixedAt), ttnPrev: W(ttnPrev), ttnLines: W(ttnLines),
    // рівень (офер Лілії), закриття, виплата
    marginOfMonth: W(marginOfMonth), autoProfi: W(autoProfi), settlement: W(settlement), checkPayoutForm: W(checkPayoutForm), payoutLines: W(payoutLines),
    // обхідний лист
    clearanceResponsible: W(clearanceResponsible), clearanceClients: W(clearanceClients), clearanceHeirs: W(clearanceHeirs), clearanceOf: W(clearanceOf),
    clearanceSigned, clearanceShots, clearanceState: W(clearanceState), clearanceReady: W(clearanceReady), clearanceCanSign: W(clearanceCanSign),
    isFinal: W(isFinal), payBlocked: W(payBlocked), payNeedsOd: W(payNeedsOd),
    // прогноз, аналітика
    forecast, payOfMonth: W(payOfMonth), deptStats, ratio, analyticsMonths,
    // калькулятор «Ціль»
    clientHistory3: W(clientHistory3), goalDefaults: W(goalDefaults), solveMargin, salaryAt, goalRun: W(goalRun), clientSources: W(clientSources),
  };
}
