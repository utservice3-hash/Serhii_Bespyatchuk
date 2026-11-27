/**
 * ☎️ «НОМЕРИ КЛІЄНТА» В КАРТЦІ (задача 11223; Роман 27.11.2026: «давай записувати номери окремо, щоб ми бачили всі
 * номери клієнта постійного»).
 *
 * Усі номери клієнта одним списком: звідки номер (контакт угоди, картка компанії Kommo або сам ключ фізособи), скільки
 * розмов на ньому за останні `PHONE_BOOK_DAYS` днів і скільки з них привʼязано до ЦЬОГО клієнта.
 *
 * 🔴 ЧОМУ «ПРИВʼЯЗАНО» — ОКРЕМЕ ЧИСЛО. Дзвінок потрапляє до клієнта через `contact_phones` (`jobs/callLinkSql.ts`).
 * Номер, що стоїть лише в картці компанії, клієнту розмов НЕ дає — і саме це блок мусить показати, а не згладити:
 * «12 розмов» під клієнтом, якому з них не зараховано жодної, було б вигаданим числом. Привʼязку блок не змінює.
 * 🔴 Номер і в контакті, і в картці компанії — один рядок із джерелом «контакт» (те саме рішення, що в
 * `CLIENT_PHONES_SQL`): контакт сильніший, бо саме він дає привʼязку.
 * Позначку «📵 нема номера» і `phonesCount` картки цей модуль НЕ чіпає: вони описують привʼязку, а не довідник.
 */
import type { Db } from "./finance.js";

/** Вікно розмов у блоці, днів (по-київськи, з сьогоднішнім днем включно). */
export const PHONE_BOOK_DAYS = 90;
/** Більше номерів блок не показує: решта — число «ще N», а не мовчазне обрізання. */
export const PHONE_BOOK_MAX = 12;

export type PhoneBookSource = "contact" | "company" | "key";
/** `linked` — розмови йдуть клієнту; `unlinked` — номер лише в картці компанії; `carrier` — номер перевізника. */
export type PhoneBookState = "linked" | "unlinked" | "carrier";

export interface PhoneBookRow {
  phone: string; src: PhoneBookSource; contact_id: string | null; company_id: string | null; company: string | null;
  talks: number; linked: number; last_day: string | null; via_lardi: boolean | null; via_history: boolean | null; shared_n: number | null;
}
export interface PhoneBookEntry {
  phone: string; source: PhoneBookSource; contactId: number | null; companyId: number | null; company: string | null;
  /** Розмови (billsec > 0) на цьому номері за вікно — усі, чиї б вони не були. */
  talks: number;
  /** З них привʼязано до цього клієнта. */
  linked: number;
  lastDay: string | null;
  carrier: { lardi: boolean; history: boolean } | null;
  /** Скільки ЩЕ клієнтів має цей номер (0 — номер лише його). */
  sharedWith: number;
  state: PhoneBookState;
}

/**
 * `$1` — канонічний ключ клієнта. По рядку на (номер, джерело): злиття джерел робить чиста `phoneBookOf`, щоб правило
 * «контакт сильніший» жило в одному місці й перевірялось без бази.
 */
export const CLIENT_PHONE_BOOK_SQL = `
  WITH ph AS (
    SELECT cp.phone, 'contact'::text AS src, MAX(dc.contact_id) AS contact_id, NULL::bigint AS company_id, NULL::text AS company
      FROM deals d
      JOIN deal_contacts dc ON dc.deal_kommo_id = d.kommo_id
      JOIN contact_phones cp ON cp.contact_id = dc.contact_id
     WHERE d.client_key = $1
     GROUP BY cp.phone
    UNION ALL
    SELECT p.phone, 'company'::text AS src, NULL::bigint AS contact_id, MAX(kc.company_id) AS company_id, MAX(kc.name) AS company
      FROM deals d
      JOIN deal_companies dco ON dco.deal_kommo_id = d.kommo_id
      JOIN kommo_companies kc ON kc.company_id = dco.company_id
      CROSS JOIN LATERAL unnest(kc.phones) AS p(phone)
     WHERE d.client_key = $1
     GROUP BY p.phone
    UNION ALL
    SELECT k.phone, 'key'::text AS src, NULL::bigint AS contact_id, NULL::bigint AS company_id, NULL::text AS company
      FROM (SELECT $1::text AS phone) k WHERE k.phone ~ '^[0-9]{9,15}$'),
  calls AS (
    SELECT rc.client_phone AS phone,
           COUNT(*) FILTER (WHERE rc.billsec > 0)::int AS talks,
           COUNT(*) FILTER (WHERE rc.billsec > 0 AND rc.client_key = $1)::int AS linked,
           to_char(MAX(rc.calldate AT TIME ZONE 'Europe/Kyiv') FILTER (WHERE rc.billsec > 0), 'YYYY-MM-DD') AS last_day
      FROM ringostat_calls rc
     WHERE rc.client_phone IN (SELECT phone FROM ph)
       AND (rc.calldate AT TIME ZONE 'Europe/Kyiv')::date BETWEEN (now() AT TIME ZONE 'Europe/Kyiv')::date - ${String(PHONE_BOOK_DAYS - 1)}
                                                          AND (now() AT TIME ZONE 'Europe/Kyiv')::date
     GROUP BY rc.client_phone)
  SELECT ph.phone, ph.src, ph.contact_id::text AS contact_id, ph.company_id::text AS company_id, ph.company,
         COALESCE(c.talks, 0) AS talks, COALESCE(c.linked, 0) AS linked, c.last_day,
         cr.via_lardi OR cr.via_lardi_user AS via_lardi, cr.via_history AS via_history, s.n AS shared_n
    FROM ph
    LEFT JOIN calls c ON c.phone = ph.phone
    LEFT JOIN carrier_phones cr ON cr.p9 = right(ph.phone, 9)
    LEFT JOIN shared_phone_clients s ON s.client_key = $1 AND s.phone = ph.phone
   ORDER BY ph.phone, ph.src`;

/** Сила джерела: контакт і ключ фізособи дають привʼязку дзвінків, картка компанії — ні. */
const RANK: Record<PhoneBookSource, number> = { contact: 0, key: 1, company: 2 };

/**
 * Рядки блока. Номер із кількох джерел — один рядок із найсильнішим джерелом; назва й id компанії лишаються довідкою.
 * Порядок: спершу ті, що реально дають клієнту розмови, далі за числом розмов, далі за номером (стабільно).
 */
export function phoneBookOf(rows: readonly PhoneBookRow[]): { phones: PhoneBookEntry[]; more: number; total: number } {
  const by = new Map<string, PhoneBookEntry>();
  for (const r of rows) {
    const carrier = r.via_lardi == null && r.via_history == null ? null : { lardi: Boolean(r.via_lardi), history: Boolean(r.via_history) };
    const prev = by.get(r.phone);
    const source = prev && RANK[prev.source] <= RANK[r.src] ? prev.source : r.src;
    const e: PhoneBookEntry = {
      phone: r.phone, source,
      contactId: r.contact_id != null ? Number(r.contact_id) : prev?.contactId ?? null,
      companyId: r.company_id != null ? Number(r.company_id) : prev?.companyId ?? null,
      company: (r.company ?? "").trim() || prev?.company || null,
      talks: r.talks, linked: r.linked, lastDay: r.last_day, carrier,
      sharedWith: Math.max(0, (r.shared_n ?? 0) - 1),
      state: carrier ? "carrier" : source === "company" ? "unlinked" : "linked",
    };
    by.set(r.phone, e);
  }
  const order: Record<PhoneBookState, number> = { linked: 0, unlinked: 1, carrier: 2 };
  const all = [...by.values()].sort((a, b) =>
    order[a.state] - order[b.state] || b.linked - a.linked || b.talks - a.talks || a.phone.localeCompare(b.phone));
  return { phones: all.slice(0, PHONE_BOOK_MAX), more: Math.max(0, all.length - PHONE_BOOK_MAX), total: all.length };
}

export async function clientPhoneBook(db: Db, clientKey: string): Promise<{ phones: PhoneBookEntry[]; more: number; total: number }> {
  const r = await db.query<PhoneBookRow>(CLIENT_PHONE_BOOK_SQL, [clientKey]);
  return phoneBookOf(r.rows);
}
