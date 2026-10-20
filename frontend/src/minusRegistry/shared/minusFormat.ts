/** Формат для реєстру: «19 000 грн», «−1 520 грн», «+1 880 грн», «20.10 09:12». Пробіли в числах — нерозривні. */
import type { Line } from './minusRegistry.js';

export const nf = (n: number) => Math.abs(n).toLocaleString('uk-UA', { maximumFractionDigits: 2 }).replace(/\s/g, ' ');
/** Сума: мінус — «−», плюс без знака. */
export const grn = (n: number) => (n < 0 ? '−' : '') + nf(n) + ' грн';
/** Маржа: завжди зі знаком. */
export const sgn = (n: number) => (n < 0 ? '−' : n > 0 ? '+' : '') + nf(n) + ' грн';
/** Форма оплати рядка — як у CRM, з валютою для ВАЛЮТА: «Безнал без НДС», «ВАЛЮТА $». */
export const fmtType = (x: Pick<Line, 'type' | 'cur'>) => (x.type || '—') + (x.cur ? ' ' + x.cur : '');
/** Дата й час дії за місцевим часом: «20.10 09:12». */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
