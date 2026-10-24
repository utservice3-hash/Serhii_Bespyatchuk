/**
 * Express Router реєстру мінусових угод: /api/minus-deals/*. Код пакета Сергія (v1.1, 23.10) БЕЗ змін логіки; монтує його
 * `routes/minusRegistry.ts` (наш вхід, вкладка `registries`, роль, імʼя й команда в `req.user`). Нижче — підключення з пакета, для довідки:
 *   const kommo = kommoFromEnv();                                   // server/kommoClient.ts — токен лише з env сервера
 *   app.use('/api/minus-deals', requireAuth, minusRegistryRouter(pool, {
 *     deals: kommo,
 *     approverIds: (process.env.MINUS_APPROVER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
 *   }));
 *   startMinusRegistrySync(pool, kommo);                            // server/minusRegistrySync.ts
 * req.user = { id, name, role } — з вашої сесії (як у пакетах «Опитування» й «Конфігуратор»).
 *
 * Права (рішення Сергія 20.10) — перевіряє сервер, інтерфейс лише ховає кнопки:
 *   менеджер і тім-лід — подають, бачать свої; повернуте — виправляють і надсилають повторно;
 *   тім-лід ще й бачить запити своєї команди (лише перегляд), якщо передано teamOf — як обсяг «Команда» ролі «Тімлід» у дашборді;
 *   погоджує ЛИШЕ акаунт Сергія (approverIds) — ролі «адмін» для цього мало;
 *   бухгалтерія — бачить усе, ставить «Оплачено» погодженим;
 *   інші адміни — бачать усе, без дій.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import {
  STATUS_LABEL, allowedActions, canSee, canSubmit, checkComment, checkDealId, checkNote, isAction, seesAll,
  EVENT_OF, FROM, TO, type Action, type CrmDeal, type RegUser, type Role,
} from './shared/minusRegistry.js';
import { KommoError, type DealSource } from './kommoSource.js';
import { addEvent, countForMe, getRequest, listRequests, tx } from './store.js';
import { syncStale } from './sync.js';

export interface ReqUser { id: string; name?: string; role?: string }
interface AuthedRequest extends Request { user?: ReqUser }

export interface MinusRegistryOptions {
  /** Звідки брати угоди: kommoClient(...) або ваш об'єкт з fetchDeal(dealId) → CrmDeal | null. */
  deals: DealSource;
  /** users.id тих, хто погоджує. За рішенням 20.10 — лише акаунт Сергія (операційний директор). */
  approverIds?: string[];
  /** Одне місце, де ролі дашборда стають ролями реєстру. За замовчуванням — defaultRoleOf(approverIds). */
  roleOf?: (u: ReqUser) => Role | null;
  /** Команда тім-ліда: users.id його менеджерів (без нього самого). Не передано — тім-лід бачить лише свої запити. */
  teamOf?: (u: ReqUser) => string[] | Promise<string[]>;
  /** При відкритті реєстру Сергієм / бухгалтерією звірити з Kommo «їхні» запити, старші за це. За замовчуванням 2 хв. */
  freshnessMs?: number;
}

/**
 * Коди ролей дашборда (звірено з дашбордом 23.10): admin, kvp, manager, team_lead, hr, accounting, finance, ceo, candidate.
 * approverIds → погоджує; accounting → бухгалтерія; admin, ceo → лише перегляд; manager → менеджер; team_lead → тім-лід.
 * До 23.10 тут було лише 'lead' — тім-ліди дашборда (team_lead) отримували 403 «Немає доступу до реєстру».
 */
export function defaultRoleOf(approverIds: string[]) {
  return (u: ReqUser): Role | null => {
    if (approverIds.includes(String(u.id))) return 'approver';
    switch (u.role) {
      case 'accounting': case 'accountant': return 'accounting';
      case 'admin': case 'ceo': return 'viewer';
      case 'team_lead': case 'lead': return 'lead';
      case 'manager': return 'manager';
      default: return null;
    }
  };
}

class HttpError extends Error { constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) { super(message); } }

export function minusRegistryRouter(pool: Pool, opts: MinusRegistryOptions): Router {
  const roleOf = opts.roleOf || defaultRoleOf(opts.approverIds || []);
  const freshness = opts.freshnessMs ?? 2 * 60_000;
  const r = Router();
  r.use(express.json({ limit: '64kb' }));

  const meOf = async (req: AuthedRequest): Promise<RegUser> => {
    const u = req.user;
    if (!u || !u.id) throw new HttpError(401, 'Потрібно увійти.');
    const role = roleOf(u);
    if (!role) throw new HttpError(403, 'Немає доступу до реєстру.');
    const me: RegUser = { id: String(u.id), name: u.name || '', role };
    if (role === 'lead' && opts.teamOf) me.team = (await opts.teamOf(u)).map(String).filter(id => id !== me.id);
    return me;
  };
  /** Угода з CRM; помилки Kommo → 502/503/504 з текстом для людини. */
  const crm = async (dealId: string): Promise<CrmDeal | null> => {
    try { return await opts.deals.fetchDeal(dealId); }
    catch (e) { if (e instanceof KommoError) throw new HttpError(e.status, e.message); throw e; }
  };
  const dupMessage = (dealId: string, status: keyof typeof STATUS_LABEL) => `Угода ${dealId} уже в реєстрі — ${STATUS_LABEL[status].toLowerCase()}.`;

  // ---------- список і лічильник ----------
  r.get('/', async (req: AuthedRequest, res) => {
    const me = await meOf(req);
    // Сергій бачить свіжі «На погодженні», бухгалтерія — свіжі «Погоджено» (щоб не оплатити те, де мінус уже зріс).
    if (me.role === 'approver' || me.role === 'accounting') {
      await syncStale(pool, opts.deals, { statuses: [me.role === 'approver' ? 'pending' : 'approved'], maxAgeMs: freshness, budgetMs: 3000, concurrency: 3 })
        .catch(e => console.error('[minus-deals] звірка:', e instanceof Error ? e.message : e));
    }
    const requests = await listRequests(pool, seesAll(me.role) ? undefined : [me.id, ...(me.team || [])]);
    res.json({ me, requests });
  });

  r.get('/counter', async (req: AuthedRequest, res) => {
    const me = await meOf(req);
    res.json({ count: await countForMe(pool, me) });
  });

  // ---------- нова угода: перегляд з CRM ----------
  r.get('/deal/:dealId', async (req: AuthedRequest, res) => {
    const me = await meOf(req);
    if (!canSubmit(me.role)) throw new HttpError(403, 'Подавати угоди можуть менеджери й тім-ліди.');
    const dealId = String(req.params.dealId).trim();
    const bad = checkDealId(dealId); if (bad) throw new HttpError(400, bad);
    const dup = (await pool.query('SELECT id, status FROM minus_deal_requests WHERE deal_id = $1', [dealId])).rows[0];
    if (dup) throw new HttpError(409, dupMessage(dealId, dup.status), { requestId: String(dup.id), status: dup.status });
    const deal = await crm(dealId);
    if (!deal) throw new HttpError(404, `У CRM немає угоди ${dealId}.`);
    res.json(deal);
  });

  // ---------- подати ----------
  r.post('/', async (req: AuthedRequest, res) => {
    const me = await meOf(req);
    if (!canSubmit(me.role)) throw new HttpError(403, 'Подавати угоди можуть менеджери й тім-ліди.');
    const b = req.body || {};
    const dealId = typeof b.dealId === 'string' ? b.dealId.trim() : typeof b.dealId === 'number' ? String(b.dealId) : '';
    const bad = checkDealId(dealId) || checkComment(b.comment); if (bad) throw new HttpError(400, bad);
    const deal = await crm(dealId);                                 // знімок — з CRM, не з браузера
    if (!deal) throw new HttpError(404, `У CRM немає угоди ${dealId}.`);
    const id = await tx(pool, async c => {
      const ins = await c.query(`INSERT INTO minus_deal_requests (deal_id, comment, crm, created_by, created_by_name)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deal_id) DO NOTHING RETURNING id`,
        [dealId, String(b.comment).trim(), JSON.stringify(deal), me.id, me.name]);
      if (!ins.rows[0]) return null;
      await addEvent(c, ins.rows[0].id, 'submitted', me);
      return String(ins.rows[0].id);
    });
    if (!id) {
      const dup = (await pool.query('SELECT id, status FROM minus_deal_requests WHERE deal_id = $1', [dealId])).rows[0];
      throw new HttpError(409, dupMessage(dealId, dup ? dup.status : 'pending'), dup ? { requestId: String(dup.id), status: dup.status } : undefined);
    }
    res.status(201).json(await getRequest(pool, id));
  });

  // ---------- дії: approve / return / reject / paid / resubmit ----------
  r.post('/:id/:action', async (req: AuthedRequest, res) => {
    const me = await meOf(req);
    const id = String(req.params.id), action = String(req.params.action);
    if (!/^\d{1,18}$/.test(id) || !isAction(action)) throw new HttpError(404, 'Запит не знайдено.');
    const a: Action = action;
    const b = req.body || {};
    const before = await getRequest(pool, id);
    if (!before || !canSee(me, before)) throw new HttpError(404, 'Запит не знайдено.');
    const could = allowedActions(me, { status: FROM[a], createdBy: before.createdBy }).includes(a);
    if (!could) throw new HttpError(403, 'Немає прав на цю дію.');
    if (before.status !== FROM[a]) throw new HttpError(409, `Запит уже «${STATUS_LABEL[before.status]}» — оновіть сторінку.`, { request: before });
    const noteErr = checkNote(a, b.note); if (noteErr) throw new HttpError(400, noteErr);
    if (a === 'resubmit' && b.comment !== undefined) { const e = checkComment(b.comment); if (e) throw new HttpError(400, e); }

    // Перед погодженням і повторним поданням — свіжі цифри з CRM. Kommo недоступна → працюємо зі знімком (фонова звірка наздожене).
    let fresh: CrmDeal | null = null;
    if (a === 'approve' || a === 'resubmit') {
      try { fresh = await opts.deals.fetchDeal(before.dealId); } catch { fresh = null; }
    }

    const out = await tx(pool, async c => {
      const cur = (await c.query('SELECT status, comment, crm FROM minus_deal_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur || cur.status !== FROM[a]) return { conflict: true as const };
      const deal: CrmDeal = fresh || cur.crm;
      if (a === 'approve') {
        const seen = typeof b.seenBudget === 'number' ? b.seenBudget : null;
        if (fresh && seen !== null && fresh.budget < seen) {
          // мінус збільшився, поки Сергій дивився: показати нові цифри, погодити ще раз
          await c.query('UPDATE minus_deal_requests SET crm = $2, synced_at = now() WHERE id = $1', [id, JSON.stringify(fresh)]);
          return { stale: true as const };
        }
        await c.query(`UPDATE minus_deal_requests SET status = 'approved', crm = $2, approved_crm = $2, grew = NULL, updated_at = now(), synced_at = now() WHERE id = $1`, [id, JSON.stringify(deal)]);
        await addEvent(c, id, 'approved', me, '', { budget: deal.budget });
      } else if (a === 'return' || a === 'reject') {
        await c.query('UPDATE minus_deal_requests SET status = $2, grew = NULL, updated_at = now() WHERE id = $1', [id, TO[a]]);
        await addEvent(c, id, EVENT_OF[a], me, String(b.note).trim());
      } else if (a === 'paid') {
        await c.query("UPDATE minus_deal_requests SET status = 'paid', updated_at = now() WHERE id = $1", [id]);
        await addEvent(c, id, 'paid', me);
      } else {
        const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : cur.comment;
        await c.query(`UPDATE minus_deal_requests SET status = 'pending', comment = $2, crm = $3, updated_at = now(), synced_at = now() WHERE id = $1`, [id, comment, JSON.stringify(deal)]);
        await addEvent(c, id, 'resubmitted', me, '', comment !== cur.comment ? { comment_before: cur.comment } : undefined);
      }
      return { ok: true as const };
    });
    const now = await getRequest(pool, id);
    if ('conflict' in out) throw new HttpError(409, `Запит уже «${STATUS_LABEL[now!.status]}» — оновіть сторінку.`, { request: now });
    if ('stale' in out) throw new HttpError(409, 'Мінус у CRM збільшився, поки ви дивились, — перегляньте цифри й погодьте ще раз.', { request: now });
    res.json(now);
  });

  // помилки: HttpError, зламаний JSON, завеликий запит, усе інше
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, ...(err.extra || {}) }); return; }
    const e = err as { type?: string };
    if (e && e.type === 'entity.parse.failed') { res.status(400).json({ error: 'Некоректний JSON.' }); return; }
    if (e && e.type === 'entity.too.large') { res.status(413).json({ error: 'Завеликий запит.' }); return; }
    console.error('[minus-deals]', err);
    res.status(500).json({ error: 'Помилка сервера. Спробуйте ще раз.' });
  });
  return r;
}
