/**
 * Строк ідентифікації платежу (рішення Сергія 27.10): 48 год, субота й неділя не рахуються, час — Київ.
 *   прихід у пт 15:00            → строк вт 15:00;
 *   прихід у сб або нд           → відлік з пн 00:00 → строк — кінець вівторка (ср 00:00);
 *   прихід у чт 17:30            → строк пн 17:30.
 * Свята — необовʼязковий список дат 'YYYY-MM-DD' (у воєнний стан порожній). Перехід на літній / зимовий час — у неділю,
 * а неділя не рахується, тож будні години не зсуваються (перевірено тестами).
 * Відлік — з пізнішого з двох моментів: час у банку (booked_at) і поява платежу у виписці (seenAt), щоб затримка банку
 * не «зʼїдала» строк менеджера.
 * Той самий код рахує строк на сервері, у клієнті й у макеті.
 */
export const TZ = 'Europe/Kyiv';
export const HOUR = 3_600_000;

export interface KyivParts { y: number; m: number; d: number; hh: number; mm: number; ss: number; wd: number }

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Частини дати за Києвом; wd: 0 — неділя … 6 — субота. */
export function kyivParts(ms: number): KyivParts {
  const o: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, ss: +o.second, wd: WD[o.weekday] };
}

/** Мілісекунди UTC для київського часу «на стіні» y-m-d hh:mm. */
export function kyiv(y: number, m: number, d: number, hh = 0, mm = 0): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target - 2 * HOUR;
  for (let i = 0; i < 4; i++) {
    const p = kyivParts(guess);
    const diff = target - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

/** Наступна київська північ після моменту ms. */
export function nextMidnight(ms: number): number {
  const p = kyivParts(ms);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return kyiv(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export const dayKey = (p: Pick<KyivParts, 'y' | 'm' | 'd'>) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

export type Holidays = ReadonlySet<string> | null | undefined;

/** Будній день (пн–пт) і не свято. */
export function isWorkday(ms: number, holidays?: Holidays): boolean {
  const p = kyivParts(ms);
  return p.wd >= 1 && p.wd <= 5 && !(holidays && holidays.has(dayKey(p)));
}

/** Додати робочий час (мс) до моменту start. */
export function addWork(start: number, ms: number, holidays?: Holidays): number {
  let t = start, left = ms;
  for (let guard = 0; guard < 800; guard++) {
    const end = nextMidnight(t);
    if (isWorkday(t, holidays)) {
      if (end - t >= left) return t + left;
      left -= end - t;
    }
    t = end;
  }
  throw new Error('identDeadline: забагато вихідних поспіль — перевірте список свят');
}

/** Робочий час між a і b (мс): лише будні, без свят. */
export function workBetween(a: number, b: number, holidays?: Holidays): number {
  if (b <= a) return 0;
  let t = a, sum = 0;
  for (let guard = 0; guard < 800 && t < b; guard++) {
    const end = nextMidnight(t);
    if (isWorkday(t, holidays)) sum += Math.min(end, b) - t;
    t = end;
  }
  return sum;
}

export interface DeadlineOptions { hours?: number; holidays?: Holidays }

/** Початок відліку — пізніше з «час у банку» і «зʼявився у виписці». */
export const startOf = (bookedAt: number, seenAt?: number | null) => Math.max(bookedAt, seenAt || 0);

/** Строк ідентифікації (мс UTC). */
export function identDeadline(bookedAt: number, seenAt?: number | null, o: DeadlineOptions = {}): number {
  return addWork(startOf(bookedAt, seenAt), (o.hours ?? 48) * HOUR, o.holidays);
}

/** Розбір списку свят: «2027-01-01, 2027-05-01» → Set. Некоректні значення — помилка (щоб не мовчати). */
export function parseHolidays(list: string | string[] | null | undefined): Set<string> {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/);
  const out = new Set<string>();
  for (const raw of arr) {
    const s = raw.trim();
    if (!s) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Свято «${s}» — потрібен формат РРРР-ММ-ДД`);
    out.add(s);
  }
  return out;
}
