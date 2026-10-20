/**
 * Реєстр мінусових угод — спільна логіка (сервер, вкладка дашборда, макет). Без залежностей.
 *
 * Процес (рішення Сергія 20.10):
 *   1. Менеджер відправляє заявку на оплату перевізнику в Kommo («Заявки на оплату» → «Оплата перевізнику по б/готівці»).
 *   2. Якщо угода мінусова — подає її в реєстр: ID угоди + «Чому угода мінусова».
 *   3. Сергій (операційний директор) погоджує / повертає на доопрацювання / відхиляє.
 *   4. Бухгалтерія оплачує погоджене безготівкою і ставить «Оплачено» в дашборді.
 * Через реєстр — лише безготівкова оплата перевізнику через бухгалтерію. Готівка йде повз реєстр.
 * Плюсові угоди бухгалтерія оплачує без реєстру; не мінусову за CRM угоду подати можна — вирішує менеджер.
 */

export type Role = 'manager' | 'lead' | 'approver' | 'accounting' | 'viewer';
//  manager / lead — подають і бачать лише свої запити;
//  approver       — лише акаунт Сергія: бачить усе, погоджує;
//  accounting     — бачить усе, ставить «Оплачено» погодженим;
//  viewer         — інші адміни: бачать усе, дій немає.

export type Status = 'pending' | 'returned' | 'approved' | 'paid' | 'rejected';
export type EventType = 'submitted' | 'resubmitted' | 'approved' | 'returned' | 'rejected' | 'paid' | 'revoked';
export type Action = 'approve' | 'return' | 'reject' | 'paid' | 'resubmit';

/** Рядок приходу чи розходу — як поля в Kommo: «Приход N» (сума), «Приход N Тип оплаты» (форма оплати), «Приход N расчет». */
export interface Line {
  sum: number;
  type: string;   // значення з CRM дослівно: Наличные / Безнал с НДС / Безнал без НДС / ВАЛЮТА / Оплата на выгрузке
  net: number;    // «расчет» — рахує CRM, реєстр нічого не перераховує
  cur?: string;   // «Валюта прихода 1» / «Валюта расхода 1» ($ / €) — лише в першого рядка, лише для ВАЛЮТА
}

/** Угода, як її бачить реєстр (знімок з Kommo). */
export interface CrmDeal {
  dealId: string;
  name: string;      // назва угоди = маршрут і дата («Київ – Львів 18.10.2026»)
  stage: string;     // назва етапу у воронці
  client: string;    // назва основного контакту угоди («картка клієнта»)
  carrier: string;   // «Назва перевізника» із заявки на оплату; '' — заявку ще не відправлено
  inc: Line[];
  exp: Line[];
  incTotal: number;  // «Расчет приходов»
  expTotal: number;  // «Расчет расходов»
  budget: number;    // «Бюджет» угоди = маржа
}

export interface RegUser { id: string; name: string; role: Role }

export interface HistEvent {
  type: EventType;
  by: string | null;       // null — система (синхронізація з Kommo)
  byName: string | null;
  at: string;              // ISO
  note: string;
}

/** «Мінус зріс» після погодження: бюджет на момент погодження і що змінилось у CRM. */
export interface Grew { budget: number; what: string }

export interface RegRequest {
  id: string;
  dealId: string;
  status: Status;
  comment: string;         // «Чому угода мінусова»
  crm: CrmDeal;
  grew: Grew | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;       // ISO
  hist: HistEvent[];
}

// ---------- підписи ----------
export const STATUS_LABEL: Record<Status, string> = {
  pending: 'На погодженні',
  returned: 'Повернуто',
  approved: 'Погоджено',
  paid: 'Оплачено',
  rejected: 'Відхилено',
};
/** Колір плашки статусу (семантика, не бренд). */
export const STATUS_TONE: Record<Status, 'warn' | 'info' | 'ok' | 'done' | 'bad'> = {
  pending: 'warn', returned: 'info', approved: 'ok', paid: 'done', rejected: 'bad',
};
export const FILTERS: Array<['all' | Status, string]> = [
  ['all', 'Усі'], ['pending', 'На погодженні'], ['returned', 'Повернуто'], ['approved', 'Погоджено'], ['paid', 'Оплачено'], ['rejected', 'Відхилено'],
];
export const EVENT_LABEL: Record<EventType, string> = {
  submitted: 'Надіслано на погодження',
  resubmitted: 'Надіслано повторно',
  approved: 'Погоджено',
  returned: 'Повернуто на доопрацювання',
  rejected: 'Відхилено',
  paid: 'Оплачено',
  revoked: 'Погодження знято — мінус зріс',
};
export const EVENT_TONE: Record<EventType, 'warn' | 'info' | 'ok' | 'done' | 'bad'> = {
  submitted: 'warn', resubmitted: 'warn', approved: 'ok', returned: 'info', rejected: 'bad', paid: 'done', revoked: 'bad',
};
/** Повідомлення після дії (тост). */
export const ACTION_DONE: Record<Action | 'submit', string> = {
  submit: 'Надіслано на погодження',
  approve: 'Погоджено — бухгалтерія може оплатити',
  return: 'Повернуто менеджеру',
  reject: 'Відхилено',
  paid: 'Позначено: оплачено',
  resubmit: 'Надіслано повторно',
};

// ---------- права ----------
export const seesAll = (role: Role) => role === 'approver' || role === 'accounting' || role === 'viewer';
export const canSubmit = (role: Role) => role === 'manager' || role === 'lead';
export const canSee = (u: RegUser, q: Pick<RegRequest, 'createdBy'>) => seesAll(u.role) || q.createdBy === u.id;

/** Чи чекає запит саме цього користувача (лічильник у меню й на вкладці). */
export function needsMe(u: RegUser, q: Pick<RegRequest, 'status' | 'createdBy'>): boolean {
  if (u.role === 'approver') return q.status === 'pending';
  if (u.role === 'accounting') return q.status === 'approved';
  if (canSubmit(u.role)) return q.createdBy === u.id && q.status === 'returned';
  return false;
}

/** Які дії доступні користувачу над запитом. Сервер перевіряє те саме — інтерфейс лише ховає кнопки. */
export function allowedActions(u: RegUser, q: Pick<RegRequest, 'status' | 'createdBy'>): Action[] {
  if (u.role === 'approver' && q.status === 'pending') return ['approve', 'return', 'reject'];
  if (u.role === 'accounting' && q.status === 'approved') return ['paid'];
  if (canSubmit(u.role) && q.createdBy === u.id && q.status === 'returned') return ['resubmit'];
  return [];
}
export const FROM: Record<Action, Status> = { approve: 'pending', return: 'pending', reject: 'pending', paid: 'approved', resubmit: 'returned' };
export const TO: Record<Action, Status> = { approve: 'approved', return: 'returned', reject: 'rejected', paid: 'paid', resubmit: 'pending' };
export const EVENT_OF: Record<Action, EventType> = { approve: 'approved', return: 'returned', reject: 'rejected', paid: 'paid', resubmit: 'resubmitted' };
export const ACTIONS: Action[] = ['approve', 'return', 'reject', 'paid', 'resubmit'];
export const isAction = (s: string): s is Action => (ACTIONS as string[]).includes(s);

/** Фільтр за замовчуванням: Сергію — «На погодженні», бухгалтерії — «Погоджено», решті — «Усі». */
export const defaultFilter = (role: Role): 'all' | Status => role === 'approver' ? 'pending' : role === 'accounting' ? 'approved' : 'all';

// ---------- перевірки (тексти — ті, що бачить користувач) ----------
export const DEAL_ID_RE = /^\d{4,12}$/;
export const COMMENT_MAX = 2000;
export function checkDealId(s: unknown): string | null {
  return typeof s === 'string' && DEAL_ID_RE.test(s.trim()) ? null : 'Введіть ID угоди з CRM — лише цифри.';
}
export function checkComment(s: unknown): string | null {
  if (typeof s !== 'string' || !s.trim()) return 'Напишіть, чому угода мінусова.';
  if (s.trim().length > COMMENT_MAX) return `Коментар — до ${COMMENT_MAX} символів.`;
  return null;
}
export function checkNote(a: Action, s: unknown): string | null {
  if (a !== 'return' && a !== 'reject') return null;
  if (typeof s !== 'string' || !s.trim()) return a === 'return' ? 'Напишіть, що доопрацювати.' : 'Напишіть причину відмови.';
  if (s.trim().length > COMMENT_MAX) return `Текст — до ${COMMENT_MAX} символів.`;
  return null;
}

// ---------- «мінус зріс» ----------
/**
 * Після погодження бюджет (маржа) у CRM зменшився → погодження знімається, запит знову «На погодженні» (рішення 20.10).
 * Доплата клієнта (бюджет зріс) погодження не знімає.
 */
export const minusGrew = (approvedBudget: number, now: Pick<CrmDeal, 'budget'>) => now.budget < approvedBudget;

const money = (n: number) => Math.abs(n).toLocaleString('uk-UA', { maximumFractionDigits: 2 }).replace(/\s/g, ' ');
const lineWord = (side: 'inc' | 'exp') => side === 'inc' ? 'прихід' : 'розхід';

/** Що змінилось між двома знімками угоди — для позначки «мінус зріс» і запису в історії. */
export function changesBetween(prev: CrmDeal, next: CrmDeal): string[] {
  const out: string[] = [];
  for (const side of ['inc', 'exp'] as const) {
    const a = prev[side], b = next[side], n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const w = `${lineWord(side)} ${i + 1}`;
      const x = a[i], y = b[i];
      if (!x && y) out.push(`додано ${w} — ${money(y.sum)} грн`);
      else if (x && !y) out.push(`прибрано ${w} — ${money(x.sum)} грн`);
      else if (x && y) {
        if (x.sum !== y.sum) out.push(`${w}: ${money(x.sum)} → ${money(y.sum)} грн`);
        if (x.type !== y.type || (x.cur || '') !== (y.cur || '')) out.push(`${w}: ${x.type}${x.cur ? ' ' + x.cur : ''} → ${y.type}${y.cur ? ' ' + y.cur : ''}`);
        else if (x.sum === y.sum && x.net !== y.net) out.push(`${w}: розрахунок ${money(x.net)} → ${money(y.net)} грн`);
      }
    }
  }
  return out;
}
/** «У CRM додано розхід 2 — 3 000 грн.» — підпис під позначкою «мінус зріс». */
export function describeChange(prev: CrmDeal, next: CrmDeal): string {
  const c = changesBetween(prev, next);
  if (!c.length) return 'У CRM змінився бюджет угоди.';
  return c.length === 1 ? `У CRM ${c[0]}.` : `У CRM: ${c.join('; ')}.`;
}
/** Запис в історії: «Маржа в CRM: −940 → −3 760 грн. Додано розхід 2 — 3 000 грн.» */
export function revokeNote(approvedBudget: number, prev: CrmDeal, next: CrmDeal): string {
  const s = (n: number) => (n < 0 ? '−' : n > 0 ? '+' : '') + money(n);
  const c = changesBetween(prev, next);
  const tail = c.length ? ' ' + c.map(x => x[0].toUpperCase() + x.slice(1)).join('. ') + '.' : '';
  return `Маржа в CRM: ${s(approvedBudget)} → ${s(next.budget)} грн.${tail}`;
}
