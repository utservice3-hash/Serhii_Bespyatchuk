/**
 * 🛑 Правила лімітів над НАШОЮ базою (Роман 03.11.2026; чисті правила — `limitRules.ts`).
 *  - `crmOfLimits` — угоди клієнта кожного ліміту: ключі = ключ боржника ліміту + ключі боржників, що збігаються з лімітом
 *    (те саме `matches`, що й у дзеркалі та колонці «Борг зараз») + клієнти CRM і 1С за ЄДРПОУ / ІПН юросіб ліміту.
 *    «Зіставлено» = знайдено хоч одну угоду (будь-яку); остання угода — без програних (143).
 *  - `resetInactiveLimits` — щоденне скидання: борг з тієї самої дебіторки, що на вкладці. Порожня дебіторка = СТОП, а не
 *    «боргу ні в кого немає»: синк дебіторки перезаписує таблицю, і в цю мить кожен ліміт виглядав би скидальним.
 *  - `listResetLimits` — скинуті й досі не замінені новим лімітом (для фільтра «Скинуто»).
 */
import type { Pool } from "pg";
import { GENERIC_CLIENT_KEYS } from "../core/metrics.js";
import { resetDue } from "./limitRules.js";
import { addEvent, tx } from "./server/cpStore.js";
import type { DebtSource } from "./server/debtSource.js";
import { addLimitEvent, listLimits } from "./server/limitsStore.js";
import { matches, type ClientLimit, type Debtor, type ResetLimit } from "./shared/clientLimits.js";
import { dt, nf } from "./shared/cpFormat.js";
import type { From } from "./shared/counterparty.js";

/** $1 — [{id, keys, codes}], $2 — службові ключі CRM. */
export const LIMIT_CRM_SQL = `
WITH lim AS (SELECT x.id, x.keys, x.codes FROM jsonb_to_recordset($1::jsonb) AS x(id text, keys text[], codes text[])),
k AS (
  SELECT l.id, u.key FROM lim l CROSS JOIN LATERAL unnest(l.keys) AS u(key)
  UNION SELECT l.id, d.client_key FROM lim l CROSS JOIN LATERAL unnest(l.codes) AS c(code)
     JOIN kommo_companies kc ON kc.edrpou = c.code OR kc.ipn = c.code
     JOIN deal_companies dc ON dc.company_id = kc.company_id JOIN deals d ON d.kommo_id = dc.deal_kommo_id
  UNION SELECT l.id, ri.client_key FROM lim l CROSS JOIN LATERAL unnest(l.codes) AS c(code) JOIN receivable_invoices ri ON ri.edrpou = c.code),
kk AS (SELECT DISTINCT id, key FROM k WHERE key IS NOT NULL AND NOT (key = ANY($2::text[])))
SELECT l.id,
  EXISTS (SELECT 1 FROM deals d JOIN kk ON kk.key = d.client_key WHERE kk.id = l.id) AS matched,
  (SELECT max(d.created_at_kommo) FROM deals d JOIN kk ON kk.key = d.client_key WHERE kk.id = l.id AND d.status_id <> 143) AS last_deal
FROM lim l`;

export type LimitCrm = { matched: boolean; lastDealAt: string | null };
export async function crmOfLimits(pool: Pool, limits: ClientLimit[], debtors: Debtor[]): Promise<Map<string, LimitCrm>> {
  if (!limits.length) return new Map();
  const input = limits.map((l) => ({
    id: l.id,
    keys: [...new Set([...(l.debtorKey ? [l.debtorKey] : []), ...debtors.filter((d) => matches(l, d)).map((d) => d.key)])],
    codes: l.members.map((m) => m.code),
  }));
  const q = await pool.query<{ id: string; matched: boolean; last_deal: Date | null }>(LIMIT_CRM_SQL, [JSON.stringify(input), GENERIC_CLIENT_KEYS]);
  return new Map(q.rows.map((r) => [r.id, { matched: r.matched === true, lastDealAt: r.last_deal ? new Date(r.last_deal).toISOString() : null }]));
}

const termsText = (l: { limit: number | null; days: number | null }) =>
  [l.limit !== null ? `${nf(l.limit)} грн` : "суму не погоджено", l.days !== null ? `${l.days} дн.` : "дні не погоджено"].join(", ");

/** Щоденне скидання лімітів за неактивністю. */
export async function resetInactiveLimits(pool: Pool, debts: DebtSource, now: Date = new Date()): Promise<{ checked: number; reset: string[] }> {
  const [limits, d] = await Promise.all([listLimits(pool, now), debts.debtors()]);
  if (!d.list.length) throw new Error("дебіторка порожня — скидання лімітів не виконується (інакше кожен ліміт виглядав би «без боргу»)");
  const crm = await crmOfLimits(pool, limits, d.list);
  const reset: string[] = [];
  for (const l of limits) {
    const c = crm.get(l.id) ?? { matched: false, lastDealAt: null };
    const debt = d.list.filter((x) => matches(l, x)).reduce((a, x) => a + x.debt, 0);
    if (!resetDue({ matched: c.matched, lastDealAt: c.lastDealAt, limitAt: l.at, debt }, now)) continue;
    const since = c.lastDealAt ? `остання угода ${dt(c.lastDealAt)}` : `угод після ліміту від ${dt(l.at)} немає`;
    const note = `Скинуто автоматично: 3 місяці без угод (${since}), боргу немає. Було: ${termsText(l)}. Потрібен новий запит.`;
    const done = await tx(pool, async (db) => {
      const u = await db.query("UPDATE client_limits SET active = false, updated_at = now() WHERE id = $1 AND active", [l.id]);
      if (!u.rowCount) return false;
      await addLimitEvent(db, l.id, "ended", null, note, { reason: "inactive", lastDealAt: c.lastDealAt, limit: l.limit, days: l.days, from: l.from });
      // req: запит повертається менеджеру — подати заново можна з тими самими умовами (новий запит на той самий код інакше заборонено)
      if (l.src === "req" && l.requestId) {
        const r = await db.query("UPDATE cp_requests SET status = 'returned', flag = NULL, updated_at = now() WHERE id = $1 AND status IN ('approved', 'pending')", [l.requestId]);
        if (r.rowCount) await addEvent(db, l.requestId, "returned", null, note);
      }
      return true;
    });
    if (done) reset.push(l.id);
  }
  return { checked: limits.length, reset };
}

/** Скинуті за неактивністю, яких досі не замінив новий діючий ліміт (за ключем боржника чи ЄДРПОУ). */
export async function listResetLimits(pool: Pool): Promise<ResetLimit[]> {
  const q = await pool.query(`
    SELECT l.id::text, l.name, l.kind, l.limit_sum, l.days, l.count_from, l.manager_id, l.manager_name, e.at, e.data->>'lastDealAt' AS last_deal,
      COALESCE((SELECT json_agg(json_build_object('code', m.code, 'name', m.name) ORDER BY m.pos, m.code) FROM client_limit_members m WHERE m.limit_id = l.id), '[]'::json) AS members
    FROM client_limits l
    JOIN LATERAL (SELECT ev.type, ev.at, ev.data FROM client_limit_events ev WHERE ev.limit_id = l.id ORDER BY ev.at DESC, ev.id DESC LIMIT 1) e
      ON e.type = 'ended' AND e.data->>'reason' = 'inactive'
    WHERE NOT l.active
      AND NOT EXISTS (SELECT 1 FROM client_limits a WHERE a.active AND (a.debtor_key = l.debtor_key
        OR EXISTS (SELECT 1 FROM client_limit_members am JOIN client_limit_members lm ON lm.code = am.code WHERE am.limit_id = a.id AND lm.limit_id = l.id)))
    ORDER BY e.at DESC, l.id`);
  return q.rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind || "", members: r.members,
    limit: r.limit_sum === null ? null : Number(r.limit_sum), days: r.days ?? null, from: r.count_from as From,
    managerId: r.manager_id, managerName: r.manager_name || "", at: new Date(r.at).toISOString(), lastDealAt: r.last_deal || null,
  }));
}
