import type { Db } from "./adCallFacts.js";
import { closeModeOf, type CloseMode } from "./carrierClose.js";
import { NON_COMMERCIAL_TEAM_IDS } from "./metrics.js";
import { SERVICE_KOMMO_USER_IDS } from "./orphanClients.js";
import { workedMonth } from "./linkedinQueue.js";

/**
 * 🔗 «Клієнти → LinkedIn» → «Черга» (задача 7361): редактор кола.
 * Юля: «Зроби список у налаштуваннях, щоб я могла його міняти без тебе»; «у дашборді покажи по кожному менеджеру:
 * скільки заявок отримав, скільки взяв, скільки проігнорував і за який час узяв».
 */

export class QueueScreenError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface QueueMember { managerId: number; name: string; team: string | null; hiredAt: string | null; position: number; absentToday: boolean; botLinked: boolean }
export interface QueueCandidate { managerId: number; name: string; team: string | null; hiredAt: string | null; suggested: boolean }
export interface QueueScreen {
  mode: CloseMode; launchedAt: string | null;
  members: QueueMember[]; candidates: QueueCandidate[];
}

const kyivToday = (now: Date) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

export async function loadQueueScreen(db: Db, modeRaw: string, now = new Date()): Promise<QueueScreen> {
  const today = kyivToday(now);
  const st = (await db.query<{ launched_at: Date | null }>(`SELECT launched_at FROM linkedin_queue_settings WHERE id`)).rows[0];
  // Активні менеджери продажу з Kommo-акаунтом (без службових і некомерційних команд) — з датою виходу з картки.
  const people = (await db.query<{ id: number; name: string; team: string | null; team_id: number | null; hired_at: string | null; pos: number | null; absent: boolean; bot: boolean }>(
    `SELECT m.id, m.name, t.name AS team, m.team_id, e.hired_at::text AS hired_at, q.position AS pos,
            EXISTS (SELECT 1 FROM team_calendar_absences a
                     WHERE a.manager_id = m.id AND a.status = 'approved' AND a.kind IN ('day_off', 'vacation', 'sick')
                       AND $1::date BETWEEN a.start_date AND a.end_date) AS absent,
            EXISTS (SELECT 1 FROM users u WHERE u.manager_id = m.id AND u.is_active AND u.leads_bot_chat_id IS NOT NULL) AS bot
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN employees e ON e.manager_id = m.id
       LEFT JOIN linkedin_queue_members q ON q.manager_id = m.id
      WHERE m.is_active AND m.kommo_user_id IS NOT NULL AND NOT (m.kommo_user_id::text = ANY($2::text[]))
      ORDER BY q.position NULLS LAST, m.name`, [today, [...SERVICE_KOMMO_USER_IDS]])).rows;
  const nonCom = new Set<number>(NON_COMMERCIAL_TEAM_IDS);
  const members = people.filter((p) => p.pos != null)
    .map((p) => ({ managerId: p.id, name: p.name, team: p.team, hiredAt: p.hired_at, position: p.pos!, absentToday: p.absent, botLinked: p.bot }));
  const candidates = people.filter((p) => p.pos == null)
    .map((p) => ({ managerId: p.id, name: p.name, team: p.team, hiredAt: p.hired_at,
      suggested: workedMonth(p.hired_at, today) && (p.team_id == null || !nonCom.has(p.team_id)) }));
  return {
    mode: closeModeOf(modeRaw), launchedAt: st?.launched_at ? new Date(st.launched_at).toISOString() : null,
    members, candidates,
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
