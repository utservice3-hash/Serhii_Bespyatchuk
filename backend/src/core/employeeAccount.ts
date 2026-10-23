/**
 * 🔑 АКАУНТ ДАШБОРДА В КАРТЦІ СПІВРОБІТНИКА (прохід 4 «один акаунт», 23.10.2026, #2280–#2283).
 *
 * Рішення Романа 23.10.2026: єдиний екран людини — «Найм → Співробітники». HR бачить логін, скидає пароль і вмикає
 * трекер — ЛИШЕ менеджерам і тімлідам («hr тільки по менеджерах може працювати і тім лідах, інші — ні»); роль і
 * вимкнення акаунта — лише адмін, СЕО, ОД (вони роблять це через наявні роути Налаштувань, з їхньою перевіркою
 * «не зняти останнього адміна»).
 *
 * Хто що може — одна чиста функція `accountVerdict`, щоб картка й сервер не розійшлись:
 *   • пароль — `reset_passwords` (адмін, СЕО, ОД) будь-кому; або `manage_sales_accounts` (HR) — лише менеджеру/тімліду;
 *   • трекер — `manage_users` будь-кому; або `manage_sales_accounts` — лише менеджеру/тімліду;
 *   • роль і вхід — лише `manage_users`.
 * «Менеджер/тімлід» — ЕФЕКТИВНА роль акаунта (ручна, якщо є, інакше з Kommo): ручна КВП чи бухгалтерія на акаунті з
 * Kommo — уже не «менеджер», і HR її не чіпає.
 *
 * Як і решта `core/`, бере зʼєднання параметром і НЕ імпортує `db/pool`.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { SecretError, type Db } from "./secrets.js";
import { SecretKeyMissing } from "./secretBox.js";
import { storeDashboardPassword } from "./teamVault.js";

/** Ролі, з якими працює HR (рішення 23.10.2026). */
export const HR_ACCOUNT_ROLES: readonly string[] = ["manager", "team_lead"];

export interface AccountPerms { manageUsers: boolean; resetPasswords: boolean; manageSales: boolean }
export type AccountAction = "password" | "tracker" | "role" | "active" | "pool";

/** Чи можна дію над акаунтом із такою ефективною роллю. Одне правило для кнопок картки й для сервера. */
export function accountVerdict(p: AccountPerms, action: AccountAction, targetRole: string): { ok: true } | { ok: false; error: string } {
  const sales = HR_ACCOUNT_ROLES.includes(targetRole);
  if (action === "password" && (p.resetPasswords || (p.manageSales && sales))) return { ok: true };
  if (action === "tracker" && (p.manageUsers || (p.manageSales && sales))) return { ok: true };
  // «Пул нічийних» відкриває менеджеру телефони чужих клієнтів — лише адмін, СЕО, ОД (Роман 23.10.2026, прохід 5).
  if ((action === "role" || action === "active" || action === "pool") && p.manageUsers) return { ok: true };
  if (p.manageSales && !sales && (action === "password" || action === "tracker"))
    return { ok: false, error: "HR керує лише акаунтами менеджерів і тімлідів" };
  return { ok: false, error: "Немає права на цю дію з акаунтом" };
}

export interface EmployeeAccount {
  userId: number; login: string; role: string; roleOverride: string | null; syncedRole: string;
  isActive: boolean; lastSeen: string | null; trackerEnabled: boolean; kommoName: string | null;
  /** 🧭 Пул нічийних (прохід 5): у картці — бо з Налаштувань людьми більше не керують. */
  orphanPool: boolean;
  /** Стан менеджера з Kommo (`manager_work_state`): null — активний; змінюється «Звільнити…» в картці. */
  workState: "finishing" | "dismissed" | null;
}

/** Акаунт, привʼязаний до картки; null — у картки акаунта немає. */
export async function employeeAccount(db: Db, employeeId: number): Promise<EmployeeAccount | null> {
  const e = (await db.query<{ user_id: number | null }>(`SELECT user_id FROM employees WHERE id = $1`, [employeeId])).rows[0];
  if (!e) throw new SecretError(404, "Співробітника не знайдено");
  if (e.user_id == null) return null;
  const u = (await db.query<{ id: number; email: string; role: string; role_override: string | null; is_active: boolean;
    last_seen: string | null; tracker_enabled: boolean; kommo: string | null; orphan_pool: boolean | null; work_state: "finishing" | "dismissed" | null }>(
    `SELECT u.id, u.email, u.role, u.role_override, u.is_active, u.last_seen, u.tracker_enabled, m.name AS kommo,
            u.orphan_pool, w.state AS work_state
       FROM users u LEFT JOIN managers m ON m.id = u.manager_id LEFT JOIN manager_work_state w ON w.manager_id = u.manager_id
      WHERE u.id = $1`, [e.user_id])).rows[0];
  return { userId: u.id, login: u.email, role: u.role_override ?? u.role, roleOverride: u.role_override, syncedRole: u.role,
    isActive: u.is_active, lastSeen: u.last_seen, trackerEnabled: u.tracker_enabled === true, kommoName: u.kommo,
    orphanPool: u.orphan_pool === true, workState: u.work_state ?? null };
}

async function accountFor(db: Db, employeeId: number, p: AccountPerms, action: AccountAction): Promise<EmployeeAccount> {
  const a = await employeeAccount(db, employeeId);
  if (!a) throw new SecretError(409, "У картки немає акаунта дашборда");
  const v = accountVerdict(p, action, a.role);
  if (!v.ok) throw new SecretError(403, v.error);
  return a;
}

/**
 * Скинути пароль: новий хеш, значення — у сейф картки (як у тімліда, `storeDashboardPassword`), у відповіді — ОДИН раз.
 * Без ключа сейфу не скидаємо: пароль, якого ніде немає, — це людина без входу.
 */
export async function resetEmployeePassword(db: Db, key: Buffer | null, actorId: number, employeeId: number, p: AccountPerms) {
  if (!key) throw new SecretKeyMissing();
  const a = await accountFor(db, employeeId, p, "password");
  const password = randomBytes(9).toString("base64url");
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await bcrypt.hash(password, 10), a.userId]);
  await storeDashboardPassword(db, key, actorId, a.userId, password);
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), 'user.reset_password', 'user', $2, $3, $4)`,
    [actorId, String(a.userId), a.login, JSON.stringify({ by: "employee_card", employeeId })]);
  return { login: a.login, password };
}

/** Трекер часу: увімкнути / вимкнути. Однаково просто в обидва боки (правило 06.08.2026). */
export async function setEmployeeTracker(db: Db, actorId: number, employeeId: number, on: unknown, p: AccountPerms) {
  if (typeof on !== "boolean") throw new SecretError(400, "Вкажіть, увімкнути чи вимкнути трекер");
  const a = await accountFor(db, employeeId, p, "tracker");
  await db.query(`UPDATE users SET tracker_enabled = $2 WHERE id = $1`, [a.userId, on]);
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), 'user.update', 'user', $2, $3, $4)`,
    [actorId, String(a.userId), a.login, JSON.stringify({ tracker_enabled: on, by: "employee_card", employeeId })]);
  return { trackerEnabled: on };
}
