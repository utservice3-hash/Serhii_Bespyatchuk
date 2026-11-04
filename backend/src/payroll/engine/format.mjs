// Формат для текстів сповіщень і підписів — як у макеті: uk-UA, нерозривні пробіли (U+00A0).
// Потрібен Node / браузер з ICU (Node ≥ 18 має повний ICU за замовчуванням).

export const NBSP = ' ';

/** 12345.6 → «12 346» */
export const nf = n => Math.round(n).toLocaleString('uk-UA').replace(/\s/g, NBSP);
/** 12345 → «12 345 ₴», −500 → «−500 ₴» (знак — U+2212) */
export const uah = n => (Math.round(n) < 0 ? '−' : '') + nf(Math.abs(n)) + NBSP + '₴';
/** 17.14 → «17,1 %» */
export const pct = x => String(Math.round(x * 10) / 10).replace('.', ',') + NBSP + '%';
/** 17.14 → «17,1» */
export const n1 = x => String(Math.round(x * 10) / 10).replace('.', ',');
/** '2026-11-20' → «20.11» */
export const dd = iso => iso.slice(8, 10) + '.' + iso.slice(5, 7);
/** '2026-11-20' → «20.11.2026» */
export const ddy = iso => dd(iso) + '.' + iso.slice(0, 4);
/** '2026-11-20T15:10' → «20.11 15:10» */
export const dt = iso => dd(iso) + (iso.length > 10 ? ' ' + iso.slice(11, 16) : '');
/** українська множина: plural(5, 'день', 'дні', 'днів') → «днів» */
export const plural = (n, a, b, c) => {
  const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c;
};
export const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
/** '2026-11' → «Листопад 2026» */
export const monthName = mk => `${MONTHS[+mk.slice(5, 7) - 1]} ${mk.slice(0, 4)}`;
/** '2026-11' → «листопада» */
export const monthGen = mk => MONTHS_GEN[+mk.slice(5, 7) - 1];
/** '2026-11' → «листопад» */
export const monthLow = mk => MONTHS[+mk.slice(5, 7) - 1].toLowerCase();
