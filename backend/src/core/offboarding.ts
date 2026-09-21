/**
 * 🚪 ЗВІЛЬНЕННЯ У ДВА КРОКИ (21.09.2026, рішення Романа).
 *
 *   «Звільнити…»           → реєстр: «завершує»; менеджер Kommo: стан «завершує» (плану немає, результат
 *                             рахується, вхід у дашборд працює — людина доводить свої угоди);
 *   «Завершити звільнення» → реєстр: «звільнений»; менеджер: «звільнений» (вхід закрито на логіні);
 *                             акаунт без картки менеджера — `users.is_active = false`. Кнопкою вручну;
 *   «Повернути»            → усе, що змінили два кроки, повертається до байта з `employee_offboarding.prev`.
 *
 * 🔴 НІЧОГО НЕ ВИДАЛЯЄТЬСЯ: сейф, документи, угоди, історія лишаються — «звільнений» це стан, а не прибирання.
 *
 * 🔴 ЧОМУ МЕНЕДЖЕРУ — `manager_work_state`, А НЕ `users.is_active`. Обидва прапорці `is_active` перераховує синк
 * Kommo кожні 30 хв (див. `core/managerState.ts`), тож вимкнення там прожило б пів години. Логін читає
 * `manager_work_state` щоразу (`LOGIN_LOOKUP_SQL`), і Звіт/КВП показують ту саму позначку «завершує / звільнений»,
 * що й після зміни в Налаштуваннях. Людина без картки менеджера синком не зачіпається — їй `users.is_active`.
 *
 * ⚠️ Уже відкрита сесія живе до кінця токена (до 12 год) — межа `loginEnabledFor`, не наша.
 * Тримають #610–#612.
 */
import { parseDate, ImportError } from "./employeeImport.js";
import type { Db } from "./secrets.js";

type MwsRow = { state: string; since: string; note: string | null; set_by: number | null; set_at: string } | null;
interface Prev {
  status: string; dismissed_at: string | null; dismiss_reason: string | null;
  /** manager_id → рядок `manager_work_state` ДО звільнення (null — рядка не було, тобто «активний»). */
  mws: Record<string, MwsRow>;
  /** Акаунт без картки менеджера: його прапорці ДО кроку 2 (null — крок 2 акаунт не чіпав). */
  user: { id: number; is_active: boolean; deactivated_at: string | null; deactivated_reason: string | null } | null;
}

async function audit(db: Db, actorId: number, id: number, label: string, action: string, details: Record<string, unknown>) {
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), $2, 'user', $3, $4, $5)`,
    [actorId, action, `e${id}`, label, details]);
}

/** Людина + її менеджери Kommo (привʼязка реєстру і картка акаунта — обидві, без повторів). */
async function load(db: Db, id: number) {
  const e = (await db.query<{ id: number; full_name: string; status: string; dismissed_at: string | null; dismiss_reason: string | null;
    user_id: number | null; manager_id: number | null; user_manager_id: number | null }>(
    `SELECT e.id, e.full_name, e.status, e.dismissed_at::text AS dismissed_at, e.dismiss_reason, e.user_id, e.manager_id, u.manager_id AS user_manager_id
       FROM employees e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = $1 FOR UPDATE OF e`, [id])).rows[0];
  if (!e) throw new ImportError(404, "Співробітника не знайдено");
  const managers = [...new Set([e.manager_id, e.user_manager_id].filter((x): x is number => x != null))];
  const off = (await db.query<{ stage: string; prev: Prev; last_day: string; reason: string }>(
    `SELECT stage, prev, last_day::text AS last_day, reason FROM employee_offboarding WHERE employee_id = $1`, [id])).rows[0] ?? null;
  return { e, managers, off };
}

async function setMws(db: Db, managerId: number, state: "finishing" | "dismissed", note: string, actorId: number) {
  // `since` у DO UPDATE не чіпаємо — як у Налаштуваннях: це дата, з якої людина в стані.
  await db.query(
    `INSERT INTO manager_work_state (manager_id, state, note, set_by, set_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (manager_id) DO UPDATE SET state = EXCLUDED.state, note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = now()`,
    [managerId, state, note, actorId]);
}

/** Крок 1: «Звільнити…» — останній робочий день і причина обовʼязкові. */
export async function startDismissal(db: Db, actorId: number, id: number, body: { lastDay?: unknown; reason?: unknown }) {
  const { e, managers, off } = await load(db, id);
  if (off || e.status !== "active") throw new ImportError(409, e.status === "finishing" || off ? "Звільнення вже розпочато" : "Людина вже звільнена");
  const lastDay = typeof body.lastDay === "string" ? parseDate(body.lastDay) : null;
  if (!lastDay) throw new ImportError(400, "Вкажіть останній робочий день");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
  if (!reason) throw new ImportError(400, "Вкажіть причину звільнення");
  if (e.user_id != null && e.user_id === actorId) throw new ImportError(400, "Себе звільнити не можна — це робить інший керівник");
  const prev: Prev = { status: e.status, dismissed_at: e.dismissed_at, dismiss_reason: e.dismiss_reason, mws: {}, user: null };
  for (const m of managers) {
    const row = (await db.query<NonNullable<MwsRow>>(
      `SELECT state, since::text AS since, note, set_by, set_at::text AS set_at FROM manager_work_state WHERE manager_id = $1`, [m])).rows[0] ?? null;
    prev.mws[String(m)] = row;
    // Уже «звільнений» у Налаштуваннях — не повертаємо його назад у «завершує».
    if (row?.state !== "dismissed") await setMws(db, m, "finishing", `звільнення в реєстрі: ${reason}`, actorId);
  }
  await db.query(`UPDATE employees SET status = 'finishing', dismissed_at = $2, dismiss_reason = $3, updated_at = now() WHERE id = $1`, [id, lastDay, reason]);
  await db.query(`INSERT INTO employee_offboarding (employee_id, stage, last_day, reason, prev, started_by) VALUES ($1, 'finishing', $2, $3, $4, $5)`,
    [id, lastDay, reason, prev, actorId]);
  await audit(db, actorId, id, e.full_name, "employees.dismiss_start", { lastDay, managers });
  return { status: "finishing" as const, managers: managers.length };
}

/** Крок 2: «Завершити звільнення» — лише після кроку 1, кнопкою вручну. */
export async function finishDismissal(db: Db, actorId: number, id: number) {
  const { e, managers, off } = await load(db, id);
  if (!off || off.stage !== "finishing") throw new ImportError(409, "Спершу «Звільнити…» — людина має бути в стані «завершує»");
  if (e.user_id != null && e.user_id === actorId) throw new ImportError(400, "Себе звільнити не можна — це робить інший керівник");
  const prev = off.prev;
  // Менеджери, яких зʼявилось між кроками (привʼязали до Kommo), теж запамʼятовуємо — інакше «Повернути» їх не відкотить.
  for (const m of managers) {
    if (!(String(m) in prev.mws)) prev.mws[String(m)] = (await db.query<NonNullable<MwsRow>>(
      `SELECT state, since::text AS since, note, set_by, set_at::text AS set_at FROM manager_work_state WHERE manager_id = $1`, [m])).rows[0] ?? null;
    await setMws(db, m, "dismissed", `звільнено в реєстрі: ${off.reason}`, actorId);
  }
  let accountOff = managers.length > 0;
  if (e.user_id != null && e.user_manager_id == null) {
    const u = (await db.query<{ id: number; is_active: boolean; deactivated_at: string | null; deactivated_reason: string | null }>(
      `SELECT id, is_active, deactivated_at::text AS deactivated_at, deactivated_reason FROM users WHERE id = $1 FOR UPDATE`, [e.user_id])).rows[0];
    prev.user = u;
    await db.query(`UPDATE users SET is_active = false, deactivated_at = now(), deactivated_reason = 'звільнено в реєстрі' WHERE id = $1`, [e.user_id]);
    accountOff = true;
  }
  await db.query(`UPDATE employees SET status = 'dismissed', updated_at = now() WHERE id = $1`, [id]);
  await db.query(`UPDATE employee_offboarding SET stage = 'dismissed', prev = $2, finished_by = $3, finished_at = now() WHERE employee_id = $1`, [id, prev, actorId]);
  await audit(db, actorId, id, e.full_name, "employees.dismiss_finish", { managers, accountOff });
  return { status: "dismissed" as const, accountOff };
}

/** «Повернути»: відкочує обидва кроки — реєстр, стан менеджера, акаунт — до стану до «Звільнити…». */
export async function revertDismissal(db: Db, actorId: number, id: number) {
  const { e, off } = await load(db, id);
  if (!off) throw new ImportError(409, "Звільнення через реєстр не було — повертати нічого");
  const p = off.prev;
  for (const [m, row] of Object.entries(p.mws)) {
    if (row == null) await db.query(`DELETE FROM manager_work_state WHERE manager_id = $1`, [Number(m)]);
    else await db.query(
      `INSERT INTO manager_work_state (manager_id, state, since, note, set_by, set_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (manager_id) DO UPDATE SET state = EXCLUDED.state, since = EXCLUDED.since, note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
      [Number(m), row.state, row.since, row.note, row.set_by, row.set_at]);
  }
  if (p.user) await db.query(`UPDATE users SET is_active = $2, deactivated_at = $3, deactivated_reason = $4 WHERE id = $1`,
    [p.user.id, p.user.is_active, p.user.deactivated_at, p.user.deactivated_reason]);
  await db.query(`UPDATE employees SET status = $2, dismissed_at = $3, dismiss_reason = $4, updated_at = now() WHERE id = $1`,
    [id, p.status, p.dismissed_at, p.dismiss_reason]);
  await db.query(`DELETE FROM employee_offboarding WHERE employee_id = $1`, [id]);
  await audit(db, actorId, id, e.full_name, "employees.dismiss_revert", { from: off.stage });
  return { status: p.status };
}
