/**
 * Хто є хто для «Виписки»: req.user = { id, name, role } — з вашої сесії (як в інших пакетах).
 * Коди ролей дашборда (звірено 23.10 і 27.10): admin, opdir, kvp, manager, team_lead, hr, accounting, finance, ceo, candidate.
 * Права — ключі для «Налаштування → Ролі та доступи» (shared/bankIdent.ts, RIGHTS). Своя перевірка прав — передайте `can`.
 */
import type { NextFunction, Request, Response } from 'express';
import { defaultCan, type Person, type Right } from './bankIdent.js';

export interface ReqUser { id: string | number; name?: string; role?: string }
export interface AuthedRequest extends Request { user?: ReqUser }

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) { super(message); }
}

/** Перевірка права. За замовчуванням — за кодом ролі (shared/bankIdent.ts → RIGHTS); адмін має все. */
export type CanFn = (u: ReqUser, right: Right) => boolean | Promise<boolean>;
export const defaultCanFn: CanFn = (u, r) => defaultCan(u.role, r);

const NO_ACCESS = new Set(['candidate', '']);
/** Поточний користувач; кандидат і без ролі — 403 (як в інших пакетах). */
export function personOf(req: AuthedRequest): Person {
  const u = req.user;
  if (!u || u.id === undefined || u.id === null || u.id === '') throw new HttpError(401, 'Потрібно увійти.');
  const role = String(u.role || '');
  if (NO_ACCESS.has(role)) throw new HttpError(403, 'Немає доступу.');
  return { id: String(u.id), name: u.name || '', role };
}

/** Помилки: HttpError, зламаний JSON, завеликий запит, усе інше. */
export function errorHandler(tag: string) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, ...(err.extra || {}) }); return; }
    const e = err as { type?: string };
    if (e && e.type === 'entity.parse.failed') { res.status(400).json({ error: 'Некоректний JSON.' }); return; }
    if (e && e.type === 'entity.too.large') { res.status(413).json({ error: 'Завеликий запит.' }); return; }
    console.error(`[${tag}]`, err);
    res.status(500).json({ error: 'Помилка сервера. Спробуйте ще раз.' });
  };
}
