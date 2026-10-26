/**
 * Курс НБУ (€, $) для розрахунку в запиті: ставки в валюті → гривні. Відкритий API НБУ, без ключа:
 *   https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&date=YYYYMMDD → [{cc: 'EUR', rate, exchangedate}, …]
 * Кеш — на день. НБУ недоступний → останній відомий курс; не було жодного → eur/usd = 0 (інтерфейс не рахує маржу у валюті).
 */
import type { Rates } from '../shared/counterparty.js';

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export async function fetchNbuRates(day: Date, f: typeof fetch = fetch): Promise<Rates> {
  const r = await f(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json&date=${ymd(day)}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`НБУ: ${r.status}`);
  const list = (await r.json()) as Array<{ cc: string; rate: number; exchangedate?: string }>;
  const pick = (cc: string) => { const x = list.find(v => v.cc === cc); if (!x || !(x.rate > 0)) throw new Error(`НБУ: немає ${cc}`); return x.rate; };
  return { eur: pick('EUR'), usd: pick('USD'), at: day.toISOString().slice(0, 10) };
}

/** Курс на сьогодні з кешем. */
export function nbuRates(f: typeof fetch = fetch, now: () => Date = () => new Date()): () => Promise<Rates> {
  let last: Rates | null = null, lastDay = '', inflight: Promise<Rates> | null = null;
  return async () => {
    const d = now(), day = ymd(d);
    if (last && lastDay === day) return last;
    if (!inflight) {
      inflight = fetchNbuRates(d, f)
        .then(r => { last = r; lastDay = day; return r; })
        .catch(e => { console.error('[counterparty] курс НБУ:', e instanceof Error ? e.message : e); return last || { eur: 0, usd: 0, at: '' }; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
}
