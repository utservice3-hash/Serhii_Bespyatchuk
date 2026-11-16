import type { Db } from "./secrets.js";
import { eventsFor, type Proposal } from "./lardiSync.js";
import { contactKey } from "./hunt.js";

/**
 * Запис сторінки живого скану Ларді (`syncLardi`) — окремо від джоби, щоб гейт ганяв його на scratch-БД без пулу.
 * Одна транзакція на сторінку: заявка (upsert) + події. «Нова» — якої ще не було в `lardi_proposals`; заявка з архіву
 * вже має свою подію `new`, тож другу не пишемо — лише підняття (`core/lardiSync.ts` → `eventsFor`).
 * ⚠️ Транзакцію відкриває сам — `client` мусить бути окремим зʼєднанням, не пулом.
 */
export async function recordProposals(client: Db, items: Proposal[]): Promise<{ fresh: number; events: number }> {
  if (!items.length) return { fresh: 0, events: 0 };
  try {
    await client.query("BEGIN");
    const known = new Map((await client.query<{ kind: string; id: string; repeated_at: string | null; has_new: boolean }>(
      `SELECT p.kind, p.id::text, to_char(p.repeated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS repeated_at,
              EXISTS (SELECT 1 FROM lardi_proposal_events e WHERE e.kind = p.kind AND e.proposal_id = p.id AND e.type = 'new') AS has_new
         FROM lardi_proposals p WHERE (p.kind, p.id) IN (SELECT * FROM unnest($1::text[], $2::bigint[]))`,
      [items.map((p) => p.kind), items.map((p) => p.id)])).rows.map((r) => [`${r.kind}:${r.id}`, r]));
    let fresh = 0, events = 0;
    for (const p of items) {
      const k = known.get(`${p.kind}:${String(p.id)}`);
      if (!k) fresh++;
      const ckey = contactKey(p.phones, p.company, p.face);
      await client.query(
        `INSERT INTO lardi_proposals (kind, id, ref_id, contact_id, ckey, company, face, phones, from_town, from_area, from_country,
            to_town, to_area, to_country, price, currency, auto_repeat, repeats_today, created_at, repeated_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'live')
         ON CONFLICT (kind, id) DO UPDATE SET ref_id = EXCLUDED.ref_id, contact_id = EXCLUDED.contact_id, ckey = EXCLUDED.ckey,
            company = EXCLUDED.company, face = EXCLUDED.face, phones = EXCLUDED.phones, from_town = EXCLUDED.from_town,
            from_area = EXCLUDED.from_area, from_country = EXCLUDED.from_country, to_town = EXCLUDED.to_town, to_area = EXCLUDED.to_area,
            to_country = EXCLUDED.to_country, price = EXCLUDED.price, currency = EXCLUDED.currency, auto_repeat = EXCLUDED.auto_repeat,
            repeats_today = EXCLUDED.repeats_today, created_at = EXCLUDED.created_at,
            repeated_at = GREATEST(lardi_proposals.repeated_at, EXCLUDED.repeated_at), last_seen_at = now(), source = 'live'`,
        [p.kind, p.id, p.refId, p.contactId, ckey, p.company, p.face, JSON.stringify(p.phones), p.fromTown, p.fromArea, p.fromCountry,
         p.toTown, p.toArea, p.toCountry, p.price, p.currency, p.autoRepeat, p.repeatsToday, p.createdAt, p.repeatedAt]);
      // Заявка з архіву вже має свою подію `new` (на час нашого скану) — другу не пишемо, лише підняття.
      const evs = eventsFor(p, k ? k.repeated_at : undefined).filter((e) => !(e.type === "new" && k?.has_new));
      for (const e of evs) {
        const r = await client.query(
          `INSERT INTO lardi_proposal_events (kind, proposal_id, ckey, type, at, source) VALUES ($1,$2,$3,$4,$5,'live') ON CONFLICT DO NOTHING`,
          [p.kind, p.id, ckey, e.type, e.at]);
        events += r.rowCount ?? 0;
      }
    }
    await client.query("COMMIT");
    return { fresh, events };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

