// Журнал змін доступу. Пишеться на кожній admin-зміні users/roles. НІКОЛИ не логуємо пароль.
//
// ⚠️ `actor_email` добирається з `users`, коли токен не приніс клейма. Заміряно
// 27.08.2026: 4 записи з порожнім email мали заповнений `actor_user_id` (=1, роль
// opdir, email у БД є) — тобто автор НЕ був утрачений, порожнім лишалось лише поле.
// Це не дірка й не старий формат (записи з email є і до, і після них).
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
     VALUES ($1, COALESCE($2, (SELECT email FROM users WHERE id = $1)), $3,$4,$5,$6,$7)`,
    [a.actorUserId, a.actorEmail, a.action, a.targetType, a.targetId, a.targetLabel ?? null, a.details ?? {}]
  );
}
