/**
 * Хто є хто для «Узгодження», «Перевірки контрагента» і «Лімітів клієнтів» — одне місце для обох роутерів.
 * req.user = { id, name, role } — з вашої сесії (як в інших пакетах). Коди ролей дашборда (звірено 23.10):
 *   admin, kvp, manager, team_lead, hr, accounting, finance, ceo, candidate.
 */
import type { NextFunction, Request, Response } from 'express';
import type { CpRole, CpUser } from '../shared/counterparty.js';

export interface ReqUser { id: string; name?: string; role?: string }
export interface AuthedRequest extends Request { user?: ReqUser }

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) { super(message); }
}

/**
 * approverIds → погоджує (лише акаунт Сергія); accounting → бухгалтерія (бачить усе, без дій);
 * admin, ceo, finance → перегляд усього; team_lead → тім-лід; manager → менеджер;
 * інші співробітники (kvp, hr, логісти…) → лише «Перевірка контрагента»; candidate і без ролі → немає доступу.
 */
export function defaultCpRoleOf(approverIds: string[]) {
  return (u: ReqUser): CpRole | null => {
    if (approverIds.includes(String(u.id))) return 'approver';
    switch (u.role) {
      case 'accounting': case 'accountant': return 'accounting';
      case 'admin': case 'ceo': case 'finance': return 'viewer';
      case 'team_lead': case 'lead': return 'lead';
      case 'manager': return 'manager';
      case 'candidate': case undefined: case null: case '': return null;
      default: return 'staff';
    }
  };
}

export interface MeOptions {
  roleOf: (u: ReqUser) => CpRole | null;
  /** Команда тім-ліда: users.id його менеджерів. Не передано — тім-лід бачить лише свої запити й клієнтів. */
  teamOf?: (u: ReqUser) => string[] | Promise<string[]>;
}
export async function meOf(req: AuthedRequest, o: MeOptions): Promise<CpUser> {
  const u = req.user;
  if (!u || !u.id) throw new HttpError(401, 'Потрібно увійти.');
  const role = o.roleOf(u);
  if (!role) throw new HttpError(403, 'Немає доступу.');
  const me: CpUser = { id: String(u.id), name: u.name || '', role };
  if (role === 'lead' && o.teamOf) me.team = (await o.teamOf(u)).map(String).filter(id => id !== me.id);
  return me;
}

/** Помилки: HttpError, зламаний JSON, завеликий запит, усе інше. */
export function errorHandler(tag: string) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, ...(err.extra || {}) }); return; }
    const e = err as { type?: string };
    if (e && e.type === 'entity.parse.failed') { res.status(400).json({ error: 'Некоректний JSON.' }); return; }
    if (e && e.type === 'entity.too.large') { res.status(413).json({ error: 'Завеликий файл або запит.' }); return; }
    console.error(`[${tag}]`, err);
    res.status(500).json({ error: 'Помилка сервера. Спробуйте ще раз.' });
  };
}
