// Тест пакета Сергія (24.10.2026) дослівно, vitest → `vitestShim`; гейт — `counterparty/counterparty.test.ts`.
/** Клієнт YouScore: заголовок з ключем, 202 → повтор → архів, лічильник транзакцій, помилки для людини. Мережі немає — підставний fetch. */
import { describe, expect, it } from './vitestShim.js';
import { YouScore, YouScoreError, balanceOf, pickResultId, type Meter } from '../server/youscore/client.js';

type Reply = { status: number; body?: unknown; type?: string };
function fake(routes: Array<[RegExp, Reply | Reply[]]>) {
  const calls: Array<{ url: string; auth: string | null; method: string }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get('authorization'), method: init?.method || 'GET' });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return new Response('', { status: 404 });
    const r = Array.isArray(hit[1]) ? (hit[1].length > 1 ? hit[1].shift()! : hit[1][0]) : hit[1];
    return new Response(r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.type || 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ys = (f: typeof fetch) => new YouScore({ apiKey: 'test-key', fetch: f, retries: 2, retryDelayMs: 0, sleep: async () => undefined });

describe('YouScore', () => {
  it('ключ — у заголовку Authorization: bearer, не в адресі; 200 — 1 транзакція', async () => {
    const { f, calls } = fake([[/\/v1\/usr\/41234567$/, { status: 200, body: { code: '41234567' } }]]);
    const m: Meter = { tx: 0 };
    const g = await ys(f).usr('41234567', m);
    expect(g).toEqual({ data: { code: '41234567' }, archived: false });
    expect(calls[0].auth).toBe('bearer test-key');
    expect(calls[0].url).not.toContain('test-key');
    expect(m.tx).toBe(1);
  });
  it('202 → повтор; після retries — архівні дані (showCurrentData=true), кожна відповідь — транзакція', async () => {
    const { f, calls } = fake([
      [/showCurrentData=true/, { status: 200, body: { features: [] } }],
      [/\/v1\/expressAnalysis\//, { status: 202 }],
    ]);
    const m: Meter = { tx: 0 };
    const g = await ys(f).expressAnalysis('41234567', m);
    expect(g.archived).toBe(true);
    expect(calls.map(c => c.url.includes('showCurrentData'))).toEqual([false, false, false, true]);
    expect(m.tx).toBe(4);
  });
  it('404 → немає такого коду (data null); 401 → зрозумілий текст; 5xx → «тимчасово недоступний»', async () => {
    const m: Meter = { tx: 0 };
    expect((await ys(fake([[/usr/, { status: 404 }]]).f).usr('12345678', m)).data).toBeNull();
    await expect(ys(fake([[/usr/, { status: 401 }]]).f).usr('12345678', m)).rejects.toThrow('YouControl не прийняв ключ API — перевірте YOUSCORE_API_KEY на сервері.');
    await expect(ys(fake([[/usr/, { status: 503 }]]).f).usr('12345678', m)).rejects.toBeInstanceOf(YouScoreError);
    expect(m.tx).toBe(0);
  });
  it('суди: сторінки по 100, кожна — транзакція; зупиняємось, коли все отримали', async () => {
    const page = (n: number, total: number, next: boolean) => ({ status: 200, body: { totalResults: total, nextPageUrl: next ? 'x' : null, results: Array.from({ length: n }, (_, i) => ({ caseNumber: String(i) })) } });
    const { f, calls } = fake([[/Skip=0/, page(100, 130, true)], [/Skip=100/, page(30, 130, false)]]);
    const m: Meter = { tx: 0 };
    const g = await ys(f).courtCaseGroups('41234567', m);
    expect(g.data!.results.length).toBe(130);
    expect(calls.length).toBe(2); expect(m.tx).toBe(2);
    expect(calls[0].url).toContain('/v1/courtCaseGroup/41234567?Top=100&Skip=0');
  });
  it('PDF: посилання → файл; ключ не передаємо на сторонній хост', async () => {
    const { f, calls } = fake([
      [/contractorsPdf/, { status: 200, body: { uri: 'https://files.example.org/dossier.pdf' } }],
      [/files\.example\.org/, { status: 200, body: '%PDF-1.4 test', type: 'application/pdf' }],
    ]);
    const m: Meter = { tx: 0 };
    const p = await ys(f).pdf('41234567', m);
    expect(new TextDecoder().decode(p!.bytes)).toBe('%PDF-1.4 test');
    expect(calls[1].auth).toBeNull();
    expect(m.tx).toBe(1);
  });
  it('компаній у фізособи: асинхронний запит (resultId) і словник типів зв\'язку', async () => {
    const { f } = fake([
      [/relationTypes/, { status: 200, body: [{ id: 1, name: 'Засновник (учасник)' }, { id: 2, name: 'Керівник' }, { id: 3, name: 'Кінцевий бенефіціарний власник' }] }],
      [/individualsRelatedPersons\/r-1/, { status: 200, body: { data: [
        { name: 'ТОВ А', relations: [{ status: 0, type: 1 }] }, { name: 'ТОВ Б', relations: [{ status: 0, type: 2 }] },
        { name: 'ТОВ В', relations: [{ status: 1, type: 1 }] }, { name: 'ТОВ Г', relations: [{ status: 0, type: 3 }] },
      ] } }],
      [/individualsRelatedPersons\?/, { status: 202, body: { resultUrl: 'https://api.youscore.com.ua/v1/individualsRelatedPersons/r-1' } }],
    ]);
    const m: Meter = { tx: 0 };
    expect(await ys(f).personCompanies('Ковальчук Андрій Степанович', m)).toBe(2);   // А (засновник) і Г (бенефіціар); Б — керівник; В — історичний
    expect(m.tx).toBe(1);
  });
  it('залишок і resultId — обережний розбір', () => {
    expect(balanceOf({ total: 19096, used: 15207 })).toBe(3889);
    expect(balanceOf({ key: { remaining: 3889 } })).toBe(3889);
    expect(balanceOf({ something: 'else' })).toBeNull();
    expect(pickResultId({ resultId: 'abc' })).toBe('abc');
    expect(pickResultId({ resultUrl: 'https://x/v1/a/b-42?x=1' })).toBe('b-42');
  });
});
