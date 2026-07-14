import { pool } from "../db/pool.js";

/**
 * ЄДИНЕ джерело грошових метрик, анкерованих по ДАТІ ВХОДУ В ЕТАП
 * (`deal_stage_events`), а НЕ по знімку поточного етапу (MASTER_PLAN КРОК 2).
 *
 * Знімок недатований → «Отримані кошти за червень» мутували щодня. Анкер по
 * даті входу — чиста функція подій, тож минулі місяці НЕ змінюються.
 *
 * Грошові етапи повного циклу (обидва пайплайни):
 *   етап 8  «Очікуємо оплату від замовника (перевізник оплачений)» → STAGE_EXPECTED
 *   етап 9  «Оплата отримана»                                      → STAGE_PAID
 *   етап 10 «Успішна угода»                                        → STAGE_SUCCESS
 * ⚠️ Етап 4 «Виставлення рахунку» (100274340) у грошові метрики НЕ входить.
 *
 * Дедуплікація: угода рахується РІВНО ОДИН РАЗ (DISTINCT kommo_id) — етапи 9 і 10
 * це ОДНІ Й ТІ САМІ гроші, без дедупу виручка подвоюється.
 */
export const FC_PIPELINES = [8921932, 155304];
export const STAGE_EXPECTED = [69716312, 25044997];
export const STAGE_PAID = [69716460, 60412544];
export const STAGE_SUCCESS = [142];
export const STAGE_RECEIVED = [...STAGE_PAID, ...STAGE_SUCCESS]; // «Отримані кошти» = 9 ∪ 10

export interface MoneyScope {
  from?: string | null;
  to?: string | null;
  managerId?: number | null;
  teamId?: number | null;
  activeOnly?: boolean; // only is_active managers (manager breakdown)
}

export interface MoneyAgg {
  revenue: number;
  deals: number;
}

/**
 * Угоди, що УВІЙШЛИ в `statusSet` (будь-який зі статусів) у періоді, дедуп по
 * угоді. `excludeSet` — виключити угоди, що в тому ж періоді увійшли ще й у ці
 * статуси (для розкладу received → успіх / досі-в-оплаті БЕЗ подвійного рахунку).
 * Дата-фільтр — на ПОДІЇ (анкер по входу); scope (менеджер/команда) — на угоді.
 */
function buildAnchorSql(
  statusSet: number[],
  s: MoneyScope,
  extraSelect: string,
  groupBy: string,
  excludeSet?: number[]
): { sql: string; params: unknown[] } {
  const p: unknown[] = [FC_PIPELINES, statusSet];
  const dateOn = (col: string) => {
    let c = "";
    if (s.from) {
      const i = p.indexOf(s.from) >= 0 ? p.indexOf(s.from) + 1 : (p.push(s.from), p.length);
      c += ` AND (${col} AT TIME ZONE 'Europe/Kyiv')::date >= $${i}`;
    }
    if (s.to) {
      const i = p.indexOf(s.to) >= 0 ? p.indexOf(s.to) + 1 : (p.push(s.to), p.length);
      c += ` AND (${col} AT TIME ZONE 'Europe/Kyiv')::date <= $${i}`;
    }
    return c;
  };
  const evDate = dateOn("e.changed_at");
  let excludeCond = "";
  if (excludeSet) {
    p.push(excludeSet);
    const exIdx = p.length;
    const ex2Date = dateOn("e2.changed_at");
    excludeCond = `AND NOT EXISTS (
      SELECT 1 FROM deal_stage_events e2
      WHERE e2.kommo_id = e.kommo_id AND e2.pipeline_id = ANY($1)
        AND e2.status_id = ANY($${exIdx})${ex2Date})`;
  }
  const scope: string[] = [];
  if (s.managerId) { p.push(s.managerId); scope.push(`d.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); scope.push(`m.team_id = $${p.length}`); }
  const joinActive = s.activeOnly ? "AND m.is_active" : "";
  const scopeWhere = scope.length ? `WHERE ${scope.join(" AND ")}` : "";
  const sql = `
    WITH a AS (
      SELECT DISTINCT e.kommo_id
      FROM deal_stage_events e
      WHERE e.pipeline_id = ANY($1) AND e.status_id = ANY($2)${evDate}
        ${excludeCond}
    )
    SELECT ${extraSelect}
    FROM a
    JOIN deals d ON d.kommo_id = a.kommo_id
    JOIN managers m ON m.id = d.manager_id ${joinActive}
    ${groupBy ? "LEFT JOIN teams t ON t.id = m.team_id" : ""}
    ${scopeWhere}
    ${groupBy}`;
  return { sql, params: p };
}

async function agg(statusSet: number[], s: MoneyScope, excludeSet?: number[]): Promise<MoneyAgg> {
  const { sql, params } = buildAnchorSql(
    statusSet,
    s,
    "COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals",
    "",
    excludeSet
  );
  const r = await pool.query<{ revenue: string; deals: string }>(sql, params);
  return { revenue: Number(r.rows[0]?.revenue ?? 0), deals: Number(r.rows[0]?.deals ?? 0) };
}

export interface TeamRow { teamId: number; teamName: string; revenue: number; deals: number }
export interface MgrRow { managerId: number; name: string; revenue: number; deals: number }

async function aggByTeam(statusSet: number[], s: MoneyScope, excludeSet?: number[]): Promise<TeamRow[]> {
  const { sql, params } = buildAnchorSql(
    statusSet,
    s,
    "t.id AS team_id, t.name AS team_name, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals",
    "GROUP BY t.id, t.name",
    excludeSet
  );
  const r = await pool.query<{ team_id: number; team_name: string; revenue: string; deals: string }>(sql, params);
  return r.rows.map((x) => ({ teamId: x.team_id, teamName: x.team_name, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

async function aggByMgr(statusSet: number[], s: MoneyScope, excludeSet?: number[]): Promise<MgrRow[]> {
  const { sql, params } = buildAnchorSql(
    statusSet,
    { ...s, activeOnly: true },
    "m.id AS manager_id, m.name, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals",
    "GROUP BY m.id, m.name",
    excludeSet
  );
  const r = await pool.query<{ manager_id: number; name: string; revenue: string; deals: string }>(sql, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, name: x.name, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

// «Отримані кошти» (факт) — угоди, що ввійшли в етап 9 АБО 10 у періоді, дедуп.
export const receivedMoney = (s: MoneyScope) => agg(STAGE_RECEIVED, s);
export const receivedByTeam = (s: MoneyScope) => aggByTeam(STAGE_RECEIVED, s);
export const receivedByMgr = (s: MoneyScope) => aggByMgr(STAGE_RECEIVED, s);

// «Успішно реалізовано» (лише етап 10) — знаменник avg_check_success_only.
export const successMoney = (s: MoneyScope) => agg(STAGE_SUCCESS, s);
export const successByTeam = (s: MoneyScope) => aggByTeam(STAGE_SUCCESS, s);
export const successByMgr = (s: MoneyScope) => aggByMgr(STAGE_SUCCESS, s);

// «Досі в оплаті» = ввійшли в етап 9 у періоді, але НЕ в 142 у тому ж періоді
// (розклад received без подвійного рахунку: received = success ⊎ paidOnly).
export const paidOnlyMoney = (s: MoneyScope) => agg(STAGE_PAID, s, STAGE_SUCCESS);
export const paidOnlyByTeam = (s: MoneyScope) => aggByTeam(STAGE_PAID, s, STAGE_SUCCESS);
export const paidOnlyByMgr = (s: MoneyScope) => aggByMgr(STAGE_PAID, s, STAGE_SUCCESS);

// «Очікування оплат» (етап 8), анкер по входу — знаменник ОЧІКУВАНОГО чека.
export const expectedMoney = (s: MoneyScope) => agg(STAGE_EXPECTED, s);
export const expectedByTeam = (s: MoneyScope) => aggByTeam(STAGE_EXPECTED, s);

/**
 * ЗНІМОК «станом на зараз» — угоди, що ПРЯМО ЗАРАЗ стоять на етапі 8 (очікуємо
 * оплату) чи 9 (оплата отримана, ще не закрито). Це прогноз-картка, НІКОЛИ не
 * сумується у виручку періоду — підпис «станом на зараз». (MASTER_PLAN КРОК 2, п.3)
 */
export async function awaitingNowSnapshot(s: MoneyScope): Promise<{ deals: number; revenue: number; byTeam: TeamRow[] }> {
  const p: unknown[] = [FC_PIPELINES, [...STAGE_EXPECTED, ...STAGE_PAID]];
  const scope: string[] = [];
  if (s.managerId) { p.push(s.managerId); scope.push(`d.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); scope.push(`m.team_id = $${p.length}`); }
  const scopeWhere = scope.length ? `AND ${scope.join(" AND ")}` : "";
  const r = await pool.query<{ team_id: number; team_name: string; revenue: string; deals: string }>(
    `SELECT t.id AS team_id, t.name AS team_name, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2) ${scopeWhere}
     GROUP BY t.id, t.name ORDER BY revenue DESC`,
    p
  );
  const byTeam = r.rows.map((x) => ({ teamId: x.team_id, teamName: x.team_name, revenue: Number(x.revenue), deals: Number(x.deals) }));
  return {
    deals: byTeam.reduce((a, b) => a + b.deals, 0),
    revenue: byTeam.reduce((a, b) => a + b.revenue, 0),
    byTeam,
  };
}
