/**
 * Рушій правила «№ рахунку за 48 год»: налаштування, права користувача, стани платежів, фіксація прострочених.
 * Один на процес; ним користуються роутер (routes/bankIdent.ts) і фоновий фіналізатор (startIdentFinalizer).
 */
import type { Pool } from 'pg';
import {
  DEFAULT_ACCOUNT_IDS, DEFAULT_OUT_COMMENT_ACCOUNT_IDS, DEFAULT_OWN_NAMES, LOOKBACK_DAYS, RIGHT_KEYS,
  baseStatus, buildState, inScope, isOwnTransfer, normIban,
  type IdentRules, type IdentState, type Right, type TxLite, type UserRights,
} from './bankIdent.js';
import { parseHolidays } from './identDeadline.js';
import { eventCounts, getIdentFrom, insertExpired, rowsByIds, type NewRow } from './bankIdentStore.js';
import { HttpError, defaultCanFn, type CanFn, type ReqUser } from './rights.js';
import { toLite, type BankTx, type TxSource } from './txSource.js';

export interface BankIdentOptions {
  /** Адаптер до вашої таблиці виписки (server/txSource.ts). */
  txs: TxSource;
  /** Перевірка прав з «Ролі та доступи». Не передано — за кодами ролей (shared/bankIdent.ts → RIGHTS). */
  can?: CanFn;
  /** Рахунки, де вписують № (за замовчуванням 3, 4, 11 — ФОП Приват, ФОП Моно, картка Ступаківського; звірено 27.10). */
  accountIds?: number[];
  /** Рахунки, де коментарі до вихідних (за замовчуванням 3, 4 — ФОП). */
  outCommentAccountIds?: number[];
  /** Строк у робочих годинах (48). */
  hours?: number;
  /** Свята 'YYYY-MM-DD' (масив або рядок через кому). У воєнний стан — порожньо. */
  holidays?: string[] | string | null;
  /** Запуск правила. Не передано — з bank_ident_settings (момент першої міграції). */
  identFrom?: Date | string | null;
  /** Частини назв контрагента, за якими платіж — свій (за замовчуванням «беспятчук»). */
  ownNames?: string[];
  /** Чи бачить користувач транзакцію (приховані отримувачі на вихідних — лише адмін). Не передано — бачать усі. */
  canSeeTx?: (u: ReqUser, tx: BankTx) => boolean | Promise<boolean>;
  now?: () => Date;
}

export type FullRights = UserRights & { oc: boolean };

export function bankIdentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<BankIdentOptions> {
  const ids = (s?: string) => (s ? s.split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n > 0) : undefined);
  return {
    accountIds: ids(env.BANK_IDENT_ACCOUNT_IDS),
    outCommentAccountIds: ids(env.BANK_OUT_COMMENT_ACCOUNT_IDS),
    hours: env.BANK_IDENT_HOURS ? Number(env.BANK_IDENT_HOURS) : undefined,
    holidays: env.BANK_IDENT_HOLIDAYS || undefined,
    identFrom: env.BANK_IDENT_FROM || undefined,
  };
}

export function identEngine(pool: Pool, opts: BankIdentOptions) {
  const now = () => (opts.now ? opts.now() : new Date()).getTime();
  const can = opts.can || defaultCanFn;
  const accountIds = opts.accountIds && opts.accountIds.length ? opts.accountIds.map(Number) : DEFAULT_ACCOUNT_IDS;
  const outIds = opts.outCommentAccountIds && opts.outCommentAccountIds.length ? opts.outCommentAccountIds.map(Number) : DEFAULT_OUT_COMMENT_ACCOUNT_IDS;
  const hours = opts.hours && opts.hours > 0 ? opts.hours : 48;
  const holidays = parseHolidays(opts.holidays ?? null);
  const ownNames = (opts.ownNames || DEFAULT_OWN_NAMES).map(s => s.toLowerCase()).filter(Boolean);
  const fixedFrom = opts.identFrom ? Date.parse(opts.identFrom instanceof Date ? opts.identFrom.toISOString() : String(opts.identFrom)) : null;
  if (fixedFrom !== null && !Number.isFinite(fixedFrom)) throw new Error(`BANK_IDENT_FROM: не дата «${opts.identFrom}»`);

  let cache: { at: number; r: IdentRules } | null = null;
  async function rules(): Promise<IdentRules> {
    if (cache && Date.now() - cache.at < 10 * 60_000) return cache.r;
    const identFrom = fixedFrom ?? (await getIdentFrom(pool));
    if (identFrom === null) throw new HttpError(503, 'Не запущено міграцію 001_bank_ident.sql.');
    const ibans = new Set((await opts.txs.ownIbans()).map(normIban).filter(Boolean));
    cache = { at: Date.now(), r: { accountIds, identFrom, hours, holidays, ownIbans: ibans, ownNames } };
    return cache.r;
  }

  async function rightsOf(u: ReqUser): Promise<FullRights> {
    const [tag, fix, nc, oc] = await Promise.all(RIGHT_KEYS.map((k: Right) => Promise.resolve(can(u, k))));
    return { tag: !!tag, fix: !!fix, nc: !!nc, oc: !!oc };
  }

  const newRow = (t: TxLite, deadline: number): NewRow => ({ txId: t.id, accountId: t.accountId, bookedAt: t.bookedAt, deadline });

  /** Стани для транзакцій (лише ті, що під правилом). Прострочені без рядка — фіксує як «неідентифіковані». */
  async function states(txs: BankTx[], rights: UserRights, at = now()): Promise<Record<number, IdentState>> {
    const r = await rules();
    const lites = txs.map(toLite).filter(t => inScope(t, r));
    if (!lites.length) return {};
    const ids = lites.map(t => t.id);
    const rows = await rowsByIds(pool, ids);
    const expired: NewRow[] = [];
    for (const t of lites) {
      const b = baseStatus(t, rows.get(t.id), at, r);
      if (b && b.expiredNow) expired.push(newRow(t, b.deadline));
    }
    if (expired.length) {
      await insertExpired(pool, expired);
      (await rowsByIds(pool, expired.map(x => x.txId))).forEach((v, k) => rows.set(k, v));
    }
    const counts = await eventCounts(pool, ids);
    const out: Record<number, IdentState> = {};
    for (const t of lites) {
      const row = rows.get(t.id) || null;
      out[t.id] = buildState(t, row, baseStatus(t, row, at, r)!, rights, counts.get(t.id) || 0);
    }
    return out;
  }

  /**
   * Платежі без рядка з since: прострочені — фіксує «неідентифікованими», решту повертає (чекають або свої перекази).
   * since за замовчуванням — 14 днів назад (але не раніше запуску правила).
   */
  async function sweepOpen(at = now(), sinceMs?: number): Promise<{ waiting: TxLite[]; expired: number }> {
    const r = await rules();
    const since = Math.max(r.identFrom, sinceMs ?? at - LOOKBACK_DAYS * 864e5);
    const list = (await opts.txs.openIncoming(accountIds, new Date(since))).map(toLite).filter(t => inScope(t, r));
    const waiting: TxLite[] = [], expired: NewRow[] = [];
    for (const t of list) {
      const b = baseStatus(t, null, at, r);
      if (!b) continue;
      if (b.expiredNow) expired.push(newRow(t, b.deadline));
      else if (b.status === 'wait') waiting.push(t);
    }
    const n = expired.length ? await insertExpired(pool, expired) : 0;
    return { waiting: waiting.sort((a, b) => b.bookedAt - a.bookedAt), expired: n };
  }

  const isFopOut = (t: TxLite) => !t.incoming && outIds.includes(t.accountId);
  return { now, rules, rightsOf, states, sweepOpen, accountIds, outIds, isFopOut, isOwn: (t: TxLite, r: IdentRules) => isOwnTransfer(t, r) };
}
export type IdentEngine = ReturnType<typeof identEngine>;

/**
 * Фоновий фіналізатор: раз на 10 хв фіксує «неідентифікований» усім, у кого минув строк (навіть якщо екран ніхто не відкривав),
 * щоб звіти й фільтр «Неідентифіковані» були повні. Кілька інстансів — нормально: pg_try_advisory_lock.
 */
export function startIdentFinalizer(pool: Pool, opts: BankIdentOptions, everyMs = 10 * 60_000): { stop(): void; runOnce(): Promise<number> } {
  const engine = identEngine(pool, opts);
  const LOCK = 7_340_027_001;
  async function runOnce(): Promise<number> {
    const c = await pool.connect();
    try {
      const got = (await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK])).rows[0].ok;
      if (!got) return 0;
      try {
        const r = await engine.rules();
        return (await engine.sweepOpen(engine.now(), r.identFrom)).expired;
      } finally {
        await c.query('SELECT pg_advisory_unlock($1)', [LOCK]);
      }
    } finally {
      c.release();
    }
  }
  const timer = setInterval(() => { runOnce().catch(e => console.error('[bank-ident] фіналізатор:', e instanceof Error ? e.message : e)); }, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer), runOnce };
}
