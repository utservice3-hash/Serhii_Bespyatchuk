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
import { createBankIdentApi } from "./client/bankIdent/api";

export const bankIdentApi = createBankIdentApi({
  base: `${String(api.defaults.baseURL ?? "").replace(/\/+$/, "")}/bank-ident`,
  fetch: (url, init) => {
    const token = localStorage.getItem("token");
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  },
});

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
