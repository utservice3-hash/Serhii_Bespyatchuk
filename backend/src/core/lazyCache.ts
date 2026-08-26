/**
 * ⏱ ЛІНИВИЙ КЕШ ПЕРІОДОНЕЗАЛЕЖНИХ ВІДПОВІДЕЙ — ЧИСТИЙ МОДУЛЬ БЕЗ ІМПОРТІВ.
 *
 * Рішення власника 25.08.2026, варіант A (лінивий), обсяг V3′. Ставиться на
 * ІМЕНОВАНІ виклики в `/overview`, а НЕ на `pool.query`: загальний SQL-кеш був би
 * невидимим і зачепив би джоби й решту роутів — а дізнались би ми про це найгіршим
 * способом. Тут кешується рівно те, що перелічено в роуті поіменно.
 *
 * 📐 ЧОМУ ВЗАГАЛІ. Заміряно на проді 25.08.2026 (прод-обробник у процесі):
 * `/overview` робить 29 запитів, з них **14 не залежать від періоду** (Σ 1 781 мс,
 * ~62% часу БД). Під ×4 — тим самим способом, яким міряє `#36`, — роут давав
 * **5 839-5 925 мс** проти порога 5 000. Тобто перевищення ~850 мс, а не 14:
 * «14 мс» було числом із щільного `test:prod`, і піднімати поріг довелось би на 17%.
 *
 * ✅ ВИГРАШ ЗАМІРЯНО СИМУЛЯЦІЄЮ САМОГО КЕШУ, А НЕ ПОРАХОВАНО:
 * ×1 2 306 → 1 226 мс · ×4 5 839 → **2 598 мс**. Холодний кеш коштує **0**
 * (перший запит після інвалідації — 2 645 мс, тобто як без кешу), отже за промах
 * платити нема чим.
 *
 * 🔑 КЛЮЧ БУДУЄТЬСЯ З АРГУМЕНТІВ, А НЕ ПИШЕТЬСЯ РУКАМИ — і це головне рішення файлу.
 * Правило власника: «у ключі мусить бути все, що змінює відповідь; не „схоже, що
 * досить“, а перелічено й засаботажовано». Рука забуде `teamId` рівно один раз — і
 * тоді один тімлід побачить числа іншого. Тут забути неможливо СТРУКТУРНО: ті самі
 * аргументи їдуть і у функцію, і в ключ (`call(name, fn, ...args)`).
 *
 * 🔴 ЩО СЮДИ НЕ ПОТРАПИЛО І ЧОМУ — `metrics.buildProjection`. Її ТРИ запити
 * періодонезалежні (вони йдуть по ПОТОЧНОМУ місяцю, не по запитаному), але сама
 * функція приймає другим аргументом `planMonthTotal`, який залежить від `to` через
 * анкерний місяць. Тобто на рівні SQL вона стала, а на рівні ФУНКЦІЇ — ні, і
 * кешувати її означало б тримати виняток із інваріанта «набір ключів однаковий для
 * будь-яких двох періодів». Ціна відмови заміряна: ×4 2 421 проти 2 598 мс, тобто
 * 177 мс — у межах дриґання Neon. Інваріант вартий більше.
 *
 * ⏳ TTL 60 с — обґрунтовано числом, а не відчуттям: дані оновлюють `syncKommo` і
 * `syncStageEvents` РАЗ НА 30 ХВ, тож найгірша черствість кешу в 30 разів менша за
 * черствість самих даних. Кеш не може показати того, чого ще немає в БД.
 *
 * 🕐 ГОДИННИК — ПАРАМЕТР, А НЕ `Date.now()` УСЕРЕДИНІ. Інакше «протухання» можна
 * перевірити лише реальним очікуванням, тобто на практиці — ніяк, і гейт мовчки
 * став би перевіркою того, що значення взагалі повертається.
 */

/** Скільки живе запис. Спільне число для всіх викликів — окремі TTL розійшлись би. */
export const OVERVIEW_TTL_MS = 60_000;

interface Entry { at: number; value: unknown }

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  /** Вік найстарішого ЖИВОГО запису, секунди. `null` — кеш порожній. */
  oldestAgeSec: number | null;
}

/**
 * Стабільний рядок з аргументів. `JSON.stringify` масиву аргументів достатньо:
 * порядок аргументів фіксований сигнатурою, а обʼєкти-скоупи ми будуємо тут-таки
 * літералами з тим самим порядком полів. Функції/символи в аргументах не
 * передаються (перевіряє `#211e`).
 */
const argKey = (args: readonly unknown[]): string => JSON.stringify(args);

export class LazyCache {
  private store = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;

  constructor(private ttlMs: number = OVERVIEW_TTL_MS) {}

  /**
   * 🔑 ЄДИНИЙ ВХІД. Ключ = імʼя + УСІ аргументи; забути частину ключа неможливо,
   * бо ті самі `args` ідуть і у виклик.
   *
   * 🔴 SINGLE-FLIGHT ОБОВʼЯЗКОВИЙ, А НЕ «ПРИЄМНИЙ БОНУС». Без нього чотири
   * одночасні `/overview` на холодному кеші дають чотири однакові важкі запити —
   * тобто рівно той сплеск, від якого ми лікуємось, і саме в найгірший момент
   * (після рестарту). З ним промах коштує один запит на всіх.
   */
  call<A extends readonly unknown[], T>(
    name: string,
    fn: (...args: A) => Promise<T>,
    ...args: A
  ): Promise<T> {
    return this.memo(`${name}|${argKey(args)}`, () => fn(...args));
  }

  /** Нижній рівень — для гейтів і для випадків, де виклик не є окремою функцією. */
  memo<T>(key: string, produce: () => Promise<T>, now: number = Date.now()): Promise<T> {
    const hit = this.store.get(key);
    if (hit && now - hit.at < this.ttlMs) { this.hits++; return Promise.resolve(hit.value as T); }

    const flying = this.inflight.get(key);
    if (flying) { this.hits++; return flying as Promise<T>; }

    this.misses++;
    // Помилку НЕ кешуємо і слід по ній прибираємо: інакше одна невдача заморозила б
    // роут на цілий TTL, а виглядало б це як «повільно, потім раптом швидко».
    const p = produce().then(
      (v) => { this.store.set(key, { at: now, value: v }); this.inflight.delete(key); return v; },
      (e) => { this.inflight.delete(key); throw e; },
    );
    this.inflight.set(key, p as Promise<unknown>);
    return p;
  }

  /**
   * Стан кешу для `/api/health`. Механізм, що робить числа на екрані до хвилини
   * старішими, зобовʼязаний показувати себе сам — той самий принцип, що
   * `deployIntent` і `alertChannel`.
   */
  stats(now: number = Date.now()): CacheStats {
    let oldest: number | null = null;
    for (const e of this.store.values()) {
      if (now - e.at >= this.ttlMs) continue;
      if (oldest === null || e.at < oldest) oldest = e.at;
    }
    return {
      entries: [...this.store.values()].filter((e) => now - e.at < this.ttlMs).length,
      hits: this.hits,
      misses: this.misses,
      oldestAgeSec: oldest === null ? null : Math.round((now - oldest) / 1000),
    };
  }

  /** Для гейтів. У проді не кличеться — інвалідація тільки за TTL. */
  clear(): void { this.store.clear(); this.inflight.clear(); this.hits = 0; this.misses = 0; }

  /** Ключі, що зараз живі — `#211e` звіряє їх НАБІР між двома періодами. */
  liveKeys(now: number = Date.now()): string[] {
    return [...this.store.entries()].filter(([, e]) => now - e.at < this.ttlMs).map(([k]) => k).sort();
  }
}

/** Єдиний екземпляр для `/overview`. Гине з процесом — це памʼять, не сховище. */
export const overviewCache = new LazyCache();
