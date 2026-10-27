/**
 * 👥 КОМАНДИ: KOMMO + ДАШБОРД (рішення Романа 27.10.2026). Схема — `dashboard_teams` + `employees.team_id` /
 * `employees.dashboard_team_id` + `org_units.dashboard_team_id`.
 *
 *  • Команди Kommo (`teams`) веде синк; їх читають 116 запитів продажів. Команди дашборду — ОКРЕМА таблиця, у `teams`
 *    не потрапляють ніколи: «IT відділ» не зʼявиться у фільтрах Звіту, КВП чи планів (#2852).
 *  • СПРАВЖНЯ КОМАНДА ЛЮДИНИ (`effectiveTeam`): звʼязаний із Kommo, і в Kommo є група, — команда Kommo, і змінити її
 *    в дашборді не можна (рішення 27.10, п.4: «ні»); інакше — вибрана в картці: команда Kommo або команда дашборду.
 *  • ЗʼЄДНАНА команда дашборду (`kommo_team_id`) показується як та команда Kommo: її люди — у блоці команди Kommo.
 *  • Нічого не видаляється: команда архівується, і лише порожня (без людей і без блоку).
 */
import type { Db } from "./secrets.js";

export class TeamsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type TeamKind = "kommo" | "dashboard";
export interface TeamRef { kind: TeamKind; id: number }

/** Ключ команди: `k:<id>` — Kommo, `d:<id>` — дашборд. Зʼєднана команда дашборду має ключ своєї команди Kommo. */
export const teamKey = (kind: TeamKind, id: number) => `${kind === "kommo" ? "k" : "d"}:${id}`;

/** «k:12» / «d:3» → посилання; порожньо → `null`; решта — 400. */
export function parseTeamRef(v: unknown): TeamRef | null {
  if (v == null || v === "") return null;
  const m = typeof v === "string" ? /^([kd]):(\d{1,9})$/.exec(v) : null;
  if (!m || Number(m[2]) <= 0) throw new TeamsError(400, "Некоректна команда");
  return { kind: m[1] === "k" ? "kommo" : "dashboard", id: Number(m[2]) };
}

/** Порівняння назв: регістр, пробіли й вид апострофа різницею не є (як «Команда» в орг-структурі). */
export function nameKey(s: string | null | undefined): string | null {
  if (s == null) return null;
  const k = s.normalize("NFC").toLowerCase().replace(/[’'`ʼ]/g, "ʼ").replace(/\s+/g, " ").trim();
  return k || null;
}

export interface PersonTeamInput {
  /** Група людини в Kommo (через `employees.manager_id` або акаунт). Є — команда звідти, і вона заблокована. */
  kommoTeamId: number | null;
  cardTeamId: number | null;
  dashTeamId: number | null;
  dashLinkedKommoId: number | null;
}
export interface PersonTeam { key: string | null; locked: boolean; source: "kommo" | "card" | null }

/** Чиста функція справжньої команди людини — одна на дерево, лічильники й картку. */
export function effectiveTeam(p: PersonTeamInput): PersonTeam {
  if (p.kommoTeamId != null) return { key: teamKey("kommo", p.kommoTeamId), locked: true, source: "kommo" };
  if (p.cardTeamId != null) return { key: teamKey("kommo", p.cardTeamId), locked: false, source: "card" };
  if (p.dashTeamId != null)
    return { key: p.dashLinkedKommoId != null ? teamKey("kommo", p.dashLinkedKommoId) : teamKey("dashboard", p.dashTeamId), locked: false, source: "card" };
  return { key: null, locked: false, source: null };
}

/** Ключ команди блоку орг-структури (або `null` — блок-контейнер). */
export function unitTeamKey(u: { teamId: number | null; dashTeamId: number | null; dashLinkedKommoId: number | null }): string | null {
  if (u.teamId != null) return teamKey("kommo", u.teamId);
  if (u.dashTeamId != null) return u.dashLinkedKommoId != null ? teamKey("kommo", u.dashLinkedKommoId) : teamKey("dashboard", u.dashTeamId);
  return null;
}

/** Стовпці й джойни справжньої команди людини (`e` — `employees`). Одне місце для дерева, списку й картки. */
export const PERSON_TEAM_COLS = `COALESCE(tm1.team_id, tm2.team_id) AS kommo_team_id, e.team_id AS card_team_id,
       e.dashboard_team_id AS dash_team_id, tdt.kommo_team_id AS dash_linked_kommo_id`;
export const PERSON_TEAM_JOINS = `LEFT JOIN managers tm1 ON tm1.id = e.manager_id
       LEFT JOIN users ttu ON ttu.id = e.user_id LEFT JOIN managers tm2 ON tm2.id = ttu.manager_id
       LEFT JOIN dashboard_teams tdt ON tdt.id = e.dashboard_team_id`;
export const personTeamInput = (r: { kommo_team_id: number | null; card_team_id: number | null; dash_team_id: number | null; dash_linked_kommo_id: number | null }): PersonTeamInput =>
  ({ kommoTeamId: r.kommo_team_id, cardTeamId: r.card_team_id, dashTeamId: r.dash_team_id, dashLinkedKommoId: r.dash_linked_kommo_id });

export interface TeamOption {
  key: string; kind: TeamKind; id: number; name: string;
  /** Для команди дашборду: з якою командою Kommo зʼєднана. */
  linkedKommoId: number | null; linkedKommoName: string | null;
  archived: boolean; members: number;
}

/** Обидві групи команд із кількістю працюючих людей (за справжньою командою). Архівні — наприкінці, з позначкою. */
export async function listTeams(db: Db): Promise<{ kommo: TeamOption[]; dashboard: TeamOption[] }> {
  const kommo = (await db.query<{ id: number; name: string }>(`SELECT id, name FROM teams ORDER BY name`)).rows;
  const dash = (await db.query<{ id: number; name: string; kommo_team_id: number | null; kommo_name: string | null; archived: boolean }>(
    `SELECT d.id, d.name, d.kommo_team_id, t.name AS kommo_name, (d.archived_at IS NOT NULL) AS archived
       FROM dashboard_teams d LEFT JOIN teams t ON t.id = d.kommo_team_id
      ORDER BY (d.archived_at IS NOT NULL), d.name`)).rows;
  const people = (await db.query<{ kommo_team_id: number | null; card_team_id: number | null; dash_team_id: number | null; dash_linked_kommo_id: number | null }>(
    `SELECT ${PERSON_TEAM_COLS} FROM employees e ${PERSON_TEAM_JOINS} WHERE e.status IN ('active','finishing')`)).rows;
  const byKey = new Map<string, number>();
  const byDash = new Map<number, number>();
  for (const r of people) {
    const t = effectiveTeam(personTeamInput(r));
    if (t.key) byKey.set(t.key, (byKey.get(t.key) ?? 0) + 1);
    if (t.source === "card" && r.dash_team_id != null) byDash.set(r.dash_team_id, (byDash.get(r.dash_team_id) ?? 0) + 1);
  }
  return {
    kommo: kommo.map((t) => ({ key: teamKey("kommo", t.id), kind: "kommo", id: t.id, name: t.name, linkedKommoId: null, linkedKommoName: null,
      archived: false, members: byKey.get(teamKey("kommo", t.id)) ?? 0 })),
    // Лічильник команди дашборду — її власні люди (навіть зʼєднаної: скільки людей вписано саме в неї).
    dashboard: dash.map((d) => ({ key: teamKey("dashboard", d.id), kind: "dashboard", id: d.id, name: d.name, linkedKommoId: d.kommo_team_id,
      linkedKommoName: d.kommo_name, archived: d.archived, members: byDash.get(d.id) ?? 0 })),
  };
}

async function teamLog(db: Db, actor: number, action: string, summary: string, before?: unknown, after?: unknown) {
  await db.query(`INSERT INTO org_log (actor_id, action, summary, before, after) VALUES ($1, $2, $3, $4, $5)`,
    [actor > 0 ? actor : null, action, summary, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)]);
}

const cleanName = (v: unknown): string => {
  if (typeof v !== "string") throw new TeamsError(400, "Назва команди — текст");
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) throw new TeamsError(400, "Назва команди обовʼязкова");
  if (s.length > 80) throw new TeamsError(400, "Назва команди — не довше 80 символів");
  return s;
};

/** Назва не повторює ні команду Kommo, ні живу команду дашборду (крім себе): інакше в списку дві «Бухгалтерії». */
async function assertNameFree(db: Db, name: string, selfId: number | null) {
  const k = nameKey(name);
  const kommo = (await db.query<{ name: string }>(`SELECT name FROM teams`)).rows.find((t) => nameKey(t.name) === k);
  if (kommo) throw new TeamsError(409, `Команда «${kommo.name}» уже є в Kommo — оберіть її або назвіть інакше`);
  const dash = (await db.query<{ id: number; name: string }>(`SELECT id, name FROM dashboard_teams WHERE archived_at IS NULL`)).rows
    .find((t) => t.id !== selfId && nameKey(t.name) === k);
  if (dash) throw new TeamsError(409, `Команда «${dash.name}» уже є в дашборді`);
}

/** Зʼєднати можна з наявною командою Kommo, і одна команда Kommo — лише з однією живою командою дашборду. */
async function assertLinkFree(db: Db, kommoTeamId: number, selfId: number | null): Promise<string> {
  const t = (await db.query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [kommoTeamId])).rows[0];
  if (!t) throw new TeamsError(400, "Команди Kommo не знайдено");
  const other = (await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM dashboard_teams WHERE archived_at IS NULL AND kommo_team_id = $1`, [kommoTeamId])).rows.find((d) => d.id !== selfId);
  if (other) throw new TeamsError(409, `З командою Kommo «${t.name}» уже зʼєднана «${other.name}»`);
  // Блок самої команди Kommo і блок зʼєднаної команди дашборду стали б двома місцями для тих самих людей.
  const twin = (await db.query<{ name: string }>(
    `SELECT u.name FROM org_units u JOIN dashboard_teams d ON d.id = u.dashboard_team_id
      WHERE d.id = $2 AND EXISTS (SELECT 1 FROM org_units k WHERE k.team_id = $1)`, [kommoTeamId, selfId ?? 0])).rows[0];
  if (twin) throw new TeamsError(409, `У «${t.name}» уже є свій блок на схемі — спершу відвʼяжіть блок «${twin.name}»`);
  return t.name;
}

const optKommoId = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new TeamsError(400, "Некоректна команда Kommo");
  return n;
};

export async function createDashboardTeam(db: Db, actor: number, body: Record<string, unknown>): Promise<number> {
  const name = cleanName(body?.name);
  await assertNameFree(db, name, null);
  const kommoTeamId = optKommoId(body?.kommoTeamId);
  const linked = kommoTeamId != null ? await assertLinkFree(db, kommoTeamId, null) : null;
  const id = (await db.query<{ id: number }>(
    `INSERT INTO dashboard_teams (name, kommo_team_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [name, kommoTeamId, actor > 0 ? actor : null])).rows[0].id;
  await teamLog(db, actor, "team.create", `Створено команду дашборду «${name}»${linked ? ` (зʼєднана з «${linked}»)` : ""}`,
    undefined, { id, name, kommoTeamId });
  return id;
}

/**
 * Перейменувати, зʼєднати / відʼєднати, архівувати / повернути. Архів — лише порожньої: без працюючих людей і без блоку
 * на схемі (інакше люди мовчки випали б у «Без блоку»). Нова назва переписується людям як вітрина (`team_label`).
 */
export async function updateDashboardTeam(db: Db, actor: number, id: number, body: Record<string, unknown>): Promise<void> {
  const cur = (await db.query<{ name: string; kommo_team_id: number | null; archived: boolean }>(
    `SELECT name, kommo_team_id, (archived_at IS NOT NULL) AS archived FROM dashboard_teams WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new TeamsError(404, "Команди дашборду не знайдено");
  const has = (k: string) => Object.hasOwn(body ?? {}, k);
  const next = { name: cur.name, kommoTeamId: cur.kommo_team_id, archived: cur.archived };
  if (has("name")) next.name = cleanName(body.name);
  if (has("kommoTeamId")) next.kommoTeamId = optKommoId(body.kommoTeamId);
  if (has("archived")) { if (typeof body.archived !== "boolean") throw new TeamsError(400, "Архів: так або ні"); next.archived = body.archived; }
  if (!next.archived && (nameKey(next.name) !== nameKey(cur.name) || cur.archived)) await assertNameFree(db, next.name, id);
  if (!next.archived && next.kommoTeamId != null && (next.kommoTeamId !== cur.kommo_team_id || cur.archived)) await assertLinkFree(db, next.kommoTeamId, id);
  if (next.archived && !cur.archived) {
    const people = Number((await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employees WHERE dashboard_team_id = $1 AND status IN ('active','finishing')`, [id])).rows[0].n);
    if (people) throw new TeamsError(409, `У команді «${cur.name}» ${people} люд. — спершу переведіть їх в іншу команду`);
    const unit = (await db.query<{ name: string }>(`SELECT name FROM org_units WHERE dashboard_team_id = $1`, [id])).rows[0];
    if (unit) throw new TeamsError(409, `Команда «${cur.name}» привʼязана до блоку «${unit.name}» на схемі — спершу відвʼяжіть блок`);
  }
  await db.query(
    `UPDATE dashboard_teams SET name = $2, kommo_team_id = $3,
            archived_at = CASE WHEN $4 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`,
    [id, next.name, next.kommoTeamId, next.archived]);
  if (next.name !== cur.name) await db.query(`UPDATE employees SET team_label = $2, updated_at = now() WHERE dashboard_team_id = $1`, [id, next.name]);
  const what = next.archived !== cur.archived ? (next.archived ? "архівовано" : "повернуто з архіву")
    : next.kommoTeamId !== cur.kommo_team_id ? (next.kommoTeamId ? "зʼєднано з командою Kommo" : "відʼєднано від Kommo") : "змінено";
  await teamLog(db, actor, "team.update", `Команду дашборду «${next.name}» ${what}`,
    { name: cur.name, kommoTeamId: cur.kommo_team_id, archived: cur.archived }, next);
}

/**
 * Команда людини з картки. Людина з групою в Kommo — 409: її команда приходить із Kommo (рішення 27.10, п.4).
 * Назва вибраної команди пишеться в `team_label` (вітрина й історія); зняти команду — і текст знімається, тож міграція
 * наступного викату її не поверне. В аудит — назви полів, без значень (правило реєстру).
 */
export async function setEmployeeTeam(db: Db, actor: number, employeeId: number, ref: TeamRef | null): Promise<{ changed: string[]; name: string | null }> {
  const p = (await db.query<{ full_name: string; team_label: string | null; kommo_team_id: number | null; kommo_name: string | null;
    card_team_id: number | null; dash_team_id: number | null }>(
    `SELECT e.full_name, e.team_label, COALESCE(tm1.team_id, tm2.team_id) AS kommo_team_id,
            (SELECT name FROM teams WHERE id = COALESCE(tm1.team_id, tm2.team_id)) AS kommo_name,
            e.team_id AS card_team_id, e.dashboard_team_id AS dash_team_id
       FROM employees e ${PERSON_TEAM_JOINS} WHERE e.id = $1 FOR UPDATE OF e`, [employeeId])).rows[0];
  if (!p) throw new TeamsError(404, "Співробітника не знайдено");
  if (p.kommo_team_id != null)
    throw new TeamsError(409, `Команда ${p.full_name} — з Kommo («${p.kommo_name}»). Змінюють її в Kommo, синк перенесе сам`);
  let teamId: number | null = null, dashId: number | null = null, name: string | null = null;
  if (ref?.kind === "kommo") {
    name = (await db.query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [ref.id])).rows[0]?.name ?? null;
    if (name == null) throw new TeamsError(400, "Команди Kommo не знайдено");
    teamId = ref.id;
  } else if (ref?.kind === "dashboard") {
    const d = (await db.query<{ name: string; archived: boolean }>(
      `SELECT name, (archived_at IS NOT NULL) AS archived FROM dashboard_teams WHERE id = $1`, [ref.id])).rows[0];
    if (!d) throw new TeamsError(400, "Команди дашборду не знайдено");
    if (d.archived) throw new TeamsError(400, `Команда «${d.name}» в архіві`);
    dashId = ref.id; name = d.name;
  }
  const changed = [
    ...(p.card_team_id !== teamId ? ["team_id"] : []),
    ...(p.dash_team_id !== dashId ? ["dashboard_team_id"] : []),
    ...((p.team_label ?? null) !== name ? ["team_label"] : []),
  ];
  if (!changed.length) return { changed, name };
  await db.query(`UPDATE employees SET team_id = $2, dashboard_team_id = $3, team_label = $4, updated_at = now() WHERE id = $1`,
    [employeeId, teamId, dashId, name]);
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), 'employees.update', 'user', $2, $3, $4)`,
    [actor > 0 ? actor : null, `e${employeeId}`, p.full_name, { changed }]);
  return { changed, name };
}
