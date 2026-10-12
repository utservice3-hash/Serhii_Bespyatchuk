/**
 * Клієнт API конфігуратора: /api/cargo/* — через спільний `api` дашборда (токен у заголовку, той самий 401 → вхід).
 * У пакеті тут був `fetch` із cookie; у нас сесія — Bearer-токен, тож лише транспорт інший, контракт той самий.
 * Помилка → Error з текстом сервера (`{error}` українською).
 */
import { api } from '../../../api';
import type { CargoApi, CargoReference } from './configurator';
import type { PalletRow, Vehicle } from '../../shared/cargoDefaults';
import type { HistoryEntry, HistoryList, HistoryRow } from '../../shared/cargoState';

async function j<T>(p: Promise<{ data: T }>): Promise<T> {
  try { return (await p).data; }
  catch (e) {
    const r = (e as { response?: { status?: number; data?: { error?: unknown } } })?.response;
    const msg = r?.data && typeof r.data.error === 'string' ? r.data.error : r?.status ? `Помилка ${r.status}` : 'Сервер недоступний';
    throw new Error(msg, { cause: e });
  }
}

export const cargoApi: CargoApi = {
  getReference: () => j<CargoReference>(api.get('/cargo/reference')),
  saveVehicles: (vehicles: Vehicle[]) => j<{ vehicles: Vehicle[] }>(api.put('/cargo/reference/vehicles', { vehicles })).then(r => r.vehicles),
  savePallets: (pallets: PalletRow[]) => j<{ pallets: PalletRow[] }>(api.put('/cargo/reference/pallets', { pallets })).then(r => r.pallets),
  resetReference: () => j<CargoReference>(api.post('/cargo/reference/reset')),
  listHistory: (limit: number) => j<HistoryList>(api.get('/cargo/history', { params: { limit } })),
  getHistory: (id: string) => j<HistoryEntry>(api.get(`/cargo/history/${encodeURIComponent(id)}`)),
  saveHistory: body => j<HistoryRow>(api.post('/cargo/history', body)),
};

/**
 * three.js r128 — з НАШОГО сервера, лише при відкритті 3D (рішення Романа 12.10, варіант А). Не `import('three')`:
 * динамічний імпорт дав би другий чанк (гейт #225), а npm-пакет зупинив би ланцюг викату на package-lock.
 * Файл — UMD-збірка: без `module`/`define` вона кладе себе в `globalThis.THREE`. Тягнемо текстом із токеном,
 * виконуємо через blob-скрипт; обіцянка одна на вкладку браузера.
 */
let threeOnce: Promise<unknown> | null = null;
export function loadThree(): Promise<unknown> {
  const g = globalThis as unknown as { THREE?: unknown };
  if (g.THREE) return Promise.resolve(g.THREE);
  threeOnce ??= j<string>(api.get('/cargo/three.js', { responseType: 'text', transformResponse: (x: unknown) => x }))
    .then(code => new Promise<unknown>((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => { URL.revokeObjectURL(url); if (g.THREE) resolve(g.THREE); else reject(new Error('3D не завантажився')); };
      s.onerror = () => { URL.revokeObjectURL(url); reject(new Error('3D не завантажився')); };
      document.head.appendChild(s);
    }))
    .catch(e => { threeOnce = null; throw e; });
  return threeOnce;
}
