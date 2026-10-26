/**
 * Вкладка «Ліміти клієнтів» — п'ята вкладка сторінки «Дебіторська заборгованість» (рішення Сергія 23.10).
 *   const h = mountClientLimits(el, { api: clientLimitsApi, onCount: n => …, navigate });   // h.refresh(), h.open(t), h.destroy()
 * Вигляд = узгоджений макет v5 (23.10). Стилі — client/counterparty/cp.css (спільні з «Узгодженням»).
 */
import {
  LFILTERS, LIMIT_EVENT_LABEL, LIMIT_EVENT_TONE, canSeeLimit, isNoLimit, limIn, limitActions, limitState, limitsBadge, rowRank, srcText,
  type AnyRow, type LimFilter, type LimitRow, type NoLimitRow,
} from '../../shared/clientLimits';
import { ENT_LABEL, FROM_LABEL, PAY_SHORT, diffLines, sideLine, type CpUser, type From } from '../../shared/counterparty';
import { PLANNED_CYCLE_DAYS } from '../../shared/cpCheck';
import { dayW, dm, dt, esc, money, plural } from '../../shared/cpFormat';
import type { LimitsApi, Navigate, NavTarget } from '../counterparty/types';
import { CpApiError } from '../counterparty/types';
import { SEARCH_ICON, closeBtn, errText, foot, hintFoot, histHtml, makeToast, opts, usebar } from '../counterparty/ui';

export interface LimitsOptions {
  api: LimitsApi;
  /** Лічильник на вкладці «Ліміти клієнтів»: перевищено ліміт + прострочено + нова справа в суді. */
  onCount?: (n: number) => void;
  /** Перехід на «Узгодження» / «Перевірку контрагента» (інша сторінка дашборда). */
  navigate?: Navigate;
  initial?: NavTarget;
  now?: () => Date;
}
export interface LimitsHandle { refresh(): Promise<void>; open(t: NavTarget): void; destroy(): void }

let seq = 0;
type Decision = 'edit' | 'set' | null;

export function mountClientLimits(root: HTMLElement, o: LimitsOptions): LimitsHandle {
  const P = `cpl${++seq}-`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(P + id) as T | null;
  const toast = makeToast(() => $('toast'));
  let me: CpUser | null = null, rows: AnyRow[] = [], debtAt: string | null = null, monitor: { last: string | null; next: string } | null = null;
  let loadErr = '', filter: LimFilter = 'all', query = '', openId: string | null = null, decision: Decision = null, busy = false, alive = true;
  let pending: NavTarget | null = o.initial || null;

  root.innerHTML = `<div class="cpx">
  <div class="cp-cq">
    <section class="cp-card" aria-label="Ліміти клієнтів">
      <div class="cp-bar">
        <div class="cp-ways" id="${P}filters" role="group" aria-label="Фільтр лімітів"></div>
        <span class="cp-grow"></span>
        <span class="cp-yc" id="${P}at"></span>
        <label class="cp-search">${SEARCH_ICON}<input id="${P}q" placeholder="ЄДРПОУ або назва" aria-label="Пошук клієнта за ЄДРПОУ або назвою" autocomplete="off"></label>
      </div>
      <div class="cp-tblwrap"><table class="cp-reg">
        <thead><tr><th>Клієнт</th><th>Ліміт</th><th>Відтермінування</th><th>Борг зараз</th><th>Прострочено</th><th>Менеджер</th></tr></thead>
        <tbody id="${P}rows"></tbody>
        <tfoot id="${P}foot"></tfoot>
      </table></div>
    </section>
  </div>
  <div class="cp-scrim" id="${P}scrim" hidden></div>
  <aside class="cp-drawer" id="${P}drawer" role="dialog" aria-modal="true" aria-labelledby="${P}dTitle" hidden></aside>
  <div class="cp-toast" id="${P}toast" role="status" aria-live="polite" hidden></div>
</div>`;

  const code0 = (x: AnyRow) => x.members[0]?.code || '';
  const membersSub = (x: AnyRow) => (x.members.length > 1 ? `<div class="cp-sub">+${x.members.length - 1} ${plural(x.members.length - 1, 'юрособа', 'юрособи', 'юросіб')}: ${x.members.slice(1).map(m => esc(m.name)).join(', ')}</div>` : '');
  const terms = (x: LimitRow) => (x.days !== null ? sideLine({ days: x.days, from: x.from }) : 'дні не погоджено');
  const limitText = (x: LimitRow) => (x.limit !== null ? money(x.limit) : 'суму не погоджено');

  function render() {
    if (!alive) return;
    const body = $('rows')!, f = $('foot')!;
    if (!me) { body.innerHTML = `<tr><td colspan="6" class="cp-empty">${loadErr ? esc(loadErr) : 'Завантаження…'}</td></tr>`; f.innerHTML = ''; $('filters')!.innerHTML = ''; return; }
    const u = me;
    const all = rows.filter(x => canSeeLimit(u, x));
    o.onCount?.(limitsBadge(u, all));
    $('filters')!.innerHTML = LFILTERS.map(([k, t]) => `<button type="button" data-lf="${k}" aria-pressed="${filter === k}">${t} <span class="cp-c">${all.filter(x => limIn(x, k)).length}</span></button>`).join('');
    $('at')!.textContent = debtAt ? `Борг — з дебіторки на ${dm(debtAt)}` : 'Дебіторка недоступна — борг не показано';
    const qq = query.trim().toLowerCase();
    const list = all.filter(x => limIn(x, filter) && (!qq || x.name.toLowerCase().includes(qq) || x.members.some(m => m.code.toLowerCase().includes(qq) || m.name.toLowerCase().includes(qq))))
      .sort((a, b) => rowRank(a) - rowRank(b) || a.name.localeCompare(b.name, 'uk'));
    body.innerHTML = list.map(x => {
      const name = `<td class="cp-c-cl"><div class="cp-who">${esc(x.name)}</div><div class="cp-sub"><span class="cp-code">${esc(code0(x) || '—')}</span>${x.kind ? ' · ' + esc(x.kind) : ''}</div>${membersSub(x)}${!isNoLimit(x) && x.suspended ? '<div class="cp-flag">призупинено — нова справа в суді</div>' : ''}${!isNoLimit(x) && x.change ? '<div class="cp-flag cp-w">запит на зміну умов</div>' : ''}${!isNoLimit(x) && x.notice ? `<div class="cp-flag cp-w" title="${esc(x.notice.what)}">зміни в YouControl</div>` : ''}</td>`;
      const who = `<td class="cp-c-mg"><div class="cp-mgr">${esc(x.managerName)}</div><div class="cp-sub">${esc(srcText(x))}</div></td>`;
      const sel = openId === x.id ? ' cp-sel' : '';
      if (isNoLimit(x)) return `<tr data-lid="${esc(x.id)}" tabindex="0" class="cp-nolim${sel}" aria-label="${esc(x.name)}">${name}
        <td class="cp-c-lm"><span class="cp-ck cp-mut">не узгоджено</span></td>
        <td class="cp-c-tm"><span class="cp-sub">умов немає</span></td>
        <td class="cp-c-st"><b class="cp-num">${money(x.debt)}</b><div class="cp-sub">${dayW(x.ageDays)} без оплати</div></td>
        <td class="cp-c-od"><span class="cp-sub">—</span></td>${who}</tr>`;
      return `<tr data-lid="${esc(x.id)}" tabindex="0" class="${x.alert ? 'cp-alert' : ''}${sel}" aria-label="${esc(x.name)}">${name}
        <td class="cp-c-lm"><b class="cp-num">${limitText(x)}</b>${x.limit !== null ? `${usebar(x.use)}<div class="cp-sub">використано ${x.use} %</div>` : ''}</td>
        <td class="cp-c-tm"><div class="cp-terms"><b>${esc(terms(x))}</b></div><div class="cp-sub">${[x.ent ? ENT_LABEL[x.ent] : '', x.pay ? PAY_SHORT[x.pay] : ''].filter(Boolean).join(' · ')}</div></td>
        <td class="cp-c-st"><b class="cp-num${x.over ? ' cp-neg' : ''}">${x.debt ? money(x.debt) : '—'}</b>${x.over && x.limit !== null ? `<div class="cp-flag">понад ліміт ${money(x.debt - x.limit)}</div>` : ''}</td>
        <td class="cp-c-od">${x.odDays ? `<b class="cp-neg">${dayW(x.odDays)}</b><div class="cp-sub">${money(x.odSum)}</div>` : '<span class="cp-sub">—</span>'}</td>${who}</tr>`;
    }).join('') || '<tr><td colspan="6" class="cp-empty">Порожньо</td></tr>';
    const sl = list.reduce((a, x) => a + (!isNoLimit(x) && x.limit ? x.limit : 0), 0), sd = list.reduce((a, x) => a + x.debt, 0);
    f.innerHTML = list.length ? `<tr><td colspan="6">${list.length} ${plural(list.length, 'клієнт', 'клієнти', 'клієнтів')} · ліміти разом ${money(sl)} · борг ${money(sd)}</td></tr>` : '';
  }

  // ---------- панель ----------
  function openPanel(id: string) { openId = id; decision = null; $('scrim')!.hidden = false; $('drawer')!.hidden = false; renderPanel(); render(); $('drawer')!.querySelector<HTMLElement>('[data-close]')?.focus(); }
  function closePanel() { openId = null; decision = null; $('scrim')!.hidden = true; $('drawer')!.hidden = true; render(); }
  const limForm = (x: LimitRow | null, title: string, ph: string) => `<div class="cp-box cp-edit"><div class="cp-lbl">${title}</div>
    <div class="cp-grid2">
      <label class="cp-f"><span>Ліміт боргу, грн <em>*</em></span><input class="cp-in cp-mono" id="${P}l-limit" inputmode="numeric" value="${x && x.limit !== null ? x.limit : ''}" placeholder="напр. 200000"></label>
      <label class="cp-f"><span>Днів відтермінування <em>*</em></span><input class="cp-in cp-mono" id="${P}l-days" inputmode="numeric" value="${x && x.days !== null ? x.days : ''}" placeholder="напр. 14"></label>
    </div>
    <label class="cp-f">Від чого рахувати<select class="cp-in" id="${P}l-from">${opts(FROM_LABEL, x ? x.from : 'orig')}</select></label>
    <label class="cp-f"><span>Причина <em>*</em></span><textarea class="cp-in" id="${P}why" rows="2" placeholder="${ph}"></textarea></label></div>`;
  function renderPanel() {
    if (!alive || !openId || !me) return;
    const D = $('drawer')!;
    const x = rows.find(y => y.id === openId);
    if (!x) { closePanel(); return; }
    const members = x.members.length > 1 ? `<div><div class="cp-lbl" style="margin-bottom:6px">Юрособи клієнта (обʼєднано в дебіторці)</div><div class="cp-mem">${x.members.map(m => `<div><b>${esc(m.name)}</b> <span class="cp-code">${esc(m.code)}</span></div>`).join('')}</div></div>` : '';
    const st = limitState(x);
    if (isNoLimit(x)) {
      D.innerHTML = `
      <div class="cp-dh"><h2 id="${P}dTitle">${esc(x.name)} <span class="cp-pill cp-${st[0]}">${st[1]}</span></h2>${closeBtn}</div>
      <div class="cp-db">
        <div class="cp-src"><span class="cp-code">${esc(code0(x) || '—')}</span>${x.kind ? ' · ' + esc(x.kind) : ''} · менеджер ${esc(x.managerName)}</div>
        <div class="cp-note cp-warnn"><b>Борг є, а умови не погоджено.</b> ${money(x.debt)}, ${dayW(x.ageDays)} без оплати — з дебіторки на ${dm(debtAt)}. Після погодження ліміт зʼявиться тут і в колонці «Ліміти» активної дебіторки.</div>
        ${members}
        ${decision === 'set' ? limForm(null, 'Задати ліміт', 'напр. платить вчасно, працюємо давно') : ''}
      </div>
      ${limActions(x)}`;
      return;
    }
    const hist = histHtml(x.hist, LIMIT_EVENT_LABEL, LIMIT_EVENT_TONE);
    const next = monitor ? dt(monitor.next) : '';
    // планова перевірка — раз на 3 місяці; суди щомісяця — лише поки є борг (рішення 23.10)
    const lc = x.lastCheck;
    const checkLine = lc ? `Остання перевірка YouControl — ${dt(lc.at)}. <button type="button" class="cp-lnk" data-act="lim-open-check">Відкрити</button>`
      : `Перевірки YouControl ще не було — планова буде найближчими днями.${code0(x) && me.role === 'approver' ? ' <button type="button" class="cp-lnk" data-act="lim-check">Перевірити зараз</button>' : ''}`;
    const srcNote = x.src === 'req'
      ? `<b>Погоджено запитом</b> ${dt(x.at)}. <button type="button" class="cp-lnk" data-act="open-req">Відкрити запит</button>`
      : x.src === 'set'
        ? `<b>Ліміт задав ${esc(x.hist.find(h => h.type === 'limitSet')?.byName || 'Сергій')}</b> ${dt(x.at)}. ${checkLine}`
        : `<b>Перенесено з дебіторки</b> ${dt(x.at)}${x.note ? ' — ' + esc(x.note) : ''}. ${checkLine}`;
    const plannedNext = lc ? `наступна ≈ ${dt(new Date(Date.parse(lc.at) + PLANNED_CYCLE_DAYS * 864e5))}` : 'перша — найближчими днями';
    const plan = code0(x) ? `Планова перевірка YouControl — раз на 3 місяці, ${plannedNext}; суди — щомісяця, поки є борг${x.members.length > 1 ? ', по кожній юрособі' : ''}${x.debt > 0 && next ? ` (наступна ${next})` : ''}.`
      : 'Коду ЄДРПОУ немає — автоматичних перевірок YouControl немає.';
    D.innerHTML = `
      <div class="cp-dh"><h2 id="${P}dTitle">${esc(x.name)} <span class="cp-pill cp-${st[0]}">${st[1]}</span></h2>${closeBtn}</div>
      <div class="cp-db">
        <div class="cp-src"><span class="cp-code">${esc(code0(x) || '—')}</span>${x.kind ? ' · ' + esc(x.kind) : ''} · менеджер ${esc(x.managerName)}</div>
        ${x.flag ? `<div class="cp-note"><b>${x.src === 'req' ? 'Погодження призупинено.' : 'Ліміт призупинено.'}</b> ${esc(x.flag.what)}</div>` : ''}
        ${x.notice ? `<div class="cp-note cp-warnn"><b>Зміни в YouControl</b> — ${dt(x.notice.at)}: ${esc(x.notice.what)}.${lc ? ' <button type="button" class="cp-lnk" data-act="lim-open-check">Відкрити перевірку</button>' : ''}<div class="cp-q">Ліміт діє; позначка зникне за 30 днів.</div></div>` : ''}
        ${x.change && x.terms ? `<div class="cp-note cp-warnn"><b>Запит на зміну умов</b> — ${esc(x.change.byName)}, ${dm(x.change.at)}. Рішення — в «Узгодженні», до нього діє цей ліміт.<div class="cp-q">${diffLines(x.terms, x.change.terms).map(esc).join('<br>')}</div></div>` : ''}
        <div class="cp-box"><div class="cp-lh"><span class="cp-lbl">Ліміт боргу</span><span class="cp-src">${debtAt ? `борг — з дебіторки на ${dm(debtAt)}` : 'дебіторка недоступна'}</span></div>
          <div class="cp-limbig"><b class="cp-num">${limitText(x)}</b><span class="cp-sub">${esc([terms(x), x.ent ? ENT_LABEL[x.ent] : '', x.pay ? PAY_SHORT[x.pay] : ''].filter(Boolean).join(' · '))}</span></div>
          ${x.limit !== null ? usebar(x.use, true) : ''}
          <div class="cp-kv">
            <div><span>Борг зараз${x.limit !== null ? ` — ${x.use} % ліміту` : ''}</span><b class="${x.over ? 'cp-neg' : ''}">${money(x.debt)}</b>${x.limit !== null ? `<i class="${x.over ? 'cp-neg' : ''}">${x.over ? `понад ліміт на ${money(x.debt - x.limit)}` : `вільно ${money(x.limit - x.debt)}`}</i>` : ''}</div>
            <div><span>Прострочено</span><b class="${x.odDays ? 'cp-neg' : ''}">${x.odDays ? `${dayW(x.odDays)} · ${money(x.odSum)}` : 'немає'}</b></div>
          </div>
          <div class="cp-src">${plan}</div></div>
        ${members}
        <div class="cp-note cp-mutn">${srcNote}</div>
        ${decision === 'edit' ? limForm(x, 'Змінити ліміт', 'напр. платить вчасно, обсяги зросли') : ''}
        <div><div class="cp-lbl" style="margin-bottom:8px">Історія ліміту</div><ul class="cp-tl">${hist || '<li><span></span><span class="cp-hint">Ще нічого не змінювалось.</span></li>'}</ul></div>
      </div>
      ${limActions(x)}`;
  }
  function limActions(x: AnyRow) {
    const u = me!, acts = limitActions(u, x), dis = busy ? ' disabled' : '';
    const teamHint = hintFoot(`Клієнт менеджера вашої команди — лише перегляд. Діяти може ${esc(x.managerName)}.`);
    if (isNoLimit(x)) {
      if (acts.includes('set')) {
        if (decision === 'set') return foot(`<button type="button" class="cp-btn cp-okb" data-act="lim-set-go" disabled>Задати ліміт</button><button type="button" class="cp-btn" data-act="cancel">Скасувати</button>`, 'Ліміт і дні одразу підуть у колонку «Ліміти» активної дебіторки.');
        return foot(`<button type="button" class="cp-btn" data-act="lim-set"${dis}>Задати ліміт</button>`, 'Або дочекайтеся запиту менеджера з перевіркою YouControl.');
      }
      if (acts.includes('applyNew')) return code0(x) ? foot('<button type="button" class="cp-btn cp-pri" data-act="lim-apply-new">Подати запит на ліміт</button>', 'Запит пройде перевірку YouControl і піде Сергію.')
        : hintFoot('Коду ЄДРПОУ в дебіторці немає — подайте запит з вкладки «Узгодження роботи з новим контрагентом».');
      return u.role === 'lead' && x.managerId !== u.id ? teamHint : '';
    }
    if (u.role === 'approver') {
      if (decision === 'edit') return foot(`<button type="button" class="cp-btn cp-okb" data-act="lim-edit-go" disabled>Зберегти ліміт</button><button type="button" class="cp-btn" data-act="cancel">Скасувати</button>`, 'Нові ліміт і дні одразу підуть у дебіторку.');
      if (acts.includes('openReq')) return foot('<button type="button" class="cp-btn cp-pri" data-act="open-req">Відкрити запит</button>', 'Погодження призупинено — рішення в запиті.');
      if (acts.includes('keep')) return foot(`<button type="button" class="cp-btn cp-okb" data-act="lim-keep"${dis}>Лишити ліміт</button><button type="button" class="cp-btn" data-act="lim-edit"${dis}>Змінити ліміт</button>`, 'Нова справа в суді — вирішіть, чи лишати ліміт.');
      return foot(`<button type="button" class="cp-btn" data-act="lim-edit"${dis}>Змінити ліміт</button>`);
    }
    if (acts.includes('apply')) return foot('<button type="button" class="cp-btn cp-pri" data-act="lim-apply">Подати запит на нові умови</button>', 'Нові умови — через погодження. До рішення діє цей ліміт.');
    if (acts.includes('requestChange')) return foot('<button type="button" class="cp-btn" data-act="lim-req-change">Запросити зміну умов</button>');
    if (x.managerId === u.id && x.src === 'req') return hintFoot('Рішення щодо умов — у Сергія. До нього діє цей ліміт.');
    if (u.role === 'lead' && x.managerId !== u.id) return teamHint;
    return '';
  }

  // ---------- дії ----------
  const replace = (r: LimitRow) => { const i = rows.findIndex(y => y.id === r.id); if (i >= 0) rows[i] = r; else rows.push(r); };
  const formVals = () => ({ limit: ($('l-limit') as HTMLInputElement).value, days: ($('l-days') as HTMLInputElement).value, from: ($('l-from') as HTMLSelectElement).value as From, reason: ($('why') as HTMLTextAreaElement).value.trim() });
  async function run(p: () => Promise<LimitRow>, ok: string, afterId?: (r: LimitRow) => void) {
    busy = true; renderPanel();
    try {
      const r = await p();
      busy = false; decision = null; replace(r); afterId?.(r);
      renderPanel(); render(); toast.show(ok);
    } catch (e) {
      busy = false;
      if (e instanceof CpApiError && e.status === 409) void refresh();
      renderPanel(); toast.show(errText(e));
    }
  }
  function onAct(a: string) {
    const x = rows.find(y => y.id === openId); if (!x || busy) return;
    const nav = o.navigate;
    if (a === 'cancel') { decision = null; renderPanel(); return; }
    if (a === 'lim-check') { closePanel(); nav?.({ tab: 'check', code: code0(x) }); return; }
    if (a === 'lim-open-check' && !isNoLimit(x) && x.lastCheck) { closePanel(); nav?.({ tab: 'check', checkId: x.lastCheck.id }); return; }
    if (a === 'open-req' && !isNoLimit(x) && x.requestId) { closePanel(); nav?.({ tab: 'new', requestId: x.requestId }); return; }
    if (a === 'lim-req-change' && !isNoLimit(x) && x.requestId) { closePanel(); nav?.({ tab: 'new', requestId: x.requestId, reqChange: true }); return; }
    if (a === 'lim-apply-new') { closePanel(); nav?.({ tab: 'new', newCode: code0(x) }); return; }
    if (a === 'lim-apply' && !isNoLimit(x)) {
      closePanel();
      nav?.({ tab: 'new', newCode: code0(x), prefill: { cl: { ...(x.days !== null ? { days: x.days } : {}), from: x.from, ...(x.pay ? { pay: x.pay } : {}) }, ...(x.ent ? { ent: x.ent } : {}), ...(x.limit !== null ? { limit: x.limit } : {}) } });
      return;
    }
    if (a === 'lim-set' || a === 'lim-edit') { decision = a === 'lim-set' ? 'set' : 'edit'; renderPanel(); $('l-limit')?.focus(); return; }
    if (a === 'lim-keep' && !isNoLimit(x)) { void run(() => o.api.keep(x.id), 'Ліміт лишено'); return; }
    if (a === 'lim-edit-go' && !isNoLimit(x)) {
      const v = formVals(); if (!v.reason) return;
      void run(() => o.api.edit(x.id, v), 'Ліміт змінено — дебіторка покаже нові умови'); return;
    }
    if (a === 'lim-set-go' && isNoLimit(x)) {
      const v = formVals(); if (!v.reason) return;
      const was = x as NoLimitRow;
      void run(() => o.api.set(was.debtorKey, v), 'Ліміт задано — зʼявиться в колонці «Ліміти» активної дебіторки', r => { rows = rows.filter(y => y.id !== was.id); openId = r.id; });
    }
  }

  // ---------- події ----------
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const fb = t.closest<HTMLElement>('[data-lf]');
    if (fb && $('filters')!.contains(fb)) { filter = fb.dataset.lf as LimFilter; render(); return; }
    if (t.closest(`#${P}scrim`)) { closePanel(); return; }
    const tr = t.closest<HTMLElement>('tr[data-lid]');
    if (tr && $('rows')!.contains(tr)) { openPanel(tr.dataset.lid!); return; }
    const D = $('drawer')!;
    if (!D.contains(t)) return;
    if (t.closest('[data-close]')) { closePanel(); return; }
    const b = t.closest<HTMLElement>('[data-act]');
    if (b && !(b as HTMLButtonElement).disabled) onAct(b.dataset.act!);
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-lid]');
    if (tr && $('rows')!.contains(tr)) openPanel(tr.dataset.lid!);
  };
  const onInput = (e: Event) => {
    const t = e.target as HTMLInputElement;
    if (t.id === P + 'q') { query = t.value; render(); return; }
    if (t.id === P + 'why') { const b = $('drawer')!.querySelector<HTMLButtonElement>('[data-act$="-go"]'); if (b) b.disabled = !t.value.trim(); }
  };
  const onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openId) closePanel(); };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('input', onInput);
  document.addEventListener('keydown', onDocKey);

  async function refresh() {
    try {
      const j = await o.api.list();
      if (!alive) return;
      const changed = !!me && (me.id !== j.me.id || me.role !== j.me.role);
      me = j.me; rows = j.rows; debtAt = j.debtAt; monitor = j.monitor; loadErr = '';
      if (changed && openId) closePanel();
      else if (openId && !decision) renderPanel();
    } catch (e) { if (alive) loadErr = 'Не вдалося завантажити ліміти. ' + errText(e); }
    render();
    if (pending && me) { const t = pending; pending = null; doOpen(t); }
  }
  function doOpen(t: NavTarget) {
    if (t.tab !== 'limits') return;
    if (!me) { pending = t; return; }
    if (t.limitId && rows.some(x => x.id === t.limitId)) openPanel(t.limitId);
  }

  render();
  void refresh();
  return {
    refresh,
    open: doOpen,
    destroy() {
      alive = false; toast.stop();
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('input', onInput);
      document.removeEventListener('keydown', onDocKey);
      root.innerHTML = '';
    },
  };
}
