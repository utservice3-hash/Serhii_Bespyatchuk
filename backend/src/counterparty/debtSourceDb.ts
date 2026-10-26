/**
 * 💳 `DebtSource` пакета над НАШОЮ дебіторкою (ТЗ §6.2): один рядок «Активної дебіторки» = один боржник.
 *  - key — `receivables.client_key` (обʼєднаний клієнт уже зведений синком через `client_key_alias`);
 *  - codes — ЄДРПОУ / ІПН юросіб з рахунків 1С цього клієнта (`receivable_invoices.edrpou`, заміряно 24.10: у 54 з 61);
 *  - managerId — `users.id` відповідального (наш `receivables.manager_id` — це `managers.id`);
 *  - debt — сума рядка; ageDays — вік найстарішого живого рахунку (як `overdue_days` синку, без списаних);
 *  - odDays / odSum — прострочка за днями ліміту «від дати рахунку» (як нинішній екран: вік > днів ліміту) —
 *    дні ліміту `receivables.limit_days`, які дзеркалить «Ліміти клієнтів» (`legacyMirror.ts`).
 * Дата синку — `job_runs.syncReceivables.last_success_at`.
 */
import type { Pool } from "pg";
import { INVOICE_ALIVE_SQL } from "../core/receivablesAge.js";
import type { DebtSource, Debtor } from "./server/debtSource.js";

export const DEBTORS_SQL = `
  SELECT r.client_key AS key, r.client_name AS name, r.amount::numeric AS debt,
         COALESCE(r.overdue_days, 0)::int AS age_days, r.limit_days,
         u.id::text AS manager_user_id, m.name AS manager_name,
         COALESCE(inv.codes, '{}') AS codes,
         COALESCE(inv.od_sum, 0)::numeric AS od_sum, COALESCE(inv.od_days, 0)::int AS od_days
    FROM receivables r
    LEFT JOIN managers m ON m.id = r.manager_id
    LEFT JOIN LATERAL (SELECT id FROM users WHERE manager_id = r.manager_id ORDER BY is_active DESC, id LIMIT 1) u ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT ri.edrpou) FILTER (WHERE ri.edrpou ~ '^[0-9]{8}([0-9]{2})?$') AS codes,
             sum(ri.amount) FILTER (WHERE ${INVOICE_ALIVE_SQL} AND (CURRENT_DATE - ri.invoice_date) > COALESCE(r.limit_days, 0)) AS od_sum,
             max((CURRENT_DATE - ri.invoice_date) - COALESCE(r.limit_days, 0)) FILTER (WHERE ${INVOICE_ALIVE_SQL}) AS od_days
        FROM receivable_invoices ri WHERE ri.client_key = r.client_key) inv ON true
   WHERE r.amount > 0`;

export function receivablesDebtSource(pool: Pool): DebtSource {
  return {
    async debtors() {
      const [rows, at] = await Promise.all([
        pool.query<{ key: string; name: string; debt: string; age_days: number; manager_user_id: string | null; manager_name: string | null;
          codes: string[]; od_sum: string; od_days: number }>(DEBTORS_SQL),
        pool.query<{ at: Date | null }>(`SELECT last_success_at AS at FROM job_runs WHERE name = 'syncReceivables'`),
      ]);
      const list: Debtor[] = rows.rows.map((r) => ({
        key: r.key, name: r.name, codes: r.codes ?? [], managerId: r.manager_user_id, managerName: r.manager_name ?? undefined,
        debt: Number(r.debt), odDays: Math.max(0, Number(r.od_days) || 0), odSum: Number(r.od_sum) || 0, ageDays: Number(r.age_days) || 0,
      }));
      return { at: (at.rows[0]?.at ?? new Date()).toISOString(), list };
    },
  };
}
