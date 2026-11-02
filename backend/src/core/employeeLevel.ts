/**
 * 🎚 РІВЕНЬ УМОВ «СТАРТ» / «ПРОФІ» (03.11.2026, ТЗ Івана). Рішення Романа: це СТАТУС, а не гроші — рівень ставлять і
 * змінюють руками, жодного розрахунку від маржі тут немає.
 *
 * Правила (з «Універсального оферу Старт/Профі»):
 *  · рівень мають лише менеджери з продажу (категорія `manager`, `core/employeeCategory.ts`); решті — null;
 *  · без жодного запису — «Старт» (так стартує кожен менеджер);
 *  · «Профі» назад на «Старт» не переводять; помилковий перехід СКАСОВУЮТЬ (`cancelled_at`), запис лишається в історії;
 *  · поточний рівень — останній нескасований запис за місяцем, з якого діє.
 * Тримає #2970–#2972.
 */
import { ImportError } from "./employeeImport.js";
import { effectiveCategory } from "./employeeCategory.js";
import type { Db } from "./secrets.js";

export type EmpLevel = "start" | "pro";
export interface LevelEntry { id: number; level: EmpLevel; from_month: string; note: string; by: string | null; at: string; cancelled: boolean }
export interface LevelState { level: EmpLevel; from: string | null; history: LevelEntry[] }

/** Чисте правило: поточний рівень за історією. Скасовані не рахуються; за рівного місяця перемагає пізніший запис. */
export function currentLevel(entries: Pick<LevelEntry, "id" | "level" | "from_month" | "cancelled">[]): { level: EmpLevel; from: string | null } {
  const live = entries.filter((e) => !e.cancelled).sort((a, b) => b.from_month.localeCompare(a.from_month) || b.id - a.id);
  return live[0] ? { level: live[0].level, from: live[0].from_month } : { level: "start", from: null };
}

/** Рівні всіх людей реєстру: `null` — людина не менеджер з продажу (рівень її не стосується). */
export async function levelsByEmployee(db: Db): Promise<Map<number, LevelState>> {
  const rows = (await db.query<LevelEntry & { employee_id: number }>(
    `SELECT l.id, l.employee_id, l.level, l.from_month::text AS from_month, l.note,
            COALESCE(u.full_name, u.email) AS by, l.created_at::text AS at, (l.cancelled_at IS NOT NULL) AS cancelled
       FROM employee_levels l LEFT JOIN users u ON u.id = l.created_by
      ORDER BY l.from_month DESC, l.id DESC`)).rows;
  const by = new Map<number, LevelEntry[]>();
  for (const { employee_id, ...e } of rows) by.set(employee_id, [...(by.get(employee_id) ?? []), e]);
  const out = new Map<number, LevelState>();
  for (const [id, history] of by) out.set(id, { ...currentLevel(history), history });
  return out;
}

const monthOf = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : null);

async function salesEmployee(db: Db, id: number) {
  const e = (await db.query<{ id: number; full_name: string; position: string | null; category: string | null; status: string }>(
    `SELECT id, full_name, position, category, status FROM employees WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!e) throw new ImportError(404, "Співробітника не знайдено");
  if (effectiveCategory(e.category, e.position) !== "manager") throw new ImportError(409, "Рівень «Старт / Профі» є лише в менеджерів з продажу");
  return e;
}

async function audit(db: Db, actorId: number, id: number, label: string, action: string, details: object) {
  await db.query(
    `INSERT INTO access_audit (actor_user_id, actor_email, action, target_type, target_id, target_label, details)
     VALUES ($1, (SELECT email FROM users WHERE id = $1), $2, 'user', $3, $4, $5)`,
    [actorId, action, `e${id}`, label, details]);
}

/** «Перевести на Профі»: місяць «РРРР-ММ», з якого діє, і обовʼязковий коментар. Уже «Профі» — 409. */
export async function promoteToPro(db: Db, actorId: number, id: number, body: { month?: unknown; comment?: unknown }) {
  const e = await salesEmployee(db, id);
  const month = monthOf(body.month);
  if (!month) throw new ImportError(400, "Вкажіть місяць, з якого діє «Профі»");
  const note = typeof body.comment === "string" ? body.comment.trim().slice(0, 300) : "";
  if (!note) throw new ImportError(400, "Коментар обовʼязковий: чому переводите");
  const cur = (await levelsByEmployee(db)).get(id);
  if (cur?.level === "pro") throw new ImportError(409, "Людина вже на «Профі» — назад на «Старт» не переводять");
  const lid = (await db.query<{ id: number }>(
    `INSERT INTO employee_levels (employee_id, level, from_month, note, created_by) VALUES ($1, 'pro', $2, $3, $4) RETURNING id`,
    [id, month, note, actorId])).rows[0].id;
  await audit(db, actorId, id, e.full_name, "employees.level", { to: "pro", from_month: month, comment: note, levelId: lid });
  return { level: "pro" as const, from: month };
}

/** «Скасувати» помилковий перехід: знімає останній нескасований запис. Нічого не видаляється. */
export async function cancelLastLevel(db: Db, actorId: number, id: number) {
  const e = await salesEmployee(db, id);
  const last = (await db.query<{ id: number; level: string; from_month: string }>(
    `SELECT id, level, from_month::text AS from_month FROM employee_levels WHERE employee_id = $1 AND cancelled_at IS NULL
      ORDER BY from_month DESC, id DESC LIMIT 1`, [id])).rows[0];
  if (!last) throw new ImportError(409, "Скасовувати нічого — переходів не було");
  await db.query(`UPDATE employee_levels SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1`, [last.id, actorId]);
  await audit(db, actorId, id, e.full_name, "employees.level_cancel", { levelId: last.id, level: last.level, from_month: last.from_month });
  return currentLevel(((await levelsByEmployee(db)).get(id)?.history) ?? []);
}
