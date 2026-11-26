/**
 * ⏱ ОДНА КОПІЯ СПИСКУ ПОСТІЙНИХ КЛІЄНТІВ НА ВКЛАДКУ БРАУЗЕРА (26.11.2026, питання Романа «чому так довго»).
 *
 * 📐 ЧОМУ. Вкладки «З ким говорити» і «Плани» показують ТОЙ САМИЙ список (`GET /dashboard/client-plans`, 1,9 МБ),
 * але кожна монтується окремо й тягнула його сама: кожне перемикання між ними коштувало ще одного повного
 * завантаження (5-7 с на проді 26.11.2026). Тепер список живе тут: друга вкладка бере його одразу.
 *
 * 🕐 СВІЖІСТЬ — 60 с від приходу відповіді, як і на сервері (`backend/src/core/scopeCache.ts`). Старіший список
 * перечитується. Дані в базі оновлює синк раз на 30 хв, тож хвилина нічого не ховає.
 *
 * 🔴 ПІСЛЯ ДІЇ КОРИСТУВАЧА СПИСОК ПЕРЕЧИТУЄТЬСЯ ЗАВЖДИ (`force`): поставив план, лишив коментар, створив задачу —
 * і бачить це одразу, а не через хвилину. І відповідь, що стартувала ДО дії, а прийшла ПІСЛЯ, у пам'ять не лягає:
 * кожне читання має номер, зберігається лише останнє за ключем.
 *
 * 🔑 У КЛЮЧІ — КОРИСТУВАЧ І МІСЯЦЬ. Вихід із дашборда — це перехід усередині тієї самої сторінки, пам'ять модуля
 * його переживає; без користувача в ключі наступна людина в цій вкладці побачила б чужий список (той самий
 * принцип, що `reportPlanCache.ts`).
 *
 * Модуль без імпортів — його читає бекенд-тест напряму. Годинник — параметр, щоб межу 60 с перевіряв гейт.
 */

/** Скільки список вважається свіжим після приходу відповіді. */
export const CLIENT_PLANS_FRESH_MS = 60_000;

/** Ключ = користувач + місяць. Охоплення (менеджер / команда) сервер виводить із користувача сам. */
export function clientPlansKey(p: { userId: number | null; month: string }): string {
  return JSON.stringify([p.userId, p.month]);
}

/** Запит, що щось пише: після його успіху пам'ять списку більше не чинна (GET / HEAD / OPTIONS — читання). */
export function isWriteMethod(method: string | undefined): boolean {
  const m = (method ?? "get").toLowerCase();
  return m !== "get" && m !== "head" && m !== "options";
}

/**
 * 🤖 Записи, які шле сама вкладка, без дії людини, і які списку не стосуються. «Я онлайн» (`Layout.tsx`, раз на
 * 30 с) пише лише час останньої активності користувача. Без цього винятку пам'ять списку жила б не довше 30 с і
 * зникала б одразу після відкриття сторінки (знайдено перевіркою в браузері 27.11.2026). Дзеркало серверного
 * `MACHINE_WRITE_PREFIXES` (`backend/src/core/scopeCache.ts`); шляхи тут — відносно `/api`, як їх кличе `api.ts`.
 */
export const MACHINE_WRITE_URLS: readonly string[] = ["/messages/heartbeat"];

/** Чи успішна відповідь на цей запит робить пам'ять списку нечинною: будь-який запис, крім названих машинних. */
export function clearsClientPlans(method: string | undefined, url: string | undefined): boolean {
  if (!isWriteMethod(method)) return false;
  const u = url ?? "";
  const q = u.indexOf("?");
  return !MACHINE_WRITE_URLS.includes(q < 0 ? u : u.slice(0, q));
}

interface Entry { value: unknown; at: number }

export class ClientPlansMemory {
  private store = new Map<string, Entry>();
  private inflight = new Map<string, { seq: number; p: Promise<unknown> }>();
  /** Номер останнього читання за ключем: відповідь старішого читання у пам'ять не лягає. */
  private latest = new Map<string, number>();
  private seq = 0;

  private freshMs: number;
  private clock: () => number;

  constructor(freshMs: number = CLIENT_PLANS_FRESH_MS, clock: () => number = () => Date.now()) {
    this.freshMs = freshMs;
    this.clock = clock;
  }

  /** Синхронно: свіжий список є — віддає його (екран малюється без «завантаження…»), інакше `undefined`. */
  peek(key: string): unknown {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (this.clock() - e.at < this.freshMs) return e.value;
    this.store.delete(key);
    return undefined;
  }

  /**
   * Список за ключем. Без `force`: свіжий запис → він; читання в польоті → те саме читання; інакше — нове.
   * З `force` (після дії користувача): завжди нове читання, і воно стає останнім за ключем.
   */
  load<T>(key: string, fetch: () => Promise<T>, force = false): Promise<T> {
    if (!force) {
      const hit = this.peek(key);
      if (hit !== undefined) return Promise.resolve(hit as T);
      const running = this.inflight.get(key);
      if (running) return running.p as Promise<T>;
    }
    const seq = ++this.seq;
    this.latest.set(key, seq);
    const p = fetch().then((v) => {
      if (this.latest.get(key) === seq) this.store.set(key, { value: v, at: this.clock() });
      return v;
    }).finally(() => { if (this.inflight.get(key)?.seq === seq) this.inflight.delete(key); });
    this.inflight.set(key, { seq, p });
    return p;
  }

  /** Забути все (наприклад, після виходу): наступне відкриття піде на сервер. */
  clear(): void {
    this.seq++;
    this.store.clear();
    this.inflight.clear();
    this.latest.clear();
  }
}

/** Одна пам'ять на вкладку браузера: спільна для «З ким говорити» і «Плани». */
export const clientPlansMemory = new ClientPlansMemory();
