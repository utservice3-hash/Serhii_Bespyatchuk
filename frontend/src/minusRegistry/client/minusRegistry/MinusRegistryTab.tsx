/**
 * React-обгортка вкладки «Реєстр мінусових угод». Уся логіка — у registry.ts (той самий код, що в макеті).
 * Лічильник «чекає вашої дії» віддає в onCount і розсилає подією `minus-registry:count` — її слухає useMinusRegistryCount (пункт меню).
 */
import { useEffect, useRef } from 'react';
import { mountMinusRegistry } from './registry';
import { minusRegistryApi } from './api';
import { COUNT_EVENT } from './useMinusRegistryCount';
import './registry.css';

export default function MinusRegistryTab({ onCount }: { onCount?: (n: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onCount);
  cb.current = onCount;
  useEffect(() => {
    if (!host.current) return;
    const h = mountMinusRegistry(host.current, {
      api: minusRegistryApi,
      onCount: n => { cb.current?.(n); window.dispatchEvent(new CustomEvent(COUNT_EVENT, { detail: n })); },
    });
    const onFocus = () => { void h.refresh(); };          // повернулись на вкладку браузера — свіжі статуси
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); h.destroy(); };
  }, []);
  return <div ref={host} />;
}
