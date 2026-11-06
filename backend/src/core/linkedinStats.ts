import type { Db } from "./adCallFacts.js";
import { closeModeOf, type CloseMode } from "./carrierClose.js";
import { DUP_REASON_PREFIX, nextInRing } from "./linkedinQueue.js";
import { loadStageCreated, type StageCreated } from "./linkedinStageDeals.js";

/**
 * 🔗 «Клієнти → LinkedIn» (задача 7361): статистика черги за період. Без пулу й без `metrics.ts` — гейти `#3406`/`#3414`
 * ганяють її на scratch-базі (той самий модуль, що кличе роут).
 *
 * 👥 ХТО ЩО БАЧИТЬ (Роман 04.11.2026): менеджер — лише свою статистику, тімлід — свою команду, керівництво — усіх.
 * Межа — тут, на сервері (`linkedinScope`): чужих рядків менеджер не отримає навіть прямим запитом.
 */

export class StatsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const kyivToday = (now: Date) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

/** Скоуп переглядача: `all` — керівництво; `team` — тімлід (своя команда); `own` — менеджер (лише він). */
export type LinkedinScope = { kind: "all" } | { kind: "team"; teamId: number } | { kind: "own"; managerId: number };
/** З токена. Менеджер / тімлід без привʼязки до менеджера чи команди — порожній скоуп (`-1`), а не «усі». */
export function linkedinScope(auth: { role: string; managerId: number | null; teamId: number | null }): LinkedinScope {
  if (auth.role === "manager") return { kind: "own", managerId: auth.managerId ?? -1 };
  if (auth.role === "team_lead") return { kind: "team", teamId: auth.teamId ?? -1 };
  return { kind: "all" };
}

export interface QueueStat { managerId: number; name: string; received: number; taken: number; ignored: number; avgTakeMin: number | null }
export interface QueueItemView {
  kommoId: number; dealName: string | null; state: string; managerName: string | null; reason: string | null;
  seenAt: string; offeredAt: string | null; deadlineAt: string | null; misses: number;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export interface LinkedinStats {
  from: string; to: string; scope: LinkedinScope["kind"];
  /** `dispatcher*` — лише для керівництва: заявки, що лишились на «Операційному директорі», нікому зі скоупу не належать. */
  kpi: { created: number; taken: number; dispatcher: number | null; dispatcherDup: number | null; dispatcherNobody: number | null; avgTakeMin: number | null };
  perManager: QueueStat[];
  items: QueueItemView[];
  /** 📅 Лише керівництву: угоди, створені на етапі «LinkedIn» від початку етапу (не лише через бота), по днях. */
  stage: StageCreated | null;
  /** Рядок черги (хто в колі, хто наступний) — лише керівництву; іншим `members`/`nextName` порожні. */
  queue: { mode: CloseMode; members: number; nextName: string | null; launchedAt: string | null;
    paused: boolean; pausedBy: string | null; pausedAt: string | null };
}

/**
 * Статистика за київські дати [from, to] включно. «Створено» — керівництву нові угоди на етапі, що потрапили в чергу;
 * менеджеру й тімліду — заявки, які бот пропонував комусь із їхнього скоупу. «Отримав / Проігнорував / Взяв» — події
 * журналу; «Взяв за» — від останньої пропозиції цьому менеджеру. «Машин поїхало» тут свідомо немає (канал LinkedIn).
 */
export async function loadLinkedinStats(db: Db, fromRaw: unknown, toRaw: unknown, modeRaw: string, now = new Date(),
  scope: LinkedinScope = { kind: "all" }): Promise<LinkedinStats> {
  const today = kyivToday(now);
  const from = isDate(fromRaw) ? fromRaw : today.slice(0, 8) + "01";
  const to = isDate(toRaw) ? toRaw : today;
  if (from > to) throw new StatsError(400, "Початок періоду пізніше за кінець");
  // Менеджери скоупу: null — усі; для команди — усі її люди, включно з неактивними (історія за період лишається).
  const ids: number[] | null = scope.kind === "all" ? null : scope.kind === "own" ? [scope.managerId]
    : (await db.query<{ id: number }>(`SELECT id FROM managers WHERE team_id = $1`, [scope.teamId])).rows.map((r) => r.id);
  const all = ids == null;
  const inPeriod = (col: string) => `(${col} AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date`;
  const inScope = (col: string) => `($3::int[] IS NULL OR ${col} = ANY($3::int[]))`;
  const tkSql = `SELECT t.manager_id, EXTRACT(EPOCH FROM (t.at - (SELECT MAX(o.at) FROM linkedin_queue_log o WHERE o.kind = 'offer'
                   AND o.kommo_id = t.kommo_id AND o.manager_id = t.manager_id AND o.at <= t.at))) / 60 AS mins
                   FROM linkedin_queue_log t WHERE t.kind = 'taken' AND ${inPeriod("t.at")} AND ${inScope("t.manager_id")}`;
  const k = (await db.query<{ created: string; taken: string; disp: string; dup: string; avg_min: string | null }>(
    `WITH tk AS (${tkSql})
     SELECT CASE WHEN $3::int[] IS NULL THEN (SELECT COUNT(*) FROM linkedin_queue_log WHERE kind = 'seen' AND ${inPeriod("at")})
                 ELSE (SELECT COUNT(DISTINCT kommo_id) FROM linkedin_queue_log WHERE kind = 'offer' AND ${inPeriod("at")} AND ${inScope("manager_id")}) END AS created,
            (SELECT COUNT(*) FROM tk) AS taken,
            (SELECT COUNT(*) FROM linkedin_queue_log WHERE kind = 'dispatcher' AND ${inPeriod("at")}) AS disp,
            (SELECT COUNT(*) FROM linkedin_queue_log WHERE kind = 'dispatcher' AND ${inPeriod("at")} AND left(note, length($4)) = $4) AS dup,
            (SELECT ROUND(AVG(mins)::numeric, 1) FROM tk) AS avg_min`, [from, to, ids, DUP_REASON_PREFIX])).rows[0];
  const perManager = (await db.query<{ manager_id: number; name: string; received: string; taken: string; ignored: string; avg_min: string | null }>(
    `WITH ev AS (SELECT * FROM linkedin_queue_log WHERE manager_id IS NOT NULL AND ${inPeriod("at")} AND ${inScope("manager_id")}),
          tk AS (${tkSql})
     SELECT m.id AS manager_id, m.name,
            COUNT(*) FILTER (WHERE ev.kind = 'offer') AS received,
            COUNT(*) FILTER (WHERE ev.kind = 'taken') AS taken,
            COUNT(*) FILTER (WHERE ev.kind = 'ignored') AS ignored,
            (SELECT ROUND(AVG(tk.mins)::numeric, 1) FROM tk WHERE tk.manager_id = m.id) AS avg_min
       FROM ev JOIN managers m ON m.id = ev.manager_id
      GROUP BY m.id, m.name ORDER BY 3 DESC, 2`, [from, to, ids])).rows.map((r) => ({ managerId: r.manager_id, name: r.name,
    received: Number(r.received), taken: Number(r.taken), ignored: Number(r.ignored), avgTakeMin: r.avg_min == null ? null : Number(r.avg_min) }));
  // Заявки: керівництву — усі за період; іншим — ті, які бот пропонував комусь зі скоупу (і хто зараз тримає — лише зі скоупу).
  const items = (await db.query<{ kommo_id: string; deal_name: string | null; state: string; mname: string | null; reason: string | null;
    seen_at: Date; offered_at: Date | null; deadline_at: Date | null; misses: number }>(
    `SELECT i.kommo_id::text, i.deal_name, i.state, CASE WHEN ${inScope("i.manager_id")} THEN m.name END AS mname,
            CASE WHEN $3::int[] IS NULL THEN i.reason END AS reason, i.seen_at, i.offered_at, i.deadline_at, i.misses
       FROM linkedin_queue_items i LEFT JOIN managers m ON m.id = i.manager_id
      WHERE ${inPeriod("i.seen_at")} AND ($3::int[] IS NULL OR i.offered_ids && $3::int[])
      ORDER BY i.seen_at DESC LIMIT 200`, [from, to, ids])).rows.map((r) => ({
    kommoId: Number(r.kommo_id), dealName: r.deal_name, state: r.state, managerName: r.mname, reason: r.reason,
    seenAt: new Date(r.seen_at).toISOString(), offeredAt: r.offered_at ? new Date(r.offered_at).toISOString() : null,
    deadlineAt: r.deadline_at ? new Date(r.deadline_at).toISOString() : null, misses: r.misses }));
  // Рядок черги: скільки в колі, хто наступний (те саме правило, що в тіку: після останнього, без відсутніх сьогодні).
  const st = (await db.query<{ launched_at: Date | null; last_manager_id: number | null; paused: boolean; pname: string | null; paused_at: Date | null }>(
    `SELECT s.launched_at, s.last_manager_id, s.paused, COALESCE(pm.name, pu.email) AS pname, s.paused_at
       FROM linkedin_queue_settings s
       LEFT JOIN users pu ON pu.id = s.paused_by LEFT JOIN managers pm ON pm.id = pu.manager_id WHERE s.id`)).rows[0];
  const ring = all ? (await db.query<{ id: number; name: string; absent: boolean }>(
    `SELECT m.id, m.name, EXISTS (SELECT 1 FROM team_calendar_absences a WHERE a.manager_id = m.id AND a.status = 'approved'
              AND a.kind IN ('day_off', 'vacation', 'sick') AND $1::date BETWEEN a.start_date AND a.end_date) AS absent
       FROM linkedin_queue_members q JOIN managers m ON m.id = q.manager_id WHERE m.is_active ORDER BY q.position, q.manager_id`,
    [today])).rows : [];
  const absent = new Set(ring.filter((r) => r.absent).map((r) => r.id));
  const nextId = nextInRing(ring.map((r) => r.id), st?.last_manager_id ?? null, (id) => !absent.has(id));
  return {
    from, to, scope: scope.kind,
    kpi: { created: Number(k.created), taken: Number(k.taken),
      dispatcher: all ? Number(k.disp) : null, dispatcherDup: all ? Number(k.dup) : null, dispatcherNobody: all ? Number(k.disp) - Number(k.dup) : null,
      avgTakeMin: k.avg_min == null ? null : Number(k.avg_min) },
    perManager, items, stage: all ? await loadStageCreated(db, from, to) : null,
    queue: { mode: closeModeOf(modeRaw), members: ring.length, nextName: ring.find((r) => r.id === nextId)?.name ?? null,
      launchedAt: st?.launched_at ? new Date(st.launched_at).toISOString() : null,
      paused: st?.paused ?? false, pausedBy: all ? st?.pname ?? null : null, pausedAt: st?.paused_at ? new Date(st.paused_at).toISOString() : null },
  };
}
