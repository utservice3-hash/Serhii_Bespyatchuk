/**
 * «Узгодження роботи з новим контрагентом» — спільна логіка (сервер, вкладки дашборда, макет). Без залежностей.
 *
 * Процес (рішення Сергія 21–23.10, макет v5 — «узгоджено» 23.10):
 *   1. Лише для клієнтів із відтермінуванням оплати (на передоплаті погодження не потрібне).
 *   2. Менеджер (тім-лід) вводить ЄДРПОУ / ІПН ФОП → перевірка YouControl (або збережена, якщо їй менше 2 місяців);
 *      нерезидент — країна, номер, назва; автоперевірки немає, рішення — за документами.
 *   3. Умови обох сторін: скільки днів і від чого рахувати, форма оплати, орієнтовна ставка за рейс (клієнт і перевізник),
 *      рейсів на місяць, наша юрособа, ліміт боргу (за замовчуванням — розрахунок боргу). Хоча б один документ.
 *   4. Сергій: погодити / змінити умови й погодити / повернути / відхилити. Погоджений ліміт іде в «Ліміти клієнтів» (дебіторка).
 *   5. Погоджений клієнт: менеджер запитує зміну умов (з причиною) — до рішення діють погоджені.
 *   6. Щомісячна перевірка судів: нова справа за перевезення, де клієнт — відповідач → погодження призупиняється, рішення за Сергієм.
 */
import { dayW, money } from './cpFormat.js';
import type { CpCheck } from './cpCheck.js';

export type PayForm = 'vat' | 'novat' | 'cash';
export type From = 'od' | 'orig' | 'inv';
export type Entity = 'uts' | 'avm' | 'fop';
export type Cur = 'uah' | 'eur' | 'usd';

/** Одна сторона умов: скільки днів, від чого рахувати, форма оплати, орієнтовна ставка за рейс і її валюта. */
export interface Side { days: number; from: From; pay: PayForm; rate: number; cur: Cur }
/** Умови: клієнт платить (cl), ми платимо перевізнику (ca), рейсів на місяць, наша юрособа, ліміт боргу (грн). */
export interface Terms { cl: Side; ca: Side; trips: number; ent: Entity; limit: number }
/** Те саме з форми: числа ще рядками («42 000»). */
export interface SideInput { days: number | string; from: From; pay: PayForm; rate: number | string; cur: Cur }
export interface TermsInput { cl: SideInput; ca: SideInput; trips: number | string; ent: Entity; limit: number | string }

export const FROM_LABEL: Record<From, string> = { od: 'від вивантаження', orig: 'від отримання оригіналів', inv: 'від дати рахунку' };
/** Коротко — для вузьких колонок (колонка «Ліміти» в активній дебіторці). */
export const FROM_SHORT: Record<From, string> = { od: 'від вивантаження', orig: 'від оригіналів', inv: 'від рахунку' };
export const PAY_LABEL: Record<PayForm, string> = { vat: 'Безготівка з ПДВ', novat: 'Безготівка без ПДВ', cash: 'Готівка' };
export const PAY_SHORT: Record<PayForm, string> = { vat: 'безготівка з ПДВ', novat: 'безготівка без ПДВ', cash: 'готівка' };
export const ENT_LABEL: Record<Entity, string> = { uts: 'ЮТС', avm: 'АвтоМув', fop: 'ФОП' };
export const CUR_LABEL: Record<Cur, string> = { uah: 'грн', eur: '€', usd: '$' };
export const COUNTRIES = ['Польща', 'Німеччина', 'Литва', 'Латвія', 'Чехія', 'Словаччина', 'Румунія', 'Молдова', 'Інша країна'];
const isKey = <T extends string>(m: Record<T, string>, v: unknown): v is T => typeof v === 'string' && Object.prototype.hasOwnProperty.call(m, v);

// ---------- ролі ----------
export type CpRole = 'manager' | 'lead' | 'approver' | 'accounting' | 'viewer' | 'staff';
//  manager / lead — подають запити, бачать свої; тім-лід — ще й запити команди (лише перегляд);
//  approver       — лише акаунт Сергія: бачить усе, погоджує, бачить залишок транзакцій YouControl;
//  accounting     — бачить усі запити й ліміти, без дій;
//  viewer         — керівники (admin, ceo, finance): бачать усе, без дій;
//  staff          — інші співробітники (логісти, КВП…): лише «Перевірка контрагента».
/** team — users.id менеджерів команди тім-ліда (лише для role 'lead'; задає сервер через опцію teamOf). */
export interface CpUser { id: string; name: string; role: CpRole; team?: string[] }

// ---------- запит ----------
export type ReqStatus = 'checking' | 'pending' | 'returned' | 'approved' | 'rejected';
export type CpEventType = 'submitted' | 'checked' | 'rechecked' | 'resubmitted' | 'approved' | 'approvedChanged' | 'returned' | 'rejected'
  | 'suspended' | 'changeRequested' | 'changeApproved' | 'changeRejected' | 'limitChanged';
export interface CpEvent { type: CpEventType; by: string | null; byName: string | null; at: string; note: string }
export interface CpFile { id: string; name: string; size: number }
export interface ChangeReq { terms: Terms; reason: string; by: string; byName: string; at: string }
/** Позначка щомісячної перевірки: нова справа за перевезення, клієнт — відповідач. */
export interface Flag { at: string; what: string; caseNo?: string }
/** Курс НБУ на момент розрахунку (грн за 1 € / $). */
export interface Rates { eur: number; usd: number; at: string }

export interface CpRequest {
  id: string;
  resident: boolean;
  code: string;               // ЄДРПОУ / ІПН ФОП; нерезидент — перший номер із реєстраційних
  country: string | null;     // нерезидент
  regNo: string | null;       // нерезидент: KRS, VAT…
  name: string;
  kind: string;               // «ТОВ», «ФОП»…; нерезидент — «Нерезидент»
  status: ReqStatus;
  terms: Terms;               // що просить менеджер (після повторного подання — оновлене)
  ok: Terms | null;           // погоджені умови (можуть відрізнятися від terms)
  change: ChangeReq | null;   // запит на зміну умов погодженого клієнта
  flag: Flag | null;          // погодження призупинено щомісячною перевіркою
  rates: Rates;               // курс на момент подання — для € / $
  checkId: string | null;     // перевірка YouControl, на якій вирішують
  checkSaved: boolean;        // узято збережену перевірку (транзакції не витрачались)
  recheckId: string | null;   // «Перевірити заново» (Сергій) — нова перевірка ще триває
  files: CpFile[];
  comment: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  hist: CpEvent[];
}

/** Запит, як його віддає сервер: з перевіркою, на якій вирішують (і чи триває повторна). */
export interface CpRequestView extends CpRequest {
  check: CpCheck | null;
  rechecking: boolean;
  /** Погоджений клієнт: борг зараз з дебіторки (якщо сервер підключено до дебіторки). */
  debt?: { debt: number; at: string } | null;
}

export const STATUS_LABEL: Record<ReqStatus, string> = {
  checking: 'Перевіряється', pending: 'На погодженні', returned: 'Повернуто', approved: 'Погоджено', rejected: 'Відхилено',
};
export const STATUS_TONE: Record<ReqStatus, 'mut' | 'warn' | 'info' | 'ok' | 'bad'> = {
  checking: 'mut', pending: 'warn', returned: 'info', approved: 'ok', rejected: 'bad',
};
export type ReqFilter = 'all' | ReqStatus;
export const FILTERS: Array<[ReqFilter, string]> = [
  ['all', 'Усі'], ['checking', 'Перевіряється'], ['pending', 'На погодженні'], ['returned', 'Повернуто'], ['approved', 'Погоджено'], ['rejected', 'Відхилено'],
];
export const EVENT_LABEL: Record<CpEventType, string> = {
  submitted: 'Надіслано на погодження',
  checked: 'Перевірено в YouControl',
  rechecked: 'Перевірено заново',
  resubmitted: 'Надіслано повторно',
  approved: 'Погоджено',
  approvedChanged: 'Погоджено з іншими умовами',
  returned: 'Повернуто на доопрацювання',
  rejected: 'Відхилено',
  suspended: 'Погодження призупинено — нова справа',
  changeRequested: 'Запит на зміну умов',
  changeApproved: 'Зміну умов погоджено',
  changeRejected: 'Зміну умов відхилено — діють попередні',
  limitChanged: 'Ліміт змінено',
};
export const EVENT_TONE: Record<CpEventType, 'mut' | 'warn' | 'info' | 'ok' | 'bad'> = {
  submitted: 'warn', checked: 'mut', rechecked: 'mut', resubmitted: 'warn', approved: 'ok', approvedChanged: 'ok', returned: 'info', rejected: 'bad',
  suspended: 'bad', changeRequested: 'warn', changeApproved: 'ok', changeRejected: 'bad', limitChanged: 'ok',
};

// ---------- права (сервер перевіряє те саме — інтерфейс лише ховає кнопки) ----------
export const seesAll = (role: CpRole) => role === 'approver' || role === 'accounting' || role === 'viewer';
export const canSubmit = (role: CpRole) => role === 'manager' || role === 'lead';
/** Вкладка «Узгодження» і «Ліміти клієнтів»: усім, крім «інших співробітників» (їм — лише перевірка). */
export const seesRequests = (role: CpRole) => role !== 'staff';
export const inMyTeam = (u: CpUser, createdBy: string) => u.role === 'lead' && !!u.team && u.team.includes(createdBy);
export const canSee = (u: CpUser, q: Pick<CpRequest, 'createdBy'>) => seesAll(u.role) || q.createdBy === u.id || inMyTeam(u, q.createdBy);
/** Колонка «Менеджер» — тим, хто бачить чужі запити. */
export const seesOthers = (u: CpUser) => seesAll(u.role) || (u.role === 'lead' && !!u.team && u.team.length > 0);
export const isOwner = (u: CpUser, q: Pick<CpRequest, 'createdBy'>) => canSubmit(u.role) && q.createdBy === u.id;
export const changePending = (q: Pick<CpRequest, 'status' | 'change'>) => q.status === 'approved' && !!q.change;

/** Чи чекає запит саме цього користувача (лічильник у меню й на вкладці). */
export function needsMe(u: CpUser, q: Pick<CpRequest, 'status' | 'change' | 'createdBy'>): boolean {
  if (u.role === 'approver') return q.status === 'pending' || changePending(q);
  return isOwner(u, q) && q.status === 'returned';
}
/** «На погодженні» — усе, що чекає рішення Сергія: нові запити й запити на зміну умов погоджених клієнтів. */
export const inFilter = (q: Pick<CpRequest, 'status' | 'change'>, k: ReqFilter) => k === 'all' || q.status === k || (k === 'pending' && changePending(q));
export const defaultFilter = (role: CpRole): ReqFilter => (role === 'approver' ? 'pending' : role === 'accounting' ? 'approved' : 'all');

export type CpAction = 'approve' | 'approveChanged' | 'return' | 'reject' | 'recheck' | 'resubmit' | 'requestChange' | 'changeApprove' | 'changeReject';
export const CP_ACTIONS: CpAction[] = ['approve', 'approveChanged', 'return', 'reject', 'recheck', 'resubmit', 'requestChange', 'changeApprove', 'changeReject'];
export const isCpAction = (s: string): s is CpAction => (CP_ACTIONS as string[]).includes(s);

/** Які дії доступні над запитом. changeApprove приймає й змінені умови (body.terms) — «Змінити й погодити». */
export function allowedActions(u: CpUser, q: Pick<CpRequest, 'status' | 'change' | 'flag' | 'createdBy' | 'resident'>): CpAction[] {
  if (u.role === 'approver') {
    if (q.status === 'pending') return q.resident ? ['approve', 'approveChanged', 'return', 'reject', 'recheck'] : ['approve', 'approveChanged', 'return', 'reject'];
    if (changePending(q)) return ['changeApprove', 'changeReject'];
    return [];
  }
  if (isOwner(u, q)) {
    if (q.status === 'returned') return ['resubmit'];
    if (q.status === 'approved' && !q.change) return ['requestChange'];
  }
  return [];
}
/** Повідомлення після дії (тост). */
export const ACTION_DONE: Record<CpAction | 'submit', string> = {
  submit: 'Надіслано на погодження',
  approve: 'Погоджено',
  approveChanged: 'Погоджено з іншими умовами',
  return: 'Повернуто менеджеру',
  reject: 'Відхилено',
  recheck: 'Перевірка YouControl запущена',
  resubmit: 'Надіслано повторно',
  requestChange: 'Запит на зміну умов надіслано Сергію',
  changeApprove: 'Зміну умов погоджено',
  changeReject: 'Зміну відхилено — діють попередні умови',
};

// ---------- перевірки (тексти — ті, що бачить користувач) ----------
export const CODE_RE = /^(\d{8}|\d{10})$/;
export const isFopCode = (code: string) => /^\d{10}$/.test(code);
export const cleanCode = (raw: unknown) => String(raw ?? '').replace(/\s/g, '');
export function checkCode(raw: unknown): string | null {
  return CODE_RE.test(cleanCode(raw)) ? null : 'Введіть ЄДРПОУ (8 цифр) або ІПН ФОП (10 цифр).';
}
export const TEXT_MAX = 2000;
export function checkText(s: unknown, empty: string): string | null {
  if (typeof s !== 'string' || !s.trim()) return empty;
  if (s.trim().length > TEXT_MAX) return `Текст — до ${TEXT_MAX} символів.`;
  return null;
}
export const NOTE_EMPTY: Partial<Record<CpAction, string>> = {
  return: 'Напишіть, що доопрацювати.',
  reject: 'Напишіть причину відмови.',
  changeReject: 'Напишіть, чому відхиляєте зміну.',
  requestChange: 'Напишіть, чому змінюємо умови.',
};

/** Число з поля форми: «42 000», «2100,5» → 42000, 2100.5; порожньо → NaN. */
export function num(v: unknown): number {
  const s = String(v ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
}
export const intIn = (v: unknown, a: number, b: number) => /^\d{1,3}$/.test(String(v ?? '').trim()) && Number(v) >= a && Number(v) <= b;
const rateOk = (v: unknown) => num(v) > 0 && num(v) < 1e8;
const limitOk = (v: unknown) => num(v) > 0 && num(v) < 1e10;

/** Чого бракує в умовах — для підказки «Потрібні: …» і для сервера. */
export function termsErr(t: TermsInput): string[] {
  const m: string[] = [];
  if (!t || !t.cl || !t.ca) return ['умови оплати'];
  if (!intIn(t.cl.days, 1, 365)) m.push('дні клієнта');
  if (!rateOk(t.cl.rate)) m.push('ставка клієнта');
  if (!intIn(t.ca.days, 0, 365)) m.push('дні перевізнику');
  if (!rateOk(t.ca.rate)) m.push('ставка перевізнику');
  if (!intIn(t.trips, 1, 999)) m.push('рейсів на місяць');
  if (!limitOk(t.limit)) m.push('ліміт боргу');
  return m;
}
const normSide = (s: SideInput): Side => ({ days: num(s.days), from: s.from, pay: s.pay, rate: num(s.rate), cur: s.cur });
export const normTerms = (t: TermsInput): Terms => ({ cl: normSide(t.cl), ca: normSide(t.ca), trips: num(t.trips), ent: t.ent, limit: num(t.limit) });
export const sameTerms = (a: TermsInput | null, b: TermsInput | null) => !!a && !!b && JSON.stringify(normTerms(a)) === JSON.stringify(normTerms(b));

/** Сервер: умови з JSON-тіла запиту → Terms або текст помилки. */
export function parseTerms(x: unknown): { terms: Terms } | { error: string } {
  const t = x as TermsInput;
  const sideOk = (s: SideInput | undefined) => !!s && isKey(FROM_LABEL, s.from) && isKey(PAY_LABEL, s.pay) && isKey(CUR_LABEL, s.cur);
  if (!t || typeof t !== 'object' || !sideOk(t.cl) || !sideOk(t.ca) || !isKey(ENT_LABEL, t.ent)) return { error: 'Заповніть умови оплати.' };
  const err = termsErr(t);
  if (err.length) return { error: 'Заповніть: ' + err.join(', ') + '.' };
  return { terms: normTerms(t) };
}

// ---------- тексти умов і що змінилось ----------
export const sideLine = (s: Pick<Side, 'days' | 'from'>) => `${dayW(s.days)} ${FROM_LABEL[s.from]}`;
export const termsLine = (t: Terms) => sideLine(t.cl);
export const termsSub = (t: Terms) => `${ENT_LABEL[t.ent]} · ${PAY_SHORT[t.cl.pay]}`;
export function fields(t: Terms): Array<[string, string]> {
  return [
    ['Клієнт платить', sideLine(t.cl)], ['Форма оплати клієнта', PAY_SHORT[t.cl.pay]], ['Ставка клієнта', money(t.cl.rate, t.cl.cur)],
    ['Перевізнику платимо', sideLine(t.ca)], ['Форма оплати перевізнику', PAY_SHORT[t.ca.pay]], ['Ставка перевізнику', money(t.ca.rate, t.ca.cur)],
    ['Рейсів на місяць', String(t.trips)], ['Наша юрособа', ENT_LABEL[t.ent]], ['Ліміт боргу', money(t.limit)],
  ];
}
/** «Клієнт платить: 30 днів від … → 21 день від …» — що змінилось між a і b. */
export const diffLines = (a: Terms, b: Terms) => { const A = fields(a), B = fields(b); return A.map(([l, v], i) => (v !== B[i][1] ? `${l}: ${v} → ${B[i][1]}` : null)).filter((x): x is string => !!x); };
/** Чим погоджене відрізняється від запитаного: «ліміт боргу 550 000 грн». */
export const askedLines = (got: Terms, asked: Terms) => { const A = fields(got), R = fields(asked); return A.map(([l, v], i) => (v !== R[i][1] ? `${l.toLowerCase()} ${R[i][1]}` : null)).filter((x): x is string => !!x); };

/** Порожні умови для нової форми: резидент — гривня й з ПДВ; нерезидент — € і без ПДВ. */
export function blankTerms(resident: boolean): TermsInput {
  return {
    cl: { days: '', from: 'orig', pay: resident ? 'vat' : 'novat', rate: '', cur: resident ? 'uah' : 'eur' },
    ca: { days: '', from: 'orig', pay: 'novat', rate: '', cur: resident ? 'uah' : 'eur' },
    trips: '', ent: 'uts', limit: '',
  };
}
