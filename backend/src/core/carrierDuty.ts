import type { Db } from "./adCallFacts.js";
import type { CloseMode } from "./carrierClose.js";
import { SERVICE_KOMMO_USER_IDS } from "./orphanClients.js";
import { leadReminderDue } from "./carrierLeadReminder.js";

/**
 * 🚚 УГОДИ «ОПЕРАЦІЙНОГО ДИРЕКТОРА» → ЧЕРГОВОМУ МЕНЕДЖЕРУ ДНЯ (задача 5972; рішення Юлі 19.10.2026).
 *
 * На етапі «Дзвінки на мобільні» частина угод створюється на службовому акаунті «Операційний директор» (Kommo 904923).
 * Його ніхто не розбирає: його задача «розібрати» висіла простроченою 11 днів. Правило Юлі:
 *  1) угоду отримує той, хто сьогодні черговий за графіком чергувань («Календар команди»); якщо чергових кілька —
 *     по черзі між ними (кому сьогодні дісталось найменше — тому наступна; рівно — молодший id);
 *  2) якщо на день ніхто не записаний — угода лишається на «Операційному директорі», а КВП о 17:00 отримує нагадування;
 *  3) субота й неділя — те саме правило.
 *
 * Режими — як в автозакриття: `dry` пише лише журнал («кому віддали б»), `live` міняє відповідального в Kommo. Угоду,
 * яку вже записано в журнал, але ще не віддано (dry або збій), live переприсвоює ЗА СЬОГОДНІШНІМ графіком.
 */

export const DUTY_RETRY_AFTER_MIN = 60;

export interface DutyKommo {
  patchLeads: (body: unknown[]) => Promise<unknown>;
  addNotes: (body: unknown[]) => Promise<unknown>;
}

export interface DutyManager { managerId: number; kommoUserId: number; name: string }
export interface AssignReport { mode: CloseMode; candidates: number; noDuty: number; logged: number; assigned: number; failed: number; error: string | null }

/** Чергові на день (Київ): активні, з Kommo-акаунтом, не службові; кожен один раз, хоч би скільки змін. */
export async function dutyManagersOn(db: Db, day: string): Promise<DutyManager[]> {
  const r = await db.query<{ id: number; kommo_user_id: string; name: string }>(`
    SELECT DISTINCT m.id, m.kommo_user_id::text, m.name
      FROM duty_schedule ds JOIN managers m ON m.id = ds.manager_id
     WHERE ds.duty_date = $1::date AND m.is_active AND m.kommo_user_id IS NOT NULL
       AND NOT (m.kommo_user_id::text = ANY($2::text[]))
     ORDER BY m.id`, [day, [...SERVICE_KOMMO_USER_IDS]]);
  return r.rows.map((x) => ({ managerId: x.id, kommoUserId: Number(x.kommo_user_id), name: x.name }));
}

/**
 * Хто отримує наступну угоду: черговий, якому СЬОГОДНІ віддано найменше (журнал + цей прохід); рівно — менший id.
 * Чиста функція: `taken` змінюється на місці, щоб кілька угод одного проходу розійшлись по черзі.
 */
export function pickDuty(duty: readonly DutyManager[], taken: Map<number, number>): DutyManager | null {
  let best: DutyManager | null = null;
  for (const d of duty) {
    const n = taken.get(d.managerId) ?? 0;
    if (!best || n < (taken.get(best.managerId) ?? 0) || (n === (taken.get(best.managerId) ?? 0) && d.managerId < best.managerId)) best = d;
  }
  if (best) taken.set(best.managerId, (taken.get(best.managerId) ?? 0) + 1);
  return best;
}

export const dutyNoteText = (name: string, day: string): string =>
  `Призначено черговому менеджеру ${name} автоматично (графік чергувань на ${day.slice(8, 10)}.${day.slice(5, 7)}): угода була на службовому акаунті «Операційний директор».`;

/**
 * Один прохід. `onStage` — угоди, що ЗАРАЗ на етапі за відповіддю Kommo цього проходу; беремо лише ті, що вже записані
 * автоматикою (минули 15 хв фільтра CRM) і досі на службовому акаунті.
 */
export async function runDutyAssign(db: Db, now: Date, mode: CloseMode, onStage: ReadonlySet<number>, kommo: DutyKommo | null): Promise<AssignReport> {
  const rep: AssignReport = { mode, candidates: 0, noDuty: 0, logged: 0, assigned: 0, failed: 0, error: null };
  if (mode === "off" || !onStage.size) return rep;
  const day = leadReminderDue(now).day;
  const cands = (await db.query<{ kommo_id: string; logged: boolean; assigned: boolean; recent_fail: boolean }>(`
    SELECT d.kommo_id::text, l.kommo_id IS NOT NULL AS logged, l.assigned_at IS NOT NULL AS assigned,
           (l.assign_error IS NOT NULL AND l.last_try_at > $3::timestamptz - make_interval(mins => $4)) AS recent_fail
      FROM carrier_call_deals d LEFT JOIN carrier_duty_assign_log l ON l.kommo_id = d.kommo_id
     WHERE d.kommo_id = ANY($1::bigint[]) AND d.responsible_user_id::text = ANY($2::text[])
     ORDER BY d.deal_created_at, d.kommo_id`,
  [[...onStage], [...SERVICE_KOMMO_USER_IDS], now.toISOString(), DUTY_RETRY_AFTER_MIN])).rows
    .filter((x) => !x.assigned && !x.recent_fail);
  rep.candidates = cands.length;
  if (!cands.length) return rep;
  const duty = await dutyManagersOn(db, day);
  if (!duty.length) { rep.noDuty = cands.length; return rep; }
  const taken = new Map((await db.query<{ manager_id: number; n: number }>(
    "SELECT manager_id, count(*)::int AS n FROM carrier_duty_assign_log WHERE duty_date = $1::date AND assigned_at IS NOT NULL GROUP BY 1", [day])).rows
    .map((x) => [x.manager_id, x.n]));
  const at = now.toISOString();
  for (const c of cands) {
    const who = pickDuty(duty, taken);
    if (!who) break;
    const id = Number(c.kommo_id);
    await db.query(`
      INSERT INTO carrier_duty_assign_log (kommo_id, manager_id, kommo_user_id, duty_date, decided_at, mode)
      VALUES ($1, $2, $3, $4::date, $5, $6)
      ON CONFLICT (kommo_id) DO UPDATE SET manager_id = EXCLUDED.manager_id, kommo_user_id = EXCLUDED.kommo_user_id,
        duty_date = EXCLUDED.duty_date, decided_at = EXCLUDED.decided_at, mode = EXCLUDED.mode
      WHERE carrier_duty_assign_log.assigned_at IS NULL`, [id, who.managerId, who.kommoUserId, day, at, mode === "live" ? "live" : "dry"]);
    if (!c.logged) rep.logged++;
    if (mode !== "live" || !kommo) continue;
    try {
      await kommo.patchLeads([{ id, responsible_user_id: who.kommoUserId }]);
    } catch (e) {
      rep.failed++; rep.error = e instanceof Error ? e.message : String(e);
      await db.query("UPDATE carrier_duty_assign_log SET assign_error = $2, last_try_at = $3 WHERE kommo_id = $1", [id, rep.error, at]);
      continue;
    }
    await db.query("UPDATE carrier_duty_assign_log SET assigned_at = $2, assign_error = NULL, last_try_at = $2 WHERE kommo_id = $1", [id, at]);
    // Відповідальний для автоматики — одразу новий: клієнта (5970) перенесуть уже на чергового, а не на службовий акаунт.
    await db.query("UPDATE carrier_call_deals SET responsible_user_id = $2, updated_at = $3 WHERE kommo_id = $1", [id, who.kommoUserId, at]);
    rep.assigned++;
    await kommo.addNotes([{ entity_id: id, note_type: "common", params: { text: dutyNoteText(who.name, day) } }]).catch(() => { /* примітка — не головне */ });
  }
  return rep;
}

/* ───────────── 🔔 КВП о 17:00: «у графіку чергувань на сьогодні нікого» ───────────── */

export const DUTY_ALERT_DONE_REASON = "Закрито автоматично: угод «Дзвінків на мобільні» на «Операційному директорі» більше немає або черговий з'явився.";
export const dutyAlertTitle = (n: number): string => `🚚 Графік чергувань: на сьогодні нікого — ${String(n)} угод «Дзвінки на мобільні» на «Операційному директорі»`;
export function dutyAlertDescription(n: number, day: string): string {
  return [
    `На ${day.slice(8, 10)}.${day.slice(5, 7)} у графіку чергувань («Календар команди») ніхто не записаний, тож ${String(n)} угод етапу «Дзвінки на мобільні» лишились на службовому акаунті «Операційний директор» — їх ніхто не розбирає.`,
    "Що зробити: поставити чергового на сьогодні — угоди перейдуть до нього автоматично протягом 5 хв; або розподілити вручну в Kommo.",
    "Задача закриється сама, щойно таких угод не буде. Створено автоматично о 17:00.",
  ].join("\n");
}
export interface DutyAlertStats { due: boolean; pending: number; created: number; updated: number; closed: number }

/**
 * Один прохід. Задача КВП ставиться першим проходом після 17:00 у будній день (так само, як нагадування тімлідам), якщо
 * на сьогодні немає чергового, а угоди на службовому акаунті є; оновлюється числом; закривається сама, щойно їх немає
 * або черговий з'явився. Розподіл у вихідні працює за тим самим графіком — нагадування лише в будні.
 */
export async function syncDutyAlerts(db: Db, now: Date, onStage: ReadonlySet<number>): Promise<DutyAlertStats> {
  const { due, day } = leadReminderDue(now);
  const stats: DutyAlertStats = { due, pending: 0, created: 0, updated: 0, closed: 0 };
  const at = now.toISOString();
  const pending = onStage.size ? (await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM carrier_call_deals WHERE kommo_id = ANY($1::bigint[]) AND responsible_user_id::text = ANY($2::text[])",
    [[...onStage], [...SERVICE_KOMMO_USER_IDS]])).rows[0].n : 0;
  const noDuty = (await dutyManagersOn(db, day)).length === 0;
  const need = noDuty && pending > 0;
  stats.pending = need ? pending : 0;
  const open = (await db.query<{ task_id: number; status: string | null; user_id: number }>(`
    SELECT a.task_id, t.status, a.user_id FROM carrier_duty_alerts a LEFT JOIN tasks t ON t.id = a.task_id WHERE a.closed_at IS NULL`)).rows;
  for (const o of open) {
    if (o.status == null || o.status === "done") { await db.query("UPDATE carrier_duty_alerts SET closed_at = $2 WHERE task_id = $1", [o.task_id, at]); continue; }
    if (!need) {
      await db.query(`UPDATE tasks SET status = 'done', close_reason = $2, closed_at = $3, updated_at = $3 WHERE id = $1 AND status <> 'done'`, [o.task_id, DUTY_ALERT_DONE_REASON, at]);
      await db.query("INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, 'done', NULL)", [o.task_id, o.status]);
      await db.query("UPDATE carrier_duty_alerts SET closed_at = $2 WHERE task_id = $1", [o.task_id, at]);
      stats.closed++;
      continue;
    }
    const u = await db.query(`UPDATE tasks SET title = $2, description = $3, deadline = $4::date, updated_at = $5
                                WHERE id = $1 AND (title IS DISTINCT FROM $2 OR deadline IS DISTINCT FROM $4::date)`,
      [o.task_id, dutyAlertTitle(pending), dutyAlertDescription(pending, day), day, at]);
    if (u.rowCount) stats.updated++;
  }
  if (!need || !due || open.some((o) => o.status != null && o.status !== "done")) return stats;
  const kvp = (await db.query<{ id: number }>(
    "SELECT id FROM users WHERE is_active AND COALESCE(role_override, role) = 'kvp' ORDER BY id LIMIT 1")).rows[0];
  if (!kvp) return stats;
  await db.query(`
    WITH x AS (
      INSERT INTO tasks (title, description, status, deadline, assignee_user_id, priority, department, task_type, created_at, updated_at)
      VALUES ($1, $2, 'not_started', $3::date, $4, 'high', 'Дзвінки на мобільні', 'simple', $5, $5) RETURNING id)
    INSERT INTO carrier_duty_alerts (task_id, user_id, alert_day, opened_at) SELECT id, $4, $3::date, $5 FROM x`,
  [dutyAlertTitle(pending), dutyAlertDescription(pending, day), day, kvp.id, at]);
  stats.created++;
  return stats;
}
