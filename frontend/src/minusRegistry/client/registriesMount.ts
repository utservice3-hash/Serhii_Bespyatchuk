/**
 * Сторінка «Реєстри та узгодження» без прив'язки до фреймворку (React-обгортка — RegistriesPage.tsx): смужка вкладок із лічильниками і три вкладки —
 *   «Реєстр мінусових угод» (client/minusRegistry) · «Узгодження роботи з новим контрагентом» · «Перевірка контрагента».
 *   const h = mountRegistriesPage(el, { minusApi, cpApi, tabs, navigate, onCount });   // h.show('check'), h.open(target), h.destroy()
 * Які вкладки показати — за доступами ролі в дашборді («Ролі та доступи»): інші співробітники бачать лише «Перевірку контрагента».
 * Перехід на «Ліміти клієнтів» (інша сторінка) — через navigate.
 */
import { mountMinusRegistry, type MinusRegistryHandle, type RegistryApi } from './minusRegistry/registry';
import { mountApprovals, type ApprovalsHandle } from './counterparty/approvals';
import { mountCounterpartyCheck, type CheckHandle } from './counterparty/check';
import type { CpApi, Navigate, NavTarget } from './counterparty/types';

export type RegTab = 'minus' | 'new' | 'check';
export const REG_TABS: Record<RegTab, string> = { minus: 'Реєстр мінусових угод', new: 'Узгодження роботи з новим контрагентом', check: 'Перевірка контрагента' };

export interface RegistriesPageOptions {
  minusApi: RegistryApi;
  cpApi: CpApi;
  /** Видимі вкладки (порядок фіксований). За замовчуванням — усі три. */
  tabs?: RegTab[];
  /** Відкрити одразу (з адреси: navFromSearch(location.search)). */
  initial?: NavTarget | null;
  /** Перехід на ІНШУ сторінку дашборда (ліміти клієнтів у дебіторці): напр. t => router.push(navToUrl(t)). */
  navigate?: Navigate;
  /** Вкладка чи відкритий запит на ЦІЙ сторінці змінились — оновити адресу без перезавантаження (history.replaceState(null, '', navToUrl(t))). */
  onLocation?: (t: NavTarget) => void;
  /** Разом «чекає вашої дії» (мінусові угоди + узгодження) — для заголовка й пункту меню. */
  onCount?: (n: number) => void;
  /** Годинник (макет — фіксована дата демо-даних). */
  now?: () => Date;
  /** Лише макет. */
  suggestIds?: Array<[string, string]>;
  suggestCodes?: Array<[string, string]>;
  checkCodes?: Array<[string, string]>;
}
export interface RegistriesPageHandle { show(t: RegTab): void; open(t: NavTarget): void; refresh(): Promise<void>; destroy(): void }

let seq = 0;

export function mountRegistriesPage(root: HTMLElement, o: RegistriesPageOptions): RegistriesPageHandle {
  const P = `rp${++seq}-`;
  const tabs = (o.tabs && o.tabs.length ? o.tabs : (['minus', 'new', 'check'] as RegTab[])).filter((t, i, a) => a.indexOf(t) === i);
  const first = o.initial && (o.initial.tab === 'minus' || o.initial.tab === 'new' || o.initial.tab === 'check') && tabs.includes(o.initial.tab) ? o.initial.tab : tabs.includes('new') ? 'new' : tabs[0];
  let cur: RegTab = first;
  const counts: Record<RegTab, number> = { minus: 0, new: 0, check: 0 };

  root.innerHTML = `<div class="cpx">
  <nav class="cp-regs" role="tablist" aria-label="Реєстри та узгодження">${tabs.map(t => `<button type="button" role="tab" id="${P}tab-${t}" data-tab="${t}" aria-controls="${P}pane-${t}" aria-selected="${t === cur}">${REG_TABS[t]}${t === 'check' ? '' : ` <span class="cp-cnt" id="${P}cnt-${t}" hidden></span>`}</button>`).join('')}</nav>
</div>
${tabs.map(t => `<div role="tabpanel" id="${P}pane-${t}" aria-labelledby="${P}tab-${t}"${t === cur ? '' : ' hidden'}></div>`).join('')}`;
  const el = (id: string) => document.getElementById(P + id)!;

  function setCount(t: RegTab, n: number) {
    counts[t] = n;
    const c = document.getElementById(`${P}cnt-${t}`);
    if (c) { c.textContent = String(n); c.hidden = !n; }
    o.onCount?.(tabs.filter(x => x !== 'check').reduce((a, x) => a + counts[x], 0));
  }
  function show(t: RegTab) {
    if (!tabs.includes(t)) return;
    cur = t;
    for (const x of tabs) { el('pane-' + x).hidden = x !== t; el('tab-' + x).setAttribute('aria-selected', String(x === t)); }
  }
  // вкладки на цій сторінці відкриваємо самі; ліміти (інша сторінка) — через navigate
  const navigate: Navigate = t => {
    if ((t.tab === 'new' || t.tab === 'check' || t.tab === 'minus') && tabs.includes(t.tab)) { show(t.tab); open(t); o.onLocation?.(t); }
    else o.navigate?.(t);
  };

  const minus: MinusRegistryHandle | null = tabs.includes('minus')
    ? mountMinusRegistry(el('pane-minus'), { api: o.minusApi, nav: false, suggestIds: o.suggestIds, onCount: n => setCount('minus', n) }) : null;
  const approvals: ApprovalsHandle | null = tabs.includes('new')
    ? mountApprovals(el('pane-new'), { api: o.cpApi, navigate, now: o.now, onCount: n => setCount('new', n), suggestCodes: o.suggestCodes, initial: o.initial && o.initial.tab === 'new' ? o.initial : undefined }) : null;
  const check: CheckHandle | null = tabs.includes('check')
    ? mountCounterpartyCheck(el('pane-check'), { api: o.cpApi, navigate, now: o.now, suggestCodes: o.checkCodes, initial: o.initial && o.initial.tab === 'check' ? o.initial : undefined }) : null;

  function open(t: NavTarget) {
    if (t.tab === 'new') approvals?.open(t);
    else if (t.tab === 'check') check?.open(t);
  }
  const onClick = (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.cp-regs [data-tab]');
    if (b && root.contains(b)) { const t = b.dataset.tab as RegTab; show(t); o.onLocation?.({ tab: t } as NavTarget); }
  };
  root.addEventListener('click', onClick);

  return {
    show,
    open(t) { if (t.tab === 'new' || t.tab === 'check' || t.tab === 'minus') { show(t.tab); open(t); } },
    async refresh() { await Promise.all([minus?.refresh(), approvals?.refresh(), check?.refresh()]); },
    destroy() { root.removeEventListener('click', onClick); minus?.destroy(); approvals?.destroy(); check?.destroy(); root.innerHTML = ''; },
  };
}
