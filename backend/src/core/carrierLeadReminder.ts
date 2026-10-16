import type { Db } from "./adCallFacts.js";
import { decisionQueue, type PendingRow } from "./carrierDecisions.js";

/**
 * 🚚 НАГАДУВАННЯ ТІМЛІДУ О 17:00 (задача 5964, підзадача 5960, Юля 16.10.2026).
 *
 * Менеджер і так має задачу «📞 Дзвінки на мобільні: розібрати N» (`carrierReviewTasks.ts`, Роман 30.09.2026: «тільки в
 * задачник»). Заміряно 16.10.2026: такі задачі висіли простроченими по 11 днів — канал є, контролю немає. Тому тімліду
 * в будній день о 17:00 — ОДНА задача на команду: скільки в команді ще чекає рішення і в кого. Строк — сьогодні.
 *
 * Черга та сама, що вкладка, задачі менеджерам і колонка «Чекають рішення зараз» у Звіті (`decisionQueue`: «На
 * перевірці» й «Помилка», досі на етапі) — тож число в задачі тімліда не може розійтися з екраном.
 *
 * Перший прохід джоби перевізників після 17:00 у будній день ставить задачу (чи оновлює відкриту й переносить строк на
 * сьогодні) — рівно раз на день (`reminded_on`). Решта проходів лише оновлюють число; команда все розібрала — задача
 * закривається сама. Угоди без команди (службовий «Операційний директор») тімлідам не йдуть: це не їхня команда.
 */

export const LEAD_REMIND_HOUR = 17;
export const LEAD_TASK_DONE_REASON = "Закрито автоматично: у команді всі дзвінки на мобільні розібрано.";

const kyivParts = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
};

/** Чи настав час нагадування: будній день за Києвом і вже 17:00 або пізніше. */
export function leadReminderDue(now: Date): { due: boolean; day: string } {
  const k = kyivParts(now);
  return { due: !["Sat", "Sun"].includes(k.weekday) && k.hour >= LEAD_REMIND_HOUR, day: k.day };
}

export interface TeamLine { managerName: string; n: number; overdue: number }
export interface TeamPending { teamId: number; teamName: string; n: number; overdue: number; lines: TeamLine[] }

/** Черга → по командах (без команди — не тімліду), у команді — по менеджерах, найбільше першим. */
export function pendingByTeam(pending: readonly Pick<PendingRow, "teamId" | "teamName" | "managerName" | "overdue">[]): Map<number, TeamPending> {
  const out = new Map<number, TeamPending>();
  for (const p of pending) {
    if (p.teamId == null) continue;
    let t = out.get(p.teamId);
    if (!t) { t = { teamId: p.teamId, teamName: p.teamName ?? `Команда #${String(p.teamId)}`, n: 0, overdue: 0, lines: [] }; out.set(p.teamId, t); }
    const name = p.managerName ?? "без менеджера";
    let l = t.lines.find((x) => x.managerName === name);
    if (!l) { l = { managerName: name, n: 0, overdue: 0 }; t.lines.push(l); }
    t.n++; l.n++;
    if (p.overdue) { t.overdue++; l.overdue++; }
  }
  for (const t of out.values()) t.lines.sort((a, b) => b.n - a.n || a.managerName.localeCompare(b.managerName, "uk"));
  return out;
}

export function leadTaskTitle(t: Pick<TeamPending, "n" | "overdue">): string {
  return `🚚 Команда: не розібрано дзвінків на мобільні — ${String(t.n)}${t.overdue ? ` (прострочено ${String(t.overdue)})` : ""}`;
}
export function leadTaskDescription(t: TeamPending): string {
  return [
    `${t.teamName}: AI не впевнений — дзвінки чекають рішення менеджерів.`,
    ...t.lines.map((l) => `• ${l.managerName} — ${String(l.n)}${l.overdue ? `, прострочено ${String(l.overdue)}` : ""}`),
    "Де: «Перевізники за розмовою» → вкладка «AI не впевнений» (менеджер відкриває угоду, слухає й тисне «Клієнт», «Перевізник» або «Інше»).",
    "У кожного менеджера є своя задача «📞 Дзвінки на мобільні: розібрати N». Ця задача закриється сама, щойно команда все розбере.",
    "Створено автоматично о 17:00.",
  ].join("\n");
}

export interface LeadReminderStats { teams: number; created: number; reminded: number; updated: number; closed: number }

/**
 * Один прохід: оновити/закрити відкриті задачі тімлідів; якщо настав час нагадування — поставити нові й перенести строк
 * відкритих на сьогодні (раз на день).
 */
export async function syncLeadReminders(db: Db, now: Date, launchAt: Date | null): Promise<LeadReminderStats> {
  const stats: LeadReminderStats = { teams: 0, created: 0, reminded: 0, updated: 0, closed: 0 };
  const { pending } = await decisionQueue(db, now, {}, 30, launchAt ? launchAt.toISOString() : null);
  const byTeam = pendingByTeam(pending);
  stats.teams = byTeam.size;
  const { due, day } = leadReminderDue(now);
  const at = now.toISOString();

  const open = new Map((await db.query<{ team_id: number; task_id: number; status: string | null; reminded_on: string }>(`
    SELECT l.team_id, l.task_id, t.status, to_char(l.reminded_on, 'YYYY-MM-DD') AS reminded_on
      FROM carrier_lead_tasks l LEFT JOIN tasks t ON t.id = l.task_id WHERE l.closed_at IS NULL`)).rows.map((x) => [x.team_id, x]));
  // Задачу закрив чи видалив тімлід — журнал закриваємо; наступне нагадування поставить нову.
  for (const [team, o] of open) {
    if (o.status == null || o.status === "done") {
      await db.query("UPDATE carrier_lead_tasks SET closed_at = $2 WHERE task_id = $1", [o.task_id, at]);
      open.delete(team);
    }
  }

  for (const [team, o] of open) {
    const t = byTeam.get(team);
    if (!t) {
      // Команда все розібрала — задача закривається сама, з причиною й записом у журналі статусів.
      await db.query(`UPDATE tasks SET status = 'done', close_reason = $2, closed_at = $3, updated_at = $3 WHERE id = $1 AND status <> 'done'`,
        [o.task_id, LEAD_TASK_DONE_REASON, at]);
      await db.query("INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, 'done', NULL)", [o.task_id, o.status ?? "not_started"]);
      await db.query("UPDATE carrier_lead_tasks SET closed_at = $2 WHERE task_id = $1", [o.task_id, at]);
      stats.closed++;
      continue;
    }
    if (due && o.reminded_on < day) {
      await db.query("UPDATE tasks SET title = $2, description = $3, deadline = $4::date, updated_at = $5 WHERE id = $1",
        [o.task_id, leadTaskTitle(t), leadTaskDescription(t), day, at]);
      await db.query("UPDATE carrier_lead_tasks SET reminded_on = $2::date WHERE task_id = $1", [o.task_id, day]);
      stats.reminded++;
      continue;
    }
    const upd = await db.query(`UPDATE tasks SET title = $2, description = $3, updated_at = $4
                                 WHERE id = $1 AND (title IS DISTINCT FROM $2 OR description IS DISTINCT FROM $3)`,
      [o.task_id, leadTaskTitle(t), leadTaskDescription(t), at]);
    if (upd.rowCount) stats.updated++;
  }

  if (!due) return stats;
  const leads = new Map((await db.query<{ team_id: number; user_id: number }>(`
    SELECT DISTINCT ON (u.team_id) u.team_id, u.id AS user_id FROM users u
     WHERE COALESCE(u.role_override, u.role) = 'team_lead' AND u.team_id IS NOT NULL AND u.is_active
     ORDER BY u.team_id, u.id`)).rows.map((x) => [x.team_id, x.user_id]));
  for (const [team, t] of byTeam) {
    if (open.has(team)) continue;
    const lead = leads.get(team);
    if (lead == null) continue; // тімліда-акаунта немає — задачу нікому (команда видна керівництву у Звіті)
    // Задача й рядок журналу — ОДНИМ оператором (той самий прийом, що в `carrierReviewTasks`): друга відкрита на команду
    // впреться в унікальний індекс, а не дасть дубль.
    await db.query(
      `WITH x AS (
         INSERT INTO tasks (title, description, status, deadline, assignee_user_id, priority, department, task_type, created_at, updated_at)
         VALUES ($1, $2, 'not_started', $3::date, $4, 'high', $5, 'simple', $6, $6) RETURNING id)
       INSERT INTO carrier_lead_tasks (task_id, team_id, lead_user_id, opened_at, reminded_on) SELECT id, $7, $4, $6, $3::date FROM x`,
      [leadTaskTitle(t), leadTaskDescription(t), day, lead, t.teamName, at, team]);
    stats.created++;
  }
  return stats;
}
