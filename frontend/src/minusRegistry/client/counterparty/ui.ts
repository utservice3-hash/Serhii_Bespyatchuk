/**
 * Спільні шматки розмітки для «Узгодження», «Перевірки контрагента» і «Лімітів клієнтів» (класи cp- з cp.css).
 * Вигляд = узгоджений макет v5 (23.10). Лише рядки HTML; усе, що приходить ззовні, — через esc().
 */
import {
  CUR_LABEL, ENT_LABEL, FROM_LABEL, PAY_LABEL, PAY_SHORT, STATUS_LABEL, STATUS_TONE, sameTerms, sideLine,
  type CpRequestView, type Rates, type ReqStatus, type TermsInput,
} from '../../shared/counterparty';
import { calcNote, calcRows, type Lag } from '../../shared/cpCalc';
import { MASS_OWNER, OWN_RECENT_MONTHS, age, agoText, critOf, monthsBetween, ownFlags, verdict, type BudgetInfo, type CheckSubject, type CourtCase, type Tone } from '../../shared/cpCheck';
import { dayW, dm, dt, esc, money, nf, plural } from '../../shared/cpFormat';

export const SEARCH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="m10.5 10.5 3.5 3.5"/></svg>';
export const closeBtn = '<span class="cp-grow"></span><button type="button" class="cp-x" data-close aria-label="Закрити">✕</button>';
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const opts = (map: Record<string, string>, sel: string) => Object.entries(map).map(([k, v]) => `<option value="${k}"${sel === k ? ' selected' : ''}>${esc(v)}</option>`).join('');
export const foot = (btns: string, hint = '') => `<div class="cp-df"><div class="cp-acts">${btns}</div>${hint ? `<div class="cp-hint">${hint}</div>` : ''}</div>`;
export const hintFoot = (hint: string) => `<div class="cp-df"><div class="cp-hint">${hint}</div></div>`;

export const pill = (s: ReqStatus) => `<span class="cp-pill cp-${STATUS_TONE[s]}">${STATUS_LABEL[s]}</span>`;
export const vpill = (v: 'ok' | 'warn' | 'fop') => (v === 'ok' ? '<span class="cp-pill cp-ok">Без зауважень</span>'
  : v === 'fop' ? '<span class="cp-pill cp-info">Суди — вручну</span>' : '<span class="cp-pill cp-warn">Є зауваження</span>');
const ic = (st: Tone) => `<span class="cp-ic cp-${st}">${st === 'ok' ? '✓' : st === 'bad' ? '✗' : st === 'warn' ? '!' : '–'}</span>`;
export const spinRows = (titles: string[], first?: string) => `<div class="cp-crit">${titles.map((t, i) => (i === 0 && first
  ? `<div class="cp-cr">${ic('ok')}<span>${t}</span><span class="cp-v">${first}</span></div>`
  : `<div class="cp-cr"><span class="cp-spin"></span><span>${t}</span><span class="cp-v">запит…</span></div>`)).join('')}</div>`;

/** Позначки в списках: вік, суди, виконавчі, власники. */
export function chips(s: CheckSubject, now: Date): string {
  const c = critOf(s, now), of = ownFlags(s.own, now);
  return `<span class="cp-ck cp-${c.age.st === 'ok' ? 'ok' : 'bad'}">${c.age.st === 'ok' ? '✓' : '✗'} ${age(s.reg, now).y} р.</span>`
    + (s.fop ? '<span class="cp-ck cp-mut">суди вручну</span>'
      : c.openN || c.lostN ? `<span class="cp-ck cp-warn">⚠ суди: ${c.openN + c.lostN}</span>` : '<span class="cp-ck cp-ok">✓ суди</span>')
    + (s.yc.enf ? `<span class="cp-ck cp-warn">⚠ виконавчі: ${s.yc.enf}</span>` : '')
    + (of.length ? `<span class="cp-ck cp-warn" title="${esc(of.join(', '))}">⚠ ${of.length === 1 ? of[0] : 'власники: ' + of.length}</span>` : '');
}

export function caseCard(c: CourtCase, who: string): string {
  const doc = c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">документ ↗</a>` : '';
  return `<div class="cp-case"><div class="cp-h"><span class="cp-mono">${esc(c.no)}</span>${c.sum !== null ? `<span class="cp-mono">${nf(c.sum)} грн</span>` : ''}</div>
    <div class="cp-m">${esc(c.court)}${c.date ? ` · надійшла ${dt(c.date)}` : ''}</div>
    <div>${esc(c.subj)}</div>
    <div class="cp-m">${who[0].toUpperCase() + who.slice(1)} — <b>відповідач</b> · ${c.open ? `розглядається${c.next ? `, засідання ${dt(c.next)}` : ''}` : `рішення набрало сили ${dt(c.lawDate)} — стягнуто`}${c.fresh ? ' · <b style="color:var(--bad)">нова</b>' : ''}${doc}</div></div>`;
}

/** «Власники й капітал»: статутний капітал, власники (частка, бенефіціар, скільки компаній), бенефіціари, директор, останні зміни. */
export function ownBlock(s: CheckSubject, now: Date): string {
  if (s.fop) return '<div class="cp-lbl" style="margin-top:4px">Власники й капітал</div><div class="cp-hint">ФОП — підприємець сам собі власник; статутного капіталу й засновників немає.</div>';
  const o = s.own; if (!o) return '';
  const recent = (d: string | null) => !!d && monthsBetween(d, now) < OWN_RECENT_MONTHS;
  const when = (d: string | null, what: string, none: string) => (d
    ? `<b>${dt(d)}</b> ${recent(d) ? `<span class="cp-ck cp-warn">⚠ ${agoText(d, now)}</span>` : `<span class="cp-os">${agoText(d, now)}</span>`}<div class="cp-os">${esc(what)}</div>`
    : `<span class="cp-os">${none}</span>`);
  const owners = o.owners.map(x => {
    const n = x.companies;
    const cnt = n === null ? '' : `<span class="cp-ck cp-${n > MASS_OWNER ? 'warn' : 'mut'}">${n > MASS_OWNER ? '⚠ ' : ''}${n} ${plural(n, 'компанія', 'компанії', 'компаній')} у власника</span>`;
    return `<div class="cp-ow"><span class="cp-on">${esc(x.name)}${x.code ? ` <span class="cp-code">${esc(x.code)}</span>` : ''}</span><span class="cp-os">${x.share !== null ? String(x.share).replace('.', ',') + ' %' : 'частка —'}${x.ben ? ' · бенефіціар' : ''}</span>${cnt}</div>`;
  }).join('') || '<span class="cp-os">у ЄДР немає</span>';
  return `<div class="cp-lbl" style="margin-top:4px">Власники й капітал</div>
    <div class="cp-own">
      <div class="cp-or"><span>Статутний капітал</span><div><b>${o.capital !== null ? money(o.capital) : '—'}</b></div></div>
      <div class="cp-or"><span>Власники</span><div>${owners}</div></div>
      ${o.bens.length ? `<div class="cp-or"><span>Кінцеві бенефіціари</span><div><b>${o.bens.map(esc).join(', ')}</b></div></div>` : ''}
      ${o.benNote ? `<div class="cp-or"><span>Бенефіціари</span><div><span class="cp-ck cp-warn">⚠ ${esc(o.benNote)}</span></div></div>` : ''}
      ${o.director ? `<div class="cp-or"><span>Директор</span><div><b>${esc(o.director.name)}</b>${o.director.since ? ` <span class="cp-os">з ${dt(o.director.since)}</span>` : ''}</div></div>` : ''}
      <div class="cp-or"><span>Остання зміна власників</span><div>${when(o.ownersAt, o.ownersWhat, 'не змінювались з реєстрації')}</div></div>
      <div class="cp-or"><span>Остання зміна директора</span><div>${when(o.dirAt, o.dirWhat, 'не змінювався з реєстрації')}</div></div>
    </div>`;
}

/** Блок «Перевірка YouControl»: критерії, справи, інше «для інформації», власники. */
export function ycBox(s: CheckSubject, o: { who: string; byName?: string | null; foot?: string; now: Date }): string {
  const c = critOf(s, o.now);
  const rows: Array<[string, { st: Tone; v: string }]> = [['Зареєстровано не менше 3 років тому', c.age], [`Відкриті справи за перевезення (${o.who} — відповідач)`, c.open], ['Програні справи за перевезення за 3 роки', c.lost]];
  return `<div class="cp-box"><div class="cp-lh"><span class="cp-lbl">Перевірка YouControl</span><span class="cp-src">${dm(s.yc.checkedAt)}${o.byName ? ' · ' + esc(o.byName) : ''}</span></div>
    ${s.yc.archived ? '<div class="cp-hint">YouControl довго оновлював дані — показано останні збережені в YouControl.</div>' : ''}
    ${s.state && !/^зареєстровано$/i.test(s.state) ? `<div class="cp-note cp-warnn"><b>Стан у ЄДР:</b> ${esc(s.state)}</div>` : ''}
    <div class="cp-crit">${rows.map(([t, x]) => `<div class="cp-cr">${ic(x.st)}<span>${t}</span><span class="cp-v">${esc(x.v)}</span></div>`).join('')}</div>
    ${s.fop ? '<div class="cp-hint">По ФОП YouControl шукає суди лише за ПІБ — перевірте вручну.</div>' : ''}
    ${s.yc.cases.length ? `<div class="cp-cases">${s.yc.cases.map(x => caseCard(x, o.who)).join('')}</div>` : ''}
    ${s.yc.other ? `<div class="cp-hint">Ще ${s.yc.other} ${plural(s.yc.other, 'справа', 'справи', 'справ')} в YouControl — не за перевезення або ${o.who} не відповідач, не враховано.</div>` : ''}
    <div class="cp-lbl" style="margin-top:4px">Для інформації</div>
    <div class="cp-facts"><span class="cp-ck cp-${s.yc.enf ? 'warn' : 'ok'}">Виконавчі провадження: ${s.yc.enf || 'немає'}</span>${s.yc.express.map(f => `<span class="cp-ck cp-${f.tone}">${esc(f.name)}: ${esc(f.value)}</span>`).join('')}${s.yc.index ? `<span class="cp-ck cp-mut">ExpressScore: ${esc(s.yc.index)}</span>` : ''}</div>
    ${ownBlock(s, o.now)}
    ${o.foot || ''}</div>`;
}
export const verdictPill = (s: CheckSubject, now: Date) => vpill(verdict(s, now));

/** Історія: точка кольору події, назва, хто й коли, примітка. */
export function histHtml(list: Array<{ type: string; byName: string | null; at: string; note: string }>, label: Record<string, string>, tone: Record<string, string>): string {
  return list.map(h => `<li style="--pc:var(--${tone[h.type] || 'muted'})"><span class="cp-dot"></span><div><div class="cp-t">${label[h.type] || h.type}</div><div class="cp-meta">${h.byName ? esc(h.byName) : 'Система'} · ${dm(h.at)}</div>${h.note ? `<div class="cp-tr">${esc(h.note)}</div>` : ''}</div></li>`).join('');
}

// ---------- умови й розрахунок ----------
export function calcInner(t: TermsInput, rates: Rates, lag: Lag): string {
  return calcRows(t, rates, lag).map(([l, v, s, cls]) => `<div class="cp-cl"><span>${l}</span><b class="${cls ? 'cp-' + cls : ''}">${v}</b><i>${s}</i></div>`).join('')
    + `<div class="cp-hint">${esc(calcNote(t, rates, lag))}</div>`;
}
export const calcBox = (t: TermsInput, rates: Rates, lag: Lag, live = false) => `<div class="cp-calc"${live ? ' data-calc' : ''}>${calcInner(t, rates, lag)}</div>`;

/** Форма умов: дві сторони, рейси, юрособа, розрахунок, ліміт боргу (з підказкою). p — префікс id полів. */
export function termsForm(t: TermsInput, p: string, rates: Rates, lag: Lag, limHint: string): string {
  const side = (k: 'cl' | 'ca', title: string) => { const s = t[k]; return `<fieldset class="cp-side"><legend>${title}</legend>
    <label class="cp-f"><span>Днів <em>*</em></span><input class="cp-in cp-mono" id="${p}${k}-days" data-tf="${k}.days" inputmode="numeric" value="${esc(s.days)}" placeholder="${k === 'cl' ? 'напр. 21' : 'напр. 7'}"></label>
    <label class="cp-f">Від чого рахувати<select class="cp-in" id="${p}${k}-from" data-tf="${k}.from">${opts(FROM_LABEL, s.from)}</select></label>
    <label class="cp-f">Форма оплати<select class="cp-in" id="${p}${k}-pay" data-tf="${k}.pay">${opts(PAY_LABEL, s.pay)}</select></label>
    <label class="cp-f"><span>Ставка за рейс, орієнтовно <em>*</em></span><span class="cp-rate"><input class="cp-in cp-mono" id="${p}${k}-rate" data-tf="${k}.rate" inputmode="decimal" value="${esc(s.rate)}" placeholder="${k === 'cl' ? 'напр. 42 000' : 'напр. 30 000'}" aria-label="${title}: ставка за рейс"><select class="cp-in" id="${p}${k}-cur" data-tf="${k}.cur" aria-label="${title}: валюта">${opts(CUR_LABEL, s.cur)}</select></span></label>
  </fieldset>`; };
  return `<div class="cp-tf">
    <div class="cp-grid2">${side('cl', 'Клієнт платить')}${side('ca', 'Ми платимо перевізнику')}</div>
    <div class="cp-grid2">
      <label class="cp-f"><span>Рейсів на місяць, орієнтовно <em>*</em></span><input class="cp-in cp-mono" id="${p}trips" data-tf="trips" inputmode="numeric" value="${esc(t.trips)}" placeholder="напр. 6"></label>
      <label class="cp-f">Наша юрособа<select class="cp-in" id="${p}ent" data-tf="ent">${opts(ENT_LABEL, t.ent)}</select></label>
    </div>
    ${calcBox(t, rates, lag, true)}
    <div class="cp-limrow">
      <label class="cp-f"><span>Ліміт боргу, грн <em>*</em></span><input class="cp-in cp-mono" id="${p}limit" data-tf="limit" inputmode="numeric" value="${esc(t.limit)}" placeholder="розрахунок або своя сума"></label>
      <div class="cp-hint" data-limhint>${limHint}</div>
    </div></div>`;
}

export const useTone = (u: number) => (u > 100 ? 'bad' : u >= 80 ? 'warn' : '');
export const usebar = (u: number, wide = false) => `<div class="cp-usebar${wide ? ' cp-wide' : ''}${useTone(u) ? ' cp-' + useTone(u) : ''}"><i style="width:${Math.min(100, Math.max(0, u))}%"></i></div>`;

/** «Умови оплати» в картці запиту: таблиця двох сторін (погоджене й «просили»), рейси, юрособа, ліміт, борг зараз, розрахунок. */
export function termsBox(r: CpRequestView, lag: Lag): string {
  const t = r.ok || r.terms, ch = !!r.ok && !sameTerms(r.ok, r.terms), q = r.terms;
  const v = (a: string, b: string) => (ch && a !== b ? `${esc(a)}<s>просили: ${esc(b)}</s>` : esc(a));
  const from = (s: { from: keyof typeof FROM_LABEL }) => FROM_LABEL[s.from].replace(/^від /, '');
  const rows: Array<[string, string, string, string, string]> = [
    ['Днів', dayW(t.cl.days), dayW(q.cl.days), dayW(t.ca.days), dayW(q.ca.days)],
    ['Від чого рахувати', from(t.cl), from(q.cl), from(t.ca), from(q.ca)],
    ['Форма оплати', PAY_LABEL[t.cl.pay], PAY_LABEL[q.cl.pay], PAY_LABEL[t.ca.pay], PAY_LABEL[q.ca.pay]],
    ['Ставка за рейс', '≈ ' + money(t.cl.rate, t.cl.cur), '≈ ' + money(q.cl.rate, q.cl.cur), '≈ ' + money(t.ca.rate, t.ca.cur), '≈ ' + money(q.ca.rate, q.ca.cur)],
  ];
  const kvs = (label: string, a: string, b: string) => `<div><span>${label}</span><b>${esc(a)}</b>${ch && a !== b ? `<s>просили: ${esc(b)}</s>` : ''}</div>`;
  const d = r.ok && r.debt ? r.debt : null;
  const use = d ? Math.round(d.debt / t.limit * 100) : 0;
  return `<div class="cp-box"><div class="cp-lh"><span class="cp-lbl">${r.ok ? (ch ? 'Умови оплати — погоджено з іншими' : 'Умови оплати — погоджено') : 'Умови оплати — запит'}</span></div>
    <table class="cp-tt"><thead><tr><th scope="col"><span class="cp-sr">Умова</span></th><th scope="col">Клієнт платить</th><th scope="col">Ми платимо перевізнику</th></tr></thead>
      <tbody>${rows.map(([l, a, aw, b, bw]) => `<tr><th scope="row">${l}</th><td>${v(a, aw)}</td><td>${v(b, bw)}</td></tr>`).join('')}</tbody></table>
    <div class="cp-kv">${kvs('Рейсів на місяць', String(t.trips), String(q.trips))}${kvs('Наша юрособа', ENT_LABEL[t.ent], ENT_LABEL[q.ent])}${kvs('Ліміт боргу', money(t.limit), money(q.limit))}</div>
    ${d ? `<div class="cp-debtline"><div class="cp-lh"><span class="cp-src">Борг зараз — з дебіторки на ${dm(d.at)}</span><b class="cp-num${d.debt > t.limit ? ' cp-neg' : ''}">${money(d.debt)} · ${use} %</b></div>${usebar(use, true)}</div>` : ''}
    ${calcBox(t, r.rates, lag)}</div>`;
}
export const termsLineOf = (t: { cl: { days: number; from: keyof typeof FROM_LABEL } }) => sideLine(t.cl);
export const termsSubOf = (t: { ent: keyof typeof ENT_LABEL; cl: { pay: keyof typeof PAY_SHORT } }) => `${ENT_LABEL[t.ent]} · ${PAY_SHORT[t.cl.pay]}`;

/**
 * Бюджет YouControl — лише Сергію: «YouControl 3 889 транзакцій · вистачить ≈ 6,5 міс.»; підказка — витрати за місяць по видах і резерв.
 * Менше резерву — попередження (ручні перевірки співробітників сервер уже зупинив).
 */
export function budgetChip(b?: BudgetInfo | null): string {
  if (!b) return '';
  const m = b.month;
  const title = `Цього місяця: запити на нових клієнтів ${m.req}, перевірки співробітників ${m.tool}, планові ${m.planned}, суди щомісяця ${m.monitor} — разом ${m.total}. `
    + `За 30 днів — ${b.last30}. Резерв на планові перевірки й суди на 60 днів — ${b.reserve}; у середньому ≈ ${b.plannedPerMonth} на місяць.`;
  const bal = b.balance === null ? '<b>—</b>' : `<b>${nf(b.balance)}</b> ${plural(b.balance, 'транзакція', 'транзакції', 'транзакцій')}`;
  const tail = b.low ? ` · менше резерву (${nf(b.reserve)}) — ручні перевірки співробітників зупинено`
    : b.months !== null ? ` · вистачить ≈ ${String(b.months).replace('.', ',')} міс.` : '';
  return `<span class="cp-yc${b.low ? ' cp-ycl' : ''}" title="${esc(title)}">YouControl ${bal}${tail}</span>`;
}

/** Тост — один на вкладку. */
export function makeToast(el: () => HTMLElement | null) {
  let t: ReturnType<typeof setTimeout> | undefined, alive = true;
  return {
    show(msg: string) { const x = el(); if (!x || !alive) return; x.textContent = msg; x.hidden = false; clearTimeout(t); t = setTimeout(() => { const y = el(); if (y) y.hidden = true; }, 2600); },
    stop() { alive = false; clearTimeout(t); },
  };
}
