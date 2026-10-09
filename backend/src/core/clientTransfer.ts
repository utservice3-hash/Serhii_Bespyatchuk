import { transferTaskRow, type TransferKind, type TransferTask } from "./transferTask.js";

/** Мінімум від клієнта БД: одне зʼєднання (транзакція живе в ньому), а не пул. */
export interface TxClient { query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }> }

/**
 * 👤 ПЕРЕДАЧА КЛІЄНТА — ОДНА ТРАНЗАКЦІЯ: закріплення (`loyalty_overrides`), історія (`client_manager_history`) і,
 * якщо є, задача новому менеджеру (`tasks`). Разом або нічого (08.10.2026): впала вставка задачі — клієнт НЕ
 * переїжджає, бо інакше новий менеджер отримав би клієнта без жодної дії, рівно те, від чого задача захищає.
 *
 * Права й перевірки тіла — у роуті ДО цього виклику (`/client-manager`: роль першою, далі `transferTaskVerdict`,
 * `assignAllowed`). Тут — лише запис. Окремо від роуту, щоб транзакцію можна було довести на порожній базі (`#1499b`).
 */
export async function applyClientTransfer(db: TxClient, a: {
  clientKey: string; toManagerId: number; reason: string; kind: TransferKind; effectiveFrom: string;
  userId: number; task: TransferTask | null;
}): Promise<{ from: number | null; taskId: number | null }> {
  await db.query("BEGIN");
  try {
    const cur = await db.query<{ pinned_manager_id: number | null }>(
      `SELECT pinned_manager_id FROM loyalty_overrides WHERE client_key = $1 FOR UPDATE`, [a.clientKey]);
    const from = cur.rows[0]?.pinned_manager_id ?? null;
    await db.query(
      `INSERT INTO loyalty_overrides (client_key, pinned_manager_id, pinned_from_month, updated_by, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (client_key) DO UPDATE SET pinned_manager_id = EXCLUDED.pinned_manager_id,
         pinned_from_month = EXCLUDED.pinned_from_month, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [a.clientKey, a.toManagerId, a.effectiveFrom, a.userId]);
    await db.query(
      `INSERT INTO client_manager_history (client_key, from_manager_id, to_manager_id, effective_from, reason, changed_by, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [a.clientKey, from, a.toManagerId, a.effectiveFrom, a.reason, a.userId, a.kind]);
    let taskId: number | null = null;
    if (a.task) {
      const nm = await db.query<{ client_name: string | null; dept: string | null }>(
        `SELECT (SELECT d.client_name FROM deals d WHERE d.client_key = $1 AND d.client_name IS NOT NULL
                  ORDER BY d.created_at_kommo DESC NULLS LAST LIMIT 1) AS client_name,
                (SELECT t.name FROM managers m LEFT JOIN teams t ON t.id = m.team_id WHERE m.id = $2) AS dept`,
        [a.clientKey, a.toManagerId]);
      const row = transferTaskRow({ task: a.task, clientName: nm.rows[0]?.client_name ?? a.clientKey, reason: a.reason, kind: a.kind });
      // Автор і «Приймає» — той, хто передав; виконавець — новий менеджер; задача привʼязана до клієнта.
      const ins = await db.query<{ id: number }>(
        `INSERT INTO tasks (title, status, deadline, assignee_id, priority, comments, department, created_by, reviewer_id, client_key)
         VALUES ($1, 'not_started', $2, $3, $4, $5, $6, $7, $7, $8) RETURNING id`,
        [row.title, row.deadline, a.toManagerId, row.priority, row.comments, nm.rows[0]?.dept ?? null, a.userId, a.clientKey]);
      taskId = ins.rows[0].id;
    }
    await db.query("COMMIT");
    return { from, taskId };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
