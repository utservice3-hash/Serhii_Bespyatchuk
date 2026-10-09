import { pool } from "../db/pool.js";
import { avgCheckByManager } from "./money.js";

/**
 * 🎯 ЦІЛЬ СЕРЕДНЬОГО ЧЕКА — ПО КОМАНДАХ, АВТОМАТИЧНО (ТЗ 4632 п.2.5; Юля 10.10.2026, дослівно: «ціль ставимо по
 * командах, не загальну. РНК і РПК працюють з різними клієнтами. Значення руками не вбиваємо. Ціль команди = середній
 * чек команди за останні 3 повні місяці + 5%, перераховується на початку місяця. Команду рахуй за поточним складом.
 * Якщо в команди за 3 місяці менше 30 успішних угод — ціль не ставимо, показуємо лише факт»).
 *
 * Чек — `money.avgCheckByManager` (маржа «Успішно реалізовано» за датою переходу ÷ угоди, мінусові віднімаються):
 * ТОЙ САМИЙ чек, що на Звіті й у задачнику. «Поточний склад» — сьогоднішня команда кожного менеджера, тож угоди
 * людини, що перейшла, рахуються новій команді.
 *
 * 🧊 ФІКСУЄТЬСЯ НА МІСЯЦЬ: перше звернення в місяці записує ціль у `avg_check_targets`, і до кінця місяця вона не
 * рухається, навіть якщо хтось перейде між командами (саме це й означає «перераховується на початку місяця»).
 * Місяці до запуску (до жовтня 2026) не записуються — рахуються на льоту й позначені `reconstructed`.
 */

export const AVG_CHECK_MIN_DEALS = 30;
export const AVG_CHECK_UPLIFT = 1.05;
const pad = (n: number) => String(n).padStart(2, "0");

/** Три повні місяці перед місяцем `month` (YYYY-MM-01): жовтень → липень–вересень, січень → жовтень–грудень. */
export function avgCheckBase(month: string): { from: string; to: string } {
  const y = Number(month.slice(0, 4)), m0 = Number(month.slice(5, 7)) - 1;
  const start = new Date(Date.UTC(y, m0 - 3, 1));
  const end = new Date(Date.UTC(y, m0, 0));
  return { from: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-01`,
    to: `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}` };
}

/** Ціль за базою: менше 30 угод — `null` (лише факт), інакше чек бази + 5%, округлено до гривні. */
export function avgCheckTargetOf(revenue: number, deals: number): number | null {
  if (deals < AVG_CHECK_MIN_DEALS || deals <= 0) return null;
  return Math.round((revenue / deals) * AVG_CHECK_UPLIFT);
}

/** Відповідь: ціль `null` поруч із `deals` пояснює себе — «менше 30 угод за 3 місяці». */
export interface TeamAvgCheckTarget { teamId: number; deals: number; revenue: number; target: number | null; base: { from: string; to: string };
  /** Ціль не зафіксована в момент, а порахована заднім числом (місяць до запуску). */
  reconstructed: boolean }

/** Перший місяць, з якого ціль фіксується (запуск 4632). */
export const AVG_CHECK_FREEZE_FROM = "2026-10-01";

async function computeTargets(month: string, teamIds: readonly number[]): Promise<Map<number, { revenue: number; deals: number }>> {
  const base = avgCheckBase(month);
  const rows = await avgCheckByManager({ from: base.from, to: base.to });
  const teamOf = new Map((await pool.query<{ id: number; team_id: number | null }>(`SELECT id, team_id FROM managers`)).rows.map((x) => [x.id, x.team_id]));
  const out = new Map<number, { revenue: number; deals: number }>(teamIds.map((t) => [t, { revenue: 0, deals: 0 }]));
  for (const r of rows) {
    const t = teamOf.get(r.managerId);
    if (t == null || !out.has(t)) continue;
    const a = out.get(t)!; a.revenue += r.revenue; a.deals += r.successDeals;
  }
  return out;
}

/**
 * Цілі команд на місяць. Від `AVG_CHECK_FREEZE_FROM` — з таблиці; немає рядків — порахувати й записати
 * (`ON CONFLICT DO NOTHING`: два одночасні звернення не перепишуть одне одного) і прочитати те, що лежить.
 */
export async function teamAvgCheckTargets(month: string, teamIds: readonly number[]): Promise<Map<number, TeamAvgCheckTarget>> {
  const base = avgCheckBase(month);
  const shape = (teamId: number, revenue: number, deals: number, reconstructed: boolean): TeamAvgCheckTarget =>
    ({ teamId, revenue: Math.round(revenue), deals, target: avgCheckTargetOf(revenue, deals), base, reconstructed });
  if (month < AVG_CHECK_FREEZE_FROM) {
    const live = await computeTargets(month, teamIds);
    return new Map([...live].map(([t, v]) => [t, shape(t, v.revenue, v.deals, true)]));
  }
  const read = async () => (await pool.query<{ team_id: number; revenue: string; deals: number }>(
    `SELECT team_id, revenue, deals FROM avg_check_targets WHERE month = $1 AND team_id = ANY($2::int[])`, [month, [...teamIds]])).rows;
  let have = await read();
  if (have.length < teamIds.length) {
    const live = await computeTargets(month, teamIds.filter((t) => !have.some((h) => h.team_id === t)));
    const vals = [...live];
    if (vals.length) {
      await pool.query(
        `INSERT INTO avg_check_targets (month, team_id, base_from, base_to, revenue, deals, target)
         SELECT $1::date, x.t, $2::date, $3::date, x.r, x.d, x.g
           FROM unnest($4::int[], $5::numeric[], $6::int[], $7::numeric[]) AS x(t, r, d, g)
         ON CONFLICT (month, team_id) DO NOTHING`,
        [month, base.from, base.to, vals.map(([t]) => t), vals.map(([, v]) => v.revenue), vals.map(([, v]) => v.deals),
          vals.map(([, v]) => avgCheckTargetOf(v.revenue, v.deals))]);
    }
    have = await read();
  }
  return new Map(have.map((h) => [h.team_id, shape(h.team_id, Number(h.revenue), Number(h.deals), false)]));
}
