/**
 * 🗄 ДЖОБА ЖИТТЄВОГО ЦИКЛУ ДОКУМЕНТІВ: звільнений → архів; повернувся → назад як «неактивний».
 * Правило — `core/docLifecycle.ts` (#444), стан людини — `stateOf` (`core/managerState.ts`).
 * Біжить кожні 30 хв незалежно від синку Kommo (пауза Kommo не має глушити архів) і на старті.
 * Ідемпотентна: другий прогін на тих самих даних нічого не змінює (#444c стереже наслідок).
 * Дії пишуться в `doc_events` без актора — це система, а не людина; у картці видно «звільнено».
 */
import { pool } from "../db/pool.js";
import { stateOf } from "../core/managerState.js";
import { lifecycleAction } from "../core/docLifecycle.js";

type Row = { file_id: number; section: "personal" | "offer"; archived_at: string | null; archived_reason: string | null; is_active: boolean; override: "finishing" | "dismissed" | null };

export async function runDocLifecycle(): Promise<{ archived: number; returned: number }> {
  const r = await pool.query<Row>(
    `SELECT f.id AS file_id, f.section, f.archived_at, f.archived_reason, u.is_active, mws.state AS override
       FROM doc_files f JOIN users u ON u.id = f.addressee_user_id
       LEFT JOIN manager_work_state mws ON mws.manager_id = u.manager_id
      WHERE f.section IN ('personal','offer')`);
  let archived = 0, returned = 0;
  for (const x of r.rows) {
    const state = stateOf({ crmActive: x.is_active, override: x.override });
    const action = lifecycleAction(state, { section: x.section, archivedAt: x.archived_at, archivedReason: x.archived_reason });
    if (action === "archive") {
      await pool.query(`UPDATE doc_files SET archived_at = now(), archived_reason = 'dismissed', archived_by = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NULL`, [x.file_id]);
      await pool.query(`INSERT INTO doc_events (file_id, kind, actor_id, details) VALUES ($1, 'archived', NULL, $2)`, [x.file_id, JSON.stringify({ reason: "dismissed", by: "docLifecycle" })]);
      archived++;
    } else if (action === "return") {
      await pool.query(`UPDATE doc_files SET archived_at = NULL, archived_reason = NULL, archived_by = NULL, inactive_at = now(), updated_at = now() WHERE id = $1 AND archived_reason = 'dismissed'`, [x.file_id]);
      await pool.query(`INSERT INTO doc_events (file_id, kind, actor_id, details) VALUES ($1, 'restored', NULL, $2)`, [x.file_id, JSON.stringify({ reason: "returned", inactive: true, by: "docLifecycle" })]);
      returned++;
    }
  }
  console.log(`docLifecycle: в архів ${archived}, повернуто неактивними ${returned}, перевірено ${r.rowCount}.`);
  return { archived, returned };
}
