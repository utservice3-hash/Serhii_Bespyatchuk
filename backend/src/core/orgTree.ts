/**
 * 🏢 ОРГ-СТРУКТУРА (задача 7062, ТЗ Даші 23.10.2026; рішення Романа 27.10.2026). Схема — `org_units` / `org_log`.
 *
 *  • ЛЮДИ — лише з реєстру «Найм → Співробітники» (працюючі: `active`, `finishing`); окремої таблиці людей немає (ТЗ).
 *  • БЛОК ЛЮДИНИ = її «Команда» (`employees.team_label`), що збігається з «Командою» блоку: `org_units.label`,
 *    а якщо порожньо — назва привʼязаної команди дашборду. Порівняння без регістру, зайвих пробілів і виду апострофа.
 *  • КЕРІВНИК блоку — вказаний вручну, інакше тімлід привʼязаної команди. Керівник стоїть у СВОЄМУ блоці (першому,
 *    де він керівник), хоч би яка в нього «Команда».
 *  • НЕВІДОМЕ ВИДНО: людина, чия «Команда» не збіглася з жодним блоком, іде в «Без блоку» з числом і переліком
 *    незнайомих значень — а не зникає. Кожен працюючий — рівно в одному місці (#2700).
 *  • ПЕРЕТЯГНУТИ = змінити «Команду» в «Наймі» тим самим `updateEmployee` (аудит), плюс рядок у `org_log` зі старим
 *    значенням. Нік у Telegram і фото кожен змінює собі сам (свій рядок реєстру — за `employees.user_id`).
 *  • Телефонів, документів, дат — не віддаємо взагалі (ТЗ): вибірка називає поля поіменно (#2702).
 */
import { updateEmployee } from "./employees.js";
import type { Db } from "./secrets.js";
import { photoVersion } from "./peopleRules.js";

export class OrgError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const ORG_DEPTS = {
  top: "Керівництво", hr: "Відділ персоналу", fin: "Фінансовий відділ", it: "IT-відділ", sales: "Комерційний відділ",
} as const;
export type OrgDept = keyof typeof ORG_DEPTS;
const isDept = (v: unknown): v is OrgDept => typeof v === "string" && Object.hasOwn(ORG_DEPTS, v);

/** Працюючі в реєстрі — та сама межа, що «Працюють» у «Наймі»: `finishing` ще працює до дати звільнення. */
export const WORKING_SQL = `e.status IN ('active','finishing')`;

/** Ключ порівняння «Команди» з блоком: регістр, пробіли й вид апострофа (ʼ ' ’ `) різницею не є. */
export function labelKey(s: string | null | undefined): string | null {
  if (s == null) return null;
  const k = s.normalize("NFC").toLowerCase().replace(/[’'`ʼ]/g, "ʼ").replace(/\s+/g, " ").trim();
  return k || null;
}

/**
 * Нік у Telegram: `@nick`, `nick`, `t.me/nick`, `https://t.me/nick` → `@nick`. Усе інше — порожньо, «-», два ніки
 * в одному полі, кирилиця, коротше за 5 — `null`: сентинел перетворюється на «не вказано» тут, один раз (правило 5).
 */
export function tgNick(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim().replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me)\//i, "").replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s) ? `@${s}` : null;
}

export interface UnitRow {
  id: number; parentId: number | null; name: string; dept: OrgDept; teamId: number | null; teamName: string | null;
  label: string | null; headEmployeeId: number | null; teamLeadEmployeeId: number | null; side: boolean; sort: number;
}
export interface PersonRow {
  id: number; name: string; position: string | null; teamLabel: string | null; telegram: string | null;
  photoV: number | null; userId: number | null;
}
export interface OrgUnit {
  id: number; parentId: number | null; name: string; dept: OrgDept; teamId: number | null; teamName: string | null;
  /** «Команда», за якою люди потрапляють у блок: власна або назва команди дашборду. `null` — блок-контейнер. */
  label: string | null; ownLabel: string | null;
  headId: number | null; headSource: "manual" | "team" | null; side: boolean; sort: number; memberIds: number[];
}
export interface OrgPerson {
  id: number; name: string; position: string | null; teamLabel: string | null; unitId: number | null; isHead: boolean;
  telegram: string | null; telegramInvalid: boolean; photo: { id: number; v: number } | null; isMe: boolean;
}
export interface OrgTree {
  units: OrgUnit[]; people: OrgPerson[]; unassigned: number[];
  unknownLabels: { label: string; count: number }[];
  stats: { total: number; noTelegram: number; noPhoto: number; unassigned: number };
}

const byUk = (a: string, b: string) => a.localeCompare(b, "uk");
const effLabel = (u: Pick<UnitRow, "label" | "teamName">) => u.label?.trim() || u.teamName?.trim() || null;

/** Чисте збирання дерева: кожен працюючий — рівно один раз (керівником, учасником або в «Без блоку»). */
export function buildOrg(unitRows: readonly UnitRow[], personRows: readonly PersonRow[], meUserId: number | null): OrgTree {
  const units = [...unitRows].sort((a, b) => a.sort - b.sort || a.id - b.id);
  const alive = new Set(personRows.map((p) => p.id));
  const placed = new Map<number, { unitId: number | null; isHead: boolean }>();
  const out: OrgUnit[] = units.map((u) => {
    const manual = u.headEmployeeId != null && alive.has(u.headEmployeeId) ? u.headEmployeeId : null;
    const team = manual == null && u.teamLeadEmployeeId != null && alive.has(u.teamLeadEmployeeId) ? u.teamLeadEmployeeId : null;
    const headId = manual ?? team;
    if (headId != null && !placed.has(headId)) placed.set(headId, { unitId: u.id, isHead: true });
    return {
      id: u.id, parentId: u.parentId, name: u.name, dept: u.dept, teamId: u.teamId, teamName: u.teamName,
      label: effLabel(u), ownLabel: u.label, headId, headSource: manual != null ? "manual" : team != null ? "team" : null,
      side: u.side, sort: u.sort, memberIds: [],
    };
  });
  const byLabel = new Map<string, OrgUnit>();
  for (const u of out) { const k = labelKey(u.label); if (k && !byLabel.has(k)) byLabel.set(k, u); }
  const unknown = new Map<string, { label: string; count: number }>();
  for (const p of personRows) {
    if (placed.has(p.id)) continue;
    const k = labelKey(p.teamLabel);
    const u = k ? byLabel.get(k) : undefined;
    if (u) { u.memberIds.push(p.id); placed.set(p.id, { unitId: u.id, isHead: false }); continue; }
    placed.set(p.id, { unitId: null, isHead: false });
    const shown = p.teamLabel?.trim() || "«Команда» не заповнена";
    const e = unknown.get(shown) ?? { label: shown, count: 0 };
    e.count++; unknown.set(shown, e);
  }
  const people: OrgPerson[] = personRows.map((p) => {
    const where = placed.get(p.id)!;
    const nick = tgNick(p.telegram);
    return {
      id: p.id, name: p.name, position: p.position, teamLabel: p.teamLabel, unitId: where.unitId, isHead: where.isHead,
      telegram: nick, telegramInvalid: !nick && !!p.telegram?.trim(), photo: p.photoV != null ? { id: p.id, v: p.photoV } : null,
      isMe: meUserId != null && p.userId === meUserId,
    };
  }).sort((a, b) => byUk(a.name, b.name));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  for (const u of out) u.memberIds.sort((a, b) => byUk(nameOf.get(a)!, nameOf.get(b)!));
  const unassigned = people.filter((p) => p.unitId == null).map((p) => p.id);
  return {
    units: out, people, unassigned,
    unknownLabels: [...unknown.values()].sort((a, b) => b.count - a.count || byUk(a.label, b.label)),
    stats: {
      total: people.length, noTelegram: people.filter((p) => !p.telegram).length,
      noPhoto: people.filter((p) => !p.photo).length, unassigned: unassigned.length,
    },
  };
}

/* ───────────────────────────── читання ───────────────────────────── */

async function unitRows(db: Db): Promise<UnitRow[]> {
  const r = await db.query<{ id: number; parent_id: number | null; name: string; dept: OrgDept; team_id: number | null; team_name: string | null;
    label: string | null; head_employee_id: number | null; team_lead_employee_id: number | null; side: boolean; sort: number }>(
    `SELECT u.id, u.parent_id, u.name, u.dept, u.team_id, t.name AS team_name, u.label, u.head_employee_id, u.side, u.sort,
            (SELECT e.id FROM managers m JOIN employees e ON e.manager_id = m.id AND ${WORKING_SQL}
              WHERE m.team_id = u.team_id AND m.is_team_lead AND m.is_active ORDER BY e.id LIMIT 1) AS team_lead_employee_id
       FROM org_units u LEFT JOIN teams t ON t.id = u.team_id
      ORDER BY u.sort, u.id`);
  return r.rows.map((x) => ({ id: x.id, parentId: x.parent_id, name: x.name, dept: x.dept, teamId: x.team_id, teamName: x.team_name,
    label: x.label, headEmployeeId: x.head_employee_id, teamLeadEmployeeId: x.team_lead_employee_id, side: x.side, sort: x.sort }));
}

async function personRows(db: Db): Promise<PersonRow[]> {
  // 🔒 Поля поіменно: телефону, пошти, дат, документів тут немає й бути не може (ТЗ; #2702).
  const r = await db.query<{ id: number; full_name: string; position: string | null; team_label: string | null; telegram: string | null;
    user_id: number | null; has_photo: boolean; photo_updated_at: Date | null }>(
    `SELECT e.id, e.full_name, e.position, e.team_label, e.telegram, e.user_id,
            (e.photo_file IS NOT NULL) AS has_photo, e.photo_updated_at
       FROM employees e WHERE ${WORKING_SQL}`);
  return r.rows.map((x) => ({ id: x.id, name: x.full_name, position: x.position, teamLabel: x.team_label, telegram: x.telegram,
    userId: x.user_id, photoV: x.has_photo ? photoVersion(x.photo_updated_at) : null }));
}

export async function loadOrg(db: Db, meUserId: number | null): Promise<OrgTree> {
  return buildOrg(await unitRows(db), await personRows(db), meUserId);
}

/** Рядок реєстру поточного користувача (працюючий), або `null` — тоді «моє фото / мій нік» недоступні. */
export async function myEmployeeId(db: Db, userId: number): Promise<number | null> {
  const r = await db.query<{ id: number }>(`SELECT e.id FROM employees e WHERE e.user_id = $1 AND ${WORKING_SQL}`, [userId]);
  return r.rows[0]?.id ?? null;
}

export async function orgLog(db: Db, limit = 300) {
  const r = await db.query<{ id: string; at: string; actor: string | null; action: string; summary: string }>(
    `SELECT l.id, to_char(l.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1)) AS actor, l.action, l.summary
       FROM org_log l LEFT JOIN users u ON u.id = l.actor_id
      ORDER BY l.at DESC, l.id DESC LIMIT $1`, [limit]);
  return r.rows.map((x) => ({ id: Number(x.id), at: x.at, actor: x.actor, action: x.action, summary: x.summary }));
}

async function log(db: Db, actor: number, action: string, summary: string, x: { employeeId?: number | null; unitId?: number | null; before?: unknown; after?: unknown }) {
  await db.query(
    `INSERT INTO org_log (actor_id, action, employee_id, unit_id, summary, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor > 0 ? actor : null, action, x.employeeId ?? null, x.unitId ?? null, summary,
      x.before === undefined ? null : JSON.stringify(x.before), x.after === undefined ? null : JSON.stringify(x.after)]);
}

/* ───────────────────────────── «моє» ───────────────────────────── */

/** Свій нік у Telegram: порожньо — прибрати; некоректний — 400 (а не тихе збереження сміття). */
export async function setMyTelegram(db: Db, userId: number, raw: unknown): Promise<string | null> {
  const id = await myEmployeeId(db, userId);
  if (id == null) throw new OrgError(404, "Вашого акаунта немає серед працюючих у «Найм → Співробітники» — зверніться до HR");
  const text = typeof raw === "string" ? raw.trim() : "";
  const nick = text ? tgNick(text) : null;
  if (text && !nick) throw new OrgError(400, "Нік у Telegram — латиниця, цифри й «_», від 5 до 32 символів (наприклад, @ivan_uts)");
  const before = (await db.query<{ telegram: string | null }>(`SELECT telegram FROM employees WHERE id = $1`, [id])).rows[0]?.telegram ?? null;
  const r = await updateEmployee(db, userId, id, { telegram: nick });
  if (r.changed.length) await log(db, userId, "me.telegram", `Змінено свій нік у Telegram: ${before ?? "—"} → ${nick ?? "—"}`, { employeeId: id, before: { telegram: before }, after: { telegram: nick } });
  return nick;
}

/* ───────────────────────────── редагування ───────────────────────────── */

async function oneUnit(db: Db, id: number): Promise<UnitRow> {
  const u = (await unitRows(db)).find((x) => x.id === id);
  if (!u) throw new OrgError(404, "Блоку не знайдено");
  return u;
}

/** Перемістити людину в блок = поставити їй «Команду» блоку в «Наймі». `unitId = null` — прибрати «Команду». */
export async function moveEmployee(db: Db, actor: number, employeeId: number, unitId: number | null): Promise<void> {
  const e = (await db.query<{ full_name: string; team_label: string | null }>(
    `SELECT e.full_name, e.team_label FROM employees e WHERE e.id = $1 AND ${WORKING_SQL}`, [employeeId])).rows[0];
  if (!e) throw new OrgError(404, "Серед працюючих такої людини немає");
  let label: string | null = null, unitName = "Без блоку";
  if (unitId != null) {
    const u = await oneUnit(db, unitId);
    label = effLabel(u);
    if (!label) throw new OrgError(409, `У блоку «${u.name}» немає «Команди» — задайте її або привʼяжіть команду дашборду`);
    unitName = u.name;
  }
  const r = await updateEmployee(db, actor, employeeId, { team_label: label });
  if (r.changed.length) await log(db, actor, "move", `${e.full_name} → ${unitName} («Команда»: ${e.team_label ?? "—"} → ${label ?? "—"})`,
    { employeeId, unitId, before: { team_label: e.team_label }, after: { team_label: label } });
}

interface UnitInput { name: string; parentId: number | null; dept: OrgDept; teamId: number | null; label: string | null; headEmployeeId: number | null; side: boolean; sort: number }

const optInt = (v: unknown, what: string): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new OrgError(400, `Некоректний ${what}`);
  return n;
};
const optText = (v: unknown, max: number, what: string): string | null => {
  if (v == null) return null;
  if (typeof v !== "string") throw new OrgError(400, `${what}: очікується текст`);
  const s = v.trim().replace(/\s+/g, " ");
  if (s.length > max) throw new OrgError(400, `${what}: не довше ${max} символів`);
  return s || null;
};

/**
 * Поля з тіла поверх поточних (для PATCH) або порожніх (для створення) — і повна перевірка результату. Разом із полями
 * повертає «Команду», яку блок матиме ПІСЛЯ запису: її перевіряють до `UPDATE`, а не після.
 */
async function resolveUnit(db: Db, body: Record<string, unknown>, cur: UnitInput | null, selfId: number | null): Promise<{ v: UnitInput; label: string | null }> {
  const has = (k: string) => Object.hasOwn(body, k);
  const next: UnitInput = cur ? { ...cur } : { name: "", parentId: null, dept: "top", teamId: null, label: null, headEmployeeId: null, side: false, sort: 0 };
  if (has("name")) next.name = optText(body.name, 120, "Назва") ?? "";
  if (has("parentId")) next.parentId = optInt(body.parentId, "батьківський блок");
  if (has("dept")) { if (!isDept(body.dept)) throw new OrgError(400, "Невідомий відділ"); next.dept = body.dept; }
  if (has("teamId")) next.teamId = optInt(body.teamId, "id команди");
  if (has("label")) next.label = optText(body.label, 120, "«Команда» блоку");
  if (has("headEmployeeId")) next.headEmployeeId = optInt(body.headEmployeeId, "id керівника");
  if (has("side")) { if (typeof body.side !== "boolean") throw new OrgError(400, "«Збоку»: так або ні"); next.side = body.side; }
  if (has("sort")) { const s = Number(body.sort); if (!Number.isInteger(s) || Math.abs(s) > 100_000) throw new OrgError(400, "Некоректний порядок"); next.sort = s; }
  if (!next.name) throw new OrgError(400, "Назва блоку обовʼязкова");
  if (next.side && next.parentId == null) throw new OrgError(400, "Блок «збоку» мусить мати батьківський блок");

  const all = await unitRows(db);
  if (next.parentId != null) {
    if (next.parentId === selfId) throw new OrgError(400, "Блок не може підпорядковуватись сам собі");
    const byId = new Map(all.map((u) => [u.id, u]));
    if (!byId.has(next.parentId)) throw new OrgError(400, "Батьківського блоку не знайдено");
    for (let p: number | null = next.parentId, guard = 0; p != null && guard < 1000; p = byId.get(p)?.parentId ?? null, guard++)
      if (p === selfId) throw new OrgError(400, "Так вийде коло: батьківський блок підпорядкований цьому");
  }
  let teamName: string | null = null;
  if (next.teamId != null) {
    teamName = (await db.query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [next.teamId])).rows[0]?.name ?? null;
    if (teamName == null) throw new OrgError(400, "Команди дашборду не знайдено");
    const taken = all.find((u) => u.teamId === next.teamId && u.id !== selfId);
    if (taken) throw new OrgError(409, `Команда «${teamName}» уже привʼязана до блоку «${taken.name}»`);
  }
  const k = labelKey(next.label ?? teamName);
  const twin = k ? all.find((u) => u.id !== selfId && labelKey(effLabel(u)) === k) : undefined;
  if (twin) throw new OrgError(409, `«Команда» «${next.label ?? teamName}» уже належить блоку «${twin.name}» — люди не знатимуть, куди йти`);
  if (next.headEmployeeId != null && !(await db.query(`SELECT 1 FROM employees e WHERE e.id = $1 AND ${WORKING_SQL}`, [next.headEmployeeId])).rowCount)
    throw new OrgError(400, "Керівником може бути лише працюючий із «Найму»");
  return { v: next, label: next.label ?? teamName };
}

const unitSnap = (u: UnitInput) => ({ name: u.name, parentId: u.parentId, dept: u.dept, teamId: u.teamId, label: u.label, headEmployeeId: u.headEmployeeId, side: u.side, sort: u.sort });

export async function createUnit(db: Db, actor: number, body: Record<string, unknown>): Promise<number> {
  const { v } = await resolveUnit(db, body ?? {}, null, null);
  const id = (await db.query<{ id: number }>(
    `INSERT INTO org_units (parent_id, name, dept, team_id, label, head_employee_id, side, sort)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [v.parentId, v.name, v.dept, v.teamId, v.label, v.headEmployeeId, v.side, v.sort])).rows[0].id;
  await log(db, actor, "unit.create", `Створено блок «${v.name}»`, { unitId: id, after: unitSnap(v) });
  return id;
}

/**
 * Зміна блоку. Якщо змінилась його «Команда» — люди з ТОЮ «Командою» переїжджають разом (їм ставиться нова, кожному
 * з аудитом), інакше перейменування блоку мовчки висипало б їх у «Без блоку» (#2704).
 */
export async function updateUnit(db: Db, actor: number, id: number, body: Record<string, unknown>): Promise<void> {
  const cur = await oneUnit(db, id);
  const was: UnitInput = { name: cur.name, parentId: cur.parentId, dept: cur.dept, teamId: cur.teamId, label: cur.label, headEmployeeId: cur.headEmployeeId, side: cur.side, sort: cur.sort };
  const { v, label: newLabel } = await resolveUnit(db, body ?? {}, was, id);
  const oldKey = labelKey(effLabel(cur));
  const carry = oldKey && oldKey !== labelKey(newLabel)
    ? (await db.query<{ id: number; full_name: string; team_label: string | null }>(
        `SELECT e.id, e.full_name, e.team_label FROM employees e WHERE ${WORKING_SQL} AND e.team_label IS NOT NULL`)).rows
        .filter((p) => labelKey(p.team_label) === oldKey)
    : [];
  if (carry.length && !newLabel) throw new OrgError(409, `У блоці ${carry.length} люд. — без «Команди» їм не буде куди потрапити; спершу перемістіть людей`);
  await db.query(
    `UPDATE org_units SET parent_id = $2, name = $3, dept = $4, team_id = $5, label = $6, head_employee_id = $7, side = $8, sort = $9, updated_at = now()
      WHERE id = $1`, [id, v.parentId, v.name, v.dept, v.teamId, v.label, v.headEmployeeId, v.side, v.sort]);
  for (const p of carry) {
    await updateEmployee(db, actor, p.id, { team_label: newLabel });
    await log(db, actor, "move", `${p.full_name} — разом із блоком «${v.name}» («Команда»: ${p.team_label} → ${newLabel})`,
      { employeeId: p.id, unitId: id, before: { team_label: p.team_label }, after: { team_label: newLabel } });
  }
  await log(db, actor, "unit.update", `Змінено блок «${v.name}»`, { unitId: id, before: unitSnap(was), after: unitSnap(v) });
}

/** Видалити можна лише порожній блок: без підпорядкованих блоків і без людей з його «Командою». */
export async function deleteUnit(db: Db, actor: number, id: number): Promise<void> {
  const tree = await loadOrg(db, null);
  const u = tree.units.find((x) => x.id === id);
  if (!u) throw new OrgError(404, "Блоку не знайдено");
  const kids = tree.units.filter((x) => x.parentId === id).length;
  if (kids) throw new OrgError(409, `У блоку «${u.name}» є підпорядковані блоки (${kids}) — спершу перенесіть або видаліть їх`);
  if (u.memberIds.length) throw new OrgError(409, `У блоці «${u.name}» ${u.memberIds.length} люд. — спершу перемістіть їх`);
  await db.query(`DELETE FROM org_units WHERE id = $1`, [id]);
  await log(db, actor, "unit.delete", `Видалено блок «${u.name}»`, { unitId: id, before: { name: u.name, parentId: u.parentId, dept: u.dept, teamId: u.teamId, label: u.ownLabel, headId: u.headId } });
}

/** Журнал фото: саме фото пише `core/people.ts`; тут — лише запис «хто змінив своє фото». */
export async function logMyPhoto(db: Db, actor: number, employeeId: number): Promise<void> {
  await log(db, actor, "me.photo", "Змінено своє фото", { employeeId });
}
