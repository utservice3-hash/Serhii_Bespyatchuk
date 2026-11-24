/**
 * ⚡ СПІЛЬНИЙ ВИКЛИК ЯДРА ДЛЯ КАРТОК ОДНОГО ВІДДІЛУ (заміри 20.11.2026 на проді, після викату стіни).
 *
 * Картки відділу питають сервер одночасно, і більшість із них — РІЗНІ поля ОДНОГО виклику ядра: «Поставлені», «Відправлені
 * авто всього» й «Машини нових клієнтів» — це той самий `dispatchedByLoadBucket`, дві картки «Час опрацювання» — той самий
 * `leadTakeSeries`, чотири картки постійних — `repeatClientsByBucket` і так далі. Без спільного виклику «Продажі» рахували
 * однакове двічі-тричі паралельно й відкривались 10 с (сам `leadTakeSeries` — 5 с, `dispatchedByLoadBucket` — 3 с).
 *
 * Правила, за якими це безпечно:
 *  • КЛЮЧ — УСІ АРГУМЕНТИ ВИКЛИКУ (`JSON.stringify(args)`), а не вибрані руками: забути `teamId` структурно неможливо
 *    (правило власника 25.08.2026 «у ключі мусить бути все, що змінює відповідь»);
 *  • зберігається ПРОМІС, тож одночасні картки чекають ОДИН запит, а не запускають свій;
 *  • відмова не кешується — наступна картка спробує знову, а не отримає чужу помилку на хвилину;
 *  • TTL короткий (`SERIES_MEMO_TTL_MS`): числа «станом на» можуть відставати не більше ніж на нього, а синк Kommo й так
 *    іде раз на 30 хв;
 *  • результат спільний — читачі його НЕ мутують (лише `.map`/`.filter`, які дають нові масиви).
 */
export const SERIES_MEMO_TTL_MS = 120_000;
const MAX_ENTRIES = 400;

type Entry = { at: number; v: Promise<unknown> };

export function memoize<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>,
  opts: { ttlMs?: number; now?: () => number; store?: Map<string, Entry> } = {}): (...args: A) => Promise<R> {
  const ttl = opts.ttlMs ?? SERIES_MEMO_TTL_MS, now = opts.now ?? Date.now, store = opts.store ?? STORE;
  return (...args: A) => {
    const k = `${name}|${JSON.stringify(args)}`, t = now(), hit = store.get(k);
    if (hit && t - hit.at < ttl) return hit.v as Promise<R>;
    if (store.size >= MAX_ENTRIES) for (const [key, e] of store) if (t - e.at >= ttl) store.delete(key);
    if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
    const v = fn(...args);
    store.set(k, { at: t, v });
    v.catch(() => { if (store.get(k)?.v === v) store.delete(k); });
    return v;
  };
}
const STORE = new Map<string, Entry>();
