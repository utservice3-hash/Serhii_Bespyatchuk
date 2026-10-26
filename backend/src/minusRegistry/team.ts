/**
 * 👥 Команда тім-ліда для пакетів Сергія (`teamOf`): `users.id` менеджерів його команди (без нього самого).
 * ТЗ v1.1 (23.10.2026): тім-лід бачить запити своєї команди — лише перегляд. Команда — `managers.team_id` = `teamId`
 * сесії тім-ліда (той самий обсяг «Команда», що й у звітах). Немає команди (`teamId` −1 / null) — порожньо.
 */
import { pool } from "../db/pool.js";

export const TEAM_MEMBERS_SQL = `
  SELECT u.id::text AS id FROM users u JOIN managers m ON m.id = u.manager_id
   WHERE m.team_id = $1 AND u.id <> $2`;

export async function teamMemberUserIds(teamId: number | null | undefined, selfUserId: number): Promise<string[]> {
  if (teamId == null || teamId < 0) return [];
  const q = await pool.query<{ id: string }>(TEAM_MEMBERS_SQL, [teamId, selfUserId]);
  return q.rows.map((r) => r.id);
}
