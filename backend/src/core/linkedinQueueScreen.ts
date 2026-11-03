import type { Db } from "./adCallFacts.js";
import { closeModeOf, type CloseMode } from "./carrierClose.js";
import { NON_COMMERCIAL_TEAM_IDS } from "./metrics.js";
import { SERVICE_KOMMO_USER_IDS } from "./orphanClients.js";
import { workedMonth } from "./linkedinQueue.js";

/**
 * 🔗 «Налаштування → Черга LinkedIn» (задача 7361): список кола, відповідальна за спірне, журнал і статистика.
 * Юля: «Зроби список у налаштуваннях, щоб я могла його міняти без тебе»; «у дашборді покажи по кожному менеджеру:
 * скільки заявок отримав, скільки взяв, скільки проігнорував і за який час узяв».
 */

export class QueueScreenError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface QueueMember { managerId: number; name: string; team: string | null; hiredAt: string | null; position: number; absentToday: boolean }
export interface QueueCandidate { managerId: number; name: string; team: string | null; hiredAt: string | null; suggested: boolean }
export interface QueueStat { managerId: number; name: string; received: number; taken: number; ignored: number; avgTakeMin: number | null }
export interface QueueItemView {
  kommoId: number; dealName: string | null; state: string; managerName: string | null; reason: string | null;
  seenAt: string; offeredAt: string | null; deadlineAt: string | null; misses: number;
}
export interface QueueScreen {
  mode: CloseMode; launchedAt: string | null; dispatcherUserId: number | null;
  members: QueueMember[]; candidates: QueueCandidate[]; dispatchers: { userId: number; name: string }[];
  items: QueueItemView[]; stats: QueueStat[];
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
  const items = (await db.query<{ kommo_id: string; deal_name: string | null; state: string; mname: string | null; reason: string | null;
    seen_at: Date; offered_at: Date | null; deadline_at: Date | null; misses: number }>(
    `SELECT i.kommo_id::text, i.deal_name, i.state, m.name AS mname, i.reason, i.seen_at, i.offered_at, i.deadline_at, i.misses
       FROM linkedin_queue_items i LEFT JOIN managers m ON m.id = i.manager_id
      ORDER BY i.seen_at DESC LIMIT 50`)).rows.map((r) => ({
    kommoId: Number(r.kommo_id), dealName: r.deal_name, state: r.state, managerName: r.mname, reason: r.reason,
    seenAt: new Date(r.seen_at).toISOString(), offeredAt: r.offered_at ? new Date(r.offered_at).toISOString() : null,
    deadlineAt: r.deadline_at ? new Date(r.deadline_at).toISOString() : null, misses: r.misses }));
  // «Отримав» = пропозиції, «проігнорував» = сплило 15 хв, «взяв» і час — від пропозиції до «Взяти» (журнал, 2б).
  const stats = (await db.query<{ manager_id: number; name: string; received: string; taken: string; ignored: string; avg_min: string | null }>(
    `WITH o AS (SELECT kommo_id, manager_id, at FROM linkedin_queue_log WHERE kind = 'offer'),
          tk AS (SELECT t.manager_id, EXTRACT(EPOCH FROM (t.at - (SELECT MAX(o.at) FROM o WHERE o.kommo_id = t.kommo_id
                                                          AND o.manager_id = t.manager_id AND o.at <= t.at))) / 60 AS mins
                   FROM linkedin_queue_log t WHERE t.kind = 'taken')
     SELECT m.id AS manager_id, m.name,
            (SELECT COUNT(*) FROM o WHERE o.manager_id = m.id) AS received,
            (SELECT COUNT(*) FROM tk WHERE tk.manager_id = m.id) AS taken,
            (SELECT COUNT(*) FROM linkedin_queue_log l WHERE l.kind = 'ignored' AND l.manager_id = m.id) AS ignored,
            (SELECT ROUND(AVG(tk.mins)::numeric, 1) FROM tk WHERE tk.manager_id = m.id) AS avg_min
       FROM managers m WHERE m.id IN (SELECT manager_id FROM o)
      ORDER BY 3 DESC, 2`)).rows.map((r) => ({ managerId: r.manager_id, name: r.name, received: Number(r.received), taken: Number(r.taken),
    ignored: Number(r.ignored), avgTakeMin: r.avg_min == null ? null : Number(r.avg_min) }));
  return {
    mode: closeModeOf(modeRaw), launchedAt: st?.launched_at ? new Date(st.launched_at).toISOString() : null,
    dispatcherUserId: st?.dispatcher_user_id ?? null, members, candidates, dispatchers, items, stats,
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
