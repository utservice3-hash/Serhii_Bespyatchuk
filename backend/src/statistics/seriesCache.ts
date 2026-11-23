/**
 * ⚡ ПАМʼЯТЬ ГОТОВИХ РЯДІВ «СТАТИСТИК» — ЧИСТИЙ МОДУЛЬ БЕЗ ІМПОРТІВ (ціль Романа 21.11.2026: «час завантаження
 * будь-якого графіка — менше 3 секунд»).
 *
 * ЩО РОБИТЬ. Ряд (точки одного показника для одного розрізу, кроку й періоду) рахується раз і лежить тут; екран
 * отримує його одразу, а перерахунок іде у фоні. Три стани запису за віком:
 *   • молодший за `SERIES_FRESH_MS` — віддається як є;
 *   • між `SERIES_FRESH_MS` і `SERIES_STALE_MS` — віддається ОДРАЗУ, а новий рахується у фоні (наступний запит уже свіжий);
 *   • старший за `SERIES_STALE_MS` або відсутній — запит чекає розрахунку: число такого віку за свіже не видається.
 * Стандартний набір (усі показники стіни, місяць і тиждень, картка й розгорнутий графік) фоново перераховує
 * `warmStatsSeries` — тож у робочий час запис майже завжди з першої групи.
 *
 * ПРАВИЛА, ЗА ЯКИМИ ЦЕ ЧЕСНО:
 *  • КЛЮЧ — УСІ АРГУМЕНТИ РОЗРАХУНКУ (`call(fn, ...args)`): ті самі аргументи їдуть і у функцію, і в ключ, тож забути
 *    розріз чи період структурно неможливо (правило власника 25.08.2026 «у ключі мусить бути все, що змінює відповідь»);
 *  • кожен запис несе МИТЬ, коли його розрахунок ПОЧАВСЯ, — екран показує її («станом на 12:40»), а не вдає, що число живе;
 *  • невдалий перерахунок НЕ СТИРАЄ добре число: воно віддається, доки не постаріє до `SERIES_STALE_MS`, а помилка
 *    рахується й видна в `/api/health`;
 *  • одночасні запити того самого ряду чекають ОДИН розрахунок;
 *  • годинник — параметр: протухання перевіряється гейтом, а не очікуванням.
 *
 * ⏳ ЧОМУ 12 і 30 ХВ. Дані в базі оновлюють синки раз на 10–30 хв (`syncKommo`, події етапів — 30 хв, дзвінки — 10 хв),
 * тож ряд віком до 12 хв відстає від бази менше, ніж база від CRM. Фоновий перерахунок іде раз на 10 хв — 12 хв дають
 * йому запас на власну тривалість. 30 хв — межа, за якою число вже пережило цілий синк, і видавати його без розрахунку не можна.
 * Обидва числа — частина обіцянки екрану («станом на»), а не технічна дрібниця: міняти лише разом із підписом.
 */
export const SERIES_FRESH_MS = 12 * 60_000;
export const SERIES_STALE_MS = 30 * 60_000;
const MAX_ENTRIES = 4000;

export interface Cached<V> { value: V; at: number }

export interface SeriesCacheStats {
  entries: number;
  /** Скільки записів зараз свіжі / ще придатні (віддаються одразу, з фоновим перерахунком). */
  fresh: number; servable: number;
  hits: number; staleServed: number; misses: number; refreshFailed: number;
  /** Вік найстарішого запису, який ще віддається, секунди. `null` — памʼять порожня. */
  oldestAgeSec: number | null;
}

export class SeriesCache<V> {
  private store = new Map<string, Cached<V>>();
  private flying = new Map<string, Promise<Cached<V>>>();
  private hits = 0;
  private staleServed = 0;
  private misses = 0;
  private refreshFailed = 0;

  constructor(private freshMs: number = SERIES_FRESH_MS, private staleMs: number = SERIES_STALE_MS, private now: () => number = Date.now) {}

  /** 🔑 Читання. Ключ = УСІ аргументи: ті самі `args` ідуть і у виклик. */
  call<A extends readonly unknown[]>(fn: (...args: A) => Promise<V>, ...args: A): Promise<Cached<V>> {
    const key = JSON.stringify(args), hit = this.store.get(key);
    if (hit) {
      const age = this.now() - hit.at;
      if (age < this.freshMs) { this.hits++; return Promise.resolve(hit); }
      if (age < this.staleMs) {
        // Віддаємо, що є, і рахуємо нове у фоні. Невдача фону — не біда запиту: число лишається, помилка порахована.
        this.staleServed++;
        this.recompute(fn, ...args).catch(() => undefined);
        return Promise.resolve(hit);
      }
    }
    this.misses++;
    return this.recompute(fn, ...args);
  }

  /** 🔄 Примусовий перерахунок (фоновий прогрів). Одночасні — один розрахунок; невдача старого запису не чіпає. */
  recompute<A extends readonly unknown[]>(fn: (...args: A) => Promise<V>, ...args: A): Promise<Cached<V>> {
    const key = JSON.stringify(args), flying = this.flying.get(key);
    if (flying) return flying;
    const at = this.now(); // мить ПОЧАТКУ: число не може бути свіжішим за дані, з яких його почали рахувати
    const p = Promise.resolve().then(() => fn(...args)).then(
      (value) => { const e = { value, at }; this.put(key, e); this.flying.delete(key); return e; },
      (err) => { this.flying.delete(key); this.refreshFailed++; throw err; },
    );
    this.flying.set(key, p);
    return p;
  }

  private put(key: string, e: Cached<V>): void {
    this.store.delete(key); // новий запис — у кінець черги витіснення
    this.store.set(key, e);
    if (this.store.size <= MAX_ENTRIES) return;
    const t = this.now();
    for (const [k, v] of this.store) if (t - v.at >= this.staleMs) this.store.delete(k);
    while (this.store.size > MAX_ENTRIES) this.store.delete(this.store.keys().next().value as string);
  }

  /** Стан для `/api/health`: механізм, що робить числа на екрані старішими за базу, зобовʼязаний показувати себе сам. */
  stats(): SeriesCacheStats {
    const t = this.now();
    let fresh = 0, servable = 0, oldest: number | null = null;
    for (const e of this.store.values()) {
      const age = t - e.at;
      if (age >= this.staleMs) continue;
      servable++;
      if (age < this.freshMs) fresh++;
      if (oldest === null || e.at < oldest) oldest = e.at;
    }
    return { entries: this.store.size, fresh, servable, hits: this.hits, staleServed: this.staleServed, misses: this.misses,
      refreshFailed: this.refreshFailed, oldestAgeSec: oldest === null ? null : Math.round((t - oldest) / 1000) };
  }

  /** Для гейтів. У проді не кличеться. */
  clear(): void { this.store.clear(); this.flying.clear(); this.hits = this.staleServed = this.misses = this.refreshFailed = 0; }
}
