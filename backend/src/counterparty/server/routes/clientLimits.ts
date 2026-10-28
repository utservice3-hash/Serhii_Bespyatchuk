/**
 * Express Router «Ліміти клієнтів» (розділ «Дебіторська заборгованість»): /api/client-limits/*.
 * Підключення:
 *   app.use('/api/client-limits', requireAuth, clientLimitsRouter(pool, {
 *     debts: cachedDebtSource(yourDebtSource),                       // server/debtSource.ts — борг і прострочка з ВАШОЇ дебіторки
 *     approverIds: (process.env.CP_APPROVER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
 *     teamOf: u => teamMemberIds(u.id),
 *   }));
 *   startCourtMonitor({ pool, youscore: ys });                       // server/courtMonitor.ts — раз на місяць
 *
 * Права: Сергій — змінює ліміт (з причиною), задає ліміт боржнику без ліміту або клієнту з бази (/search, /add), «лишає» ліміт після нової справи в суді;
 * менеджер бачить своїх клієнтів, тім-лід — ще й команди (лише перегляд), бухгалтерія й керівники — усіх (без дій).
 * Нові умови менеджер подає через «Узгодження» (/api/counterparty) — тут лише читання.
 */
import express, { Router } from 'express';
import type { Pool } from 'pg';
import { buildRows, canSeeLimit, cellsFor, clientQuery, isNoLimit, limitOfClient, limitsBadge, parseLimitInput, type AnyRow, type LimitRow } from '../../shared/clientLimits.js';
import { FROM_LABEL, diffLines, seesRequests, sideLine, type CpRole, type CpUser, type Terms } from '../../shared/counterparty.js';
import { DEFAULT_LAG, type Lag } from '../../shared/cpCalc.js';
import { dayW, money } from '../../shared/cpFormat.js';
import { monitorInfo } from '../courtMonitor.js';
import { HttpError, defaultCpRoleOf, errorHandler, meOf, type AuthedRequest, type ReqUser } from '../cpRoles.js';
import { addEvent, tx } from '../cpStore.js';
import type { ClientDirectory } from '../clientDirectory.js';
import type { DebtSource } from '../debtSource.js';
import { addLimitEvent, getLimit, importLimit, insertSetLimit, listLimits, type ImportRow } from '../limitsStore.js';

export interface ClientLimitsOptions {
  /** Борг і прострочка з дебіторки. */
  debts: DebtSource;
  /** Клієнти бази для «＋ Додати клієнта» (задача 7137); немає — пошук і додавання відповідають 503. */
  clients?: ClientDirectory;
  approverIds?: string[];
  roleOf?: (u: ReqUser) => CpRole | null;
  teamOf?: (u: ReqUser) => string[] | Promise<string[]>;
  lag?: Lag;
  /** Розклад щомісячної перевірки — лише для підпису «наступна перевірка …» (сам запуск — startCourtMonitor). */
  monitorDay?: number;
  monitorHour?: number;
  now?: () => Date;
}

export function clientLimitsRouter(pool: Pool, opts: ClientLimitsOptions): Router {
  const roleOf = opts.roleOf || defaultCpRoleOf(opts.approverIds || []);
  const me = (req: AuthedRequest) => meOf(req, { roleOf, teamOf: opts.teamOf });
  const now = opts.now || (() => new Date());
  const r = Router();
  r.use(express.json({ limit: '2mb' }));

  async function rows(): Promise<{ rows: AnyRow[]; at: string | null; cells: ReturnType<typeof buildRows>['cells'] }> {
    const [limits, d] = await Promise.all([listLimits(pool, now()), opts.debts.debtors().catch(e => { console.error('[client-limits] дебіторка:', e instanceof Error ? e.message : e); return null; })]);
    const b = buildRows(limits, d ? d.list : []);
    return { rows: b.rows, at: d ? d.at : null, cells: b.cells };
  }
  const visible = (u: CpUser, list: AnyRow[]) => list.filter(x => canSeeLimit(u, x));
  const need = (u: CpUser) => { if (!seesRequests(u.role)) throw new HttpError(403, 'Немає доступу до лімітів клієнтів.'); };
  const approver = (u: CpUser) => { if (u.role !== 'approver') throw new HttpError(403, 'Змінювати ліміти може лише Сергій.'); };
  async function rowOf(id: string): Promise<LimitRow> {
    const all = await rows();
    const x = all.rows.find(y => !isNoLimit(y) && y.id === id);
    if (!x || isNoLimit(x)) throw new HttpError(404, 'Ліміт не знайдено.');
    return x;
  }

  r.get('/', async (req: AuthedRequest, res) => {
    const u = await me(req); need(u);
    const all = await rows();
    res.json({ me: u, rows: visible(u, all.rows), debtAt: all.at, monitor: await monitorInfo(pool, now(), opts.monitorDay, opts.monitorHour), lag: opts.lag || DEFAULT_LAG });
  });
  r.get('/counter', async (req: AuthedRequest, res) => {
    const u = await me(req);
    if (!seesRequests(u.role)) { res.json({ count: 0 }); return; }
    res.json({ count: limitsBadge(u, (await rows()).rows) });
  });
  /**
   * Для колонки «Ліміти» активної дебіторки: ключ боржника → ліміт і стан («у межах» / «переліміт» / «не узгоджено»).
   * canEdit — олівці (лише Сергій); cells[*].canRequest — «Запросити зміну» (свій клієнт менеджера / тім-ліда).
   */
  r.get('/by-debtor', async (req: AuthedRequest, res) => {
    const u = await me(req); need(u);
    const all = await rows();
    res.json({ at: all.at, cells: cellsFor(u, all.cells), canEdit: u.role === 'approver' });
  });

  // ---------- Сергій: змінити ліміт ----------
  r.post('/:id/edit', async (req: AuthedRequest, res) => {
    const u = await me(req); approver(u);
    const p = parseLimitInput(req.body); if ('error' in p) throw new HttpError(400, p.error);
    const id = String(req.params.id);
    const l = await getLimit(pool, id, now()); if (!l) throw new HttpError(404, 'Ліміт не знайдено.');
    await tx(pool, async db => {
      if (l.src === 'req' && l.requestId) {
        const q = (await db.query('SELECT ok FROM cp_requests WHERE id = $1 FOR UPDATE', [l.requestId])).rows[0];
        const before: Terms | null = q?.ok ?? null;
        if (!before) throw new HttpError(409, 'Запит уже не погоджено — оновіть сторінку.');
        const after: Terms = { ...before, limit: p.limit, cl: { ...before.cl, days: p.days, from: p.from } };
        const lines = diffLines(before, after);
        if (!lines.length) throw new HttpError(400, 'Нічого не змінилось.');
        await db.query('UPDATE cp_requests SET ok = $2, updated_at = now() WHERE id = $1', [l.requestId, JSON.stringify(after)]);
        await addEvent(db, l.requestId, 'limitChanged', u, [...lines, 'Причина: ' + p.reason].join('\n'), { before, after });
      } else {
        const was = `${l.limit ? money(l.limit) : 'суму не погоджено'}, ${l.days !== null ? sideLine({ days: l.days, from: l.from }) : 'дні не погоджено'}`;
        const nowS = `${money(p.limit)}, ${sideLine({ days: p.days, from: p.from })}`;
        if (was === nowS) throw new HttpError(400, 'Нічого не змінилось.');
        await addLimitEvent(db, id, 'limitChanged', u, `${was} → ${nowS}${l.flag ? '\nПісля перевірки судів' : ''}\nПричина: ${p.reason}`);
      }
      await db.query('UPDATE client_limits SET limit_sum = $2, days = $3, count_from = $4, flag = NULL, updated_at = now() WHERE id = $1', [id, p.limit, p.days, p.from]);
    });
    res.json(await rowOf(id));
  });
  /** Нова справа в суді по перенесеному / заданому ліміту — Сергій вирішив лишити. */
  r.post('/:id/keep', async (req: AuthedRequest, res) => {
    const u = await me(req); approver(u);
    const id = String(req.params.id);
    const l = await getLimit(pool, id, now()); if (!l) throw new HttpError(404, 'Ліміт не знайдено.');
    if (l.src === 'req') throw new HttpError(409, 'Погодження призупинено — рішення в самому запиті.');
    if (!l.flag) throw new HttpError(409, 'Ліміт не призупинено — оновіть сторінку.');
    const extra = typeof (req.body || {}).note === 'string' ? String(req.body.note).trim().slice(0, 2000) : '';
    await tx(pool, async db => {
      await db.query('UPDATE client_limits SET flag = NULL, updated_at = now() WHERE id = $1', [id]);
      await addLimitEvent(db, id, 'kept', u, 'Справу переглянуто — ліміт лишається.' + (extra ? '\n' + extra : ''));
    });
    res.json(await rowOf(id));
  });
  /** Боржник без ліміту — Сергій задає ліміт напряму (одразу йде в колонку «Ліміти» дебіторки). */
  r.post('/set', async (req: AuthedRequest, res) => {
    const u = await me(req); approver(u);
    const p = parseLimitInput(req.body); if ('error' in p) throw new HttpError(400, p.error);
    const key = typeof (req.body || {}).debtorKey === 'string' ? req.body.debtorKey : '';
    const all = await rows();
    const d = all.rows.find(x => isNoLimit(x) && x.debtorKey === key);
    if (!d || !isNoLimit(d)) throw new HttpError(409, 'Цей боржник уже має ліміт або зник із дебіторки — оновіть сторінку.');
    const id = await tx(pool, async db => {
      const old = (await db.query('SELECT id, active FROM client_limits WHERE debtor_key = $1 FOR UPDATE', [key])).rows[0];
      let lid: string;
      if (old && old.active) throw new HttpError(409, 'Цей боржник уже має ліміт — оновіть сторінку.');
      if (old) {
        await db.query(`UPDATE client_limits SET src = 'set', request_id = NULL, active = true, flag = NULL, limit_sum = $2, days = $3, count_from = $4,
          manager_id = $5, manager_name = $6, name = $7, at = now(), updated_at = now() WHERE id = $1`, [old.id, p.limit, p.days, p.from, d.managerId, d.managerName, d.name]);
        lid = String(old.id);
      } else {
        lid = await insertSetLimit(db, { debtorKey: key, name: d.name, kind: d.kind, members: d.members, limit: p.limit, days: p.days, from: p.from, managerId: d.managerId, managerName: d.managerName });
      }
      await addLimitEvent(db, lid, 'limitSet', u, `${money(p.limit)}, ${dayW(p.days)} ${FROM_LABEL[p.from]}\nПричина: ${p.reason}`);
      return lid;
    });
    res.status(201).json(await rowOf(id));
  });

  // ---------- Сергій: клієнт із бази, якого немає в дебіторці (задача 7137) ----------
  const directory = () => { if (!opts.clients) throw new HttpError(503, 'Пошук по базі клієнтів недоступний.'); return opts.clients; };
  /** Пошук по всій базі за назвою або ЄДРПОУ / ІПН; limitId — уже діючий ліміт цього клієнта (за ключем або кодом). */
  r.get('/search', async (req: AuthedRequest, res) => {
    const u = await me(req); approver(u);
    const q = clientQuery(String(req.query.q ?? ''));
    if (!q) { res.json({ hits: [] }); return; }
    const [hits, limits] = await Promise.all([directory().search(q), listLimits(pool, now())]);
    res.json({ hits: hits.map(h => ({ key: h.key, name: h.name, codes: h.codes, managerId: h.managerId, managerName: h.managerName,
      deals: h.deals, lastDealAt: h.lastDealAt, debtor: h.debtor, limitId: limitOfClient(limits, h) })) });
  });
  /** Ліміт клієнту з бази: ключ — його client_key, юрособи — його коди; коли стане боржником, дебіторка підхопить ліміт сама. */
  r.post('/add', async (req: AuthedRequest, res) => {
    const u = await me(req); approver(u);
    const p = parseLimitInput(req.body); if ('error' in p) throw new HttpError(400, p.error);
    const key = typeof (req.body || {}).clientKey === 'string' ? req.body.clientKey : '';
    const h = key ? await directory().get(key) : null;
    if (!h) throw new HttpError(404, 'Клієнта немає в базі — оновіть пошук.');
    if (limitOfClient(await listLimits(pool, now()), h)) throw new HttpError(409, 'У цього клієнта вже є ліміт — відкрийте його в списку.');
    const managerId = h.managerId || '0', managerName = h.managerName || 'без відповідального';
    const id = await tx(pool, async db => {
      const old = (await db.query('SELECT id, active FROM client_limits WHERE debtor_key = $1 FOR UPDATE', [key])).rows[0];
      let lid: string;
      if (old && old.active) throw new HttpError(409, 'У цього клієнта вже є ліміт — оновіть сторінку.');
      if (old) {
        await db.query(`UPDATE client_limits SET src = 'set', request_id = NULL, active = true, flag = NULL, limit_sum = $2, days = $3, count_from = $4,
          manager_id = $5, manager_name = $6, name = $7, at = now(), updated_at = now() WHERE id = $1`, [old.id, p.limit, p.days, p.from, managerId, managerName, h.name]);
        lid = String(old.id);
      } else {
        lid = await insertSetLimit(db, { debtorKey: key, name: h.name, kind: '', members: h.codes.map(code => ({ code, name: h.name })),
          limit: p.limit, days: p.days, from: p.from, managerId, managerName });
      }
      await addLimitEvent(db, lid, 'limitSet', u, `${money(p.limit)}, ${dayW(p.days)} ${FROM_LABEL[p.from]}\nДодано з бази клієнтів${h.debtor ? '' : ' — боргу зараз немає'}\nПричина: ${p.reason}`);
      return lid;
    });
    res.status(201).json(await rowOf(id));
  });

  /** Одноразовий перенос наявних лімітів з дебіторки (idempotent за debtorKey). Те саме — tools/importLimits.ts. */
  r.post('/import', async (req: AuthedRequest, res) => {
    const u = await me(req); approver(u);
    const list: ImportRow[] = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
    let inserted = 0, skipped = 0;
    for (const x of list) {
      if (!x || typeof x.debtorKey !== 'string' || !x.debtorKey || typeof x.name !== 'string' || !x.managerId || (x.limit == null && x.days == null)) { skipped++; continue; }
      (await importLimit(pool, { ...x, members: Array.isArray(x.members) ? x.members : [] })) === 'inserted' ? inserted++ : skipped++;
    }
    res.json({ inserted, skipped });
  });

  r.use(errorHandler('client-limits'));
  return r;
}
