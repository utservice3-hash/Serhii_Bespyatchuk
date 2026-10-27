/**
 * Хуки «Виписки»:
 *   useBankIdent(ids, api)      — стани № рахунку для рядків, що на екрані (POST /state; лише ті, що під правилом);
 *   useBankIdentCounts(api)     — лічильники для фільтра й бейджа в меню (GET /counts; badge — лише тим, хто вписує №);
 *   useOutComments(ids, api)    — коментарі до вихідних ФОП (POST /comments/summary; немає права → enabled=false).
 */
import { useCallback, useEffect, useState } from 'react';
import type { CommentSummary, IdentState } from '../../shared/bankIdent';
import { BankIdentError, clockFrom, type BankIdentApi, type Clock, type CountsResponse } from './types';

const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function useBankIdent(ids: Array<number | string>, api: BankIdentApi) {
  const key = ids.map(String).join(',');
  const [states, setStates] = useState<Record<string, IdentState>>({});
  const [clock, setClock] = useState<Clock>(() => Date.now);
  const [holidays, setHolidays] = useState<string[]>([]);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    const list = key ? key.split(',').map(Number) : [];
    if (!list.length) { setStates({}); return; }
    try {
      const out: Record<string, IdentState> = {};
      let now = new Date().toISOString(), hol: string[] = [];
      for (const part of chunks(list, 500)) {
        const r = await api.states(part);
        Object.assign(out, r.states); now = r.now; hol = r.holidays || [];
      }
      setStates(out); setClock(() => clockFrom(now)); setHolidays(hol); setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [key, api]);
  useEffect(() => { void reload(); }, [reload]);
  const setState = useCallback((s: IdentState) => setStates(p => ({ ...p, [s.txId]: s })), []);
  return { states, clock, holidays, setState, reload, error };
}

export function useBankIdentCounts(api: BankIdentApi, everyMs = 60_000) {
  const [counts, setCounts] = useState<CountsResponse | null>(null);
  const reload = useCallback(async () => {
    try { setCounts(await api.counts()); } catch { /* лічильник не критичний — спробуємо наступного разу */ }
  }, [api]);
  useEffect(() => {
    void reload();
    const t = setInterval(() => { void reload(); }, everyMs);
    return () => clearInterval(t);
  }, [reload, everyMs]);
  return { counts, badge: counts ? counts.badge : 0, reload };
}

export function useOutComments(ids: Array<number | string>, api: BankIdentApi) {
  const key = ids.map(String).join(',');
  const [summaries, setSummaries] = useState<Record<string, CommentSummary>>({});
  const [enabled, setEnabled] = useState(false);
  const reload = useCallback(async () => {
    const list = key ? key.split(',').map(Number) : [];
    if (!list.length) { setSummaries({}); return; }
    try {
      const out: Record<string, CommentSummary> = {};
      for (const part of chunks(list, 500)) Object.assign(out, await api.commentSummary(part));
      setSummaries(out); setEnabled(true);
    } catch (e) {
      if (e instanceof BankIdentError && e.status === 403) { setEnabled(false); setSummaries({}); }
    }
  }, [key, api]);
  useEffect(() => { void reload(); }, [reload]);
  const setSummary = useCallback((id: number, s: CommentSummary) => setSummaries(p => ({ ...p, [id]: s })), []);
  return { summaries, enabled, setSummary, reload };
}
