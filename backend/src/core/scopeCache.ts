/**
 * ⏱ ПАМ'ЯТЬ ГОТОВОЇ ВІДПОВІДІ ЕКРАНА — ЧИСТИЙ МОДУЛЬ БЕЗ ІМПОРТІВ (26.11.2026, список постійних клієнтів).
 *
 * 📐 ЧОМУ. `/client-plans` збирає відповідь 5-7 с на КОЖНЕ відкриття: три однакові запити поспіль дали 5,7 / 5,0 /
 * 4,8 с (замір прода 26.11.2026), а вкладки «З ким говорити» і «Плани» тягнуть його кожна окремо. Дані в базі
 * оновлює синк раз на 30 хв, тож відповідь, якій до 60 с, у 30 разів свіжіша за самі дані.
 *
 * 🔑 КЛЮЧ — З АРГУМЕНТІВ (`call(name, fn, ...args)`), як у `lazyCache.ts`, і з тієї самої причини: рука забуде
 * команду в ключі рівно один раз, і тоді один тімлід побачить клієнтів іншого. Тут забути неможливо структурно:
 * функція отримує ЛИШЕ ті аргументи, з яких зібрано ключ.
 *
 * 🔴 ЧИМ ВІДРІЗНЯЄТЬСЯ ВІД `LazyCache` І ЧОМУ НЕ ВІН. Тут пам'ятається відповідь, яку користувач щойно сам змінив
 * (поставив план, залишив коментар, створив задачу), і він мусить побачити свою зміну ОДРАЗУ. Тому є `invalidate()`,
 * і він має ПОКОЛІННЯ: читання, що стартувало ДО запису й завершилось ПІСЛЯ, несе старі дані — його результат
 * у пам'ять не кладеться. У `LazyCache.clear()` такої перевірки немає: політ, що пережив очищення, записав би
 * застаріле значення на повні 60 с.
 *
 * 🧮 СТЕЛЯ ЗАПИСІВ. Найбільша відповідь — 1,9 МБ у JSON (674 клієнти), охоплень за хвилину одиниці. Стеля записів
 * стоїть на випадок, якщо хтось перебере місяці й менеджерів підряд: найстаріший запис іде геть.
 *
 * 🕐 ГОДИННИК — ПАРАМЕТР, як у `lazyCache.ts`: «протухання» перевіряється гейтом, а не очікуванням.
 */

export const SCOPE_TTL_MS = 60_000;
export const SCOPE_MAX_ENTRIES = 24;

interface Entry { at: number; value: unknown }

export interface ScopeCacheStats { entries: number; hits: number; misses: number; invalidations: number }

export class ScopeCache {
  private store = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();
  private epoch = 0;
  private hits = 0;
  private misses = 0;

  constructor(private ttlMs: number = SCOPE_TTL_MS, private maxEntries: number = SCOPE_MAX_ENTRIES) {}

  /** Ключ = назва + ті самі аргументи, що їдуть у функцію. */
  call<A extends readonly unknown[], T>(name: string, fn: (...args: A) => Promise<T>, ...args: A): Promise<T> {
    return this.memo(`${name}|${JSON.stringify(args)}`, () => fn(...args));
  }

  memo<T>(key: string, produce: () => Promise<T>, now: number = Date.now()): Promise<T> {
    const hit = this.store.get(key);
    if (hit && now - hit.at < this.ttlMs) { this.hits++; return Promise.resolve(hit.value as T); }

    // Двоє одночасних із тим самим ключем — одне обчислення (це і є «×4»: четверо відкрили екран разом).
    const flying = this.inflight.get(key);
    if (flying) { this.hits++; return flying as Promise<T>; }

    this.misses++;
    const born = this.epoch;
    const p = produce().then(
      (v) => {
        // Запис стався, поки ми читали: віддаємо тому, хто чекав, але в пам'ять НЕ кладемо.
        if (born === this.epoch) {
          this.inflight.delete(key);
          this.put(key, { at: now, value: v }, now);
        }
        return v;
      },
      (e) => { if (born === this.epoch) this.inflight.delete(key); throw e; },
    );
    this.inflight.set(key, p as Promise<unknown>);
    return p;
  }

  private put(key: string, e: Entry, now: number): void {
    for (const [k, old] of this.store) if (now - old.at >= this.ttlMs) this.store.delete(k);
    this.store.delete(key);
    this.store.set(key, e);
    // Map тримає порядок вставки: перший ключ — найстаріший.
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Запис у базу: усе, що пам'ятали й що ще летить, більше не чинне. */
  invalidate(): void { this.epoch++; this.store.clear(); this.inflight.clear(); }

  stats(now: number = Date.now()): ScopeCacheStats {
    return {
      entries: [...this.store.values()].filter((e) => now - e.at < this.ttlMs).length,
      hits: this.hits, misses: this.misses, invalidations: this.epoch,
    };
  }

  /** Живі ключі — для гейта «різні охоплення мають різні ключі». */
  liveKeys(now: number = Date.now()): string[] {
    return [...this.store.entries()].filter(([, e]) => now - e.at < this.ttlMs).map(([k]) => k).sort();
  }
}

/** Пам'ять списку постійних клієнтів (`GET /dashboard/client-plans`). */
export const clientPlansCache = new ScopeCache();

/** Методи, які нічого не пишуть: після них пам'ять лишається чинною. */
export const READ_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];

/**
 * 🤖 ЗАПИСИ МАШИН, ЯКІ СПИСКУ КЛІЄНТІВ НЕ СТОСУЮТЬСЯ. Їх шле не людина, а програма, раз на кілька десятків секунд:
 *  · `POST /api/tracker/…` — трекер часу з кожного робочого комп'ютера; пише лише у свої таблиці (`tracker_devices`,
 *    `tracker_intervals`), гейт `#11240f`;
 *  · `POST /api/messages/heartbeat` — «я онлайн» з КОЖНОЇ відкритої вкладки дашборда раз на 30 с (`Layout.tsx`);
 *    пише лише `users.last_seen`, якого список не читає, гейт `#11240i`. Знайдено перевіркою в браузері 27.11.2026:
 *    без цього винятку при трьох десятках людей онлайн пам'ять скидалась би щосекунди й не давала нічого.
 * 🔴 Сюди — ЛИШЕ запис, про який гейтом доведено, що список його не бачить.
 * Запис, що закінчується скісною рискою, — префікс (`/api/tracker/` не накриває сусіда `/api/tracker-report`);
 * без неї — рівно цей шлях (`/api/messages/heartbeat` не накриває решту месенджера).
 */
export const MACHINE_WRITE_PREFIXES: readonly string[] = ["/api/tracker/", "/api/messages/heartbeat"];

/** Чи запит — один із названих машинних записів. Рядок запиту (`?…`) до шляху не належить. */
export function isMachineWrite(url: string, list: readonly string[] = MACHINE_WRITE_PREFIXES): boolean {
  const q = url.indexOf("?");
  const pathOnly = q < 0 ? url : url.slice(0, q);
  return list.some((p) => (p.endsWith("/") ? pathOnly.startsWith(p) : pathOnly === p));
}

interface ReqLike { method: string; originalUrl?: string }
interface ResLike { statusCode: number; on: (event: "finish", cb: () => void) => unknown }

/**
 * 🧹 УСПІШНИЙ ЗАПИС ЧЕРЕЗ API СКИДАЄ ПАМ'ЯТЬ — мідлвар для `index.ts`, ставиться ПЕРЕД роутерами.
 *
 * Чому «будь-який, крім названих машинних», а не перелік роутів, що впливають: на рядок списку впливають плани,
 * коментарі, задачі, наступні кроки, контакти, анкета, позначка проблемного, архів, передача відповідального — це
 * різні роутери, і новий запис додадуть, не згадавши про цей список. Перелік «хто впливає» збрехав би мовчки
 * (користувач не побачив би власної зміни); зайве скидання коштує одного повільного відкриття. Скидаємо на
 * `finish`: відповідь на запис уже пішла, тож наступне читання того самого користувача гарантовано рахується
 * заново. Невдалий запис (4xx/5xx) нічого не змінив — пам'ять лишається.
 */
export function invalidateOnWrite(cache: Pick<ScopeCache, "invalidate">, skipPrefixes: readonly string[] = MACHINE_WRITE_PREFIXES) {
  return (req: ReqLike, res: ResLike, next: () => void): void => {
    if (!READ_METHODS.includes(req.method) && !isMachineWrite(req.originalUrl ?? "", skipPrefixes)) {
      res.on("finish", () => { if (res.statusCode < 400) cache.invalidate(); });
    }
    next();
  };
}
