import { guardDecision, MAX_RUN_MS } from "./syncGuardRule.js";

/**
 * 🛡 ОХОРОНЕЦЬ ВІД НАКЛАДАННЯ — ЧИСТИЙ, БЕЗ `pool`.
 *
 * Навіщо тепер: синк дзвінків стає двократним — годинний повний прохід і пʼятихвилинний
 * свіжий (сигнал менеджеру, ТЗ-1). Обидва пишуть `ringostat_calls` і звʼязують рядки
 * масовими UPDATE. Два одночасні проходи на цій таблиці — рівно та конкуренція за рядки,
 * на якій уже ловили дедлок (`.claude/rules/jobs-sync.md`).
 *
 * Рішення «біжить / пропуск / перехоплення» НЕ переписано, а взято з `guardDecision` —
 * його стелю вже стереже `#68`. Тут лише обгортка стану.
 *
 * 🔴 ПРОПУСК — НЕ УСПІХ. Повертаємо `{ skipped: true }`, і `runJob` пише пропуск, не рухаючи
 * успіх: інакше джоба, що «щопʼять хвилин успішно нічого не робить», виглядала б здоровою.
 */
export interface GuardSkip { skipped: true; reason: string }

export function createRunGuard(label: string, maxMs = MAX_RUN_MS, clock: () => number = Date.now) {
  let running = false;
  let since = 0;
  return async function run<T>(fn: () => Promise<T>): Promise<T | GuardSkip> {
    const now = clock();
    const decision = guardDecision(running, since, now, maxMs);
    if (decision === "skip") {
      return { skipped: true, reason: `${label}: попередній прохід ще біжить (${String(Math.round((now - since) / 1000))} с)` };
    }
    if (decision === "seize") {
      console.error(`${label}: попередній прохід висить ${String(Math.round((now - since) / 60000))} хв — вважаю мертвим і перехоплюю. Це АВАРІЯ, а не норма.`);
    }
    const mine = now;
    running = true;
    since = mine;
    try {
      return await fn();
    } finally {
      // 🔴 Скидаємо ЛИШЕ свій прапорець. Перехоплений завислий прохід, який таки
      // завершиться пізніше, не має права оголосити «вільно», поки біжить новий.
      if (since === mine) running = false;
    }
  };
}
