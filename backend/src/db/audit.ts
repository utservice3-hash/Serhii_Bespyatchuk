// Журнал змін доступу. Пишеться на кожній admin-зміні users/roles. НІКОЛИ не логуємо пароль.
import { pool } from "./pool.js";

export async function writeAudit(a: {
  actorUserId: number | null;
  actorEmail: string | null;
  action: string; // user.* | role.* | bank.account.* | bank.hidden.*
  targetType: "user" | "role" | "bank_account" | "bank_payee";
  targetId: string;
  targetLabel?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [a.actorUserId, a.actorEmail, a.action, a.targetType, a.targetId, a.targetLabel ?? null, a.details ?? {}]
  );
}
