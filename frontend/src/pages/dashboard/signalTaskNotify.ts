/**
 * 🔔 СПОВІЩЕННЯ ПРО ЗАДАЧУ-СИГНАЛ «ПРОПУЩЕНИЙ БЕЗ ПЕРЕДЗВОНУ» (ТЗ-1 §1.5, канал (a)).
 *
 * ТЗ описує канал (a) як «тост + звук + браузерна нотифікація», і власник обрав саме його —
 * задачею менеджеру. Але сповіщення в продукті спрацьовувало лише на ЗМІНУ статусу вже
 * відомої задачі (`in_progress`/`done`), тож нова задача-сигнал приходила мовчки: менеджер
 * бачив її, лише відкривши Задачник. Для порога «5 хвилин» це не сигнал. Спіймано звіркою
 * 16.09.2026.
 *
 * ⚠️ ПРЕФІКС МУСИТЬ ДОРІВНЮВАТИ БЕКЕНДУ (`core/missedCallSignal.ts`, `SIGNAL_TITLE_PREFIX`).
 * Розійдуться — сповіщення замовкне тихо. Тримає `#462`.
 */
export const SIGNAL_TITLE_PREFIX = "📵 Передзвонити клієнту";

/** Початок причини автозакриття — мусить дорівнювати `autoCloseReason` бекенду (тримає `#462`). */
export const AUTO_CLOSE_PREFIX = "Закрито автоматично:";

export interface TaskLike {
  id: number; title: string; status: string; assigneeId?: number | null;
  closeReason?: string | null; createdAt?: string | null;
}
/** Що памʼятаємо про задачу з попереднього опитування. */
export interface KnownTask { status: string; closeReason: string | null }
export const knownOf = (t: TaskLike): KnownTask => ({ status: t.status, closeReason: t.closeReason ?? null });

/** Допуск на розбіжність годинників браузера й сервера, коли порівнюємо час створення з моментом відкриття. */
export const SIGNAL_CLOCK_SKEW_MS = 120_000;

/**
 * Нова або ПЕРЕВІДКРИТА ДЖОБОЮ задача-сигнал, призначена саме мені.
 *
 * · `known === null` — першого опитування ще не було (вкладка могла бути у фоні, і опитування
 *   пропускались). Тоді дзвонимо лише задачами, СТВОРЕНИМИ після відкриття сторінки: старі
 *   задачі на кожному відкритті — шум, а свіжі мовчки ковтати не можна (рецензія 17.09.2026).
 * · Перевідкрита дзвонить, лише якщо її перевідкрила ДЖОБА: вона знімає причину автозакриття.
 *   Менеджер, що сам повернув задачу в роботу, причини не знімає — і тосту «пропущений» не
 *   отримує (рецензія 17.09.2026). Закриту менеджером задачу джоба перевідкриває без тосту —
 *   свідома межа: відрізнити ці два випадки з видачі списку нема чим.
 */
export function isSignalAlert(t: TaskLike, known: ReadonlyMap<number, KnownTask> | null, myManagerId: number | null | undefined, mountedAtMs: number): boolean {
  if (myManagerId == null || t.assigneeId !== myManagerId) return false;
  if (!t.title.startsWith(SIGNAL_TITLE_PREFIX) || t.status === "done") return false;
  if (known === null) {
    const created = t.createdAt ? Date.parse(t.createdAt) : NaN;
    return Number.isFinite(created) && created >= mountedAtMs - SIGNAL_CLOCK_SKEW_MS;
  }
  const was = known.get(t.id);
  if (was === undefined) return true;
  return was.status === "done"
    && (was.closeReason ?? "").startsWith(AUTO_CLOSE_PREFIX)
    && !(t.closeReason ?? "").startsWith(AUTO_CLOSE_PREFIX);
}

/** Один тост на опитування: пачка з кількох задач — одним рядком, а не стіною звуків. */
export function signalAlertText(titles: string[]): string | null {
  if (titles.length === 0) return null;
  if (titles.length === 1) return `📵 Пропущений дзвінок без передзвону — ${titles[0].slice(SIGNAL_TITLE_PREFIX.length).replace(/^:\s*/, "")}. Задача в Задачнику.`;
  return `📵 ${String(titles.length)} пропущених дзвінків без передзвону — задачі в Задачнику.`;
}
