/**
 * ⭐ «ОЦІНКА ПРОРАХУНКУ» ЛІДГЕНА (задача 7537, ТЗ Юлі 30.10.2026).
 *
 * Менеджер ставить оцінку 1–5 в СВОЇЙ угоді, що виросла з передачі лідгена (поле Kommo «Оцінка прорахунку»,
 * select, id 2100177). Дашборд показує по кожному лідгену: середню, скільки оцінено й не оцінено, і скільки з цих
 * самих передач уже поїхало (машина — «Дата загрузки» угоди менеджера, як на картці лідгена).
 *
 * Модуль ЧИСТИЙ (без БД): домен — ті самі рядки, що список «Гроші з передач» (`leadgenHandoffMoney().deals`),
 * тож блок оцінок не може рахувати інші передачі, ніж екран. Рахуються лише передачі ПЕРІОДУ (`inPeriod`):
 * рядок, що потрапив у відповідь грошима з давнішої передачі, — не прорахунок цього періоду.
 * Передача, що привела в угоду, вже пораховану іншою передачею (`same`), оцінку не двоїть.
 */
export const FIELD_QUOTE_RATING = 2100177;
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** Значення select-поля Kommo → оцінка; усе, що не ціле 1–5, — `null` (поле порожнє або чужий варіант). */
export function parseQuoteRating(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^[1-5]$/.test(s)) return null;
  return Number(s);
}

export interface RatingRow {
  lgId: number; dealId: number | null; inPeriod: boolean; cls: string;
  rating?: number | null; loadDay?: string | null;
}
export interface RatingStats {
  /** Передачі періоду з угодою менеджера — знаменник «оцінено / не оцінено». */
  deals: number;
  rated: number; unrated: number;
  /** Передачі періоду, де угоди менеджера не знайшлося: оцінити нема де. */
  noDeal: number;
  /** Середня з оцінених, 2 знаки; `null` — жодної оцінки (не нуль: нуль читався б як «оцінили на 0»). */
  avg: number | null;
  /** Скільки оцінок кожного бала: індекс 0 — «1», індекс 4 — «5». */
  dist: [number, number, number, number, number];
  /** З тих самих передач — угоди з «Датою загрузки» (машина), і частка від `deals`, %. */
  machines: number; machinesPct: number | null;
}

export function ratingStats(rows: readonly RatingRow[]): RatingStats {
  const seen = new Set<number>();
  const dist: RatingStats["dist"] = [0, 0, 0, 0, 0];
  let deals = 0, rated = 0, noDeal = 0, machines = 0, sum = 0;
  for (const r of rows) {
    if (!r.inPeriod || r.cls === "same") continue;
    if (r.dealId == null) { noDeal++; continue; }
    if (seen.has(r.dealId)) continue;
    seen.add(r.dealId);
    deals++;
    if (r.loadDay != null) machines++;
    const v = r.rating ?? null;
    if (v != null && v >= RATING_MIN && v <= RATING_MAX) { rated++; sum += v; dist[v - 1]++; }
  }
  return {
    deals, rated, unrated: deals - rated, noDeal,
    avg: rated > 0 ? Math.round((sum / rated) * 100) / 100 : null,
    dist, machines, machinesPct: deals > 0 ? Math.round((machines / deals) * 1000) / 10 : null,
  };
}

export interface RatingView { totals: RatingStats; byPerson: (RatingStats & { managerId: number })[] }

/** Відділ і кожен лідген — одним `ratingStats`; відділ рахується з усіх рядків, а не сумою людей (угода — раз). */
export function ratingView(rows: readonly RatingRow[]): RatingView {
  const by = new Map<number, RatingRow[]>();
  for (const r of rows) { const a = by.get(r.lgId); if (a) a.push(r); else by.set(r.lgId, [r]); }
  return {
    totals: ratingStats(rows),
    byPerson: [...by].map(([managerId, rs]) => ({ managerId, ...ratingStats(rs) })).sort((a, b) => a.managerId - b.managerId),
  };
}
