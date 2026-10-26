/**
 * Express Router «Узгодження роботи з новим контрагентом» + «Перевірка контрагента»: /api/counterparty/*.
 * Підключення (за вашим requireAuth, як інші вкладки):
 *   const ys = youScoreFromEnv();                                    // server/youscore/client.ts — ключ лише з env
 *   const cp = counterpartyRouter(pool, {
 *     youscore: ys,
 *     files: dirFileStore(process.env.CP_FILES_DIR || './data/counterparty'),
 *     approverIds: (process.env.CP_APPROVER_IDS || process.env.MINUS_APPROVER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
 *     teamOf: u => teamMemberIds(u.id),                              // обсяг «Команда» тім-ліда
 *   });
 *   app.use('/api/counterparty', requireAuth, cp);
 *
 * Права (рішення Сергія 21–23.10) — перевіряє сервер, інтерфейс лише ховає кнопки:
 *   менеджер і тім-лід — подають запити, бачать свої; тім-лід — ще й запити команди (лише перегляд);
 *   погоджує ЛИШЕ акаунт Сергія (approverIds); бухгалтерія й керівники — бачать усе, без дій;
 *   перевірити контрагента може будь-хто з доступом до вкладки; залишок транзакцій бачить лише Сергій.
 */
import express, { Router, type Response } from 'express';
import type { Pool } from 'pg';
import {
  COUNTRIES, NOTE_EMPTY, STATUS_LABEL, allowedActions, askedLines, canSee, canSubmit, checkCode, checkText, cleanCode, diffLines, isCpAction,
  parseTerms, sameTerms, seesAll, seesRequests, termsLine,
  type CpAction, type CpRequest, type CpRole, type CpUser, type Rates, type Terms,
} from '../../shared/counterparty.js';
import { DEFAULT_LAG, type Lag } from '../../shared/cpCalc.js';
import type { CheckContext, CheckView, CpCheck } from '../../shared/cpCheck.js';
import { checkRunner, checkedNote, type CheckRunner } from '../cpChecks.js';
import { HttpError, defaultCpRoleOf, errorHandler, meOf, type AuthedRequest, type ReqUser } from '../cpRoles.js';
import {
  activeRequestByCode, addEvent, countForMe, freshCheck, getCheck, getRequest, lastRequestByCode, latestDone, listChecks, listRequests, runningCheck, tx, withChecks,
} from '../cpStore.js';
import type { DebtSource } from '../debtSource.js';
import type { FileStore } from '../fileStore.js';
import { ycBudget, type BudgetInfo } from '../ycBudget.js';
import { endRequestLimit, limitByMember, markCourtsSeen, upsertFromRequest } from '../limitsStore.js';
import { nbuRates } from '../nbu.js';
import type { YouScoreApi } from '../youscore/client.js';

export interface CounterpartyOptions {
  /** YouScore (YouControl). null — ключа немає: перевірки відповідають 503 з поясненням, решта працює. */
  youscore: YouScoreApi | null;
  /** Документи до запитів і PDF-досьє. */
  files: FileStore;
  /** users.id тих, хто погоджує. За рішенням — лише акаунт Сергія (операційний директор). */
  approverIds?: string[];
  /** Одне місце, де ролі дашборда стають ролями цих вкладок. За замовчуванням — defaultCpRoleOf(approverIds). */
  roleOf?: (u: ReqUser) => CpRole | null;
  /** Команда тім-ліда: users.id його менеджерів (без нього самого). */
  teamOf?: (u: ReqUser) => string[] | Promise<string[]>;
  /** Курс НБУ (€, $). За замовчуванням — nbuRates() з кешем на день. */
  rates?: () => Promise<Rates>;
  /** Через скільки днів після вивантаження — рахунок і оригінали. Оригінали — налаштування (за замовчуванням 10). */
  lag?: Lag;
  /** Найбільший документ, МБ (за замовчуванням 20). */
  maxFileMb?: number;
  /** Скільки власників перевіряти на «скільки компаній у власника» (кожен — +1 транзакція). */
  ownerLookups?: number;
  now?: () => Date;
  /** Готовий runner (щоб планові перевірки й цей роутер ділили той самий). */
  runner?: CheckRunner;
  /** Дебіторка — для резерву транзакцій (суди боржникам). Не передано — резерв лише на планові перевірки. */
  debts?: DebtSource;
  /** Бюджет YouControl. За замовчуванням — ycBudget({ pool, youscore, debts }) з кешем 5 хв. */
  budget?: () => Promise<BudgetInfo>;
}

const DUP_STATUSES = ['checking', 'pending', 'returned', 'approved'];
const FILE_NAME_MAX = 255;

export function counterpartyRouter(pool: Pool, opts: CounterpartyOptions): Router & { runner: CheckRunner } {
  const roleOf = opts.roleOf || defaultCpRoleOf(opts.approverIds || []);
  const me = (req: AuthedRequest) => meOf(req, { roleOf, teamOf: opts.teamOf });
  const now = opts.now || (() => new Date());
  const lag = opts.lag || DEFAULT_LAG;
  const rates = opts.rates || nbuRates();
  const runner = opts.runner || checkRunner({ pool, youscore: opts.youscore, files: opts.files, now, ownerLookups: opts.ownerLookups });
  const budget = opts.budget || ycBudget({ pool, youscore: opts.youscore, debts: opts.debts, now });
  const budgetFor = async (u: CpUser) => (u.role === 'approver' && opts.youscore ? budget().catch(() => null) : null);
  const r = Router() as Router & { runner: CheckRunner };
  r.runner = runner;
  const json = express.json({ limit: '256kb' });
  const raw = express.raw({ type: () => true, limit: `${opts.maxFileMb ?? 20}mb` });

  const visibleReq = (u: CpUser, q: Pick<CpRequest, 'createdBy'>) => seesRequests(u.role) && canSee(u, q);
  const owners = (u: CpUser) => (seesAll(u.role) ? undefined : [u.id, ...(u.team || [])]);
  const view = async (q: CpRequest) => (await withChecks(pool, [q]))[0];

  async function ctxOf(c: CpCheck, u: CpUser): Promise<CheckContext> {
    const latest = await latestDone(pool, c.code);
    const q = await lastRequestByCode(pool, c.code);
    const lim = q && DUP_STATUSES.includes(q.status) ? null : await limitByMember(pool, c.code);
    return {
      latest: latest ? { id: latest.id, at: latest.at, byName: latest.byName } : null,
      req: q ? { id: q.id, status: q.status, byName: q.createdByName, visible: visibleReq(u, q), okLine: q.status === 'approved' && q.ok ? termsLine(q.ok) : null, okLimit: q.status === 'approved' && q.ok ? q.ok.limit : null } : null,
      limit: lim && lim.src !== 'req' ? { limit: lim.limit, days: lim.days, from: lim.from, src: lim.src } : null,
    };
  }
  const checkView = async (c: CpCheck, u: CpUser): Promise<CheckView> => ({ ...c, ctx: await ctxOf(c, u) });

  // ---------- запити ----------
  r.get('/requests', async (req: AuthedRequest, res) => {
    const u = await me(req);
    if (!seesRequests(u.role)) throw new HttpError(403, 'Немає доступу до запитів на погодження.');
    const list = await listRequests(pool, owners(u));
    res.json({ me: u, requests: await withChecks(pool, list), rates: await rates(), lag, budget: await budgetFor(u) });
  });
  r.get('/requests/counter', async (req: AuthedRequest, res) => {
    const u = await me(req);
    res.json({ count: await countForMe(pool, u) });
  });

  /** Форма «Новий клієнт»: є запит з цим кодом? є збережена перевірка? інакше — запускає нову (src 'req'). */
  r.post('/lookup', json, async (req: AuthedRequest, res) => {
    const u = await me(req);
    if (!canSubmit(u.role)) throw new HttpError(403, 'Подавати запити можуть менеджери й тім-ліди.');
    const code = cleanCode((req.body || {}).code);
    const bad = checkCode(code); if (bad) throw new HttpError(400, bad);
    const dup = await activeRequestByCode(pool, code);
    if (dup) {
      res.json({ dup: { id: dup.id, status: dup.status, name: dup.name, byName: dup.createdByName, at: dup.createdAt, ok: dup.status === 'approved' ? dup.ok : null, terms: dup.terms, visible: visibleReq(u, dup) } });
      return;
    }
    const lim = await limitByMember(pool, code);
    const limit = lim && lim.src !== 'req' ? { limit: lim.limit, days: lim.days, from: lim.from, src: lim.src } : null;
    const fresh = await freshCheck(pool, code, now());
    if (fresh) { res.json({ check: await checkView(fresh, u), saved: true, limit }); return; }
    const running = await runningCheck(pool, code);
    const c = running || await runner.start(code, u, 'req');
    res.json({ check: await checkView(c, u), saved: false, limit });
  });

  r.post('/requests', json, async (req: AuthedRequest, res) => {
    const u = await me(req);
    if (!canSubmit(u.role)) throw new HttpError(403, 'Подавати запити можуть менеджери й тім-ліди.');
    const b = req.body || {};
    const pt = parseTerms(b.terms); if ('error' in pt) throw new HttpError(400, pt.error);
    const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
    if (comment.length > 2000) throw new HttpError(400, 'Коментар — до 2000 символів.');
    const fileIds: string[] = Array.isArray(b.files) ? [...new Set(b.files.map(String))] as string[] : [];
    if (!fileIds.length || fileIds.some(x => !/^\d{1,18}$/.test(x))) throw new HttpError(400, 'Додайте хоча б один документ.');
    const own = await pool.query('SELECT id FROM cp_files WHERE id = ANY($1::bigint[]) AND uploaded_by = $2 AND request_id IS NULL', [fileIds, u.id]);
    if (own.rows.length !== fileIds.length) throw new HttpError(400, 'Документи не знайдено — завантажте ще раз.');
    const rt = await rates();
    for (const cur of [pt.terms.cl.cur, pt.terms.ca.cur]) {
      if (cur !== 'uah' && !(rt[cur] > 0)) throw new HttpError(503, 'Курс НБУ зараз недоступний — ставки в € / $ не перерахувати. Спробуйте за кілька хвилин.');
    }
    let id: string | null;
    let waitCheck: string | null = null;
    if (b.resident !== false) {
      const code = cleanCode(b.code);
      const bad = checkCode(code); if (bad) throw new HttpError(400, bad);
      const dup = await activeRequestByCode(pool, code);
      if (dup) throw new HttpError(409, `${dup.name} уже має запит — ${STATUS_LABEL[dup.status].toLowerCase()}.`, visibleReq(u, dup) ? { requestId: dup.id } : undefined);
      const c = await getCheck(pool, b.checkId ? String(b.checkId) : null);
      if (!c || c.code !== code || c.status === 'failed') throw new HttpError(400, 'Спершу перевірте клієнта в YouControl.');
      const base = c.subj || c.base;
      if (!base) throw new HttpError(409, 'YouControl ще повертає дані ЄДР — зачекайте кілька секунд.');
      const mine = (await pool.query("SELECT (created_by = $2 AND src = 'req' AND created_at > now() - interval '1 day') AS mine FROM cp_checks WHERE id = $1", [c.id, u.id])).rows[0]?.mine;
      const saved = !mine;
      const status = c.status === 'running' ? 'checking' : 'pending';
      id = await tx(pool, async db => {
        const ins = await db.query(`INSERT INTO cp_requests (resident, code, name, kind, status, terms, rates, check_id, check_saved, comment, created_by, created_by_name)
          VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING RETURNING id`,
        [code, base.name, base.kind, status, JSON.stringify(pt.terms), JSON.stringify(rt), c.id, saved, comment, u.id, u.name]);
        if (!ins.rows[0]) return null;
        const rid = String(ins.rows[0].id);
        await db.query('UPDATE cp_files SET request_id = $1 WHERE id = ANY($2::bigint[])', [rid, fileIds]);
        await addEvent(db, rid, 'submitted', u);
        if (status === 'pending') await addEvent(db, rid, 'checked', null, checkedNote(c, saved, now()));
        return rid;
      });
      if (!id) throw new HttpError(409, 'Цей клієнт уже має запит — оновіть сторінку.');
      if (status === 'checking') waitCheck = c.id;
      else if (!c.pdf) void runner.pdfFor(c.id).catch(() => undefined);
    } else {
      const country = typeof b.country === 'string' ? b.country.trim() : '';
      const regNo = typeof b.regNo === 'string' ? b.regNo.trim() : '';
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!COUNTRIES.includes(country)) throw new HttpError(400, 'Оберіть країну.');
      if (!regNo || regNo.length > 120) throw new HttpError(400, 'Вкажіть реєстраційний номер / VAT.');
      if (!name || name.length > 200) throw new HttpError(400, 'Вкажіть назву компанії.');
      const code = regNo.split(/[·,;]/)[0].trim().slice(0, 60);
      id = await tx(pool, async db => {
        const ins = await db.query(`INSERT INTO cp_requests (resident, code, country, reg_no, name, kind, status, terms, rates, comment, created_by, created_by_name)
          VALUES (false, $1, $2, $3, $4, 'Нерезидент', 'pending', $5, $6, $7, $8, $9) RETURNING id`,
        [code, country, regNo, name, JSON.stringify(pt.terms), JSON.stringify(rt), comment, u.id, u.name]);
        const rid = String(ins.rows[0].id);
        await db.query('UPDATE cp_files SET request_id = $1 WHERE id = ANY($2::bigint[])', [rid, fileIds]);
        await addEvent(db, rid, 'submitted', u);
        return rid;
      });
    }
    if (waitCheck) await runner.settle(waitCheck);          // перевірка могла завершитися, поки зберігали запит
    res.status(201).json(await view((await getRequest(pool, id!))!));
  });

  // ---------- дії над запитом ----------
  r.post('/requests/:id/:action', json, async (req: AuthedRequest, res) => {
    const u = await me(req);
    const id = String(req.params.id), action = String(req.params.action);
    if (!/^\d{1,18}$/.test(id) || !isCpAction(action)) throw new HttpError(404, 'Запит не знайдено.');
    const a: CpAction = action;
    const b = req.body || {};
    const before = await getRequest(pool, id);
    if (!before || !visibleReq(u, before)) throw new HttpError(404, 'Запит не знайдено.');
    if (!allowedActions(u, before).includes(a)) {
      // могли не встигнути оновити сторінку: статус уже інший → 409 зі свіжим станом; інакше — немає прав
      const could = (['approve', 'approveChanged', 'return', 'reject', 'recheck', 'changeApprove', 'changeReject'] as CpAction[]).includes(a) ? u.role === 'approver'
        : ['resubmit', 'requestChange'].includes(a) && canSubmit(u.role) && before.createdBy === u.id;
      if (could) throw new HttpError(409, `Запит уже «${STATUS_LABEL[before.status]}» — оновіть сторінку.`, { request: await view(before) });
      throw new HttpError(403, 'Немає прав на цю дію.');
    }
    // перевірка тексту / умов — до запису
    const noteMsg = NOTE_EMPTY[a];
    const note = typeof b.note === 'string' ? b.note.trim() : typeof b.reason === 'string' ? b.reason.trim() : '';
    if (noteMsg) { const e = checkText(note, noteMsg); if (e) throw new HttpError(400, e); }
    let terms: Terms | null = null;
    if (a === 'approveChanged' || a === 'resubmit' || a === 'requestChange' || (a === 'changeApprove' && b.terms)) {
      const pt = parseTerms(b.terms); if ('error' in pt) throw new HttpError(400, pt.error);
      terms = pt.terms;
    }
    if (a === 'resubmit' && typeof b.comment === 'string' && b.comment.trim().length > 2000) throw new HttpError(400, 'Коментар — до 2000 символів.');
    if (a === 'requestChange' && before.ok && sameTerms(terms, before.ok)) throw new HttpError(400, 'Умови не змінились.');
    if (a === 'changeApprove' && before.ok && before.change && sameTerms(terms || before.change.terms, before.ok)) throw new HttpError(400, 'Це чинні умови — щоб лишити їх, відхиліть зміну.');

    // «Перевірити заново» — нова перевірка (гроші), запит лишається «На погодженні»
    if (a === 'recheck') {
      if (before.recheckId) { const rc = await getCheck(pool, before.recheckId); if (rc && rc.status === 'running') throw new HttpError(409, 'Перевірка вже триває.'); }
      const c = await runner.start(before.code, u, 'req');
      await pool.query('UPDATE cp_requests SET recheck_id = $2, updated_at = now() WHERE id = $1', [id, c.id]);
      await runner.settle(c.id);
      res.json(await view((await getRequest(pool, id))!));
      return;
    }

    const out = await tx(pool, async db => {
      const cur = (await db.query('SELECT status, change, ok FROM cp_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur || cur.status !== before.status || !!cur.change !== !!before.change) return 'conflict' as const;
      const q = before;
      const set = async (sql: string, vals: unknown[]) => db.query(`UPDATE cp_requests SET ${sql}, updated_at = now() WHERE id = $1`, [id, ...vals]);
      if (a === 'approve' || a === 'approveChanged') {
        const base: Terms = q.ok || q.terms;
        const t = a === 'approve' ? base : terms!;
        const same = sameTerms(t, base);
        await set("status = 'approved', ok = $2, flag = NULL", [JSON.stringify(t)]);
        await addEvent(db, id, same ? 'approved' : 'approvedChanged', u, same ? '' : ['Просили → погоджено:', ...diffLines(base, t)].join('\n'), same ? undefined : { before: base, after: t });
        await upsertFromRequest(db, { ...q, ok: t }, t, u);
        const chk = q.checkId ? await getCheck(db, q.checkId) : null;
        if (q.resident && chk?.subj) await markCourtsSeen(db, q.code, chk.subj.yc.cases.map(c => c.no));
      } else if (a === 'return' || a === 'reject') {
        await set('status = $2, flag = NULL, ok = NULL', [a === 'return' ? 'returned' : 'rejected']);   // погодження (якщо було) — недійсне
        await addEvent(db, id, a === 'return' ? 'returned' : 'rejected', u, note);
        if (q.ok) await endRequestLimit(db, id, u, a === 'return' ? 'Запит повернуто менеджеру — ліміт знято до нового погодження.' : 'Запит відхилено — ліміт знято.');
      } else if (a === 'resubmit') {
        const changed = !sameTerms(terms, q.terms);
        const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : q.comment;
        await set("status = 'pending', terms = $2, comment = $3", [JSON.stringify(terms), comment]);
        await addEvent(db, id, 'resubmitted', u, changed ? ['Змінено:', ...diffLines(q.terms, terms!)].join('\n') : '', comment !== q.comment ? { comment_before: q.comment } : undefined);
      } else if (a === 'requestChange') {
        const ch = { terms, reason: note, by: u.id, byName: u.name, at: now().toISOString() };
        await set('change = $2', [JSON.stringify(ch)]);
        await addEvent(db, id, 'changeRequested', u, ['Діє → просять:', ...diffLines(q.ok!, terms!), 'Причина: ' + note].join('\n'));
      } else if (a === 'changeApprove') {
        const asked = q.change!.terms, t = terms || asked;
        const lines = ['Було → погоджено:', ...diffLines(q.ok!, t)];
        if (!sameTerms(t, asked)) lines.push('Просили: ' + askedLines(t, asked).join('; '));
        await set('terms = $2, ok = $3, change = NULL', [JSON.stringify(asked), JSON.stringify(t)]);
        await addEvent(db, id, 'changeApproved', u, lines.join('\n'), { before: q.ok, after: t });
        await upsertFromRequest(db, { ...q, ok: t }, t, u);
      } else if (a === 'changeReject') {
        await set('change = NULL', []);
        await addEvent(db, id, 'changeRejected', u, note);
      }
      return 'ok' as const;
    });
    const now2 = await getRequest(pool, id);
    if (out === 'conflict') throw new HttpError(409, `Запит уже «${STATUS_LABEL[now2!.status]}» — оновіть сторінку.`, { request: await view(now2!) });
    if ((a === 'approve' || a === 'approveChanged') && now2!.checkId) void runner.pdfFor(now2!.checkId).catch(() => undefined);
    res.json(await view(now2!));
  });

  // ---------- перевірки ----------
  r.get('/checks', async (req: AuthedRequest, res) => {
    const u = await me(req);
    const all = u.role === 'approver';
    const list = await listChecks(pool, all ? undefined : u.id);
    // «є новіша»: найновіша завершена перевірка кожного коду — одним запитом
    const codes = [...new Set(list.map(c => c.code))];
    const lq = codes.length ? await pool.query(`SELECT DISTINCT ON (code) id, code, done_at, created_by_name FROM cp_checks
      WHERE status = 'done' AND src <> 'monitor' AND code = ANY($1::text[]) ORDER BY code, done_at DESC, id DESC`, [codes]) : { rows: [] };
    const latest = new Map<string, { id: string; at: string; byName: string | null }>(lq.rows.map((x: { id: string; code: string; done_at: string; created_by_name: string | null }) =>
      [x.code, { id: String(x.id), at: new Date(x.done_at).toISOString(), byName: x.created_by_name }]));
    const checks: CheckView[] = list.map(c => ({ ...c, ctx: { latest: latest.get(c.code) || null, req: null, limit: null } }));
    res.json({ me: u, checks, budget: await budgetFor(u) });
  });
  /** Вкладка «Перевірка контрагента»: збережена (якщо їй < 2 міс.) або нова. force — «Перевірити заново зараз» (лише Сергій). */
  r.post('/checks', json, async (req: AuthedRequest, res) => {
    const u = await me(req);
    const code = cleanCode((req.body || {}).code);
    const bad = checkCode(code); if (bad) throw new HttpError(400, bad);
    const force = !!(req.body || {}).force && u.role === 'approver';
    if (!force) {
      const fresh = await freshCheck(pool, code, now());
      if (fresh) { res.json({ check: await checkView(fresh, u), saved: true }); return; }
    }
    const running = await runningCheck(pool, code);                 // уже хтось перевіряє цей код — не платимо двічі
    if (!running && u.role !== 'approver' && opts.youscore) {
      const b = await budget().catch(() => null);
      if (b && b.low) throw new HttpError(409, 'Транзакції YouControl зараз потрібні на планові перевірки клієнтів — нові ручні перевірки робить лише Сергій. Збережені перевірки доступні.');
    }
    const c = running || await runner.start(code, u, 'tool');
    res.json({ check: await checkView(c, u), saved: false });
  });
  r.get('/checks/:id', async (req: AuthedRequest, res) => {
    const u = await me(req);
    const c = await getCheck(pool, String(req.params.id));
    if (!c) throw new HttpError(404, 'Перевірку не знайдено.');
    res.json(await checkView(c, u));
  });
  r.post('/checks/:id/pdf', async (req: AuthedRequest, res) => {
    const u = await me(req);
    const c = await getCheck(pool, String(req.params.id));
    if (!c || c.status !== 'done') throw new HttpError(404, 'Перевірку не знайдено.');
    const ok = await runner.pdfFor(c.id);
    if (!ok) throw new HttpError(502, 'YouControl не віддав PDF-досьє — спробуйте пізніше.');
    res.json(await checkView((await getCheck(pool, c.id))!, u));
  });
  r.get('/checks/:id/pdf', async (req: AuthedRequest, res) => {
    await me(req);
    const q = await pool.query('SELECT code, pdf_key FROM cp_checks WHERE id = $1', [/^\d{1,18}$/.test(String(req.params.id)) ? String(req.params.id) : '0']);
    const row = q.rows[0];
    if (!row || !row.pdf_key) throw new HttpError(404, 'PDF-досьє немає.');
    const bytes = await opts.files.get(row.pdf_key);
    if (!bytes) throw new HttpError(404, 'Файл не знайдено.');
    sendFile(res, bytes, `YouControl_${row.code}.pdf`, 'application/pdf');
  });
  /** Бюджет YouControl — лише Сергію: залишок, витрати за місяць по видах, резерв на планові, на скільки вистачить. */
  r.get('/budget', async (req: AuthedRequest, res) => {
    const u = await me(req);
    if (u.role !== 'approver') throw new HttpError(403, 'Бюджет YouControl бачить лише Сергій.');
    res.json(await budgetFor(u));
  });

  // ---------- документи ----------
  /** Завантаження одного файлу: тіло — сам файл, ім'я — заголовок X-File-Name (encodeURIComponent). */
  r.post('/files', raw, async (req: AuthedRequest, res) => {
    const u = await me(req);
    if (!canSubmit(u.role)) throw new HttpError(403, 'Документи додають менеджери й тім-ліди.');
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')).replace(/[\\/\r\n\t]/g, '_').trim(); } catch { name = ''; }
    const body = req.body as Buffer;
    if (!name || name.length > FILE_NAME_MAX) throw new HttpError(400, 'Немає назви файлу.');
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Порожній файл.');
    const mime = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 120);
    const key = await opts.files.put(new Uint8Array(body), { name, mime });
    const ins = await pool.query('INSERT INTO cp_files (name, size, mime, storage_key, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, body.length, mime, key, u.id]);
    res.status(201).json({ id: String(ins.rows[0].id), name, size: body.length });
  });
  r.get('/files/:id', async (req: AuthedRequest, res) => {
    const u = await me(req);
    const id = String(req.params.id);
    if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, 'Файл не знайдено.');
    const f = (await pool.query('SELECT * FROM cp_files WHERE id = $1', [id])).rows[0];
    if (!f) throw new HttpError(404, 'Файл не знайдено.');
    const q = f.request_id ? await getRequest(pool, String(f.request_id)) : null;
    if (!(f.uploaded_by === u.id || (q && visibleReq(u, q)))) throw new HttpError(404, 'Файл не знайдено.');
    const bytes = await opts.files.get(f.storage_key);
    if (!bytes) throw new HttpError(404, 'Файл не знайдено.');
    sendFile(res, bytes, f.name, f.mime);
  });

  r.use(errorHandler('counterparty'));
  return r;
}

function sendFile(res: Response, bytes: Uint8Array, name: string, mime: string) {
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(bytes));
}
