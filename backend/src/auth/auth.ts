import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type Role = "admin" | "team_lead" | "manager";
// Scope-compat роль у токені (див. rbac.scopeCompatRole): для вбудованих = тотожність;
// company-scope не-admin → 'company' (наявна per-route логіка трактує як «усі», але це
// НЕ 'admin' — admin-only дії лишаються закритими, відкриваються лише perm-гейтом).
export type ScopeRole = Role | "company";

export interface AuthPayload {
  userId: number;
  email?: string;    // для аудиту (хто зробив зміну)
  role: ScopeRole;   // scope-compat (для наявної data-scope логіки в роутах)
  roleKey: string;   // ефективний ключ ролі (admin|kvp|team_lead|manager|<custom>) — для гейтів
  screens?: string[]; // дозволені вкладки (screen_access=true) — ЛИШЕ для косметики nav у FE; сервер гейтить незалежно
  perms?: string[];   // надані права (permissions=true) — ЛИШЕ для косметики FE; сервер гейтить через requirePerm
  managerId: number | null;
  teamId: number | null;
  /** `users.tracker_enabled` — ЛИШЕ косметика nav (ховає кнопку); межу тримає сервер. */
  trackerEnabled?: boolean;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "12h" });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, config.jwtSecret) as AuthPayload;
}
