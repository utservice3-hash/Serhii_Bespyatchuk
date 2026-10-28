/**
 * Рядок «№ рахунку» під надходженням (ФОП Моно / Приват, картка Ступаківського) — той самий код, що в макеті.
 *   const h = mountIdentLine(el, { state, api: bankIdentApi, clock, holidays, onChange });
 *   h.update({ state }); h.destroy();
 * React — ./IdentLine.tsx; стани — useBankIdent(rows) (POST /api/bank-ident/state).
 *
 * Стани (рішення Сергія 27.10):
 *   чекає №          — поле + «Зберегти» → «Зафіксувати № …? Змінити потім зможе лише фінансист» → номер, хто й коли;
 *                      строк «⏱ до вт 27.10, 15:00 · ще 1 год 30 хв» (бурштиновий, коли < 12 роб. год);
 *   з номером        — «✓ № …», хто й коли; фінансисту — «Змінити» і «Визнати неідентифікованим» (з причиною);
 *   неідентифікований — строк минув або визнав фінансист; дій немає ні в кого;
 *   свій переказ / не оплата клієнта — номер не потрібен; бухгалтер позначає «не оплата клієнта», поки строк не минув.
 * Інтерфейс показує лише дозволене (state.can); сервер перевіряє все сам.
 */
import {
  MSG, NC_REASONS, SOON_MS, checkInvoiceNo, checkNotClient, checkReason, normNo, normText, roleLabel,
  type IdentEvent, type IdentState, type NcReason,
} from '../../shared/bankIdent';
import { workBetween } from '../../shared/identDeadline';
import { esc, fDT, fDue, fDueAt, fLeft, fWDT } from './format';
import { BankIdentError, type BankIdentApi, type Clock } from './types';

type Open = null | 'confirm' | 'fix' | 'unid' | 'nc' | 'hist' | 'reset'; // reset — [дашборд 28.10]
export interface IdentLineUi {
  open: Open;
  no: string; fixNo: string; fixWhy: string; unidWhy: string; ncReason: NcReason; ncNote: string; resetWhy: string;
  err: string; info: string; busy: boolean;
  hist: IdentEvent[] | null; histErr: string;
}
export const newIdentUi = (): IdentLineUi => ({
  open: null, no: '', fixNo: '', fixWhy: '', unidWhy: '', ncReason: NC_REASONS[0], ncNote: '', resetWhy: '',
  err: '', info: '', busy: false, hist: null, histErr: '',
});

const left = (s: IdentState, now: number, hol?: ReadonlySet<string>) => (s.deadlineAt ? workBetween(now, Date.parse(s.deadlineAt), hol) : 0);
export const isSoon = (s: IdentState, now: number, hol?: ReadonlySet<string>) => s.status === 'wait' && left(s, now, hol) <= SOON_MS;

export function dueHtml(s: IdentState, now: number, hol?: ReadonlySet<string>): string {
  if (s.status !== 'wait' || !s.deadlineAt) return '';
  return `<span class="bi-due${isSoon(s, now, hol) ? ' bi-soon' : ''}" title="Рахуються лише будні: субота й неділя — ні">⏱ до <b>${fDue(s.deadlineAt)}</b> · ${fLeft(left(s, now, hol))}</span>`;
}

const B = (act: string, label: string, cls = '', ui?: IdentLineUi, extra = '') =>
  `<button type="button" class="bi-btn${cls ? ' ' + cls : ''}" data-bi="${act}"${ui && ui.busy ? ' disabled' : ''}${extra}>${label}</button>`;
const who = (p: { name: string; role: string } | null) => (p ? `<b>${esc(p.name)}</b>${p.role ? ' · ' + esc(roleLabel(p.role)) : ''}` : 'Система');

export function histLineHtml(e: IdentEvent): string {
  const no = (v: string | null) => `<span class="bi-no">${esc(v)}</span>`;
  switch (e.act) {
    case 'set': return `${who(e.by)} — зафіксовано № ${no(e.toNo)}`;
    case 'change': return `${who(e.by)} — змінено № ${no(e.fromNo)} → ${no(e.toNo)} · «${esc(e.reason)}»`;
    case 'unidentify': return `${who(e.by)} — визнано неідентифікованим (був № ${no(e.fromNo)}) · «${esc(e.reason)}»`;
    case 'not_client': return `${who(e.by)} — позначено «не оплата клієнта»: ${esc(e.reason)}${e.note ? ' — ' + esc(e.note) : ''}`;
    case 'expired': return '<span class="bi-sys">Строк минув — номер не вписано. Неідентифікований остаточно.</span>';
    // [дашборд 28.10] скидання вписаного номера (погодив Сергій)
    case 'reset': return `${who(e.by)} — скинуто № ${no(e.fromNo)}, платіж знову чекає номер · «${esc(e.reason)}»`;
    default: return '';
  }
}

function histLink(s: IdentState, ui: IdentLineUi) {
  return s.events ? `<button type="button" class="bi-lnk" data-bi="hist" aria-expanded="${ui.open === 'hist'}">Історія${s.events > 1 ? ` (${s.events})` : ''}</button>` : '';
}
const errHtml = (t: string) => (t ? `<span class="bi-err" role="alert">${esc(t)}</span>` : '');
const infoHtml = (t: string) => (t ? `<span class="bi-info" role="status">${esc(t)}</span>` : '');

/** Увесь вміст (рядок + розгорнутий блок). Окремо від mount — для тестів і серверного рендеру. */
export function identLineHtml(s: IdentState, ui: IdentLineUi, now: number, hol?: ReadonlySet<string>): string {
  let h = '';
  const by = s.by ? `${esc(s.by.name)}, ${fDT(s.at!)}` : '';
  switch (s.status) {
    case 'own':
      h = '<span class="bi-pill bi-mut">↔ Свій переказ</span><span class="bi-by">між рахунками компанії — № не потрібен</span>';
      break;
    case 'not_client':
      h = `<span class="bi-pill bi-mut">Не оплата клієнта</span><span class="bi-by">${esc(s.reason)}${s.note ? ' — ' + esc(s.note) : ''}${by ? ' · ' + by : ''}</span>${histLink(s, ui)}`;
      break;
    case 'identified':
      h = `<span class="bi-pill bi-ok" title="Номер зафіксовано. Змінити може лише фінансист.">✓ № <span class="bi-no">${esc(s.invoiceNo)}</span></span>`
        + `<span class="bi-by">${by}${s.changed ? ' · змінено' : ''}</span>${histLink(s, ui)}`;
      if ((s.can.fix || s.can.reset) && ui.open !== 'fix' && ui.open !== 'unid' && ui.open !== 'reset') {
        h += `<span class="bi-acts">${s.can.fix ? B('fix', '✎ Змінити', '', ui) : ''}${s.can.reset ? B('reset', '↺ Скинути №', '', ui) : ''}${s.can.fix ? B('unid', 'Визнати неідентифікованим', 'bi-warn', ui) : ''}</span>`;
      }
      break;
    case 'unidentified':
      h = `<span class="bi-pill bi-bad">Неідентифікований</span><span class="bi-by">${s.unidKind === 'finance'
        ? `визнано: ${by} · «${esc(s.reason)}»`
        : `строк минув — ${fDueAt(s.deadlineAt!)} · номер уже не вписати`}</span>${histLink(s, ui)}`;
      break;
    case 'wait': {
      const due = dueHtml(s, now, hol);
      if (ui.open === 'confirm') {
        h = `<span class="bi-conf" role="group" aria-label="Підтвердження"><span>Зафіксувати № <span class="bi-no">${esc(normNo(ui.no))}</span>? Змінити потім зможе лише фінансист.</span>`
          + `${B('confirm', ui.busy ? 'Зберігаю…' : 'Так, зафіксувати', 'bi-pri', ui)}${B('cancel', 'Скасувати', 'bi-ghost', ui)}</span>${due}`;
      } else {
        h = s.can.set
          ? `<input class="bi-num${ui.err ? ' bi-bad-b' : ''}" data-bf="no" value="${esc(ui.no)}" placeholder="№ рахунку" aria-label="№ рахунку" maxlength="120" autocomplete="off" inputmode="text">${B('save', 'Зберегти', 'bi-pri', ui)}${due}`
          : `<span class="bi-by">чекає № рахунку від менеджера</span>${due}`;
        if (s.can.nc && ui.open !== 'nc') h += B('nc', 'Не оплата клієнта', '', ui);
      }
      break;
    }
  }
  if (ui.open !== 'fix' && ui.open !== 'unid' && ui.open !== 'nc' && ui.open !== 'reset') h += errHtml(ui.err);
  h += infoHtml(ui.info);

  let box = '';
  if (ui.open === 'hist') box = histBox(ui);
  else if (ui.open === 'fix' && s.status === 'identified') box = fixBox(s, ui);
  else if (ui.open === 'unid' && s.status === 'identified') box = unidBox(s, ui);
  else if (ui.open === 'reset' && s.status === 'identified') box = resetBox(s, ui);
  else if (ui.open === 'nc' && s.status === 'wait') box = ncBox(ui);
  return `<div class="bi-line">${h}</div>${box}`;
}

function histBox(ui: IdentLineUi): string {
  const body = ui.histErr ? errHtml(ui.histErr) : !ui.hist ? '<span class="bi-by">Завантаження…</span>'
    : `<ol class="bi-hist">${ui.hist.map(e => `<li><span>${fWDT(e.at)}</span><span>${histLineHtml(e)}</span></li>`).join('')}</ol>`;
  return `<div class="bi-box"><div class="bi-fh">Історія <span class="bi-by">— бачать усі, хто бачить виписку</span></div>${body}`
    + `<div class="bi-frow">${B('cancel', 'Згорнути', 'bi-ghost')}</div></div>`;
}
function fixBox(_s: IdentState, ui: IdentLineUi): string { // [дашборд] `_s`: noUnusedParameters
  return `<div class="bi-box"><div class="bi-fh">Змінити № рахунку <span class="bi-by">— стара й нова версії та причина підуть в історію</span></div>`
    + `<div class="bi-frow"><label>Новий №<input class="bi-num" data-bf="fixNo" value="${esc(ui.fixNo)}" maxlength="120" autocomplete="off"></label>`
    + `<label class="bi-grow">Причина<input class="bi-inp" data-bf="fixWhy" value="${esc(ui.fixWhy)}" placeholder="напр. одруківка: у призначенні 8568" maxlength="300"></label></div>`
    + errHtml(ui.err)
    + `<div class="bi-frow">${B('fix-save', ui.busy ? 'Зберігаю…' : 'Зберегти зміну', 'bi-pri', ui)}${B('cancel', 'Скасувати', 'bi-ghost', ui)}</div></div>`;
}
function unidBox(s: IdentState, ui: IdentLineUi): string {
  return `<div class="bi-box"><div class="bi-fh">Визнати неідентифікованим</div>`
    + `<p>Номер <span class="bi-no">${esc(s.invoiceNo)}</span> зніметься, платіж стане «Неідентифікований» — <b>остаточно</b>: вписати номер потім не зможе ніхто.</p>`
    + `<div class="bi-frow"><label class="bi-grow">Причина<input class="bi-inp" data-bf="unidWhy" value="${esc(ui.unidWhy)}" placeholder="напр. номер вигаданий, клієнта не знайшли" maxlength="300"></label></div>`
    + errHtml(ui.err)
    + `<div class="bi-frow">${B('unid-save', ui.busy ? 'Зберігаю…' : 'Визнати неідентифікованим', 'bi-warn bi-fill', ui)}${B('cancel', 'Скасувати', 'bi-ghost', ui)}</div></div>`;
}
/** [дашборд 28.10] «↺ Скинути №»: номер знімається, платіж знову «Чекає №» — менеджер впише правильний, поки строк не минув. */
function resetBox(s: IdentState, ui: IdentLineUi): string {
  return `<div class="bi-box"><div class="bi-fh">Скинути № рахунку <span class="bi-by">— платіж знову чекатиме номер, в історії лишиться, що номер скидали</span></div>`
    + `<p>Номер <span class="bi-no">${esc(s.invoiceNo)}</span> зніметься, і менеджер зможе вписати правильний до кінця строку.</p>`
    + `<div class="bi-frow"><label class="bi-grow">Причина<input class="bi-inp" data-bf="resetWhy" value="${esc(ui.resetWhy)}" placeholder="напр. менеджер помилилась у номері" maxlength="300"></label></div>`
    + errHtml(ui.err)
    + `<div class="bi-frow">${B('reset-save', ui.busy ? 'Зберігаю…' : 'Скинути №', 'bi-pri', ui)}${B('cancel', 'Скасувати', 'bi-ghost', ui)}</div></div>`;
}
function ncBox(ui: IdentLineUi): string {
  return `<div class="bi-box"><div class="bi-fh">Не оплата клієнта <span class="bi-by">— строк знімається, № не потрібен</span></div>`
    + `<div class="bi-frow"><label>Що це<select class="bi-sel" data-bf="ncReason">${NC_REASONS.map(x => `<option${x === ui.ncReason ? ' selected' : ''}>${x}</option>`).join('')}</select></label>`
    + `<label class="bi-grow">Коментар<input class="bi-inp" data-bf="ncNote" value="${esc(ui.ncNote)}" placeholder="для «Інше» — обовʼязково" maxlength="300"></label></div>`
    + errHtml(ui.err)
    + `<div class="bi-frow">${B('nc-save', ui.busy ? 'Зберігаю…' : 'Позначити', 'bi-pri', ui)}${B('cancel', 'Скасувати', 'bi-ghost', ui)}</div></div>`;
}

/** Строк минув просто на екрані — показуємо «неідентифікований» без запиту (сервер зафіксує сам). */
export const expiredState = (s: IdentState): IdentState => ({ ...s, status: 'unidentified', unidKind: 'expired', at: s.deadlineAt, can: { set: false, fix: false, nc: false } });

export interface IdentLineOptions {
  state: IdentState;
  api: Pick<BankIdentApi, 'set' | 'fix' | 'unidentify' | 'notClient' | 'history' | 'reset'>;
  /** Серверний час (clockFrom(now) з відповіді /state). */
  clock?: Clock;
  /** Свята з відповіді /state (зараз порожньо). */
  holidays?: string[];
  /** Новий стан після дії або коли строк минув — оновіть свій список / лічильник. */
  onChange?: (s: IdentState) => void;
}
export interface IdentLineHandle { update(p: { state?: IdentState }): void; destroy(): void }

export function mountIdentLine(el: HTMLElement, o: IdentLineOptions): IdentLineHandle {
  let s = o.state, alive = true, timer: ReturnType<typeof setInterval> | null = null;
  const ui = newIdentUi();
  const clock = o.clock || Date.now;
  const hol = new Set(o.holidays || []);

  function render(focus?: string) {
    if (!alive) return;
    el.innerHTML = `<div class="bi" data-bi-tx="${s.txId}">${identLineHtml(s, ui, clock(), hol)}</div>`;
    if (focus) {
      const f = el.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-bf="${focus}"]`);
      if (f) { f.focus(); if (f instanceof HTMLInputElement) f.setSelectionRange(f.value.length, f.value.length); }
    }
    if (timer) { clearInterval(timer); timer = null; }
    if (s.status === 'wait') timer = setInterval(tick, 30_000);
  }
  function tick() {
    if (!alive || s.status !== 'wait') return;
    const now = clock();
    if (s.deadlineAt && now >= Date.parse(s.deadlineAt)) { setState(expiredState(s)); return; }
    const due = el.querySelector('.bi-due');
    if (due) due.outerHTML = dueHtml(s, now, hol);
  }
  function setState(next: IdentState, info = '') {
    s = next;
    Object.assign(ui, newIdentUi(), { info });
    render();
    o.onChange?.(s);
  }
  async function run<T extends IdentState>(fn: () => Promise<T>) {
    if (ui.busy) return;
    ui.busy = true; ui.err = ''; ui.info = ''; render();
    try {
      const next = await fn();
      if (alive) setState(next);
    } catch (e) {
      if (!alive) return;
      ui.busy = false;
      if (e instanceof BankIdentError && e.state) setState(e.state, e.message);   // 409: хтось устиг / строк минув — показуємо актуальне
      else { ui.err = e instanceof Error ? e.message : 'Помилка. Спробуйте ще раз.'; render(); }
    }
  }
  async function loadHist() {
    ui.hist = null; ui.histErr = ''; render();
    try { ui.hist = await o.api.history(s.txId); } catch (e) { ui.histErr = e instanceof Error ? e.message : 'Не вдалося завантажити історію.'; }
    if (alive && ui.open === 'hist') render();
  }

  const act: Record<string, () => void> = {
    save() {
      const e = checkInvoiceNo(ui.no);
      if (e) { ui.err = e; ui.info = ''; render('no'); return; }
      ui.err = ''; ui.info = ''; ui.open = 'confirm'; render();
      el.querySelector<HTMLButtonElement>('[data-bi="confirm"]')?.focus();
    },
    // [дашборд] властивість, а не метод `confirm()`: гейт #1510 стереже вікно браузера за формою `confirm(` — тут вбудоване підтвердження
    confirm: () => { void run(() => o.api.set(s.txId, normNo(ui.no))); },
    cancel() { ui.open = null; ui.err = ''; render(); },
    hist() { if (ui.open === 'hist') { ui.open = null; render(); } else { ui.open = 'hist'; void loadHist(); } },
    fix() { ui.open = 'fix'; ui.fixNo = s.invoiceNo || ''; ui.fixWhy = ''; ui.err = ''; ui.info = ''; render('fixNo'); },
    'fix-save'() {
      const no = normNo(ui.fixNo);
      const e = checkInvoiceNo(no) || (no === s.invoiceNo ? MSG.same : '') || checkReason(ui.fixWhy);
      if (e) { ui.err = e; render(); return; }
      void run(() => o.api.fix(s.txId, no, normText(ui.fixWhy), s.invoiceNo || ''));
    },
    unid() { ui.open = 'unid'; ui.unidWhy = ''; ui.err = ''; ui.info = ''; render('unidWhy'); },
    'unid-save'() {
      const e = checkReason(ui.unidWhy);
      if (e) { ui.err = e; render('unidWhy'); return; }
      void run(() => o.api.unidentify(s.txId, normText(ui.unidWhy), s.invoiceNo || ''));
    },
    reset() { ui.open = 'reset'; ui.resetWhy = ''; ui.err = ''; ui.info = ''; render('resetWhy'); },
    'reset-save'() {
      const e = checkReason(ui.resetWhy);
      if (e) { ui.err = e; render('resetWhy'); return; }
      void run(() => o.api.reset(s.txId, normText(ui.resetWhy), s.invoiceNo || ''));
    },
    nc() { ui.open = 'nc'; ui.err = ''; ui.info = ''; render('ncReason'); },
    'nc-save'() {
      const e = checkNotClient(ui.ncReason, ui.ncNote);
      if (e) { ui.err = e; render('ncNote'); return; }
      void run(() => o.api.notClient(s.txId, ui.ncReason, normText(ui.ncNote)));
    },
  };
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bi]');
    if (!b || !el.contains(b) || (b as HTMLButtonElement).disabled) return;
    act[b.dataset.bi!]?.();
  };
  const onInput = (e: Event) => {
    const f = e.target as HTMLInputElement;
    const k = f.dataset && f.dataset.bf;
    if (!k) return;
    (ui as unknown as Record<string, string>)[k] = f.value;
    if (ui.err) {                       // почали виправляти — прибираємо помилку, не перемальовуючи поле
      ui.err = '';
      el.querySelectorAll('.bi-err').forEach(x => x.remove());
      el.querySelectorAll('.bi-bad-b').forEach(x => x.classList.remove('bi-bad-b'));
    }
  };
  const ENTER: Record<string, string> = { no: 'save', fixNo: 'fix-save', fixWhy: 'fix-save', unidWhy: 'unid-save', ncNote: 'nc-save', resetWhy: 'reset-save' };
  const onKey = (e: KeyboardEvent) => {
    const k = (e.target as HTMLElement).dataset?.bf;
    if (e.key === 'Enter' && k && ENTER[k] && !ui.busy) { e.preventDefault(); act[ENTER[k]](); }
    if (e.key === 'Escape' && ui.open && !ui.busy) { e.preventDefault(); act.cancel(); }
  };
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('change', onInput);
  el.addEventListener('keydown', onKey);
  render();

  return {
    update(p) {
      if (!p.state) return;
      const same = p.state.status === s.status && p.state.invoiceNo === s.invoiceNo;
      s = p.state;
      if (!same) Object.assign(ui, newIdentUi());
      render();
    },
    destroy() {
      alive = false;
      if (timer) clearInterval(timer);
      el.removeEventListener('click', onClick);
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onInput);
      el.removeEventListener('keydown', onKey);
      el.innerHTML = '';
    },
  };
}
