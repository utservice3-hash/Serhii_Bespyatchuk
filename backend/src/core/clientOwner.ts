import { pool } from "../db/pool.js";
import { effectiveManagerSql, monthLiteralSql } from "./effectiveManager.js";

/**
 * 👤 ЕФЕКТИВНИЙ МЕНЕДЖЕР І КОМАНДА КЛІЄНТА на місяць `ym` (те саме правило, що в реактивації):
 * основний = менеджер більшості ОПЛАЧЕНИХ угод клієнта (стадія `paid`, без грошей і без анкера
 * дати — тут привʼязка людини, не метрика), поверх — закріплення/передачі з `loyalty_overrides`.
 *
 * 📐 ЧОМУ САМЕ paid, А НЕ «всі угоди» (замір 23.09.2026 на 336 клієнтах, що випали): за всіма
 * угодами 114 клієнтів лягали на «Финансовый отдел», бо рахунки заводить бухгалтерія; за
 * оплаченими — нуль, 335 із 336 у продажних командах, 1 без команди.
 */
export interface ClientOwner { clientKey: string; clientName: string | null; managerId: number | null; managerName: string | null; teamId: number | null; teamName: string | null }

export async function clientOwnersFor(keys: string[], ym: string): Promise<Map<string, ClientOwner>> {
  if (!keys.length) return new Map();
  const month = monthLiteralSql(ym);
  const r = await pool.query<{ client_key: string; client_name: string | null; manager_id: number | null; manager_name: string | null; team_id: number | null; team_name: string | null }>(
    `WITH per AS (
       SELECT d.client_key, d.manager_id, COUNT(*) AS n, MAX(d.kommo_id) AS mx
         FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key = ANY($1) GROUP BY 1, 2),
     pm AS (SELECT DISTINCT ON (client_key) client_key, manager_id FROM per ORDER BY client_key, n DESC, mx DESC),
     nm AS (SELECT DISTINCT ON (client_key) client_key, client_name FROM deals WHERE client_key = ANY($1) ORDER BY client_key, kommo_id DESC)
     SELECT pm.client_key, nm.client_name, ${effectiveManagerSql("lo", "pm", month)} AS manager_id,
            mm.name AS manager_name, mm.team_id, tm.name AS team_name
       FROM pm LEFT JOIN nm ON nm.client_key = pm.client_key
       LEFT JOIN loyalty_overrides lo ON lo.client_key = pm.client_key
       LEFT JOIN managers mm ON mm.id = ${effectiveManagerSql("lo", "pm", month)}
       LEFT JOIN teams tm ON tm.id = mm.team_id`, [keys]);
  return new Map(r.rows.map((x) => [x.client_key, { clientKey: x.client_key, clientName: x.client_name, managerId: x.manager_id, managerName: x.manager_name, teamId: x.team_id, teamName: x.team_name }]));
}
