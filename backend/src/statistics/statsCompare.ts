/**
 * 📐 ПОРІВНЯННЯ ОДНАКОВИХ ВІДРІЗКІВ (ТЗ «Статистики» 28.09.2026, блок 1; задачі 4603, 4367). Чисте — без БД.
 *
 * Було: плитка брала останню точку ряду й порівнювала з точкою «4 тижні тому» або попередньою —
 * тобто ПОНЕДІЛОК поточного тижня (1 день) з ПОВНИМ минулим тижнем. Звідси «Дохід ▼93%»,
 * якого не було. Тепер поточний відрізок завжди порівнюється з відрізком ТІЄЇ САМОЇ довжини:
 *   тиждень — пн..сьогодні  проти  пн..той самий день минулого тижня;
 *   місяць  — 1-ше..сьогодні проти  1-ше..той самий день минулого місяця (клампиться: 31.03 → 28/29.02).
 *   ПОВНИЙ місяць — проти ПОВНОГО попереднього, а не «до того самого числа» (задача Юлі 05.10.2026, «+79%»).
 *
 * 📐 ЧОМУ ПОВНИЙ ПРОТИ ПОВНОГО. Вересень (30 днів) порівнювався з серпнем 01–30.08 — 31.08 випадав, а того дня
 * закрили 879 520 ₴ (кінець місяця — день масового закриття в «Успішно»). Плитка показувала +79,9%
 * (2 994 959 проти 1 664 473), правильне +17,7% (проти 2 543 993). Для НЕПОВНОГО місяця «той самий відрізок»
 * лишається: 01–08.10 проти 01–08.09 — інакше половина місяця порівнювалась би з цілим.
 * Для неповного відрізка підпис «станом на <дата>» — щоб число не читалось як підсумок.
 *
 * Тиждень — календарний Пн–Нд (4367: «тиждень не захоплює понеділок наступного»).
 */

/** `range` — довільний період «з – по» (ТЗ 4632 п.2.3): порівнюється з тими самими датами минулого місяця. */
export type Gran = "week" | "month" | "range";
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

export function compareWindows(gran: Exclude<Gran, "range">, anchor: string): CompareWindows {
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
  const complete = day === last;
  const pDay = complete ? dim(py, pm0) : Math.min(day, dim(py, pm0));
  return {
    gran, full: { from, to: `${anchor.slice(0, 7)}-${String(last).padStart(2, "0")}` },
    cur: { from, to: anchor },
    prev: { from: pFrom, to: `${pFrom.slice(0, 7)}-${String(pDay).padStart(2, "0")}` },
    complete,
  };
}

/** Та сама дата місяцем раніше, з обрізкою кінця місяця (31.10 → 30.09, 31.03 → 28/29.02). */
export function sameDayPrevMonth(date: string): string {
  const y = Number(date.slice(0, 4)), m0 = Number(date.slice(5, 7)) - 1, day = Number(date.slice(8, 10));
  const py = m0 === 0 ? y - 1 : y, pm0 = m0 === 0 ? 11 : m0 - 1;
  return `${py}-${String(pm0 + 1).padStart(2, "0")}-${String(Math.min(day, dim(py, pm0))).padStart(2, "0")}`;
}

/**
 * 📅 ДОВІЛЬНИЙ ПЕРІОД «З – ПО» (ТЗ 4632 п.2.3–2.4, Юля 28.09: «до того ж періоду минулого місяця»).
 * Поточний відрізок — від `from` до `to`, але не далі сьогодні; попередній — ТІ САМІ дати місяцем раніше.
 * 23–25.09 → 23–25.08; період, що ще триває (23.09–05.10 на 01.10), порівнюється з 23.08–01.09 — ТІЄЇ САМОЇ довжини.
 */
export function rangeWindows(from: string, to: string, today: string): CompareWindows {
  const curTo = to < today ? to : today < from ? from : today;
  return {
    gran: "range", full: { from, to }, cur: { from, to: curTo },
    prev: { from: sameDayPrevMonth(from), to: sameDayPrevMonth(curTo) },
    complete: to <= today,
  };
}

const MONTH_GEN = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const dmy = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;

/**
 * 🏷 З ЧИМ ПОРІВНЯННЯ — ДАТАМИ, А НЕ «ДО ПОПЕРЕДНЬОГО» (ТЗ 4632 п.2.4: «підписати прямо, з чим порівняння»).
 * Без «до» на початку — екран сам ставить «до …». Одне правило для плиток і заголовка таблиці команд.
 */
export function compareLabel(w: CompareWindows): string {
  const span = `${dmy(w.prev.from)}–${dmy(w.prev.to)}`;
  if (w.gran === "week") return w.complete ? `минулого тижня (${span})` : `${span} (той самий відрізок минулого тижня)`;
  if (w.gran === "month") return w.complete ? `${MONTH_GEN[Number(w.prev.from.slice(5, 7)) - 1]} (${span})` : `${span} (ті самі дні минулого місяця)`;
  return `${span} (ті самі дати минулого місяця)`;
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

/**
 * План на графіку — лише до поточного періоду включно (точка = понеділок тижня або 1-ше місяця ≤ сьогодні).
 * 📐 Заміряно 02.10.2026 на справжньому екрані: без обрізки лінія тяглась до 26.10 і до 2 млн ₴ — майбутні тижні
 * Звіт ще не зафіксував, їхній автоплан рухається щодня. Ще й вісь X їхала в майбутнє, і «3 міс» зсувалось уперед.
 */
export function clipPlanToToday<T extends { points: { period: string }[] }>(plan: T[], today: string): T[] {
  return plan.map((p) => ({ ...p, points: clipPointsToToday(p.points, today) })).filter((p) => p.points.length > 0);
}

/**
 * Факт на графіку — теж лише до поточного періоду. 📐 Заміряно 02.10.2026 на «Поставлених»: угоди із ЗАПЛАНОВАНОЮ
 * датою завантаження давали точки 05.10 і 12.10 (5 і 1 авто) — лінія «падала» в майбутньому, а вікно «3 міс»
 * рахувалось від 12.10. Плитка «Відправлені авто» майбутніх завантажень не рахує; графік тепер теж.
 */
export function clipPointsToToday<P extends { period: string }>(points: P[], today: string): P[] {
  return points.filter((x) => x.period <= today);
}

/* 📋 «План-факт» (4632): рядок із чисел — чистий, щоб гейт перевіряв його без бази. */
export interface PlanFactLine {
  plan: number | null; fact: number; pct: number | null;
  /** План − факт, не менше нуля; `null` без плану. */
  remaining: number | null;
  /** Очікується за плановою датою оплати від сьогодні до кінця періоду (минулий період — 0). */
  expect: number;
  /** Скільки треба на робочий день до кінця періоду, щоб закрити залишок; минулий період або без плану — `null`. */
  needPerDay: number | null;
  avgCheck: number | null; successDeals: number;
  /** Розмови + спроби на менеджера за робочий день відрізка. */
  callsPerDay: number | null;
}
/** Рядок із чисел: % і залишок рахуються тут, один раз, для менеджера, команди й компанії однаково. */
export function planFactLine(x: { plan: number | null; fact: number; expect: number; avgRevenue: number; successDeals: number;
  calls: number; managerDays: number; workDaysLeft: number; complete: boolean }): PlanFactLine {
  const plan = x.plan != null && x.plan > 0 ? Math.round(x.plan) : null;
  const remaining = plan != null ? Math.max(0, plan - Math.round(x.fact)) : null;
  return {
    plan, fact: Math.round(x.fact), pct: planPct(x.fact, plan), remaining, expect: Math.round(x.expect),
    needPerDay: !x.complete && remaining != null && x.workDaysLeft > 0 ? Math.round(remaining / x.workDaysLeft) : null,
    avgCheck: x.successDeals > 0 ? Math.round(x.avgRevenue / x.successDeals) : null, successDeals: x.successDeals,
    callsPerDay: x.managerDays > 0 ? Math.round((x.calls / x.managerDays) * 10) / 10 : null,
  };
}

