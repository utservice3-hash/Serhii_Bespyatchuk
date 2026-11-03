import type { Db } from "./adCallFacts.js";
import { closeModeOf, type CloseMode } from "./carrierClose.js";
import { NON_COMMERCIAL_TEAM_IDS } from "./metrics.js";
import { SERVICE_KOMMO_USER_IDS } from "./orphanClients.js";
import { workedMonth } from "./linkedinQueue.js";

/**
 * 🔗 «Клієнти → LinkedIn» (задача 7361): статистика черги за період і редактор кола («Налаштувати чергу»).
 * Юля: «Зроби список у налаштуваннях, щоб я могла його міняти без тебе»; «у дашборді покажи по кожному менеджеру:
 * скільки заявок отримав, скільки взяв, скільки проігнорував і за який час узяв».
 */

export class QueueScreenError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface QueueMember { managerId: number; name: string; team: string | null; hiredAt: string | null; position: number; absentToday: boolean }
export interface QueueCandidate { managerId: number; name: string; team: string | null; hiredAt: string | null; suggested: boolean }
export interface QueueScreen {
  mode: CloseMode; launchedAt: string | null; dispatcherUserId: number | null;
  members: QueueMember[]; candidates: QueueCandidate[]; dispatchers: { userId: number; name: string }[];
}

const kyivToday = (now: Date) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

export async function loadQueueScreen(db: Db, modeRaw: string, now = new Date()): Promise<QueueScreen> {
  const today = kyivToday(now);
  const st = (await db.query<{ launched_at: Date | null; dispatcher_user_id: number | null }>(
    `SELECT launched_at, dispatcher_user_id FROM linkedin_queue_settings WHERE id`)).rows[0];
  // Активні менеджери продажу з Kommo-акаунтом (без службових і некомерційних команд) — з датою виходу з картки.
  const people = (await db.query<{ id: number; name: string; team: string | null; team_id: number | null; hired_at: string | null; pos: number | null; absent: boolean }>(
    `SELECT m.id, m.name, t.name AS team, m.team_id, e.hired_at::text AS hired_at, q.position AS pos,
            EXISTS (SELECT 1 FROM team_calendar_absences a
                     WHERE a.manager_id = m.id AND a.status = 'approved' AND a.kind IN ('day_off', 'vacation', 'sick')
                       AND $1::date BETWEEN a.start_date AND a.end_date) AS absent
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN employees e ON e.manager_id = m.id
       LEFT JOIN linkedin_queue_members q ON q.manager_id = m.id
      WHERE m.is_active AND m.kommo_user_id IS NOT NULL AND NOT (m.kommo_user_id::text = ANY($2::text[]))
      ORDER BY q.position NULLS LAST, m.name`, [today, [...SERVICE_KOMMO_USER_IDS]])).rows;
  const nonCom = new Set<number>(NON_COMMERCIAL_TEAM_IDS);
  const members = people.filter((p) => p.pos != null)
    .map((p) => ({ managerId: p.id, name: p.name, team: p.team, hiredAt: p.hired_at, position: p.pos!, absentToday: p.absent }));
  const candidates = people.filter((p) => p.pos == null)
    .map((p) => ({ managerId: p.id, name: p.name, team: p.team, hiredAt: p.hired_at,
      suggested: workedMonth(p.hired_at, today) && (p.team_id == null || !nonCom.has(p.team_id)) }));
  const dispatchers = (await db.query<{ id: number; name: string }>(
    `SELECT u.id, COALESCE(m.name, u.email) AS name FROM users u LEFT JOIN managers m ON m.id = u.manager_id
      WHERE u.is_active AND COALESCE(u.role_override, u.role) <> 'candidate' ORDER BY 2`)).rows.map((r) => ({ userId: r.id, name: r.name }));
  return {
    mode: closeModeOf(modeRaw), launchedAt: st?.launched_at ? new Date(st.launched_at).toISOString() : null,
    dispatcherUserId: st?.dispatcher_user_id ?? null, members, candidates, dispatchers,
  };
}

/** Новий порядок кола — повністю, як його поставила Юля. Лише активні менеджери з Kommo, без повторів. */
export async function saveQueueMembers(db: Db, managerIds: unknown, userId: number): Promise<void> {
  if (!Array.isArray(managerIds) || managerIds.some((x) => !Number.isInteger(x) || (x as number) <= 0)) {
    throw new QueueScreenError(400, "Список менеджерів має бути масивом id");
  }
  const ids = managerIds as number[];
  if (new Set(ids).size !== ids.length) throw new QueueScreenError(400, "Менеджер у списку двічі");
  if (ids.length) {
    const ok = (await db.query<{ id: number }>(
      `SELECT id FROM managers WHERE id = ANY($1::int[]) AND is_active AND kommo_user_id IS NOT NULL`, [ids])).rows.length;
    if (ok !== ids.length) throw new QueueScreenError(400, "У списку є неактивний або невідомий менеджер");
  }
  await db.query("BEGIN");
  try {
    await db.query(`DELETE FROM linkedin_queue_members`);
    for (const [i, id] of ids.entries()) {
      await db.query(`INSERT INTO linkedin_queue_members (manager_id, position, added_by) VALUES ($1, $2, $3)`, [id, i + 1, userId]);
    }
    await db.query("COMMIT");
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}

/** Кому йдуть дублі й «двоє підряд не взяли» (Даша). `null` — нікому (тоді лише журнал). */
export async function saveQueueDispatcher(db: Db, dispatcherUserId: unknown, userId: number): Promise<void> {
  const v = dispatcherUserId == null || dispatcherUserId === "" ? null : Number(dispatcherUserId);
  if (v != null && (!Number.isInteger(v) || v <= 0)) throw new QueueScreenError(400, "Некоректний користувач");
  if (v != null && !(await db.query(`SELECT 1 FROM users WHERE id = $1 AND is_active`, [v])).rows.length) {
    throw new QueueScreenError(400, "Користувача не знайдено або він вимкнений");
  }
  await db.query(`INSERT INTO linkedin_queue_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
  await db.query(`UPDATE linkedin_queue_settings SET dispatcher_user_id = $1, updated_by = $2, updated_at = now() WHERE id`, [v, userId]);
}
