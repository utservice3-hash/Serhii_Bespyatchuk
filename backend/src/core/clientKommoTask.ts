import type { Db } from "./adCallFacts.js";
import { clientOwnersFor } from "./clientOwner.js";
import {
  pickOpenDeal, pickOwner, leadBody, taskBody, closeTaskBody, PUSH_MAX_ATTEMPTS, PUSH_PER_RUN, type OwnerCandidate,
} from "./clientKommoTaskRules.js";

/**
 * 📌 ЗАДАЧА КЛІЄНТУ → KOMMO: читання й запис (задача 8345). Правила — у чистому `clientKommoTaskRules.ts`.
 *
 * Черга — сама таблиця `client_next_steps`: живий крок без `kommo_task_id` ще не в Kommo. Тому «перенесення старих
 * задач у день запуску» — той самий шлях, що й нова задача: перший прохід джоби забирає все, що лежить відкритим.
 * Кожен крок запису зберігається одразу (спершу угода, потім задача), щоб повтор після збою не створив другу угоду.
 * Kommo — зовнішня система: помилка не губиться, а лягає в рядок (`kommo_error`, лічильник спроб) і видна на екрані.
 */
export interface KommoLeadLite { id: number; status_id: number; created_at: number; _embedded?: { contacts?: { id: number }[]; companies?: { id: number }[] } }
export interface KommoTaskDeps {
  fetchLeads(ids: number[]): Promise<KommoLeadLite[]>;
  createLead(body: unknown): Promise<number>;
  createTask(body: unknown): Promise<number>;
  closeTasks(body: unknown): Promise<void>;
  fetchTasks(ids: number[]): Promise<{ id: number; is_completed: boolean }[]>;
}

const ymOf = (d: Date): string => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);

async function managerCandidate(db: Db, managerId: number | null): Promise<OwnerCandidate | null> {
  if (managerId == null) return null;
  const r = (await db.query<{ id: number; kommo_user_id: string | null; is_active: boolean }>(
    `SELECT id, kommo_user_id::text, is_active FROM managers WHERE id = $1`, [managerId])).rows[0];
  return r ? { managerId: r.id, kommoUserId: r.kommo_user_id ? Number(r.kommo_user_id) : null, active: r.is_active } : null;
}

export type PushResult = { ok: true; leadId: number; taskId: number; created: boolean } | { ok: false; error: string } | { ok: true; skipped: true };

/** Один крок → Kommo. Повторний виклик для вже перенесеного чи закритого кроку нічого не робить. */
export async function pushStep(db: Db, deps: KommoTaskDeps, stepId: number, now: Date): Promise<PushResult> {
  const s = (await db.query<{ id: number; client_key: string; text: string; due: string | null; created_by: number | null;
    kommo_lead_id: string | null; author_manager: number | null }>(
    `SELECT s.id, s.client_key, s.text, to_char(s.due_date, 'YYYY-MM-DD') AS due, s.created_by, s.kommo_lead_id::text,
            u.manager_id AS author_manager
       FROM client_next_steps s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = $1 AND s.done_at IS NULL AND s.kommo_task_id IS NULL`, [stepId])).rows[0];
  if (!s) return { ok: true, skipped: true };
  try {
    const card = (await clientOwnersFor([s.client_key], ymOf(now))).get(s.client_key) ?? null;
    const owner = pickOwner(await managerCandidate(db, card?.managerId ?? null), await managerCandidate(db, s.author_manager));
    if (!owner.ok) throw new Error(owner.error);
    let leadId = s.kommo_lead_id ? Number(s.kommo_lead_id) : null;
    let created = false;
    if (leadId == null) {
      const local = (await db.query<{ kommo_id: string; open: boolean }>(
        `SELECT kommo_id::text, (status_id NOT IN (142, 143)) AS open FROM deals
          WHERE client_key = $1 ORDER BY (status_id NOT IN (142, 143)) DESC, created_at_kommo DESC NULLS LAST LIMIT 12`, [s.client_key])).rows;
      if (!local.length) throw new Error("у клієнта немає жодної угоди в дашборді — нема звідки взяти контакт для Kommo");
      const live = await deps.fetchLeads(local.map((d) => Number(d.kommo_id)));
      leadId = pickOpenDeal(live.map((l) => ({ id: l.id, statusId: l.status_id, createdAt: l.created_at })));
      if (leadId == null) {
        const src = [...live].sort((a, b) => b.created_at - a.created_at)[0];
        const contactIds = src?._embedded?.contacts?.map((c) => c.id) ?? [];
        const companyId = src?._embedded?.companies?.[0]?.id ?? null;
        if (!contactIds.length && companyId == null) throw new Error("в угодах клієнта в Kommo немає ні контакту, ні компанії — нову угоду нема до кого привʼязати");
        leadId = await deps.createLead(leadBody({ clientName: card?.clientName ?? null, clientKey: s.client_key, kommoUserId: owner.kommoUserId, contactIds, companyId }));
        created = true;
      }
      // Угоду зберігаємо ДО задачі: якщо задача впаде, повтор не створить другу угоду.
      await db.query(`UPDATE client_next_steps SET kommo_lead_id = $2, kommo_lead_created = $3 WHERE id = $1`, [s.id, leadId, created]);
    }
    const taskId = await deps.createTask(taskBody({ text: s.text, due: s.due, leadId, kommoUserId: owner.kommoUserId }, now));
    await db.query(`UPDATE client_next_steps SET kommo_task_id = $2, kommo_pushed_at = $3, kommo_error = NULL WHERE id = $1`, [s.id, taskId, now.toISOString()]);
    return { ok: true, leadId, taskId, created };
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    await db.query(`UPDATE client_next_steps SET kommo_attempts = kommo_attempts + 1, kommo_error = $2 WHERE id = $1`, [s.id, error]);
    return { ok: false, error };
  }
}

export interface KommoTasksReport { pushed: number; createdLeads: number; failed: number; closedInKommo: number; doneFromKommo: number; waiting: number }

/** Прохід джоби: ① нові й старі живі кроки → Kommo; ② закриті в дашборді → закрити задачу в Kommo; ③ закриті в Kommo → закрити крок. */
export async function syncClientTasks(db: Db, deps: KommoTaskDeps, now: Date): Promise<KommoTasksReport> {
  const rep: KommoTasksReport = { pushed: 0, createdLeads: 0, failed: 0, closedInKommo: 0, doneFromKommo: 0, waiting: 0 };
  const pending = (await db.query<{ id: number }>(
    `SELECT id FROM client_next_steps WHERE done_at IS NULL AND kommo_task_id IS NULL AND kommo_attempts < $1 ORDER BY kommo_attempts, created_at, id LIMIT $2`,
    [PUSH_MAX_ATTEMPTS, PUSH_PER_RUN])).rows;
  for (const p of pending) {
    const r = await pushStep(db, deps, p.id, now);
    if (!r.ok) rep.failed++;
    else if (!("skipped" in r)) { rep.pushed++; if (r.created) rep.createdLeads++; }
  }
  // ② Крок закрили (або замінили новим) у дашборді, а задача в Kommo ще відкрита.
  const toClose = (await db.query<{ id: number; kommo_task_id: string }>(
    `SELECT id, kommo_task_id::text FROM client_next_steps
      WHERE done_at IS NOT NULL AND kommo_task_id IS NOT NULL AND kommo_task_closed_at IS NULL ORDER BY id`)).rows;
  for (const c of toClose) {
    await deps.closeTasks(closeTaskBody(Number(c.kommo_task_id)));
    await db.query(`UPDATE client_next_steps SET kommo_task_closed_at = $2 WHERE id = $1`, [c.id, now.toISOString()]);
    rep.closedInKommo++;
  }
  // ③ Менеджер закрив задачу в Kommo — крок у дашборді виконано (хто закрив у Kommo, дашборд не знає: `done_by` порожній).
  const open = (await db.query<{ id: number; kommo_task_id: string }>(
    `SELECT id, kommo_task_id::text FROM client_next_steps WHERE done_at IS NULL AND kommo_task_id IS NOT NULL ORDER BY id`)).rows;
  for (let i = 0; i < open.length; i += 100) {
    const part = open.slice(i, i + 100);
    const tasks = await deps.fetchTasks(part.map((o) => Number(o.kommo_task_id)));
    const done = new Set(tasks.filter((t) => t.is_completed).map((t) => t.id));
    for (const o of part) {
      if (!done.has(Number(o.kommo_task_id))) continue;
      await db.query(`UPDATE client_next_steps SET done_at = $2, kommo_task_closed_at = $2 WHERE id = $1 AND done_at IS NULL`, [o.id, now.toISOString()]);
      rep.doneFromKommo++;
    }
  }
  rep.waiting = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM client_next_steps WHERE done_at IS NULL AND kommo_task_id IS NULL`)).rows[0]?.n ?? 0;
  return rep;
}
