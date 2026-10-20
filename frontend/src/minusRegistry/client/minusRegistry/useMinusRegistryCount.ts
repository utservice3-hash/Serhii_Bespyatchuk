/**
 * Лічильник для пункту бокового меню «Реєстри» (рішення 20.10: сповіщення — лише лічильник у меню дашборда).
 *   const n = useMinusRegistryCount();   // <MenuItem badge={n || undefined}>Реєстри</MenuItem>
 * Сергію — запити «На погодженні»; бухгалтерії — «Погоджено» (чекають оплати); менеджеру й тім-ліду — свої «Повернуто».
 * Оновлюється раз на хвилину, при поверненні на вкладку браузера і одразу після дії у вкладці реєстру.
 */
import { useEffect, useState } from 'react';
import { minusRegistryApi } from './api';

export const COUNT_EVENT = 'minus-registry:count';

export function useMinusRegistryCount(pollMs = 60_000, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    // Дашборд: ролі без вкладки «Реєстри» не питають сервер узагалі (інакше щохвилини 403).
    if (!enabled) { setN(0); return; }
    let alive = true;
    const tick = () => { minusRegistryApi.counter().then(c => { if (alive) setN(c); }).catch(() => undefined); };
    const onCount = (e: Event) => { const v = (e as CustomEvent<number>).detail; if (typeof v === 'number') setN(v); };
    tick();
    const t = setInterval(tick, pollMs);
    window.addEventListener('focus', tick);
    window.addEventListener(COUNT_EVENT, onCount);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', tick); window.removeEventListener(COUNT_EVENT, onCount); };
  }, [pollMs, enabled]);
  return n;
}
