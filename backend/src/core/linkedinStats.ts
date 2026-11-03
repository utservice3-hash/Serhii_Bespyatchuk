import type { Db } from "./adCallFacts.js";
import { closeModeOf, type CloseMode } from "./carrierClose.js";
import { DUP_REASON_PREFIX, nextInRing } from "./linkedinQueue.js";

/**
 * 🔗 «Клієнти → LinkedIn» (задача 7361): статистика черги за період. Без пулу й без `metrics.ts` — гейт `#3406`
 * ганяє її на scratch-базі (той самий модуль, що кличе роут).
 */

export class StatsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const kyivToday = (now: Date) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

export interface QueueStat { managerId: number; name: string; received: number; taken: number; ignored: number; avgTakeMin: number | null }
export interface QueueItemView {
  kommoId: number; dealName: string | null; state: string; managerName: string | null; reason: string | null;
  seenAt: string; offeredAt: string | null; deadlineAt: string | null; misses: number;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export interface LinkedinStats {
  from: string; to: string;
  kpi: { created: number; taken: number; dispatcher: number; dispatcherDup: number; dispatcherNobody: number; avgTakeMin: number | null };
  perManager: QueueStat[];
  items: QueueItemView[];
  queue: { mode: CloseMode; members: number; nextName: string | null; dispatcherName: string | null; launchedAt: string | null };
}

/**
 * Статистика за київські дати [from, to] включно. «Створено» — нові угоди на етапі, що потрапили в чергу за період;
 * «Отримав / Проігнорував / Взяв» — події журналу за період; «Взяв за» — від останньої пропозиції цьому менеджеру.
 * «Машин поїхало» тут свідомо немає: без каналу LinkedIn (прохід 1) порахувати його нема з чого.
 */
export async function loadLinkedinStats(db: Db, fromRaw: unknown, toRaw: unknown, modeRaw: string, now = new Date()): Promise<LinkedinStats> {
  const today = kyivToday(now);
  const from = isDate(fromRaw) ? fromRaw : today.slice(0, 8) + "01";
  const to = isDate(toRaw) ? toRaw : today;
  if (from > to) throw new StatsError(400, "Початок періоду пізніше за кінець");
  const inPeriod = (col: string) => `(${col} AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date`;
  const k = (await db.query<{ created: string; taken: string; disp: string; dup: string; avg_min: string | null }>(
    `WITH tk AS (SELECT t.manager_id, EXTRACT(EPOCH FROM (t.at - (SELECT MAX(o.at) FROM linkedin_queue_log o WHERE o.kind = 'offer'
                   AND o.kommo_id = t.kommo_id AND o.manager_id = t.manager_id AND o.at <= t.at))) / 60 AS mins
                   FROM linkedin_queue_log t WHERE t.kind = 'taken' AND ${inPeriod("t.at")})
     SELECT (SELECT COUNT(*) FROM linkedin_queue_log WHERE kind = 'seen' AND ${inPeriod("at")}) AS created,
            (SELECT COUNT(*) FROM tk) AS taken,
            (SELECT COUNT(*) FROM linkedin_queue_log WHERE kind = 'dispatcher' AND ${inPeriod("at")}) AS disp,
            (SELECT COUNT(*) FROM linkedin_queue_log WHERE kind = 'dispatcher' AND ${inPeriod("at")} AND left(note, length($3)) = $3) AS dup,
            (SELECT ROUND(AVG(mins)::numeric, 1) FROM tk) AS avg_min`, [from, to, DUP_REASON_PREFIX])).rows[0];
  const perManager = (await db.query<{ manager_id: number; name: string; received: string; taken: string; ignored: string; avg_min: string | null }>(
    `WITH ev AS (SELECT * FROM linkedin_queue_log WHERE manager_id IS NOT NULL AND ${inPeriod("at")}),
          tk AS (SELECT t.manager_id, EXTRACT(EPOCH FROM (t.at - (SELECT MAX(o.at) FROM linkedin_queue_log o WHERE o.kind = 'offer'
                   AND o.kommo_id = t.kommo_id AND o.manager_id = t.manager_id AND o.at <= t.at))) / 60 AS mins
                   FROM ev t WHERE t.kind = 'taken')
     SELECT m.id AS manager_id, m.name,
            COUNT(*) FILTER (WHERE ev.kind = 'offer') AS received,
            COUNT(*) FILTER (WHERE ev.kind = 'taken') AS taken,
            COUNT(*) FILTER (WHERE ev.kind = 'ignored') AS ignored,
            (SELECT ROUND(AVG(tk.mins)::numeric, 1) FROM tk WHERE tk.manager_id = m.id) AS avg_min
       FROM ev JOIN managers m ON m.id = ev.manager_id
      GROUP BY m.id, m.name ORDER BY 3 DESC, 2`, [from, to])).rows.map((r) => ({ managerId: r.manager_id, name: r.name,
    received: Number(r.received), taken: Number(r.taken), ignored: Number(r.ignored), avgTakeMin: r.avg_min == null ? null : Number(r.avg_min) }));
  const items = (await db.query<{ kommo_id: string; deal_name: string | null; state: string; mname: string | null; reason: string | null;
    seen_at: Date; offered_at: Date | null; deadline_at: Date | null; misses: number }>(
    `SELECT i.kommo_id::text, i.deal_name, i.state, m.name AS mname, i.reason, i.seen_at, i.offered_at, i.deadline_at, i.misses
       FROM linkedin_queue_items i LEFT JOIN managers m ON m.id = i.manager_id
      WHERE ${inPeriod("i.seen_at")} ORDER BY i.seen_at DESC LIMIT 200`, [from, to])).rows.map((r) => ({
    kommoId: Number(r.kommo_id), dealName: r.deal_name, state: r.state, managerName: r.mname, reason: r.reason,
    seenAt: new Date(r.seen_at).toISOString(), offeredAt: r.offered_at ? new Date(r.offered_at).toISOString() : null,
    deadlineAt: r.deadline_at ? new Date(r.deadline_at).toISOString() : null, misses: r.misses }));
  // Рядок черги: скільки в колі, хто наступний (те саме правило, що в тіку: після останнього, без відсутніх сьогодні).
  const st = (await db.query<{ launched_at: Date | null; last_manager_id: number | null; dname: string | null }>(
    `SELECT s.launched_at, s.last_manager_id, COALESCE(m.name, u.email) AS dname FROM linkedin_queue_settings s
       LEFT JOIN users u ON u.id = s.dispatcher_user_id LEFT JOIN managers m ON m.id = u.manager_id WHERE s.id`)).rows[0];
  const ring = (await db.query<{ id: number; name: string; absent: boolean }>(
    `SELECT m.id, m.name, EXISTS (SELECT 1 FROM team_calendar_absences a WHERE a.manager_id = m.id AND a.status = 'approved'
              AND a.kind IN ('day_off', 'vacation', 'sick') AND $1::date BETWEEN a.start_date AND a.end_date) AS absent
       FROM linkedin_queue_members q JOIN managers m ON m.id = q.manager_id WHERE m.is_active ORDER BY q.position, q.manager_id`,
    [today])).rows;
  const absent = new Set(ring.filter((r) => r.absent).map((r) => r.id));
  const nextId = nextInRing(ring.map((r) => r.id), st?.last_manager_id ?? null, (id) => !absent.has(id));
  return {
    from, to,
    kpi: { created: Number(k.created), taken: Number(k.taken), dispatcher: Number(k.disp), dispatcherDup: Number(k.dup),
      dispatcherNobody: Number(k.disp) - Number(k.dup), avgTakeMin: k.avg_min == null ? null : Number(k.avg_min) },
    perManager, items,
    queue: { mode: closeModeOf(modeRaw), members: ring.length, nextName: ring.find((r) => r.id === nextId)?.name ?? null,
      dispatcherName: st?.dname ?? null, launchedAt: st?.launched_at ? new Date(st.launched_at).toISOString() : null },
  };
}
