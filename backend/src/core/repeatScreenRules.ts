/**
 * 👥 ЕКРАН «ПОСТІЙНІ КЛІЄНТИ» ПІСЛЯ TOP WEEKLY 12.10 (задача 5609, ТЗ Юлі 12.10.2026; регламент ред. 2) — чисті правила
 * нових карток і позначок. Без БД: роут збирає факти, тут — лише рішення, щоб гейт довів їх на власній фікстурі.
 *
 * Відповіді Романа на розділ 7 ТЗ (13.10.2026, Юлія затверджує):
 *  · «Плюс / мінус до середнього» — ТОЙ САМИЙ ВІДРІЗОК МІСЯЦЯ: з 1-го до сьогодні проти середнього за ті самі дні
 *    трьох попередніх місяців. Не «середнє × частка днів»: замовлення нерівномірні, пропорція давала б хибний мінус
 *    на початку місяця. Минулий (закритий) місяць — повний проти трьох повних.
 *  · «Замовляли раніше» — ті самі 3 попередні ПОВНІ місяці: тоді «не замовили» і «мінус до середнього» говорять про
 *    одних і тих самих клієнтів.
 * Гроші — «з рахунку і далі», як решта цього екрана (`money.fromInvoiceByClientKey`).
 */

export interface DayWindow { from: string; to: string }

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const monthStartOf = (ym: string, back: number): Date => {
  const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - back); return d;
};
const monthEndOf = (start: Date): Date => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));

/**
 * Вікна порівняння для місяця екрана `month` (YYYY-MM) і київського «сьогодні» (YYYY-MM-DD).
 * `prev` — три попередні місяці, кожен від 1-го до того самого дня (день, якого в місяці немає, — до його кінця);
 * `before` — три попередні ПОВНІ місяці одним відрізком («замовляли раніше»).
 */
export function sameWindows(month: string, today: string): { partial: boolean; day: number; prev: DayWindow[]; before: DayWindow } {
  const partial = today.slice(0, 7) === month;
  const day = partial ? Number(today.slice(8, 10)) : 31;
  const prev = [1, 2, 3].map((back) => {
    const s = monthStartOf(month, back), e = monthEndOf(s);
    const to = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), Math.min(day, e.getUTCDate())));
    return { from: ymd(s), to: ymd(to) };
  });
  const bS = monthStartOf(month, 3), bE = monthEndOf(monthStartOf(month, 1));
  return { partial, day, prev, before: { from: ymd(bS), to: ymd(bE) } };
}

/** Різниця з середнім трьох вікон. Вікно без замовлень — нуль, а не «немає даних»: клієнт тоді справді не платив. */
export function deltaVsAvg(cur: number, prev: readonly number[]): { avg: number; delta: number } {
  const avg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
  return { avg: Math.round(avg), delta: Math.round(cur - avg) };
}

/**
 * Період «без роботи», днів — ЗА ЗАМОВЧУВАННЯМ. Справжнє значення — налаштування `noWorkDays` (Налаштування → Загальні),
 * роут читає його й передає сюди (ядро `app_settings` не читає — гейт `#6 КОНФІГ`). Остаточне число погоджується із
 * Сергієм (задача 6455).
 */
export const NO_WORK_DAYS = 30;
export const NO_WORK_DAYS_MIN = 7;
export const NO_WORK_DAYS_MAX = 180;

/** Перший день періоду «без роботи»: `today − days`, обидва кінці включно (за Києвом). */
export function noWorkFrom(today: string, days: number): string {
  const d = new Date(`${today.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface WorkInput {
  /** Угода «від рахунку» за період або зараз у роботі на такому етапі (`clientWorkProof.invoiceProofByClientKey`). */
  invoice: { kommoId: number } | null;
  /** Оплата від клієнта у Виписці за період (`clientWorkProof.paymentProofByClientKey`). */
  payment: { at: string } | null;
  /** Відкритий наступний крок у картці клієнта і його дата (може бути без дати). */
  stepOpen: boolean; stepDue: string | null;
  /** Відкрита задача по клієнту в Задачнику і її строк. */
  taskOpen: boolean; taskDue: string | null;
  today: string;
}

/**
 * Позначки рядка. «Задача» по клієнту — відкритий наступний крок у картці АБО відкрита задача в Задачнику.
 *  · `noWork` (задача 6455, правило Сергія 20.10.2026): за період НЕМАЄ ні угоди на етапі «Виставлення рахунку» або
 *    далі, ні оплати від клієнта у Виписці. Розмови, ручні контакти, кроки й задачі роботу не підтверджують (до
 *    23.10.2026 підтверджували — регламент ред. 2, п.4.2);
 *  · `noTask` — немає жодної відкритої задачі чи кроку;
 *  · `overdue` — дата відкритої задачі чи кроку вже минула.
 */
export function workFlags(w: WorkInput): { noWork: boolean; noTask: boolean; overdue: boolean } {
  const late = (open: boolean, due: string | null) => open && due != null && due.slice(0, 10) < w.today;
  return {
    noWork: w.invoice == null && w.payment == null,
    noTask: !w.stepOpen && !w.taskOpen,
    overdue: late(w.stepOpen, w.stepDue) || late(w.taskOpen, w.taskDue),
  };
}
