import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  extractPhone,
  fetchContactsByIds,
  fetchLeadsByIds,
  kommoWrite,
} from "../kommo/client.js";

const REACTIVATION_PIPELINE = 8921948;
const AUTO_STAGE = 108224932; // "Автододані (UTSAI)"
const TAG_COMPANY = "Неактивний_3міс";
const TAG_LEAD = "Авто_реактивація";

interface Candidate {
  client_key: string;
  client_name: string;
  orders: number;
  amount: number;
  last_paid: string;
  last_mgr: string;
  sample_deal: number;
}

async function getLeadgenUserIds(): Promise<number[]> {
  const r = await pool.query<{ kommo_user_id: string }>(
    `SELECT m.kommo_user_id FROM managers m JOIN teams t ON t.id = m.team_id
     WHERE m.is_active AND m.kommo_user_id IS NOT NULL AND (t.name ILIKE '%лідоген%' OR t.name ILIKE '%лидоген%')`
  );
  return r.rows.map((x) => Number(x.kommo_user_id));
}

async function getCandidates(limit: number): Promise<Candidate[]> {
  const r = await pool.query<Candidate>(
    `WITH cs AS (
       SELECT d.client_key,
         (array_agg(d.client_name ORDER BY d.created_at_kommo DESC))[1] client_name,
         COUNT(*)::int orders, SUM(d.price)::float amount,
         MAX(d.created_at_kommo) last_paid,
         (array_agg(m.name ORDER BY d.created_at_kommo DESC))[1] last_mgr,
         (array_agg(d.kommo_id ORDER BY d.created_at_kommo DESC))[1]::bigint sample_deal
       FROM deals d JOIN managers m ON m.id = d.manager_id
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND d.created_at_kommo >= '2022-01-01'
       GROUP BY d.client_key
     )
     SELECT * FROM cs
     WHERE orders >= 3 AND last_paid < now() - interval '3 months'
       AND client_key NOT IN (
         SELECT DISTINCT client_key FROM deals
         WHERE pipeline_id IN (8921948, 8921936, 7337048) AND status_id NOT IN (142, 143) AND client_key IS NOT NULL
       )
     ORDER BY amount DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

function uah(n: number): string {
  return new Intl.NumberFormat("uk-UA").format(Math.round(n));
}

/**
 * Company ids that already have an OPEN lead in the reactivation/lead-gen
 * pipelines — read live from Kommo (not our synced DB, which lags freshly
 * created leads) so repeated runs never create duplicates.
 */
async function getCompaniesAlreadyInWork(): Promise<Set<number>> {
  const base = config.kommo.baseUrl;
  const ids = new Set<number>();
  for (const pid of [REACTIVATION_PIPELINE, 8921936, 7337048]) {
    let page = 1;
    while (true) {
      const r = await fetch(
        `${base}/api/v4/leads?limit=250&page=${page}&filter[pipeline_id]=${pid}&with=companies`,
        { headers: { Authorization: `Bearer ${config.kommo.token}` } }
      );
      if (r.status === 204) break;
      const j = (await r.json()) as { _embedded?: { leads?: KommoLeadLite[] } };
      const leads = j._embedded?.leads ?? [];
      for (const l of leads) {
        if (l.status_id === 142 || l.status_id === 143) continue; // closed
        for (const c of l._embedded?.companies ?? []) ids.add(c.id);
      }
      if (leads.length < 250) break;
      page++;
    }
  }
  return ids;
}

interface KommoLeadLite {
  status_id: number;
  _embedded?: { companies?: { id: number }[] };
}

export async function reactivateLeads(): Promise<void> {
  const write = process.argv.includes("--write");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 5;

  const leadgens = await getLeadgenUserIds();
  if (leadgens.length === 0) throw new Error("No lead-gen users found for assignment");
  const candidates = await getCandidates(limit);
  const alreadyInWork = await getCompaniesAlreadyInWork();
  console.log(`${candidates.length} candidates; ${leadgens.length} lead-gens; ${alreadyInWork.size} companies already in work; write=${write}`);

  let created = 0;
  let i = 0;
  for (const c of candidates) {
    // Resolve company/contact/phone from a representative deal.
    const [lead] = await fetchLeadsByIds([c.sample_deal]);
    const companyId = lead?._embedded?.companies?.[0]?.id ?? null;
    // Only reactivate real companies — skip clients that are just a person's name.
    if (!companyId) {
      console.log(`SKIP (no company): ${c.client_name}`);
      continue;
    }
    // Idempotency: never create a second lead for a company already in work.
    if (alreadyInWork.has(companyId)) {
      console.log(`SKIP (already in work): ${c.client_name}`);
      continue;
    }
    alreadyInWork.add(companyId);
    const contactId =
      lead?._embedded?.contacts?.find((x) => x.is_main)?.id ?? lead?._embedded?.contacts?.[0]?.id ?? null;
    let phone: string | null = null;
    if (contactId) {
      const [contact] = await fetchContactsByIds([contactId]);
      phone = contact ? extractPhone(contact) : null;
    }
    if (!phone) {
      console.log(`SKIP (no phone): ${c.client_name}`);
      continue;
    }

    const responsible = leadgens[i % leadgens.length];
    i++;
    const noteText =
      `Авто-реактивація (UTSAI).\n` +
      `Всього перевезень за весь час: ${c.orders}\n` +
      `На суму: ${uah(c.amount)} грн\n` +
      `Останнє замовлення: ${new Date(c.last_paid).toLocaleDateString("uk-UA")}\n` +
      `Раніше працював з менеджером: ${c.last_mgr}`;

    if (!write) {
      console.log(`DRY: would create lead "${c.client_name}" → user ${responsible}, company ${companyId}, contact ${contactId}, phone ${phone}`);
      created++;
      continue;
    }

    const leadBody: Record<string, unknown> = {
      name: `Реактивація: ${c.client_name}`,
      pipeline_id: REACTIVATION_PIPELINE,
      status_id: AUTO_STAGE,
      responsible_user_id: responsible,
      _embedded: {
        tags: [{ name: TAG_LEAD }],
        ...(companyId ? { companies: [{ id: companyId }] } : {}),
        ...(contactId ? { contacts: [{ id: contactId }] } : {}),
      },
    };
    const res = await kommoWrite<{ _embedded: { leads: { id: number }[] } }>(
      "/api/v4/leads",
      [leadBody]
    );
    const newLeadId = res._embedded.leads[0].id;

    await kommoWrite(`/api/v4/leads/${newLeadId}/notes`, [
      { note_type: "common", params: { text: noteText } },
    ]);

    // Tag the company without clobbering existing tags. Non-fatal: a tagging
    // failure must not undo the created lead.
    if (companyId) {
      try {
        await kommoWrite(
          "/api/v4/companies",
          [{ id: companyId, _embedded: { tags_to_add: [{ name: TAG_COMPANY }] } }],
          "PATCH"
        );
      } catch (err) {
        console.log(`  (company tag failed for ${companyId}: ${(err as Error).message})`);
      }
    }

    console.log(`CREATED lead ${newLeadId} for ${c.client_name} → user ${responsible}`);
    created++;
  }
  console.log(`Done. ${write ? "Created" : "Would create"} ${created} reactivation leads.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reactivateLeads()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
