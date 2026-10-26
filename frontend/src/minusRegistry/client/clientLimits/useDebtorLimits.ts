/**
 * Для колонки «Ліміти» в «Активній дебіторці»: ключ боржника → ліміт з «Лімітів клієнтів» (а не з рахунків).
 *   const { cells, canEdit, reload } = useDebtorLimits();
 *   <td><DebtorLimitCell debtor={{ key: d.key, name: d.name }} cell={cells[d.key]} canEdit={canEdit} onSaved={reload} /></td>   // готова комірка: ./DebtorLimitCell.tsx
 *   const s = overdueSplit(debtors, cells);   // плитки «Загальний борг» / «Прострочено» (shared/clientLimits.ts)
 * c.status: 'ok' (у межах) | 'over' (переліміт) | 'none' (не узгоджено); c.limit, c.days, c.from, c.suspended, c.canRequest.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DebtorLimitCell } from '../../shared/clientLimits';
import { clientLimitsApi } from '../counterparty/api';

// loaded — відповідь прийшла: доти (і при збої) екран малює ліміт зі своїх даних, а не «не узгоджено» всім (дашборд).
export function useDebtorLimits(): { cells: Record<string, DebtorLimitCell>; canEdit: boolean; at: string | null; loaded: boolean; reload: () => void } {
  const [s, setS] = useState<{ cells: Record<string, DebtorLimitCell>; canEdit: boolean; at: string | null; loaded: boolean }>({ cells: {}, canEdit: false, at: null, loaded: false });
  const reload = useCallback(() => {
    clientLimitsApi.byDebtor()
      .then(j => setS({ cells: j.cells || {}, canEdit: !!j.canEdit, at: j.at || null, loaded: true }))
      .catch(() => undefined);
  }, []);
  useEffect(() => { reload(); window.addEventListener('focus', reload); return () => window.removeEventListener('focus', reload); }, [reload]);
  return { ...s, reload };
}
