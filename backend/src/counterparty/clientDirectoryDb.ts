/**
 * 🔎 `ClientDirectory` пакета над НАШОЮ базою (задача 7137): «＋ Додати клієнта» у «Лімітах клієнтів» шукає серед усіх, з
 * ким була хоч одна угода в CRM, і серед боржників дебіторки (рішення Романа 28.10 — не лише з успішною угодою: кількість
 * угод і дата останньої стоять поруч, тож лід без перевезень видно одразу).
 *  - key — `deals.client_key` / `receivables.client_key` (той самий канонічний ключ, аліаси вже застосовані синком);
 *  - назва — з дебіторки, інакше компанія CRM останньої угоди, інакше назва клієнта в угоді;
 *  - коди — ЄДРПОУ / ІПН компаній CRM цього ключа + ЄДРПОУ з рахунків 1С (у CRM код є лише в 10% компаній, 28.10);
 *  - відповідальний — з дебіторки, інакше менеджер останньої угоди (`managers.id` → `users.id`, як у debtSourceDb.ts).
 * Назва шукається ПО КЛЮЧУ, нормалізованому тим самим `normalizeClientName`, що й синк: «ТОВ «ЮМО»» і «юмо» — одне й те саме.
 * Замір на проді 28.10: 33–85 мс на запит.
 */
import type { Pool } from "pg";
import { GENERIC_CLIENT_KEYS } from "../core/metrics.js";
import { normalizeClientName } from "../utils/clientName.js";
import type { ClientDirectory, ClientHit } from "./server/clientDirectory.js";

const VALID_CODE = `'^[0-9]{8}([0-9]{2})?$'`;

/** $1 — частина ключа (або NULL), $2 — код (або NULL), $3 — службові ключі, $4 — точний ключ (або NULL). */
export const CLIENT_DIRECTORY_SQL = `
WITH keys AS (
  SELECT d.client_key AS key FROM deals d
   WHERE $1::text IS NOT NULL AND d.client_key LIKE '%' || $1 || '%' AND NOT (d.client_key = ANY($3::text[]))
  UNION SELECT r.client_key FROM receivables r WHERE $1::text IS NOT NULL AND r.client_key LIKE '%' || $1 || '%'
  UNION SELECT d.client_key FROM kommo_companies kc
          JOIN deal_companies dc ON dc.company_id = kc.company_id JOIN deals d ON d.kommo_id = dc.deal_kommo_id
         WHERE $2::text IS NOT NULL AND (kc.edrpou = $2 OR kc.ipn = $2) AND d.client_key IS NOT NULL AND NOT (d.client_key = ANY($3::text[]))
  UNION SELECT ri.client_key FROM receivable_invoices ri WHERE $2::text IS NOT NULL AND ri.edrpou = $2
  UNION SELECT d.client_key FROM deals d WHERE $4::text IS NOT NULL AND d.client_key = $4
  UNION SELECT r.client_key FROM receivables r WHERE $4::text IS NOT NULL AND r.client_key = $4
), agg AS (
  SELECT k.key, s.n, s.last_at, s.mgr, s.deal_name, s.last_deal
    FROM keys k
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, max(d.created_at_kommo) AS last_at,
             (array_agg(d.manager_id ORDER BY d.created_at_kommo DESC) FILTER (WHERE d.manager_id IS NOT NULL))[1] AS mgr,
             (array_agg(d.client_name ORDER BY d.created_at_kommo DESC) FILTER (WHERE d.client_name IS NOT NULL))[1] AS deal_name,
             (array_agg(d.kommo_id ORDER BY d.created_at_kommo DESC))[1] AS last_deal
        FROM deals d WHERE d.client_key = k.key) s ON true
   ORDER BY (k.key = COALESCE($4, $1)) DESC, s.last_at DESC NULLS LAST, k.key
   LIMIT 20)
SELECT a.key, COALESCE(r.client_name, co.name, a.deal_name, a.key) AS name, COALESCE(a.n, 0) AS deals, a.last_at,
       u.id::text AS manager_user_id, COALESCE(m.name, '') AS manager_name,
       COALESCE(r.amount > 0, false) AS debtor,
       COALESCE((SELECT array_agg(DISTINCT x.c ORDER BY x.c) FROM (
          SELECT kc.edrpou AS c FROM deals d JOIN deal_companies dc ON dc.deal_kommo_id = d.kommo_id
            JOIN kommo_companies kc ON kc.company_id = dc.company_id WHERE d.client_key = a.key AND kc.edrpou ~ ${VALID_CODE}
          UNION SELECT kc.ipn FROM deals d JOIN deal_companies dc ON dc.deal_kommo_id = d.kommo_id
            JOIN kommo_companies kc ON kc.company_id = dc.company_id WHERE d.client_key = a.key AND kc.ipn ~ '^[0-9]{10}$'
          UNION SELECT ri.edrpou FROM receivable_invoices ri WHERE ri.client_key = a.key AND ri.edrpou ~ ${VALID_CODE}) x), '{}') AS codes
  FROM agg a
  LEFT JOIN receivables r ON r.client_key = a.key
  LEFT JOIN LATERAL (SELECT kc.name FROM deal_companies dc JOIN kommo_companies kc ON kc.company_id = dc.company_id
                      WHERE dc.deal_kommo_id = a.last_deal AND btrim(COALESCE(kc.name, '')) <> '' ORDER BY kc.company_id LIMIT 1) co ON true
  LEFT JOIN managers m ON m.id = COALESCE(r.manager_id, a.mgr)
  LEFT JOIN LATERAL (SELECT id FROM users WHERE manager_id = COALESCE(r.manager_id, a.mgr) ORDER BY is_active DESC, id LIMIT 1) u ON true
 ORDER BY (a.key = COALESCE($4, $1)) DESC, a.last_at DESC NULLS LAST, a.key`;

type Row = { key: string; name: string; deals: number; last_at: Date | null; manager_user_id: string | null; manager_name: string; debtor: boolean; codes: string[] };
const toHit = (r: Row): ClientHit => ({
  key: r.key, name: r.name, codes: r.codes ?? [], managerId: r.manager_user_id, managerName: r.manager_name,
  deals: Number(r.deals) || 0, lastDealAt: r.last_at ? new Date(r.last_at).toISOString() : null, debtor: r.debtor === true,
});

export function clientDirectoryDb(pool: Pool): ClientDirectory {
  const run = async (text: string | null, code: string | null, key: string | null) =>
    (await pool.query<Row>(CLIENT_DIRECTORY_SQL, [text, code, GENERIC_CLIENT_KEYS, key])).rows.map(toHit);
  return {
    async search(q) {
      if ("code" in q) return run(null, q.code, null);
      const norm = normalizeClientName(q.text);
      return norm ? run(norm, null, null) : [];
    },
    async get(key) {
      if (!key || GENERIC_CLIENT_KEYS.includes(key)) return null;
      return (await run(null, null, key)).find((h) => h.key === key) ?? null;
    },
  };
}
