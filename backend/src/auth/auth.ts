import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type Role = "admin" | "team_lead" | "manager";

export interface AuthPayload {
  userId: number;
  role: Role;
  managerId: number | null;
  teamId: number | null;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "12h" });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, config.jwtSecret) as AuthPayload;
}
