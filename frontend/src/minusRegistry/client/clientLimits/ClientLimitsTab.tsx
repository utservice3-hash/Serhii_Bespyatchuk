/**
 * П'ята вкладка сторінки «Дебіторська заборгованість» — «Ліміти клієнтів» (React-обгортка; логіка — limits.ts, той самий код, що в макеті).
 *   {tab === 'limits' && <ClientLimitsTab onCount={setLimitsBadge} onNavigate={t => router.push(navToUrl(t))} />}
 * Переходи «Відкрити запит» / «Перевірити» / «Подати запит на нові умови» ведуть на сторінку «Реєстри та узгодження».
 */
import { useEffect, useRef } from 'react';
import { mountClientLimits } from './limits';
import { clientLimitsApi } from '../counterparty/api';
import { navFromSearch, navToUrl, type NavTarget } from '../counterparty/types';
import { LIMITS_COUNT_EVENT } from './useClientLimitsCount';
import '../counterparty/cp.css';

export default function ClientLimitsTab({ onCount, onNavigate }: { onCount?: (n: number) => void; onNavigate?: (t: NavTarget, url: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef(onCount), nav = useRef(onNavigate);
  cb.current = onCount; nav.current = onNavigate;
  useEffect(() => {
    if (!host.current) return;
    const initial = navFromSearch(window.location.search);
    const h = mountClientLimits(host.current, {
      api: clientLimitsApi,
      initial: initial && initial.tab === 'limits' ? initial : undefined,
      navigate: t => { const url = navToUrl(t); if (nav.current) nav.current(t, url); else window.location.assign(url); },
      onCount: n => { cb.current?.(n); window.dispatchEvent(new CustomEvent(LIMITS_COUNT_EVENT, { detail: n })); },
    });
    const onFocus = () => { void h.refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); h.destroy(); };
  }, []);
  return <div ref={host} />;
}
