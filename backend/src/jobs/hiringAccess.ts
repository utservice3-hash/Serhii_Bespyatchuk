import { pool } from "../db/pool.js";
import type { Db } from "../core/hiring.js";
import { closeExpiredAccess } from "../core/hiringTraining.js";

/**
 * 🎓 НАЙМ, прохід 2a: закрити прострочений доступ кандидатів до навчання.
 * Правило строку — `core/hiringTrainingRules.ts` (48 год без входу; три київські дні від першого входу;
 * + продовження). Кожен кандидат — окрема транзакція: одна зламана картка не тримає решту відкритими.
 */
export async function closeExpiredCandidateAccess(): Promise<{ checked: number; closed: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await closeExpiredAccess(client as unknown as Db);
    await client.query("COMMIT");
    if (out.closed) console.log(`hiringAccess: закрито доступ ${out.closed} із ${out.checked}`);
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { client.release(); }
}
