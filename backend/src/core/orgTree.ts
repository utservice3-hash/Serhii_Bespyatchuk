/**
 * 🏢 ОРГ-СТРУКТУРА (задача 7062, ТЗ Даші 23.10.2026; рішення Романа 27.10.2026). Схема — `org_units` / `org_log`.
 *
 *  • ЛЮДИ — лише з реєстру «Найм → Співробітники» (працюючі: `active`, `finishing`); окремої таблиці людей немає (ТЗ).
 *  • БЛОК ЛЮДИНИ = її КОМАНДА (рішення Романа 27.10.2026, `core/teams.ts`): у кого в Kommo є група — команда Kommo,
 *    решта — вибрана в картці (команда Kommo або команда дашборду). Блок привʼязаний до однієї команди будь-якого
 *    джерела; зʼєднана команда дашборду живе в блоці своєї команди Kommo. Текст «Команди» (`team_label`) — лише вітрина.
 *  • КЕРІВНИК блоку — вказаний вручну, інакше тімлід привʼязаної команди. Керівник стоїть у СВОЄМУ блоці (першому,
 *    де він керівник), хоч би яка в нього «Команда».
 *  • НЕВІДОМЕ ВИДНО: людина без команди або з командою без блоку іде в «Без блоку» з числом і переліком (назва
 *    команди або старий текст «Команди», напр. «9») — а не зникає. Кожен працюючий — рівно в одному місці (#2850).
 *  • ПЕРЕТЯГНУТИ = поставити людині команду блоку (`setEmployeeTeam`, аудит) + рядок у `org_log`. Людину з Kommo не
 *    перетягнути — 409 (її команда з Kommo). Нік у Telegram і фото кожен змінює собі сам (свій рядок — за `user_id`).
 *  • ТЕЛЕФОН — у картці, усім, включно з кандидатами (рішення Романа 28.10.2026, замість «не показувати» з ТЗ); пошти,
 *    документів, дат — не віддаємо взагалі: вибірка називає поля поіменно (#2712). Номер зводиться до одного вигляду тут,
 *    один раз (`phoneView`); нерозпізнаний показується як записаний, а не ховається.
 */
import { updateEmployee } from "./employees.js";
import type { Db } from "./secrets.js";
import {
  effectiveTeam, unitTeamKey, setEmployeeTeam, PERSON_TEAM_COLS, PERSON_TEAM_JOINS, personTeamInput, type PersonTeamInput, TeamsError,
} from "./teams.js";
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

/**
 * Телефон для картки: `0501112233`, `380501112233`, `+380 50 111-22-33`, `501112233` → «+380 50 111 22 33» з посиланням
 * `tel:+380501112233`. Порожньо або без жодної цифри й літери («-») — `null`. Решту (не 9/10/12 цифр українського номера, кілька номерів) показуємо як
 * записано, без посилання: невідоме видно, а не зникає (#2713).
 */
export function phoneView(raw: string | null | undefined): { text: string; tel: string | null } | null {
  const t = raw?.trim();
  if (!t || !/[\p{L}\d]/u.test(t)) return null; // «-», «—», «.» — сентинел, а не номер (правило 5)
  const d = /^\+?[\d\s()-]+$/.test(t) ? t.replace(/\D/g, "") : "";
  const n = d.length === 12 && d.startsWith("380") ? d.slice(3) : d.length === 10 && d.startsWith("0") ? d.slice(1)
    : d.length === 9 && !d.startsWith("0") ? d : null;
  if (!n) return { text: t, tel: null };
  return { text: `+380 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`, tel: `+380${n}` };
}

export interface UnitRow {
  id: number; parentId: number | null; name: string; dept: OrgDept; teamId: number | null; teamName: string | null;
  /** Команда дашборду блоку (замість команди Kommo) і, якщо вона зʼєднана, — її команда Kommo. */
  dashTeamId: number | null; dashTeamName: string | null; dashLinkedKommoId: number | null;
  label: string | null; headEmployeeId: number | null; teamLeadEmployeeId: number | null; side: boolean; sort: number;
}
export interface PersonRow extends PersonTeamInput {
  id: number; name: string; position: string | null; teamLabel: string | null; telegram: string | null; phone: string | null;
  /** Назва справжньої команди людини (Kommo або дашборду) — для картки й «Без блоку». */
  teamName: string | null;
  photoV: number | null; userId: number | null;
}
export interface OrgUnit {
  id: number; parentId: number | null; name: string; dept: OrgDept; teamId: number | null; teamName: string | null;
  dashTeamId: number | null; dashTeamName: string | null;
  /** Ключ команди блоку (`k:<id>` / `d:<id>`), за яким сюди потрапляють люди. `null` — блок-контейнер. */
  teamKey: string | null;
  /** Назва команди блоку (Kommo або дашборду). `null` — блок-контейнер. */
  label: string | null; ownLabel: string | null;
  headId: number | null; headSource: "manual" | "team" | null; side: boolean; sort: number; memberIds: number[];
}
export interface OrgPerson {
  id: number; name: string; position: string | null; teamLabel: string | null; unitId: number | null; isHead: boolean;
  /** Справжня команда людини і чи вона з Kommo (тоді змінюють її лише в Kommo). */
  teamName: string | null; teamLocked: boolean;
  telegram: string | null; telegramInvalid: boolean; phone: { text: string; tel: string | null } | null;
  photo: { id: number; v: number } | null; isMe: boolean;
}
export interface OrgTree {
  units: OrgUnit[]; people: OrgPerson[]; unassigned: number[];
  unknownLabels: { label: string; count: number }[];
  stats: { total: number; noTelegram: number; noPhoto: number; unassigned: number };
}

const byUk = (a: string, b: string) => a.localeCompare(b, "uk");
/** Назва команди блоку: команда Kommo або команда дашборду; власний текст блоку більше людей не розставляє. */
const unitTeamName = (u: Pick<UnitRow, "teamName" | "dashTeamName">) => u.teamName?.trim() || u.dashTeamName?.trim() || null;

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
      dashTeamId: u.dashTeamId, dashTeamName: u.dashTeamName, teamKey: unitTeamKey(u),
      label: unitTeamName(u), ownLabel: u.label, headId, headSource: manual != null ? "manual" : team != null ? "team" : null,
      side: u.side, sort: u.sort, memberIds: [],
    };
  });
  const byKey = new Map<string, OrgUnit>();
  for (const u of out) if (u.teamKey && !byKey.has(u.teamKey)) byKey.set(u.teamKey, u);
  const teamOf = new Map(personRows.map((p) => [p.id, effectiveTeam(p)]));
  const unknown = new Map<string, { label: string; count: number }>();
  for (const p of personRows) {
    if (placed.has(p.id)) continue;
    const k = teamOf.get(p.id)!.key;
    const u = k ? byKey.get(k) : undefined;
    if (u) { u.memberIds.push(p.id); placed.set(p.id, { unitId: u.id, isHead: false }); continue; }
    placed.set(p.id, { unitId: null, isHead: false });
    // Команда є, але блоку під неї немає — її назва; команди немає — старий текст «Команди» (видно, що там «9»).
    const shown = k ? `${p.teamName ?? "команда"} — блоку немає` : p.teamLabel?.trim() ? `«${p.teamLabel.trim()}» — команду не вибрано` : "Команду не вибрано";
    const e = unknown.get(shown) ?? { label: shown, count: 0 };
    e.count++; unknown.set(shown, e);
  }
  const people: OrgPerson[] = personRows.map((p) => {
    const where = placed.get(p.id)!;
    const nick = tgNick(p.telegram);
    return {
      id: p.id, name: p.name, position: p.position, teamLabel: p.teamLabel, unitId: where.unitId, isHead: where.isHead,
      teamName: p.teamName, teamLocked: teamOf.get(p.id)!.locked,
      telegram: nick, telegramInvalid: !nick && !!p.telegram?.trim(), phone: phoneView(p.phone), photo: p.photoV != null ? { id: p.id, v: p.photoV } : null,
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
    dash_team_id: number | null; dash_team_name: string | null; dash_linked_kommo_id: number | null;
    label: string | null; head_employee_id: number | null; team_lead_employee_id: number | null; side: boolean; sort: number }>(
    `SELECT u.id, u.parent_id, u.name, u.dept, u.team_id, t.name AS team_name,
            u.dashboard_team_id AS dash_team_id, d.name AS dash_team_name, d.kommo_team_id AS dash_linked_kommo_id,
            u.label, u.head_employee_id, u.side, u.sort,
            (SELECT e.id FROM managers m JOIN employees e ON e.manager_id = m.id AND ${WORKING_SQL}
              WHERE m.team_id = COALESCE(u.team_id, d.kommo_team_id) AND m.is_team_lead AND m.is_active ORDER BY e.id LIMIT 1) AS team_lead_employee_id
       FROM org_units u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN dashboard_teams d ON d.id = u.dashboard_team_id
      ORDER BY u.sort, u.id`);
  return r.rows.map((x) => ({ id: x.id, parentId: x.parent_id, name: x.name, dept: x.dept, teamId: x.team_id, teamName: x.team_name,
    dashTeamId: x.dash_team_id, dashTeamName: x.dash_team_name, dashLinkedKommoId: x.dash_linked_kommo_id,
    label: x.label, headEmployeeId: x.head_employee_id, teamLeadEmployeeId: x.team_lead_employee_id, side: x.side, sort: x.sort }));
}

async function personRows(db: Db): Promise<PersonRow[]> {
  // 🔒 Поля поіменно: пошти, дат, документів тут немає й бути не може (ТЗ); телефон — рішення Романа 28.10 (#2712).
  const r = await db.query<{ id: number; full_name: string; position: string | null; team_label: string | null; telegram: string | null; phone: string | null;
    user_id: number | null; has_photo: boolean; photo_updated_at: Date | null; team_name: string | null;
    kommo_team_id: number | null; card_team_id: number | null; dash_team_id: number | null; dash_linked_kommo_id: number | null }>(
    `SELECT e.id, e.full_name, e.position, e.team_label, e.telegram, e.phone, e.user_id,
            (e.photo_file IS NOT NULL) AS has_photo, e.photo_updated_at, ${PERSON_TEAM_COLS},
            COALESCE((SELECT name FROM teams WHERE id = COALESCE(tm1.team_id, tm2.team_id, e.team_id, tdt.kommo_team_id)), tdt.name) AS team_name
       FROM employees e ${PERSON_TEAM_JOINS} WHERE ${WORKING_SQL}`);
  return r.rows.map((x) => ({ id: x.id, name: x.full_name, position: x.position, teamLabel: x.team_label, telegram: x.telegram, phone: x.phone,
    userId: x.user_id, photoV: x.has_photo ? photoVersion(x.photo_updated_at) : null, teamName: x.team_name, ...personTeamInput(x) }));
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

/**
 * Перемістити людину в блок = поставити їй КОМАНДУ блоку (`setEmployeeTeam`: аудит реєстру, назва — у вітрину «Команди»).
 * `unitId = null` — команду зняти. Людина з Kommo — 409 (її команда з Kommo); блок-контейнер без команди — 409.
 */
export async function moveEmployee(db: Db, actor: number, employeeId: number, unitId: number | null): Promise<void> {
  const e = (await db.query<{ full_name: string; team_label: string | null }>(
    `SELECT e.full_name, e.team_label FROM employees e WHERE e.id = $1 AND ${WORKING_SQL}`, [employeeId])).rows[0];
  if (!e) throw new OrgError(404, "Серед працюючих такої людини немає");
  let unitName = "Без блоку";
  let ref: { kind: "kommo" | "dashboard"; id: number } | null = null;
  if (unitId != null) {
    const u = await oneUnit(db, unitId);
    if (u.teamId != null) ref = { kind: "kommo", id: u.teamId };
    else if (u.dashTeamId != null) ref = { kind: "dashboard", id: u.dashTeamId };
    else throw new OrgError(409, `У блоку «${u.name}» немає команди — привʼяжіть команду Kommo або команду дашборду`);
    unitName = u.name;
  }
  let r: { changed: string[]; name: string | null };
  try { r = await setEmployeeTeam(db, actor, employeeId, ref); }
  catch (x) { if (x instanceof TeamsError) throw new OrgError(x.status, x.message); throw x; }
  if (r.changed.length) await log(db, actor, "move", `${e.full_name} → ${unitName} (команда: ${e.team_label ?? "—"} → ${r.name ?? "—"})`,
    { employeeId, unitId, before: { team_label: e.team_label }, after: { team_label: r.name } });
}

interface UnitInput { name: string; parentId: number | null; dept: OrgDept; teamId: number | null; dashTeamId: number | null; label: string | null; headEmployeeId: number | null; side: boolean; sort: number }

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
 * Поля з тіла поверх поточних (для PATCH) або порожніх (для створення) — і повна перевірка результату. Команда блоку —
 * `team` (`k:<id>` / `d:<id>` / порожньо) або, як раніше, `teamId` (команда Kommo). Разом із полями повертає ключ
 * команди, яку блок матиме ПІСЛЯ запису: її перевіряють до `UPDATE`, а не після.
 */
async function resolveUnit(db: Db, body: Record<string, unknown>, cur: UnitInput | null, selfId: number | null): Promise<{ v: UnitInput; key: string | null }> {
  const has = (k: string) => Object.hasOwn(body, k);
  const next: UnitInput = cur ? { ...cur } : { name: "", parentId: null, dept: "top", teamId: null, dashTeamId: null, label: null, headEmployeeId: null, side: false, sort: 0 };
  if (has("name")) next.name = optText(body.name, 120, "Назва") ?? "";
  if (has("parentId")) next.parentId = optInt(body.parentId, "батьківський блок");
  if (has("dept")) { if (!isDept(body.dept)) throw new OrgError(400, "Невідомий відділ"); next.dept = body.dept; }
  if (has("team")) {
    const m = body.team == null || body.team === "" ? null : typeof body.team === "string" ? /^([kd]):(\d{1,9})$/.exec(body.team) : null;
    if (body.team != null && body.team !== "" && !m) throw new OrgError(400, "Некоректна команда блоку");
    next.teamId = m?.[1] === "k" ? Number(m[2]) : null;
    next.dashTeamId = m?.[1] === "d" ? Number(m[2]) : null;
  } else if (has("teamId")) { next.teamId = optInt(body.teamId, "id команди"); if (next.teamId != null) next.dashTeamId = null; }
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
  let teamName: string | null = null, linked: number | null = null;
  if (next.teamId != null) {
    teamName = (await db.query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [next.teamId])).rows[0]?.name ?? null;
    if (teamName == null) throw new OrgError(400, "Команди Kommo не знайдено");
  } else if (next.dashTeamId != null) {
    const d = (await db.query<{ name: string; archived: boolean; kommo_team_id: number | null }>(
      `SELECT name, (archived_at IS NOT NULL) AS archived, kommo_team_id FROM dashboard_teams WHERE id = $1`, [next.dashTeamId])).rows[0];
    if (!d) throw new OrgError(400, "Команди дашборду не знайдено");
    if (d.archived && d.name && next.dashTeamId !== cur?.dashTeamId) throw new OrgError(400, `Команда «${d.name}» в архіві`);
    teamName = d.name; linked = d.kommo_team_id;
  }
  const key = unitTeamKey({ teamId: next.teamId, dashTeamId: next.dashTeamId, dashLinkedKommoId: linked });
  const twin = key ? all.find((u) => u.id !== selfId && unitTeamKey(u) === key) : undefined;
  if (twin) throw new OrgError(409, `Команда «${teamName}» уже привʼязана до блоку «${twin.name}» — люди не знатимуть, куди йти`);
  if (next.headEmployeeId != null && !(await db.query(`SELECT 1 FROM employees e WHERE e.id = $1 AND ${WORKING_SQL}`, [next.headEmployeeId])).rowCount)
    throw new OrgError(400, "Керівником може бути лише працюючий із «Найму»");
  return { v: next, key };
}

const unitSnap = (u: UnitInput) => ({ name: u.name, parentId: u.parentId, dept: u.dept, teamId: u.teamId, dashTeamId: u.dashTeamId, label: u.label, headEmployeeId: u.headEmployeeId, side: u.side, sort: u.sort });

export async function createUnit(db: Db, actor: number, body: Record<string, unknown>): Promise<number> {
  const { v } = await resolveUnit(db, body ?? {}, null, null);
  const id = (await db.query<{ id: number }>(
    `INSERT INTO org_units (parent_id, name, dept, team_id, dashboard_team_id, label, head_employee_id, side, sort)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [v.parentId, v.name, v.dept, v.teamId, v.dashTeamId, v.label, v.headEmployeeId, v.side, v.sort])).rows[0].id;
  await log(db, actor, "unit.create", `Створено блок «${v.name}»`, { unitId: id, after: unitSnap(v) });
  return id;
}

/**
 * Зміна блоку. Люди належать КОМАНДІ, а не блоку: перейменування блоку нікого не рухає. Зміна команди блоку, у якому
 * є люди, — 409: інакше вони мовчки випали б у «Без блоку» (спершу перемістити людей або змінити їм команду).
 */
export async function updateUnit(db: Db, actor: number, id: number, body: Record<string, unknown>): Promise<void> {
  const cur = await oneUnit(db, id);
  const was: UnitInput = { name: cur.name, parentId: cur.parentId, dept: cur.dept, teamId: cur.teamId, dashTeamId: cur.dashTeamId, label: cur.label, headEmployeeId: cur.headEmployeeId, side: cur.side, sort: cur.sort };
  const { v, key } = await resolveUnit(db, body ?? {}, was, id);
  if (key !== unitTeamKey(cur)) {
    const members = (await loadOrg(db, null)).units.find((u) => u.id === id)?.memberIds.length ?? 0;
    if (members) throw new OrgError(409, `У блоці «${cur.name}» ${members} люд. їхньої команди — без неї вони випадуть у «Без блоку»; спершу перемістіть людей`);
  }
  await db.query(
    `UPDATE org_units SET parent_id = $2, name = $3, dept = $4, team_id = $5, dashboard_team_id = $6, label = $7, head_employee_id = $8,
            side = $9, sort = $10, updated_at = now() WHERE id = $1`,
    [id, v.parentId, v.name, v.dept, v.teamId, v.dashTeamId, v.label, v.headEmployeeId, v.side, v.sort]);
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
  await log(db, actor, "unit.delete", `Видалено блок «${u.name}»`, { unitId: id, before: { name: u.name, parentId: u.parentId, dept: u.dept, teamId: u.teamId, dashTeamId: u.dashTeamId, label: u.ownLabel, headId: u.headId } });
}

/** Журнал фото: саме фото пише `core/people.ts`; тут — лише запис «хто змінив своє фото». */
export async function logMyPhoto(db: Db, actor: number, employeeId: number): Promise<void> {
  await log(db, actor, "me.photo", "Змінено своє фото", { employeeId });
}
