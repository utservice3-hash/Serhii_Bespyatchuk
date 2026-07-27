// Само-блокування: не дати системі лишитись без активного адміна і не дати адміну
// розжалувати/деактивувати самого себе. Чиста функція (нижче) — для гейта b; DB-обгортки
// рахують входи. Ефективний адмін = COALESCE(role_override, role)='admin' AND is_active.
import { pool } from "../db/pool.js";

export type OrphanReason = "self" | "last";

/** Чисте рішення (без БД) — легко тестується. */
export function wouldOrphanAdmin(opts: {
  actorUserId: number;
  targetUserId: number;
  targetIsActiveAdmin: boolean; // цільовий ЗАРАЗ ефективно-активний адмін?
  changeRemovesAdmin: boolean;  // зміна прибирає адмінство (override→не-admin) АБО деактивує?
  otherActiveAdmins: number;    // к-ть ІНШИХ активних ефективних адмінів
}): { block: boolean; reason?: OrphanReason } {
  if (!opts.targetIsActiveAdmin || !opts.changeRemovesAdmin) return { block: false };
  if (opts.actorUserId === opts.targetUserId) return { block: true, reason: "self" };
  if (opts.otherActiveAdmins === 0) return { block: true, reason: "last" };
  return { block: false };
}

export async function isActiveEffectiveAdmin(userId: number): Promise<boolean> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM users WHERE id=$1 AND is_active AND COALESCE(role_override, role)='admin'`,
    [userId]
  );
  return r.rows[0].n > 0;
}

export async function otherActiveAdminCount(excludeUserId: number): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM users WHERE is_active AND COALESCE(role_override, role)='admin' AND id <> $1`,
    [excludeUserId]
  );
  return r.rows[0].n;
}
