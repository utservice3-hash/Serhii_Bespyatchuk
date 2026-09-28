/**
 * 📌 ОБҐРУНТУВАННЯ ПЛАНУ (ТЗ Юлі 22.09.2026, п.3.3; задача 4312):
 * «можливість вручну закріпити один дзвінок або скрін як обґрунтування плану — щоб при питанні
 * „чому план такий“ не шукати серед 50 розмов».
 *
 * Одне обґрунтування на клієнта й місяць плану (PK `client_key, month`), і воно — АБО дзвінок
 * Ringostat, АБО скрин контакту: другого не дано (CHECK у БД + `basisTarget` тут). Закріпити
 * вдруге = замінити; зняти = прибрати рядок (правило зони доступів: дія з інтерфейсу скасовна
 * тим самим інтерфейсом).
 *
 * 🔴 ПРИНАЛЕЖНІСТЬ ПЕРЕВІРЯЄ СЕРВЕР. Дзвінок мусить бути дзвінком САМЕ цього клієнта
 * (`ringostat_calls.client_key`), скрин — контактом цього клієнта з файлом. Інакше через id
 * можна було б «обґрунтувати» план чужою розмовою, і доступ до неї пройшов би повз `canSeeClient`.
 *
 * ⚠️ `CHECK` + upsert (правило db-sql): у вставці завжди стоять ОБИДВІ колонки (одна — NULL),
 * тож EXCLUDED — це вже фінальний рядок, і крос-колонковий CHECK бачить правильні дані.
 */

export type BasisTarget = { kind: "call"; callId: string } | { kind: "contact"; contactId: number };

/** Що закріплюють. Рівно одне з двох; обидва або жодного — відмова з поясненням. */
export function basisTarget(body: { callId?: unknown; contactId?: unknown }): BasisTarget | { error: string } {
  const call = typeof body.callId === "string" && body.callId.trim() ? body.callId.trim() : null;
  const cid = Number(body.contactId);
  const contact = body.contactId != null && Number.isInteger(cid) && cid > 0 ? cid : null;
  if (call && contact) return { error: "Обґрунтування — АБО дзвінок, АБО скрин, не обидва" };
  if (call) return { kind: "call", callId: call };
  if (contact) return { kind: "contact", contactId: contact };
  return { error: "Вкажіть дзвінок або скрин" };
}

/** `YYYY-MM` → перше число місяця; сміття — `null`. */
export function basisMonth(raw: unknown): string | null {
  const s = String(raw ?? "");
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? `${s}-01` : null;
}

/** Чи належить ціль клієнту: `$1` клієнт, `$2` дзвінок або NULL, `$3` контакт або NULL. */
export const BASIS_BELONGS_SQL = `
  SELECT CASE
    WHEN $2::text IS NOT NULL THEN EXISTS (SELECT 1 FROM ringostat_calls WHERE uniqueid = $2 AND client_key = $1)
    ELSE EXISTS (SELECT 1 FROM client_contacts WHERE id = $3 AND client_key = $1 AND stored_name IS NOT NULL)
  END AS ok`;

export const BASIS_UPSERT_SQL = `
  INSERT INTO client_plan_basis (client_key, month, call_uniqueid, contact_id, set_by, set_at)
  VALUES ($1, $2::date, $3, $4, $5, now())
  ON CONFLICT (client_key, month) DO UPDATE SET
    call_uniqueid = EXCLUDED.call_uniqueid, contact_id = EXCLUDED.contact_id,
    set_by = EXCLUDED.set_by, set_at = now()`;

export const BASIS_CLEAR_SQL = `DELETE FROM client_plan_basis WHERE client_key = $1 AND month = $2::date`;

/**
 * Обґрунтування клієнтів за місяць з усім, що треба показати: коли, скільки, хто, запис
 * (для дзвінка) або назва файла (для скрину). `$1` — ключі, `$2` — перше число місяця.
 */
export const BASIS_FOR_MONTH_SQL = `
  SELECT b.client_key,
         CASE WHEN b.call_uniqueid IS NOT NULL THEN 'call' ELSE 'contact' END AS kind,
         b.call_uniqueid, b.contact_id,
         to_char(COALESCE(rc.calldate, cc.created_at) AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD HH24:MI') AS at,
         rc.billsec, rc.recording,
         COALESCE(m.name, rc.employee_fio) AS call_by,
         cc.channel, cc.file_name
    FROM client_plan_basis b
    LEFT JOIN ringostat_calls rc ON rc.uniqueid = b.call_uniqueid
    LEFT JOIN managers m ON m.id = rc.manager_id
    LEFT JOIN client_contacts cc ON cc.id = b.contact_id
   WHERE b.client_key = ANY($1) AND b.month = $2::date`;

export interface PlanBasis {
  kind: "call" | "contact";
  callId: string | null;
  contactId: number | null;
  at: string | null;
  sec: number | null;
  recording: string | null;
  by: string | null;
  channel: string | null;
  fileName: string | null;
}

export function shapeBasis(r: {
  kind: string; call_uniqueid: string | null; contact_id: number | null; at: string | null;
  billsec: number | null; recording: string | null; call_by: string | null; channel: string | null; file_name: string | null;
}): PlanBasis {
  return {
    kind: r.kind === "call" ? "call" : "contact",
    callId: r.call_uniqueid, contactId: r.contact_id == null ? null : Number(r.contact_id),
    at: r.at, sec: r.billsec == null ? null : Number(r.billsec), recording: r.recording,
    by: r.call_by, channel: r.channel, fileName: r.file_name,
  };
}

export async function basisForMonth(keys: string[], monthFirst: string): Promise<Map<string, PlanBasis>> {
  const out = new Map<string, PlanBasis>();
  if (keys.length === 0) return out;
  const { pool } = await import("../db/pool.js");
  const r = await pool.query(BASIS_FOR_MONTH_SQL, [keys, monthFirst]);
  for (const x of r.rows) out.set(x.client_key, shapeBasis(x));
  return out;
}
