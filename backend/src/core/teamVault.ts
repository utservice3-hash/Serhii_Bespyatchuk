/**
 * 👥 ТІМЛІД І СЕЙФ СВОЄЇ КОМАНДИ — ОПЕРАЦІЇ З БАЗОЮ (29.09.2026). Правило — `teamVaultRules.ts`.
 *
 * Зʼєднання й ключ — параметрами, як у `secrets.ts`: гейти ганяють усе на scratch-кластері з
 * власним ключем. Показ іде ТИМ САМИМ `revealSecret` (код у Telegram, 30 с, аудит) — тут лише
 * межа «своя команда» перед ним.
 *
 * 🔑 ПАРОЛЬ ДАШБОРДА В СЕЙФІ. У `users` лежить лише bcrypt-хеш, тож відновити пароль із бази
 * неможливо в принципі. Тому пароль шифрується в сейф у ту мить, коли його генерує система
 * (скидання тімлідом або адміном). Паролі, видані раніше, у сейфі не зʼявляться, доки їх не скинуть,
 * і екран каже це словами — «невідомий, скиньте», а не порожнім місцем.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { SecretError, ownerOf, prepareSecret, insertSecrets, type Db } from "./secrets.js";
import { SecretKeyMissing } from "./secretBox.js";
import { teamMemberVerdict, teamSecretVisible, DASHBOARD_SERVICE, type TeamActor, type TeamTarget } from "./teamVaultRules.js";

async function actorOf(db: Db, actorId: number): Promise<TeamActor> {
  const r = (await db.query<{ id: number; role: string; team_id: number | null }>(
    `SELECT id, COALESCE(role_override, role) AS role, team_id FROM users WHERE id = $1`, [actorId])).rows[0];
  return { userId: actorId, role: r?.role ?? "", teamId: r?.team_id ?? null };
}

const TARGET_SQL = `
  SELECT u.id, COALESCE(u.role_override, u.role) AS role, u.team_id, u.is_active,
         (w.state = 'dismissed') AS dismissed
    FROM users u LEFT JOIN manager_work_state w ON w.manager_id = u.manager_id`;

const targetOf = (r: { id: number; role: string; team_id: number | null; is_active: boolean; dismissed: boolean | null }): TeamTarget =>
  ({ userId: r.id, role: r.role, teamId: r.team_id, active: r.is_active, dismissed: r.dismissed === true });

/** Кидає 403 з причиною, якщо людина не з команди тімліда. Повертає ціль. */
export async function assertTeamMember(db: Db, actorId: number, userId: number): Promise<TeamTarget> {
  const a = await actorOf(db, actorId);
  const row = (await db.query<{ id: number; role: string; team_id: number | null; is_active: boolean; dismissed: boolean | null }>(
    `${TARGET_SQL} WHERE u.id = $1`, [userId])).rows[0];
  const t = row ? targetOf(row) : null;
  const v = teamMemberVerdict(a, t);
  if (!v.ok) throw new SecretError(403, v.reason);
  return t!;
}

/** Список команди: профіль із реєстру + скільки паролів у сейфі + чи є там пароль дашборда. */
export async function listTeamPeople(db: Db, actorId: number) {
  const a = await actorOf(db, actorId);
  if (a.role !== "team_lead" || a.teamId == null) {
    const v = teamMemberVerdict(a, null);
    return { rows: [], reason: v.ok ? null : v.reason };
  }
  // Ширший набір — та сама команда; хто з них видимий, вирішує `teamMemberVerdict` нижче, рядок за рядком.
  const rows = (await db.query<{
    id: number; role: string; team_id: number | null; is_active: boolean; dismissed: boolean | null;
    name: string; login: string; position: string | null; phone: string | null; contact_email: string | null;
    telegram: string | null; birth_date: string | null; hired_at: string | null; kind: string | null; service: string | null;
  }>(
    `SELECT u.id, COALESCE(u.role_override, u.role) AS role, u.team_id, u.is_active, (w.state = 'dismissed') AS dismissed,
            COALESCE(NULLIF(e.full_name, ''), NULLIF(u.full_name, ''), m.name, u.email) AS name, u.email AS login,
            e.position, e.phone, e.email AS contact_email, e.telegram, e.birth_date::text AS birth_date, e.hired_at::text AS hired_at,
            s.kind, s.service
       FROM users u
       LEFT JOIN managers m ON m.id = u.manager_id
       LEFT JOIN manager_work_state w ON w.manager_id = u.manager_id
       LEFT JOIN employees e ON e.user_id = u.id
       LEFT JOIN employee_secrets s ON (s.user_id = u.id OR (e.id IS NOT NULL AND s.employee_id = e.id))
                                   AND s.superseded_at IS NULL AND s.deleted_at IS NULL
      WHERE u.team_id = $1
      ORDER BY name, u.id`, [a.teamId])).rows;
  const byId = new Map<number, {
    userId: number; name: string; login: string; position: string | null; phone: string | null; email: string | null;
    telegram: string | null; birthDate: string | null; hiredAt: string | null; passwords: number; dashboardKnown: boolean;
  }>();
  for (const r of rows) {
    if (!teamMemberVerdict(a, targetOf(r)).ok) continue;
    let p = byId.get(r.id);
    if (!p) {
      p = { userId: r.id, name: r.name, login: r.login, position: r.position, phone: r.phone, email: r.contact_email,
        telegram: r.telegram, birthDate: r.birth_date, hiredAt: r.hired_at, passwords: 0, dashboardKnown: false };
      byId.set(r.id, p);
    }
    if (r.kind && teamSecretVisible(r.kind)) {
      p.passwords++;
      if (r.service === DASHBOARD_SERVICE) p.dashboardKnown = true;
    }
  }
  return { rows: [...byId.values()], reason: null };
}

/** Картка людини для тімліда: профіль і паролі (без значень, без карток, без видалених і старих версій). */
export async function teamPersonVault(db: Db, actorId: number, userId: number) {
  await assertTeamMember(db, actorId, userId);
  const list = await listTeamPeople(db, actorId);
  const person = list.rows.find((p) => p.userId === userId);
  if (!person) throw new SecretError(404, "Людину не знайдено");
  const e = (await db.query<{ id: number }>(`SELECT id FROM employees WHERE user_id = $1`, [userId])).rows[0];
  const items = (await db.query<{ id: number; kind: string; service: string; label: string | null; login: string | null; updated_at: string }>(
    `SELECT id, kind, service, label, login, created_at AS updated_at
       FROM employee_secrets
      WHERE (user_id = $1 OR ($2::int IS NOT NULL AND employee_id = $2::int)) AND superseded_at IS NULL AND deleted_at IS NULL
      ORDER BY (service = $3) DESC, service, id`, [userId, e?.id ?? null, DASHBOARD_SERVICE])).rows
    .filter((i) => teamSecretVisible(i.kind));
  return { person, items };
}

/** Код показу чи показ: запис сейфу мусить бути паролем людини з команди тімліда. */
export async function assertTeamSecret(db: Db, actorId: number, secretId: number): Promise<void> {
  const s = (await db.query<{ kind: string; user_id: number | null; owner_user: number | null }>(
    `SELECT s.kind, s.user_id, e.user_id AS owner_user
       FROM employee_secrets s LEFT JOIN employees e ON e.id = s.employee_id WHERE s.id = $1`, [secretId])).rows[0];
  if (!s) throw new SecretError(404, "Запис не знайдено");
  const owner = s.user_id ?? s.owner_user;
  if (owner == null) throw new SecretError(403, "Людина без акаунта — не з вашої команди");
  await assertTeamMember(db, actorId, owner);
  if (!teamSecretVisible(s.kind)) throw new SecretError(403, "Картки тімліду не показуються");
}

/**
 * Покласти пароль дашборда в сейф: попередній запис стає історією, новий — поточним. Значення
 * шифрується тут-таки (`insertSecrets`), в аудит іде лише факт.
 */
export async function storeDashboardPassword(db: Db, key: Buffer | null, actorId: number, userId: number, password: string): Promise<number> {
  if (!key) throw new SecretKeyMissing();
  const login = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0]?.email ?? null;
  await db.query(
    `UPDATE employee_secrets SET superseded_at = now()
      WHERE user_id = $1 AND kind = 'password' AND service = $2 AND superseded_at IS NULL AND deleted_at IS NULL`,
    [userId, DASHBOARD_SERVICE]);
  const o = await ownerOf(db, userId);
  return (await insertSecrets(db, key, actorId, o, [prepareSecret({ kind: "password", service: DASHBOARD_SERVICE, login, value: password })]))[0];
}

/**
 * Скинути пароль дашборда людині з команди: новий хеш у `users`, значення — у сейф, відповідь —
 * значення ОДИН раз. Без ключа сейфу не скидаємо: тімлід отримав би пароль, якого більше ніде
 * немає, і наступне «Показати» вже нічого б не знайшло.
 */
export async function resetTeamPassword(db: Db, key: Buffer | null, actorId: number, userId: number): Promise<{ password: string }> {
  if (!key) throw new SecretKeyMissing();
  await assertTeamMember(db, actorId, userId);
  const password = randomBytes(9).toString("base64url");
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await bcrypt.hash(password, 10), userId]);
  await storeDashboardPassword(db, key, actorId, userId, password);
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), 'user.reset_password', 'user', $2::text, (SELECT email FROM users WHERE id = $3), $4)`,
    [actorId, String(userId), userId, { by: "team_lead" }]);
  return { password };
}
