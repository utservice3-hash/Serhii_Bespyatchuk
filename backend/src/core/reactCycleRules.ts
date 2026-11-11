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
 *  1. «Реактивую сам» — ЗІ СТРОКОМ (з 01.10.2026 — 4 тижні від натискання, див. нижче; до того — до кінця
 *     наступного місяця). Повторно продовжити строк кнопкою не можна — інакше строку немає;
 *  2. у пул ідуть УСІ без рахунку, навіть давні — без обмеження давністю;
 *  3. гроші — як є, за менеджером угоди в Kommo (тут нічого не рахується).
 *
 * 📐 «3 МІСЯЦІ» — ПОВНІ КАЛЕНДАРНІ. Останній рахунок у травні → червень, липень, серпень без рахунку →
 * 1 вересня клієнт у реактивації; вересень — його «4-й місяць». Рахунок у поточному місяці повертає
 * клієнта одразу. Усе за Києвом (дата рахунку приходить уже київською, `money.lastInvoiceByClientKey`).
 *
 * 📅 ЩОТИЖНЯ ЗАМІСТЬ РАЗ НА МІСЯЦЬ (рішення Романа 01.10.2026, підтвердила Юля; задача 4313). Перша
 * редакція передавала в пул 1-го числа — і 01.11 віддала б лідгенам ~490 клієнтів за ніч («до хвиль вони не
 * готові»). Тепер:
 *  · менеджер має `DECISION_DAYS` (4 тижні) від входу в реактивацію (1-ше число 4-го місяця);
 *  · «Реактивую сам» — `SELF_GRACE_DAYS` (4 тижні) від дня натискання;
 *  · строк минув → передача в НАЙБЛИЖЧИЙ ПОНЕДІЛОК, не раніше 08:00 за Києвом (`transferWindowOpen`);
 *  · за тиждень у пул іде не більше `WEEKLY_CAP` (100), черга — від найсвіжішого останнього рахунку
 *    (таких легше повернути); хто не вмістився — наступного понеділка;
 *  · нинішній хвіст (цикл `LAUNCH_MONTH`) — до передачі з `LAUNCH_RELEASE` (пн 05.10.2026), порціями по 100.
 * Тримають `#1210`–`#1215`.
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
/** Скільки днів менеджер має на рішення від входу в реактивацію (1-ше число 4-го місяця). */
export const DECISION_DAYS = 28;
/** «Реактивую сам»: скільки днів від натискання клієнт лишається за менеджером. */
export const SELF_GRACE_DAYS = 28;
/** Скільки клієнтів за тиждень автоматично йде в пул (ручна передача менеджером — без межі). */
export const WEEKLY_CAP = 100;
/** Перший понеділок, з якого до передачі хвіст циклу `LAUNCH_MONTH` (рішення Романа 01.10.2026). */
export const LAUNCH_RELEASE = "2026-10-05";
/** Година за Києвом, з якої в понеділок відкрито передачу. */
export const TRANSFER_HOUR = 8;

export type Decision = "self" | "leadgen";
/** `orphan` — клієнт прийшов із «Нічийних»: менеджер віддав, ніхто не взяв за робочий день (задача 8135). */
export type PoolReason = "manager" | "auto" | "self_expired" | "orphan";
export type CycleStatus = "waiting" | "self" | "pool" | "taken";

/** Рядок `client_react_cycles` у формі, потрібній правилу. Місяці — `YYYY-MM`. */
export interface CycleRow {
  cycleMonth: string;
  decision: Decision | null;
  /** День рішення за Києвом, `YYYY-MM-DD`. */
  decidedDate: string | null;
  pooled: boolean;
  poolReason: PoolReason | null;
  closed: boolean;
  closeReason: "invoice" | "taken" | "pool_off" | null;
}

/** `YYYY-MM` + n місяців. Анкер на 1-ше число — 31-ше не перескакує місяць (борг 19 у CLAUDE.md). */
export function addMonths(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` + n днів (у UTC-числах — без зсуву годинника). */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Понеділок того тижня, якому належить день. */
export function weekMonday(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();   // 0 — неділя
  return addDays(ymd, -((dow + 6) % 7));
}

/** Перший понеділок, що НЕ раніше за день. */
export function mondayOnOrAfter(ymd: string): string {
  const m = weekMonday(ymd);
  return m === ymd ? m : addDays(m, 7);
}

/** Чи відкрита передача: у понеділок — лише з `TRANSFER_HOUR`, решту днів тижня — так (добір пропущеного понеділка). */
export function transferWindowOpen(todayYmd: string, kyivHour: number): boolean {
  return !(weekMonday(todayYmd) === todayYmd && kyivHour < TRANSFER_HOUR);
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

/**
 * 🧭 ЧИ ОЖИВ КЛІЄНТ У ПУЛІ — рядок пулу закривається (`invoice`) і лідгену не дістається.
 * Звичайний рядок (реактивація) — за правилом реактивації: є рахунок за 3 місяці → ожив (4.4).
 * Рядок `orphan` (з «Нічийних», 8135) — інакше: такий клієнт міг мати рахунок і місяць тому (віддають
 * «не спрацювались», а не «заснув»), тож ожилим він стає лише від рахунку ПІЗНІШЕ за день, коли його поклали.
 * Інакше нічний прохід закривав би рядок `orphan` тієї ж ночі, і клієнт зникав би з пулу, не дійшовши до лідгена.
 */
export function poolRevived(p: { poolReason: PoolReason | null; pooledDay: string | null; lastInvoice: string | null }, nowYm: string): boolean {
  if (p.poolReason === "orphan") return p.lastInvoice != null && p.pooledDay != null && p.lastInvoice > p.pooledDay;
  return !inReact(p.lastInvoice, nowYm);
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
 * ПОНЕДІЛОК, з якого клієнт до автопередачі (найраніший; черга по `WEEKLY_CAP` може відсунути на тиждень-
 * другий). `null` — строку немає (клієнт уже в пулі або взятий лідгеном).
 */
export function transferMonday(cycleMonth: string, row: CycleRow | null): string | null {
  const st = statusOf(row);
  if (st === "waiting") {
    return cycleMonth === LAUNCH_MONTH ? LAUNCH_RELEASE : mondayOnOrAfter(addDays(`${cycleMonth}-01`, DECISION_DAYS));
  }
  if (st === "self") return mondayOnOrAfter(addDays(row!.decidedDate ?? `${cycleMonth}-01`, SELF_GRACE_DAYS));
  return null;
}

/** Чи вже до передачі цього тижня (4.3 + рішення 01.10): понеділок передачі настав. */
export function autoDue(cycleMonth: string, row: CycleRow | null, todayYmd: string): boolean {
  const dl = transferMonday(cycleMonth, row);
  return dl != null && dl <= weekMonday(todayYmd);
}

/** Причина автопередачі — щоб у пулі було видно, чи менеджер мовчав, чи не встиг за власним строком. */
export function autoReason(row: CycleRow | null): PoolReason {
  return statusOf(row) === "self" ? "self_expired" : "auto";
}

/** Днів до понеділка передачі (0 — цього тижня вже до передачі). */
export function daysLeft(transferYmd: string, todayYmd: string): number {
  return Math.max(0, Math.round((Date.parse(`${transferYmd}T00:00:00Z`) - Date.parse(`${todayYmd}T00:00:00Z`)) / 86400000));
}

/** Які кнопки дозволені зараз. «Сам» — лише раз за цикл; «лідгенам» — доки клієнт не в пулі. */
export function allowedDecisions(row: CycleRow | null): Decision[] {
  // 🚫 Рядок старого пулу, закритий 11.11.2026 (`pool_off`): рішення в цьому циклі вже було — повторний запис
  // відхилив би ON CONFLICT, тож кнопку не пропонуємо, щоб не вести в 409.
  if (row?.closeReason === "pool_off") return [];
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
  /** До передачі, але не вмістились у тижневу межу — підуть наступного понеділка (для логу). */
  deferred: number;
}

/**
 * Прохід як ЧИСТА функція: що перенести в пул, що закрити. Застосування — окремо, SQL-ом.
 * `rows` — рядки циклів по ключах (будь-які місяці); `openPools` — відкриті рядки пулу.
 * `transfer` — чи відкрита передача зараз (`transferWindowOpen`); `pooledThisWeek` — скільки вже передано
 * автоматично цього тижня (межа `WEEKLY_CAP` — на тиждень, тож повторний прогін її не перевищить).
 * Закриття ожилих — щоразу, незалежно від дня.
 */
export function planSweep(
  candidates: Candidate[], rows: Map<string, CycleRow[]>,
  openPools: { clientKey: string; cycleMonth: string; lastInvoice: string | null; poolReason?: PoolReason | null; pooledDay?: string | null }[],
  todayYmd: string,
  opts: { transfer: boolean; pooledThisWeek: number } = { transfer: true, pooledThisWeek: 0 },
): SweepActions {
  const nowYm = todayYmd.slice(0, 7);
  const actions: SweepActions = { pool: [], close: [], deferred: 0 };
  for (const p of openPools) {
    // 🧭 Рядок `orphan` живе за власним правилом «ожив» (`poolRevived`), інакше закрився б тієї ж ночі.
    if (poolRevived({ poolReason: p.poolReason ?? null, pooledDay: p.pooledDay ?? null, lastInvoice: p.lastInvoice }, nowYm)) {
      actions.close.push({ clientKey: p.clientKey, cycleMonth: p.cycleMonth });
    }
  }
  const due: { c: Candidate; cm: string; row: CycleRow | null }[] = [];
  for (const c of candidates) {
    if (!inReact(c.lastInvoice, nowYm) || c.debtHold) continue;
    const cm = cycleMonthOf(c.lastInvoice);
    const row = (rows.get(c.clientKey) ?? []).find((r) => r.cycleMonth === cm) ?? null;
    // Клієнт уже в пулі за іншим (старим) циклом — не дублюємо; той рядок закриється або візьметься.
    const openElsewhere = (rows.get(c.clientKey) ?? []).some((r) => r.pooled && !r.closed && r.cycleMonth !== cm);
    if (openElsewhere) continue;
    if (autoDue(cm, row, todayYmd)) due.push({ c, cm, row });
  }
  if (!opts.transfer) return actions;
  // Черга: спершу найсвіжіший останній рахунок (таких легше повернути), без рахунку — в кінці; далі ключ —
  // щоб порядок не залежав від порядку рядків у запиті.
  due.sort((a, b) => (b.c.lastInvoice ?? "").localeCompare(a.c.lastInvoice ?? "") || a.c.clientKey.localeCompare(b.c.clientKey));
  const room = Math.max(0, WEEKLY_CAP - opts.pooledThisWeek);
  for (const d of due.slice(0, room)) {
    actions.pool.push({ clientKey: d.c.clientKey, cycleMonth: d.cm, reason: autoReason(d.row), fromManagerId: d.c.managerId });
  }
  actions.deferred = Math.max(0, due.length - room);
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

/**
 * 🚫 ПЕРЕДАЧУ ЛІДГЕНАМ ВИМКНЕНО (Сергій, TOP Weekly 29.10.2026 і задача 7367 31.10: «вимкнути передачу
 * реактивації лідгенам з 01.11»; правка Олександра в 6437; Роман 06.11.2026: «просто вимкни і все»).
 *
 * Вимикається ВСЕ, що кладе клієнта в пул: понеділкова автопередача (`auto`, `self_expired`) і кнопка
 * «Передати лідгенам» (`manager`). Вкладку «Пул лідгенів» не бачить ніхто, «Взяти» закрите.
 *
 * 🔴 ДАНІ НЕ ЧІПАЄМО. Ті, хто вже в пулі (544 на 06.11.2026, жодного не взяв лідген), і так рахувались за
 * своїм менеджером — пул жив лише в дашборді (`reactCycle.ts`, шапка). Тепер вони показуються звичайними
 * клієнтами реактивації. Закриття «ожилих» рядків пулу (є рахунок) іде як і йшло.
 *
 * Чисті правила вище НЕ змінено: перемикач стоїть на краях (джоба, роут, вигляд циклу), тож повернути
 * передачу = `true` тут, без переписування правила й гейтів `#840`–`#848`, `#1210`–`#1215`.
 */
export const LEADGEN_POOL_ENABLED = false;

/**
 * 🧭 ЕКРАН «ПУЛ ЛІДГЕНІВ» — ЗНОВУ ВИДНО (задачі 8135 + 8349, ТЗ Юлі 09.11.2026 у 8850; Роман 11.11.2026).
 * Пул повертається ІНШИМ шляхом: не передачею з реактивації (вона лишається вимкненою — `LEADGEN_POOL_ENABLED`),
 * а з «Нічийних» — клієнт, якого менеджер віддав і ніхто не взяв за робочий день (`pool_reason = 'orphan'`).
 * Тому вимикачів ДВА: що кладе клієнтів у пул (старе — вимкнено) і чи видно сам пул (так — лідгенам і керівництву).
 * Старі 545 рядків закрито `pool_off` (Роман 11.11, п.4) — у пулі лише ті, хто прийшов із нічийних.
 */
export const LEADGEN_POOL_SCREEN = true;

/** Чи відкрита передача зараз — з урахуванням вимикача. Джоба питає саме це, а не голе вікно. */
export function poolTransferOpen(todayYmd: string, kyivHour: number, enabled = LEADGEN_POOL_ENABLED): boolean {
  return enabled && transferWindowOpen(todayYmd, kyivHour);
}

/** Доступ до пулу з урахуванням вимикача ЕКРАНА (`LEADGEN_POOL_SCREEN`): вимкнено — не бачить і не бере ніхто. */
export function poolAccessNow(isLeadgen: boolean, isAdminScope: boolean, screen = LEADGEN_POOL_SCREEN): { canSee: boolean; canTake: boolean } {
  return screen ? poolAccess(isLeadgen, isAdminScope) : { canSee: false, canTake: false };
}

/** Кнопки циклу з урахуванням вимикача: вимкнено — «Передати лідгенам» не пропонується. */
export function decisionsNow(row: CycleRow | null, enabled = LEADGEN_POOL_ENABLED): Decision[] {
  const d = allowedDecisions(row);
  return enabled ? d : d.filter((x) => x !== "leadgen");
}

/**
 * Стан для показу з урахуванням вимикача: передачу вимкнено — рядок пулу зі СТАРОЇ передачі показується як звичайна
 * реактивація; рядок `orphan` (з «Нічийних», 8135) — це справжній пул, і він лишається «у пулі».
 */
export function statusNow(row: CycleRow | null, enabled = LEADGEN_POOL_ENABLED): CycleStatus {
  const st = statusOf(row);
  return !enabled && st === "pool" && row?.poolReason !== "orphan" ? "waiting" : st;
}
