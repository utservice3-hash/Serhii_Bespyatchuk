import { pool } from "../db/pool.js";

/**
 * ЄДИНЕ джерело грошових метрик (MASTER_PLAN КРОК 2, виправлено КРОКОМ 4 — опція Б).
 *
 * Грошові етапи повного циклу (обидва пайплайни):
 *   етап 8  «Очікуємо оплату від замовника (перевізник оплачений)» → STAGE_EXPECTED
 *   етап 9  «Оплата отримана»                                      → STAGE_PAID
 *   етап 10 «Успішна угода» (142)                                  → SUCCESS
 * ⚠️ Етап 4 «Виставлення рахунку» (100274340) у грошові метрики НЕ входить.
 *
 * 🔴 РЕОУПЕНИ ТРАПЛЯЮТЬСЯ РЕГУЛЯРНО (не «1-2 виключення»). Угода може входити в 142
 * кілька разів (виграли → повернули → знову виграли). Рахуємо РАЗ, за ФІНАЛЬНИМ
 * станом (опція Б власника, 14.07.2026):
 *   • success  = угода ЗАРАЗ у статусі 142; анкер = `closed_at` (= фінальний виграш).
 *   • paidOnly = угода ЗАРАЗ у етапі 9 (гроші прийшли, ще не закрито); анкер = ОСТАННІЙ
 *                вхід у етап 9. received = success ⊎ paidOnly (диз'юнктні за поточним
 *                статусом → без подвійного рахунку НІ всередині, НІ між місяцями).
 *   • expected = угода ЗАРАЗ у етапі 8; анкер = останній вхід у етап 8.
 * У кожної угоди — ОДИН анкер (один closed_at / один поточний етап) → вона потрапляє
 * рівно в ОДИН місяць. Це матчить `deals`(status,closed_at) і Kommo напряму (звірка).
 */
export const FC_PIPELINES = [8921932, 155304];
export const STAGE_EXPECTED = [69716312, 25044997];
export const STAGE_PAID = [69716460, 60412544];
export const STAGE_SUCCESS = [142];
export const STAGE_RECEIVED = [...STAGE_PAID, ...STAGE_SUCCESS];

export interface MoneyScope {
  from?: string | null;
  to?: string | null;
  managerId?: number | null;
  teamId?: number | null;
  activeOnly?: boolean;
}
export interface MoneyAgg { revenue: number; deals: number }
export interface TeamRow { teamId: number; teamName: string; revenue: number; deals: number }
export interface MgrRow { managerId: number; name: string; teamId: number | null; revenue: number; deals: number }
export interface BucketRow { bucket: string; revenue: number; deals: number }
export interface MgrWeekRow { managerId: number; weekStart: string; revenue: number; deals: number }

type Kind = "received" | "success" | "paidOnly" | "expected";

/**
 * Джерело угод для метрики — по одному рядку на угоду з ЄДИНИМ анкером:
 *   success  — ЗАРАЗ 142, anchor = closed_at.
 *   paidOnly — ЗАРАЗ у етапі 9, anchor = MAX(вхід у етап 9).
 *   expected — ЗАРАЗ у етапі 8, anchor = MAX(вхід у етап 8).
 *   received — success ⊎ paidOnly.
 * price береться з `deals` (уже збережено МІНУСОМ для мінус-угод → SUM уже нетто).
 */
function sourceSql(kind: Kind, p: unknown[]): string {
  p.push(FC_PIPELINES);
  const fc = `$${p.length}`;
  const successSrc =
    `SELECT d.kommo_id, d.closed_at_kommo AS anchor_at, d.manager_id, d.price
       FROM deals d
      WHERE d.status_id = 142 AND d.pipeline_id = ANY(${fc}) AND d.closed_at_kommo IS NOT NULL`;
  const currentStageSrc = (stages: number[]): string => {
    p.push(stages);
    const st = `$${p.length}`;
    return `SELECT d.kommo_id, a.anchor_at, d.manager_id, d.price
              FROM deals d
              JOIN (SELECT kommo_id, MAX(changed_at) AS anchor_at
                      FROM deal_stage_events
                     WHERE pipeline_id = ANY(${fc}) AND status_id = ANY(${st})
                     GROUP BY kommo_id) a ON a.kommo_id = d.kommo_id
             WHERE d.status_id = ANY(${st}) AND d.pipeline_id = ANY(${fc})`;
  };
  if (kind === "success") return successSrc;
  if (kind === "paidOnly") return currentStageSrc(STAGE_PAID);
  if (kind === "expected") return currentStageSrc(STAGE_EXPECTED);
  return `${successSrc} UNION ALL ${currentStageSrc(STAGE_PAID)}`; // received
}

async function query<T>(kind: Kind, s: MoneyScope, extraSelect: string, groupBy: string): Promise<T[]> {
  const p: unknown[] = [];
  const src = sourceSql(kind, p);
  const conds: string[] = [];
  if (s.from) { p.push(s.from); conds.push(`(src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date >= $${p.length}`); }
  if (s.to) { p.push(s.to); conds.push(`(src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date <= $${p.length}`); }
  if (s.managerId) { p.push(s.managerId); conds.push(`src.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const teamsJoin = /\bt\./.test(extraSelect + groupBy) ? "LEFT JOIN teams t ON t.id = m.team_id" : "";
  const sql = `
    SELECT ${extraSelect}
    FROM (${src}) src
    JOIN managers m ON m.id = src.manager_id ${activeJoin}
    ${teamsJoin}
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ${groupBy}`;
  const r = await pool.query(sql, p);
  return r.rows as T[];
}

async function agg(kind: Kind, s: MoneyScope): Promise<MoneyAgg> {
  const rows = await query<{ revenue: string; deals: string }>(kind, s, "COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals", "");
  return { revenue: Number(rows[0]?.revenue ?? 0), deals: Number(rows[0]?.deals ?? 0) };
}
async function aggByTeam(kind: Kind, s: MoneyScope): Promise<TeamRow[]> {
  const rows = await query<{ team_id: number; team_name: string; revenue: string; deals: string }>(
    kind, s, "t.id AS team_id, t.name AS team_name, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals", "GROUP BY t.id, t.name"
  );
  return rows.map((x) => ({ teamId: x.team_id, teamName: x.team_name, revenue: Number(x.revenue), deals: Number(x.deals) }));
}
async function aggByMgr(kind: Kind, s: MoneyScope): Promise<MgrRow[]> {
  const rows = await query<{ manager_id: number; name: string; team_id: number | null; revenue: string; deals: string }>(
    kind, { ...s, activeOnly: true },
    "m.id AS manager_id, m.name, m.team_id, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals",
    "GROUP BY m.id, m.name, m.team_id"
  );
  return rows.map((x) => ({ managerId: x.manager_id, name: x.name, teamId: x.team_id, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

// «Отримані кошти» = success ⊎ paidOnly.
export const receivedMoney = (s: MoneyScope) => agg("received", s);
export const receivedByTeam = (s: MoneyScope) => aggByTeam("received", s);
export const receivedByMgr = (s: MoneyScope) => aggByMgr("received", s);
// «Успішно реалізовано» (ЗАРАЗ 142, за closed_at) — знаменник avg_check_success_only.
export const successMoney = (s: MoneyScope) => agg("success", s);
export const successByTeam = (s: MoneyScope) => aggByTeam("success", s);
export const successByMgr = (s: MoneyScope) => aggByMgr("success", s);
// «Досі в оплаті» (ЗАРАЗ етап 9).
export const paidOnlyMoney = (s: MoneyScope) => agg("paidOnly", s);
export const paidOnlyByTeam = (s: MoneyScope) => aggByTeam("paidOnly", s);
export const paidOnlyByMgr = (s: MoneyScope) => aggByMgr("paidOnly", s);
// «Очікування оплат» (ЗАРАЗ етап 8).
export const expectedMoney = (s: MoneyScope) => agg("expected", s);
export const expectedByTeam = (s: MoneyScope) => aggByTeam("expected", s);
export const expectedByMgr = (s: MoneyScope) => aggByMgr("expected", s);

export async function receivedByBucket(s: MoneyScope, granularity: "day" | "week" | "month"): Promise<BucketRow[]> {
  const gran = granularity === "day" || granularity === "month" ? granularity : "week";
  const rows = await query<{ bucket: string; revenue: string; deals: string }>(
    "received", s,
    `to_char(date_trunc('${gran}', (src.anchor_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals`,
    "GROUP BY 1 ORDER BY 1"
  );
  return rows.map((x) => ({ bucket: x.bucket, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

/** received по (менеджер × тиждень) за місяць — для тижневої сітки план/факт. */
export async function receivedByManagerWeek(managerIds: number[], monthStart: string): Promise<MgrWeekRow[]> {
  const p: unknown[] = [];
  const src = sourceSql("received", p);
  p.push(monthStart); const ms = `$${p.length}`;
  p.push(managerIds); const ids = `$${p.length}`;
  const r = await pool.query<{ manager_id: number; week_start: string; revenue: string; deals: string }>(
    `SELECT src.manager_id,
            to_char(date_trunc('week', (src.anchor_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS week_start,
            COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals
       FROM (${src}) src
      WHERE src.manager_id = ANY(${ids})
        AND (src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date >= ${ms}::date
        AND (src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date < (${ms}::date + interval '1 month')
      GROUP BY src.manager_id, week_start`,
    p
  );
  return r.rows.map((x) => ({ managerId: x.manager_id, weekStart: x.week_start, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

/**
 * ЗНІМОК «станом на зараз» — угоди, що ПРЯМО ЗАРАЗ стоять на етапі 8 чи 9. Прогноз-
 * картка, НІКОЛИ не сумується у виручку періоду (підпис «станом на зараз»).
 */
export async function awaitingNowSnapshot(s: MoneyScope): Promise<{ deals: number; revenue: number; byTeam: TeamRow[] }> {
  const p: unknown[] = [FC_PIPELINES, [...STAGE_EXPECTED, ...STAGE_PAID]];
  const scope: string[] = [];
  if (s.managerId) { p.push(s.managerId); scope.push(`d.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); scope.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ team_id: number; team_name: string; revenue: string; deals: string }>(
    `SELECT t.id AS team_id, t.name AS team_name, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals
       FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
      WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2) ${scope.length ? "AND " + scope.join(" AND ") : ""}
      GROUP BY t.id, t.name ORDER BY revenue DESC`,
    p
  );
  const byTeam = r.rows.map((x) => ({ teamId: x.team_id, teamName: x.team_name, revenue: Number(x.revenue), deals: Number(x.deals) }));
  return { deals: byTeam.reduce((a, b) => a + b.deals, 0), revenue: byTeam.reduce((a, b) => a + b.revenue, 0), byTeam };
}
