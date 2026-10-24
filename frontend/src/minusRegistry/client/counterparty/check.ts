/**
 * Вкладка «Перевірка контрагента» (сторінка «Реєстри та узгодження»): будь-який співробітник перевіряє будь-якого українського контрагента
 * (клієнта чи перевізника) в YouControl. Повтор того самого коду — раз на 2 місяці; до того всі бачать збережену (Сергій — «Перевірити заново зараз»).
 *   const h = mountCounterpartyCheck(el, { api: counterpartyApi, navigate });   // h.refresh(), h.open({tab:'check', code}), h.destroy()
 * Вигляд = узгоджений макет v5 (23.10).
 */
import { STATUS_LABEL, canSubmit, checkCode, cleanCode, sideLine, type CpUser } from '../../shared/counterparty';
import { TX_EST, isFresh, validUntil, verdict, type CheckView } from '../../shared/cpCheck';
import { dm, dt, esc, money, txW } from '../../shared/cpFormat';
import type { CpApi, Navigate, NavTarget } from './types';
import { budgetChip, chips, closeBtn, errText, makeToast, spinRows, vpill, ycBox } from './ui';
import type { BudgetInfo } from '../../shared/cpCheck';

export interface CheckOptions {
  api: CpApi;
  navigate?: Navigate;
  initial?: NavTarget;
  /** Лише макет: підказки кодів. */
  suggestCodes?: Array<[string, string]>;
  pollMs?: number;
  now?: () => Date;
}
export interface CheckHandle { refresh(): Promise<void>; open(t: NavTarget): void; destroy(): void }

let seq = 0;

export function mountCounterpartyCheck(root: HTMLElement, o: CheckOptions): CheckHandle {
  const P = `cpc${++seq}-`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(P + id) as T | null;
  const now = o.now || (() => new Date());
  const toast = makeToast(() => $('toast'));
  let me: CpUser | null = null, checks: CheckView[] = [], budget: BudgetInfo | null = null, loadErr = '', err = '';
  let open: CheckView | null = null, justNow = new Set<string>(), busy = false, alive = true;
  let pollT: ReturnType<typeof setTimeout> | undefined;
  let pending: NavTarget | null = o.initial || null;

  root.innerHTML = `<div class="cpx">
  <div class="cp-cq">
    <section class="cp-card" aria-label="Перевірка контрагента">
      <div class="cp-chkhead">
        <form id="${P}form" class="cp-chkf" autocomplete="off">
          <input class="cp-in cp-mono" id="${P}code" inputmode="numeric"${o.suggestCodes ? ` list="${P}codes"` : ''} placeholder="ЄДРПОУ або ІПН ФОП" aria-label="ЄДРПОУ або ІПН ФОП контрагента">
          <button type="submit" class="cp-btn cp-pri" id="${P}go">Перевірити в YouControl</button>
        </form>
        <div class="cp-err" id="${P}err" role="alert" hidden></div>
        <div class="cp-hint">Клієнт чи перевізник — будь-який український контрагент. Нова перевірка того самого коду — раз на 2 місяці, до того всі бачать збережену. Нерезидентів YouControl не перевіряє.</div>
      </div>
      <div class="cp-bar"><span class="cp-lbl" id="${P}title">Мої перевірки</span><span class="cp-grow"></span><span id="${P}bud"></span></div>
      <div class="cp-tblwrap"><table class="cp-reg">
        <thead><tr><th>Контрагент</th><th>Результат</th><th>Перевірено</th><th>Нова перевірка</th></tr></thead>
        <tbody id="${P}rows"></tbody>
      </table></div>
    </section>
  </div>
  <div class="cp-scrim" id="${P}scrim" hidden></div>
  <aside class="cp-drawer" id="${P}drawer" role="dialog" aria-modal="true" aria-labelledby="${P}dTitle" hidden></aside>
  <div class="cp-toast" id="${P}toast" role="status" aria-live="polite" hidden></div>
  ${o.suggestCodes ? `<datalist id="${P}codes">${o.suggestCodes.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</datalist>` : ''}
</div>`;

  /** Стан збереженої перевірки: є новіша / свіжа (до …) / застаріла. */
  const stateOf = (c: CheckView): 'old' | 'fresh' | 'expired' => (c.ctx.latest && c.ctx.latest.id !== c.id ? 'old' : isFresh(c.at, now()) ? 'fresh' : 'expired');

  function render() {
    if (!alive) return;
    const rows = $('rows')!;
    $('err')!.textContent = err; $('err')!.hidden = !err;
    if (!me) { rows.innerHTML = `<tr><td colspan="4" class="cp-empty">${loadErr ? esc(loadErr) : 'Завантаження…'}</td></tr>`; return; }
    const all = me.role === 'approver';
    $('title')!.textContent = all ? 'Усі перевірки' : 'Мої перевірки';
    $('bud')!.innerHTML = all ? budgetChip(budget) : '';
    const list = checks.filter(c => c.status === 'done' && c.subj);
    rows.innerHTML = list.map(c => {
      const s = c.subj!, st = stateOf(c);
      const next = st === 'old' ? '<span class="cp-when">є новіша</span>' : st === 'fresh' ? `<span class="cp-when">з ${dt(validUntil(c.at))}</span>` : '<span class="cp-ck cp-ok">можна зараз</span>';
      return `<tr data-cid="${esc(c.id)}" tabindex="0" class="${open && open.id === c.id ? 'cp-sel' : ''}" aria-label="${esc(s.name)}">
        <td class="cp-c-cl"><div class="cp-who">${esc(s.name)}</div><div class="cp-sub"><span class="cp-code">${esc(s.code)}</span> · ${esc(s.kind)}${c.src === 'req' ? ' · з форми запиту' : ''}</div></td>
        <td class="cp-c-ck"><div class="cp-chks">${chips(s, now())}</div></td>
        <td class="cp-c-mg">${all ? `<div class="cp-mgr">${esc(c.byName || '')}</div>` : ''}<div class="cp-when">${dm(c.at)}</div></td>
        <td class="cp-c-st">${next}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="cp-empty">Ви ще нікого не перевіряли. Введіть код угорі.</td></tr>';
  }

  // ---------- панель ----------
  function showPanel(c: CheckView) {
    open = c;
    $('scrim')!.hidden = false; $('drawer')!.hidden = false;
    renderPanel(); render();
    $('drawer')!.querySelector<HTMLElement>('[data-close]')?.focus();
  }
  function closePanel() { open = null; $('scrim')!.hidden = true; $('drawer')!.hidden = true; render(); schedulePoll(); }
  function renderPanel() {
    if (!alive || !open) return;
    const D = $('drawer')!, c = open;
    if (c.status === 'running' || !c.subj) {
      const b = c.base;
      D.innerHTML = `<div class="cp-dh"><h2 id="${P}dTitle">Перевіряємо${b ? ': ' + esc(b.name) : ` ${esc(c.code)}`}</h2>${closeBtn}</div>
        <div class="cp-db"><div class="cp-box"><div class="cp-lbl">YouControl</div>${spinRows(b && b.fop ? ['ЄДР', 'Виконавчі провадження', 'Експрес-аналіз'] : ['ЄДР', 'Суди', 'Виконавчі провадження', 'Експрес-аналіз', 'Власники й капітал'], b ? 'готово' : undefined)}
        <div class="cp-hint">YouControl іноді оновлює дані до кількох хвилин — вікно можна закрити, перевірка збережеться.</div></div></div>`;
      return;
    }
    const s = c.subj, st = stateOf(c), u = me!;
    const stNote = st === 'old' ? `<div class="cp-note cp-mutn"><b>Є новіша перевірка</b> — від ${dt(c.ctx.latest!.at)}, ${esc(c.ctx.latest!.byName || 'система')}.</div>`
      : st === 'expired' ? `<div class="cp-note cp-warnn"><b>Перевірка застаріла</b> — від ${dt(c.at)}. Можна перевірити заново.</div>`
      : justNow.has(c.id) && c.by === u.id ? `<div class="cp-note cp-okn"><b>Перевірено щойно.</b> Збережено до ${dt(validUntil(c.at))} — до того всі бачитимуть цю перевірку без нових витрат.</div>`
      : `<div class="cp-note cp-mutn"><b>Збережена перевірка</b> від ${dt(c.at)} — ${esc(c.byName || 'система')}. Нова — не раніше ${dt(validUntil(c.at))}.</div>`;
    const r = c.ctx.req;
    const reqNote = !r ? '' : r.visible
      ? `<div class="cp-note cp-mutn"><b>Є запит на погодження:</b> ${STATUS_LABEL[r.status].toLowerCase()}${r.status === 'approved' && r.okLine ? ' — ' + esc(r.okLine) + (r.okLimit ? ', ліміт ' + money(r.okLimit) : '') : ''} · ${esc(r.byName)}. <button type="button" class="cp-lnk" data-act="open-req" data-rid="${esc(r.id)}">Відкрити запит</button></div>`
      : `<div class="cp-note cp-mutn"><b>Є запит на погодження</b> — ${STATUS_LABEL[r.status].toLowerCase()}, ${esc(r.byName)}.</div>`;
    const l = c.ctx.limit;
    const limNote = l ? `<div class="cp-note cp-mutn"><b>Діючий клієнт:</b> ліміт ${l.limit !== null ? money(l.limit) : '—'}${l.days !== null ? ', ' + esc(sideLine({ days: l.days, from: l.from })) : ''} — ${l.src === 'debt' ? 'перенесено з дебіторки' : 'задав Сергій'}.</div>` : '';
    const url = c.pdf ? o.api.pdfUrl(c.id) : null;
    const pdf = c.pdf
      ? (url ? `<a class="cp-file cp-fyc" href="${esc(url)}" target="_blank" rel="noopener"><span aria-hidden="true">📄</span><span class="cp-fn">Досьє YouControl — ${esc(c.code)}.pdf</span><span class="cp-fs">${dt(c.at)}</span></a>`
        : `<span class="cp-file cp-fyc"><span aria-hidden="true">📄</span><span class="cp-fn">Досьє YouControl — ${esc(c.code)}.pdf</span><span class="cp-fs">${dt(c.at)}</span></span>`)
      : `<button type="button" class="cp-btn cp-sm" data-act="pdf"${busy ? ' disabled' : ''}>Завантажити PDF-досьє · ${txW(TX_EST.pdf)}</button>`;
    D.innerHTML = `
      <div class="cp-dh"><h2 id="${P}dTitle">${esc(s.name)} ${vpill(verdict(s, now()))}</h2>${closeBtn}</div>
      <div class="cp-db">
        <div><div class="cp-src"><span class="cp-code">${esc(s.code)}</span> · ${esc(s.kind)}${s.addr ? ' · ' + esc(s.addr) : ''}</div>${s.head ? `<div class="cp-src">Керівник: ${esc(s.head)}</div>` : ''}</div>
        ${stNote}
        ${reqNote}
        ${limNote}
        ${ycBox(s, { who: 'контрагент', byName: c.byName, now: now() })}
        <div><div class="cp-lbl" style="margin-bottom:6px">PDF-досьє</div><div class="cp-files">${pdf}</div></div>
      </div>
      ${actions(c, st)}`;
  }
  function actions(c: CheckView, st: 'old' | 'fresh' | 'expired') {
    const u = me!, b: string[] = [], r = c.ctx.req;
    const active = !!r && ['approved', 'pending', 'checking', 'returned'].includes(r.status);
    const apply = canSubmit(u.role) && !active && st !== 'old';
    if (apply) b.push(`<button type="button" class="cp-btn cp-pri" data-act="apply">${c.ctx.limit ? 'Подати запит на нові умови' : 'Подати на погодження як нового клієнта'}</button>`);
    const k = c.subj!.fop ? TX_EST.fop : TX_EST.repeat;          // повторна перевірка — без «історії змін»
    if (st === 'expired') b.push(`<button type="button" class="cp-btn" data-act="recheck"${busy ? ' disabled' : ''}>Перевірити заново · ≈ ${txW(k)}</button>`);
    else if (st === 'fresh' && u.role === 'approver') b.push(`<button type="button" class="cp-btn" data-act="recheck"${busy ? ' disabled' : ''}>Перевірити заново зараз · ≈ ${txW(k)}</button>`);
    if (!b.length) return '';
    return `<div class="cp-df"><div class="cp-acts">${b.join('')}</div>${apply ? '<div class="cp-hint">Подавайте, лише якщо клієнт хоче відтермінування оплати.</div>' : ''}</div>`;
  }

  // ---------- дії ----------
  async function lookup(raw: string, force = false) {
    const code = cleanCode(raw);
    err = checkCode(code) || '';
    if (err) { err = 'Введіть ЄДРПОУ (8 цифр) або ІПН ФОП (10 цифр). Нерезидентів YouControl не перевіряє.'; render(); return; }
    if (busy) return;
    busy = true; render();
    try {
      const { check, saved } = await o.api.startCheck(code, force);
      busy = false;
      if (check.status === 'failed') { err = check.error || 'Перевірка не вдалася — спробуйте ще раз.'; render(); return; }
      upsert(check);
      if (saved) { showPanel(check); toast.show(`Збережена перевірка від ${dt(check.at)} — нова не раніше ${dt(validUntil(check.at))}`); }
      else { showPanel(check); schedulePoll(); }
    } catch (e) { busy = false; err = errText(e); render(); }
  }
  const upsert = (c: CheckView) => { const i = checks.findIndex(x => x.id === c.id); if (i >= 0) checks[i] = c; else checks.unshift(c); };
  async function onAct(a: string, el: HTMLElement) {
    const c = open; if (!c || busy) return;
    if (a === 'open-req') { o.navigate?.({ tab: 'new', requestId: el.dataset.rid! }); return; }
    if (a === 'apply') { closePanel(); o.navigate?.({ tab: 'new', newCode: c.code }); return; }
    if (a === 'recheck') { closePanel(); ($('code') as HTMLInputElement).value = c.code; await lookup(c.code, me!.role === 'approver'); return; }
    if (a === 'pdf') {
      busy = true; renderPanel();
      try { const n = await o.api.pdf(c.id); busy = false; upsert(n); if (open && open.id === n.id) open = n; renderPanel(); toast.show(me!.role === 'approver' ? `PDF-досьє збережено — ${txW(TX_EST.pdf)}` : 'PDF-досьє збережено'); }
      catch (e) { busy = false; renderPanel(); toast.show(errText(e)); }
    }
  }

  // ---------- події ----------
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest(`#${P}scrim`)) { closePanel(); return; }
    const tr = t.closest<HTMLElement>('tr[data-cid]');
    if (tr && $('rows')!.contains(tr)) { const c = checks.find(x => x.id === tr.dataset.cid); if (c) void openFull(c); return; }
    const D = $('drawer')!;
    if (!D.contains(t)) return;
    if (t.closest('[data-close]')) { closePanel(); return; }
    const b = t.closest<HTMLElement>('[data-act]');
    if (b && !(b as HTMLButtonElement).disabled) void onAct(b.dataset.act!, b);
  };
  /** Рядок списку → панель з повним контекстом (є запит? діючий ліміт?). */
  async function openFull(c: CheckView) {
    showPanel(c);
    try { const f = await o.api.getCheck(c.id); if (open && open.id === c.id) { open = f; upsert(f); renderPanel(); } } catch { /* лишаємо як є */ }
  }
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-cid]');
    if (tr && $('rows')!.contains(tr)) { const c = checks.find(x => x.id === tr.dataset.cid); if (c) void openFull(c); }
  };
  const onSubmit = (e: Event) => {
    if ((e.target as HTMLElement).id !== P + 'form') return;
    e.preventDefault();
    void lookup(($('code') as HTMLInputElement).value);
  };
  const onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) closePanel(); };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onDocKey);

  function schedulePoll() {
    clearTimeout(pollT);
    if (!alive || !open || open.status !== 'running') return;
    const id = open.id;
    pollT = setTimeout(async () => {
      if (!alive || !open || open.id !== id) return;
      try {
        const c = await o.api.getCheck(id);
        if (!open || open.id !== id) return;
        if (c.status === 'failed') { closePanel(); err = c.error || 'Перевірка не вдалася — спробуйте ще раз.'; checks = checks.filter(x => x.id !== id); render(); return; }
        open = c; upsert(c);
        if (c.status === 'done') {
          justNow.add(c.id);
          toast.show(me!.role === 'approver' ? `Перевірено — списано ${txW(c.tx)}` : `Перевірено — збережено до ${dt(validUntil(c.at))}`);
          void refresh();
        }
        renderPanel(); render();
      } catch { /* наступна спроба */ }
      schedulePoll();
    }, o.pollMs ?? 2000);
  }
  async function refresh() {
    try {
      const j = await o.api.listChecks();
      if (!alive) return;
      const changed = !!me && (me.id !== j.me.id || me.role !== j.me.role);
      me = j.me; checks = j.checks; budget = j.budget || null; loadErr = '';
      if (changed) { err = ''; if (open) closePanel(); }
    } catch (e) { if (alive) loadErr = 'Не вдалося завантажити перевірки. ' + errText(e); }
    render();
    if (pending && me) { const t = pending; pending = null; doOpen(t); }
  }
  function doOpen(t: NavTarget) {
    if (t.tab !== 'check') return;
    if (!me) { pending = t; return; }
    if (t.checkId) {                                              // відкрити збережену перевірку (з «Лімітів клієнтів») — без нових витрат
      const id = t.checkId;
      void o.api.getCheck(id).then(c => { if (alive) { upsert(c); showPanel(c); } }).catch(e => { err = errText(e); render(); });
    } else if (t.code) { ($('code') as HTMLInputElement).value = t.code; void lookup(t.code); }
    else ($('code') as HTMLInputElement | null)?.focus();
  }

  render();
  void refresh();
  return {
    refresh,
    open: doOpen,
    destroy() {
      alive = false; toast.stop(); clearTimeout(pollT);
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('submit', onSubmit);
      document.removeEventListener('keydown', onDocKey);
      root.innerHTML = '';
    },
  };
}
