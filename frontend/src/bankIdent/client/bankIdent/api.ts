/**
 * Клієнт /api/bank-ident/*. API дашборда — з токеном, тож передайте свій fetch, що додає авторизацію:
 *   export const bankIdentApi = createBankIdentApi({ fetch: apiFetch });     // ваш fetch з Bearer-токеном
 * Без параметра — звичайний fetch із cookie (credentials: 'same-origin').
 */
import type { CommentSummary, IdentEvent, IdentState, OutComment } from '../../shared/bankIdent';
import { BankIdentError, type BankIdentApi, type CountsResponse, type ListResponse, type StateResponse } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createBankIdentApi(o: { fetch?: FetchLike; base?: string } = {}): BankIdentApi {
  const base = o.base || '/api/bank-ident';
  const doFetch: FetchLike = o.fetch || ((u, i) => fetch(u, { credentials: 'same-origin', ...i }));
  async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await doFetch(base + path, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new BankIdentError('Немає звʼязку з сервером. Спробуйте ще раз.', 0);
    }
    let j: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { j = await r.json(); } catch { /* порожня відповідь */ }
    if (!r.ok) throw new BankIdentError((j && j.error) || `Помилка ${r.status}. Спробуйте ще раз.`, r.status, j && j.state);
    return j as T;
  }
  const id = (n: number) => encodeURIComponent(String(n));
  return {
    states: ids => call<StateResponse>('POST', '/state', { ids }),
    counts: () => call<CountsResponse>('GET', '/counts'),
    list: (status, limit = 50, offset = 0) => call<ListResponse>('GET', `/list?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`),
    history: txId => call<{ events: IdentEvent[] }>('GET', `/${id(txId)}/history`).then(j => j.events),
    set: (txId, no) => call<{ state: IdentState }>('POST', `/${id(txId)}/invoice`, { no }).then(j => j.state),
    fix: (txId, no, reason, expected) => call<{ state: IdentState }>('PATCH', `/${id(txId)}/invoice`, { no, reason, expected }).then(j => j.state),
    unidentify: (txId, reason, expected) => call<{ state: IdentState }>('POST', `/${id(txId)}/unidentify`, { reason, expected }).then(j => j.state),
    reset: (txId, reason, expected) => call<{ state: IdentState }>('POST', `/${id(txId)}/reset`, { reason, expected }).then(j => j.state), // [дашборд 28.10]
    notClient: (txId, reason, note) => call<{ state: IdentState }>('POST', `/${id(txId)}/not-client`, { reason, note }).then(j => j.state),
    commentSummary: ids => call<{ summaries: Record<string, CommentSummary> }>('POST', '/comments/summary', { ids }).then(j => j.summaries),
    comments: txId => call<{ comments: OutComment[] }>('GET', `/${id(txId)}/comments`).then(j => j.comments),
    addComment: (txId, body) => call<{ comment: OutComment; summary: CommentSummary }>('POST', `/${id(txId)}/comments`, { body }),
  };
}
