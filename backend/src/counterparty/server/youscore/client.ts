/**
 * YouScore API (YouControl) — https://api.youscore.com.ua. Ключ — ЛИШЕ в env сервера: YOUSCORE_API_KEY (у браузер не потрапляє).
 * Авторизація: заголовок `Authorization: bearer <ключ>` (специфікація swagger/v1, звірено 23.10).
 *
 * Гроші: кожен запит з позначкою «Транзакція +» — 1 транзакція; кожна сторінка — 1; відповідь 202 «Update in progress» — теж 1.
 * Тому 202 повторюємо один раз через retryDelayMs (за замовч. 30 с; retries — налаштування),
 * а далі беремо архівні дані (showCurrentData=true) з позначкою «архів» — щоб одна перевірка не з'їла десятки транзакцій.
 * Скільки витрачено — рахує Meter (по кожній перевірці окремо; зберігається в cp_checks.tx).
 */
export class YouScoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'YouScoreError'; }
}
/** Лічильник транзакцій однієї перевірки. */
export interface Meter { tx: number }
/** Відповідь: data — null, якщо YouScore відповів 404 («немає такого коду»). archived — довелось узяти архівні дані. */
export interface Got<T> { data: T | null; archived: boolean }

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface YouScoreApi {
  usr(code: string, m: Meter): Promise<Got<any>>;
  history(code: string, m: Meter): Promise<Got<any>>;
  /** Усі сторінки судових справ (до maxPages по 100). */
  courtCaseGroups(code: string, m: Meter, maxPages?: number): Promise<Got<{ total: number; results: any[] }>>;
  enforcement(code: string, m: Meter): Promise<Got<{ total: number; results: any[] }>>;
  expressAnalysis(code: string, m: Meter): Promise<Got<any>>;
  /** PDF-досьє (як «Досьє» у web-версії YouControl). */
  pdf(code: string, m: Meter): Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Скільки компаній, де фізособа — засновник / бенефіціар (збіг за ПІБ — можливі тезки). null — не вдалося. */
  personCompanies(fullName: string, m: Meter): Promise<number | null>;
  /** Скільки компаній, де юрособа (код) — засновник. null — не вдалося. */
  companyCompanies(code: string, m: Meter): Promise<number | null>;
  /** Залишок транзакцій на ключі (безкоштовно). null — не вдалося розібрати відповідь. */
  balance(): Promise<number | null>;
}

export interface YouScoreOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Скільки разів повторювати 202, перш ніж узяти архівні дані (кожен 202 — транзакція; за замовчуванням 1). */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** resultId з відповіді 202 асинхронних запитів: {resultId} | {id} | {resultUrl: '.../{id}'}. */
export function pickResultId(body: any): string | null {
  if (!body) return null;
  if (typeof body === 'string') return body.trim().split('/').pop() || null;
  const v = body.resultId ?? body.id ?? body.result?.id ?? null;
  if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
  const url = body.resultUrl ?? body.url ?? body.result ?? '';
  return typeof url === 'string' && url ? url.split('?')[0].split('/').filter(Boolean).pop() || null : null;
}

export class YouScore implements YouScoreApi {
  private base: string;
  private f: typeof fetch;
  private retries: number;
  private delay: number;
  private timeout: number;
  private sleep: (ms: number) => Promise<void>;
  private relTypes: Promise<Set<number> | null> | null = null;

  constructor(private opts: YouScoreOptions) {
    if (!opts.apiKey) throw new Error('YOUSCORE_API_KEY не задано');
    this.base = (opts.baseUrl || 'https://api.youscore.com.ua').replace(/\/+$/, '');
    this.f = opts.fetch || fetch;
    this.retries = opts.retries ?? 1;
    this.delay = opts.retryDelayMs ?? 30_000;
    this.timeout = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep || sleepReal;
  }

  /** Один HTTP-запит. paid — чи списує YouScore транзакцію (для Meter). */
  private async call(method: 'GET' | 'POST', path: string, query: Record<string, string | number | boolean | undefined>, m: Meter | null, paid: boolean, body?: unknown) {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    const url = `${this.base}${path}${qs ? '?' + qs : ''}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeout);
    let r: Response;
    try {
      r = await this.f(url, {
        method,
        headers: { Authorization: `bearer ${this.opts.apiKey}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch {
      throw new YouScoreError(503, 'YouControl не відповідає — спробуйте за кілька хвилин.');
    } finally { clearTimeout(t); }
    if (paid && m && (r.status === 200 || r.status === 202)) m.tx++;
    if (r.status === 401 || r.status === 403) throw new YouScoreError(503, 'YouControl не прийняв ключ API — перевірте YOUSCORE_API_KEY на сервері.');
    if (r.status === 429) throw new YouScoreError(503, 'YouControl: забагато запитів — спробуйте за хвилину.');
    if (r.status === 451) throw new YouScoreError(451, 'YouControl не віддає дані про цю особу (обмеження закону).');
    if (r.status >= 500) throw new YouScoreError(503, 'YouControl тимчасово недоступний — спробуйте пізніше.');
    let json: any = null;
    const text = await r.text();
    if (text) { try { json = JSON.parse(text); } catch { json = text; } }
    return { status: r.status, json };
  }

  /** GET з повторами на 202; після retries — архівні дані (showCurrentData=true). 404 → data null. */
  private async get<T = any>(path: string, query: Record<string, string | number | boolean | undefined>, m: Meter): Promise<Got<T>> {
    for (let i = 0; i <= this.retries; i++) {
      const { status, json } = await this.call('GET', path, query, m, true);
      if (status === 200) return { data: json as T, archived: false };
      if (status === 404 || status === 204) return { data: null, archived: false };
      if (status === 400) throw new YouScoreError(400, 'YouControl відхилив запит — перевірте код.');
      if (status !== 202) throw new YouScoreError(502, `YouControl відповів ${status}.`);
      if (i < this.retries) await this.sleep(this.delay);
    }
    const { status, json } = await this.call('GET', path, { ...query, showCurrentData: true }, m, true);
    if (status === 200) return { data: json as T, archived: true };
    if (status === 404 || status === 204) return { data: null, archived: true };
    throw new YouScoreError(504, 'YouControl ще оновлює дані — спробуйте перевірити за кілька хвилин.');
  }

  /** Сторінки: Top/Skip, кожна сторінка — 1 транзакція. */
  private async paged(path: string, m: Meter, top: number, maxPages: number): Promise<Got<{ total: number; results: any[] }>> {
    const results: any[] = []; let total = 0, archived = false;
    for (let page = 0; page < maxPages; page++) {
      const g = await this.get<any>(path, { Top: top, Skip: page * top }, m);
      if (!g.data) return page === 0 ? { data: null, archived: g.archived } : { data: { total, results }, archived };
      archived = archived || g.archived;
      const list: any[] = Array.isArray(g.data.results) ? g.data.results : Array.isArray(g.data) ? g.data : [];
      total = Number(g.data.totalResults ?? list.length) || list.length;
      results.push(...list);
      if (results.length >= total || list.length < top || !g.data.nextPageUrl) break;
    }
    return { data: { total, results }, archived };
  }

  usr(code: string, m: Meter) { return this.get(`/v1/usr/${encodeURIComponent(code)}`, {}, m); }
  history(code: string, m: Meter) { return this.get(`/v1/history/${encodeURIComponent(code)}`, {}, m); }
  courtCaseGroups(code: string, m: Meter, maxPages = 3) { return this.paged(`/v1/courtCaseGroup/${encodeURIComponent(code)}`, m, 100, maxPages); }
  enforcement(code: string, m: Meter) { return this.paged(`/v1/enforcement/${encodeURIComponent(code)}`, m, 500, 1); }
  expressAnalysis(code: string, m: Meter) { return this.get(`/v1/expressAnalysis/${encodeURIComponent(code)}`, {}, m); }

  async pdf(code: string, m: Meter) {
    const g = await this.get<any>(`/v1/contractorsPdf/file/${encodeURIComponent(code)}`, {}, m);
    const uri = g.data && (g.data.uri || g.data.url);
    if (!uri) return null;
    // ключ передаємо лише на хост YouScore — не на сторонні сховища за посиланням
    const sameHost = (() => { try { return new URL(uri).host === new URL(this.base).host; } catch { return false; } })();
    try {
      const r = await this.f(uri, { headers: sameHost ? { Authorization: `bearer ${this.opts.apiKey}` } : {} });
      if (!r.ok) return null;
      return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'application/pdf' };
    } catch { return null; }
  }

  /** Асинхронні запити YouScore: перший — 202 з resultId (транзакція), далі результат за resultId (без транзакції). */
  private async asyncResult(start: () => Promise<{ status: number; json: any }>, resultPath: (id: string) => string): Promise<any | null> {
    const s = await start();
    const id = pickResultId(s.json);
    if (!id) return s.status === 200 ? s.json : null;
    for (let i = 0; i < 10; i++) {
      await this.sleep(i === 0 ? 2000 : 5000);
      const r = await this.call('GET', resultPath(id), {}, null, false);
      if (r.status === 200) return r.json;
      if (r.status !== 202) return null;
    }
    return null;
  }
  /** Коди типів зв'язку «засновник / учасник / бенефіціар» зі словника YouScore (кешуються). */
  private ownerRelationTypes(): Promise<Set<number> | null> {
    if (!this.relTypes) {
      this.relTypes = this.call('GET', '/v1/individualsRelatedPersons/relationTypes', {}, null, false).then(({ status, json }) => {
        if (status !== 200 || !json) return null;
        const entries: Array<[number, string]> = Array.isArray(json)
          ? json.map((x: any) => [Number(x.id ?? x.key ?? x.value ?? x.code), String(x.name ?? x.description ?? x.title ?? x.text ?? '')])
          : Object.entries(json).map(([k, v]) => [Number(k), String(v)]);
        const ids = entries.filter(([id, t]) => Number.isFinite(id) && /засновн|учасник|бенефіц|власник/i.test(t)).map(([id]) => id);
        return ids.length ? new Set(ids) : null;
      }).catch(() => null);
    }
    return this.relTypes;
  }
  async personCompanies(fullName: string, m: Meter): Promise<number | null> {
    const [last, first, ...middle] = fullName.trim().split(/\s+/);
    if (!last || !first) return null;
    const types = await this.ownerRelationTypes();
    if (!types) return null;
    const res = await this.asyncResult(
      () => this.call('GET', '/v1/individualsRelatedPersons', { LastName: last, FirstName: first, MiddleName: middle.join(' ') || undefined }, m, true),
      id => `/v1/individualsRelatedPersons/${encodeURIComponent(id)}`,
    ).catch(() => null);
    const data: any[] = res && Array.isArray(res.data) ? res.data : [];
    if (!res) return null;
    return data.filter(c => (c.relations || []).some((r: any) => Number(r.status) === 0 && types.has(Number(r.type)))).length;
  }
  async companyCompanies(code: string, m: Meter): Promise<number | null> {
    const res = await this.asyncResult(
      () => this.call('POST', '/v1/affiliates/query', {}, m, true, {
        contractorCode: code, searchMaxLevels: 1, traverseFinancialGroups: false, traverseBranches: false, traverseManagers: false,
        traverseFounders: true, traverseBeneficiaries: false, traversePersonNames: false, traverseFoundersMinimumPercent: 0,
        includeStatusNotInTermination: true, includeStatusCertificateInvalid: false, includeStatusBankruptcy: true,
        includeStatusTerminationInProgress: true, includeStatusTerminated: false,
        addFieldRegistrationDate: false, addFieldName: false, addFieldEnglishName: false, addFieldLegalForm: false,
        addFieldManagers: false, addFieldContacts: false, addFieldFoundingCapital: false,
      }),
      id => `/v1/affiliates/result/${encodeURIComponent(id)}`,
    ).catch(() => null);
    if (!res) return null;
    const roots: any[] = Array.isArray(res) ? res : [res];
    const codes = new Set<string>();
    for (const r of roots) for (const a of r.affiliates || []) if (Number(a.referenceType) === 6 && a.code) codes.add(String(a.code));
    return codes.size;
  }

  async balance(): Promise<number | null> {
    try {
      const { status, json } = await this.call('GET', '/v1/rateLimits', {}, null, false);
      return status === 200 ? balanceOf(json) : null;
    } catch { return null; }
  }
}

/**
 * Залишок з /v1/rateLimits. Схему відповіді специфікація не описує → шукаємо «скільки доступно» і «скільки використано».
 * Звірте на своєму ключі: `npm run check:youscore` друкує структуру (без значень ключа).
 */
export function balanceOf(j: any): number | null {
  if (!j || typeof j !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  for (const k of ['remaining', 'remain', 'left', 'balance', 'available', 'availableTransactions']) { const v = n(j[k]); if (v !== null) return v; }
  const total = n(j.total ?? j.limit ?? j.totalTransactions ?? j.transactionsLimit ?? j.allowed);
  const used = n(j.used ?? j.spent ?? j.usedTransactions ?? j.transactionsUsed ?? j.made ?? j.count);
  if (total !== null && used !== null) return total - used;
  for (const v of Object.values(j)) if (v && typeof v === 'object' && !Array.isArray(v)) { const b = balanceOf(v); if (b !== null) return b; }
  return null;
}

/** З env сервера. Немає ключа — null: перевірка контрагентів вимкнена (сервер відповідає 503 з поясненням). */
export function youScoreFromEnv(env: NodeJS.ProcessEnv = process.env): YouScore | null {
  const key = (env.YOUSCORE_API_KEY || '').trim();
  return key ? new YouScore({ apiKey: key, baseUrl: env.YOUSCORE_BASE_URL || undefined }) : null;
}
