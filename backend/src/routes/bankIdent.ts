/**
 * 💳 «ВИПИСКА» — № РАХУНКУ НА ВХІДНИХ І КОМЕНТАРІ ДО ВИХІДНИХ ФОП: /api/bank-ident/* (27.10.2026).
 * Пакет Сергія `UTS_vypyska_nomer_rakhunku` (server/routes/bankIdent.ts) — правила, тексти, коди відповідей і порядок
 * перевірок ті самі. Змінено лише підключення до дашборда:
 *  1. Вхід — наш `requireAuth` + вкладка `bank` (routeTab); `req.user` збирається з `req.auth` (імʼя — `NAME_SQL`).
 *  2. Права — наші ключі «Ролі та доступи» (`roleHasPerm`): tag_bank_invoice · fix_bank_invoice · mark_bank_not_client ·
 *     bank_out_comments (сід — schema.sql). Кандидат — 403, як у пакеті.
 *  3. Адаптер виписки — `bankIdent/txSource.ts`: наші колонки, видалені рядки не існують, і `canSeeTx` = та сама межа,
 *     що в /api/bank/* (рахунки «лише фінанси», вихідні робочих карток, приховані отримувачі).
 *  4. Express 4 — async-помилки ловить `lib/asyncRoutes` (патч Router), далі — обробник пакета.
 *  5. Без спредів обʼєктів у відповідях (#17e2) — поля перелічено.
 * Фіналізатор прострочених — джоба `bankIdentFinalize` (index.ts, раз на 10 хв), а не setInterval пакета.
 */
import "../lib/asyncRoutes.js";
import express, { Router, type Response, type NextFunction } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasPerm } from "../auth/rbac.js";
import { NAME_SQL } from "../surveys/surveyRules.js";
import { getHiddenPayees, type HiddenPayee } from "../core/bankReport.js";
import {
  MSG, NC_REASONS, checkComment, checkInvoiceNo, checkNotClient, checkReason, conflictMsg, deadlineOf, inScope, isOwnTransfer, normNo, normText,
  type IdentState, type NcReason, type StoredStatus, type Right,
} from "../bankIdent/bankIdent.js";
import {
  addComment, commentSummaries, comments, history, idsByStatus, insertExpired, insertIdentified, insertNotClient, rowsByIds,
  statusTotals, updateFix, updateUnidentify, withTx,
} from "../bankIdent/bankIdentStore.js";
import { bankIdentConfigFromEnv, identEngine, type BankIdentOptions, type FullRights } from "../bankIdent/identEngine.js";
import { HttpError, errorHandler, personOf, type AuthedRequest, type ReqUser } from "../bankIdent/rights.js";
import { canSeeTxRow, ourTxSource, publicRow, toLite, type BankTx } from "../bankIdent/txSource.js";
import { jobSkip, type JobSkip } from "../jobs/jobRuns.js";

const MAX_IDS = 500;

// приховані отримувачі — той самий список, що в /api/bank/outgoing; кеш на хвилину (на кожен рядок не ходимо в БД)
let payeesCache: { at: number; list: HiddenPayee[] } | null = null;
async function payees(): Promise<HiddenPayee[]> {
  if (payeesCache && Date.now() - payeesCache.at < 60_000) return payeesCache.list;
  payeesCache = { at: Date.now(), list: await getHiddenPayees() };
  return payeesCache.list;
}

const env = bankIdentConfigFromEnv();
export const bankIdentOptions: BankIdentOptions = {
  txs: ourTxSource(pool),
  can: (u: ReqUser, key: Right) => roleHasPerm(String(u.role || ""), key),
  canSeeTx: async (u: ReqUser, t: BankTx) => canSeeTxRow(t, {
    privateFinance: roleHasPerm(String(u.role || ""), "view_private_finance"),
    hiddenPayments: roleHasPerm(String(u.role || ""), "view_hidden_payments"),
  }, await payees()),
  accountIds: env.accountIds, outCommentAccountIds: env.outCommentAccountIds, hours: env.hours, holidays: env.holidays, identFrom: env.identFrom,
};

function parseIds(v: unknown): number[] {
  if (!Array.isArray(v)) throw new HttpError(400, "Потрібен масив ids.");
  if (v.length > MAX_IDS) throw new HttpError(400, `Забагато id за раз — до ${MAX_IDS}.`);
  const out = new Set<number>();
  for (const x of v) {
    const n = Number(x);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(400, "Некоректний id транзакції.");
    out.add(n);
  }
  return [...out];
}
function txIdOf(v: string): number {
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new HttpError(400, "Некоректний id транзакції.");
  return n;
}
const LIST_STATUSES = ["wait", "unidentified", "identified", "not_client"] as const;
type ListStatus = typeof LIST_STATUSES[number];

const engine = identEngine(pool, bankIdentOptions);
export const bankIdentRouter = Router();
bankIdentRouter.use(requireAuth);
bankIdentRouter.use(express.json({ limit: "64kb" }));
// req.user пакета = { id, name, role } — з нашої сесії; імʼя — з менеджера CRM / картки / акаунта
bankIdentRouter.use(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
  try {
    const a = req.auth!;
    const name = (await pool.query<{ name: string }>(`SELECT n.name FROM (${NAME_SQL}) n WHERE n.id = $1`, [a.userId])).rows[0]?.name ?? "";
    req.user = { id: a.userId, name, role: a.roleKey };
    next();
  } catch (e) { next(e); }
});

const r = bankIdentRouter;
async function visible(u: ReqUser, list: BankTx[]): Promise<BankTx[]> {
  const ok = await Promise.all(list.map((t) => Promise.resolve(bankIdentOptions.canSeeTx!(u, t))));
  return list.filter((_, i) => ok[i]);
}
async function oneTx(u: ReqUser, id: number): Promise<BankTx> {
  const [t] = await visible(u, await bankIdentOptions.txs.byIds([id]));
  if (!t) throw new HttpError(404, MSG.notFound);
  return t;
}
async function stateOf(t: BankTx, rights: FullRights, at: number): Promise<IdentState> {
  return (await engine.states([t], rights, at))[Number(t.id)];
}
async function scoped(u: ReqUser, id: number) {
  const t = await oneTx(u, id);
  const rules = await engine.rules();
  const lite = toLite(t);
  if (!inScope(lite, rules)) throw new HttpError(400, MSG.notInScope);
  return { t, lite, rules };
}
const conflict = (res: Response, msg: string, state: IdentState) => { res.status(409).json({ error: msg, state }); };

// ───────────── стани ─────────────
r.post("/state", async (req: AuthedRequest, res) => {
  personOf(req);
  const ids = parseIds(req.body?.ids);
  const rights = await engine.rightsOf(req.user!);
  const at = engine.now();
  const txs = await visible(req.user!, await bankIdentOptions.txs.byIds(ids));
  const states = await engine.states(txs, rights, at);
  res.json({ now: new Date(at).toISOString(), holidays: [...(await engine.rules()).holidays], states });
});

r.get("/counts", async (req: AuthedRequest, res) => {
  personOf(req);
  const rights = await engine.rightsOf(req.user!);
  const { waiting } = await engine.sweepOpen();
  const rules = await engine.rules();
  const wait = waiting.filter((t) => !isOwnTransfer(t, rules)).length;
  const totals = await statusTotals(pool, engine.accountIds);
  res.json({ wait, identified: totals.identified, not_client: totals.not_client, unidentified: totals.unidentified, badge: rights.tag ? wait : 0 });
});

r.get("/list", async (req: AuthedRequest, res) => {
  personOf(req);
  const status = String(req.query.status || "") as ListStatus;
  if (!LIST_STATUSES.includes(status)) throw new HttpError(400, "status: wait | unidentified | identified | not_client");
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rights = await engine.rightsOf(req.user!);
  const at = engine.now();
  const rules = await engine.rules();
  const { waiting } = await engine.sweepOpen(at);
  let ids: number[], total: number;
  if (status === "wait") {
    const w = waiting.filter((t) => !isOwnTransfer(t, rules));
    total = w.length; ids = w.slice(offset, offset + limit).map((t) => t.id);
  } else {
    ({ ids, total } = await idsByStatus(pool, status as StoredStatus, engine.accountIds, limit, offset));
  }
  const txs = await visible(req.user!, await bankIdentOptions.txs.byIds(ids));
  const byId = new Map(txs.map((t) => [Number(t.id), t]));
  const rows = ids.map((id) => byId.get(id)).filter((t): t is BankTx => !!t);
  const states = await engine.states(rows, rights, at);
  res.json({ now: new Date(at).toISOString(), holidays: [...rules.holidays], ids: rows.map((t) => Number(t.id)), rows: rows.map(publicRow), states, total });
});

r.get("/:txId/history", async (req: AuthedRequest, res) => {
  personOf(req);
  const id = txIdOf(String(req.params.txId));
  await scoped(req.user!, id);
  res.json({ events: await history(pool, id) });
});

// ───────────── дії ─────────────
r.post("/:txId/invoice", async (req: AuthedRequest, res) => {
  const me = personOf(req);
  const rights = await engine.rightsOf(req.user!);
  if (!rights.tag && !rights.fix) throw new HttpError(403, MSG.noRight);
  const e = checkInvoiceNo(req.body?.no);
  if (e) throw new HttpError(400, e);
  const no = normNo(req.body.no);
  const id = txIdOf(String(req.params.txId));
  const { t, lite, rules } = await scoped(req.user!, id);
  const at = engine.now();
  const out = await withTx(pool, async (c) => {
    if ((await rowsByIds(c, [id], true)).get(id)) return "taken" as const;
    if (isOwnTransfer(lite, rules)) return "own" as const;
    const deadline = deadlineOf(lite, rules);
    const nr = { txId: id, accountId: lite.accountId, bookedAt: lite.bookedAt, deadline };
    if (at >= deadline) { await insertExpired(c, [nr]); return "late" as const; }
    return (await insertIdentified(c, nr, no, me, at)) ? "ok" as const : "taken" as const;
  });
  const state = await stateOf(t, rights, at);
  if (out !== "ok") return conflict(res, out === "late" ? MSG.late : conflictMsg(state), state);
  res.status(201).json({ state });
});

r.patch("/:txId/invoice", async (req: AuthedRequest, res) => {
  const me = personOf(req);
  const rights = await engine.rightsOf(req.user!);
  if (!rights.fix) throw new HttpError(403, MSG.noRight);
  const e = checkInvoiceNo(req.body?.no) || checkReason(req.body?.reason);
  if (e) throw new HttpError(400, e);
  const no = normNo(req.body.no), reason = normText(req.body.reason), expected = normNo(req.body?.expected);
  if (!expected) throw new HttpError(400, "Потрібен expected — номер, який ви бачили на екрані.");
  if (no === expected) throw new HttpError(400, MSG.same);
  const id = txIdOf(String(req.params.txId));
  const { t } = await scoped(req.user!, id);
  const at = engine.now();
  const row = await withTx(pool, (c) => updateFix(c, id, expected, no, reason, me, at));
  const state = await stateOf(t, rights, at);
  if (!row) return conflict(res, state.status === "identified" ? MSG.changed : conflictMsg(state), state);
  res.json({ state });
});

r.post("/:txId/unidentify", async (req: AuthedRequest, res) => {
  const me = personOf(req);
  const rights = await engine.rightsOf(req.user!);
  if (!rights.fix) throw new HttpError(403, MSG.noRight);
  const e = checkReason(req.body?.reason);
  if (e) throw new HttpError(400, e);
  const reason = normText(req.body.reason), expected = normNo(req.body?.expected);
  if (!expected) throw new HttpError(400, "Потрібен expected — номер, який ви бачили на екрані.");
  const id = txIdOf(String(req.params.txId));
  const { t } = await scoped(req.user!, id);
  const at = engine.now();
  const row = await withTx(pool, (c) => updateUnidentify(c, id, expected, reason, me, at));
  const state = await stateOf(t, rights, at);
  if (!row) return conflict(res, state.status === "identified" ? MSG.changed : conflictMsg(state), state);
  res.json({ state });
});

r.post("/:txId/not-client", async (req: AuthedRequest, res) => {
  const me = personOf(req);
  const rights = await engine.rightsOf(req.user!);
  if (!rights.nc) throw new HttpError(403, MSG.noRight);
  const reason = req.body?.reason as NcReason, note = normText(req.body?.note);
  const e = checkNotClient(reason, note);
  if (e) throw new HttpError(400, e);
  if (!NC_REASONS.includes(reason)) throw new HttpError(400, "Оберіть, що це за платіж.");
  const id = txIdOf(String(req.params.txId));
  const { t, lite, rules } = await scoped(req.user!, id);
  const at = engine.now();
  const out = await withTx(pool, async (c) => {
    if ((await rowsByIds(c, [id], true)).get(id)) return "taken" as const;
    if (isOwnTransfer(lite, rules)) return "own" as const;
    const deadline = deadlineOf(lite, rules);
    const nr = { txId: id, accountId: lite.accountId, bookedAt: lite.bookedAt, deadline };
    if (at >= deadline) { await insertExpired(c, [nr]); return "late" as const; }
    return (await insertNotClient(c, nr, reason, note, me, at)) ? "ok" as const : "taken" as const;
  });
  const state = await stateOf(t, rights, at);
  const expired = state.status === "unidentified" && state.unidKind === "expired";
  if (out !== "ok") return conflict(res, out === "late" || expired ? MSG.lateNc : conflictMsg(state), state);
  res.status(201).json({ state });
});

// ───────────── коментарі до вихідних ФОП (право bank_out_comments; без нього — 403, коментарів не видно взагалі) ─────────────
async function fopOut(u: ReqUser, id: number) {
  const t = await oneTx(u, id);
  if (!engine.isFopOut(toLite(t))) throw new HttpError(400, MSG.notFopOut);
  return t;
}
r.post("/comments/summary", async (req: AuthedRequest, res) => {
  personOf(req);
  const rights = await engine.rightsOf(req.user!);
  if (!rights.oc) throw new HttpError(403, MSG.noRight);
  const ids = parseIds(req.body?.ids);
  const txs = (await visible(req.user!, await bankIdentOptions.txs.byIds(ids))).filter((t) => engine.isFopOut(toLite(t)));
  const sums = await commentSummaries(pool, txs.map((t) => Number(t.id)));
  const out: Record<number, { count: number; last: unknown }> = {};
  for (const t of txs) out[Number(t.id)] = sums.get(Number(t.id)) || { count: 0, last: null };
  res.json({ summaries: out });
});
r.get("/:txId/comments", async (req: AuthedRequest, res) => {
  personOf(req);
  const rights = await engine.rightsOf(req.user!);
  if (!rights.oc) throw new HttpError(403, MSG.noRight);
  const id = txIdOf(String(req.params.txId));
  await fopOut(req.user!, id);
  res.json({ comments: await comments(pool, id) });
});
r.post("/:txId/comments", async (req: AuthedRequest, res) => {
  const me = personOf(req);
  const rights = await engine.rightsOf(req.user!);
  if (!rights.oc) throw new HttpError(403, MSG.noRight);
  const e = checkComment(req.body?.body);
  if (e) throw new HttpError(400, e);
  const id = txIdOf(String(req.params.txId));
  await fopOut(req.user!, id);
  const comment = await addComment(pool, id, me, normText(req.body.body), engine.now());
  const summary = (await commentSummaries(pool, [id])).get(id) || { count: 1, last: comment };
  res.status(201).json({ comment, summary });
});

r.use(errorHandler("bank-ident"));

/**
 * Фіналізатор (джоба `bankIdentFinalize`, раз на 10 хв): фіксує «неідентифікований» усім, у кого минув строк, навіть якщо
 * екран ніхто не відкривав — щоб фільтр і лічильники були повні. Тіло — `runOnce` пакета (advisory lock — кілька
 * процесів не дублюють); повертає, скільки зафіксовано вперше. Зайнятий замок — `jobSkip`, а не «успіх з нулем».
 */
export async function bankIdentFinalizeOnce(): Promise<{ expired: number } | JobSkip> {
  const LOCK = 7_340_027_001;
  const c = await pool.connect();
  try {
    const got = (await c.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK])).rows[0].ok;
    if (!got) return jobSkip("фіналізатор уже біжить в іншому процесі (advisory lock)"); // пропуск ≠ успіх
    try {
      const rules = await engine.rules();
      return { expired: (await engine.sweepOpen(engine.now(), rules.identFrom)).expired };
    } finally {
      await c.query("SELECT pg_advisory_unlock($1)", [LOCK]);
    }
  } finally {
    c.release();
  }
}
