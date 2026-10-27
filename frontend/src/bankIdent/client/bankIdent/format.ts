/** Формат для «Виписки»: час — завжди київський (незалежно від поясу компʼютера), як і строк. */
import { kyivParts } from '../../shared/identDeadline';

export const WDS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const p2 = (n: number) => String(n).padStart(2, '0');
const ms = (v: number | string) => (typeof v === 'number' ? v : Date.parse(v));

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const fDate = (v: number | string) => { const p = kyivParts(ms(v)); return `${p2(p.d)}.${p2(p.m)}`; };
export const fTime = (v: number | string) => { const p = kyivParts(ms(v)); return `${p2(p.hh)}:${p2(p.mm)}`; };
export const fDT = (v: number | string) => `${fDate(v)}, ${fTime(v)}`;
export const fWDT = (v: number | string) => `${WDS[kyivParts(ms(v)).wd]} ${fDT(v)}`;
export const isMidnight = (v: number | string) => { const p = kyivParts(ms(v)); return p.hh === 0 && p.mm === 0; };
/** «до …»: «вт 27.10, 15:00» або «кінця вт 27.10», якщо строк — рівно північ. */
export const fDue = (v: number | string) => { const t = ms(v); return isMidnight(t) ? `кінця ${WDS[kyivParts(t - 1).wd]} ${fDate(t - 1)}` : fWDT(t); };
/** «строк минув — …»: «вт 27.10, 15:00» або «кінець вт 27.10». */
export const fDueAt = (v: number | string) => { const t = ms(v); return isMidnight(t) ? `кінець ${WDS[kyivParts(t - 1).wd]} ${fDate(t - 1)}` : fWDT(t); };
/** Скільки лишилось робочого часу: «ще 46 год», «ще 1 год 30 хв», «ще 25 хв». */
export function fLeft(msLeft: number): string {
  const m = Math.max(1, Math.round(msLeft / 60000));
  if (m < 60) return `ще ${m} хв`;
  const h = Math.floor(m / 60), r = m % 60;
  return h < 3 && r ? `ще ${h} год ${r} хв` : `ще ${h} год`;
}
export const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
};
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
