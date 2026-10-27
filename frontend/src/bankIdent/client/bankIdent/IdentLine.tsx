/**
 * Рядок «№ рахунку» під надходженням — React-обгортка (логіка — identLineMount.ts, той самий код, що в макеті).
 *   const ident = useBankIdent(incoming.map(t => t.id), bankIdentApi);
 *   …у рядку, третім блоком в основній колонці (під назвою й призначенням):
 *   {ident.states[t.id] && <IdentLine state={ident.states[t.id]} api={bankIdentApi} clock={ident.clock} holidays={ident.holidays} onChange={ident.setState} />}
 * Немає стану для рядка — платіж не під правилом (ЮТС, Автомув, ЄЛОГІСТ, вихідні, до запуску) — нічого не малюйте.
 */
import { useEffect, useRef } from 'react';
import type { IdentState } from '../../shared/bankIdent';
import { mountIdentLine, type IdentLineHandle } from './identLineMount';
import type { BankIdentApi, Clock } from './types';
import './bankIdent.css';

export interface IdentLineProps {
  state: IdentState;
  api: BankIdentApi;
  clock?: Clock;
  holidays?: string[];
  onChange?: (s: IdentState) => void;
}

export default function IdentLine({ state, api, clock, holidays, onChange }: IdentLineProps) {
  const host = useRef<HTMLDivElement>(null);
  const h = useRef<IdentLineHandle | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    h.current = mountIdentLine(host.current, { state, api, clock, holidays, onChange: s => cb.current?.(s) });
    return () => { h.current?.destroy(); h.current = null; };
  }, [state.txId, api, clock]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { h.current?.update({ state }); }, [state]);
  return <div ref={host} />;
}
