import type { Db } from "./adCallFacts.js";
import { normalizePhone } from "../utils/phone.js";
import { OUTBOUND_TYPES } from "./missedCallsRules.js";
import { LEADGEN_CALL_MIN_SEC } from "./leadgenRules.js";
import type { Responsible } from "./prozorroPush.js";
import type { PzConfig } from "./prozorroSettings.js";
import { assignTarget, callClosesTask, contactTaskText, contactTaskTitle, CONTACT_DONE_REASON, CONTACT_TASK_DEPARTMENT, CONTACT_TASKS_FROM,
  OPDIR_KOMMO_USER_ID, type AssignTarget } from "./prozorroAssign.js";

/**
 * 🎯 ПРОЗОРРО: КОМУ УГОДИ, ЗАДАЧА «ЗВʼЯЗАТИСЯ» І ЇЇ АВТОЗАКРИТТЯ (задача 8731). Правила — чисті, у `core/prozorroAssign.ts`;
 * тут лише читання й запис. Механізм задач — той самий, що автозадачі «Першого дотику» (`core/firstTouchAutoTasks.ts`):
 * задача + позначка в рядку джерела, повтор не ставить другої.
 */

const kyivDay = (d: Date): string => d.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

/** Хто отримує угоди сьогодні: ОД, вибрана людина чи черговий. `who` — null, якщо не вибрано (угоди чекають). */
export async function resolveResponsible(db: Db, cfg: PzConfig, now: Date): Promise<{ target: AssignTarget; who: Responsible | null }> {
  const target = assignTarget(cfg, kyivDay(now));
  if (target.kind === "none") return { target, who: null };
  const r = (await db.query<{ id: number; name: string; kommo_user_id: string | null; is_active: boolean }>(
    target.kind === "opdir"
      ? `SELECT id, name, kommo_user_id::text, is_active FROM managers WHERE kommo_user_id = $1 ORDER BY id LIMIT 1`
      : `SELECT id, name, kommo_user_id::text, is_active FROM managers WHERE id = $1`,
    [target.kind === "opdir" ? OPDIR_KOMMO_USER_ID : target.managerId])).rows[0];
  return { target, who: r ? { managerId: r.id, name: r.name, kommoUserId: r.kommo_user_id ? Number(r.kommo_user_id) : null, active: r.is_active } : null };
}

/**
 * 📋 Задача «звʼязатися» по кожній новій угоді, що пішла на ЛЮДИНУ (не на ОД): виконавець — акаунт дашборда цієї людини, термін —
 * сьогодні за Києвом. Лише угоди після `CONTACT_TASKS_FROM`. Людини без акаунта дашборда — задача не ставиться (лічильник `noUser`).
 */
export async function createContactTasks(db: Db, now: Date, leadUrl: (id: number) => string): Promise<{ created: number; noUser: number }> {
  const rows = (await db.query<{ id: string; company_name: string; contact_name: string | null; phone: string | null; amount: string | null;
    kommo_lead_id: string; user_id: number | null }>(`
    SELECT l.id::text, l.company_name, l.contact_name, l.phone, l.amount::text, l.kommo_lead_id::text,
           (SELECT u.id FROM managers m JOIN users u ON u.manager_id = m.id AND u.is_active
             WHERE m.kommo_user_id = l.responsible_user_id ORDER BY u.id LIMIT 1) AS user_id
      FROM prozorro_leads l
     WHERE l.kommo_lead_id IS NOT NULL AND l.task_id IS NULL AND l.pushed_at >= $1
       AND l.responsible_user_id IS DISTINCT FROM $2
     ORDER BY l.pushed_at, l.id`, [CONTACT_TASKS_FROM, OPDIR_KOMMO_USER_ID])).rows;
  const at = now.toISOString(), today = kyivDay(now);
  let created = 0, noUser = 0;
  for (const r of rows) {
    if (r.user_id == null) { noUser++; continue; }
    const text = contactTaskText({ companyName: r.company_name, contactName: r.contact_name, phone: r.phone, leadUrl: leadUrl(Number(r.kommo_lead_id)) });
    await db.query(`
      WITH x AS (
        INSERT INTO tasks (title, description, comments, status, deadline, assignee_user_id, priority, department, task_type, created_at, updated_at)
        VALUES ($1, $2, $2, 'not_started', $3::date, $4, 'high', $5, 'simple', $6, $6) RETURNING id)
      UPDATE prozorro_leads SET task_id = (SELECT id FROM x) WHERE id = $7 AND task_id IS NULL`,
      [contactTaskTitle(r.company_name, r.amount == null ? null : Number(r.amount)), text, today, r.user_id, CONTACT_TASK_DEPARTMENT, at, r.id]);
    created++;
  }
  return { created, noUser };
}

/**
 * ☎️ Автозакриття: вихідний дзвінок на номер контакту угоди, розмова > 8 с, не раніше за створення угоди (`callClosesTask`).
 * Задачу вже закрили руками — лише ставимо позначку, щоб більше не перевіряти. Номер не схожий на телефон — закриють руками.
 */
export async function closeContactTasks(db: Db, now: Date): Promise<{ open: number; closed: number; manual: number }> {
  const rows = (await db.query<{ id: string; task_id: number; status: string; phone: string | null; pushed_at: Date }>(`
    SELECT l.id::text, l.task_id, t.status, l.phone, l.pushed_at
      FROM prozorro_leads l JOIN tasks t ON t.id = l.task_id
     WHERE l.task_closed_at IS NULL`)).rows;
  const at = now.toISOString();
  let closed = 0, manual = 0;
  for (const r of rows) {
    if (r.status === "done") {
      await db.query("UPDATE prozorro_leads SET task_closed_at = $2 WHERE id = $1", [r.id, at]); manual++; continue;
    }
    const phone = normalizePhone(r.phone);
    if (!phone) continue;
    const calls = (await db.query<{ call_type: string; billsec: number; calldate: Date }>(
      `SELECT call_type, billsec, calldate FROM ringostat_calls WHERE client_phone = $1 AND calldate >= $2 ORDER BY calldate`,
      [phone, r.pushed_at])).rows;
    const pushedAt = new Date(r.pushed_at).getTime();
    if (!calls.some((c) => callClosesTask({ callType: c.call_type, billsec: Number(c.billsec), at: new Date(c.calldate).getTime() }, pushedAt,
      OUTBOUND_TYPES, LEADGEN_CALL_MIN_SEC))) continue;
    await db.query("UPDATE tasks SET status = 'done', close_reason = $2, closed_at = $3, updated_at = $3 WHERE id = $1 AND status <> 'done'",
      [r.task_id, CONTACT_DONE_REASON, at]);
    await db.query("INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, 'done', NULL)", [r.task_id, r.status]);
    await db.query("UPDATE prozorro_leads SET task_closed_at = $2 WHERE id = $1", [r.id, at]);
    closed++;
  }
  return { open: rows.length - closed - manual, closed, manual };
}
