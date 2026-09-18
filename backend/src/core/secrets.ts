/**
 * 🔐 СЕЙФ ДОСТУПІВ — ОПЕРАЦІЇ З БАЗОЮ (18.09.2026). Правила й шифр — `secretBox.ts`.
 *
 * Зʼєднання, ключ і «як надіслати в Telegram» — параметрами: `db/pool`, `.env` і бот тут не
 * імпортуються, тож гейти ганяють усе це на scratch-кластері з власним ключем і фальшивим ботом.
 *
 * 🔴 ЗНАЧЕННЯ (пароль, повний номер картки) ВИХОДИТЬ ЗВІДСИ РІВНО В ОДНОМУ МІСЦІ — `revealSecret`,
 * після коду. Списки, картка людини, журнал і аудит його не містять за побудовою: відповідь
 * складається з явно названих полів, а колонки шифру в них не вибираються взагалі.
 */
import {
  aadFor, seal, unseal, normalizeCard, cardLast4, newRevealCode, newSalt, hashCode, verifyRevealCode, revealCodeMessage,
  KEY_VERSION, REVEAL_CODE_TTL_MS, REVEAL_SECONDS, LINK_CODE_TTL_MS, SERVICE_LABEL, CARD_SERVICE, SecretKeyMissing,
} from "./secretBox.js";
import { linkTokenState } from "./signCode.js";

export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}
export type Send = (chatId: number | string, text: string) => Promise<boolean>;

export class SecretError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const NAME = `COALESCE(NULLIF(u.full_name, ''), m.name, u.email)`;

/** Запис в аудит доступів (та сама таблиця, що `db/audit.ts`), але через передане зʼєднання. */
async function audit(db: Db, actorId: number, action: string, target: { id: number | string; label: string | null }, details: Record<string, unknown>) {
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), $2, 'user', $3, $4, $5)`,
    [actorId, action, String(target.id), target.label, details]);
}

async function person(db: Db, userId: number) {
  const p = (await db.query<{ id: number; name: string; email: string; team_name: string | null; role: string; is_active: boolean }>(
    `SELECT u.id, ${NAME} AS name, u.email, t.name AS team_name, COALESCE(u.role_override, u.role) AS role, u.is_active
       FROM users u LEFT JOIN managers m ON m.id = u.manager_id LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = $1`, [userId])).rows[0];
  if (!p) throw new SecretError(404, "Співробітника не знайдено");
  return p;
}

/**
 * ВЛАСНИК ЗАПИСУ (18.09.2026): акаунт дашборда (`user_id`) АБО людина реєстру без акаунта (`employee_id`).
 * Посилання — `"12"` / `"u12"` (акаунт) або `"e34"` (людина реєстру). Людина реєстру З акаунтом
 * тримає записи на акаунті — як і до реєстру; `employee_id` лише для тих, у кого акаунта немає.
 * AAD різниться (`…:12:…` проти `…:e34:…`), тож шифр однієї не розшифрується як шифр іншої.
 */
export interface Owner { userId: number | null; employeeId: number | null; name: string; ref: string }

export function parseRef(ref: unknown): { user: number } | { employee: number } {
  const m = /^(u|e)?(\d+)$/.exec(String(ref ?? "").trim());
  if (!m || Number(m[2]) <= 0) throw new SecretError(400, "Некоректний id співробітника");
  return m[1] === "e" ? { employee: Number(m[2]) } : { user: Number(m[2]) };
}

export async function ownerOf(db: Db, ref: unknown): Promise<Owner> {
  const r = parseRef(typeof ref === "number" ? String(ref) : ref);
  if ("user" in r) {
    const p = await person(db, r.user);
    const e = (await db.query<{ id: number }>(`SELECT id FROM employees WHERE user_id = $1`, [p.id])).rows[0];
    return { userId: p.id, employeeId: e?.id ?? null, name: p.name, ref: String(p.id) };
  }
  const e = (await db.query<{ id: number; full_name: string; user_id: number | null }>(
    `SELECT id, full_name, user_id FROM employees WHERE id = $1`, [r.employee])).rows[0];
  if (!e) throw new SecretError(404, "Співробітника не знайдено");
  if (e.user_id != null) return ownerOf(db, e.user_id);
  return { userId: null, employeeId: e.id, name: e.full_name, ref: `e${e.id}` };
}

/** Власник рядка сейфу — для аудиту й повідомлення в Telegram. */
async function ownerOfRow(db: Db, s: { user_id: number | null; employee_id: number | null }): Promise<Owner> {
  return s.user_id != null ? ownerOf(db, s.user_id) : ownerOf(db, `e${s.employee_id}`);
}

/** AAD рядка: для акаунта — як і було, для людини реєстру — з префіксом `e`. */
export const aadOfRow = (s: { user_id: number | null; employee_id: number | null; kind: string; service: string }) =>
  s.user_id != null ? aadFor(s.user_id, s.kind, s.service) : `uts-secret:v1:e${s.employee_id}:${s.kind}:${s.service}`;

/** Список людей: хто, команда, скільки записів. Без жодного значення. */
export async function listPeople(db: Db) {
  return (await db.query(
    `SELECT 'e' || e.id AS ref, COALESCE(u.id, NULL) AS id, e.full_name AS name, COALESCE(e.email, u.email) AS email,
            COALESCE(t.name, e.team_label) AS team_name, COALESCE(u.role_override, u.role) AS role, e.status, (u.id IS NOT NULL) AS has_account,
            count(s.id) FILTER (WHERE s.kind = 'password')::int AS passwords,
            count(s.id) FILTER (WHERE s.kind = 'card')::int AS cards, max(s.created_at) AS updated_at
       FROM employees e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN employee_secrets s ON (s.user_id = e.user_id OR s.employee_id = e.id) AND s.superseded_at IS NULL AND s.deleted_at IS NULL
      GROUP BY e.id, u.id, t.name
     UNION ALL
     SELECT u.id::text AS ref, u.id, ${NAME} AS name, u.email, t.name AS team_name, COALESCE(u.role_override, u.role) AS role,
            'active' AS status, true AS has_account,
            count(s.id) FILTER (WHERE s.kind = 'password')::int AS passwords,
            count(s.id) FILTER (WHERE s.kind = 'card')::int AS cards, max(s.created_at) AS updated_at
       FROM users u LEFT JOIN managers m ON m.id = u.manager_id LEFT JOIN teams t ON t.id = u.team_id
       LEFT JOIN employee_secrets s ON s.user_id = u.id AND s.superseded_at IS NULL AND s.deleted_at IS NULL
      WHERE u.is_active AND COALESCE(u.role_override, u.role) <> 'candidate'
        AND NOT EXISTS (SELECT 1 FROM employees e2 WHERE e2.user_id = u.id)
      GROUP BY u.id, m.name, t.name
      ORDER BY name`)).rows;
}

/** Картка людини: записи (без значень), видалені (для «Відновити») і журнал показів. */
export async function personVault(db: Db, ref: number | string) {
  const o = await ownerOf(db, ref);
  const items = (await db.query(
    `SELECT s.id, s.kind, s.service, s.label, s.login, s.last4, s.created_at AS updated_at, s.deleted_at,
            COALESCE(NULLIF(cu.full_name, ''), cm.name, cu.email) AS updated_by,
            (SELECT count(*)::int FROM employee_secrets h WHERE (h.user_id = s.user_id OR h.employee_id = s.employee_id) AND h.kind = s.kind
               AND h.service = s.service AND COALESCE(h.label, '') = COALESCE(s.label, '')) AS versions
       FROM employee_secrets s LEFT JOIN users cu ON cu.id = s.created_by LEFT JOIN managers cm ON cm.id = cu.manager_id
      WHERE (s.user_id = $1 OR s.employee_id = $2) AND s.superseded_at IS NULL
      ORDER BY s.deleted_at NULLS FIRST, s.kind DESC, s.service, s.id`, [o.userId, o.employeeId])).rows;
  const journal = (await db.query(
    `SELECT a.id, a.at, a.action, COALESCE(NULLIF(u.full_name, ''), m.name, a.actor_email) AS actor,
            a.details->>'service' AS service, a.details->>'reason' AS reason
       FROM access_audit a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN managers m ON m.id = u.manager_id
      WHERE a.target_type = 'user' AND a.target_id = ANY($1::text[]) AND a.action LIKE 'secret.%'
      ORDER BY a.at DESC, a.id DESC LIMIT 100`, [[o.userId != null ? String(o.userId) : "-", o.employeeId != null ? `e${o.employeeId}` : "-"]])).rows;
  const p = o.userId != null ? await person(db, o.userId) : null;
  return { person: { id: o.userId, ref: o.ref, name: o.name, email: p?.email ?? null, team_name: p?.team_name ?? null, role: p?.role ?? null, hasAccount: o.userId != null }, items, journal };
}

/** Правила одного запису — спільні для «+ Додати» і імпорту. Кидає `SecretError(400)`; значення не логується. */
export function prepareSecret(b: Record<string, unknown>) {
  const kind = b.kind === "card" ? "card" : b.kind === "password" ? "password" : null;
  if (!kind) throw new SecretError(400, "Тип: пароль або картка");
  let service: string, value: string, last4: string | null = null;
  if (kind === "card") {
    const digits = normalizeCard(b.value);
    if (!digits) throw new SecretError(400, "Номер картки — 12–19 цифр");
    service = CARD_SERVICE; value = digits; last4 = cardLast4(digits);
  } else {
    service = str(b.service) ?? "";
    if (!(service in SERVICE_LABEL)) throw new SecretError(400, "Оберіть сервіс");
    const v = typeof b.value === "string" ? b.value : "";
    if (!v) throw new SecretError(400, "Пароль порожній");
    if (v.length > 500) throw new SecretError(400, "Пароль задовгий");
    value = v;
  }
  const label = str(b.label);
  if (service === "other" && !label) throw new SecretError(400, "Для «Інше» вкажіть назву сервісу");
  return { kind, service, value, last4, label, login: str(b.login) };
}

/**
 * Кілька записів ОДНОГО власника — одним вставленням і одним записом аудиту на кожен (імпорт, 18.09.2026:
 * 1554 записи по одному йшли 3 хв і браузер не дочікувався відповіді). Ті самі правила й AAD, що в `createSecret`.
 */
export async function insertSecrets(db: Db, key: Buffer | null, actorId: number, o: Owner, items: ReturnType<typeof prepareSecret>[]): Promise<number[]> {
  if (!key) throw new SecretKeyMissing();
  if (!items.length) return [];
  const row = { user_id: o.userId, employee_id: o.userId == null ? o.employeeId : null };
  const vals: unknown[] = [], tuples: string[] = [];
  for (const it of items) {
    const box = seal(key, it.value, aadOfRow({ ...row, kind: it.kind, service: it.service }));
    const b = vals.length;
    vals.push(row.user_id, row.employee_id, it.kind, it.service, it.label, it.login, it.last4, box.cipher, box.iv, box.tag, KEY_VERSION, actorId);
    tuples.push(`(${Array.from({ length: 12 }, (_, k) => `$${b + k + 1}`).join(",")})`);
  }
  const ids = (await db.query<{ id: number }>(
    `INSERT INTO employee_secrets (user_id, employee_id, kind, service, label, login, last4, cipher, iv, tag, key_version, created_by)
     VALUES ${tuples.join(",")} RETURNING id`, vals)).rows.map((r) => r.id);
  const av: unknown[] = [actorId, o.ref, o.name], at: string[] = [];
  items.forEach((it, k) => { av.push({ secretId: ids[k], kind: it.kind, service: it.service, label: it.label }); at.push(`($1, (SELECT email FROM users WHERE id = $1), 'secret.create', 'user', $2, $3, $${av.length})`); });
  await db.query(`INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details) VALUES ${at.join(",")}`, av);
  return ids;
}

/** Додати запис. Пароль/номер шифрується тут-таки; у відповіді й аудиті його немає. */
export async function createSecret(db: Db, key: Buffer | null, actorId: number, ref: number | string, b: Record<string, unknown>): Promise<number> {
  if (!key) throw new SecretKeyMissing();
  const o = await ownerOf(db, ref);
  return (await insertSecrets(db, key, actorId, o, [prepareSecret(b)]))[0];
}

async function lockSecret(db: Db, id: number) {
  const s = (await db.query<{ id: number; user_id: number | null; employee_id: number | null; kind: string; service: string; label: string | null; login: string | null;
    last4: string | null; cipher: string; iv: string; tag: string; superseded_at: string | null; deleted_at: string | null }>(
    `SELECT id, user_id, employee_id, kind, service, label, login, last4, cipher, iv, tag, superseded_at, deleted_at
       FROM employee_secrets WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!s) throw new SecretError(404, "Запис не знайдено");
  return s;
}

/**
 * Змінити логін і/або значення. Нове значення — НОВИЙ рядок, старий стає історією: при звільненні
 * так видно, що пароль справді змінено, і коли.
 */
export async function updateSecret(db: Db, key: Buffer | null, actorId: number, id: number, b: Record<string, unknown>): Promise<number> {
  if (!key) throw new SecretKeyMissing();
  const s = await lockSecret(db, id);
  if (s.superseded_at || s.deleted_at) throw new SecretError(409, "Це вже не поточна версія запису");
  const p = await ownerOfRow(db, s);
  const login = b.login !== undefined ? str(b.login) : s.login;
  let box = { cipher: s.cipher, iv: s.iv, tag: s.tag }, last4 = s.last4, changedValue = false;
  if (b.value !== undefined && b.value !== "") {
    let value: string;
    if (s.kind === "card") {
      const digits = normalizeCard(b.value);
      if (!digits) throw new SecretError(400, "Номер картки — 12–19 цифр");
      value = digits; last4 = cardLast4(digits);
    } else {
      if (typeof b.value !== "string" || b.value.length > 500) throw new SecretError(400, "Некоректний пароль");
      value = b.value;
    }
    box = seal(key, value, aadOfRow(s));
    changedValue = true;
  }
  if (!changedValue && login === s.login) throw new SecretError(400, "Нічого не змінилось");
  await db.query(`UPDATE employee_secrets SET superseded_at = now() WHERE id = $1`, [id]);
  const r = await db.query<{ id: number }>(
    `INSERT INTO employee_secrets (user_id, employee_id, kind, service, label, login, last4, cipher, iv, tag, key_version, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [s.user_id, s.employee_id, s.kind, s.service, s.label, login, last4, box.cipher, box.iv, box.tag, KEY_VERSION, actorId]);
  await audit(db, actorId, "secret.update", { id: p.ref, label: p.name },
    { secretId: r.rows[0].id, previousId: id, kind: s.kind, service: s.service, valueChanged: changedValue });
  return r.rows[0].id;
}

/** Видалити / відновити (мʼяко, скасовно — правило 06.08.2026). */
export async function setSecretDeleted(db: Db, actorId: number, id: number, deleted: boolean) {
  const s = await lockSecret(db, id);
  if (s.superseded_at) throw new SecretError(409, "Це вже не поточна версія запису");
  if (deleted === (s.deleted_at != null)) throw new SecretError(409, deleted ? "Запис уже видалено" : "Запис не видалено");
  await db.query(`UPDATE employee_secrets SET deleted_at = ${deleted ? "now()" : "NULL"}, deleted_by = ${deleted ? "$2" : "NULL"} WHERE id = $1`,
    deleted ? [id, actorId] : [id]);
  const p = await ownerOfRow(db, s);
  await audit(db, actorId, deleted ? "secret.delete" : "secret.restore", { id: p.ref, label: p.name }, { secretId: id, kind: s.kind, service: s.service });
}

const whatOf = (s: { kind: string; service: string; label: string | null; last4: string | null }) =>
  s.kind === "card" ? `Картка •••• ${s.last4 ?? "????"}` : s.service === "other" ? (s.label ?? "Інше") : (SERVICE_LABEL[s.service] ?? s.service);

/** Надіслати код показу в Telegram «UTS Сейф» ТОГО, хто дивиться. */
export async function sendRevealCode(db: Db, actorId: number, id: number, send: Send | null): Promise<{ expiresInSec: number }> {
  if (!send) throw new SecretError(503, "Бот «UTS Сейф» не налаштований на сервері");
  const chat = (await db.query<{ vault_chat_id: string | null }>(`SELECT vault_chat_id FROM users WHERE id = $1`, [actorId])).rows[0]?.vault_chat_id;
  if (!chat) throw new SecretError(409, "Спершу привʼяжіть Telegram до бота «UTS Сейф» — кнопка у вкладці «Доступи»", { needLink: true });
  const s = await lockSecret(db, id);
  if (s.superseded_at || s.deleted_at) throw new SecretError(409, "Це вже не поточна версія запису");
  const p = await ownerOfRow(db, s);
  await db.query(`UPDATE secret_reveal_codes SET used_at = now() WHERE actor_id = $1 AND secret_id = $2 AND used_at IS NULL`, [actorId, id]);
  const code = newRevealCode(), salt = newSalt();
  await db.query(
    `INSERT INTO secret_reveal_codes (actor_id, secret_id, code_hash, salt, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
    [actorId, id, hashCode(code, salt), salt, String(REVEAL_CODE_TTL_MS)]);
  if (!(await send(chat, revealCodeMessage(code, whatOf(s), p.name)))) throw new SecretError(502, "Telegram не відповідає — спробуйте ще раз");
  return { expiresInSec: REVEAL_CODE_TTL_MS / 1000 };
}

/** Показ: правильний код → значення ОДИН раз + запис в аудиті. Хибний код зʼїдає спробу. */
export async function revealSecret(db: Db, key: Buffer | null, actorId: number, id: number, b: { code?: unknown; reason?: unknown }, now = new Date()) {
  if (!key) throw new SecretKeyMissing();
  const s = await lockSecret(db, id);
  if (s.superseded_at || s.deleted_at) throw new SecretError(409, "Це вже не поточна версія запису");
  const c = (await db.query<{ id: number; code_hash: string; salt: string; attempts: number; expires_at: string; used_at: string | null }>(
    `SELECT id, code_hash, salt, attempts, expires_at, used_at FROM secret_reveal_codes
      WHERE actor_id = $1 AND secret_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [actorId, id])).rows[0];
  if (!c) throw new SecretError(400, "Спершу надішліть код у Telegram");
  const v = verifyRevealCode({ codeHash: c.code_hash, salt: c.salt, attempts: c.attempts, expiresAt: c.expires_at, usedAt: c.used_at }, b.code, now);
  if (!v.ok) {
    if (v.status === 403) await db.query(`UPDATE secret_reveal_codes SET attempts = attempts + 1 WHERE id = $1`, [c.id]);
    throw new SecretError(v.status, v.reason, { attemptsLeft: v.attemptsLeft });
  }
  await db.query(`UPDATE secret_reveal_codes SET used_at = now() WHERE id = $1`, [c.id]);
  const value = unseal(key, s, aadOfRow(s));
  const p = await ownerOfRow(db, s);
  const reason = str(b.reason)?.slice(0, 300) ?? null;
  await audit(db, actorId, "secret.reveal", { id: p.ref, label: p.name }, { secretId: id, kind: s.kind, service: whatOf(s), reason });
  return { value, login: s.login, seconds: REVEAL_SECONDS };
}

// ── Привʼязка Telegram до бота «UTS Сейф» ───────────────────────────────────

export async function vaultLinkState(db: Db, userId: number) {
  const r = (await db.query<{ vault_linked_at: string | null }>(`SELECT vault_linked_at FROM users WHERE id = $1`, [userId])).rows[0];
  return { linked: r?.vault_linked_at != null, linkedAt: r?.vault_linked_at ?? null };
}

/** Код привʼязки: 6 цифр, 10 хв, унікальний серед живих. */
export async function createVaultLink(db: Db, userId: number): Promise<{ code: string; expiresInSec: number }> {
  let code = newRevealCode();
  for (let i = 0; i < 5; i++) {
    const clash = await db.query(`SELECT 1 FROM vault_link_codes WHERE code = $1 AND used_at IS NULL AND expires_at > now()`, [code]);
    if (!clash.rowCount) break;
    code = newRevealCode();
  }
  await db.query(`INSERT INTO vault_link_codes (user_id, code, expires_at) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
    [userId, code, String(LINK_CODE_TTL_MS)]);
  return { code, expiresInSec: LINK_CODE_TTL_MS / 1000 };
}

export async function unlinkVault(db: Db, userId: number) {
  await db.query(`UPDATE users SET vault_chat_id = NULL, vault_linked_at = NULL WHERE id = $1`, [userId]);
}

/**
 * Повідомлення в бот: `/start 123456` або просто `123456`. Правильний живий код привʼязує чат до
 * людини ОДИН раз. Повертає текст відповіді боту — вебхук лише надсилає його.
 */
export async function linkVaultChat(db: Db, text: string, chatId: number, now = new Date()): Promise<string> {
  const m = /^\/start(?:@\w+)?\s+(\d{6})$/.exec(text.trim()) ?? /^(\d{6})$/.exec(text.trim());
  if (!m) return "Це бот сейфу доступів дашборда UTS. Щоб привʼязати акаунт: у дашборді відкрийте «Найм» → «Доступи» → «Привʼязати Telegram» і надішліть сюди 6-значний код.";
  const row = (await db.query<{ id: number; user_id: number; expires_at: string; used_at: string | null; name: string }>(
    `SELECT c.id, c.user_id, c.expires_at, c.used_at, ${NAME} AS name
       FROM vault_link_codes c JOIN users u ON u.id = c.user_id LEFT JOIN managers m ON m.id = u.manager_id
      WHERE c.code = $1 AND c.used_at IS NULL ORDER BY c.created_at DESC LIMIT 1`, [m[1]])).rows[0];
  const state = row ? linkTokenState({ expiresAt: row.expires_at, usedAt: row.used_at }, now) : "expired";
  if (!row || state !== "ok") return "Код не підійшов або застарів (діє 10 хвилин). Натисніть «Привʼязати Telegram» у дашборді ще раз.";
  await db.query(`UPDATE vault_link_codes SET used_at = now() WHERE id = $1`, [row.id]);
  await db.query(`UPDATE users SET vault_chat_id = $2, vault_linked_at = now() WHERE id = $1`, [row.user_id, chatId]);
  return `✅ Привʼязано: ${row.name}. Сюди приходитимуть коди для перегляду доступів. Паролів цей бот не надсилає ніколи.`;
}
