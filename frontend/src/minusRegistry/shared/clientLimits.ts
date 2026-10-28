/**
 * «Ліміти клієнтів» — вкладка розділу «Дебіторська заборгованість» (рішення Сергія 23.10). Спільне для сервера, вкладки й макета.
 *
 * Один реєстр погоджених умов з клієнтами: ліміт боргу (грн) і відтермінування (днів, від чого рахувати). Джерела:
 *   req  — погоджено запитом «Узгодження роботи з новим контрагентом»;
 *   debt — перенесено з дебіторки (ліміти, що досі жили на рахунках; один ліміт — на обʼєднаного клієнта з кількох юросіб);
 *   set  — задав Сергій боржнику, з яким умови не погоджено.
 * Боржники з дебіторки без ліміту показуються окремими рядками «Ліміт не узгоджено» (src 'none').
 * Борг і прострочка — з дебіторки (DebtSource на сервері). Колонка «Ліміти» активної дебіторки читає ці ліміти.
 * Щомісяця — перевірка судів по ВСІХ клієнтах з лімітом, по кожній юрособі.
 */
import { canSubmit, inMyTeam, seesAll, type ChangeReq, type CpUser, type Entity, type Flag, type From, type PayForm, type Terms } from './counterparty.js';
import { DEFAULT_LAG, type Lag } from './cpCalc.js';
import { dt } from './cpFormat.js';

export type LimitSrc = 'req' | 'debt' | 'set';
export interface Member { code: string; name: string }
export type LimitEventType = 'approved' | 'approvedChanged' | 'changeApproved' | 'changeRequested' | 'changeRejected' | 'limitChanged'
  | 'suspended' | 'migrated' | 'limitSet' | 'limSuspended' | 'kept' | 'ended' | 'planned';
export interface LimitEvent { type: LimitEventType; by: string | null; byName: string | null; at: string; note: string }
export const LIMIT_EVENT_LABEL: Record<LimitEventType, string> = {
  approved: 'Погоджено',
  approvedChanged: 'Погоджено з іншими умовами',
  changeApproved: 'Зміну умов погоджено',
  changeRequested: 'Запит на зміну умов',
  changeRejected: 'Зміну умов відхилено — діють попередні',
  limitChanged: 'Ліміт змінено',
  suspended: 'Погодження призупинено — нова справа',
  migrated: 'Перенесено з дебіторки',
  limitSet: 'Ліміт задано',
  limSuspended: 'Ліміт призупинено — нова справа в суді',
  kept: 'Ліміт лишено після перевірки судів',
  ended: 'Ліміт знято',
  planned: 'Перевірка YouControl',
};
export const LIMIT_EVENT_TONE: Record<LimitEventType, 'mut' | 'warn' | 'info' | 'ok' | 'bad'> = {
  approved: 'ok', approvedChanged: 'ok', changeApproved: 'ok', changeRequested: 'warn', changeRejected: 'bad', limitChanged: 'ok',
  suspended: 'bad', migrated: 'info', limitSet: 'ok', limSuspended: 'bad', kept: 'ok', ended: 'mut', planned: 'mut',
};

export interface ClientLimit {
  id: string;
  src: LimitSrc;
  requestId: string | null;    // req — запит, яким погоджено
  debtorKey: string | null;    // ключ боржника в дебіторці (обʼєднаний клієнт), якщо відомий
  name: string;
  kind: string;
  members: Member[];           // юрособи клієнта; перша — основна
  limit: number | null;        // ліміт боргу, грн (null — суму не погоджено)
  days: number | null;         // відтермінування, днів (null — дні не погоджено)
  from: From;
  ent: Entity | null;
  pay: PayForm | null;
  terms: Terms | null;         // req — погоджені умови повністю
  managerId: string;
  managerName: string;
  at: string;                  // коли погоджено / перенесено / задано
  note: string;                // debt — звідки ліміт («діяв на рахунках з березня 2025»)
  flag: Flag | null;           // нова справа в суді: req — з запиту, debt / set — з самого ліміту
  suspended: boolean;          // req — погодження призупинено; debt / set — є flag
  change: ChangeReq | null;    // req — запит менеджера на зміну умов
  /** Планова перевірка знайшла зміни (новий власник / директор, нові виконавчі, «особлива увага» в експрес-аналізі) — 30 днів. Не призупиняє. */
  notice: { at: string; what: string } | null;
  /** Остання перевірка YouControl основної юрособи (для «Перевірити» / «Відкрити» в панелі). */
  lastCheck: { id: string; at: string } | null;
  hist: LimitEvent[];
}
/** Борг з дебіторки. odDays — найбільша прострочка в днях, odSum — прострочена сума. */
export interface DebtInfo { debt: number; odDays: number; odSum: number }
export interface LimitRow extends ClientLimit, DebtInfo { over: boolean; use: number; alert: boolean }
/** Боржник з дебіторки, з яким умови не погоджено. ageDays — скільки днів найстаріший борг без оплати. */
export interface NoLimitRow { id: string; src: 'none'; debtorKey: string; name: string; kind: string; members: Member[]; managerId: string; managerName: string; debt: number; ageDays: number }
export type AnyRow = LimitRow | NoLimitRow;
export const isNoLimit = (x: AnyRow): x is NoLimitRow => x.src === 'none';

/**
 * Боржник з дебіторки (рядок «Боржники» активної дебіторки; обʼєднаний клієнт — один Debtor з кількома кодами).
 * Дає сервер з ваших даних (1С / CRM) — server/debtSource.ts.
 */
export interface Debtor {
  key: string;                 // ваш ідентифікатор боржника (групи) в дебіторці
  name: string;
  kind?: string;               // «ТОВ», «ФОП»… — якщо відомо
  codes: string[];             // ЄДРПОУ / ІПН юросіб боржника (якщо 1С їх віддає)
  managerId: string | null;    // users.id «Відповідального»
  managerName?: string;
  debt: number;                // борг зараз, грн
  odDays: number;              // найбільша прострочка, днів
  odSum: number;               // прострочена сума, грн
  ageDays: number;             // скільки днів найстаріший неоплачений рахунок
}
/** Ліміт ↔ боржник: ключ боржника збігається з debtorKey ліміту, АБО хоч одна юрособа ліміту є серед кодів боржника. */
export const matches = (l: Pick<ClientLimit, 'debtorKey' | 'members'>, d: Pick<Debtor, 'key' | 'codes'>) =>
  (!!l.debtorKey && l.debtorKey === d.key) || d.codes.some(c => l.members.some(m => m.code === c));
/**
 * Клієнт із нашої бази (угоди CRM + дебіторка) — для «＋ Додати клієнта» (Сергій, UTS TOP Weekly 26.10: «сюди додати всіх
 * клієнтів, які в нас є в нашій базі… по назві або по коду»). Дає сервер — counterparty/clientDirectoryDb.ts.
 */
export interface ClientHit {
  key: string;                 // client_key — той самий ключ, що й у дебіторці (60 з 67 боржників, 28.10)
  name: string;
  codes: string[];             // ЄДРПОУ / ІПН — з компаній CRM і рахунків 1С
  managerId: string | null;    // users.id відповідального (з дебіторки, інакше — з останньої угоди)
  managerName: string;
  deals: number;               // угод у CRM
  lastDealAt: string | null;
  debtor: boolean;             // зараз є борг у дебіторці
}
/** Пошук: 8 або 10 цифр — код (ЄДРПОУ / ІПН); інакше — назва від 2 знаків; коротше — шукати нічого. */
export function clientQuery(q: string): { code: string } | { text: string } | null {
  const s = q.trim();
  if (/^\d{8}$|^\d{10}$/.test(s)) return { code: s };
  return s.length >= 2 ? { text: s } : null;
}
/** Діючий ліміт, що вже покриває клієнта бази — за ключем або за кодом юрособи (те саме правило, що й ліміт ↔ боржник). */
export const limitOfClient = (limits: Array<Pick<ClientLimit, 'id' | 'debtorKey' | 'members'>>, h: Pick<ClientHit, 'key' | 'codes'>): string | null =>
  limits.find(l => matches(l, { key: h.key, codes: h.codes }))?.id ?? null;

/** Рядки вкладки: ліміти з боргом + боржники з боргом без ліміту. cells — що показати в колонці «Ліміти» активної дебіторки по кожному боржнику. */
export function buildRows(limits: ClientLimit[], debtors: Debtor[]): { rows: AnyRow[]; cells: Record<string, DebtorLimitCell> } {
  const rows: AnyRow[] = [], used = new Set<string>(), cells: Record<string, DebtorLimitCell> = {};
  for (const l of limits) {
    const ds = debtors.filter(d => matches(l, d));
    ds.forEach(d => used.add(d.key));
    const row = withDebt(l, ds.length ? { debt: ds.reduce((a, d) => a + d.debt, 0), odDays: Math.max(...ds.map(d => d.odDays)), odSum: ds.reduce((a, d) => a + d.odSum, 0) } : null);
    rows.push(row);
    for (const d of ds) if (!cells[d.key]) cells[d.key] = debtorCell(row);
  }
  for (const d of debtors) {
    if (!cells[d.key]) cells[d.key] = debtorCell(null, d);
    if (used.has(d.key) || !(d.debt > 0)) continue;
    rows.push({ id: 'D-' + d.key, src: 'none', debtorKey: d.key, name: d.name, kind: d.kind || '', members: d.codes.map(c => ({ code: c, name: d.name })),
      managerId: d.managerId || '', managerName: d.managerName || '', debt: d.debt, ageDays: d.ageDays });
  }
  return { rows, cells };
}

export function withDebt(l: ClientLimit, d: DebtInfo | null): LimitRow {
  const debt = d?.debt ?? 0, odDays = d?.odDays ?? 0, odSum = d?.odSum ?? 0;
  const over = l.limit !== null && debt > l.limit;
  const use = l.limit ? Math.round(debt / l.limit * 100) : 0;
  return { ...l, debt, odDays, odSum, over, use, alert: over || odDays > 0 || l.suspended };
}

export type LimFilter = 'all' | 'over' | 'od' | 'court' | 'notice' | 'none' | 'debt';
export const LFILTERS: Array<[LimFilter, string]> = [
  ['all', 'Усі'], ['over', 'Перевищено ліміт'], ['od', 'Прострочено'], ['court', 'Нова справа в суді'], ['notice', 'Зміни в YouControl'], ['none', 'Ліміт не узгоджено'], ['debt', 'Перенесені з дебіторки'],
];
export const limIn = (x: AnyRow, k: LimFilter) => k === 'all' || (k === 'none' && isNoLimit(x))
  || (!isNoLimit(x) && ((k === 'over' && x.over) || (k === 'od' && x.odDays > 0) || (k === 'court' && x.suspended) || (k === 'notice' && !!x.notice) || (k === 'debt' && x.src === 'debt')));
/** Порядок: те, що потребує уваги, — угорі; далі боржники без ліміту; далі решта. */
export const rowRank = (x: AnyRow) => (isNoLimit(x) ? 1 : x.alert ? 0 : 2);
export const useTone = (u: number) => (u > 100 ? 'bad' : u >= 80 ? 'warn' : '');
export function limitState(x: AnyRow): ['ok' | 'bad' | 'done', string] {
  if (isNoLimit(x)) return ['done', 'Ліміт не узгоджено'];
  return x.suspended ? ['bad', 'Призупинено'] : x.over ? ['bad', 'Перевищено ліміт'] : x.odDays ? ['bad', 'Прострочено'] : ['ok', 'Діє'];
}
export function srcText(x: AnyRow): string {
  if (isNoLimit(x)) return 'з дебіторки · без ліміту';
  if (x.src === 'req') return 'погоджено ' + dt(x.at);
  if (x.src === 'set') return `задав ${x.hist.find(h => h.type === 'limitSet')?.byName || 'Сергій'} ${dt(x.at)}`;
  return 'з дебіторки';
}

// ---------- права ----------
export const canSeeLimit = (u: CpUser, x: Pick<AnyRow, 'managerId'>) => seesAll(u.role) || x.managerId === u.id || inMyTeam(u, x.managerId);
/** Лічильник на вкладці: перевищено + прострочено + нова справа. Бухгалтерії й керівникам без дій — не показуємо. */
export const limitsBadge = (u: CpUser, rows: AnyRow[]) =>
  u.role === 'approver' || canSubmit(u.role) ? rows.filter(x => !isNoLimit(x) && canSeeLimit(u, x) && x.alert).length : 0;

export type LimitAction = 'edit' | 'keep' | 'set' | 'openReq' | 'applyNew' | 'apply' | 'requestChange';
/**
 * Хто що може (сервер перевіряє edit / keep / set; решта — переходи в «Узгодження»):
 *   Сергій — «Змінити ліміт» (з причиною), «Задати ліміт» боржнику без ліміту, «Лишити ліміт» після нової справи;
 *            призупинене погодження (req) — рішення в самому запиті;
 *   менеджер (свій клієнт) — «Подати запит на ліміт» / «на нові умови» (перенесений чи заданий ліміт) / «Запросити зміну умов» (req);
 *   тім-лід — клієнти команди лише переглядає.
 */
export function limitActions(u: CpUser, x: AnyRow): LimitAction[] {
  if (isNoLimit(x)) {
    if (u.role === 'approver') return ['set'];
    return canSubmit(u.role) && x.managerId === u.id ? ['applyNew'] : [];
  }
  if (u.role === 'approver') return x.suspended ? (x.src === 'req' ? ['openReq'] : ['keep', 'edit']) : ['edit'];
  if (canSubmit(u.role) && x.managerId === u.id) {
    if (x.src !== 'req') return ['apply'];
    return x.change || x.suspended ? [] : ['requestChange'];
  }
  return [];
}

// ---------- перевірки ----------
export interface LimitInput { limit: number; days: number; from: From; reason: string }
export function parseLimitInput(b: unknown): LimitInput | { error: string } {
  const x = (b || {}) as Record<string, unknown>;
  const limit = Number(String(x.limit ?? '').replace(/[\s  ]/g, '').replace(',', '.'));
  const days = String(x.days ?? '').trim();
  if (!(limit > 0 && limit < 1e10) || !/^\d{1,3}$/.test(days) || +days < 1 || +days > 365) return { error: 'Вкажіть ліміт і дні відтермінування.' };
  if (!['od', 'orig', 'inv'].includes(String(x.from))) return { error: 'Вкажіть, від чого рахувати дні.' };
  const reason = typeof x.reason === 'string' ? x.reason.trim() : '';
  if (!reason) return { error: 'Напишіть причину.' };
  if (reason.length > 2000) return { error: 'Текст — до 2000 символів.' };
  return { limit, days: +days, from: x.from as From, reason };
}

// ---------- для «Активної дебіторки» ----------
/** Що показати в колонці «Ліміти» для боржника: «у межах» / «переліміт» / «не узгоджено». */
export interface DebtorLimitCell {
  limitId: string | null; limit: number | null; days: number | null; from: From | null;
  status: 'ok' | 'over' | 'none'; suspended: boolean; use: number;
  /** Менеджер ліміту (у боржника без ліміту — «Відповідальний» з дебіторки). */
  managerId: string | null;
  /** Ставить сервер для того, хто дивиться: свій клієнт менеджера / тім-ліда → «Запросити зміну» («Запросити ліміт»). */
  canRequest?: boolean;
}
export function debtorCell(row: LimitRow | null, d?: Pick<Debtor, 'managerId'> | null): DebtorLimitCell {
  if (!row) return { limitId: null, limit: null, days: null, from: null, status: 'none', suspended: false, use: 0, managerId: d?.managerId ?? null };
  return { limitId: row.id, limit: row.limit, days: row.days, from: row.from, status: row.over ? 'over' : 'ok', suspended: row.suspended, use: row.use, managerId: row.managerId };
}
/** Комірки для користувача: Сергій міняє олівцями (canEdit у відповіді), менеджер / тім-лід свого клієнта — «Запросити зміну», решта — лише бачить. */
export function cellsFor(u: CpUser, cells: Record<string, DebtorLimitCell>): Record<string, DebtorLimitCell> {
  const out: Record<string, DebtorLimitCell> = {};
  for (const [k, c] of Object.entries(cells)) out[k] = { ...c, canRequest: canSubmit(u.role) && !!c.managerId && c.managerId === u.id };
  return out;
}
/**
 * Плитки «Загальний борг» і «Прострочено» активної дебіторки — за «Лімітами клієнтів» (як зараз, але ліміт не зникає з рахунками):
 *   'none' — дні з боржником не узгоджено → «ліміт не узгоджено» (рахується простроченим, як зараз);
 *   'over' — прострочка понад узгоджені дні (odDays > 0) → «понад узгоджений ліміт»;
 *   null   — «у межах домовленості».
 * Перевищення суми («переліміт») — окремо, у колонці «Ліміти»; простроченим не робить.
 */
export type OverdueKind = 'over' | 'none' | null;
export const overdueKind = (d: Pick<Debtor, 'debt' | 'odDays'>, c: DebtorLimitCell | null | undefined): OverdueKind =>
  !(d.debt > 0) ? null : !c || c.status === 'none' || c.days === null ? 'none' : d.odDays > 0 ? 'over' : null;
export interface DebtAgg { n: number; sum: number }
export interface OverdueSplit { total: DebtAgg; within: DebtAgg; overdue: DebtAgg; overLimit: DebtAgg; noLimit: DebtAgg }
export function overdueSplit(ds: Array<Pick<Debtor, 'key' | 'debt' | 'odDays'>>, cells: Record<string, DebtorLimitCell>): OverdueSplit {
  const z = (): DebtAgg => ({ n: 0, sum: 0 });
  const s: OverdueSplit = { total: z(), within: z(), overdue: z(), overLimit: z(), noLimit: z() };
  const add = (a: DebtAgg, x: number) => { a.n++; a.sum += x; };
  for (const d of ds) {
    if (!(d.debt > 0)) continue;
    add(s.total, d.debt);
    const k = overdueKind(d, cells[d.key]);
    if (!k) add(s.within, d.debt);
    else { add(s.overdue, d.debt); add(k === 'over' ? s.overLimit : s.noLimit, d.debt); }
  }
  return s;
}
/** Дати рахунку з дебіторки (1С / CRM). originalsAt — коли отримали оригінали, якщо дебіторка це знає. */
export interface InvoiceDates { unloadedAt?: string | null; invoiceAt?: string | null; originalsAt?: string | null }
const addDays = (d: string | Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/**
 * До якої дати клієнт має заплатити за рахунком — для прострочки в дебіторці («Прострочено», «понад узгоджений ліміт»).
 * «Від оригіналів»: якщо дати оригіналів немає — вивантаження + lag.orig (налаштування, за замовчуванням 10 днів).
 */
export function dueDate(inv: InvoiceDates, terms: { days: number; from: From }, lag: Lag = DEFAULT_LAG): Date | null {
  let base: Date | null = null;
  if (terms.from === 'inv') base = inv.invoiceAt ? new Date(inv.invoiceAt) : inv.unloadedAt ? addDays(inv.unloadedAt, lag.inv) : null;
  else if (terms.from === 'orig') base = inv.originalsAt ? new Date(inv.originalsAt) : inv.unloadedAt ? addDays(inv.unloadedAt, lag.orig) : null;
  else base = inv.unloadedAt ? new Date(inv.unloadedAt) : null;
  return base && !Number.isNaN(base.getTime()) ? addDays(base, terms.days) : null;
}
