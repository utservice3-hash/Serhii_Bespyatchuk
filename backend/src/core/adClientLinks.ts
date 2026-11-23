/**
 * 🔗 КУДИ ВЕДЕ НАЗВА КЛІЄНТА В ТАБЛИЦІ «КЛІЄНТИ З РЕКЛАМИ · ЗА LTV» (Роман 19.11.2026: «коли нажимаєш на назву клієнта —
 * відкривалось його Kommo»; TOP Weekly 16.11, Сергій просив деталізацію по клієнтах).
 *
 * Клієнт у дашборді — `client_key` (нормалізована назва компанії або телефон фізособи), а в Kommo це компанія або контакт.
 * Тому ведемо на те, що є в CRM, у такому порядку:
 *   1. КОМПАНІЯ найсвіжішої угоди клієнта (`deal_companies`). Компаній буває кілька (дублі в Kommo: «Алварк» має 5) —
 *      свіжа угода показує ту, з якою працюють зараз;
 *   2. інакше — КОНТАКТ найсвіжішої угоди (головний першим): фізособи компанії не мають;
 *   3. інакше — найсвіжіша УГОДА клієнта, щоб клік не був мертвим.
 * Заміряно на проді 19.11.2026 по 1 674 клієнтах з реклами: компанія — 1 385 (з них 160 мають 2+), лише контакт — 289,
 * ні того, ні того — 0. Порядок тримає `#3318`, живу повноту — `#3318c`.
 */
export type AdClientKommoTarget = { kind: "company" | "contact" | "deal"; id: number };

export function adClientKommoTarget(r: { companyId: number | null; contactId: number | null; dealId: number | null }):
    AdClientKommoTarget | null {
  if (r.companyId != null) return { kind: "company", id: r.companyId };
  if (r.contactId != null) return { kind: "contact", id: r.contactId };
  if (r.dealId != null) return { kind: "deal", id: r.dealId };
  return null;
}

/** Один запит на всі ключі: компанія / контакт / угода з найсвіжішої угоди клієнта (індекс `idx_deals_client_key`). */
export const AD_CLIENT_LINKS_SQL = `
  SELECT k.key AS client_key,
         (SELECT dc.company_id::text FROM deals x JOIN deal_companies dc ON dc.deal_kommo_id = x.kommo_id
           WHERE x.client_key = k.key ORDER BY x.created_at_kommo DESC, x.kommo_id DESC, dc.company_id LIMIT 1) AS company_id,
         (SELECT ct.contact_id::text FROM deals x JOIN deal_contacts ct ON ct.deal_kommo_id = x.kommo_id
           WHERE x.client_key = k.key ORDER BY x.created_at_kommo DESC, x.kommo_id DESC, ct.is_main DESC, ct.contact_id LIMIT 1) AS contact_id,
         (SELECT x.kommo_id::text FROM deals x
           WHERE x.client_key = k.key ORDER BY x.created_at_kommo DESC, x.kommo_id DESC LIMIT 1) AS deal_id
    FROM unnest($1::text[]) AS k(key)`;

const num = (v: string | null): number | null => (v == null ? null : Number(v));

/** `client_key` → куди вести. Пул — лінивим імпортом, щоб чиста функція вище тестувалась без бази. */
export async function adClientLinks(keys: readonly string[]): Promise<Map<string, AdClientKommoTarget | null>> {
  const out = new Map<string, AdClientKommoTarget | null>();
  if (!keys.length) return out;
  const { pool } = await import("../db/pool.js");
  const r = await pool.query<{ client_key: string; company_id: string | null; contact_id: string | null; deal_id: string | null }>(
    AD_CLIENT_LINKS_SQL, [keys]);
  for (const x of r.rows)
    out.set(x.client_key, adClientKommoTarget({ companyId: num(x.company_id), contactId: num(x.contact_id), dealId: num(x.deal_id) }));
  return out;
}
