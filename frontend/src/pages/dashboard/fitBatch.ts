/**
 * 📏 ВИСОТА ПОЛІВ У ТАБЛИЦІ ЗАДАЧ — ОДНИМ ПРОХОДОМ НА ВСЮ ТАБЛИЦЮ (задача 9227, 18.11.2026).
 *
 * Поле назви й коментаря в старій таблиці задачника росте під свій текст. Доти кожне поле
 * міряло себе саме: «висота auto → прочитати scrollHeight → виставити». Читання після запису
 * змушує браузер перерахувати розмітку ВСІЄЇ таблиці, тож 600 рядків (1 200 полів) давали
 * 1 200 повних перерахунків. Заміряно: тімлід, «Командні задачі», 600 задач - 11,6 с;
 * на процесорі вчетверо слабшому - 67 с, Chrome пише «Сторінка не відповідає». Так виглядала
 * «помилка при переході на задачі команди» у Лілі (9227).
 *
 * Тут ті самі три кроки, але для всіх полів разом: спершу ВСІМ «auto», потім ВСІ читання,
 * потім ВСІ записи. Перерахунок один, вигляд той самий. Порядок тримає гейт `#9227`.
 */
export interface FitTarget {
  style: { height: string };
  readonly scrollHeight: number;
}

/** Підігнати висоту всіх полів: усі записи «auto» → усі читання → усі записи висоти. */
export function fitHeights(els: readonly FitTarget[]): void {
  for (const el of els) el.style.height = "auto";
  const heights = els.map((el) => el.scrollHeight);
  els.forEach((el, i) => { el.style.height = `${heights[i]}px`; });
}

export interface FitBatch {
  /** Поле просить підігнати висоту; сама підгонка - в `flush`, разом з іншими. */
  mark: (el: FitTarget) => void;
  /** Підігнати всіх, хто попросив. Порожній список - нічого не робить. */
  flush: () => void;
}

/**
 * Черга полів однієї таблиці. `flush` кличе таблиця одразу після свого рендеру (усі поля
 * вже позначились), а `schedule` - страховка на випадок, коли поле перемалювалось без таблиці:
 * тоді його піджене наступний кадр, а не ніхто.
 */
export function createFitBatch(schedule: (cb: () => void) => void): FitBatch {
  const pending = new Set<FitTarget>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (pending.size === 0) return;
    const els = [...pending];
    pending.clear();
    fitHeights(els);
  };
  return {
    mark: (el) => {
      pending.add(el);
      if (!scheduled) { scheduled = true; schedule(flush); }
    },
    flush,
  };
}
