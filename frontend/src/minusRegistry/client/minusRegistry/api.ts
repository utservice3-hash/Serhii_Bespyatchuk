/**
 * Клієнт API реєстру: /api/minus-deals/* (server: `routes/minusRegistry.ts` → `minusRegistry/router.ts`).
 * У пакеті тут був `fetch` із cookie; у нас сесія — Bearer-токен, тож іде через спільний `api` дашборда (той самий 401 → вхід).
 * Контракт і тексти помилок — як у пакеті: `RegistryApiError(текст сервера | «Помилка N…», статус, request?)`.
 */
import { api } from '../../../api';
import type { Action, CrmDeal, RegRequest, RegUser } from '../../shared/minusRegistry';
import { RegistryApiError, type RegistryApi } from './registry';

async function call<T>(p: Promise<{ data: T }>): Promise<T> {
  try { return (await p).data; }
  catch (e) {
    const r = (e as { response?: { status?: number; data?: { error?: unknown; request?: RegRequest } } })?.response;
    if (!r) throw new RegistryApiError('Немає зв\'язку з сервером. Спробуйте ще раз.', 0);
    const status = r.status ?? 0;
    const msg = r.data && typeof r.data.error === 'string' ? r.data.error : `Помилка ${status}. Спробуйте ще раз.`;
    throw new RegistryApiError(msg, status, r.data?.request);
  }
}

export const minusRegistryApi: RegistryApi & { counter(): Promise<number> } = {
  list: () => call<{ me: RegUser; requests: RegRequest[] }>(api.get('/minus-deals')),
  findDeal: dealId => call<CrmDeal>(api.get(`/minus-deals/deal/${encodeURIComponent(dealId)}`)),
  submit: (dealId, comment) => call<RegRequest>(api.post('/minus-deals', { dealId, comment })),
  act: (id, action: Action, body = {}) => call<RegRequest>(api.post(`/minus-deals/${encodeURIComponent(id)}/${action}`, body)),
  counter: () => call<{ count: number }>(api.get('/minus-deals/counter')).then(j => j.count),
};
