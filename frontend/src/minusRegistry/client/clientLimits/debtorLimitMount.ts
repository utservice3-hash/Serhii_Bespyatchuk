/**
 * «Активна дебіторка» → колонка «Ліміти» (рішення Сергія 22–23.10). Той самий код — у макеті (вкладка «Активна дебіторка»).
 *   const h = mountDebtorLimitCell(td, { debtor: { key, name }, cell: cells[key], canEdit, api: clientLimitsApi, onSaved, navigate });
 *   h.update({ cell, canEdit }); h.destroy();
 * React — ./DebtorLimitCell.tsx; дані — useDebtorLimits() (GET /api/client-limits/by-debtor).
 *
 * Дві строки, як зараз у дашборді: «дні — 30 дн. від рахунку», «сума — 300 000 ₴ у межах / переліміт» (або «не узгоджено»),
 * але з «Лімітів клієнтів» — ліміт не зникає, коли клієнт закрив усі рахунки.
 *   Олівці «Змінити узгоджену відстрочку» / «Змінити ліміт суми» — лише Сергію (canEdit). Зміна — з причиною, в історію ліміту.
 *   Боржнику без ліміту олівець задає ліміт (POST /set). Іншим — «Запросити зміну» / «Запросити ліміт» (свій клієнт, cell.canRequest) → «Ліміти клієнтів».
 *   Ліміт призупинено (нова справа в суді) — позначка, клік → «Ліміти клієнтів».
 */
import { debtorCell, type DebtorLimitCell, type LimitRow } from '../../shared/clientLimits';
import { FROM_LABEL, FROM_SHORT, type From } from '../../shared/counterparty';
import { esc, nf } from '../../shared/cpFormat';
import type { LimitsApi, Navigate } from '../counterparty/types';
import { closeBtn, errText, opts } from '../counterparty/ui';

export interface DebtorLimitCellOptions {
  /** key — ключ боржника у вашій дебіторці (як у DebtSource), name — для заголовка діалогу. */
  debtor: { key: string; name: string };
  /** cells[key] з /by-debtor; немає — «не узгоджено». */
  cell: DebtorLimitCell | null | undefined;
  /** Олівці — лише Сергій (canEdit з /by-debtor). */
  canEdit: boolean;
  api: Pick<LimitsApi, 'edit' | 'set'>;
  /** Після збереження — оновіть плитки й рядок (reload() з useDebtorLimits). msg — що сказати користувачу. */
  onSaved?: (row: LimitRow, msg: string) => void;
  /** «Запросити зміну», «призупинено» → «Ліміти клієнтів» (інша вкладка). */
  navigate?: Navigate;
  /** Шрифт і колір — як у вашій таблиці (за замовчуванням так). */
  inherit?: boolean;
}
export interface DebtorLimitCellHandle {
  update(p: Partial<Pick<DebtorLimitCellOptions, 'cell' | 'canEdit' | 'debtor'>>): void;
  destroy(): void;
}

const PEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M10.7 2.8 13.2 5.3 5.7 12.8 2.7 13.3 3.2 10.3Z"/><path d="m9.4 4.1 2.5 2.5"/></svg>';
let seq = 0;

/** Вміст комірки (без обгортки). Окремо — для тестів і для тих, хто малює таблицю рядками. */
export function limitCellHtml(c: DebtorLimitCell | null | undefined, canEdit: boolean): string {
  const none = !c || c.status === 'none';
  const no = '<span class="cp-lcn">не узгоджено</span>';
  const days = !none && c!.days !== null ? `<b>${c!.days} дн.</b> <i>${FROM_SHORT[(c!.from || 'od') as From]}</i>` : no;
  const sum = !none && c!.limit !== null
    ? `<b class="cp-num">${nf(c!.limit)} ₴</b> <i${c!.status === 'over' ? ' class="cp-lco"' : ''}>${c!.status === 'over' ? 'переліміт' : 'у межах'}</i>` : no;
  const pen = (k: 'days' | 'sum', t: string) => (canEdit ? `<button type="button" class="cp-pen" data-lc="${k}" aria-label="${t}" title="${t}">${PEN}</button>` : '');
  const susp = !none && c!.suspended ? '<button type="button" class="cp-lcs" data-lc="open" title="Нова справа в суді — рішення за Сергієм у «Лімітах клієнтів»">призупинено — нова справа</button>' : '';
  const ask = !canEdit && c?.canRequest ? `<button type="button" class="cp-lnk cp-lcq" data-lc="ask">${none ? 'Запросити ліміт' : 'Запросити зміну'}</button>` : '';
  return `<div class="cp-lc${canEdit ? ' cp-lce' : ''}">`
    + `<div class="cp-lcr"><span class="cp-lck">дні</span><span class="cp-lcv">${days}</span>${pen('days', none ? 'Задати ліміт' : 'Змінити узгоджену відстрочку')}</div>`
    + `<div class="cp-lcr"><span class="cp-lck">сума</span><span class="cp-lcv">${sum}</span>${pen('sum', none ? 'Задати ліміт' : 'Змінити ліміт суми')}</div>`
    + `${susp}${ask}</div>`;
}

export function mountDebtorLimitCell(el: HTMLElement, o: DebtorLimitCellOptions): DebtorLimitCellHandle {
  const cur = { cell: o.cell ?? null, canEdit: o.canEdit, debtor: { ...o.debtor } };
  let dlg: HTMLElement | null = null, opener: 'days' | 'sum' | null = null, busy = false, alive = true, dirty = false;

  function render() {
    if (!alive) return;
    el.innerHTML = `<div class="cpx${o.inherit === false ? '' : ' cp-inh'}">${limitCellHtml(cur.cell, cur.canEdit)}</div>`;
  }
  const isNone = () => !cur.cell || cur.cell.status === 'none';

  // ---------- діалог олівця ----------
  function close(refocus = true) {
    if (!dlg) return;
    dlg.remove(); dlg = null; busy = false;
    document.removeEventListener('keydown', onDocKey, true);
    if (dirty) { dirty = false; render(); }
    if (refocus && opener) el.querySelector<HTMLElement>(`[data-lc="${opener}"]`)?.focus();
    opener = null;
  }
  function openEditor(kind: 'days' | 'sum') {
    close(false);
    const c = cur.cell, none = isNone();
    const P = `cplc${++seq}-`;
    const title = none ? 'Задати ліміт' : kind === 'days' ? 'Змінити узгоджену відстрочку' : 'Змінити ліміт суми';
    const w = document.createElement('div');
    w.className = 'cpx cp-lcm';
    w.innerHTML = `<div class="cp-scrim" data-lc="cancel"></div>
  <div class="cp-dlg" role="dialog" aria-modal="true" aria-labelledby="${P}t">
    <div class="cp-dh"><h2 id="${P}t">${title}</h2>${closeBtn}</div>
    <div class="cp-db">
      <div class="cp-src"><b>${esc(cur.debtor.name)}</b>${none ? ' · ліміт не узгоджено' : ` · зараз ${c!.limit !== null ? nf(c!.limit) + ' ₴' : 'суму не погоджено'}, ${c!.days !== null ? `${c!.days} дн. ${FROM_SHORT[(c!.from || 'od') as From]}` : 'дні не погоджено'}`}</div>
      <div class="cp-grid2">
        <label class="cp-f"><span>Ліміт боргу, грн <em>*</em></span><input class="cp-in cp-mono" data-f="limit" inputmode="numeric" autocomplete="off" value="${!none && c!.limit !== null ? c!.limit : ''}" placeholder="напр. 200000"></label>
        <label class="cp-f"><span>Днів відтермінування <em>*</em></span><input class="cp-in cp-mono" data-f="days" inputmode="numeric" autocomplete="off" value="${!none && c!.days !== null ? c!.days : ''}" placeholder="напр. 14"></label>
      </div>
      <label class="cp-f">Від чого рахувати<select class="cp-in" data-f="from">${opts(FROM_LABEL, (!none && c!.from) || 'orig')}</select></label>
      <label class="cp-f"><span>Причина <em>*</em></span><textarea class="cp-in" data-f="why" rows="2" maxlength="2000" placeholder="напр. платить вчасно, обсяги зросли"></textarea></label>
      <div class="cp-err" role="alert" hidden></div>
    </div>
    <div class="cp-df"><div class="cp-acts"><button type="button" class="cp-btn cp-okb" data-lc="save" disabled>${none ? 'Задати ліміт' : 'Зберегти'}</button><button type="button" class="cp-btn" data-lc="cancel">Скасувати</button></div>
      <div class="cp-hint">${none ? 'Ліміт зʼявиться в «Лімітах клієнтів» і тут, у колонці «Ліміти».' : 'Зміна з причиною запишеться в історію ліміту в «Лімітах клієнтів».'}</div></div>
  </div>`;
    document.body.appendChild(w);
    dlg = w; opener = kind;
    w.addEventListener('click', onDlgClick);
    w.addEventListener('input', onDlgInput);
    document.addEventListener('keydown', onDocKey, true);
    const f = w.querySelector<HTMLInputElement>(`[data-f="${none || kind === 'sum' ? 'limit' : 'days'}"]`);
    f?.focus(); f?.select();
  }
  const field = (k: string) => dlg!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-f="${k}"]`)!;
  async function save() {
    if (!dlg || busy) return;
    const v = { limit: field('limit').value, days: field('days').value, from: field('from').value as From, reason: field('why').value.trim() };
    if (!v.reason) return;
    const none = isNone(), id = cur.cell?.limitId;
    const btn = dlg.querySelector<HTMLButtonElement>('[data-lc="save"]')!, err = dlg.querySelector<HTMLElement>('.cp-err')!;
    busy = true; btn.disabled = true; err.hidden = true;
    try {
      const row = none || !id ? await o.api.set(cur.debtor.key, v) : await o.api.edit(id, v);
      if (!alive) return;
      cur.cell = { ...debtorCell(row), canRequest: cur.cell?.canRequest };
      render(); close();
      o.onSaved?.(row, none ? 'Ліміт задано — він уже в «Лімітах клієнтів»' : 'Ліміт змінено — записано в історію «Лімітів клієнтів»');
    } catch (e) {
      if (!dlg) return;
      busy = false; btn.disabled = false;
      err.textContent = errText(e); err.hidden = false;
    }
  }
  function onDlgClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) { close(); return; }
    const b = t.closest<HTMLElement>('[data-lc]');
    if (!b || (b as HTMLButtonElement).disabled) return;
    if (b.dataset.lc === 'cancel') close();
    else if (b.dataset.lc === 'save') void save();
  }
  function onDlgInput(e: Event) {
    const t = e.target as HTMLElement;
    if (t.dataset.f === 'why' && !busy) dlg!.querySelector<HTMLButtonElement>('[data-lc="save"]')!.disabled = !(t as HTMLTextAreaElement).value.trim();
  }
  function onDocKey(e: KeyboardEvent) {
    if (!dlg) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    // фокус лишається в діалозі
    const f = [...dlg.querySelectorAll<HTMLElement>('.cp-dlg button:not([disabled]), .cp-dlg input, .cp-dlg select, .cp-dlg textarea')];
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }

  // ---------- комірка ----------
  function onClick(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-lc]');
    if (!b || !el.contains(b)) return;
    e.stopPropagation();   // рядок таблиці не розгортається
    const k = b.dataset.lc;
    if ((k === 'days' || k === 'sum') && cur.canEdit) { openEditor(k); return; }
    if (k === 'open' && cur.cell?.limitId) { o.navigate?.({ tab: 'limits', limitId: cur.cell.limitId }); return; }
    if (k === 'ask') o.navigate?.({ tab: 'limits', limitId: cur.cell?.limitId || 'D-' + cur.debtor.key });
  }
  el.addEventListener('click', onClick);
  render();

  return {
    update(p) {
      if ('cell' in p) cur.cell = p.cell ?? null;
      if (p.canEdit !== undefined) cur.canEdit = p.canEdit;
      if (p.debtor) cur.debtor = { ...p.debtor };
      if (dlg) dirty = true; else render();
    },
    destroy() {
      alive = false; close(false);
      el.removeEventListener('click', onClick);
      el.innerHTML = '';
    },
  };
}
