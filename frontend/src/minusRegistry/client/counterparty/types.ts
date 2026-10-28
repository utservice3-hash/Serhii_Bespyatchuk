/**
 * Що вкладки «Узгодження», «Перевірка контрагента» і «Ліміти клієнтів» чекають від «сервера».
 * У дашборді — api.ts (fetch до /api/counterparty і /api/client-limits); у макеті — mockup/src/demoCp.ts (у пам'яті).
 */
import type { AnyRow, ClientHit, DebtorLimitCell, LimitRow } from '../../shared/clientLimits';
import type { CpAction, CpFile, CpRequestView, CpUser, From, Rates, ReqStatus, Terms, TermsInput } from '../../shared/counterparty';
import type { Lag } from '../../shared/cpCalc';
import type { BudgetInfo, CheckView } from '../../shared/cpCheck';

/** Код уже має активний запит. */
export interface DupInfo { id: string; status: ReqStatus; name: string; byName: string; at: string; ok: Terms | null; terms: Terms; visible: boolean }
/** Діючий ліміт без запиту (перенесений з дебіторки чи заданий Сергієм) — підказка «Діючий клієнт». */
export interface LimitInfo { limit: number | null; days: number | null; from: From; src: 'debt' | 'set' }
export type LookupResult = { dup: DupInfo } | { check: CheckView; saved: boolean; limit: LimitInfo | null };
export interface SubmitBody {
  resident: boolean;
  code?: string; checkId?: string;                 // резидент
  country?: string; regNo?: string; name?: string; // нерезидент
  terms: TermsInput; files: string[]; comment: string;
}
export interface ActBody { note?: string; reason?: string; terms?: TermsInput; comment?: string }
/** budget — лише Сергію (залишок YouControl, витрати, резерв); іншим null. */
export interface RequestsData { me: CpUser; requests: CpRequestView[]; rates: Rates; lag: Lag; budget?: BudgetInfo | null }
export interface ChecksData { me: CpUser; checks: CheckView[]; budget?: BudgetInfo | null }

export interface CpApi {
  listRequests(): Promise<RequestsData>;
  counter(): Promise<number>;
  /** Форма «Новий клієнт»: дубль / збережена перевірка / нова перевірка. */
  lookup(code: string): Promise<LookupResult>;
  submit(body: SubmitBody): Promise<CpRequestView>;
  act(id: string, action: CpAction, body?: ActBody): Promise<CpRequestView>;
  listChecks(): Promise<ChecksData>;
  /** Перевірити: збережена (якщо їй < 2 міс.) або нова. force — «Перевірити заново зараз» (Сергій). */
  startCheck(code: string, force?: boolean): Promise<{ check: CheckView; saved: boolean }>;
  getCheck(id: string): Promise<CheckView>;
  /** PDF-досьє (1 транзакція). */
  pdf(id: string): Promise<CheckView>;
  /** Посилання на файл для завантаження; null — у макеті (файлів немає). */
  pdfUrl(id: string): string | null;
  upload(file: File): Promise<CpFile>;
  fileUrl(id: string): string | null;
}

export interface LimitsData { me: CpUser; rows: AnyRow[]; debtAt: string | null; monitor: { last: string | null; next: string }; lag: Lag }
export interface LimitBody { limit: number | string; days: number | string; from: From; reason: string }
/** Колонка «Ліміти» активної дебіторки: at — дата дебіторки; canEdit — олівці (Сергій). */
export interface DebtorLimitsData { at: string | null; cells: Record<string, DebtorLimitCell>; canEdit: boolean }
export interface LimitsApi {
  list(): Promise<LimitsData>;
  counter(): Promise<number>;
  byDebtor(): Promise<DebtorLimitsData>;
  edit(id: string, b: LimitBody): Promise<LimitRow>;
  keep(id: string, note?: string): Promise<LimitRow>;
  set(debtorKey: string, b: LimitBody): Promise<LimitRow>;
  /** «＋ Додати клієнта» (Сергій): пошук по базі; limitId — у клієнта вже є ліміт. */
  search(q: string): Promise<{ hits: ClientHitView[] }>;
  add(clientKey: string, b: LimitBody): Promise<LimitRow>;
}
export interface ClientHitView extends ClientHit { limitId: string | null }

/** Помилка API: message — для людини; request — свіжий стан запиту, якщо сервер його повернув (409). */
export class CpApiError extends Error {
  status: number;
  request?: CpRequestView;
  constructor(message: string, status: number, request?: CpRequestView) { super(message); this.name = 'CpApiError'; this.status = status; this.request = request; }
}

/**
 * Переходи між вкладками (вони на різних сторінках дашборда: «Реєстри та узгодження» і «Дебіторська заборгованість»).
 * У дашборді navigate веде на адресу (navToQuery); у макеті — перемикає вкладку.
 */
export type NavTarget =
  | { tab: 'new'; requestId?: string; reqChange?: boolean; newCode?: string; prefill?: Partial<Pick<Terms, 'ent' | 'limit'>> & { cl?: Partial<Terms['cl']> } }
  | { tab: 'check'; code?: string; checkId?: string }
  | { tab: 'limits'; limitId?: string }
  | { tab: 'minus' };
export type Navigate = (t: NavTarget) => void;

/** NavTarget → адреса: /registries?tab=new&request=12 · /registries?tab=check&code=41234567 · /receivables?tab=limits. */
export function navToUrl(t: NavTarget, paths = { registries: '/registries', receivables: '/receivables' }): string {
  const q = new URLSearchParams();
  q.set('tab', t.tab);
  if (t.tab === 'new') {
    if (t.requestId) q.set('request', t.requestId);
    if (t.reqChange) q.set('change', '1');
    if (t.newCode) q.set('code', t.newCode);
    if (t.prefill) q.set('prefill', JSON.stringify(t.prefill));
  }
  if (t.tab === 'check' && t.code) q.set('code', t.code);
  if (t.tab === 'check' && t.checkId) q.set('check', t.checkId);
  if (t.tab === 'limits' && t.limitId) q.set('limit', t.limitId);
  return `${t.tab === 'limits' ? paths.receivables : paths.registries}?${q.toString()}`;
}
/** Адреса → NavTarget (сторінка відкривається з потрібною вкладкою / запитом). */
export function navFromSearch(search: string): NavTarget | null {
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  if (tab === 'new') {
    let prefill: unknown;
    try { prefill = q.get('prefill') ? JSON.parse(q.get('prefill')!) : undefined; } catch { prefill = undefined; }
    return { tab, requestId: q.get('request') || undefined, reqChange: q.get('change') === '1', newCode: q.get('code') || undefined,
      prefill: prefill && typeof prefill === 'object' ? prefill as Extract<NavTarget, { tab: 'new' }>['prefill'] : undefined };
  }
  if (tab === 'check') return { tab, code: q.get('code') || undefined, checkId: q.get('check') || undefined };
  if (tab === 'limits') return { tab, limitId: q.get('limit') || undefined };
  if (tab === 'minus') return { tab };
  return null;
}
