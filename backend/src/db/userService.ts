import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

export type Role = "admin" | "team_lead" | "manager";

export async function createOrUpdateUser(params: {
  email: string;
  role: Role;
  teamName?: string;
  password?: string;
}): Promise<{ email: string; password: string }> {
  const { email, role } = params;

  let teamId: number | null = null;
  if (params.teamName) {
    const teamRes = await pool.query<{ id: number }>(
      `SELECT id FROM teams WHERE name = $1`,
      [params.teamName]
    );
    if (!teamRes.rows[0]) throw new Error(`Команду не знайдено: ${params.teamName}`);
    teamId = teamRes.rows[0].id;
  }
  if (role === "team_lead" && !teamId) {
    throw new Error("Для ролі team_lead потрібна команда");
  }

  const password = params.password ?? randomBytes(9).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (email, password_hash, role, team_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       team_id = EXCLUDED.team_id`,
    [email, passwordHash, role, teamId]
  );

  return { email, password };
}

export async function listUsers(): Promise<
  { email: string; role: Role; team_name: string | null }[]
> {
  const result = await pool.query(
    `SELECT u.email, u.role, t.name AS team_name
     FROM users u
     LEFT JOIN teams t ON t.id = u.team_id
     ORDER BY u.email`
  );
  return result.rows;
}

export async function listTeams(): Promise<{ id: number; name: string }[]> {
  const result = await pool.query(`SELECT id, name FROM teams ORDER BY name`);
  return result.rows;
}
