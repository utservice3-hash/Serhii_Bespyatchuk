/**
 * 📐 ПОРІВНЯННЯ ОДНАКОВИХ ВІДРІЗКІВ (ТЗ «Статистики» 28.09.2026, блок 1; задачі 4603, 4367). Чисте — без БД.
 *
 * Було: плитка брала останню точку ряду й порівнювала з точкою «4 тижні тому» або попередньою —
 * тобто ПОНЕДІЛОК поточного тижня (1 день) з ПОВНИМ минулим тижнем. Звідси «Дохід ▼93%»,
 * якого не було. Тепер поточний відрізок завжди порівнюється з відрізком ТІЄЇ САМОЇ довжини:
 *   тиждень — пн..сьогодні  проти  пн..той самий день минулого тижня;
 *   місяць  — 1-ше..сьогодні проти  1-ше..той самий день минулого місяця (клампиться: 31.03 → 28/29.02).
 * Для неповного відрізка підпис «станом на <дата>» — щоб число не читалось як підсумок.
 *
 * Тиждень — календарний Пн–Нд (4367: «тиждень не захоплює понеділок наступного»).
 */

export type Gran = "week" | "month";
export interface Window { from: string; to: string }
export interface CompareWindows {
  gran: Gran;
  /** Поточний відрізок: від початку періоду до anchor (включно). */
  cur: Window;
  /** Той самий відрізок попереднього періоду — ТІЄЇ САМОЇ довжини. */
  prev: Window;
  /** Увесь поточний період (для плану й підпису). */
  full: Window;
  /** anchor — останній день періоду: порівнюються повні періоди. */
  complete: boolean;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const isoDow = (s: string) => { const w = D(s).getUTCDay(); return w === 0 ? 7 : w; };
const dim = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** Понеділок і неділя календарного тижня дати. */
export function weekOf(date: string): Window {
  const from = addDays(date, 1 - isoDow(date));
  return { from, to: addDays(from, 6) };
}

/** Тиждень із історії таблиці датований НЕДІЛЕЮ (кінцем); у CRM — понеділком. Ведемо до понеділка. */
export function sheetWeekToMonday(period: string): string {
  return isoDow(period) === 7 ? addDays(period, -6) : period;
}

export function compareWindows(gran: Gran, anchor: string): CompareWindows {
  if (gran === "week") {
    const w = weekOf(anchor);
    return {
      gran, full: w, cur: { from: w.from, to: anchor },
      prev: { from: addDays(w.from, -7), to: addDays(anchor, -7) },
      complete: anchor === w.to,
    };
  }
  const y = Number(anchor.slice(0, 4)), m0 = Number(anchor.slice(5, 7)) - 1, day = Number(anchor.slice(8, 10));
  const from = `${anchor.slice(0, 7)}-01`;
  const last = dim(y, m0);
  const py = m0 === 0 ? y - 1 : y, pm0 = m0 === 0 ? 11 : m0 - 1;
  const pFrom = `${py}-${String(pm0 + 1).padStart(2, "0")}-01`;
  const pDay = Math.min(day, dim(py, pm0));
  return {
    gran, full: { from, to: `${anchor.slice(0, 7)}-${String(last).padStart(2, "0")}` },
    cur: { from, to: anchor },
    prev: { from: pFrom, to: `${pFrom.slice(0, 7)}-${String(pDay).padStart(2, "0")}` },
    complete: day === last,
  };
}

/** Δ у відсотках; `null`, коли порівнювати нема з чим (попередній нуль) — а не ±∞ чи «▼100%». */
export function deltaPct(now: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((now - prev) / Math.abs(prev)) * 1000) / 10;
}

/** % виконання плану; `null` без плану — щоб «плану немає» не читалось як 0%. */
export function planPct(fact: number, plan: number | null): number | null {
  if (!plan || plan <= 0) return null;
  return Math.round((fact / plan) * 1000) / 10;
}

/** Ранг за % плану (більший — вище); без плану — після всіх, у порядку факту. 1-based. */
export function rankByPlan<T extends { pct: number | null; fact: number }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.pct == null && b.pct == null) return b.fact - a.fact;
    if (a.pct == null) return 1;
    if (b.pct == null) return -1;
    return b.pct - a.pct;
  });
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Клітинка плану тижня: менеджер × частина тижня в межах місяця (будує `statsSummary.monthWeekPlanCells`).
 * `manual` / `manualTaskId` — ручна ціль тімліда, що діє в цій частині, і задача, з якої вона взята.
 */
export interface WeekPlanCell {
  managerId: number; teamId: number | null; blockFrom: string; blockTo: string;
  auto: number; manual: number | null; manualTaskId: number | null;
}

/**
 * Згортка частин одного календарного тижня в план менеджера. Кожна частина — як на Звіті: ручна ціль ?? автоплан.
 * 🔴 РУЧНА ЦІЛЬ РАХУЄТЬСЯ РАЗ НА ЗАДАЧУ, А НЕ РАЗ НА ЛЮДИНУ. Заміряно 02.10.2026 на тижні 28.09–04.10: 7 людей мали
 * ОДНУ задачу на весь тиждень (вона покриває обидві частини — рахувати раз), а 11 — ДВІ, окремо на 28–30.09 і на
 * 01–02.10 (рахувати обидві). Правило «раз на людину» губило жовтневі 42 100 ₴, «раз на частину» подвоїло б 106 000.
 * Повертає автоплан по частинах і ручні цілі окремо — для розбивки під плиткою.
 */
export function foldWeek(cells: readonly WeekPlanCell[], blockStarts: readonly string[]):
    Map<number, { teamId: number | null; autoPerBlock: number[]; manual: number }> {
  const out = new Map<number, { teamId: number | null; autoPerBlock: number[]; manual: number }>();
  const counted = new Set<number>();
  for (const [bi, bf] of blockStarts.entries()) {
    for (const c of cells) {
      if (c.blockFrom !== bf) continue;
      const cur = out.get(c.managerId) ?? { teamId: c.teamId, autoPerBlock: blockStarts.map(() => 0), manual: 0 };
      if (c.manual != null && c.manualTaskId != null) {
        if (!counted.has(c.manualTaskId)) { counted.add(c.manualTaskId); cur.manual += c.manual; }
      } else cur.autoPerBlock[bi] += c.auto;
      out.set(c.managerId, cur);
    }
  }
  return out;
}
