import { pool } from "../db/pool.js";
import { closeContactTasks } from "../core/prozorroTasks.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * ☎️ АВТОЗАКРИТТЯ ЗАДАЧ «ЗВʼЯЗАТИСЯ» ПО ТЕНДЕРНИХ УГОДАХ (задача 8731) — раз на 30 хв о :22/:52: не на :00/:30 із syncKommo,
 * не на хвилинах інших автозадач. Лише наша БД (дзвінки — з `ringostat_calls`, які привозить `syncCalls` о :35).
 * Правило — `core/prozorroAssign.callClosesTask`, запис — `core/prozorroTasks.closeContactTasks`.
 */
const guard = createRunGuard("prozorroTasks");

export async function prozorroTasks(): Promise<{ open: number; closed: number; manual: number } | GuardSkip> {
  return guard(async () => {
    const s = await closeContactTasks(pool, new Date());
    console.log(`prozorroTasks: відкритих ${String(s.open)} · закрито дзвінком ${String(s.closed)} · закрили руками ${String(s.manual)}`);
    return s;
  });
}
