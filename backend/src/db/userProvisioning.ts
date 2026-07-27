import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

export function generatePassword(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Ensures every active manager that has an email has a dashboard login, and
 * deactivates logins for managers who are no longer active in the CRM. Team
 * leads get the `team_lead` role (team-scoped access); everyone else is a
 * `manager`. Admin users are never touched. Returns the credentials created
 * during this run so they can be surfaced to the admin once.
 */
export async function provisionUsers(): Promise<{ email: string; password: string; name: string }[]> {
  const created: { email: string; password: string; name: string }[] = [];

  const managers = await pool.query<{
    id: number;
    name: string;
    email: string | null;
    team_id: number | null;
    is_team_lead: boolean;
    is_active: boolean;
  }>(
    `SELECT id, name, email, team_id, is_team_lead, is_active FROM managers WHERE email IS NOT NULL`
  );

  for (const m of managers.rows) {
    const role = m.is_team_lead ? "team_lead" : "manager";

    const existing = await pool.query<{ id: number; role: string }>(
      `SELECT id, role FROM users WHERE manager_id = $1 OR email = $2`,
      [m.id, m.email]
    );

    if (existing.rows[0]) {
      // Синк веде ЛИШЕ CRM-owned поля (role/team_id/manager_id/is_active). role_override
      // — панель-owned, синк його НІКОЛИ не чіпає → ефективна роль (напр. admin/kvp/custom,
      // виставлена адміном) переживає синк. Адмінство більше не «захищене» гілкою if — воно
      // живе в role_override, куди синк не пише.
      const u = existing.rows[0];
      await pool.query(
        `UPDATE users SET role = $1, team_id = $2, manager_id = $3, is_active = $4 WHERE id = $5`,
        [role, m.team_id, m.id, m.is_active, u.id]
      );
      continue;
    }

    if (!m.is_active) continue;

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 10);
    // Пароль — ЛИШЕ bcrypt-хеш; плейнтекст у БД не пишемо (initial_password прибрано).
    await pool.query(
      `INSERT INTO users (email, password_hash, role, manager_id, team_id, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (email) DO NOTHING`,
      [m.email, passwordHash, role, m.id, m.team_id]
    );
    created.push({ email: m.email!, password, name: m.name });
  }

  return created;
}

export async function resetPassword(userId: number): Promise<string> {
  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 10);
  // Хеш-онлі: плейнтекст НЕ зберігаємо; згенерований пароль повертаємо викликачу ОДИН раз.
  await pool.query(
    `UPDATE users SET password_hash = $1 WHERE id = $2`,
    [passwordHash, userId]
  );
  return password;
}
