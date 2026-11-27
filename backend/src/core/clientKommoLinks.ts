/**
 * 🔗 КАРТКА КЛІЄНТА → KOMMO (Роман 27.11.2026: «хочеться щоб можна було перейти на карточку клієнта в коммо через
 * дашборд»). Клієнт дашборда — `client_key` (назва компанії або телефон фізособи), а в Kommo це компанія або контакт,
 * і компаній в одного клієнта буває кілька (дублі в CRM, обʼєднані в дашборді). Тому картка показує ВСІ компанії клієнта,
 * свіжа перша; а коли компаній немає — контакт найсвіжішої угоди, інакше саму угоду, щоб клік не був мертвим.
 *
 * ⚠️ «Компанії немає» тут НЕ твердження про CRM: `deal_companies` заповнений за горизонтом бекфілу (правило зони
 * clients, 06.08.2026), тож без компанії ми мовчки ведемо на контакт чи угоду і нічого не пишемо про «не прикріплено».
 *
 * Порядок і підписи — чиста `kommoLinksOf` (гейт `#11244`); адреси будує роут (`core/kommoLinks.ts` тягне `config`).
 */
import { AD_CLIENT_LINKS_SQL } from "./adClientLinks.js";

export type ClientKommoKind = "company" | "contact" | "deal";
export interface ClientKommoTarget { kind: ClientKommoKind; id: number; name: string | null; deals: number | null }

/** Більше компаній картка не показує: решта — число «ще N», а не мовчазне обрізання. */
export const KOMMO_LINKS_MAX = 5;

/** Компанії клієнта: скільки його угод на кожній і коли остання. `$1` — канонічний ключ. */
export const CLIENT_COMPANIES_SQL = `
  SELECT dc.company_id::text AS company_id, MAX(kc.name) AS name, COUNT(*)::int AS deals,
         MAX(d.created_at_kommo) AS last_at
    FROM deals d
    JOIN deal_companies dc ON dc.deal_kommo_id = d.kommo_id
    LEFT JOIN kommo_companies kc ON kc.company_id = dc.company_id
   WHERE d.client_key = $1
   GROUP BY dc.company_id
   ORDER BY last_at DESC NULLS LAST, deals DESC, dc.company_id`;

export interface CompanyRow { company_id: string; name: string | null; deals: number }

/**
 * Куди вести з картки. Компанії є — усі вони (до `KOMMO_LINKS_MAX`), у порядку запиту; немає — контакт; немає й
 * контакту — угода. `more` — скільки компаній не вмістилось.
 */
export function kommoLinksOf(companies: readonly CompanyRow[], fallback: { contactId: number | null; dealId: number | null }):
    { targets: ClientKommoTarget[]; more: number } {
  if (companies.length > 0) {
    const shown = companies.slice(0, KOMMO_LINKS_MAX);
    return {
      targets: shown.map((c) => ({ kind: "company" as const, id: Number(c.company_id), name: c.name?.trim() || null, deals: Number(c.deals) })),
      more: companies.length - shown.length,
    };
  }
  if (fallback.contactId != null) return { targets: [{ kind: "contact", id: fallback.contactId, name: null, deals: null }], more: 0 };
  if (fallback.dealId != null) return { targets: [{ kind: "deal", id: fallback.dealId, name: null, deals: null }], more: 0 };
  return { targets: [], more: 0 };
}

const num = (v: string | null | undefined): number | null => (v == null ? null : Number(v));

/** Посилання клієнта. Пул — лінивим імпортом, щоб чиста функція вище тестувалась без бази. */
export async function clientKommoTargets(clientKey: string): Promise<{ targets: ClientKommoTarget[]; more: number }> {
  const { pool } = await import("../db/pool.js");
  const companies = (await pool.query<CompanyRow>(CLIENT_COMPANIES_SQL, [clientKey])).rows;
  if (companies.length > 0) return kommoLinksOf(companies, { contactId: null, dealId: null });
  const f = (await pool.query<{ contact_id: string | null; deal_id: string | null }>(AD_CLIENT_LINKS_SQL, [[clientKey]])).rows[0];
  return kommoLinksOf([], { contactId: num(f?.contact_id), dealId: num(f?.deal_id) });
}
