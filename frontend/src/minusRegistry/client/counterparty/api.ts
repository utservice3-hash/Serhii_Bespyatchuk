/**
 * Клієнт API: /api/counterparty/* і /api/client-limits/* (server: `routes/counterparty.ts` → `counterparty/mount.ts`).
 * У пакеті тут був `fetch` із cookie; у нас сесія — Bearer-токен, тож іде через спільний `api` дашборда (той самий 401 → вхід).
 * Контракт і тексти помилок — як у пакеті: `CpApiError(текст сервера | «Помилка N…», статус, request?)`.
 * `pdfUrl` / `fileUrl` лишаються адресами (пакет малює їх як посилання) — клік по них перехоплює сторінка і качає файл
 * через `api` з токеном (`downloadApiFile` нижче), бо звичайний перехід за `<a href="/api/…">` повернув би 401.
 */
import { api } from '../../../api';
import type { CpApi, LimitsApi } from './types';
import { CpApiError } from './types';

async function call<T>(p: Promise<{ data: T }>): Promise<T> {
  try { return (await p).data; }
  catch (e) {
    const r = (e as { response?: { status?: number; data?: { error?: unknown; request?: unknown } } })?.response;
    if (!r) throw new CpApiError('Немає зв\'язку з сервером. Спробуйте ще раз.', 0);
    const status = r.status ?? 0;
    const msg = r.data && typeof r.data.error === 'string' ? r.data.error : `Помилка ${status}. Спробуйте ще раз.`;
    throw new CpApiError(msg, status, r.data?.request as never);
  }
}

const CP = '/counterparty';
const enc = encodeURIComponent;
export const counterpartyApi: CpApi = {
  listRequests: () => call(api.get(`${CP}/requests`)),
  counter: () => call<{ count: number }>(api.get(`${CP}/requests/counter`)).then(j => j.count),
  lookup: code => call(api.post(`${CP}/lookup`, { code })),
  submit: body => call(api.post(`${CP}/requests`, body)),
  act: (id, action, body = {}) => call(api.post(`${CP}/requests/${enc(id)}/${action}`, body)),
  listChecks: () => call(api.get(`${CP}/checks`)),
  startCheck: (code, force) => call(api.post(`${CP}/checks`, { code, force: !!force })),
  getCheck: id => call(api.get(`${CP}/checks/${enc(id)}`)),
  pdf: id => call(api.post(`${CP}/checks/${enc(id)}/pdf`)),
  pdfUrl: id => `/api${CP}/checks/${enc(id)}/pdf`,
  upload: file => call(api.post(`${CP}/files`, file, {
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': enc(file.name) },
    transformRequest: [(d: unknown) => d],
  })),
  fileUrl: id => `/api${CP}/files/${enc(id)}`,
};

const CL = '/client-limits';
export const clientLimitsApi: LimitsApi = {
  list: () => call(api.get(CL)),
  counter: () => call<{ count: number }>(api.get(`${CL}/counter`)).then(j => j.count),
  byDebtor: () => call(api.get(`${CL}/by-debtor`)),
  edit: (id, b) => call(api.post(`${CL}/${enc(id)}/edit`, b)),
  keep: (id, note) => call(api.post(`${CL}/${enc(id)}/keep`, { note })),
  set: (debtorKey, b) => call(api.post(`${CL}/set`, { ...b, debtorKey })),
  search: q => call(api.get(`${CL}/search`, { params: { q } })),
  add: (clientKey, b) => call(api.post(`${CL}/add`, { ...b, clientKey })),
};

/** Файл з нашого API (`/api/counterparty/...`) — з токеном, як blob; відкрити PDF у новій вкладці, решту — зберегти. */
export async function downloadApiFile(href: string): Promise<void> {
  const path = href.replace(/^\/api/, '');
  const r = await api.get(path, { responseType: 'blob' });
  const blob = r.data as Blob;
  const url = URL.createObjectURL(blob);
  const cd = String((r.headers as Record<string, unknown>)['content-disposition'] ?? '');
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : 'file';
  if (blob.type === 'application/pdf') window.open(url, '_blank');
  else { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** Перехоплювач кліків по посиланнях пакета на файли API (`<a href="/api/counterparty/...">`); збій — у сповіщення дашборда. */
export function interceptApiLinks(onError: (msg: string) => void) {
  return (e: { target: EventTarget | null; preventDefault(): void }): void => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href^="/api/counterparty/"]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    void downloadApiFile(a.getAttribute('href')!).catch(() => onError('Файл не завантажився — спробуйте ще раз.'));
  };
}
