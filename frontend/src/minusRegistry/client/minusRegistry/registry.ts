/**
 * Вкладка «Реєстр мінусових угод» (сторінка дашборда «Реєстри»). Без прив'язки до фреймворку:
 *   const h = mountMinusRegistry(el, { api: minusRegistryApi, onCount: n => … });   // h.refresh(), h.destroy()
 * Вигляд і поведінка = затверджений макет v5 (20.10); макет зібрано з цього самого файлу (tools/buildMockup.mjs).
 * Хто дивиться і що може — каже сервер (GET /api/minus-deals → me); інтерфейс лише ховає кнопки.
 */
import {
  ACTION_DONE, EVENT_LABEL, EVENT_TONE, FILTERS, STATUS_LABEL, STATUS_TONE,
  allowedActions, canSee, canSubmit, checkComment, checkDealId, checkNote, defaultFilter, needsMe, seesAll,
  type Action, type CrmDeal, type Line, type RegRequest, type RegUser, type Status,
} from '../../shared/minusRegistry';
import { esc, fmtType, fmtWhen, grn, nf, plural, sgn } from '../../shared/minusFormat';

export interface RegistryApi {
  list(): Promise<{ me: RegUser; requests: RegRequest[] }>;
  /** Угода з CRM для подання. Помилка (не цифри / уже в реєстрі / немає в CRM) — RegistryApiError з текстом для людини. */
  findDeal(dealId: string): Promise<CrmDeal>;
  submit(dealId: string, comment: string): Promise<RegRequest>;
  act(id: string, action: Action, body?: { note?: string; comment?: string; seenBudget?: number }): Promise<RegRequest>;
}

/** Помилка API: message — для людини; request — свіжий стан запиту, якщо сервер його повернув (409). */
export class RegistryApiError extends Error {
  // Поля явно, не `readonly` у параметрах конструктора: фронт дашборда збирається з `erasableSyntaxOnly`.
  readonly status: number;
  readonly request?: RegRequest;
  constructor(message: string, status: number, request?: RegRequest) { super(message); this.name = 'RegistryApiError'; this.status = status; this.request = request; }
}

export interface MinusRegistryOptions {
  api: RegistryApi;
  /** Скільки запитів чекає дії цього користувача — для лічильника в меню й заголовку сторінки. */
  onCount?: (n: number) => void;
  /** Лише макет: підказки ID угод у полі пошуку. */
  suggestIds?: Array<[string, string]>;
}
export interface MinusRegistryHandle { refresh(): Promise<void>; destroy(): void }

type Filter = 'all' | Status;
type Decision = 'return' | 'reject' | 'paid' | null;
interface Draft { id: string; deal: CrmDeal | null; err: string; comment: string }

const NO_CARRIER = '<span class="mr-tbd">з\'явиться після заявки на оплату</span>';
const NO_CARRIER_LONG = '<span class="mr-tbd">з\'явиться, коли менеджер відправить заявку на оплату в CRM</span>';
const FROM_CRM = '<div class="mr-src">Усе з CRM як є: суми, форма оплати, розрахунок, бюджет</div>';
const SEARCH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="m10.5 10.5 3.5 3.5"/></svg>';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let seq = 0;

export function mountMinusRegistry(root: HTMLElement, opts: MinusRegistryOptions): MinusRegistryHandle {
  const P = `mr${++seq}-`;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(P + id) as T | null;

  let me: RegUser | null = null;
  let reqs: RegRequest[] = [];
  let loadErr = '';
  let filter: Filter = 'all', query = '';
  let panel: 'new' | 'detail' | null = null, openId: string | null = null;
  let decision: Decision = null, draft: Draft | null = null, busy = false, alive = true;
  let toastT: ReturnType<typeof setTimeout> | undefined;

  root.innerHTML = `<div class="mreg">
  <div class="mr-cq">
    <nav class="mr-regs" role="tablist" aria-label="Реєстри">
      <button type="button" role="tab" aria-selected="true">Реєстр мінусових угод <span class="mr-cnt" id="${P}regcnt" hidden></span></button>
    </nav>
    <section class="mr-card" aria-label="Реєстр мінусових угод">
      <div class="mr-bar">
        <div class="mr-ways" id="${P}filters" role="group" aria-label="Статус"></div>
        <span class="mr-grow"></span>
        <label class="mr-search">${SEARCH_ICON}<input id="${P}q" inputmode="numeric" placeholder="ID угоди" aria-label="Пошук за ID угоди" autocomplete="off"></label>
        <button type="button" class="mr-btn mr-pri" id="${P}add" hidden>+ Додати угоду</button>
      </div>
      <div class="mr-tblwrap"><table class="mr-reg">
        <thead><tr><th>Угода</th><th>Маршрут</th><th>Клієнт</th><th>Перевізник</th><th class="mr-r">Приходи</th><th class="mr-r">Розходи</th><th class="mr-r">Маржа</th><th id="${P}whoh">Менеджер</th><th>Статус</th></tr></thead>
        <tbody id="${P}rows"></tbody>
        <tfoot id="${P}foot"></tfoot>
      </table></div>
    </section>
  </div>
  <div class="mr-scrim" id="${P}scrim" hidden></div>
  <aside class="mr-drawer" id="${P}drawer" role="dialog" aria-modal="true" aria-labelledby="${P}dTitle" hidden></aside>
  <div class="mr-toast" id="${P}toast" role="status" aria-live="polite" hidden></div>
  ${opts.suggestIds ? `<datalist id="${P}ids">${opts.suggestIds.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</datalist>` : ''}
</div>`;

  // ---------- шматки розмітки ----------
  const pill = (s: Status) => `<span class="mr-pill mr-${STATUS_TONE[s]}">${STATUS_LABEL[s]}</span>`;
  /** Форми оплати під сумою в таблиці — по одній на рядок, без повторів. */
  const forms = (list: Line[]) => [...new Set(list.map(fmtType))].map(t => `<span class="mr-pf">${esc(t)}</span>`).join('');

  function parties(d: CrmDeal) {
    return `<div><dl class="mr-parties"><dt>Клієнт</dt><dd>${esc(d.client || '—')}</dd><dt>Перевізник</dt><dd>${d.carrier ? esc(d.carrier) : NO_CARRIER_LONG}</dd></dl>
    <div class="mr-src mr-psrc">Клієнт — з картки клієнта в угоді · перевізник — із заявки на оплату (б/готівка)</div></div>`;
  }
  /** Приходи й розходи — як блок полів у CRM: «Приход N» · «Тип оплаты» · сума · «расчет»; угорі — «Расчет приходов». */
  function ledger(d: CrmDeal) {
    const block = (title: string, list: Line[], word: string, tot: number) => `<div class="mr-lg"><div class="mr-lh"><span class="mr-lbl">${title}</span><span class="mr-tot mr-num">${grn(tot)}</span></div>
      <table class="mr-lt"><thead><tr><th></th><th>Форма оплати</th><th class="mr-r">Сума</th><th class="mr-r">Розрахунок</th></tr></thead>
      <tbody>${list.map((x, k) => `<tr><th scope="row">${word} ${k + 1}</th><td class="mr-f">${esc(fmtType(x))}</td><td class="mr-r mr-num">${nf(x.sum)}</td><td class="mr-r mr-num">${nf(x.net)}</td></tr>`).join('')}</tbody></table></div>`;
    const m = d.budget;
    return `<div class="mr-ledger">
      ${block('Приходи', d.inc, 'Прихід', d.incTotal)}
      ${block('Розходи', d.exp, 'Розхід', d.expTotal)}
      <div class="mr-lg mr-mg ${m < 0 ? 'mr-minus' : 'mr-plus'}"><div class="mr-lh"><span class="mr-lbl">Маржа · бюджет угоди</span><span class="mr-tot mr-num ${m < 0 ? 'mr-neg' : 'mr-pos'}">${sgn(m)}</span></div></div>
    </div>`;
  }
  const route = (d: CrmDeal) => `<div><div class="mr-lbl">Маршрут</div><div class="mr-bigroute">${esc(d.name)}</div><div class="mr-src">Етап у CRM: ${esc(d.stage)}</div></div>`;

  // ---------- список ----------
  function render() {
    if (!alive) return;
    const rows = $('rows')!, foot = $('foot')!;
    if (!me) {
      rows.innerHTML = `<tr><td colspan="9" class="mr-empty">${loadErr ? esc(loadErr) : 'Завантаження…'}</td></tr>`;
      foot.innerHTML = ''; $('filters')!.innerHTML = '';
      return;
    }
    const u = me;
    const mine = reqs.filter(r => canSee(u, r));
    const n = mine.filter(r => needsMe(u, r)).length;
    const c = $('regcnt')!; c.textContent = String(n); c.hidden = !n;
    opts.onCount?.(n);
    $('filters')!.innerHTML = FILTERS.map(([k, t]) => {
      const cnt = k === 'all' ? mine.length : mine.filter(r => r.status === k).length;
      return `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${t} <span class="mr-c">${cnt}</span></button>`;
    }).join('');
    $('add')!.hidden = !canSubmit(u.role);
    const list = mine.filter(r => (filter === 'all' || r.status === filter) && (!query || r.dealId.includes(query)));
    const showWho = seesAll(u.role);
    $('whoh')!.hidden = !showWho;
    rows.innerHTML = list.map(r => {
      const d = r.crm.budget;
      return `<tr data-id="${esc(r.id)}" tabindex="0" class="${openId === r.id ? 'mr-sel' : ''}" aria-label="Угода ${esc(r.dealId)}">
      <td class="mr-c-id"><span class="mr-id">${esc(r.dealId)}</span><div class="mr-sub mr-when">${fmtWhen(r.createdAt)}</div></td>
      <td class="mr-c-route mr-route">${esc(r.crm.name)}</td>
      <td class="mr-c-cl mr-party">${esc(r.crm.client || '—')}</td>
      <td class="mr-c-ca mr-party">${r.crm.carrier ? esc(r.crm.carrier) : NO_CARRIER}</td>
      <td class="mr-c-in mr-r mr-money">${grn(r.crm.incTotal)}${forms(r.crm.inc)}</td>
      <td class="mr-c-pay mr-r mr-money">${grn(r.crm.expTotal)}${forms(r.crm.exp)}</td>
      <td class="mr-c-diff mr-r mr-money ${d < 0 ? 'mr-neg' : 'mr-pos'}">${sgn(d)}</td>
      ${showWho ? `<td class="mr-c-who mr-who">${esc(r.createdByName)}</td>` : ''}
      <td class="mr-c-st">${pill(r.status)}${r.grew && r.status === 'pending' ? '<span class="mr-grew" title="Мінус зріс після погодження">мінус зріс</span>' : ''}</td></tr>`;
    }).join('') || `<tr><td colspan="9" class="mr-empty">${query ? 'Угоди ' + esc(query) + ' в реєстрі немає' : 'Порожньо'}</td></tr>`;
    const total = list.reduce((s, r) => s + r.crm.budget, 0);
    foot.innerHTML = list.length
      ? `<tr><td colspan="6">${list.length} ${plural(list.length, 'угода', 'угоди', 'угод')}</td><td class="mr-r mr-money ${total < 0 ? 'mr-neg' : 'mr-pos'}">${sgn(total)}</td><td colspan="${showWho ? 2 : 1}"></td></tr>`
      : '';
  }

  // ---------- панель ----------
  function openPanel(kind: 'new' | 'detail', id?: string) {
    panel = kind; openId = id || null; decision = null;
    if (kind === 'new') draft = { id: '', deal: null, err: '', comment: '' };
    $('scrim')!.hidden = false; $('drawer')!.hidden = false;
    renderPanel(); render();
    const f = kind === 'new' ? $('dealId') : $('drawer')!.querySelector<HTMLElement>('[data-close]');
    f?.focus();
  }
  function closePanel() {
    panel = null; openId = null; decision = null; draft = null;
    $('scrim')!.hidden = true; $('drawer')!.hidden = true;
    render();
  }
  function renderPanel() {
    if (!alive || !panel) return;
    const D = $('drawer')!;
    if (panel === 'new') { D.innerHTML = newPanel(); return; }
    const r = reqs.find(x => x.id === openId);
    if (!r || !me) { closePanel(); return; }
    const g = r.grew && r.status === 'pending'
      ? `<div class="mr-note"><b>Мінус зріс після погодження:</b> маржа ${sgn(r.grew.budget)} → ${sgn(r.crm.budget)}. ${esc(r.grew.what)}</div>` : '';
    const hist = r.hist.map(h => `<li style="--pc:var(--${EVENT_TONE[h.type]})"><span class="mr-dot"></span><div><div class="mr-t">${EVENT_LABEL[h.type]}</div><div class="mr-meta">${h.byName ? esc(h.byName) + ' · ' : ''}${fmtWhen(h.at)}</div>${h.note ? `<div class="mr-tr">${esc(h.note)}</div>` : ''}</div></li>`).join('');
    const editable = allowedActions(me, r).includes('resubmit');
    D.innerHTML = `
    <div class="mr-dh"><h2 id="${P}dTitle">Угода <span class="mr-num">${esc(r.dealId)}</span> ${pill(r.status)}</h2><span class="mr-grow"></span><button type="button" class="mr-x" data-close aria-label="Закрити">✕</button></div>
    <div class="mr-db">
      ${route(r.crm)}
      ${parties(r.crm)}
      ${ledger(r.crm)}
      ${FROM_CRM}
      ${g}
      <div><div class="mr-lbl">Чому мінус</div>
        ${editable
          ? `<label class="mr-field" style="margin-top:6px"><textarea class="mr-in" id="${P}cmt" rows="3" aria-label="Чому угода мінусова">${esc(r.comment)}</textarea></label>`
          : `<div class="mr-quote" style="margin-top:6px">${esc(r.comment)}</div>`}
        <div class="mr-meta">${esc(r.createdByName)} · ${fmtWhen(r.createdAt)}</div></div>
      <div><div class="mr-lbl" style="margin-bottom:8px">Історія</div><ul class="mr-tl">${hist}</ul></div>
    </div>
    ${actions(r)}`;
  }
  function actions(r: RegRequest) {
    const acts = allowedActions(me!, r);
    const dis = busy ? ' disabled' : '';
    if (acts.includes('approve')) {
      if (decision === 'return' || decision === 'reject') {
        const ret = decision === 'return';
        return `<div class="mr-df"><label class="mr-field">${ret ? 'Що доопрацювати' : 'Причина відмови'}<textarea class="mr-in" id="${P}why" rows="3"></textarea></label>
        <div class="mr-acts"><button type="button" class="mr-btn ${ret ? 'mr-pri' : 'mr-badb'}" data-act="${decision}-go" disabled>${ret ? 'Повернути менеджеру' : 'Відхилити'}</button><button type="button" class="mr-btn" data-act="cancel">Скасувати</button></div></div>`;
      }
      return `<div class="mr-df"><div class="mr-acts"><button type="button" class="mr-btn mr-okb" data-act="approve"${dis}>Погодити</button><button type="button" class="mr-btn" data-act="return"${dis}>Повернути на доопрацювання</button><button type="button" class="mr-btn mr-badb" data-act="reject"${dis}>Відхилити</button></div></div>`;
    }
    if (acts.includes('paid')) {
      if (decision === 'paid') return `<div class="mr-df"><div class="mr-hint">Усі оплати перевізнику по угоді проведено?</div><div class="mr-acts"><button type="button" class="mr-btn mr-okb" data-act="paid-go"${dis}>Так, оплачено</button><button type="button" class="mr-btn" data-act="cancel">Скасувати</button></div></div>`;
      return `<div class="mr-df"><div class="mr-acts"><button type="button" class="mr-btn mr-okb" data-act="paid">Оплачено</button></div></div>`;
    }
    if (acts.includes('resubmit')) return `<div class="mr-df"><div class="mr-acts"><button type="button" class="mr-btn mr-pri" data-act="resubmit"${dis}>Надіслати повторно</button></div></div>`;
    return '';
  }
  function newPanel() {
    const d = draft!, c = d.deal;
    return `
    <div class="mr-dh"><h2 id="${P}dTitle">Нова угода в реєстр</h2><span class="mr-grow"></span><button type="button" class="mr-x" data-close aria-label="Закрити">✕</button></div>
    <div class="mr-db">
      <form id="${P}find" class="mr-row" autocomplete="off"><input class="mr-in" id="${P}dealId" inputmode="numeric"${opts.suggestIds ? ` list="${P}ids"` : ''} placeholder="ID угоди в CRM" aria-label="ID угоди" value="${esc(d.id)}"><button type="submit" class="mr-btn"${busy ? ' disabled' : ''}>Знайти в CRM</button></form>
      <div class="mr-hint">Реєстр — лише для безготівкової оплати перевізнику через бухгалтерію.</div>
      ${d.err ? `<div class="mr-err" role="alert">${esc(d.err)}</div>` : ''}
      ${c ? `${route(c)}${parties(c)}${ledger(c)}${FROM_CRM}
      <label class="mr-field">Чому угода мінусова<textarea class="mr-in" id="${P}newCmt" rows="4">${esc(d.comment)}</textarea></label>` : ''}
    </div>
    ${c ? `<div class="mr-df"><div class="mr-acts"><button type="button" class="mr-btn mr-pri" data-act="submit"${d.comment.trim() && !busy ? '' : ' disabled'}>Надіслати на погодження</button></div></div>` : ''}`;
  }

  // ---------- дії ----------
  let toastHide = () => { const t = $('toast'); if (t) t.hidden = true; };
  function toast(msg: string) {
    const t = $('toast'); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(toastHide, 2400);
  }
  const replace = (q: RegRequest) => { const i = reqs.findIndex(x => x.id === q.id); if (i >= 0) reqs[i] = q; else reqs.unshift(q); };

  async function findDeal(raw: string) {
    if (!draft || busy) return;
    const id = raw.trim();
    draft.id = id; draft.deal = null; draft.err = '';
    const bad = checkDealId(id);
    if (bad) draft.err = bad;
    else {
      busy = true; renderPanel();
      try { draft.deal = await opts.api.findDeal(id); }
      catch (e) { draft.err = errText(e); }
      finally { busy = false; }
      if (panel !== 'new' || !draft) return;                // закрили, поки шукали
    }
    renderPanel();
    (($('newCmt') || $('dealId')) as HTMLElement | null)?.focus();
  }
  async function submit() {
    if (!draft || !draft.deal || busy) return;
    const bad = checkComment(draft.comment); if (bad) { toast(bad); return; }
    busy = true; renderPanel();
    try {
      const created = await opts.api.submit(draft.id, draft.comment.trim());
      busy = false;
      replace(created);
      filter = 'all'; panel = 'detail'; openId = created.id; draft = null;
      renderPanel(); render(); toast(ACTION_DONE.submit);
    } catch (e) {
      busy = false;
      if (draft) draft.err = errText(e);
      renderPanel();
    }
  }
  async function act(r: RegRequest, a: Action, body: { note?: string; comment?: string; seenBudget?: number }) {
    busy = true; renderPanel();
    try {
      replace(await opts.api.act(r.id, a, body));
      busy = false; decision = null;
      renderPanel(); render(); toast(ACTION_DONE[a]);
    } catch (e) {
      busy = false;
      if (e instanceof RegistryApiError && e.request) { replace(e.request); decision = null; }
      renderPanel(); render(); toast(errText(e));
    }
  }
  function onAct(a: string) {
    if (busy) return;
    if (a === 'submit') { void submit(); return; }
    const r = reqs.find(x => x.id === openId); if (!r) return;
    if (a === 'approve') { void act(r, 'approve', { seenBudget: r.crm.budget }); return; }
    if (a === 'return' || a === 'reject') { decision = a; renderPanel(); $('why')?.focus(); return; }
    if (a === 'cancel') { decision = null; renderPanel(); render(); return; }
    if (a === 'return-go' || a === 'reject-go') {
      const which: Action = a === 'return-go' ? 'return' : 'reject';
      const why = ($('why') as HTMLTextAreaElement | null)?.value.trim() || '';
      const bad = checkNote(which, why); if (bad) { toast(bad); return; }
      void act(r, which, { note: why }); return;
    }
    if (a === 'paid') { decision = 'paid'; renderPanel(); render(); return; }
    if (a === 'paid-go') { void act(r, 'paid', {}); return; }
    if (a === 'resubmit') {
      const t = $('cmt') as HTMLTextAreaElement | null;
      void act(r, 'resubmit', { comment: t && t.value.trim() ? t.value.trim() : r.comment });
    }
  }

  // ---------- події ----------
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const f = t.closest<HTMLElement>('[data-f]');
    if (f && $('filters')!.contains(f)) { filter = f.dataset.f as Filter; render(); return; }
    if (t.closest(`#${P}add`)) { openPanel('new'); return; }
    if (t.closest(`#${P}scrim`)) { closePanel(); return; }
    const tr = t.closest<HTMLElement>('tr[data-id]');
    if (tr && $('rows')!.contains(tr)) { openPanel('detail', tr.dataset.id); return; }
    const D = $('drawer')!;
    if (!D.contains(t)) return;
    if (t.closest('[data-close]')) { closePanel(); return; }
    const b = t.closest<HTMLElement>('[data-act]');
    if (b && !(b as HTMLButtonElement).disabled) onAct(b.dataset.act!);
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]');
    if (tr && $('rows')!.contains(tr)) openPanel('detail', tr.dataset.id);
  };
  const onInput = (e: Event) => {
    const t = e.target as HTMLInputElement | HTMLTextAreaElement;
    const D = $('drawer')!;
    if (t.id === P + 'q') { query = t.value.replace(/\D/g, ''); render(); }
    else if (t.id === P + 'newCmt' && draft) { draft.comment = t.value; const b = D.querySelector<HTMLButtonElement>('[data-act="submit"]'); if (b) b.disabled = !draft.comment.trim() || busy; }
    else if (t.id === P + 'why') { const b = D.querySelector<HTMLButtonElement>('[data-act="return-go"],[data-act="reject-go"]'); if (b) b.disabled = !t.value.trim(); }
    else if (t.id === P + 'cmt') { const b = D.querySelector<HTMLButtonElement>('[data-act="resubmit"]'); if (b) b.disabled = !t.value.trim() || busy; }
  };
  const onSubmit = (e: Event) => {
    if ((e.target as HTMLElement).id !== P + 'find') return;
    e.preventDefault();
    void findDeal(($('dealId') as HTMLInputElement).value);
  };
  const onDocKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && panel) closePanel(); };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('input', onInput);
  root.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onDocKey);

  async function refresh() {
    try {
      const j = await opts.api.list();
      if (!alive) return;
      const changed = !me || me.id !== j.me.id || me.role !== j.me.role;
      me = j.me; reqs = j.requests; loadErr = '';
      if (changed) { filter = defaultFilter(me.role); if (panel) closePanel(); }
      else if (panel === 'detail' && !reqs.some(r => r.id === openId)) closePanel();
    } catch (e) {
      if (!alive) return;
      loadErr = 'Не вдалося завантажити реєстр. ' + errText(e);
    }
    render();
  }

  render();
  void refresh();

  return {
    refresh,
    destroy() {
      alive = false;
      clearTimeout(toastT); toastHide = () => undefined;
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('input', onInput);
      root.removeEventListener('submit', onSubmit);
      document.removeEventListener('keydown', onDocKey);
      root.innerHTML = '';
    },
  };
}
