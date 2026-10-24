/**
 * Лічильник для пункту бокового меню «Реєстри та узгодження»: мінусові угоди + запити на погодження контрагентів.
 *   const n = useRegistriesCount();   // <MenuItem badge={n || undefined}>Реєстри та узгодження</MenuItem>
 * Сергію — «На погодженні» (обидва реєстри) і запити на зміну умов; бухгалтерії — погоджені мінусові угоди (чекають оплати);
 * менеджеру й тім-ліду — свої «Повернуто». Оновлюється раз на хвилину, при поверненні на вкладку браузера і одразу після дії.
 */
import { useEffect, useState } from 'react';
import { minusRegistryApi } from './minusRegistry/api';
import { counterpartyApi } from './counterparty/api';

export const COUNT_EVENT = 'registries:count';

export function useRegistriesCount(pollMs = 60_000, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    // Дашборд: ролі без вкладки «Реєстри» не питають сервер узагалі (інакше щохвилини 403).
    if (!enabled) { setN(0); return; }
    let alive = true;
    const tick = () => {
      Promise.all([minusRegistryApi.counter().catch(() => 0), counterpartyApi.counter().catch(() => 0)])
        .then(([a, b]) => { if (alive) setN(a + b); });
    };
    const onCount = (e: Event) => { const v = (e as CustomEvent<number>).detail; if (typeof v === 'number') setN(v); };
    tick();
    const t = setInterval(tick, pollMs);
    window.addEventListener('focus', tick);
    window.addEventListener(COUNT_EVENT, onCount);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', tick); window.removeEventListener(COUNT_EVENT, onCount); };
  }, [pollMs, enabled]);
  return n;
}
