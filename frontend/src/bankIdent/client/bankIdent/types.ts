/** Контракт клієнта з /api/bank-ident/* (server/routes/bankIdent.ts). Макет підставляє «сервер» у памʼяті з тими самими правилами. */
import type { CommentSummary, IdentEvent, IdentState, NcReason, OutComment } from '../../shared/bankIdent';

export class BankIdentError extends Error {
  // [дашборд] поля явно: у фронті дашборда `erasableSyntaxOnly` забороняє параметр-властивості конструктора
  readonly status: number;
  readonly state?: IdentState;
  constructor(message: string, status: number, state?: IdentState) { super(message); this.status = status; this.state = state; }
}

export type ListStatus = 'wait' | 'unidentified' | 'identified' | 'not_client';
export interface StateResponse { now: string; holidays: string[]; states: Record<string, IdentState> }
export interface CountsResponse { wait: number; unidentified: number; identified: number; not_client: number; badge: number }
export interface ListResponse { now: string; holidays: string[]; ids: number[]; rows: Record<string, unknown>[]; states: Record<string, IdentState>; total: number }

export interface BankIdentApi {
  states(ids: number[]): Promise<StateResponse>;
  counts(): Promise<CountsResponse>;
  list(status: ListStatus, limit?: number, offset?: number): Promise<ListResponse>;
  history(txId: number): Promise<IdentEvent[]>;
  set(txId: number, no: string): Promise<IdentState>;
  fix(txId: number, no: string, reason: string, expected: string): Promise<IdentState>;
  unidentify(txId: number, reason: string, expected: string): Promise<IdentState>;
  notClient(txId: number, reason: NcReason, note: string): Promise<IdentState>;
  /** 403 → у користувача немає права на коментарі до вихідних (тоді їх не показуємо зовсім). */
  commentSummary(ids: number[]): Promise<Record<string, CommentSummary>>;
  comments(txId: number): Promise<OutComment[]>;
  addComment(txId: number, body: string): Promise<{ comment: OutComment; summary: CommentSummary }>;
}

/** Серверний час (мс): Date.now() + зсув з відповіді /state, щоб строк не залежав від годинника компʼютера. */
export type Clock = () => number;
export const clockFrom = (serverNowIso: string): Clock => {
  const off = Date.parse(serverNowIso) - Date.now();
  return () => Date.now() + off;
};
