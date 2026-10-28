/**
 * Фільтр «Усі · Чекають № · Неідентифіковані · З номером» і інфо-рядок над списком (у стилі чипів рахунків).
 *   const { counts } = useBankIdentCounts(bankIdentApi);
 *   <IdentFilter counts={counts} value={f} onChange={setF} />      // f ≠ 'all' → рядки з bankIdentApi.list(f)
 *   <IdentRuleBar kind="in" />                                      // на вкладці «Вихідні» — kind="out", лише тим, у кого є право на коментарі
 */
import { useEffect, useRef } from 'react';
import { identRuleHtml, mountIdentFilter, type IdentFilterValue } from './identFilterMount';
import type { CountsResponse } from './types';
import './bankIdent.css';

export function IdentFilter({ counts, value, onChange }: { counts: CountsResponse | null; value: IdentFilterValue; onChange: (v: IdentFilterValue) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const h = useRef<ReturnType<typeof mountIdentFilter> | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    h.current = mountIdentFilter(host.current, { counts, value, onChange: v => cb.current(v) });
    return () => { h.current?.destroy(); h.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { h.current?.update({ counts, value }); }, [counts, value]);
  return <div ref={host} />;
}

/** Статичний текст із пакета (без даних користувача) — innerHTML безпечний. */
export function IdentRuleBar({ kind }: { kind: 'in' | 'out' }) {
  return <div dangerouslySetInnerHTML={{ __html: identRuleHtml(kind) }} />;
}
