import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { signToken } from "../auth/auth.js";
import { effectiveRoleKey, getRoleDef, scopeCompatRole } from "../auth/rbac.js";

export const authRouter = Router();

// Email нормалізується (trim + нижній регістр) ще до валідації — мобільний
// автокапс/пробіл більше не ламає вхід. Пароль НЕ чіпаємо (пробіл може бути
// частиною пароля). У запиті теж lower(email) — на випадок, якщо збережений
// email містить великі літери.
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password format" });
  }
  const { email, password } = parsed.data;

  const result = await pool.query<{
    id: number;
    password_hash: string;
    role: "admin" | "team_lead" | "manager";
    role_override: string | null;
    manager_id: number | null;
    team_id: number | null;
    is_active: boolean;
  }>(
    `SELECT id, password_hash, role, role_override, manager_id, team_id, is_active FROM users WHERE lower(email) = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: "Обліковий запис деактивовано" });
  }

  // Ефективна роль = role_override ?? синкнута роль. У токен кладемо ключ ролі (для гейтів)
  // + scope-compat роль (для наявної data-scope логіки в роутах) + перелік дозволених вкладок
  // (для косметики nav у FE — сервер усе одно гейтить незалежно).
  const roleKey = effectiveRoleKey(user);
  const def = getRoleDef(roleKey);
  const screens = def ? Object.keys(def.screenAccess).filter((k) => def.screenAccess[k] === true) : undefined;
  const perms = def ? Object.keys(def.permissions).filter((k) => def.permissions[k] === true) : undefined;
  const token = signToken({
    userId: user.id,
    email,
    role: scopeCompatRole(roleKey, def),
    roleKey,
    screens,
    perms,
    managerId: user.manager_id,
    teamId: user.team_id,
  });
  res.json({ token });
});
