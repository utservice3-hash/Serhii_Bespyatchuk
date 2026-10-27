/**
 * Фільтр «Усі · Чекають № · Неідентифіковані · З номером», інфо-рядки й ліва смуга рядка.
 * Вигляд — як чипи рахунків на поточному екрані «Виписка» (заокруглені, активний — синій).
 */
import { SOON_MS, type IdentState } from '../../shared/bankIdent';
import { workBetween } from '../../shared/identDeadline';
import { esc } from './format';
import type { CountsResponse, ListStatus } from './types';

export type IdentFilterValue = 'all' | Exclude<ListStatus, 'not_client'>;
export const IDENT_FILTERS: Array<[IdentFilterValue, string, keyof CountsResponse | null]> = [
  ['all', 'Усі', null], ['wait', 'Чекають №', 'wait'], ['unidentified', 'Неідентифіковані', 'unidentified'], ['identified', 'З номером', 'identified'],
];

export function identFilterHtml(c: CountsResponse | null, value: IdentFilterValue): string {
  return `<div class="bi-filt" role="group" aria-label="№ рахунку">${IDENT_FILTERS.map(([v, label, k]) => {
    const n = c && k ? c[k] : null;
    const tone = v === 'wait' && n ? ' bi-n-warn' : v === 'unidentified' && n ? ' bi-n-bad' : '';
    return `<button type="button" class="bi-chip${value === v ? ' bi-on' : ''}" data-bfv="${v}" aria-pressed="${value === v}">${esc(label)}${n !== null ? ` <span class="bi-n${tone}">${n}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

export function mountIdentFilter(el: HTMLElement, o: { counts: CountsResponse | null; value: IdentFilterValue; onChange: (v: IdentFilterValue) => void }) {
  let cur = { ...o };
  const render = () => { el.innerHTML = identFilterHtml(cur.counts, cur.value); };
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bfv]');
    if (!b || !el.contains(b)) return;
    cur.value = b.dataset.bfv as IdentFilterValue; render(); cur.onChange(cur.value);
  };
  el.addEventListener('click', onClick);
  render();
  return {
    update(p: Partial<typeof cur>) { cur = { ...cur, ...p }; render(); },
    destroy() { el.removeEventListener('click', onClick); el.innerHTML = ''; },
  };
}

/** Інфо-рядок над списком: 'in' — правило № рахунку, 'out' — хто бачить коментарі (показуйте лише тим, у кого є право). */
export function identRuleHtml(kind: 'in' | 'out'): string {
  const text = kind === 'in'
    ? '<b>№ рахунку</b> — на надходженнях ФОП Беспятчук (Моно, Приват) і картки Ступаківського. Менеджер вписує його <b>один раз</b>, за <b>48 год</b> без суботи й неділі; не вписав — платіж <b>«Неідентифікований»</b> назавжди. Змінити номер може лише фінансист. Свої перекази номера не потребують; повернення й помилкові платежі бухгалтер позначає «не оплата клієнта».'
    : 'Коментарі до вихідних <b>ФОП Беспятчук</b> бачать і пишуть лише <b>адмін і бухгалтер</b> — іншим ролям їх не видно взагалі.';
  return `<div class="bi-rule"><span class="bi-i" aria-hidden="true">i</span><div>${text}</div></div>`;
}

/**
 * Колір лівої смуги рядка (у рядку виписки вже є border-left: 3px solid transparent):
 * бурштиновий — платіж чекає №, лишилось < 12 робочих год і користувач може вписати номер; інакше прозорий.
 */
export function identAccent(s: IdentState | null | undefined, now: number, holidays?: ReadonlySet<string>): string {
  if (!s || s.status !== 'wait' || !s.can.set || !s.deadlineAt) return 'transparent';
  return workBetween(now, Date.parse(s.deadlineAt), holidays) <= SOON_MS ? 'var(--warn, #b45309)' : 'transparent';
}
