/**
 * ⏱ ПАМʼЯТЬ ВІДПОВІДЕЙ `/report-plan` У ВКЛАДЦІ — задача 10989, рішення Романа 26.11.2026.
 *
 * 📐 ЧОМУ. Заміряно на проді 26.11: один `/report-plan` коштує 2-4 с (навіть на один день),
 * а тімліди гортають тижні туди-назад. Повернення на тиждень, який щойно бачили, платило
 * ці секунди щоразу заново.
 *
 * 🔑 ПРАВИЛО ВЛАСНИКА, ДОСЛІВНО: «давай тримати навіть 80 секунд, і якщо повернулися знову
 * на неї і вийшли то таймер знову оновлюється на 80 секунд після останньої активності на
 * цій сторінці». Тобто таймер НЕ від завантаження, а від ОСТАННЬОГО ПЕРЕГЛЯДУ:
 *  - поки період на екрані, запис не старіє (`onScreen`);
 *  - пішов з нього — запис живе `REPORT_PLAN_KEEP_MS` від моменту виходу;
 *  - повернувся й знову пішов — відлік починається заново від другого виходу;
 *  - запис, якого ще ніхто не бачив (фонове довантаження), живе 80 с від приходу.
 *
 * 🔴 КЛЮЧ БУДУЄТЬСЯ З АРГУМЕНТІВ ЗАПИТУ, А НЕ ПИШЕТЬСЯ РУКАМИ (той самий принцип, що в
 * `backend/src/core/lazyCache.ts`). Забути в ключі команди = тімлід побачить числа іншої
 * команди; забути користувача = після виходу й входу іншої людини в тій самій вкладці
 * (вихід — це SPA-навігація, памʼять модуля переживає її) показати чужі числа.
 * Тримає `#10989e`.
 *
 * 🕐 ГОДИННИК — ПАРАМЕТР КОНСТРУКТОРА, А НЕ `Date.now()` У МЕТОДАХ: інакше межу 80 с можна перевірити
 * лише реальним очікуванням, тобто ніяк (`#10989f`).
 *
 * 🔁 SINGLE-FLIGHT: фонове довантаження попереднього тижня і клік «‹» на нього ж у ту
 * саму мить отримують ОДИН запит, а не два — інакше довантаження подвоїло б навантаження
 * саме тоді, коли людина чекає.
 *
 * Модуль без імпортів — його читає бекенд-тест напряму (як `reportScope.ts`).
 */

/** Скільки живе запис після того, як період зник з екрана. Рішення Романа 26.11.2026. */
export const REPORT_PLAN_KEEP_MS = 80_000;

export interface PlanKeyParts {
  userId: number | null;
  teamIds: readonly number[];
  from: string;
  to: string;
}

/** Ключ = користувач + набір команд (без порядку) + обидві дати. Нічого з цього не можна викинути. */
export function reportPlanKey(p: PlanKeyParts): string {
  return JSON.stringify([p.userId, [...p.teamIds].sort((a, b) => a - b), p.from, p.to]);
}

interface Entry { value: unknown; leftAt: number | null }

export class ReportPlanMemory {
  private store = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();
  private onScreen = new Set<string>();
  /** Покоління: відповідь запиту, що стартував ДО `clear()`, у памʼять уже не потрапляє. */
  private gen = 0;

  private keepMs: number;
  private clock: () => number;

  constructor(keepMs: number = REPORT_PLAN_KEEP_MS, clock: () => number = () => Date.now()) {
    this.keepMs = keepMs;
    this.clock = clock;
  }

  private alive(e: Entry, now: number): boolean {
    return e.leftAt === null || now - e.leftAt <= this.keepMs;
  }

  /** Синхронно: є живий запис — віддає його, інакше `undefined` (і прибирає протухлий). */
  peek(key: string): unknown {
    const now = this.clock();
    const e = this.store.get(key);
    if (!e) return undefined;
    if (this.alive(e, now)) return e.value;
    this.store.delete(key);
    return undefined;
  }

  /** Живий запис → він; запит у польоті → той самий проміс; інакше — новий запит. */
  load<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    const hit = this.peek(key);
    if (hit !== undefined) return Promise.resolve(hit as T);
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const gen = this.gen;
    const p = fetch().then((v) => {
      if (gen !== this.gen) return v;
      // Відповідь, яка вже на екрані, стає «закріпленою»; фонова живе KEEP від миті ПРИХОДУ.
      this.store.set(key, { value: v, leftAt: this.onScreen.has(key) ? null : this.clock() });
      return v;
    }).finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Що зараз на екрані. Ключі, які щойно зникли з екрана, починають відлік від `now`;
   * ключі на екрані таймера не мають. Порожній список = людина пішла зі Звіту.
   */
  setOnScreen(keys: readonly string[]): void {
    const now = this.clock();
    const next = new Set(keys);
    for (const k of this.onScreen) {
      if (!next.has(k)) { const e = this.store.get(k); if (e) e.leftAt = now; }
    }
    for (const k of next) { const e = this.store.get(k); if (e) e.leftAt = null; }
    this.onScreen = next;
    for (const [k, e] of this.store) if (!this.alive(e, now)) this.store.delete(k);
  }

  /** «Спробувати знову» і вихід: забути все, наступний запит піде на сервер. */
  clear(): void {
    this.gen++;
    this.store.clear();
    this.inflight.clear();
  }
}

/** Одна памʼять на вкладку: переживає перехід в інший розділ і назад (рішення Романа — «повернулися знову»). */
export const reportPlanMemory = new ReportPlanMemory();
