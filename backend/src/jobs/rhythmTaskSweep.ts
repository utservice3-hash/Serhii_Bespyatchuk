/**
 * ⏱ РАНКОВИЙ ПРОХІД «ПРОПУСТИЛИ РИТМ, РОБОТИ НЕМАЄ» (задача 11229, рішення Романа 27.11.2026).
 *
 * Раз на добу вранці (і на старті): тімлід отримує ОДНУ задачу на менеджера, клієнти в ній — рядками. Прохід
 *  1. закриває рядки, де причина зникла (з клієнтом попрацювали, клієнт замовив, перейшов у «Реактивацію» тощо) —
 *     кожен із власною причиною;
 *  2. додає нових клієнтів рядками у відкриту задачу менеджера або ставить нову;
 *  3. закриває задачу, коли в ній не лишилось відкритих рядків.
 *
 * Хто підпадає й кому ставити — чисте правило `core/rhythmTaskRules.ts`. Рядки клієнтів приходять аргументом: бойовий
 * виклик (`index.ts`) передає збирач екрана «З ким говорити», тож задача й екран рахують одним кодом.
 *
 * Ідемпотентно: читання наявних задач і запис ідуть однією транзакцією під замком, тож два прогони поспіль (старт
 * сервера і розклад) дублів не дають. Telegram не чіпає; задачі реактивації й KPI не читає і не пише.
 */
import type { Db } from "../core/adCallFacts.js";
import {
  planRhythmTasks, RHYTHM_CLIENT_TYPE, RHYTHM_PACK_TYPE, RHYTHM_TASK_DAYS, packTitle,
  type ExistingRow, type OpenPack, type RhythmFacts, type RhythmPlan, type RhythmRow, type RhythmTargets,
} from "../core/rhythmTaskRules.js";

/** Замок транзакції: два прогони одночасно не читають «задачі немає» разом. Число — номер задачі. */
const SWEEP_LOCK = 11229;

export interface RhythmSweepResult {
  packsCreated: number; rowsAdded: number; rowsClosed: number; packsClosed: number;
  stats: RhythmPlan["stats"];
}

/** Тімліди команд, власні акаунти менеджерів і керівник відділу продажу — ті самі вирази, що в задачах перевізників. */
export async function loadRhythmTargets(db: Db): Promise<RhythmTargets> {
  const leads = await db.query<{ team_id: number; user_id: number }>(`
    SELECT DISTINCT ON (u.team_id) u.team_id, u.id AS user_id FROM users u
     WHERE COALESCE(u.role_override, u.role) = 'team_lead' AND u.team_id IS NOT NULL AND u.is_active
     ORDER BY u.team_id, u.id`);
  const own = await db.query<{ manager_id: number; user_id: number }>(`
    SELECT DISTINCT ON (u.manager_id) u.manager_id, u.id AS user_id FROM users u
     WHERE u.manager_id IS NOT NULL AND u.is_active ORDER BY u.manager_id, u.id`);
  const head = await db.query<{ id: number }>(
    "SELECT id FROM users WHERE is_active AND COALESCE(role_override, role) = 'kvp' ORDER BY id LIMIT 1");
  return {
    leadByTeam: new Map(leads.rows.map((r) => [r.team_id, r.user_id])),
    userByManager: new Map(own.rows.map((r) => [r.manager_id, r.user_id])),
    headUserId: head.rows[0]?.id ?? null,
  };
}

type Facts = Partial<RhythmFacts> | null;

/**
 * Один прохід на вже відкритому з'єднанні. Порожній список клієнтів — помилка, а не «нікого немає»: інакше збій
 * читання екрана закрив би всі рядки з причиною «клієнта немає у списку».
 */
export async function sweepRhythmTasks(db: Db, rows: readonly RhythmRow[]): Promise<RhythmSweepResult> {
  if (rows.length === 0) throw new Error("rhythmTaskSweep: список постійних клієнтів порожній — задачі не чіпаю");
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock($1)", [SWEEP_LOCK]);
    const targets = await loadRhythmTargets(db);
    const ex = await db.query<{ id: number; parent_id: number; status: string; client_key: string; facts: Facts; pack_status: string }>(`
      SELECT c.id, c.parent_id, c.status, c.client_key, c.metrics_json AS facts, p.status AS pack_status
        FROM tasks c JOIN tasks p ON p.id = c.parent_id
       WHERE c.task_type = $1 AND c.client_key IS NOT NULL`, [RHYTHM_CLIENT_TYPE]);
    const pk = await db.query<{ id: number; assignee_user_id: number | null; title: string; facts: { managerId?: number; via?: "lead" | "head" } | null }>(`
      SELECT id, assignee_user_id, title, metrics_json AS facts
        FROM tasks WHERE task_type = $1 AND status <> 'done' ORDER BY id`, [RHYTHM_PACK_TYPE]);
    const existing: ExistingRow[] = ex.rows.filter((r) => r.facts?.managerId != null).map((r) => ({
      id: r.id, packId: r.parent_id, packOpen: r.pack_status !== "done", open: r.status !== "done",
      clientKey: r.client_key, managerId: Number(r.facts!.managerId), lastOrder: r.facts!.lastOrder ?? null,
    }));
    const packs: OpenPack[] = pk.rows.filter((r) => r.facts?.managerId != null).map((r) => ({
      id: r.id, managerId: Number(r.facts!.managerId), assigneeUserId: r.assignee_user_id, title: r.title, via: r.facts!.via ?? null,
    }));
    const plan = planRhythmTasks({ rows, existing, packs, targets });

    const close = async (id: number, reason: string) => {
      const r = await db.query<{ id: number }>(
        `UPDATE tasks SET status = 'done', closed_at = now(), close_reason = $2, updated_at = now()
          WHERE id = $1 AND status <> 'done' RETURNING id`, [id, reason]);
      if (r.rows.length) {
        await db.query("INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, NULL, 'done', NULL)", [id]);
      }
    };
    const addRows = async (packId: number, userId: number | null, department: string | null, list: RhythmPlan["add"][number]["rows"]) => {
      for (const r of list) {
        await db.query(
          `INSERT INTO tasks (title, status, assignee_user_id, priority, department, task_type, client_key, parent_id, metrics_json)
           VALUES ($1, 'not_started', $2, 'high', $3, $4, $5, $6, $7)`,
          [r.title, userId, department, RHYTHM_CLIENT_TYPE, r.clientKey, packId, JSON.stringify(r.facts)]);
      }
    };

    for (const c of plan.closeRows) await close(c.id, c.reason);
    for (const f of plan.refresh) await db.query("UPDATE tasks SET metrics_json = $2 WHERE id = $1", [f.id, JSON.stringify(f.facts)]);
    let rowsAdded = 0;
    for (const a of plan.add) {
      const p = (await db.query<{ assignee_user_id: number | null; department: string | null }>(
        "SELECT assignee_user_id, department FROM tasks WHERE id = $1", [a.packId])).rows[0];
      await addRows(a.packId, p?.assignee_user_id ?? null, p?.department ?? null, a.rows);
      rowsAdded += a.rows.length;
    }
    for (const c of plan.create) {
      const ins = await db.query<{ id: number }>(
        `INSERT INTO tasks (title, status, assignee_user_id, priority, department, task_type, metrics_json)
         VALUES ($1, 'not_started', $2, 'high', $3, $4, $5) RETURNING id`,
        [packTitle(c.managerName, c.rows.length), c.userId, c.department, RHYTHM_PACK_TYPE,
         JSON.stringify({ managerId: c.managerId, managerName: c.managerName, via: c.via })]);
      await addRows(ins.rows[0].id, c.userId, c.department, c.rows);
      rowsAdded += c.rows.length;
    }
    for (const u of plan.update) {
      await db.query("UPDATE tasks SET title = $2, assignee_user_id = $3, metrics_json = $4, updated_at = now() WHERE id = $1",
        [u.packId, u.title, u.userId, JSON.stringify({ managerId: packs.find((p) => p.id === u.packId)!.managerId, managerName: u.managerName, via: u.via })]);
      // Виконавець рядків — той самий, що в задачі: інакше рядок лишився б у списку попереднього тімліда.
      await db.query("UPDATE tasks SET assignee_user_id = $2 WHERE parent_id = $1 AND task_type = $3 AND assignee_user_id IS DISTINCT FROM $2",
        [u.packId, u.userId, RHYTHM_CLIENT_TYPE]);
    }
    for (const c of plan.closePacks) await close(c.id, c.reason);
    await db.query("COMMIT");
    return { packsCreated: plan.create.length, rowsAdded, rowsClosed: plan.closeRows.length, packsClosed: plan.closePacks.length, stats: plan.stats };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

/** Бойовий прохід: рядки екрана → одне з'єднання з пула → запис. Пул лінивий, щоб чисті частини імпортувались без бази. */
export async function runRhythmTaskSweep(loadRows: () => Promise<readonly RhythmRow[]>): Promise<RhythmSweepResult> {
  const rows = await loadRows();
  const { pool } = await import("../db/pool.js");
  const c = await pool.connect();
  try {
    const r = await sweepRhythmTasks(c as unknown as Db, rows);
    const s = r.stats;
    console.log(`rhythmTaskSweep: на екрані ${String(s.onScreen)}, підпадають ${String(s.due)} (вже ставили ${String(s.covered)}, нікому ставити ${String(s.noTarget)}); `
      + `нових задач ${String(r.packsCreated)}, рядків додано ${String(r.rowsAdded)}, рядків закрито ${String(r.rowsClosed)}, задач закрито ${String(r.packsClosed)}; `
      + `не підпадають: ритм ${String(s.skipped.rhythm)}, менше ${String(RHYTHM_TASK_DAYS)} днів ${String(s.skipped.days)}, є робота ${String(s.skipped.work)}, `
      + `проблемні ${String(s.skipped.problem)}, дебіторка ${String(s.skipped.debt)}, реактивація ${String(s.skipped.react)}`);
    return r;
  } finally { c.release(); }
}
