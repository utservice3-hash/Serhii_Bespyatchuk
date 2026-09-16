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

export interface TaskLike { id: number; title: string; status: string; assigneeId?: number | null }

/**
 * Нова або ПЕРЕВІДКРИТА задача-сигнал, призначена саме мені.
 * Перевідкрита (`done` → не `done`) теж кличе: клієнт знову не додзвонився.
 * `known` — статуси з попереднього опитування; першого завантаження тут немає за побудовою
 * (його відсікає виклик), інакше кожне відкриття сторінки дзвеніло б усіма старими задачами.
 */
export function isSignalAlert(t: TaskLike, known: ReadonlyMap<number, string>, myManagerId: number | null | undefined): boolean {
  if (myManagerId == null || t.assigneeId !== myManagerId) return false;
  if (!t.title.startsWith(SIGNAL_TITLE_PREFIX) || t.status === "done") return false;
  const was = known.get(t.id);
  return was === undefined || was === "done";
}

/** Один тост на опитування: пачка з кількох задач — одним рядком, а не стіною звуків. */
export function signalAlertText(titles: string[]): string | null {
  if (titles.length === 0) return null;
  if (titles.length === 1) return `📵 Пропущений дзвінок без передзвону — ${titles[0].slice(SIGNAL_TITLE_PREFIX.length).replace(/^:\s*/, "")}. Задача в Задачнику.`;
  return `📵 ${String(titles.length)} пропущених дзвінків без передзвону — задачі в Задачнику.`;
}
