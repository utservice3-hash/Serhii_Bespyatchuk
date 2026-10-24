/**
 * Формат для «Узгодження», «Перевірки контрагента» і «Лімітів клієнтів»: суми, дні, дати. Пробіли в числах — нерозривні.
 * Дати показуються за місцевим часом браузера (сервер віддає ISO).
 */
export const nf = (n: number) => Math.abs(n).toLocaleString('uk-UA', { maximumFractionDigits: 2 }).replace(/\s/g, ' ');
export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const CUR_SIGN: Record<string, string> = { uah: 'грн', eur: '€', usd: '$' };
/** «460 000 грн», «2 100 €». Знак мінуса — окремо там, де він потрібен. */
export const money = (x: number, cur: string = 'uah') => `${nf(x)} ${CUR_SIGN[cur] || cur}`;
/** «460 тис.», «1,10 млн» — у списку, де місця мало. */
export const short = (x: number) => (Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(2).replace('.', ',')} млн` : `${Math.round(x / 1000)} тис.`);
export const rate2 = (x: number) => String(x).replace('.', ',');
export const dayW = (d: number) => `${d} ${plural(d, 'день', 'дні', 'днів')}`;
export const tripsW = (t: number) => `${t} ${plural(t, 'рейс', 'рейси', 'рейсів')}`;
export const txW = (n: number) => `${n} ${plural(n, 'транзакція', 'транзакції', 'транзакцій')}`;
export const casesW = (n: number) => `${n} ${plural(n, 'справа', 'справи', 'справ')}`;
export const clientsW = (n: number) => `${n} ${plural(n, 'клієнт', 'клієнти', 'клієнтів')}`;
export const entitiesW = (n: number) => `${n} ${plural(n, 'юрособа', 'юрособи', 'юросіб')}`;
export const kb = (bytes: number) => { const k = Math.max(1, Math.round(bytes / 1024)); return k >= 1024 ? `${(k / 1024).toFixed(1).replace('.', ',')} МБ` : `${k} КБ`; };

const p2 = (n: number) => String(n).padStart(2, '0');
const D = (s: string | Date) => (s instanceof Date ? s : new Date(s));
const ok = (d: Date) => !Number.isNaN(d.getTime());
/** «21.10.2026» */
export const dt = (s: string | Date | null | undefined) => { if (!s) return ''; const d = D(s); return ok(d) ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}` : ''; };
/** «21.10 06:00» */
export const dm = (s: string | Date | null | undefined) => { if (!s) return ''; const d = D(s); return ok(d) ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : ''; };
