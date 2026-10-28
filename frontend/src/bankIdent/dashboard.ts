/**
 * 💳 Підключення пакета «Виписка — № рахунку» (27.10.2026) до дашборда — єдине місце, де пакет знає про наш API.
 *  - `bankIdentApi` — клієнт пакета (`createBankIdentApi`) на нашій адресі API і з нашим Bearer-токеном
 *    (ТЗ §6: «ВАШ fetch з Bearer-токеном»), як `api` (axios) з `api.ts`;
 *  - `useBankIdentBadge` — число біля «Виписка» в меню (як «Реєстри»): скільки платежів чекають №.
 *    Питаємо сервер лише тих, у кого є вкладка й право вписувати № — інакше щохвилини марний запит.
 *  - `BANK_IDENT_COUNT_EVENT` — після «Зберегти» на екрані бейдж оновлюється одразу, не чекаючи хвилини.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { createBankIdentApi, type FetchLike } from "./client/bankIdent/api";
import { BankIdentError, type BankIdentApi, type CountsResponse, type ListResponse } from "./client/bankIdent/types";

const BASE = `${String(api.defaults.baseURL ?? "").replace(/\/+$/, "")}/bank-ident`;
const authFetch: FetchLike = (url, init) => {
  const token = localStorage.getItem("token");
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
};
export const bankIdentApi = createBankIdentApi({ base: BASE, fetch: authFetch });

/**
 * Той самий клієнт, але фільтр («Чекають № · …») і лічильники — лише для компанії, вибраної чипом у «Виписці» (28.10:
 * без цього «З номером» на чипі «ФОП (Моно)» показував платіж ФОП (Приват)). Без компанії — сам `bankIdentApi`.
 * Бейдж у меню й далі питає без компанії (`useBankIdentBadge`).
 */
export function bankIdentApiFor(company: string | null): BankIdentApi {
  if (!company) return bankIdentApi;
  const q = `company=${encodeURIComponent(company)}`;
  const get = async <T,>(path: string): Promise<T> => {
    const r = await authFetch(BASE + path, { method: "GET", headers: { Accept: "application/json" } })
      .catch(() => { throw new BankIdentError("Немає звʼязку з сервером. Спробуйте ще раз.", 0); });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new BankIdentError((j && j.error) || `Помилка ${r.status}. Спробуйте ще раз.`, r.status, j && j.state);
    return j as T;
  };
  return {
    ...bankIdentApi,
    counts: () => get<CountsResponse>(`/counts?${q}`),
    list: (status, limit = 50, offset = 0) => get<ListResponse>(`/list?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}&${q}`),
  };
}

export const BANK_IDENT_COUNT_EVENT = "bank-ident:count";

export function useBankIdentBadge(enabled: boolean, pollMs = 60_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let alive = true;
    const tick = () => { bankIdentApi.counts().then((c) => { if (alive) setN(c.badge); }).catch(() => undefined); };
    tick();
    const t = setInterval(tick, pollMs);
    window.addEventListener("focus", tick);
    window.addEventListener(BANK_IDENT_COUNT_EVENT, tick);
    return () => { alive = false; clearInterval(t); window.removeEventListener("focus", tick); window.removeEventListener(BANK_IDENT_COUNT_EVENT, tick); };
  }, [enabled, pollMs]);
  return n;
}
