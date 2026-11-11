/**
 * 🧭 «НІЧИЙНІ» → ПУЛ ЛІДГЕНІВ (задача 8135; Роман 11.11.2026). Щогодини, за Києвом о :10.
 *
 * По кожному клієнту, якого менеджер віддав у «Нічийні» (`loyalty_overrides.released_at`), — одна відповідь
 * чистого правила `releaseAction`:
 *   · `revived`    — після передачі зʼявився рахунок: з клієнтом працюють — позначку знято, лишається за менеджером;
 *   · `to_leadgen` — минув робочий день і ніхто не взяв: рядок пулу `orphan` + позначку знято (в одній транзакції);
 *   · `wait`       — ще в строку.
 * В обох перших випадках сповіщення «візьміть» закривається. Kommo не чіпаємо.
 *
 * Порожній прогін (нікого не віддавали) — штатний нуль, і лог каже це словами з розміром простору: «у нічийних 0».
 */
import { pool } from "../db/pool.js";
import { lastInvoiceByClientKey } from "../core/money.js";
import { kyivToday } from "../core/dates.js";
import { releasedRows, releaseAction, clearRelease, closeReleaseNotices, moveToLeadgen } from "../core/orphanRelease.js";

export async function runOrphanToLeadgen(now = new Date()): Promise<{ released: number; moved: number; revived: number; waiting: number }> {
  const rows = await releasedRows(pool);
  const inv = await lastInvoiceByClientKey(rows.map((r) => r.clientKey));
  const nowIso = now.toISOString();
  const monthYm = kyivToday().slice(0, 7);
  let moved = 0, revived = 0, waiting = 0;
  for (const r of rows) {
    const act = releaseAction({ releasedAt: r.releasedAt, releasedDay: r.releasedDay, lastInvoice: inv.get(r.clientKey) ?? null }, nowIso);
    if (act === "wait") { waiting++; continue; }
    if (act === "revived") {
      if (await clearRelease(pool, r.clientKey)) revived++;
      await closeReleaseNotices(pool, r.clientKey);
      continue;
    }
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await moveToLeadgen(c, { clientKey: r.clientKey, fromManagerId: r.fromManagerId, monthYm });
      await c.query("COMMIT");
      moved++;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    await closeReleaseNotices(pool, r.clientKey);
  }
  console.log(`orphanToLeadgen: у нічийних від менеджерів ${rows.length} → лідгенам ${moved}, ожили ${revived}, чекають ${waiting}`);
  return { released: rows.length, moved, revived, waiting };
}
