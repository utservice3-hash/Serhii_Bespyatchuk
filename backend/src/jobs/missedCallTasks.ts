import { pool } from "../db/pool.js";
import { applyMissedCallSignals, type SignalStats } from "../core/missedCallSignal.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * 📵 Задача менеджеру по пропущеному без передзвону за 5 хв (ТЗ-1, прохід 3).
 * Уся логіка — у `core/missedCallSignal.ts` (без `pool`, гейт `#457`); тут лише зʼєднання,
 * охоронець від накладання тіків і рядок у лог з обсягом.
 *
 * ⚠️ ОБСЯГ ЗАВЖДИ НАЗИВАЄТЬСЯ ЧИСЛОМ (правило зони джоб). Нуль груп уночі — норма;
 * нуль груп у робочий день годинами — привід дивитись, чи йде частий синк дзвінків.
 */
const guard = createRunGuard("missedCallTasks");

export async function missedCallTasks(): Promise<SignalStats | GuardSkip> {
  return guard(async () => {
    const client = await pool.connect();
    try {
      const s = await applyMissedCallSignals(client, new Date());
      console.log(`missedCallTasks: груп ${String(s.groups)}, створено ${String(s.created)}, `
        + `перевідкрито ${String(s.reopened)}, оновлено ${String(s.updated)}, закрито ${String(s.closed)}.`);
      return s;
    } finally {
      client.release();
    }
  });
}
