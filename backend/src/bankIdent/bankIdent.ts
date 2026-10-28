/**
 * «Виписка» — № рахунку на вхідних і коментарі до вихідних ФОП: правила, права, статуси (рішення Сергія 27.10).
 * Той самий код працює на сервері (server/routes/bankIdent.ts), у клієнті й у макеті (mockup/src/demoApi.ts).
 *
 *   Менеджер вписує № рахунку ОДИН раз, поки не минули 48 год без суботи й неділі (shared/identDeadline.ts).
 *   Не вписав — «Неідентифікований» ОСТАТОЧНО: номер не впише ніхто, адмін теж.
 *   Змінити вписаний номер або визнати платіж неідентифікованим — лише фінансист, з причиною, будь-коли; усе — в історію.
 *   Свої перекази (наш IBAN, власник ФОП, «між власними рахунками») — номер не потрібен, автоматично.
 *   Повернення / помилкові платежі / кошти власника — бухгалтер позначає «не оплата клієнта», поки строк не минув.
 *   Коментарі до вихідних ФОП бачать і пишуть лише бухгалтер і адмін; іншим їх не видно взагалі.
 */
import { HOUR, identDeadline } from './identDeadline.js';

export type IdentStatus = 'wait' | 'identified' | 'not_client' | 'unidentified' | 'own';
export type StoredStatus = 'identified' | 'not_client' | 'unidentified';
export type IdentAct = 'set' | 'change' | 'unidentify' | 'not_client' | 'expired' | 'reset';
export type UnidKind = 'expired' | 'finance';

export interface Person { id: string; name: string; role: string }

/** Стан платежу для інтерфейсу (POST /api/bank-ident/state). */
export interface IdentState {
  txId: number;
  status: IdentStatus;
  /** Строк (ISO): для «чекає» — до коли; для «неідентифікований» за строком — коли минув. */
  deadlineAt: string | null;
  invoiceNo: string | null;
  /** Хто поставив поточний стан; null — система (строк минув). */
  by: Person | null;
  at: string | null;
  /** Хто зафіксував номер першим (автор). */
  firstBy: Person | null;
  firstAt: string | null;
  /** Номер змінював фінансист. */
  changed: boolean;
  reason: string | null;
  note: string | null;
  unidKind: UnidKind | null;
  /** Скільки записів в історії. */
  events: number;
  /** Що може поточний користувач — інтерфейс показує лише дозволене, сервер усе одно перевіряє. */
  can: { set: boolean; fix: boolean; nc: boolean; reset?: boolean }; // reset — [дашборд 28.10]
}

export interface IdentEvent {
  id: number;
  at: string;
  by: Person | null;
  act: IdentAct;
  fromNo: string | null;
  toNo: string | null;
  reason: string | null;
  note: string | null;
}

export interface OutComment { id: number; at: string; by: Person; body: string }
export interface CommentSummary { count: number; last: OutComment | null }

/** Збережений стан (рядок bank_tx_ident). */
export interface IdentRow {
  txId: number;
  accountId: number;
  bookedAt: string;
  status: StoredStatus;
  invoiceNo: string | null;
  firstBy: Person | null;
  firstAt: string | null;
  by: Person | null;
  at: string;
  reason: string | null;
  note: string | null;
  unidKind: UnidKind | null;
  deadlineAt: string;
  changed: boolean;
}

/** Транзакція виписки — лише те, що потрібно правилу. */
export interface TxLite {
  id: number;
  accountId: number;
  incoming: boolean;
  bookedAt: number;
  /** Коли платіж зʼявився у виписці дашборда (якщо відомо). */
  seenAt?: number | null;
  counterpartyName?: string | null;
  counterpartyIban?: string | null;
  purpose?: string | null;
}

// ───────────── права ─────────────

export type Right = 'tag_bank_invoice' | 'fix_bank_invoice' | 'mark_bank_not_client' | 'bank_out_comments' | 'reset_bank_invoice';

/** Нові права для «Налаштування → Ролі та доступи». Адмін має все (рівень адміністратора). */
export const RIGHTS: Record<Right, { label: string; roles: string[]; gives: string }> = {
  tag_bank_invoice: {
    label: 'Вписувати № рахунку (Виписка)',
    roles: ['manager', 'team_lead', 'lead'],
    gives: 'Один раз вписати № у надходження ФОП Моно / Приват і картки Ступаківського, поки не минули 48 год.',
  },
  fix_bank_invoice: {
    label: 'Змінювати № рахунку (Виписка)',
    roles: ['finance'],
    gives: 'Змінити вписаний номер або визнати платіж неідентифікованим — з причиною, будь-коли. Неідентифікований за строком не чіпає ніхто.',
  },
  mark_bank_not_client: {
    label: 'Позначати «не оплата клієнта» (Виписка)',
    roles: ['accounting', 'accountant'],
    gives: 'Повернення, помилкові платежі, кошти власника — без номера, поки строк не минув.',
  },
  // [дашборд 28.10, погодив Сергій] скинути вписаний № → платіж знову «Чекає №» (менеджер помилився), поки строк не минув
  reset_bank_invoice: {
    label: 'Скидати № рахунку (Виписка)',
    roles: ['finance', 'financier'],
    gives: 'Прибрати вписаний номер, щоб платіж знову чекав № і менеджер вписав правильний. Лише поки не минули 48 год; з причиною, в історію.',
  },
  bank_out_comments: {
    label: 'Коментарі до вихідних ФОП (Виписка)',
    roles: ['accounting', 'accountant'],
    gives: 'Бачити й писати коментарі до вихідних ФОП Беспятчук (Моно, Приват). Без цього права коментарів не видно взагалі.',
  },
};
export const RIGHT_KEYS = Object.keys(RIGHTS) as Right[];
export const ADMIN_ROLES = ['admin'];

/** Права за замовчуванням — за кодом ролі дашборда. Своя система прав — передайте `can` у роутер. */
export function defaultCan(role: string | null | undefined, right: Right): boolean {
  return !!role && (ADMIN_ROLES.includes(role) || RIGHTS[right].roles.includes(role));
}
export const ROLE_LABEL: Record<string, string> = {
  admin: 'адмін', manager: 'менеджер', team_lead: 'тімлід', lead: 'тімлід', accounting: 'бухгалтер', accountant: 'бухгалтер',
  finance: 'фінансист', ceo: 'CEO', opdir: 'ОД', kvp: 'КВП', hr: 'HR',
  // [дашборд] наші ключі ролей: фінансист — `financier`, «Бухгалтерія» — дванадцять підкреслень (db/roleDeclarations.ts)
  financier: 'фінансист', '____________': 'бухгалтер',
};
export const roleLabel = (r: string | null | undefined) => (r ? ROLE_LABEL[r] || r : '');

// ───────────── налаштування правила ─────────────

/** Рахунки, звірені з дашбордом 27.10: 3 — ФОП Беспятчук (Приват), 4 — ФОП Беспятчук (Моно), 11 — Oleksandr Stupakivskyi робоча моно. */
export const DEFAULT_ACCOUNT_IDS = [3, 4, 11];
/** Коментарі до вихідних — лише ФОП (рішення Сергія: «на вихідних платежах по ФОПу»). */
export const DEFAULT_OUT_COMMENT_ACCOUNT_IDS = [3, 4];
/** «Горить» — лишилось менше 12 робочих годин. */
export const SOON_MS = 12 * HOUR;
/** Скільки днів назад шукати платежі, що ще чекають (48 роб. год + вихідні + запас на свята). */
export const LOOKBACK_DAYS = 14;
export const DEFAULT_OWN_NAMES = ['беспятчук'];

export interface IdentRules {
  accountIds: number[];
  /** Момент запуску правила (мс): старіші надходження — без номера й строку. */
  identFrom: number;
  hours: number;
  holidays: ReadonlySet<string>;
  /** IBAN наших рахунків (нормалізовані). */
  ownIbans: ReadonlySet<string>;
  /** Частини назв, за якими платіж — свій (власник ФОП тощо), у нижньому регістрі. */
  ownNames: string[];
}

export const normIban = (s: string | null | undefined) => String(s || '').replace(/\s+/g, '').toUpperCase();
const OWN_PURPOSE = /між\s+власними\s+рахунками/i;

/** Свій переказ: з нашого IBAN, від власника ФОП або «між власними рахунками». */
export function isOwnTransfer(tx: TxLite, r: Pick<IdentRules, 'ownIbans' | 'ownNames'>): boolean {
  const iban = normIban(tx.counterpartyIban);
  if (iban && r.ownIbans.has(iban)) return true;
  const name = String(tx.counterpartyName || '').toLowerCase();
  if (name && r.ownNames.some(n => n && name.includes(n))) return true;
  return OWN_PURPOSE.test(String(tx.purpose || ''));
}

/** Платіж підпадає під правило: вхідний, на одному з рахунків, після запуску. */
export const inScope = (tx: TxLite, r: Pick<IdentRules, 'accountIds' | 'identFrom'>) =>
  tx.incoming && r.accountIds.includes(Number(tx.accountId)) && tx.bookedAt >= r.identFrom;

export const deadlineOf = (tx: TxLite, r: Pick<IdentRules, 'hours' | 'holidays'>) =>
  identDeadline(tx.bookedAt, tx.seenAt, { hours: r.hours, holidays: r.holidays });

export interface BaseStatus {
  status: IdentStatus;
  deadline: number;
  /** Строк минув, а рядка ще немає — треба зафіксувати «неідентифікований» (system). */
  expiredNow?: boolean;
}

/** Статус без урахування прав. null — платіж не підпадає під правило (рядка «№ рахунку» немає). */
export function baseStatus(tx: TxLite, row: IdentRow | null | undefined, now: number, r: IdentRules): BaseStatus | null {
  if (!inScope(tx, r)) return null;
  if (row) return { status: row.status, deadline: Date.parse(row.deadlineAt) };
  const deadline = deadlineOf(tx, r);
  if (isOwnTransfer(tx, r)) return { status: 'own', deadline };
  if (now >= deadline) return { status: 'unidentified', deadline, expiredNow: true };
  return { status: 'wait', deadline };
}

export interface UserRights { tag: boolean; fix: boolean; nc: boolean; reset?: boolean }

/** Стан для інтерфейсу. */
export function buildState(tx: TxLite, row: IdentRow | null | undefined, base: BaseStatus, rights: UserRights, events: number, now?: number): IdentState {
  const s = base.status;
  return {
    txId: tx.id,
    status: s,
    deadlineAt: s === 'wait' || s === 'unidentified' ? new Date(base.deadline).toISOString() : null,
    invoiceNo: row?.invoiceNo ?? null,
    by: row?.by ?? null,
    at: row ? row.at : base.expiredNow ? new Date(base.deadline).toISOString() : null,
    firstBy: row?.firstBy ?? null,
    firstAt: row?.firstAt ?? null,
    changed: !!row?.changed,
    reason: row?.reason ?? null,
    note: row?.note ?? null,
    unidKind: row ? row.unidKind : base.expiredNow ? 'expired' : null,
    events,
    can: {
      set: s === 'wait' && (rights.tag || rights.fix),
      fix: s === 'identified' && rights.fix,
      nc: s === 'wait' && rights.nc,
      // [дашборд 28.10] скинути вписаний № — лише поки строк не минув (інакше фіналізатор одразу дасть «Неідентифікований»)
      // поле — лише тим, хто має право (іншим його немає, як і до 28.10)
      reset: rights.reset ? s === 'identified' && now !== undefined && now < base.deadline : undefined,
    },
  };
}

// ───────────── перевірки вводу (тексти — ті самі в інтерфейсі й на сервері) ─────────────

export const LIMITS = { no: 120, reason: 300, note: 300, comment: 1000 };
export const NC_REASONS = ['Повернення коштів', 'Помилковий платіж', 'Кошти власника', 'Інше'] as const;
export type NcReason = typeof NC_REASONS[number];

/** Номер — вільний текст (рішення Сергія «без перевірки» з реєстром), але хоча б одна цифра, щоб «ок» / «+» не рахувались. */
export const normNo = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
export function checkInvoiceNo(v: unknown): string {
  const s = normNo(v);
  if (!s) return 'Впишіть номер рахунку.';
  if (!/\d/.test(s)) return 'У номері має бути хоча б одна цифра.';
  if (s.length > LIMITS.no) return `Задовго — до ${LIMITS.no} символів.`;
  return '';
}
export const normText = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
export function checkReason(v: unknown): string {
  const s = normText(v);
  if (!s) return 'Вкажіть причину — вона піде в історію.';
  if (s.length > LIMITS.reason) return `Причина задовга — до ${LIMITS.reason} символів.`;
  return '';
}
export function checkNotClient(reason: unknown, note: unknown): string {
  if (!NC_REASONS.includes(reason as NcReason)) return 'Оберіть, що це за платіж.';
  const n = normText(note);
  if (reason === 'Інше' && !n) return 'Для «Інше» напишіть коментар.';
  if (n.length > LIMITS.note) return `Коментар задовгий — до ${LIMITS.note} символів.`;
  return '';
}
export function checkComment(v: unknown): string {
  const s = normText(v);
  if (!s) return 'Коментар порожній.';
  if (s.length > LIMITS.comment) return `Коментар задовгий — до ${LIMITS.comment} символів.`;
  return '';
}

/** Тексти відмов — однакові на сервері й у макеті. */
export const MSG = {
  late: 'Строк минув — номер уже не вписати.',
  lateNc: 'Строк минув — позначити вже не можна.',
  own: 'Це свій переказ — номер не потрібен.',
  changed: 'Поки ви редагували, номер змінився — гляньте актуальний.',
  same: 'Номер той самий — змінювати нічого.',
  notIdentified: 'Номера немає — змінювати нічого.',
  noRight: 'Немає права на цю дію.',
  notInScope: 'Для цього платежу номер рахунку не потрібен.',
  notFound: 'Платіж не знайдено.',
  notFopOut: 'Коментарі — лише до вихідних ФОП Беспятчук.',
  lateReset: 'Строк минув — скинути номер уже не можна: платіж став би «Неідентифікованим».',
};

/** Чому дію не виконано: стан уже інший (хтось устиг, строк минув) — текст за актуальним станом. */
export function conflictMsg(s: IdentState): string {
  const who = (p: Person | null) => (p && p.name ? ` — ${p.name}` : '');
  const dot = (t: string) => (/[.!?…]$/.test(t) ? t : t + '.');
  if (s.status === 'identified') return dot(`Номер уже зафіксовано: № ${s.invoiceNo}${who(s.firstBy || s.by)}`);
  if (s.status === 'unidentified') return s.unidKind === 'expired' ? MSG.late : 'Платіж уже визнано неідентифікованим.';
  if (s.status === 'not_client') return dot(`Платіж уже позначено «не оплата клієнта»${who(s.by)}`);
  if (s.status === 'own') return MSG.own;
  return 'Стан платежу змінився — гляньте актуальний.';
}

export const STATUS_LABEL: Record<IdentStatus, string> = {
  wait: 'Чекає №', identified: 'З номером', not_client: 'Не оплата клієнта', unidentified: 'Неідентифікований', own: 'Свій переказ',
};
