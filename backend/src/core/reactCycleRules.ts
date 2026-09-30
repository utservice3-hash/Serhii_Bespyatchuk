/**
 * 🔁 ЦИКЛ РЕАКТИВАЦІЇ — ЧИСТЕ ПРАВИЛО (ТЗ Юлі 22.09.2026, блок 4; задача 4313). Без БД: гейти бігають скрізь.
 *
 * ТЗ:
 *  4.1 3 місяці без виставлених рахунків → на початку 4-го місяця клієнт падає у вкладку «Реактивація»
 *      відповідального менеджера;
 *  4.2 дві кнопки: «Реактивую сам» (лишається за менеджером) і «Передати лідгенам» (у пул лідгенів);
 *  4.3 немає рахунку й немає дії до кінця 4-го місяця → автоматично в пул;
 *  4.4 лідген не бачить і не бере клієнта з відповідальним і рахунком за останні 3 місяці.
 *
 * Рішення Романа 30.09.2026 на три відкриті питання:
 *  1. «Реактивую сам» — ЗІ СТРОКОМ: нема рахунку до кінця НАСТУПНОГО місяця після натискання → у пул.
 *     Повторно продовжити строк кнопкою не можна — інакше строку немає;
 *  2. у пул ідуть УСІ без рахунку, навіть давні — без обмеження давністю;
 *  3. гроші — як є, за менеджером угоди в Kommo (тут нічого не рахується).
 *
 * 📐 «3 МІСЯЦІ» — ПОВНІ КАЛЕНДАРНІ. Останній рахунок у травні → червень, липень, серпень без рахунку →
 * 1 вересня клієнт у реактивації; вересень — його «4-й місяць». Рахунок у поточному місяці повертає
 * клієнта одразу. Усе за Києвом (дата рахунку приходить уже київською, `money.lastInvoiceByClientKey`).
 *
 * 🔴 СТАРТ — НЕ З ІСТОРІЇ, А З `LAUNCH_MONTH`. На день викату без рахунку з червня було 706 клієнтів
 * (+72 з 01.10). Якби цикл рахувався від справжнього «4-го місяця», перша ж ніч скинула б сотні клієнтів у
 * пул, і менеджери не натиснули б жодної кнопки. Тому для всіх, хто вже в реактивації, 4-й місяць =
 * жовтень 2026, і перша автопередача — у ніч на 01.11.2026. Тримає #842.
 */

/** Перший «4-й місяць» для всіх, хто вже був у реактивації на день викату. */
export const LAUNCH_MONTH = "2026-10";
/** Скільки повних місяців без рахунку кладуть клієнта в реактивацію. */
export const QUIET_MONTHS = 3;
/** «Реактивую сам»: ще стільки місяців ПІСЛЯ місяця натискання. */
export const SELF_GRACE_MONTHS = 1;

export type Decision = "self" | "leadgen";
export type PoolReason = "manager" | "auto" | "self_expired";
export type CycleStatus = "waiting" | "self" | "pool" | "taken";

/** Рядок `client_react_cycles` у формі, потрібній правилу. Місяці — `YYYY-MM`. */
export interface CycleRow {
  cycleMonth: string;
  decision: Decision | null;
  decidedMonth: string | null;
  pooled: boolean;
  poolReason: PoolReason | null;
  closed: boolean;
  closeReason: "invoice" | "taken" | null;
}

/** `YYYY-MM` + n місяців. Анкер на 1-ше число — 31-ше не перескакує місяць (борг 19 у CLAUDE.md). */
export function addMonths(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

/** Останній день місяця `YYYY-MM` → `YYYY-MM-DD`. */
export function lastDayOf(ym: string): string {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

/**
 * У реактивації ЗАРАЗ? Немає жодного рахунку з 1-го числа місяця (поточний − 3).
 * Рахунку не було ніколи → так (клієнт є в базі постійних, а рахунку не має — він точно не «живий»).
 */
export function inReact(lastInvoice: string | null, nowYm: string): boolean {
  if (!lastInvoice) return true;
  return addMonths(lastInvoice.slice(0, 7), QUIET_MONTHS + 1) <= nowYm;
}

/** Місяць циклу: «4-й місяць» без рахунку, але не раніше за старт механізму. */
export function cycleMonthOf(lastInvoice: string | null): string {
  if (!lastInvoice) return LAUNCH_MONTH;
  const fourth = addMonths(lastInvoice.slice(0, 7), QUIET_MONTHS + 1);
  return fourth > LAUNCH_MONTH ? fourth : LAUNCH_MONTH;
}

/** Стан циклу для показу. Рядок іншого циклу (старий, до останнього рахунку) не рахується. */
export function statusOf(row: CycleRow | null): CycleStatus {
  if (!row) return "waiting";
  if (row.closeReason === "taken") return "taken";
  if (row.pooled && !row.closed) return "pool";
  if (row.decision === "self") return "self";
  return "waiting";
}

/**
 * Останній місяць, у якому рахунок або дія ще рятують від автопередачі. `null` — строку немає
 * (клієнт уже в пулі або взятий лідгеном).
 */
export function deadlineMonth(cycleMonth: string, row: CycleRow | null): string | null {
  const st = statusOf(row);
  if (st === "waiting") return cycleMonth;
  if (st === "self") return addMonths(row!.decidedMonth ?? cycleMonth, SELF_GRACE_MONTHS);
  return null;
}

/** Чи пора автоматично класти в пул (4.3 + рішення 1). */
export function autoDue(cycleMonth: string, row: CycleRow | null, nowYm: string): boolean {
  const dl = deadlineMonth(cycleMonth, row);
  return dl != null && nowYm > dl;
}

/** Причина автопередачі — щоб у пулі було видно, чи менеджер мовчав, чи не встиг за власним строком. */
export function autoReason(row: CycleRow | null): PoolReason {
  return statusOf(row) === "self" ? "self_expired" : "auto";
}

/** Днів до автопередачі (включно з сьогодні до кінця дедлайн-місяця). */
export function daysLeft(deadlineYm: string, todayYmd: string): number {
  return Math.round((Date.parse(`${lastDayOf(deadlineYm)}T00:00:00Z`) - Date.parse(`${todayYmd}T00:00:00Z`)) / 86400000);
}

/** Які кнопки дозволені зараз. «Сам» — лише раз за цикл; «лідгенам» — доки клієнт не в пулі. */
export function allowedDecisions(row: CycleRow | null): Decision[] {
  const st = statusOf(row);
  if (st === "waiting") return ["self", "leadgen"];
  if (st === "self") return ["leadgen"];
  return [];
}

export interface Candidate {
  clientKey: string;
  lastInvoice: string | null;
  managerId: number | null;
  /** Прострочена дебіторка: боржника в реактивацію не ведемо (правило «Дебіторка ↔ Реактивація»). */
  debtHold: boolean;
}

export interface SweepActions {
  pool: { clientKey: string; cycleMonth: string; reason: PoolReason; fromManagerId: number | null }[];
  /** Відкриті рядки пулу, чий клієнт ожив (зʼявився рахунок) — закрити з причиною `invoice`. */
  close: { clientKey: string; cycleMonth: string }[];
}

/**
 * Нічний прохід як ЧИСТА функція: що перенести в пул, що закрити. Застосування — окремо, SQL-ом.
 * `rows` — рядки циклів по ключах (будь-які місяці); `openPools` — відкриті рядки пулу.
 */
export function planSweep(
  candidates: Candidate[], rows: Map<string, CycleRow[]>,
  openPools: { clientKey: string; cycleMonth: string; lastInvoice: string | null }[], nowYm: string,
): SweepActions {
  const actions: SweepActions = { pool: [], close: [] };
  for (const p of openPools) {
    if (!inReact(p.lastInvoice, nowYm)) actions.close.push({ clientKey: p.clientKey, cycleMonth: p.cycleMonth });
  }
  for (const c of candidates) {
    if (!inReact(c.lastInvoice, nowYm) || c.debtHold) continue;
    const cm = cycleMonthOf(c.lastInvoice);
    const row = (rows.get(c.clientKey) ?? []).find((r) => r.cycleMonth === cm) ?? null;
    // Клієнт уже в пулі за іншим (старим) циклом — не дублюємо; той рядок закриється або візьметься.
    const openElsewhere = (rows.get(c.clientKey) ?? []).some((r) => r.pooled && !r.closed && r.cycleMonth !== cm);
    if (openElsewhere) continue;
    if (autoDue(cm, row, nowYm)) {
      actions.pool.push({ clientKey: c.clientKey, cycleMonth: cm, reason: autoReason(row), fromManagerId: c.managerId });
    }
  }
  return actions;
}

/**
 * 4.2/4.4 — хто бачить пул і хто бере. Лідген (член команди «Лідогенерація») бачить і бере — собі;
 * керівництво (`isAdminScope`) бачить, але не бере: у нього немає менеджерського акаунта, на який
 * закріпити клієнта. Решта не бачить пулу взагалі.
 */
export function poolAccess(isLeadgen: boolean, isAdminScope: boolean): { canSee: boolean; canTake: boolean } {
  return { canSee: isLeadgen || isAdminScope, canTake: isLeadgen };
}
