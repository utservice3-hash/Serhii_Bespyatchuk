import { pool } from "../db/pool.js";
import { fetchLeadsByIds, fetchContactsByIds, extractPhone, LEADS_BY_IDS_MAX, type KommoDeal } from "../kommo/client.js";

// Перевізники з CRM для калькулятора ставок. Правило (від власника): контакти
// з ознаками реклами/таргету (гео-мітки) — це КЛІЄНТ; усі інші контакти в
// угоді — перевізники. Додатково відсіюємо основний контакт (це клієнт за
// резолвером) і контакти без телефону. Беремо успішні угоди за 12 місяців.
// Пошук по місту потім іде по назві угоди (у назві — маршрут).

// «Гео/таргет»-ознаки в імені контакта. «гео» лише як окреме слово, щоб не
// зачепити Георгія/Геннадія.
const AD_MARK = /(^|[^а-яa-zіїєґё])(гео|geo)([^а-яa-zіїєґё]|$)|📍|тарге|target|реклам|\bads?\b|инста|інста|insta|facebook|фейсбук|\bfb\b|tiktok|тікток|тик[- ]?ток/i;

const BATCH_DEALS = 200; // угод за один прохід (батчі Kommo по 250 всередині)

export async function syncCarriers(): Promise<void> {
  // Невзяті в роботу успішні угоди повного циклу за 12 міс, свіжі перші.
  const deals = await pool.query<{ kommo_id: string; name: string | null; closed: string | null }>(
    `SELECT d.kommo_id, d.name, to_char((d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date, 'YYYY-MM-DD') AS closed
       FROM deals d
       LEFT JOIN carrier_sync_done s ON s.deal_kommo_id = d.kommo_id::bigint
      WHERE d.pipeline_id IN (8921932, 155304) AND d.status_id = 142
        AND d.closed_at_kommo >= now() - interval '12 months'
        AND s.deal_kommo_id IS NULL
      ORDER BY d.closed_at_kommo DESC
      LIMIT $1`,
    [BATCH_DEALS]
  );
  if (deals.rowCount === 0) { console.log("syncCarriers: nothing new."); return; }

  const byId = new Map(deals.rows.map((r) => [Number(r.kommo_id), r]));
  // Дрібнимо по 250 — `BATCH_DEALS` сьогодні 200, але межа не має триматись на
  // тому, що дві константи випадково узгоджені.
  const allIds = [...byId.keys()];
  const leads: KommoDeal[] = [];
  for (let i = 0; i < allIds.length; i += LEADS_BY_IDS_MAX) {
    leads.push(...await fetchLeadsByIds(allIds.slice(i, i + LEADS_BY_IDS_MAX)));
  }

  // Кандидати: НЕосновні контакти угоди (основний = клієнт).
  const candidateIds = new Set<number>();
  const dealContacts = new Map<number, number[]>(); // deal -> contact ids
  for (const l of leads) {
    const ids: number[] = [];
    for (const c of l._embedded?.contacts ?? []) {
      if (!c.is_main) { ids.push(c.id); candidateIds.add(c.id); }
    }
    dealContacts.set(l.id, ids);
  }

  const contacts = candidateIds.size ? await fetchContactsByIds([...candidateIds]) : [];
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  let added = 0;
  for (const l of leads) {
    const deal = byId.get(l.id);
    for (const cid of dealContacts.get(l.id) ?? []) {
      const c = contactById.get(cid);
      if (!c?.name) continue;
      if (AD_MARK.test(c.name)) continue; // гео/таргет-мітка → це клієнт
      const phone = extractPhone(c);
      if (!phone) continue; // перевізник без телефону не потрібен
      const r = await pool.query(
        `INSERT INTO carrier_trips (contact_id, deal_kommo_id, name, phone, deal_name, deal_date)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contact_id, deal_kommo_id) DO NOTHING`,
        [cid, l.id, c.name.slice(0, 200), phone, (deal?.name ?? "").slice(0, 300), deal?.closed ?? null]
      );
      added += r.rowCount ?? 0;
    }
  }
  // Позначаємо всі опрацьовані угоди (і без перевізників теж).
  for (const id of byId.keys()) {
    await pool.query(`INSERT INTO carrier_sync_done (deal_kommo_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  }
  console.log(`syncCarriers: processed ${deals.rowCount} deals, +${added} carrier trips.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // --loop: ганяти, доки всі угоди не опрацьовані (первинний backfill).
  const loop = process.argv.includes("--loop");
  (async () => {
    do {
      const before = await pool.query(`SELECT count(*) n FROM carrier_sync_done`);
      await syncCarriers();
      const after = await pool.query(`SELECT count(*) n FROM carrier_sync_done`);
      if (Number(after.rows[0].n) === Number(before.rows[0].n)) break;
      await new Promise((r) => setTimeout(r, 2000));
    } while (loop);
    await pool.end();
  })().catch((err) => { console.error(err); process.exit(1); });
}
