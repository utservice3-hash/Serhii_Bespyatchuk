/**
 * 🎓 НАЙМ, ПРОХІД 2a — АКАУНТ КАНДИДАТА, ЗАПРОШЕННЯ, ДОСТУП, ПРОГРЕС (17.09.2026).
 * Правила строку — `hiringTrainingRules.ts`; порядок і відсоток кроків — `trainingProgress.ts`
 * (той самий, що бачить кандидат у «Навчанні»: друга копія розійшлася б мовчки).
 *
 * Як і `hiring.ts`, кожна функція бере зʼєднання параметром і НЕ імпортує `db/pool`.
 */
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { HiringError, LEAD_VISIBLE_SQL, type Db } from "./hiring.js";
import { ensureEmployeeFromCandidate } from "./employeeAdd.js";
import type { HiringAccess, HiringStatus } from "./hiringRules.js";
import {
  CANDIDATE_ACCESS, CLOSE_REASON_LABEL, accessDeadline, accessToClose, trainingDay, trainingHealth, promoteVerdict,
  inviteState, INVITE_STATE_TEXT, newInviteToken, hashInviteToken, looksLikeInviteToken, candidateLogin, passwordProblem, newCandidatePassword,
  type CloseReason, type TrainingHealth,
} from "./hiringTrainingRules.js";
import { orderedMaterials, materialStates, coursePercent, type ProgressMap } from "./trainingProgress.js";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const d = (v: unknown): Date | null => (v == null ? null : new Date(v as string));

async function event(db: Db, candidateId: number, kind: string, comment: string, actorId: number | null, from?: string, to?: string) {
  await db.query(
    `INSERT INTO hiring_events (candidate_id, kind, from_status, to_status, comment, actor_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [candidateId, kind, from ?? null, to ?? null, comment, actorId]);
}

interface AccountRow {
  id: number; full_name: string | null; email: string | null; status: HiringStatus; team_id: number | null;
  user_id: number | null; account_created_at: string | null; first_login_at: string | null;
  access_extended_days: number; access_closed_at: string | null; access_closed_reason: CloseReason | null;
}
const ACCOUNT_COLS = `c.id, c.full_name, c.email, c.status, c.team_id, c.user_id, c.account_created_at, c.first_login_at,
  c.access_extended_days, c.access_closed_at, c.access_closed_reason`;

/** Рядок кандидата під замком із межею видимості тімліда (та сама, що в картки). */
async function lockAccount(db: Db, id: number, access: HiringAccess, leadTeamId: number | null): Promise<AccountRow> {
  const params: unknown[] = [id];
  let vis = "";
  if (access === "lead") { params.push(leadTeamId ?? -1); vis = ` AND ${LEAD_VISIBLE_SQL("$2")}`; }
  else if (access !== "edit") vis = " AND false";
  const c = (await db.query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM hiring_candidates c WHERE c.id = $1${vis} FOR UPDATE`, params)).rows[0];
  if (!c) throw new HiringError(404, "Кандидата не знайдено");
  return c;
}

/**
 * Акаунт із роллю «Кандидат». Кличеться при переході в «кандидат + команда» тією самою
 * транзакцією. Пароль — випадковий і нікому не відомий: увійти можна лише через запрошення.
 */
export async function ensureCandidateAccount(db: Db, actorId: number | null, candidateId: number): Promise<number> {
  const c = (await db.query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM hiring_candidates c WHERE c.id = $1 FOR UPDATE`, [candidateId])).rows[0];
  if (!c) throw new HiringError(404, "Кандидата не знайдено");
  if (c.user_id) return c.user_id;
  const email = str(c.email)?.toLowerCase() ?? null;
  const taken = email ? ((await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])).rowCount ?? 0) > 0 : false;
  const login = candidateLogin({ email, candidateId, emailTaken: taken });
  const clash = await db.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [login]);
  if (clash.rowCount) throw new HiringError(409, `Логін ${login} уже зайнятий іншим користувачем`);
  const hash = await bcrypt.hash(randomBytes(24).toString("base64url"), 10);
  const u = await db.query<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, role_override, team_id, full_name, is_active)
     VALUES ($1, $2, 'manager', 'candidate', $3, $4, true) RETURNING id`, [login, hash, c.team_id, c.full_name]);
  const userId = u.rows[0].id;
  await db.query(`UPDATE hiring_candidates SET user_id = $1, account_created_at = now(), first_login_at = NULL,
                    access_extended_days = 0, access_closed_at = NULL, access_closed_reason = NULL WHERE id = $2`, [userId, candidateId]);
  await event(db, candidateId, "access", `акаунт створено · логін ${login}`, actorId);
  return userId;
}

/** Закрити доступ: акаунт вимикається, причина — у картці й історії. Повторне закриття — нічого. */
export async function closeCandidateAccess(db: Db, candidateId: number, reason: CloseReason, actorId: number | null): Promise<boolean> {
  const c = (await db.query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM hiring_candidates c WHERE c.id = $1`, [candidateId])).rows[0];
  if (!c?.user_id || c.access_closed_at) return false;
  if (reason !== "manager") {
    await db.query(`UPDATE users SET is_active = false, deactivated_at = now(), deactivated_reason = $1 WHERE id = $2`,
      [`найм: ${CLOSE_REASON_LABEL[reason]}`, c.user_id]);
    await db.query(`UPDATE hiring_invites SET revoked_at = now() WHERE candidate_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [candidateId]);
  }
  await db.query(`UPDATE hiring_candidates SET access_closed_at = now(), access_closed_reason = $1 WHERE id = $2`, [reason, candidateId]);
  await event(db, candidateId, "access", reason === "manager" ? "навчання завершено · роль акаунта «Менеджер»" : `доступ до навчання закрито · ${CLOSE_REASON_LABEL[reason]}`, actorId);
  return true;
}

/**
 * Повернення з «менеджера» (скасовність, правило 06.08.2026): роль акаунта теж повертається
 * в «Кандидат», інакше статус картки й права людини розійшлись би.
 */
export async function undoPromotion(db: Db, candidateId: number, actorId: number | null): Promise<void> {
  const c = (await db.query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM hiring_candidates c WHERE c.id = $1`, [candidateId])).rows[0];
  if (!c?.user_id || c.access_closed_reason !== "manager") return;
  await db.query(`UPDATE users SET role_override = 'candidate' WHERE id = $1`, [c.user_id]);
  await db.query(`UPDATE hiring_candidates SET access_closed_at = NULL, access_closed_reason = NULL WHERE id = $1`, [candidateId]);
  await event(db, candidateId, "access", "роль акаунта повернуто в «Кандидат»", actorId);
}

/** Чи має картка акаунт (для заборони загального переходу в «менеджер»). */
/**
 * Привʼязати НАЯВНИЙ акаунт з роллю «Кандидат» до картки (18.09.2026: `test-candidate@uts.ua` створили в
 * «Налаштуваннях» до того, як зʼявилась картка, і на «На навчанні» його не було видно). Лише «редагування»
 * (Іван, керівництво). Акаунт — роль кандидата, без іншої картки; картка — без акаунта, у статусі
 * «кандидат + команда» або «на навчанні». Тримає #572.
 */
export async function linkCandidateAccount(db: Db, actorId: number | null, candidateId: number, userId: unknown, access: HiringAccess) {
  if (access !== "edit") throw new HiringError(403, "Привʼязувати акаунти може лише HR або керівництво");
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw new HiringError(400, "Оберіть акаунт");
  const c = await lockAccount(db, candidateId, access, null);
  if (c.user_id) throw new HiringError(409, "У кандидата вже є акаунт");
  if (c.status !== "candidate" && c.status !== "training") throw new HiringError(409, "Акаунт привʼязується на статусі «кандидат + команда» або «на навчанні»");
  const u = (await db.query<{ id: number; email: string; role: string }>(
    `SELECT id, email, COALESCE(role_override, role) AS role FROM users WHERE id = $1 FOR UPDATE`, [uid])).rows[0];
  if (!u) throw new HiringError(404, "Акаунт не знайдено");
  if (u.role !== "candidate") throw new HiringError(409, "Це не акаунт кандидата — привʼязати можна лише акаунт із роллю «Кандидат»");
  if ((await db.query(`SELECT 1 FROM hiring_candidates WHERE user_id = $1`, [uid])).rowCount) throw new HiringError(409, "Цей акаунт уже привʼязаний до іншої картки");
  await db.query(`UPDATE hiring_candidates SET user_id = $1, account_created_at = now(), access_extended_days = 0,
                    access_closed_at = NULL, access_closed_reason = NULL WHERE id = $2`, [uid, candidateId]);
  await db.query(`UPDATE users SET team_id = COALESCE($2, team_id), is_active = true WHERE id = $1`, [uid, c.team_id]);
  await event(db, candidateId, "access", `привʼязано наявний акаунт · логін ${u.email}`, actorId);
  return { login: u.email };
}

/** Вільні акаунти з роллю «Кандидат» — ще не привʼязані до жодної картки. */
export async function freeCandidateAccounts(db: Db) {
  return (await db.query<{ id: number; email: string; full_name: string | null; is_active: boolean }>(
    `SELECT u.id, u.email, u.full_name, u.is_active FROM users u
      WHERE COALESCE(u.role_override, u.role) = 'candidate' AND NOT EXISTS (SELECT 1 FROM hiring_candidates c WHERE c.user_id = u.id)
      ORDER BY u.created_at DESC`)).rows;
}

export async function hasAccount(db: Db, candidateId: number): Promise<boolean> {
  return ((await db.query(`SELECT 1 FROM hiring_candidates WHERE id = $1 AND user_id IS NOT NULL`, [candidateId])).rowCount ?? 0) > 0;
}

/** Нове запрошення. Попереднє невикористане гаситься. Токен повертається ОДИН раз. */
export async function issueInvite(db: Db, actorId: number | null, candidateId: number, access: HiringAccess, leadTeamId: number | null) {
  const c = await lockAccount(db, candidateId, access, leadTeamId);
  if (c.status !== "candidate" && c.status !== "training")
    throw new HiringError(409, "Запрошення — для статусів «кандидат + команда» і «на навчанні»");
  if (c.access_closed_at) throw new HiringError(409, `Доступ закрито (${CLOSE_REASON_LABEL[c.access_closed_reason!]}) — спершу «Відновити доступ»`);
  const userId = c.user_id ?? await ensureCandidateAccount(db, actorId, candidateId);
  await db.query(`UPDATE hiring_invites SET revoked_at = now() WHERE candidate_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [candidateId]);
  const token = newInviteToken();
  const r = await db.query<{ expires_at: string }>(
    `INSERT INTO hiring_invites (candidate_id, user_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING expires_at`,
    [candidateId, userId, hashInviteToken(token), actorId, CANDIDATE_ACCESS.inviteHours]);
  const login = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email;
  await event(db, candidateId, "access", `створено посилання-запрошення (чинне ${CANDIDATE_ACCESS.inviteHours} год)`, actorId);
  return { token, expiresAt: r.rows[0].expires_at, login };
}

/**
 * 🔑 ЛОГІН І ПАРОЛЬ, ПОКАЗАНІ ОДИН РАЗ (рішення власника 18.09.2026; на зустрічі 15.09 Сергій
 * казав «у цієї людини кандидата є логін-пароль до дашборду»).
 *
 * 🔴 ПАРОЛЬ НЕ ПОТРАПЛЯЄ НІКУДИ, КРІМ ВІДПОВІДІ: ні в подію історії, ні в лог, ні в `users`
 * (там лише bcrypt-хеш). Той, хто відкрив картку пізніше, побачить лише «видано логін і пароль»
 * із датою — а щоб дати вхід ще раз, натисне кнопку знову й отримає НОВИЙ пароль.
 * ⚠️ Видача пароля гасить невикористані запрошення: два живі шляхи входу означали б, що
 * «посилання вже не працює» стало б несподіванкою рівно тоді, коли людина ним користується.
 */
export async function issueCandidatePassword(db: Db, actorId: number | null, candidateId: number, access: HiringAccess, leadTeamId: number | null) {
  const c = await lockAccount(db, candidateId, access, leadTeamId);
  if (c.status !== "candidate" && c.status !== "training")
    throw new HiringError(409, "Вхід — для статусів «кандидат + команда» і «на навчанні»");
  if (c.access_closed_at) throw new HiringError(409, `Доступ закрито (${CLOSE_REASON_LABEL[c.access_closed_reason!]}) — спершу «Відновити доступ»`);
  const userId = c.user_id ?? await ensureCandidateAccount(db, actorId, candidateId);
  const password = newCandidatePassword();
  await db.query(`UPDATE users SET password_hash = $1, is_active = true WHERE id = $2`, [await bcrypt.hash(password, 10), userId]);
  await db.query(`UPDATE hiring_invites SET revoked_at = now() WHERE candidate_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [candidateId]);
  const login = (await db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId])).rows[0].email;
  await event(db, candidateId, "access", "видано логін і пароль (пароль показано один раз)", actorId);
  return { login, password };
}

async function inviteByToken(db: Db, token: unknown, lock: boolean) {
  if (!looksLikeInviteToken(token)) throw new HiringError(404, "Посилання недійсне");
  const r = (await db.query<{ id: number; candidate_id: number; user_id: number; expires_at: string; used_at: string | null;
    revoked_at: string | null; email: string; is_active: boolean; full_name: string | null }>(
    `SELECT i.id, i.candidate_id, i.user_id, i.expires_at, i.used_at, i.revoked_at, u.email, u.is_active, c.full_name
       FROM hiring_invites i JOIN users u ON u.id = i.user_id JOIN hiring_candidates c ON c.id = i.candidate_id
      WHERE i.token_hash = $1${lock ? " FOR UPDATE OF i" : ""}`, [hashInviteToken(token)])).rows[0];
  if (!r) throw new HiringError(404, "Посилання недійсне");
  return r;
}

/** Публічна сторінка «Встановіть пароль»: кому посилання і чи воно ще чинне. */
export async function readInvite(db: Db, token: unknown, now = new Date()) {
  const r = await inviteByToken(db, token, false);
  const state = inviteState({ expiresAt: new Date(r.expires_at), usedAt: d(r.used_at), revokedAt: d(r.revoked_at), now });
  if (state !== "valid") throw new HiringError(410, INVITE_STATE_TEXT[state]);
  if (!r.is_active) throw new HiringError(410, "Доступ до навчання закрито. Зверніться до рекрутера");
  return { name: r.full_name, login: r.email, expiresAt: r.expires_at };
}

/** Встановити пароль за запрошенням. Повертає користувача, якому треба видати вхід. */
export async function acceptInvite(db: Db, token: unknown, password: unknown, now = new Date()): Promise<number> {
  const r = await inviteByToken(db, token, true);
  const state = inviteState({ expiresAt: new Date(r.expires_at), usedAt: d(r.used_at), revokedAt: d(r.revoked_at), now });
  if (state !== "valid") throw new HiringError(410, INVITE_STATE_TEXT[state]);
  if (!r.is_active) throw new HiringError(410, "Доступ до навчання закрито. Зверніться до рекрутера");
  const bad = passwordProblem(password);
  if (bad) throw new HiringError(400, bad);
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await bcrypt.hash(password as string, 10), r.user_id]);
  await db.query(`UPDATE hiring_invites SET used_at = now() WHERE id = $1`, [r.id]);
  await event(db, r.candidate_id, "access", "пароль встановлено за запрошенням", null);
  return r.user_id;
}

/**
 * Вхід кандидата. Перший вхід запускає строк навчання і переводить «кандидат + команда» →
 * «на навчанні» (подія без автора: так звіт бачить старт навчання того дня, коли людина зайшла).
 */
export async function noteCandidateLogin(db: Db, userId: number): Promise<void> {
  const c = (await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM hiring_candidates c WHERE c.user_id = $1 FOR UPDATE`, [userId])).rows[0];
  if (!c || c.first_login_at || c.access_closed_at) return;
  await db.query(`UPDATE hiring_candidates SET first_login_at = now() WHERE id = $1`, [c.id]);
  await event(db, c.id, "access", "перший вхід у навчання", null);
  if (c.status === "candidate") {
    await db.query(`UPDATE hiring_candidates SET status = 'training', updated_at = now() WHERE id = $1`, [c.id]);
    await event(db, c.id, "status", "перший вхід у навчання", null, "candidate", "training");
  }
}

/** «Продовжити доступ на 1 день» — рекрутер, адмін-рівень, тімлід своєї команди. */
export async function extendAccess(db: Db, actorId: number | null, id: number, access: HiringAccess, leadTeamId: number | null) {
  const c = await lockAccount(db, id, access, leadTeamId);
  if (!c.user_id) throw new HiringError(409, "У кандидата ще немає акаунта");
  if (c.access_closed_at) throw new HiringError(409, "Доступ уже закрито — «Відновити доступ» робить рекрутер");
  await db.query(`UPDATE hiring_candidates SET access_extended_days = access_extended_days + 1 WHERE id = $1`, [id]);
  await event(db, id, "access", "доступ продовжено на 1 день", actorId);
}

/** «Відновити доступ» після автоматичного закриття — рекрутер і адмін-рівень. Дає ще добу від сьогодні. */
export async function restoreAccess(db: Db, actorId: number | null, id: number) {
  const c = await lockAccount(db, id, "edit", null);
  if (!c.user_id || !c.access_closed_at) throw new HiringError(409, "Доступ не закрито");
  if (c.access_closed_reason === "manager") throw new HiringError(409, "Кандидат уже менеджер");
  if (c.status === "refused" || c.status === "black")
    throw new HiringError(409, "Кандидат у відмові — спершу поверніть статус");
  const now = new Date();
  // Скільки діб продовження треба, щоб новий строк був не раніше ніж за добу від зараз.
  const base = { accountCreatedAt: new Date(c.account_created_at!), firstLoginAt: d(c.first_login_at) };
  let ext = c.access_extended_days;
  while (accessDeadline({ ...base, extendedDays: ext }).getTime() < now.getTime() + 20 * 3_600_000) ext++;
  await db.query(`UPDATE users SET is_active = true, deactivated_at = NULL, deactivated_reason = NULL WHERE id = $1`, [c.user_id]);
  await db.query(`UPDATE hiring_candidates SET access_closed_at = NULL, access_closed_reason = NULL, access_extended_days = $1 WHERE id = $2`, [ext, id]);
  await event(db, id, "access", `доступ відновлено (продовжено на ${ext - c.access_extended_days} дн.)`, actorId);
}

/** Джоба: закрити прострочені доступи. Повертає, скільки закрито. */
export async function closeExpiredAccess(db: Db, now = new Date()): Promise<{ checked: number; closed: number }> {
  const rows = (await db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM hiring_candidates c
      WHERE c.user_id IS NOT NULL AND c.access_closed_at IS NULL AND c.status IN ('candidate','training')`)).rows;
  let closed = 0;
  for (const c of rows) {
    const reason = accessToClose({ accountCreatedAt: new Date(c.account_created_at!), firstLoginAt: d(c.first_login_at),
      extendedDays: c.access_extended_days, closedAt: null, now });
    if (reason && await closeCandidateAccess(db, c.id, reason, null)) closed++;
  }
  return { checked: rows.length, closed };
}

// ── Прогрес ───────────────────────────────────────────────────────────────

interface Course { folders: { id: number; parent_id: number | null; position: number; course_id: number | null; name: string }[];
  materials: { id: number; folder_id: number; title: string; kind: string; position: number; required: boolean }[];
  ordered: { id: number; folderId: number; position: number; required: boolean }[] }

/** Кроки кандидата: усі опубліковані курси з аудиторією «кандидат» або «усі», у порядку «Навчання». */
async function candidateCourse(db: Db): Promise<Course> {
  // Послідовно, не Promise.all: на клієнті транзакції паралельні запити — черга pg із попередженням.
  const courses = await db.query<{ id: number }>(`SELECT id FROM training_courses WHERE audience IN ('candidate','all') AND published ORDER BY position, id`);
  const folders = await db.query<Course["folders"][number]>(`SELECT id, parent_id, position, course_id, name FROM training_folders`);
  const materials = await db.query<Course["materials"][number]>(`SELECT id, folder_id, title, kind, position, required FROM training_materials WHERE status = 'published'`);
  const fRows = folders.rows.map((f) => ({ id: f.id, parentId: f.parent_id, position: f.position }));
  const mRows = materials.rows.map((m) => ({ id: m.id, folderId: m.folder_id, position: m.position, required: m.required }));
  const ordered = courses.rows.flatMap((c) => folders.rows
    .filter((f) => f.course_id === c.id && f.parent_id === null)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .flatMap((m) => orderedMaterials(m.id, fRows, mRows)));
  return { folders: folders.rows, materials: materials.rows, ordered };
}

function progressOf(course: Course, progress: ProgressMap) {
  const required = course.ordered.filter((m) => m.required);
  const done = required.filter((m) => progress.get(m.id) === "done").length;
  const states = materialStates(course.ordered, progress);
  const cur = states.find((s) => s.state === "available" || s.state === "opened");
  const title = cur ? course.materials.find((m) => m.id === cur.id)?.title ?? null : null;
  return { done, total: required.length, percent: coursePercent(course.ordered, progress), states, current: title };
}

export interface TrainingRow {
  id: number; full_name: string | null; phone: string | null; telegram: string | null; status: HiringStatus;
  team_id: number | null; team_name: string | null; login: string | null;
  account_created_at: string | null; first_login_at: string | null; last_activity_at: string | null;
  access_extended_days: number; access_closed_at: string | null; access_closed_reason: CloseReason | null;
  deadline: string | null; day: number; days: number; health: TrainingHealth | "no_account";
  done: number; total: number; percent: number; current_step: string | null; open_questions: number;
  invite: { expires_at: string; used_at: string | null; revoked_at: string | null } | null;
  /** Коли Іван востаннє бачив логін і пароль (сам пароль не зберігається ніде). */
  password_issued_at: string | null;
}

/** Дошка «На навчанні»: картки з акаунтом або в статусах «кандидат + команда» / «на навчанні». */
export async function trainingBoard(db: Db, access: HiringAccess, leadTeamId: number | null, now = new Date(), onlyId?: number): Promise<TrainingRow[]> {
  if (access === "none") throw new HiringError(403, "Немає доступу до найму");
  const params: unknown[] = [];
  let where = `(c.user_id IS NOT NULL OR c.status IN ('candidate','training'))`;
  if (access === "lead") { params.push(leadTeamId ?? -1); where += ` AND ${LEAD_VISIBLE_SQL(`$${params.length}`)}`; }
  if (onlyId != null) { params.push(onlyId); where += ` AND c.id = $${params.length}`; }
  const rows = (await db.query<Omit<TrainingRow, "deadline" | "day" | "days" | "health" | "done" | "total" | "percent" | "current_step">>(
    `SELECT c.id, c.full_name, c.phone, c.telegram, c.status, c.team_id, t.name AS team_name, u.email AS login, c.user_id,
            c.account_created_at, c.first_login_at, c.access_extended_days, c.access_closed_at, c.access_closed_reason,
            (SELECT max(e.at) FROM training_events e WHERE e.user_id = c.user_id) AS last_activity_at,
            (SELECT count(*)::int FROM hiring_training_questions q WHERE q.candidate_id = c.id AND q.answer IS NULL) AS open_questions,
            (SELECT max(e.at) FROM hiring_events e WHERE e.candidate_id = c.id AND e.kind = 'access'
                AND e.comment LIKE 'видано логін і пароль%') AS password_issued_at,
            (SELECT json_build_object('expires_at', i.expires_at, 'used_at', i.used_at, 'revoked_at', i.revoked_at)
               FROM hiring_invites i WHERE i.candidate_id = c.id ORDER BY i.created_at DESC, i.id DESC LIMIT 1) AS invite
       FROM hiring_candidates c LEFT JOIN teams t ON t.id = c.team_id LEFT JOIN users u ON u.id = c.user_id
      WHERE ${where}
      ORDER BY (c.access_closed_at IS NULL) DESC, c.account_created_at DESC NULLS FIRST, c.id DESC`, params)).rows as (TrainingRow & { user_id: number | null })[];
  if (!rows.length) return [];
  const course = await candidateCourse(db);
  const userIds = rows.map((r) => r.user_id).filter((x): x is number => x != null);
  const prog = userIds.length
    ? (await db.query<{ user_id: number; material_id: number; status: "opened" | "done" }>(
        `SELECT user_id, material_id, status FROM training_progress WHERE user_id = ANY($1::int[])`, [userIds])).rows : [];
  return rows.map((r) => {
    const map: ProgressMap = new Map(prog.filter((p) => p.user_id === r.user_id).map((p) => [p.material_id, p.status]));
    const pr = progressOf(course, map);
    const firstLoginAt = d(r.first_login_at);
    const base = r.user_id && r.account_created_at
      ? { deadline: accessDeadline({ accountCreatedAt: new Date(r.account_created_at), firstLoginAt, extendedDays: r.access_extended_days }).toISOString(),
          day: trainingDay({ firstLoginAt, extendedDays: r.access_extended_days, now }),
          health: trainingHealth({ closedReason: r.access_closed_reason, firstLoginAt, lastActivityAt: d(r.last_activity_at), done: pr.done, total: pr.total, now }) }
      : { deadline: null, day: 0, health: "no_account" as const };
    const { user_id: _uid, ...row } = r;
    return { ...row, ...base, days: CANDIDATE_ACCESS.trainingDays + r.access_extended_days,
      done: pr.done, total: pr.total, percent: pr.percent, current_step: pr.current };
  });
}

/** Прогрес одного кандидата: рядок дошки + кроки + питання + історія доступу. */
export async function trainingDetail(db: Db, id: number, access: HiringAccess, leadTeamId: number | null, now = new Date()) {
  const row = (await trainingBoard(db, access, leadTeamId, now, id))[0];
  if (!row) throw new HiringError(404, "Кандидата не знайдено або він не на навчанні");
  const userId = (await db.query<{ user_id: number | null }>(`SELECT user_id FROM hiring_candidates WHERE id = $1`, [id])).rows[0]?.user_id;
  const course = await candidateCourse(db);
  const prog = userId ? (await db.query<{ material_id: number; status: "opened" | "done"; finished_at: string | null; opened_at: string }>(
    `SELECT material_id, status, finished_at, opened_at FROM training_progress WHERE user_id = $1`, [userId])).rows : [];
  const states = materialStates(course.ordered, new Map(prog.map((p) => [p.material_id, p.status])));
  const moduleName = (folderId: number) => {
    const f = course.folders.find((x) => x.id === folderId);
    const root = f?.parent_id != null ? course.folders.find((x) => x.id === f.parent_id) : f;
    return root?.name ?? "";
  };
  const steps = course.ordered.map((m, i) => {
    const src = course.materials.find((x) => x.id === m.id)!;
    const p = prog.find((x) => x.material_id === m.id);
    return { id: m.id, index: i + 1, title: src.title, kind: src.kind, module: moduleName(m.folderId), required: m.required,
      state: states[i].state, opened_at: p?.opened_at ?? null, finished_at: p?.finished_at ?? null };
  });
  const questions = (await db.query(
    `SELECT q.id, q.question, q.asked_at, q.answer, q.answered_at, q.material_id,
            (SELECT title FROM training_materials m WHERE m.id = q.material_id) AS material_title,
            COALESCE(u.full_name, mg.name, u.email) AS answered_by
       FROM hiring_training_questions q LEFT JOIN users u ON u.id = q.answered_by LEFT JOIN managers mg ON mg.id = u.manager_id
      WHERE q.candidate_id = $1 ORDER BY q.asked_at, q.id`, [id])).rows;
  const events = (await db.query(
    `SELECT e.id, e.kind, e.from_status, e.to_status, e.comment, e.at, COALESCE(u.full_name, mg.name, u.email) AS actor
       FROM hiring_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN managers mg ON mg.id = u.manager_id
      WHERE e.candidate_id = $1 AND (e.kind IN ('access','question') OR (e.kind = 'status' AND e.to_status IN ('candidate','training','manager','refused','black')))
      ORDER BY e.at DESC, e.id DESC`, [id])).rows;
  return { row, steps, questions, events };
}

/** «Перевести в менеджери»: роль акаунта → «Менеджер», статус → «менеджер». */
export async function promoteCandidate(db: Db, actorId: number | null, id: number, comment: unknown,
  canDecide: boolean, access: HiringAccess, leadTeamId: number | null) {
  if (!canDecide) throw new HiringError(403, "Рішення після навчання приймає тімлід команди");
  const text = str(comment);
  if (!text) throw new HiringError(400, "Коментар обовʼязковий");
  const c = await lockAccount(db, id, access, leadTeamId);
  if (!c.user_id) throw new HiringError(409, "У кандидата немає акаунта — переведіть статусом");
  const [row] = await trainingBoard(db, access, leadTeamId, new Date(), id);
  const v = promoteVerdict({ status: c.status, closedReason: c.access_closed_reason, done: row.done, total: row.total });
  if (!v.ok) throw new HiringError(409, v.reason);
  await db.query(`UPDATE users SET role_override = 'manager', is_active = true WHERE id = $1`, [c.user_id]);
  await db.query(`UPDATE hiring_candidates SET status = 'manager', updated_at = now() WHERE id = $1`, [id]);
  await event(db, id, "status", `після навчання (${row.done} із ${row.total} кроків) · ${text}`, actorId, c.status, "manager");
  await closeCandidateAccess(db, id, "manager", actorId);
  await ensureEmployeeFromCandidate(db, actorId, id); // 👤 після навчання — теж у реєстр (#647)
}

// ── Екран кандидата (прохід 2b) ──────────────────────────────────────────

/**
 * «Моє навчання» для самого кандидата: день, строк доступу, команда, тімлід, прогрес.
 *
 * 🔴 РАХУЄ `trainingBoard` — ТОЙ САМИЙ РЯДОК, ЩО БАЧИТЬ РЕКРУТЕР НА ДОШЦІ. Друга копія формули
 * строку розійшлась би з першою мовчки, і кандидат бачив би «ще 30 год», а тімлід — «закрито».
 * Ключ — `userId` із токена; параметра «чий» немає, тож чужого не віддати навіть помилкою.
 * Користувач без картки в «Наймі» — `null`: екран курсу працює, смуги строку просто немає.
 */
export async function candidateSelf(db: Db, userId: number, now = new Date()) {
  const c = (await db.query<{ id: number }>(`SELECT id FROM hiring_candidates WHERE user_id = $1`, [userId])).rows[0];
  if (!c) return null;
  const row = (await trainingBoard(db, "edit", null, now, c.id))[0];
  if (!row) return null;
  const lead = (await db.query<{ name: string | null }>(
    `SELECT COALESCE(u.full_name, m.name, u.email) AS name FROM users u LEFT JOIN managers m ON m.id = u.manager_id
      WHERE u.team_id = $1 AND COALESCE(u.role_override, u.role) = 'team_lead' AND u.is_active ORDER BY u.id LIMIT 1`,
    [row.team_id ?? -1])).rows[0];
  return {
    fullName: row.full_name, teamName: row.team_name, leadName: lead?.name ?? null,
    day: row.day, days: row.days, deadline: row.deadline, firstLoginAt: row.first_login_at,
    closedReason: row.access_closed_reason, done: row.done, total: row.total, percent: row.percent,
  };
}

// ── Питання тімліду ────────────────────────────────────────────────────────

/** Кандидат питає тімліда з кроку. Лише власник акаунта кандидата з відкритим доступом. */
export async function askQuestion(db: Db, userId: number, p: { materialId?: unknown; question?: unknown }) {
  const c = (await db.query<AccountRow>(`SELECT ${ACCOUNT_COLS} FROM hiring_candidates c WHERE c.user_id = $1`, [userId])).rows[0];
  if (!c) throw new HiringError(403, "Питання тімліду — для кандидатів на навчанні");
  if (c.access_closed_at) throw new HiringError(403, "Доступ до навчання закрито");
  const q = str(p.question);
  if (!q) throw new HiringError(400, "Напишіть питання");
  if (q.length > 2000) throw new HiringError(400, "Питання задовге — до 2000 символів");
  let materialId: number | null = null;
  if (p.materialId != null && p.materialId !== "") {
    materialId = Number(p.materialId);
    if (!Number.isInteger(materialId) || !(await db.query(`SELECT 1 FROM training_materials WHERE id = $1`, [materialId])).rowCount)
      throw new HiringError(400, "Такого кроку немає");
  }
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_training_questions (candidate_id, material_id, question) VALUES ($1,$2,$3) RETURNING id`, [c.id, materialId, q]);
  await event(db, c.id, "question", `питання тімліду: ${q.slice(0, 200)}`, userId);
  return r.rows[0].id;
}

export async function myQuestions(db: Db, userId: number) {
  return (await db.query(
    `SELECT q.id, q.material_id, q.question, q.asked_at, q.answer, q.answered_at
       FROM hiring_training_questions q JOIN hiring_candidates c ON c.id = q.candidate_id
      WHERE c.user_id = $1 ORDER BY q.asked_at, q.id`, [userId])).rows;
}

export async function answerQuestion(db: Db, actorId: number | null, candidateId: number, questionId: number, answer: unknown,
  canDecide: boolean, access: HiringAccess, leadTeamId: number | null) {
  if (!canDecide) throw new HiringError(403, "На питання відповідає тімлід команди");
  const text = str(answer);
  if (!text) throw new HiringError(400, "Напишіть відповідь");
  await lockAccount(db, candidateId, access, leadTeamId);
  const r = await db.query(
    `UPDATE hiring_training_questions SET answer = $1, answered_by = $2, answered_at = now()
      WHERE id = $3 AND candidate_id = $4 AND answer IS NULL`, [text, actorId, questionId, candidateId]);
  if (!r.rowCount) throw new HiringError(409, "Питання не знайдено або на нього вже відповіли");
  await event(db, candidateId, "question", `відповідь тімліда: ${text.slice(0, 200)}`, actorId);
}
