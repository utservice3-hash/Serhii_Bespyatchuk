import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { signToken } from "../auth/auth.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
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
    manager_id: number | null;
    team_id: number | null;
    is_active: boolean;
  }>(
    `SELECT id, password_hash, role, manager_id, team_id, is_active FROM users WHERE email = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: "Обліковий запис деактивовано" });
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
    managerId: user.manager_id,
    teamId: user.team_id,
  });
  res.json({ token });
});
