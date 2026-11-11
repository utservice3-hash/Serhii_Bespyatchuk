/**
 * 🏢 ВИД КЛІЄНТА ДЛЯ ВСЬОГО СПИСКУ — «юр/ФОП» чи «фіз» (задача 8339; правило — `clientKind` з «Нічийних», 05.10.2026).
 * Юр/ФОП — платив безготівкою, або в компанії Kommo є ЄДРПОУ/ІПН, або форма власності в назві; решта — фізособа.
 * Факти — ОДНИМ пакетним запитом по ключах (стеля роуту 20 с; дешевий фрагмент у великому запиті вже двічі ламав план).
 */
import { clientKind, type ClientKind } from "./orphanClients.js";

export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Назву бере САМ — останню назву з угод клієнта, як пул «Нічийних» (`metrics.orphanClients`). Інакше два роути з різною
 * подачею назви («нормалізована» в реактивації) дали б одному ключу різний вид.
 */
export async function kindsFor(db: Db, keys: string[]): Promise<Map<string, ClientKind>> {
  const out = new Map<string, ClientKind>();
  if (!keys.length) return out;
  const r = await db.query<{ ck: string; has_code: boolean; any_cashless: boolean; nm: string | null }>(
    `WITH k AS (SELECT DISTINCT d.client_key AS ck, d.kommo_id FROM deals d WHERE d.client_key = ANY($1)),
          co AS (SELECT k.ck, bool_or(kc.edrpou ~ '^[0-9]{8}$' OR kc.edrpou ~ '^[0-9]{10}$' OR kc.ipn ~ '^[0-9]{10}$') AS has_code
                   FROM k JOIN deal_companies dc ON dc.deal_kommo_id = k.kommo_id
                   JOIN kommo_companies kc ON kc.company_id = dc.company_id GROUP BY k.ck),
          cl AS (SELECT d.client_key AS ck, bool_or(lower(COALESCE(d.payment_type, '')) LIKE '%безнал%') AS any_cashless,
                        (array_agg(d.client_name ORDER BY d.closed_at_kommo DESC NULLS LAST)
                           FILTER (WHERE d.client_name IS NOT NULL))[1] AS nm
                   FROM deals d WHERE d.client_key = ANY($1) GROUP BY d.client_key)
     SELECT cl.ck, COALESCE(co.has_code, false) AS has_code, cl.any_cashless, cl.nm
       FROM cl LEFT JOIN co ON co.ck = cl.ck`, [keys]);
  const facts = new Map(r.rows.map((x) => [x.ck, x]));
  for (const k of keys) {
    const f = facts.get(k);
    out.set(k, clientKind({ name: f?.nm ?? k, anyCashless: f?.any_cashless === true, hasCode: f?.has_code === true }).kind);
  }
  return out;
}
