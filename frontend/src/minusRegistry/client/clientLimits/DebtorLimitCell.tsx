/**
 * Колонка «Ліміти» в «Активній дебіторці» (React-обгортка; логіка — debtorLimitMount.ts, той самий код, що в макеті).
 *   const { cells, canEdit, reload } = useDebtorLimits();
 *   <td><DebtorLimitCell debtor={{ key: d.key, name: d.name }} cell={cells[d.key]} canEdit={canEdit} onSaved={reload} onNavigate={t => router.push(navToUrl(t))} /></td>
 * Олівці — лише Сергію; іншим — «Запросити зміну» (свій клієнт) → вкладка «Ліміти клієнтів».
 */
import { useEffect, useRef } from 'react';
import type { DebtorLimitCell as Cell, LimitRow } from '../../shared/clientLimits';
import { clientLimitsApi } from '../counterparty/api';
import { navToUrl, type NavTarget } from '../counterparty/types';
import { mountDebtorLimitCell, type DebtorLimitCellHandle } from './debtorLimitMount';
import '../counterparty/cp.css';

export interface DebtorLimitCellProps {
  debtor: { key: string; name: string };
  cell: Cell | null | undefined;
  canEdit: boolean;
  onSaved?: (row: LimitRow, msg: string) => void;
  onNavigate?: (t: NavTarget, url: string) => void;
}

export default function DebtorLimitCell({ debtor, cell, canEdit, onSaved, onNavigate }: DebtorLimitCellProps) {
  const host = useRef<HTMLDivElement>(null);
  const h = useRef<DebtorLimitCellHandle | null>(null);
  const saved = useRef(onSaved), nav = useRef(onNavigate);
  saved.current = onSaved; nav.current = onNavigate;
  useEffect(() => {
    if (!host.current) return;
    h.current = mountDebtorLimitCell(host.current, {
      debtor, cell, canEdit, api: clientLimitsApi,
      onSaved: (r, msg) => saved.current?.(r, msg),
      navigate: t => { const url = navToUrl(t); if (nav.current) nav.current(t, url); else window.location.assign(url); },
    });
    return () => { h.current?.destroy(); h.current = null; };
  }, [debtor.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { h.current?.update({ cell, canEdit, debtor }); }, [cell, canEdit, debtor.name]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} />;
}
