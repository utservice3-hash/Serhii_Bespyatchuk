/**
 * Сторінка дашборда «Реєстри та узгодження» (окремий пункт бокового меню; пакет Сергія 23–24.10).
 * Вкладки: «Реєстр мінусових угод» · «Узгодження роботи з новим контрагентом» · «Перевірка контрагента». Логіка — registriesMount.ts
 * (той самий код, що в макеті). Хто що може — визначає сервер за сесією; які вкладки показати — `regTabsFor(roleKey)`.
 * Посилання пакета на файли (`/api/counterparty/...`) перехоплюються й качаються з токеном (`interceptApiLinks`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../components/Toasts';
import { mountRegistriesPage, type RegTab } from './registriesMount';
import { minusRegistryApi } from './minusRegistry/api';
import { counterpartyApi, interceptApiLinks } from './counterparty/api';
import { navFromSearch, navToUrl, type NavTarget } from './counterparty/types';
import { COUNT_EVENT } from './useRegistriesCount';
import './minusRegistry/registry.css';
import './counterparty/cp.css';
import './registriesPage.css';

/** Назва — і в заголовку, і в пункті бокового меню. */
export const PAGE_TITLE = 'Реєстри та узгодження';

export default function RegistriesPage({ tabs, onNavigate }: { tabs?: RegTab[]; onNavigate?: (t: NavTarget, url: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [n, setN] = useState(0);
  const toast = useToast();
  const onFileClick = useMemo(() => interceptApiLinks(msg => toast(msg, { error: true })), [toast]);
  const nav = useRef(onNavigate);
  nav.current = onNavigate;
  useEffect(() => {
    if (!host.current) return;
    const h = mountRegistriesPage(host.current, {
      minusApi: minusRegistryApi,
      cpApi: counterpartyApi,
      tabs,
      initial: navFromSearch(window.location.search),
      // «Ліміти клієнтів» — інша сторінка (дебіторка): роутер дашборда
      navigate: t => { const url = navToUrl(t); if (nav.current) nav.current(t, url); else window.location.assign(url); },
      // вкладка / відкритий запит → адреса (можна поділитися посиланням)
      onLocation: t => window.history.replaceState(window.history.state, '', navToUrl(t)),
      onCount: c => { setN(c); window.dispatchEvent(new CustomEvent(COUNT_EVENT, { detail: c })); },
    });
    const onFocus = () => { void h.refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); h.destroy(); };
  }, [tabs?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="registries-page" onClickCapture={onFileClick}>
      <h1 className="rp-title">
        {PAGE_TITLE}
        {n > 0 && <span className="rp-cnt" title="Чекають вашої дії">{n}</span>}
      </h1>
      <div ref={host} />
    </div>
  );
}
