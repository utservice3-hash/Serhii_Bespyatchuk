/**
 * Коментарі до вихідного платежу ФОП — React-обгортка (логіка — outCommentsMount.ts).
 *   const oc = useOutComments(outgoing.map(t => t.id), bankIdentApi);   // немає права → oc.enabled = false, нічого не малюємо
 *   {oc.enabled && oc.summaries[t.id] && <OutComments txId={t.id} summary={oc.summaries[t.id]} api={bankIdentApi} onChange={s => oc.setSummary(t.id, s)} />}
 */
import { useEffect, useRef } from 'react';
import type { CommentSummary } from '../../shared/bankIdent';
import { mountOutComments, type OutCommentsHandle } from './outCommentsMount';
import type { BankIdentApi } from './types';
import './bankIdent.css';

export interface OutCommentsProps {
  txId: number;
  summary: CommentSummary;
  api: BankIdentApi;
  onChange?: (s: CommentSummary) => void;
  privacy?: string;
}

export default function OutComments({ txId, summary, api, onChange, privacy }: OutCommentsProps) {
  const host = useRef<HTMLDivElement>(null);
  const h = useRef<OutCommentsHandle | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    h.current = mountOutComments(host.current, { txId, summary, api, privacy, onChange: s => cb.current?.(s) });
    return () => { h.current?.destroy(); h.current = null; };
  }, [txId, api]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { h.current?.update({ summary }); }, [summary]);
  return <div ref={host} />;
}
