import type { Db } from "./adCallFacts.js";
import { CARRIER_STAGE } from "./carrierCallRules.js";
import { CLOSE_BATCH, LOST_STATUS, type CloseMode } from "./carrierClose.js";

/**
 * 🧽 ЗАДАЧІ НА ЗАКРИТИХ УГОДАХ «ДЗВІНКІВ НА МОБІЛЬНІ» (Роман 05.10.2026: «треба щоб автоматично закривало також задачу,
 * не тільки перекидало в етап»).
 *
 * Ringostat ставить на кожну нову угоду етапу задачу «Связаться» (від робота, `created_by = 0`). Угоду потім закриває
 * хтось інший — зовнішній фільтр CRM за секунди, дашборд, людина, — а задача лишається, і менеджер мусить закривати
 * кожну руками. Заміряно 05.10.2026: після фільтра — 214 відкритих задач на 202 угодах за 60 днів; після закриттів
 * дашборда до 02.10 — ще 347 (з 02.10 дашборд гасить задачі сам перед закриттям угоди, `carrierClose.ts`).
 *
 * Тож НЕЗАЛЕЖНО від того, хто закрив: угода етапу закрита (143) у нашій `deals` → перевіряємо СВІЖИЙ статус у Kommo
 * (могли повернути в роботу після синку) → закриваємо відкриті задачі РОБОТА з текстом результату. Задачі людей не
 * чіпаємо ніколи: їх ставили свідомо. Повернута в роботу угода — не чіпаємо й не позначаємо: якщо її знову закриють,
 * вона знову стане кандидатом.
 *
 * Межі — технічні, не бізнес-правила: угоди, закриті за останні 90 днів (заміряний хвіст — 60, запас), і не раніше
 * ніж через 10 хв після закриття (задача Ringostat і закриття фільтра ходять секундами, синк угод — раз на 30 хв).
 * За прохід — не більше 80 угод (≤ 6 запитів до Kommo раз на 5 хв): хвіст розбирається за кілька годин, а не одним
 * залпом, після якого Kommo ріже ліміт усім нашим джобам.
 *
 * Режим — `CARRIER_TASK_SWEEP` (як інші записи «Відсіву»): `live` — закриваємо; `off` — нічого; решта — `dry`,
 * журнал «що закрили б». Журнальний прохід не заважає бойовому: `live` бере і ті угоди, які вже бачив `dry`.
 */
export const TASK_SWEEP = { horizonDays: 90, settleMin: 10, batch: 40, maxPerTick: 80 } as const;

export const TASK_SWEEP_TEXT = "Угоду вже закрито в CRM — передзвонювати не треба. Задачу закрив дашборд автоматично.";

export interface SweepTask { id: number; leadId: number; createdBy: number; completed: boolean }

export interface SweepKommo {
  /** Свіжий статус угод у Kommo. */
  leadStatuses(ids: readonly number[]): Promise<{ id: number; statusId: number }[]>;
  /** Відкриті задачі угод. */
  openTasks(leadIds: readonly number[]): Promise<SweepTask[]>;
  closeTasks(taskIds: readonly number[], text: string): Promise<unknown>;
}

export interface SweepReport {
  mode: CloseMode;
  /** Угоди, які брали в цей прохід. */
  candidates: number;
  /** З них у Kommo досі закриті. */
  stillClosed: number;
  /** Повернуті в роботу після синку — не чіпали. */
  reopened: number;
  /** Відкриті задачі робота на закритих угодах. */
  robotTasks: number;
  /** Скільки закрито (у `dry` — 0). */
  closedTasks: number;
  /** Задачі людей на закритих угодах — лишили. */
  peopleTasks: number;
  error: string | null;
}

/** Чисте правило: закриваємо лише відкриту задачу РОБОТА на угоді, яка в Kommo ЗАРАЗ закрита. */
export function robotTasksToClose(tasks: readonly SweepTask[], closedLeads: ReadonlySet<number>): SweepTask[] {
  return tasks.filter((t) => !t.completed && t.createdBy === 0 && closedLeads.has(t.leadId));
}

/** Кандидати: угоди етапу, закриті в межах вікна, яких ще не прибирали в цьому режимі. `$1` — now, `$2` — режим. */
export const SWEEP_CANDIDATES_SQL = `
  SELECT d.kommo_id::bigint AS id FROM deals d
   WHERE d.pipeline_id = ${String(CARRIER_STAGE.pipelineId)} AND d.status_id = ${String(LOST_STATUS)}
     AND d.closed_at_kommo >= $1::timestamptz - make_interval(days => ${String(TASK_SWEEP.horizonDays)})
     AND d.closed_at_kommo <= $1::timestamptz - make_interval(mins => ${String(TASK_SWEEP.settleMin)})
     AND NOT EXISTS (SELECT 1 FROM carrier_task_sweeps s WHERE s.kommo_id = d.kommo_id AND (s.mode = 'live' OR $2 = 'dry'))
   ORDER BY d.closed_at_kommo DESC, d.kommo_id
   LIMIT ${String(TASK_SWEEP.maxPerTick)}`;

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Один прохід. Збій Kommo в порції — порцію не позначаємо (повтор наступним проходом), решта йде далі. */
export async function runTaskSweep(db: Db, now: Date, mode: CloseMode, kommo: SweepKommo): Promise<SweepReport> {
  const rep: SweepReport = { mode, candidates: 0, stillClosed: 0, reopened: 0, robotTasks: 0, closedTasks: 0, peopleTasks: 0, error: null };
  if (mode === "off") return rep;
  const ids = (await db.query<{ id: string }>(SWEEP_CANDIDATES_SQL, [now.toISOString(), mode])).rows.map((r) => Number(r.id));
  rep.candidates = ids.length;
  for (const part of chunks(ids, TASK_SWEEP.batch)) {
    try {
      const closed = new Set((await kommo.leadStatuses(part)).filter((l) => l.statusId === LOST_STATUS).map((l) => l.id));
      rep.stillClosed += closed.size;
      rep.reopened += part.length - closed.size;
      if (!closed.size) continue;
      const tasks = await kommo.openTasks([...closed]);
      const toClose = robotTasksToClose(tasks, closed);
      rep.robotTasks += toClose.length;
      rep.peopleTasks += tasks.filter((t) => !t.completed && t.createdBy !== 0 && closed.has(t.leadId)).length;
      if (mode === "live") {
        for (const b of chunks(toClose.map((t) => t.id), CLOSE_BATCH)) await kommo.closeTasks(b, TASK_SWEEP_TEXT);
        rep.closedTasks += toClose.length;
      }
      const perLead = new Map<number, number>();
      for (const t of toClose) perLead.set(t.leadId, (perLead.get(t.leadId) ?? 0) + 1);
      const leads = [...closed];
      await db.query(
        `INSERT INTO carrier_task_sweeps (kommo_id, swept_at, mode, robot_tasks, closed_tasks)
         SELECT k, $2::timestamptz, $3, n, CASE WHEN $3 = 'live' THEN n ELSE 0 END
           FROM unnest($1::bigint[], $4::int[]) AS x(k, n)
         ON CONFLICT (kommo_id) DO UPDATE SET swept_at = EXCLUDED.swept_at, mode = EXCLUDED.mode,
           robot_tasks = EXCLUDED.robot_tasks, closed_tasks = EXCLUDED.closed_tasks`,
        [leads, now.toISOString(), mode, leads.map((k) => perLead.get(k) ?? 0)]);
    } catch (e) {
      rep.error = e instanceof Error ? e.message : String(e);
    }
  }
  return rep;
}

export interface SweepStats { mode: CloseMode; deals: number; robotTasks: number; closedTasks: number }

/** Підсумок для службового рядка: скільки угод прибрано й задач закрито (або знайшли б — у журналі). */
export async function taskSweepStats(db: Db, mode: CloseMode): Promise<SweepStats> {
  const r = await db.query<{ deals: string; robot: string; closed: string }>(
    `SELECT count(*) AS deals, COALESCE(sum(robot_tasks), 0) AS robot, COALESCE(sum(closed_tasks), 0) AS closed
       FROM carrier_task_sweeps WHERE mode = $1`, [mode === "live" ? "live" : "dry"]);
  const x = r.rows[0];
  return { mode, deals: Number(x?.deals ?? 0), robotTasks: Number(x?.robot ?? 0), closedTasks: Number(x?.closed ?? 0) };
}
