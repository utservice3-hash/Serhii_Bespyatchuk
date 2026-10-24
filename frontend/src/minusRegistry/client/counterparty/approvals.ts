/**
 * Вкладка «Узгодження роботи з новим контрагентом» (сторінка «Реєстри та узгодження»). Без прив'язки до фреймворку:
 *   const h = mountApprovals(el, { api: counterpartyApi, onCount: n => …, navigate });   // h.refresh(), h.open(target), h.destroy()
 * Вигляд і поведінка = узгоджений макет v5 (23.10); макет зібрано з цього самого файлу (tools/buildMockup.mjs).
 * Хто дивиться і що може — каже сервер (GET /api/counterparty/requests → me); інтерфейс лише ховає кнопки.
 */
import {
  ACTION_DONE, COUNTRIES, EVENT_LABEL, EVENT_TONE, FILTERS, NOTE_EMPTY, STATUS_LABEL, allowedActions, blankTerms, canSubmit, changePending, checkCode, cleanCode,
  defaultFilter, diffLines, inFilter, inMyTeam, isOwner, needsMe, normTerms, sameTerms, seesOthers, termsErr, termsLine, termsSub,
  type CpAction, type CpFile, type CpRequestView, type CpUser, type Rates, type ReqFilter, type TermsInput,
} from '../../shared/counterparty';
import { DEFAULT_LAG, calc, debtText, gapText, type Lag } from '../../shared/cpCalc';
import { TX_EST, age, validUntil, type CheckView } from '../../shared/cpCheck';
import { dayW, dm, dt, esc, kb, money, plural, short, tripsW, txW } from '../../shared/cpFormat';
import { CpApiError, type CpApi, type DupInfo, type LimitInfo, type Navigate, type NavTarget } from './types';
import {
  SEARCH_ICON, budgetChip, calcInner, chips, closeBtn, errText, foot, hintFoot, histHtml, makeToast, pill, spinRows, termsBox, termsForm, ycBox,
} from './ui';
import type { BudgetInfo } from '../../shared/cpCheck';

export interface ApprovalsOptions {
  api: CpApi;
  /** Скільки запитів чекає дії цього користувача — для лічильника на вкладці, в заголовку й у меню. */
  onCount?: (n: number) => void;
  /** Перехід на іншу вкладку (перевірка, ліміти). */
  navigate?: Navigate;
  /** Відкрити одразу: запит, нову форму з кодом. */
  initial?: NavTarget;
  /** Лише макет: підказки кодів у полі «ЄДРПОУ». */
  suggestCodes?: Array<[string, string]>;
  /** Як часто оновлювати, поки YouControl перевіряє (мс). */
  pollMs?: number;
  now?: () => Date;
}
export interface ApprovalsHandle { refresh(): Promise<void>; open(t: NavTarget): void; destroy(): void }

type Found = { dup: DupInfo } | { check: CheckView; saved: boolean; limit: LimitInfo | null };
interface Draft {
  resident: boolean; code: string; err: string; found: Found | null; looking: boolean;
  t: TermsInput; limitAuto: boolean; country: string; cname: string; regNo: string; files: CpFile[]; uploading: number; comment: string;
}
type Decision = 'change' | 'return' | 'reject' | 'chgEdit' | 'chgReject' | 'reqChange' | null;

let seq = 0;
const limitInfoLine = (l: LimitInfo) => `ліміт ${l.limit !== null ? money(l.limit) : '—'}${l.days !== null ? `, ${dayW(l.days)} ${({ od: 'від вивантаження', orig: 'від отримання оригіналів', inv: 'від дати рахунку' })[l.from]}` : ''}`;

export function mountApprovals(root: HTMLElement, o: ApprovalsOptions): ApprovalsHandle {
  const P = `cpa${++seq}-`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(P + id) as T | null;
  const now = o.now || (() => new Date());
  const toast = makeToast(() => $('toast'));

  let me: CpUser | null = null, reqs: CpRequestView[] = [], rates: Rates = { eur: 0, usd: 0, at: '' }, lag: Lag = DEFAULT_LAG, loadErr = '';
  let budget: BudgetInfo | null = null;
  let filter: ReqFilter = 'all', query = '';
  let panel: 'new' | 'detail' | null = null, openId: string | null = null, decision: Decision = null;
  let wt: TermsInput | null = null, wtKey: string | null = null, wtAuto = false;
  let draft: Draft | null = null, busy = false, alive = true;
  let pollT: ReturnType<typeof setTimeout> | undefined;
  let pending: NavTarget | null = o.initial || null;
  const wasRechecking = new Set<string>();

  root.innerHTML = `<div class="cpx">
  <div class="cp-cq">
    <section class="cp-card" aria-label="Узгодження роботи з новим контрагентом">
      <div class="cp-bar">
        <div class="cp-ways" id="${P}filters" role="group" aria-label="Статус"></div>
        <span class="cp-grow"></span>
        <span id="${P}bud"></span>
        <label class="cp-search">${SEARCH_ICON}<input id="${P}q" placeholder="ЄДРПОУ або назва" aria-label="Пошук за ЄДРПОУ або назвою" autocomplete="off"></label>
        <button type="button" class="cp-btn cp-pri" id="${P}add" hidden>+ Новий клієнт</button>
      </div>
      <div class="cp-tblwrap"><table class="cp-reg">
        <thead><tr><th>Клієнт</th><th>Умови оплати</th><th>Перевірка</th><th id="${P}whoh">Менеджер</th><th>Статус</th></tr></thead>
        <tbody id="${P}rows"></tbody>
        <tfoot id="${P}foot"></tfoot>
      </table></div>
    </section>
  </div>
  <div class="cp-scrim" id="${P}scrim" hidden></div>
  <aside class="cp-drawer" id="${P}drawer" role="dialog" aria-modal="true" aria-labelledby="${P}dTitle" hidden></aside>
  <div class="cp-toast" id="${P}toast" role="status" aria-live="polite" hidden></div>
  ${o.suggestCodes ? `<datalist id="${P}codes">${o.suggestCodes.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</datalist>` : ''}
</div>`;

  // ---------- список ----------
  function termsCell(r: CpRequestView) {
    const t = r.ok || r.terms, c = calc(t, r.rates, lag);
    const was = r.ok && r.ok.cl.days !== r.terms.cl.days ? ` <span class="cp-strike">${r.terms.cl.days} дн.</span>` : '';
    const chg = changePending(r) && r.change && r.ok ? `<div class="cp-sub cp-chg">запит: ${esc(termsLine(r.change.terms))}${r.change.terms.trips !== r.ok.trips ? ` · ${tripsW(r.change.terms.trips)}/міс.` : ''}</div>` : '';
    return `<div class="cp-terms"><b>${esc(termsLine(t))}</b>${was}</div>
      <div class="cp-sub">${esc(termsSub(t))} · ${tripsW(t.trips)}/міс.</div>
      <div class="cp-sub">ліміт ${short(t.limit)} грн${c.margin !== undefined && c.margin <= 0 ? ' · <span class="cp-neg">мінус на рейсі</span>' : ''}</div>${chg}`;
  }
  function checkCell(r: CpRequestView) {
    if (r.status === 'checking' || r.rechecking) return '<span class="cp-ck cp-mut"><span class="cp-spin"></span> YouControl…</span>';
    if (!r.resident) return '<span class="cp-ck cp-mut">нерезидент · вручну</span>';
    if (r.check && r.check.status === 'failed') return '<span class="cp-ck cp-bad">перевірка не вдалася</span>';
    return r.check && r.check.subj ? chips(r.check.subj, now()) : '<span class="cp-ck cp-mut">—</span>';
  }
  function render() {
    if (!alive) return;
    const rows = $('rows')!, footEl = $('foot')!;
    if (!me) {
      rows.innerHTML = `<tr><td colspan="5" class="cp-empty">${loadErr ? esc(loadErr) : 'Завантаження…'}</td></tr>`;
      footEl.innerHTML = ''; $('filters')!.innerHTML = '';
      return;
    }
    const u = me;
    o.onCount?.(reqs.filter(r => needsMe(u, r)).length);
    $('filters')!.innerHTML = FILTERS.map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${t} <span class="cp-c">${reqs.filter(r => inFilter(r, k)).length}</span></button>`).join('');
    $('add')!.hidden = !canSubmit(u.role);
    $('bud')!.innerHTML = budgetChip(budget);
    const qq = query.trim().toLowerCase();
    const list = reqs.filter(r => inFilter(r, filter) && (!qq || r.code.toLowerCase().includes(qq) || r.name.toLowerCase().includes(qq)));
    const showWho = seesOthers(u);
    $('whoh')!.hidden = !showWho;
    rows.innerHTML = list.map(r => `<tr data-id="${esc(r.id)}" tabindex="0" class="${panel === 'detail' && openId === r.id ? 'cp-sel' : ''}" aria-label="${esc(r.name)}">
      <td class="cp-c-cl"><div class="cp-who">${esc(r.name)}</div><div class="cp-sub"><span class="cp-code">${esc(r.code)}</span> · ${esc(r.resident ? r.kind : r.country || '')}</div></td>
      <td class="cp-c-tm">${termsCell(r)}</td>
      <td class="cp-c-ck"><div class="cp-chks">${checkCell(r)}</div></td>
      ${showWho ? `<td class="cp-c-mg"><div class="cp-mgr">${esc(r.createdByName)}</div><div class="cp-when">${dm(r.createdAt)}</div></td>` : ''}
      <td class="cp-c-st">${pill(r.status)}${r.flag && r.status === 'pending' ? '<div class="cp-flag">нова справа</div>' : ''}${changePending(r) ? '<div class="cp-flag cp-w">зміна умов</div>' : ''}</td></tr>`).join('')
      || `<tr><td colspan="5" class="cp-empty">${qq ? 'Нічого не знайдено' : 'Порожньо'}</td></tr>`;
    footEl.innerHTML = list.length ? `<tr><td colspan="${showWho ? 5 : 4}">${list.length} ${plural(list.length, 'клієнт', 'клієнти', 'клієнтів')}</td></tr>` : '';
  }

  // ---------- панель ----------
  function openPanel(kind: 'new' | 'detail', id?: string) {
    panel = kind; openId = id || null; decision = null; wtKey = null;
    if (kind === 'new') {
      draft = { resident: true, code: '', err: '', found: null, looking: false, t: blankTerms(true), limitAuto: true, country: '', cname: '', regNo: '', files: [], uploading: 0, comment: '' };
      wt = draft.t; wtKey = 'new'; wtAuto = true;
    }
    $('scrim')!.hidden = false; $('drawer')!.hidden = false;
    renderPanel(); render();
    const f = kind === 'new' ? $('code') : $('drawer')!.querySelector<HTMLElement>('[data-close]');
    f?.focus();
  }
  function closePanel() {
    panel = null; openId = null; decision = null; wtKey = null; draft = null;
    $('scrim')!.hidden = true; $('drawer')!.hidden = true;
    render(); schedulePoll();
  }
  /** Робоча копія умов для форми редагування (одна на панель). */
  function form(key: string, base: TermsInput, p: string) {
    if (wtKey !== key) { wt = JSON.parse(JSON.stringify(base)) as TermsInput; wtKey = key; wtAuto = false; }
    return termsForm(wt!, p, curRates(), lag, limHint(wt!, wtAuto));
  }
  const curRates = () => (panel === 'detail' ? reqs.find(r => r.id === openId)?.rates || rates : rates);
  function limHint(t: TermsInput, auto: boolean) {
    const c = calc(t, curRates(), lag);
    if (c.debt === undefined) return 'Заповніть умови — система запропонує ліміт за розрахунком боргу.';
    return auto ? `Підставлено розрахунок боргу клієнта (≈ ${money(c.debt)}). Можна змінити.` : `Розрахунок боргу: ≈ ${money(c.debt)} · <button type="button" class="cp-lnk" data-limauto>підставити</button>`;
  }
  const eb = (title: string, inner: string) => `<div class="cp-box cp-edit"><div class="cp-lbl">${title}</div>${inner}</div>`;
  function editBlock(r: CpRequestView) {
    const acts = allowedActions(me!, r);
    if (acts.includes('approveChanged') && decision === 'change') return eb('Погодити з іншими умовами', form(r.id + ':change', r.ok || r.terms, 'a-'));
    if (acts.includes('changeApprove') && decision === 'chgEdit' && r.change) return eb('Погодити зміну з іншими умовами', form(r.id + ':chgEdit', r.change.terms, 'a-'));
    if (acts.includes('requestChange') && decision === 'reqChange' && r.ok) return eb('Нові умови', form(r.id + ':reqChange', r.ok, 'c-')
      + '<label class="cp-f"><span>Чому змінюємо <em>*</em></span><textarea class="cp-in" id="' + P + 'why" rows="2" placeholder="напр. обсяги зросли, клієнт просить більше днів"></textarea></label>');
    if (acts.includes('resubmit')) return eb('Умови оплати — виправте, якщо треба', form(r.id + ':resubmit', r.terms, 'm-'));
    return '';
  }
  function checkBox(r: CpRequestView) {
    if (!r.resident) return '<div class="cp-note cp-mutn"><b>Автоперевірки немає — нерезидент.</b> Рішення — за документами, умовами й поясненнями менеджера.</div>';
    if (r.status === 'checking' || r.rechecking) return `<div class="cp-box"><div class="cp-lbl">Перевірка YouControl</div>
      ${spinRows(['ЄДР', 'Суди', 'Виконавчі провадження', 'Експрес-аналіз', 'Власники й капітал', 'PDF-досьє'], r.check?.base ? 'готово' : undefined)}
      <div class="cp-hint">YouControl іноді оновлює дані до кількох хвилин — запит піде Сергію, щойно перевірка завершиться.</div></div>`;
    const recheck = me!.role === 'approver' && allowedActions(me!, r).includes('recheck')
      ? `<div><button type="button" class="cp-btn cp-sm" data-act="recheck"${busy ? ' disabled' : ''}>Перевірити заново · ≈ ${txW(r.check?.subj?.fop || r.check?.base?.fop ? TX_EST.fop : TX_EST.repeat)}</button></div>` : '';
    if (!r.check || r.check.status === 'failed' || !r.check.subj) {
      return `<div class="cp-note cp-warnn"><b>Перевірку YouControl не завершено.</b> ${esc(r.check?.error || 'Немає даних.')}${recheck ? `<div class="cp-q">${recheck}</div>` : ''}</div>`;
    }
    const s = r.check.subj;
    const plan = r.status === 'approved' ? 'Планова перевірка YouControl — раз на 3 місяці; суди — щомісяця, поки клієнт винен.'
      : 'Після погодження: планова перевірка YouControl раз на 3 місяці, суди — щомісяця, поки клієнт винен.';
    const footHtml = `<div class="cp-src">${r.checkSaved ? `Взято збережену перевірку (${esc(r.check.byName || 'система')}) — нова не раніше ${dt(validUntil(r.check.at))}. ` : ''}${plan}</div>${recheck}`;
    return ycBox(s, { who: 'клієнт', foot: footHtml, now: now() });
  }
  function filesBox(r: CpRequestView) {
    const link = (url: string | null, inner: string, cls = '') => (url ? `<a class="cp-file${cls}" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>` : `<span class="cp-file${cls}">${inner}</span>`);
    const yc = r.resident && r.check && r.check.pdf ? link(o.api.pdfUrl(r.check.id), `<span aria-hidden="true">📄</span><span class="cp-fn">Досьє YouControl — ${esc(r.code)}.pdf</span><span class="cp-fs">з YouControl</span>`, ' cp-fyc') : '';
    return `<div><div class="cp-lbl" style="margin-bottom:6px">Документи</div><div class="cp-files">${r.files.map(f => link(o.api.fileUrl(f.id), `<span aria-hidden="true">📎</span><span class="cp-fn">${esc(f.name)}</span><span class="cp-fs">${kb(f.size)}</span>`)).join('')}${yc}</div></div>`;
  }
  function renderPanel() {
    if (!alive || !panel) return;
    const D = $('drawer')!;
    if (panel === 'new') { D.innerHTML = newPanel(); return; }
    const r = reqs.find(x => x.id === openId);
    if (!r || !me) { closePanel(); return; }
    const flag = r.flag && r.status === 'pending' ? `<div class="cp-note"><b>Погодження призупинено.</b> ${esc(r.flag.what)}</div>` : '';
    let chg = '';
    if (changePending(r) && r.change && r.ok) {
      const a = calc(r.ok, r.rates, lag), b = calc(r.change.terms, r.rates, lag);
      chg = `<div class="cp-note cp-warnn"><b>Запит на зміну умов</b> — ${esc(r.change.byName)}, ${dm(r.change.at)}. До рішення діють погоджені умови.
        <div class="cp-q">${diffLines(r.ok, r.change.terms).map(esc).join('<br>')}</div>
        <div class="cp-q">Розрахунок боргу: ${debtText(a)} → <b>${debtText(b)}</b><br>Фінансуємо: ${gapText(a)} → <b>${gapText(b)}</b></div>
        <div class="cp-q">Причина: ${esc(r.change.reason)}</div></div>`;
    }
    const editComment = allowedActions(me, r).includes('resubmit');
    const sub = r.resident ? `${esc(r.kind)}${r.check?.subj?.addr ? ' · ' + esc(r.check.subj.addr) : ''}` : `${esc(r.country || '')} · ${esc(r.regNo || '')}`;
    const head = r.resident && r.check?.subj?.head ? `<div class="cp-src">Керівник: ${esc(r.check.subj.head)}</div>` : '';
    D.innerHTML = `
    <div class="cp-dh"><h2 id="${P}dTitle">${esc(r.name)} ${pill(r.status)}</h2>${closeBtn}</div>
    <div class="cp-db">
      <div><div class="cp-src"><span class="cp-code">${esc(r.code)}</span> · ${sub}</div>${head}</div>
      ${flag}
      ${chg}
      ${editBlock(r) || termsBox(r, lag)}
      ${checkBox(r)}
      ${filesBox(r)}
      <div><div class="cp-lbl">Коментар менеджера</div>
        ${editComment ? `<label class="cp-f" style="margin-top:6px"><textarea class="cp-in" id="${P}cmt" rows="3" aria-label="Коментар менеджера">${esc(r.comment)}</textarea></label>`
          : `<div class="cp-quote" style="margin-top:6px">${esc(r.comment || '—')}</div>`}
        <div class="cp-meta">${esc(r.createdByName)} · ${dm(r.createdAt)}</div></div>
      <div><div class="cp-lbl" style="margin-bottom:8px">Історія</div><ul class="cp-tl">${histHtml(r.hist, EVENT_LABEL, EVENT_TONE)}</ul></div>
    </div>
    ${actions(r)}`;
  }
  function actions(r: CpRequestView) {
    const u = me!, acts = allowedActions(u, r), dis = busy ? ' disabled' : '';
    if (acts.includes('approve')) {
      if (decision === 'change') return foot(`<button type="button" class="cp-btn cp-okb" data-act="change-go"${dis}>Погодити з цими умовами</button><button type="button" class="cp-btn" data-act="cancel">Скасувати</button>`);
      if (decision === 'return' || decision === 'reject') {
        const ret = decision === 'return';
        return `<div class="cp-df"><label class="cp-f">${ret ? 'Що доопрацювати' : 'Причина відмови'}<textarea class="cp-in" id="${P}why" rows="3"></textarea></label>
          <div class="cp-acts"><button type="button" class="cp-btn ${ret ? 'cp-pri' : 'cp-badb'}" data-act="${decision}-go" disabled>${ret ? 'Повернути менеджеру' : 'Відхилити'}</button><button type="button" class="cp-btn" data-act="cancel">Скасувати</button></div></div>`;
      }
      return foot(`<button type="button" class="cp-btn cp-okb" data-act="approve"${dis}>Погодити</button><button type="button" class="cp-btn" data-act="change"${dis}>Змінити умови й погодити</button><button type="button" class="cp-btn" data-act="return"${dis}>Повернути</button><button type="button" class="cp-btn cp-badb" data-act="reject"${dis}>Відхилити</button>`,
        `Погоджений ліміт — ${money((r.ok || r.terms).limit)} — зʼявиться в дебіторці: «Ліміти клієнтів» і колонка «Ліміти».`);
    }
    if (acts.includes('changeApprove')) {
      if (decision === 'chgEdit') return foot(`<button type="button" class="cp-btn cp-okb" data-act="chg-edit-go"${dis}>Погодити з цими умовами</button><button type="button" class="cp-btn" data-act="cancel">Скасувати</button>`);
      if (decision === 'chgReject') return `<div class="cp-df"><label class="cp-f">Чому відхиляєте зміну<textarea class="cp-in" id="${P}why" rows="3"></textarea></label>
        <div class="cp-acts"><button type="button" class="cp-btn cp-badb" data-act="chg-reject-go" disabled>Відхилити зміну</button><button type="button" class="cp-btn" data-act="cancel">Скасувати</button></div></div>`;
      return foot(`<button type="button" class="cp-btn cp-okb" data-act="chg-approve"${dis}>Погодити зміну</button><button type="button" class="cp-btn" data-act="chg-edit"${dis}>Змінити й погодити</button><button type="button" class="cp-btn cp-badb" data-act="chg-reject"${dis}>Відхилити зміну</button>`, 'Відхилите — лишаться погоджені раніше умови.');
    }
    if (acts.includes('requestChange')) {
      if (decision === 'reqChange') return foot(`<button type="button" class="cp-btn cp-pri" data-act="req-change-go" disabled>Надіслати на погодження</button><button type="button" class="cp-btn" data-act="cancel">Скасувати</button>`, 'До рішення Сергія діють погоджені умови.');
      return foot(`<button type="button" class="cp-btn" data-act="req-change"${dis}>Змінити умови</button>`);
    }
    if (isOwner(u, r) && changePending(r)) return hintFoot('Запит на зміну умов — у Сергія. До рішення діють погоджені умови.');
    if (acts.includes('resubmit')) return foot(`<button type="button" class="cp-btn cp-pri" data-act="resubmit"${dis}>Надіслати повторно</button>`);
    if (inMyTeam(u, r.createdBy)) return hintFoot(`Запит менеджера вашої команди — лише перегляд. Діяти може ${esc(r.createdByName)}.`);
    return '';
  }

  // ---------- новий клієнт ----------
  function missing(): string[] {
    const d = draft!, m: string[] = [];
    if (!d.resident) { if (!d.country) m.push('країна'); if (!d.regNo.trim()) m.push('номер'); if (!d.cname.trim()) m.push('назва'); }
    m.push(...termsErr(d.t));
    if (!d.files.length) m.push('хоча б один документ');
    if (d.uploading) m.push('дочекатися завантаження файлів');
    return m;
  }
  function foundInner(f: Extract<Found, { check: CheckView }>) {
    const c = f.check, b = c.subj || c.base;
    const lim = f.limit ? `<div class="cp-note cp-mutn"><b>Діючий клієнт:</b> ${esc(limitInfoLine(f.limit))} — ${f.limit.src === 'debt' ? 'перенесено з дебіторки' : 'задав Сергій'}. Після погодження цього запиту діятимуть нові умови.</div>` : '';
    if (!b) return `${spinRows(['ЄДР', 'Суди', 'Виконавчі провадження', 'Експрес-аналіз', 'Власники й капітал'])}<div class="cp-hint">Перевірка в YouControl триває — умови можна заповнювати вже зараз.</div>${lim}`;
    const a = age(b.reg, now());
    const head = `<div class="cp-big">${esc(b.name)}</div><div class="cp-src">${esc(b.kind)}${b.addr ? ' · ' + esc(b.addr) : ''}${b.head ? ' · ' + esc(b.head) : ''}</div>`;
    if (c.status === 'running' || !c.subj) return head + `<div class="cp-crit"><div class="cp-cr"><span class="cp-ic cp-${a.y >= 3 ? 'ok' : 'bad'}">${a.y >= 3 ? '✓' : '✗'}</span><span>Зареєстровано ${dt(b.reg)}</span><span class="cp-v">${a.text}</span></div>
      ${(b.fop ? ['Виконавчі провадження', 'Експрес-аналіз'] : ['Суди', 'Виконавчі провадження', 'Експрес-аналіз', 'Власники й капітал']).map(t => `<div class="cp-cr"><span class="cp-spin"></span><span>${t}</span><span class="cp-v">запит…</span></div>`).join('')}</div>
      <div class="cp-hint">Перевірка в YouControl триває — умови можна заповнювати вже зараз.</div>${lim}`;
    return head + (f.saved ? `<div class="cp-src">Збережена перевірка від ${dt(c.at)} — ${esc(c.byName || 'система')}; нова — не раніше ${dt(validUntil(c.at))}. Транзакції не витрачаються.</div>` : '')
      + ycBox(c.subj, { who: 'клієнт', byName: c.byName, now: now() }) + (a.y < 3 ? '<div class="cp-hint">Менше 3 років — подати можна, рішення за Сергієм.</div>' : '') + lim;
  }
  function newPanel() {
    const d = draft!, f = d.found;
    const check = f && 'check' in f ? f : null, dup = f && 'dup' in f ? f.dup : null;
    const showForm = !d.resident || (!!check && check.check.status !== 'failed');
    const m = showForm ? missing() : [];
    const dupNote = dup ? `<div class="cp-note cp-mutn"><b>${esc(dup.name)}</b> уже ${dup.status === 'approved' && dup.ok ? `погоджений: ${esc(termsLine(dup.ok))}, ${esc(termsSub(dup.ok))}, ліміт ${money(dup.ok.limit)}` : 'має запит «' + STATUS_LABEL[dup.status] + '»'} — ${esc(dup.byName)}, ${dm(dup.at)}.${dup.visible ? ` <button type="button" class="cp-lnk" data-act="open-req" data-rid="${esc(dup.id)}">Відкрити запит</button>` : ''}</div>` : '';
    return `
    <div class="cp-dh"><h2 id="${P}dTitle">Новий клієнт на погодження</h2>${closeBtn}</div>
    <div class="cp-db">
      <div class="cp-hint">Лише для клієнтів із відтермінуванням оплати. На передоплаті погодження не потрібне.</div>
      <div class="cp-seg" role="group" aria-label="Клієнт"><button type="button" data-res="ua" aria-pressed="${d.resident}">Резидент України</button><button type="button" data-res="nr" aria-pressed="${!d.resident}">Нерезидент</button></div>
      ${d.resident ? `
      <form id="${P}find" class="cp-row" autocomplete="off"><input class="cp-in cp-mono" id="${P}code" inputmode="numeric"${o.suggestCodes ? ` list="${P}codes"` : ''} placeholder="ЄДРПОУ або ІПН ФОП" aria-label="ЄДРПОУ або ІПН ФОП" value="${esc(d.code)}"><button type="submit" class="cp-btn"${d.looking ? ' disabled' : ''}>Перевірити в YouControl</button></form>
      ${d.err ? `<div class="cp-err" role="alert">${esc(d.err)}</div>` : ''}
      ${dupNote}
      ${check && check.check.status !== 'failed' ? `<div class="cp-found" id="${P}found">${foundInner(check)}</div>` : ''}` : `
      <div class="cp-grid2">
        <label class="cp-f"><span>Країна <em>*</em></span><select class="cp-in" id="${P}n-country"><option value="">Оберіть…</option>${COUNTRIES.map(c => `<option${d.country === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="cp-f"><span>Реєстраційний номер / VAT <em>*</em></span><input class="cp-in cp-mono" id="${P}n-regNo" value="${esc(d.regNo)}" placeholder="KRS, VAT…"></label>
      </div>
      <label class="cp-f"><span>Назва компанії <em>*</em></span><input class="cp-in" id="${P}n-cname" value="${esc(d.cname)}" placeholder="як у реєстрі країни"></label>
      <div class="cp-hint">Автоперевірки для нерезидентів немає — Сергій вирішує за документами й умовами.</div>`}
      ${showForm ? `
      <div class="cp-lbl">Умови оплати</div>${termsForm(d.t, P + 'n-', rates, lag, limHint(d.t, d.limitAuto))}
      <div><div class="cp-lbl" style="margin-bottom:6px">Документи <em style="color:var(--brand);font-style:normal">*</em></div>
        <label class="cp-drop" id="${P}drop"><input type="file" id="${P}fileIn" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"><span>📎 Перетягніть файли сюди або</span><span class="cp-btn" style="padding:5px 10px">оберіть</span><span class="cp-hint">виписка, реєстраційні, усе від клієнта</span></label>
        ${d.files.length || d.uploading ? `<div class="cp-files" style="margin-top:8px">${d.files.map((x, i) => `<span class="cp-file"><span aria-hidden="true">📎</span><span class="cp-fn">${esc(x.name)}</span><span class="cp-fs">${kb(x.size)}</span><button type="button" class="cp-rm" data-rm="${i}" aria-label="Прибрати ${esc(x.name)}">✕</button></span>`).join('')}${d.uploading ? `<span class="cp-file"><span class="cp-spin"></span><span class="cp-fn">завантажується: ${d.uploading}</span></span>` : ''}</div>` : ''}
        ${d.resident ? '<div class="cp-hint" style="margin-top:6px">PDF-досьє YouControl додасться саме.</div>' : ''}</div>
      <label class="cp-f">Коментар для Сергія<textarea class="cp-in" id="${P}n-comment" rows="3" placeholder="що за клієнт, маршрути, чому відтермінування">${esc(d.comment)}</textarea></label>` : ''}
    </div>
    ${showForm ? `<div class="cp-df"><div class="cp-acts"><button type="button" class="cp-btn cp-pri" data-act="submit"${m.length || busy ? ' disabled' : ''}>Надіслати на погодження</button></div>
      <div class="cp-hint" id="${P}need"${m.length ? '' : ' hidden'}>${m.length ? 'Потрібні: ' + m.join(', ') + '.' : ''}</div></div>` : ''}`;
  }
  function updateReady() {
    if (!draft) return;
    const m = missing(), b = $('drawer')!.querySelector<HTMLButtonElement>('[data-act="submit"]'), h = $('need');
    if (b) b.disabled = m.length > 0 || busy;
    if (h) { h.textContent = m.length ? 'Потрібні: ' + m.join(', ') + '.' : ''; h.hidden = !m.length; }
  }
  function refreshFound() {
    const el = $('found');
    if (el && draft && draft.found && 'check' in draft.found) el.innerHTML = foundInner(draft.found);
  }
  async function lookup(raw: string, prefill?: Extract<NavTarget, { tab: 'new' }>['prefill']) {
    if (!draft) return;
    const code = cleanCode(raw);
    Object.assign(draft, { code, found: null, err: '' });
    const bad = checkCode(code);
    if (bad) { draft.err = bad; renderPanel(); return; }
    draft.looking = true; renderPanel();
    try {
      const f = await o.api.lookup(code);
      if (!draft || panel !== 'new') return;
      draft.found = f;
      if ('check' in f && f.check.status === 'failed') draft.err = f.check.error || 'Перевірка не вдалася — спробуйте ще раз.';
    } catch (e) { if (draft) draft.err = errText(e); }
    if (!draft) return;
    draft.looking = false;
    if (prefill) {
      Object.assign(draft.t.cl, prefill.cl || {});
      if (prefill.ent) draft.t.ent = prefill.ent;
      if (prefill.limit) { draft.t.limit = String(prefill.limit); draft.limitAuto = false; wtAuto = false; }
    }
    renderPanel(); render(); schedulePoll();
    (($('n-cl-days') || $('code')) as HTMLElement | null)?.focus();
  }
  async function addFiles(list: FileList | null) {
    if (!list || !draft) return;
    const d = draft;
    for (const f of Array.from(list)) {
      d.uploading++; renderPanel();
      try { const x = await o.api.upload(f); if (draft === d) d.files.push(x); }
      catch (e) { toast.show(`${f.name}: ${errText(e)}`); }
      finally { d.uploading--; if (draft === d) { renderPanel(); } }
    }
  }
  async function submit() {
    const d = draft; if (!d || busy) return;
    if (missing().length) return;
    const f = d.found && 'check' in d.found ? d.found : null;
    busy = true; updateReady();
    try {
      const created = await o.api.submit(d.resident
        ? { resident: true, code: d.code, checkId: f!.check.id, terms: normTerms(d.t), files: d.files.map(x => x.id), comment: d.comment.trim() }
        : { resident: false, country: d.country, regNo: d.regNo.trim(), name: d.cname.trim(), terms: normTerms(d.t), files: d.files.map(x => x.id), comment: d.comment.trim() });
      busy = false; replace(created);
      filter = 'all'; panel = 'detail'; openId = created.id; draft = null; wtKey = null;
      renderPanel(); render(); schedulePoll();
      toast.show(created.status === 'checking' ? 'Надіслано — перевірка YouControl ще триває' : ACTION_DONE.submit);
    } catch (e) {
      busy = false;
      if (draft) draft.err = errText(e);
      renderPanel(); toast.show(errText(e));
    }
  }

  // ---------- дії ----------
  const replace = (q: CpRequestView) => { const i = reqs.findIndex(x => x.id === q.id); if (i >= 0) reqs[i] = q; else reqs.unshift(q); };
  async function act(r: CpRequestView, a: CpAction, body: Parameters<CpApi['act']>[2], done: (q: CpRequestView) => string) {
    busy = true; renderPanel();
    try {
      const q = await o.api.act(r.id, a, body);
      busy = false; decision = null; wtKey = null; replace(q);
      renderPanel(); render(); schedulePoll(); toast.show(done(q));
    } catch (e) {
      busy = false;
      if (e instanceof CpApiError && e.request) { replace(e.request); decision = null; wtKey = null; }
      renderPanel(); render(); toast.show(errText(e));
    }
  }
  const why = () => (($('why') as HTMLTextAreaElement | null)?.value.trim() || '');
  const termsToast = (err: string[]) => toast.show('Заповніть: ' + err.join(', '));
  function onAct(a: string, el: HTMLElement) {
    if (busy) return;
    if (a === 'submit') { void submit(); return; }
    if (a === 'open-req') { const id = el.dataset.rid!; openPanel('detail', id); if (!reqs.some(x => x.id === id)) void refresh(); return; }
    const r = reqs.find(x => x.id === openId); if (!r) return;
    if (a === 'approve') { void act(r, 'approve', {}, q => `Погоджено — ліміт ${money(q.ok!.limit)} у «Лімітах клієнтів»`); return; }
    if (a === 'change' || a === 'chg-edit' || a === 'req-change') { decision = a === 'change' ? 'change' : a === 'chg-edit' ? 'chgEdit' : 'reqChange'; renderPanel(); ($(a === 'req-change' ? 'c-cl-days' : 'a-cl-days'))?.focus(); return; }
    if (a === 'return' || a === 'reject' || a === 'chg-reject') { decision = a === 'chg-reject' ? 'chgReject' : a; renderPanel(); $('why')?.focus(); return; }
    if (a === 'cancel') { decision = null; wtKey = null; renderPanel(); render(); return; }
    if (a === 'change-go' || a === 'chg-edit-go') {
      const err = termsErr(wt!); if (err.length) { termsToast(err); return; }
      const t = normTerms(wt!);
      if (a === 'change-go') { const same = sameTerms(t, r.ok || r.terms); void act(r, 'approveChanged', { terms: t }, q => `${same ? 'Погоджено' : 'Погоджено з іншими умовами'} — ліміт ${money(q.ok!.limit)} у «Лімітах клієнтів»`); }
      else void act(r, 'changeApprove', { terms: t }, q => `Зміну умов погоджено — ліміт ${money(q.ok!.limit)}`);
      return;
    }
    if (a === 'return-go' || a === 'reject-go' || a === 'chg-reject-go') {
      const which: CpAction = a === 'return-go' ? 'return' : a === 'reject-go' ? 'reject' : 'changeReject';
      const t = why(); if (!t) { toast.show(NOTE_EMPTY[which]!); return; }
      void act(r, which, { note: t }, () => ACTION_DONE[which]); return;
    }
    if (a === 'chg-approve') { void act(r, 'changeApprove', {}, q => `Зміну умов погоджено — ліміт ${money(q.ok!.limit)}`); return; }
    if (a === 'req-change-go') {
      const t = why(); if (!t) return;
      const err = termsErr(wt!); if (err.length) { termsToast(err); return; }
      if (sameTerms(normTerms(wt!), r.ok)) { toast.show('Умови не змінились'); return; }
      void act(r, 'requestChange', { terms: normTerms(wt!), reason: t }, () => ACTION_DONE.requestChange); return;
    }
    if (a === 'resubmit') {
      const err = termsErr(wt!); if (err.length) { termsToast(err); return; }
      const c = ($('cmt') as HTMLTextAreaElement | null)?.value.trim();
      void act(r, 'resubmit', { terms: normTerms(wt!), comment: c || r.comment }, () => ACTION_DONE.resubmit); return;
    }
    if (a === 'recheck') { wasRechecking.add(r.id); void act(r, 'recheck', {}, () => 'Перевіряємо заново в YouControl…'); }
  }
  /** Поле «Ліміт боргу»: поки його не чіпали — іде за розрахунком. */
  function syncLimit(fromLimitInput: boolean) {
    if (!wt) return;
    const isNew = panel === 'new' && draft;
    let auto = isNew ? draft!.limitAuto : wtAuto;
    if (fromLimitInput) auto = false;
    else if (auto) {
      const c = calc(wt, curRates(), lag); wt.limit = c.debt !== undefined ? String(c.debt) : '';
      const li = $('drawer')!.querySelector<HTMLInputElement>('[data-tf="limit"]'); if (li) li.value = String(wt.limit);
    }
    if (isNew) draft!.limitAuto = auto; else wtAuto = auto;
    const h = $('drawer')!.querySelector<HTMLElement>('[data-limhint]'); if (h) h.innerHTML = limHint(wt, auto);
  }

  // ---------- події ----------
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const fb = t.closest<HTMLElement>('[data-f]');
    if (fb && $('filters')!.contains(fb)) { filter = fb.dataset.f as ReqFilter; render(); return; }
    if (t.closest(`#${P}add`)) { openPanel('new'); return; }
    if (t.closest(`#${P}scrim`)) { closePanel(); return; }
    const tr = t.closest<HTMLElement>('tr[data-id]');
    if (tr && $('rows')!.contains(tr)) { openPanel('detail', tr.dataset.id); return; }
    const D = $('drawer')!;
    if (!D.contains(t)) return;
    if (t.closest('[data-close]')) { closePanel(); return; }
    if (t.closest('[data-limauto]') && wt) { if (panel === 'new' && draft) draft.limitAuto = true; else wtAuto = true; syncLimit(false); updateReady(); return; }
    const rs = t.closest<HTMLElement>('[data-res]');
    if (rs && panel === 'new' && draft) {
      draft.resident = rs.dataset.res === 'ua'; draft.err = '';
      if (!String(draft.t.cl.rate).trim() && !String(draft.t.ca.rate).trim()) {
        const b = blankTerms(draft.resident); draft.t.cl.cur = b.cl.cur; draft.t.ca.cur = b.ca.cur; draft.t.cl.pay = b.cl.pay;
      }
      renderPanel(); return;
    }
    const rm = t.closest<HTMLElement>('[data-rm]');
    if (rm && draft) { draft.files.splice(Number(rm.dataset.rm), 1); renderPanel(); return; }
    const b = t.closest<HTMLElement>('[data-act]');
    if (b && !(b as HTMLButtonElement).disabled) onAct(b.dataset.act!, b);
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
    if (tr && $('rows')!.contains(tr)) openPanel('detail', tr.dataset.id);
  };
  const onInput = (e: Event) => {
    const t = e.target as HTMLInputElement;
    if (t.id === P + 'q') { query = t.value; render(); return; }
    const D = $('drawer')!;
    if (!D.contains(t)) return;
    if (t.dataset && t.dataset.tf && wt) {
      const [a, b] = t.dataset.tf.split('.') as [keyof TermsInput, string | undefined];
      if (b) (wt[a] as unknown as Record<string, string>)[b] = t.value; else (wt as unknown as Record<string, string>)[a] = t.value;
      syncLimit(t.dataset.tf === 'limit');
      const box = D.querySelector<HTMLElement>('[data-calc]'); if (box) box.innerHTML = calcInner(wt, curRates(), lag);
      updateReady();
      return;
    }
    if (panel === 'new' && draft && t.id.startsWith(P + 'n-')) {
      const k = t.id.slice((P + 'n-').length);
      if (k === 'country' || k === 'regNo' || k === 'cname' || k === 'comment') draft[k] = t.value;
      updateReady(); return;
    }
    if (t.id === P + 'why') { const btn = D.querySelector<HTMLButtonElement>('[data-act$="-go"]'); if (btn) btn.disabled = !t.value.trim(); }
  };
  const onChange = (e: Event) => {
    const t = e.target as HTMLInputElement;
    if (t.id === P + 'fileIn') { void addFiles(t.files); t.value = ''; }
  };
  const onSubmit = (e: Event) => {
    if ((e.target as HTMLElement).id !== P + 'find') return;
    e.preventDefault();
    void lookup(($('code') as HTMLInputElement).value);
  };
  const onDrag = (e: DragEvent) => {
    const z = (e.target as HTMLElement).closest?.(`#${P}drop`) as HTMLElement | null;
    if (!z) return;
    if (e.type === 'dragover') { e.preventDefault(); z.classList.add('cp-over'); }
    else if (e.type === 'dragleave') z.classList.remove('cp-over');
    else { e.preventDefault(); z.classList.remove('cp-over'); void addFiles(e.dataTransfer?.files || null); }
  };
  const onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && panel) closePanel(); };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  for (const ev of ['dragover', 'dragleave', 'drop']) root.addEventListener(ev, onDrag as EventListener);
  document.addEventListener('keydown', onDocKey);

  // ---------- дані ----------
  /** Поки YouControl перевіряє — опитуємо сервер. */
  function schedulePoll() {
    clearTimeout(pollT);
    if (!alive) return;
    const waitReq = reqs.some(r => r.status === 'checking' || r.rechecking);
    const f = draft && draft.found && 'check' in draft.found ? draft.found : null;
    const waitDraft = !!f && f.check.status === 'running';
    if (!waitReq && !waitDraft) return;
    pollT = setTimeout(async () => {
      if (!alive) return;
      if (waitDraft && f && draft && draft.found === f) {
        try {
          const c = await o.api.getCheck(f.check.id);
          if (draft && draft.found === f) {
            f.check = c;
            if (c.status === 'failed') { draft.err = c.error || 'Перевірка не вдалася.'; renderPanel(); }
            else if (c.status === 'done') { renderPanel(); updateReady(); }
            else refreshFound();
          }
        } catch { /* наступна спроба */ }
      }
      if (waitReq) await refresh();
      else schedulePoll();
    }, o.pollMs ?? 2500);
  }
  async function refresh() {
    try {
      const j = await o.api.listRequests();
      if (!alive) return;
      const changed = !me || me.id !== j.me.id || me.role !== j.me.role;
      const before = panel === 'detail' ? JSON.stringify(reqs.find(r => r.id === openId) || null) : '';
      me = j.me; reqs = j.requests; rates = j.rates; lag = j.lag; budget = j.budget || null; loadErr = '';
      for (const id of [...wasRechecking]) {
        const r = reqs.find(x => x.id === id);
        if (r && !r.rechecking) { wasRechecking.delete(id); if (r.check?.status === 'done') toast.show(me.role === 'approver' ? `Перевірено заново — списано ${txW(r.check.tx)}` : 'Перевірено заново'); }
      }
      if (changed) { filter = defaultFilter(me.role); if (panel) closePanel(); }
      else if (panel === 'detail') {
        if (!reqs.some(r => r.id === openId)) closePanel();
        // перемальовуємо картку, лише якщо запит змінився (перевірка завершилась тощо) і людина зараз нічого не вводить
        else if (JSON.stringify(reqs.find(r => r.id === openId)) !== before && !decision && !typing()) renderPanel();
      }
    } catch (e) {
      if (!alive) return;
      loadErr = 'Не вдалося завантажити запити. ' + errText(e);
    }
    render();
    if (pending) { const t = pending; pending = null; open(t); }
    schedulePoll();
  }
  /** Курсор у полі панелі — не перемальовуємо, щоб не загубити введене. */
  const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $('drawer')!.contains(a); };
  function open(t: NavTarget) {
    if (!me) { pending = t; return; }
    if (t.tab !== 'new') return;
    if (t.requestId) {
      openPanel('detail', t.requestId);
      const r = reqs.find(x => x.id === t.requestId);
      if (r && t.reqChange && allowedActions(me, r).includes('requestChange')) { decision = 'reqChange'; renderPanel(); $('c-cl-days')?.focus(); }
      return;
    }
    if (canSubmit(me.role)) {
      openPanel('new');
      if (t.newCode) void lookup(t.newCode, t.prefill);
    }
  }

  render();
  void refresh();

  return {
    refresh,
    open,
    destroy() {
      alive = false; toast.stop(); clearTimeout(pollT);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onChange);
      root.removeEventListener('submit', onSubmit);
      for (const ev of ['dragover', 'dragleave', 'drop']) root.removeEventListener(ev, onDrag as EventListener);
      document.removeEventListener('keydown', onDocKey);
      root.innerHTML = '';
    },
  };
}
