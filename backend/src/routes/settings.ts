import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { provisionUsers, resetPassword, generatePassword } from "../db/userProvisioning.js";
import { roleHasPerm, getRoleDef, refreshRoles } from "../auth/rbac.js";
import { wouldOrphanAdmin, otherActiveAdminCount } from "../auth/adminGuard.js";
import { writeAudit } from "../db/audit.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

export interface AppSettings {
  loyaltyThreshold: number; // paid orders to count as a "regular" client
  loyaltyWindowMonths: number; // window for the threshold
  sleepingWindowMonths: number; // lapsed-but-recoverable lookback
  receivablesOverdueWarnDays: number; // highlight debt overdue beyond this
  // Базовий тариф калькулятора ставок (грн/км), коли заявок по напрямку немає:
  // окремо ціла машина і догруз («зелена зона» з карти прорахунку).
  ratesFallbackFullPerKm: number;
  ratesFallbackPartPerKm: number;
  // Значення поля «Источник клиента» (2098035), що рахуються як «прийнята
  // реклама» в повному циклі (KPI ads_count). Ручний метод КВП: 6 сайтових
  // джерел. Admin-редаговане — можна додавати/прибирати без правок коду.
  adSources: string[];
  // Мʼяка нижня межа місячного плану на менеджера (₴). НЕ заборона: план нижчий
  // допускається з обґрунтуванням (напр. менеджер вийшов у середині місяця), але
  // тоді картка йде до затверджувача з бейджем. У налаштуваннях, а не в коді, —
  // щоб КВП міняв поріг без деплою.
  planMinPerManager: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  loyaltyThreshold: 2,
  loyaltyWindowMonths: 2,
  sleepingWindowMonths: 6,
  receivablesOverdueWarnDays: 0,
  ratesFallbackFullPerKm: 25,
  ratesFallbackPartPerKm: 15,
  // §3b словника: adSources НЕ має дефолту в коді — список живе в БД
  // (сид у schema.sql). Відсутність = помилка конфігурації, видима як [].
  adSources: [] as string[],
  planMinPerManager: 30000,
};

/** Reads the persisted settings merged over defaults. */
export async function getSettings(): Promise<AppSettings> {
  const result = await pool.query<{ data: Partial<AppSettings> }>(
    `SELECT data FROM app_settings WHERE id = 1`
  );
  const merged = { ...DEFAULT_SETTINGS, ...(result.rows[0]?.data ?? {}) };
  // §3b: adSources БЕЗ code-fallback. Порожній список = помилка конфігурації
  // (метрики реклами видимо занулюються, а не тихо рахуються «якимось» списком).
  if (!Array.isArray(merged.adSources) || merged.adSources.length === 0) {
    console.error("КОНФІГ-ПОМИЛКА: adSources порожній у app_settings — рекламні метрики = 0. Прогони migrate (сид у schema.sql).");
    merged.adSources = [];
  }
  return merged;
}

settingsRouter.get("/", async (_req, res) => {
  res.json({ settings: await getSettings() });
});

settingsRouter.put("/", async (req, res) => {
  if (req.auth!.role !== "admin") {
    return res.status(403).json({ error: "Лише адміністратор може змінювати налаштування" });
  }

  const body = req.body ?? {};
  const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const current = await getSettings();
  const next: AppSettings = {
    loyaltyThreshold: clampInt(body.loyaltyThreshold, 1, 50, current.loyaltyThreshold),
    loyaltyWindowMonths: clampInt(body.loyaltyWindowMonths, 1, 24, current.loyaltyWindowMonths),
    sleepingWindowMonths: clampInt(body.sleepingWindowMonths, 1, 36, current.sleepingWindowMonths),
    receivablesOverdueWarnDays: clampInt(body.receivablesOverdueWarnDays, 0, 365, current.receivablesOverdueWarnDays),
    ratesFallbackFullPerKm: clampInt(body.ratesFallbackFullPerKm, 1, 500, current.ratesFallbackFullPerKm),
    ratesFallbackPartPerKm: clampInt(body.ratesFallbackPartPerKm, 1, 500, current.ratesFallbackPartPerKm),
    // 0 = вимкнути перевірку зовсім; стеля 1 млн, щоб помилковий ввід не заблокував подачу.
    planMinPerManager: clampInt(body.planMinPerManager, 0, 1_000_000, current.planMinPerManager),
    adSources: Array.isArray(body.adSources)
      ? [...new Set((body.adSources as unknown[]).map((s) => String(s).trim()).filter((s) => s.length > 0))]
      : current.adSources,
  };

  // §3b словника: зміна adSources журналюється (хто/коли/було→стало).
  const listChanged = JSON.stringify(current.adSources) !== JSON.stringify(next.adSources);
  await pool.query(
    `UPDATE app_settings SET data = $1 WHERE id = 1`,
    [JSON.stringify(next)]
  );
  if (listChanged) {
    await pool.query(
      `INSERT INTO ad_sources_log (changed_by, old_list, new_list) VALUES ($1, $2, $3)`,
      [`user:${req.auth!.userId}`, JSON.stringify(current.adSources), JSON.stringify(next.adSources)]
    );
  }
  res.json({ settings: next });
});

// --- User & role management (право manage_users) ---
// Гейт вкладки «Налаштування» вже відсіює чужі ролі (requireAuth tab-gate); тут додатково
// вимагаємо право manage_users, щоб кастомна роль без нього не керувала людьми.
function requireManageUsers(req: import("express").Request, res: import("express").Response): boolean {
  if (!roleHasPerm(req.auth!.roleKey, "manage_users")) {
    res.status(403).json({ error: "Немає права керувати користувачами й ролями" });
    return false;
  }
  return true;
}
// Скидання пароля — ОКРЕМЕ право, відділене від manage_users: дозволяємо тільки
// довіреним (ceo/opdir/admin), тоді як керування ролями/юзерами (manage_users) — ширше.
function requireResetPasswords(req: import("express").Request, res: import("express").Response): boolean {
  if (!roleHasPerm(req.auth!.roleKey, "reset_passwords")) {
    res.status(403).json({ error: "Немає права скидати паролі" });
    return false;
  }
  return true;
}
const audit = (req: import("express").Request) => ({ actorUserId: req.auth!.userId, actorEmail: req.auth!.email ?? null });

// Список: за замовч. лише АКТИВНІ; ?archived=1 → деактивовані (Архів) з причиною/датою.
// Пароль НЕ віддаємо (лише bcrypt-хеш у БД). Ефективна роль = COALESCE(role_override, role).
settingsRouter.get("/users", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const archived = req.query.archived === "1" || req.query.archived === "true";
  const result = await pool.query(
    `SELECT u.id, u.email,
            COALESCE(m.name, u.full_name, CASE WHEN COALESCE(u.role_override,u.role)='admin' THEN 'Операційний директор' END) AS name,
            u.role AS synced_role, u.role_override,
            COALESCE(u.role_override, u.role) AS role_effective,
            u.is_active, u.deactivated_at, u.deactivated_reason,
            (u.manager_id IS NOT NULL) AS crm_linked,
            t.name AS team_name
     FROM users u
     LEFT JOIN managers m ON m.id = u.manager_id
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.is_active = $1
     ORDER BY COALESCE(u.role_override,u.role)='admin' DESC, t.name NULLS LAST, u.email`,
    [!archived]
  );
  res.json({ users: result.rows });
});

// Ручний користувач: ПІБ + email + пароль(опц.) + роль + команда. manager_id=NULL (не з CRM).
// Роль кладемо в role_override (users.role має CHECK admin|team_lead|manager і не тримає custom).
settingsRouter.post("/users", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const fullName = String(req.body?.fullName ?? req.body?.name ?? "").trim() || null;
  const teamId = req.body?.teamId ? Number(req.body.teamId) : null;
  const roleKey = String(req.body?.role ?? "manager");
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Невірний e-mail" });
  if (!getRoleDef(roleKey)) return res.status(400).json({ error: "Невідома роль" });
  const exists = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (exists.rowCount) return res.status(409).json({ error: "Користувач з таким e-mail вже існує" });

  const password = String(req.body?.password ?? "").trim() || generatePassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, role_override, team_id, full_name, is_active)
     VALUES ($1, $2, 'manager', $3, $4, $5, true) RETURNING id`,
    [email, passwordHash, roleKey, teamId, fullName]
  );
  await writeAudit({ ...audit(req), action: "user.create", targetType: "user", targetId: String(ins.rows[0].id), targetLabel: email, details: { role: roleKey, manual: true } });
  res.json({ email, password }); // пароль повертаємо ОДИН раз
});

settingsRouter.post("/users/provision", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const created = await provisionUsers();
  res.json({ created });
});

settingsRouter.post("/users/:id/reset-password", async (req, res) => {
  if (!requireResetPasswords(req, res)) return;
  const id = Number(req.params.id);
  const u = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id=$1`, [id]);
  if (!u.rows[0]) return res.status(404).json({ error: "Користувача не знайдено" });
  const password = await resetPassword(id);
  await writeAudit({ ...audit(req), action: "user.reset_password", targetType: "user", targetId: String(id), targetLabel: u.rows[0].email });
  res.json({ password }); // ОДИН раз; у БД лише хеш
});

// Реактивація РУЧНОГО користувача (CRM-менеджер відновлюється поверненням у CRM → синк).
settingsRouter.post("/users/:id/reactivate", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const id = Number(req.params.id);
  const cur = await pool.query<{ email: string; manager_id: number | null }>(`SELECT email, manager_id FROM users WHERE id=$1`, [id]);
  if (!cur.rows[0]) return res.status(404).json({ error: "Користувача не знайдено" });
  if (cur.rows[0].manager_id !== null) {
    return res.status(400).json({ error: "CRM-менеджер відновлюється поверненням у CRM (синк активує автоматично)" });
  }
  await pool.query(`UPDATE users SET is_active=true, deactivated_at=NULL, deactivated_reason=NULL WHERE id=$1`, [id]);
  await writeAudit({ ...audit(req), action: "user.reactivate", targetType: "user", targetId: String(id), targetLabel: cur.rows[0].email });
  res.json({ ok: true });
});

// Зміна override-ролі / активності / ПІБ(ручним). Само-блокування → 409.
settingsRouter.patch("/users/:id", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const id = Number(req.params.id);
  const cur = await pool.query<{ email: string; role: string; role_override: string | null; is_active: boolean; manager_id: number | null; full_name: string | null }>(
    `SELECT email, role, role_override, is_active, manager_id, full_name FROM users WHERE id = $1`, [id]
  );
  if (!cur.rows[0]) return res.status(404).json({ error: "Користувача не знайдено" });
  const c = cur.rows[0];

  // role_override: null (revert до синкнутої) або існуючий roles.key.
  let newOverride = c.role_override;
  if ("roleOverride" in req.body) {
    const ro = req.body.roleOverride;
    if (ro === null || ro === "") newOverride = null;
    else if (typeof ro === "string" && getRoleDef(ro)) newOverride = ro;
    else return res.status(400).json({ error: "Невідома роль" });
  }
  const newActive = typeof req.body.isActive === "boolean" ? req.body.isActive : c.is_active;

  // Само-блокування (409): чисте рішення в adminGuard.wouldOrphanAdmin.
  const curEff = c.role_override ?? c.role;
  const newEff = newOverride ?? c.role;
  const targetIsActiveAdmin = c.is_active && curEff === "admin";
  const changeRemovesAdmin = targetIsActiveAdmin && (newEff !== "admin" || newActive === false);
  if (changeRemovesAdmin) {
    const others = await otherActiveAdminCount(id);
    const g = wouldOrphanAdmin({ actorUserId: req.auth!.userId, targetUserId: id, targetIsActiveAdmin, changeRemovesAdmin, otherActiveAdmins: others });
    if (g.block) {
      return res.status(409).json({ error: g.reason === "self" ? "Не можна розжалувати/деактивувати самого себе (адміна)" : "Не можна зняти останнього активного адміністратора" });
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if ("roleOverride" in req.body) { params.push(newOverride); sets.push(`role_override = $${params.length}`); }
  if (typeof req.body.isActive === "boolean") {
    params.push(newActive); sets.push(`is_active = $${params.length}`);
    if (!newActive) { params.push(String(req.body.reason ?? "деактивовано адміном").slice(0, 300)); sets.push(`deactivated_reason = $${params.length}`); sets.push(`deactivated_at = now()`); }
    else { sets.push(`deactivated_at = NULL`); sets.push(`deactivated_reason = NULL`); }
  }
  // ПІБ — ЛИШЕ для РУЧНИХ (не-CRM). Серверний інваріант (не покладаємось на FE):
  // CRM-ім'я перезапише синк, тож редагувати його безглуздо → 400. Порожнє ім'я → 400.
  let renamed: { from: string | null; to: string } | null = null;
  const rawName = req.body.fullName ?? req.body.name;
  if (rawName !== undefined) {
    if (typeof rawName !== "string" || !rawName.trim()) return res.status(400).json({ error: "Ім'я не може бути порожнім" });
    if (c.manager_id !== null) return res.status(400).json({ error: "ПІБ CRM-менеджера редагується лише в CRM (синк перезапише зміну)" });
    const to = rawName.trim();
    params.push(to); sets.push(`full_name = $${params.length}`);
    renamed = { from: c.full_name, to };
  }
  if (sets.length === 0) return res.json({ ok: true });
  params.push(id);
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);

  const action = typeof req.body.isActive === "boolean" && !newActive ? "user.deactivate" : (renamed ? "user.rename" : "user.update");
  await writeAudit({ ...audit(req), action, targetType: "user", targetId: String(id), targetLabel: c.email, details: { role_override: newOverride, is_active: newActive, ...(renamed ? { renamed } : {}) } });
  res.json({ ok: true });
});

// --- Ролі та доступи (право manage_users; вбудовані не видаляються/не перейменовуються) ---
settingsRouter.get("/roles", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const r = await pool.query(
    `SELECT key, name, built_in, data_scope, screen_access, permissions, cloned_from,
            (SELECT count(*)::int FROM users u WHERE COALESCE(u.role_override,u.role)=roles.key AND u.is_active) AS users_count
     FROM roles ORDER BY built_in DESC, name`
  );
  res.json({ roles: r.rows });
});

function validRolePayload(b: Record<string, unknown>) {
  const dataScope = ["own", "team", "company"].includes(String(b.dataScope)) ? String(b.dataScope) : "own";
  const screen = (b.screenAccess && typeof b.screenAccess === "object") ? b.screenAccess : {};
  const perms = (b.permissions && typeof b.permissions === "object") ? b.permissions : {};
  return { dataScope, screen, perms };
}

// Створення/клонування кастомної ролі.
settingsRouter.post("/roles", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const key = String(req.body?.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const name = String(req.body?.name ?? "").trim();
  if (!key || !name) return res.status(400).json({ error: "Потрібні ключ і назва" });
  if (getRoleDef(key)) return res.status(409).json({ error: "Роль з таким ключем уже існує" });
  const clonedFrom = typeof req.body?.cloneFrom === "string" ? req.body.cloneFrom : null;
  const base = clonedFrom ? getRoleDef(clonedFrom) : null;
  const { dataScope, screen, perms } = validRolePayload(req.body ?? {});
  await pool.query(
    `INSERT INTO roles (key, name, built_in, data_scope, screen_access, permissions, cloned_from)
     VALUES ($1,$2,false,$3,$4,$5,$6)`,
    [key, name, base ? base.dataScope : dataScope, JSON.stringify(base ? base.screenAccess : screen), JSON.stringify(base ? base.permissions : perms), clonedFrom]
  );
  await refreshRoles();
  await writeAudit({ ...audit(req), action: clonedFrom ? "role.clone" : "role.create", targetType: "role", targetId: key, targetLabel: name, details: { clonedFrom } });
  res.json({ ok: true, key });
});

// Редагування — ЛИШЕ кастомних (вбудовані 🔒).
settingsRouter.put("/roles/:key", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const key = req.params.key;
  const def = getRoleDef(key);
  if (!def) return res.status(404).json({ error: "Роль не знайдено" });
  if (def.builtIn) return res.status(403).json({ error: "Вбудовану роль змінювати не можна" });
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : def.name;
  const { dataScope, screen, perms } = validRolePayload(req.body ?? {});
  await pool.query(
    `UPDATE roles SET name=$1, data_scope=$2, screen_access=$3, permissions=$4 WHERE key=$5`,
    [name, dataScope, JSON.stringify(screen), JSON.stringify(perms), key]
  );
  await refreshRoles();
  await writeAudit({ ...audit(req), action: "role.update", targetType: "role", targetId: key, targetLabel: name });
  res.json({ ok: true });
});

// Видалення — ЛИШЕ кастомних і лише якщо нікому не призначена.
settingsRouter.delete("/roles/:key", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const key = req.params.key;
  const def = getRoleDef(key);
  if (!def) return res.status(404).json({ error: "Роль не знайдено" });
  if (def.builtIn) return res.status(403).json({ error: "Вбудовану роль видалити не можна" });
  const used = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM users WHERE role_override=$1`, [key]);
  if (used.rows[0].n > 0) return res.status(409).json({ error: `Роль призначена ${used.rows[0].n} користувач(ам) — спершу зніміть` });
  await pool.query(`DELETE FROM roles WHERE key=$1`, [key]);
  await refreshRoles();
  await writeAudit({ ...audit(req), action: "role.delete", targetType: "role", targetId: key, targetLabel: def.name });
  res.json({ ok: true });
});

// Журнал змін.
settingsRouter.get("/audit", async (req, res) => {
  if (!requireManageUsers(req, res)) return;
  const r = await pool.query(
    `SELECT id, at, actor_email, action, target_type, target_id, target_label, details
     FROM access_audit ORDER BY at DESC LIMIT 500`
  );
  res.json({ audit: r.rows });
});
