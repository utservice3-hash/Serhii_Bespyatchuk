/**
 * Лічильник на вкладці «Ліміти клієнтів» (і, якщо хочете, на пункті меню «Дебіторська заборгованість»):
 * перевищено ліміт + прострочено + нова справа в суді — серед клієнтів, яких бачить користувач. Бухгалтерії й керівникам — 0.
 */
import { useEffect, useState } from 'react';
import { clientLimitsApi } from '../counterparty/api';

export const LIMITS_COUNT_EVENT = 'client-limits:count';

export function useClientLimitsCount(pollMs = 5 * 60_000, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let alive = true;
    const tick = () => { clientLimitsApi.counter().then(c => { if (alive) setN(c); }).catch(() => undefined); };
    const onCount = (e: Event) => { const v = (e as CustomEvent<number>).detail; if (typeof v === 'number') setN(v); };
    tick();
    const t = setInterval(tick, pollMs);
    window.addEventListener('focus', tick);
    window.addEventListener(LIMITS_COUNT_EVENT, onCount);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', tick); window.removeEventListener(LIMITS_COUNT_EVENT, onCount); };
  }, [pollMs, enabled]);
  return n;
}
