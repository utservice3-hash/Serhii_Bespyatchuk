import { pool } from "../db/pool.js";
import {
  extractLeadSource,
  extractPhone,
  fetchAllCompanies,
  fetchAllContacts,
  fetchCompaniesByIds,
  fetchContactsByIds,
  fetchLeadsByIds,
  forEachDealPage,
  type KommoDeal,
} from "../kommo/client.js";
import { isLegalEntityName, normalizeClientName, normalizePhone } from "../utils/clientName.js";

/**
 * One-off backfill: populates client_name/client_key on deals created this
 * year. Existing deals already in the DB never get these fields filled in
 * by the regular incremental sync unless they're also re-updated in Kommo,
 * so this script re-fetches this year's leads directly to resolve and
 * persist client identity for them.
 */
function resolveClientKey(
  deal: KommoDeal,
  companyNameById: Map<number, string>,
  contactById: Map<number, { name: string; phone: string | null }>
): { name: string | null; key: string | null } {
  const companies = deal._embedded?.companies ?? [];
  const company = companies.find((c) => c.is_main) ?? companies[0];
  if (company) {
    const name = companyNameById.get(company.id);
    if (name) return { name, key: normalizeClientName(name) };
  }

  const contacts = deal._embedded?.contacts ?? [];
  const contact = contacts.find((c) => c.is_main) ?? contacts[0];
  if (contact) {
    const info = contactById.get(contact.id);
    if (info?.name) {
      if (isLegalEntityName(info.name)) {
        return { name: info.name, key: normalizeClientName(info.name) };
      }
      const phoneKey = normalizePhone(info.phone);
      return { name: info.name, key: phoneKey ?? normalizeClientName(info.name) };
    }
  }

  return { name: null, key: null };
}

/**
 * Efficient lead-source backfill: pulls our own deals (created 2022+) by id in
 * batches of 250 and updates lead_channel/source from their custom fields.
 */
async function backfillSourceById(): Promise<void> {
  const idRows = await pool.query<{ kommo_id: string }>(
    `SELECT kommo_id FROM deals WHERE created_at_kommo >= '2022-01-01' ORDER BY kommo_id`
  );
  const ids = idRows.rows.map((r) => Number(r.kommo_id));
  console.log(`Source backfill: ${ids.length} deals (2022+) to refresh by id.`);

  let updated = 0;
  let seen = 0;
  const BATCH = 250;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batchIds = ids.slice(i, i + BATCH);
    const leads = await fetchLeadsByIds(batchIds);
    for (const deal of leads) {
      const src = extractLeadSource(deal);
      const result = await pool.query(
        `UPDATE deals SET utm_source = $2, lead_generator = $3, client_source = $4, lead_channel = $5
           WHERE kommo_id = $1`,
        [deal.id, src.utmSource, src.leadGenerator, src.clientSource, src.channel]
      );
      updated += result.rowCount ?? 0;
    }
    seen += batchIds.length;
    if (seen % 2500 === 0 || i + BATCH >= ids.length) {
      console.log(`  …processed ${seen}/${ids.length}, updated ${updated}`);
    }
  }
  console.log(`Source backfill done: updated ${updated} of ${ids.length} deals.`);
}

/**
 * Full client identity backfill via id batches: fetches our 2022+ deals by id
 * (with embedded company/contact ids), then fetches just those companies and
 * contacts by id to resolve names/phones — avoids the unreliable all-records
 * pull. Reliable and bounded.
 */
async function backfillClientKeyById(): Promise<void> {
  const idRows = await pool.query<{ kommo_id: string }>(
    `SELECT kommo_id FROM deals WHERE created_at_kommo >= '2022-01-01' ORDER BY kommo_id`
  );
  const ids = idRows.rows.map((r) => Number(r.kommo_id));
  console.log(`Client-key backfill: ${ids.length} deals (2022+) by id.`);

  let updated = 0;
  let seen = 0;
  const BATCH = 250;
  for (let i = 0; i < ids.length; i += BATCH) {
    const leads = await fetchLeadsByIds(ids.slice(i, i + BATCH));

    const companyIds = new Set<number>();
    const contactIds = new Set<number>();
    for (const lead of leads) {
      for (const c of lead._embedded?.companies ?? []) companyIds.add(c.id);
      for (const c of lead._embedded?.contacts ?? []) contactIds.add(c.id);
    }
    const [companies, contacts] = await Promise.all([
      fetchCompaniesByIds([...companyIds]),
      fetchContactsByIds([...contactIds]),
    ]);
    const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
    const contactById = new Map(
      contacts.map((c) => [c.id, { name: c.name, phone: extractPhone(c) }])
    );

    for (const deal of leads) {
      const { name, key } = resolveClientKey(deal, companyNameById, contactById);
      if (!key) continue;
      const result = await pool.query(
        `UPDATE deals SET client_name = $2, client_key = $3 WHERE kommo_id = $1`,
        [deal.id, name, key]
      );
      updated += result.rowCount ?? 0;
    }
    seen += BATCH;
    if (seen % 2500 < BATCH) console.log(`  …processed ~${Math.min(seen, ids.length)}/${ids.length}, keyed ${updated}`);
  }
  console.log(`Client-key backfill done: keyed ${updated} of ${ids.length}.`);
}

export async function backfillClientKeys(): Promise<void> {
  // Default to the start of the current year, but allow a wider window so the
  // full deal history can be keyed (needed for repeat-client segmentation).
  // `--all` keys every deal ever; `--since=YYYY` starts from that year.
  const sinceArg = process.argv.find((a) => a.startsWith("--since="));
  const allTime = process.argv.includes("--all");
  const startYear = sinceArg
    ? Number(sinceArg.split("=")[1])
    : new Date().getFullYear();
  const yearStart = allTime
    ? 0
    : Math.floor(new Date(startYear, 0, 1).getTime() / 1000);

  // `--source-only` backfills just the lead-source fields. It fetches our own
  // deals by id (in batches) rather than paging all of Kommo's history, so it
  // only touches leads we actually have. We ignore leads older than 2022.
  const sourceOnly = process.argv.includes("--source-only");
  if (sourceOnly) {
    await backfillSourceById();
    return;
  }
  if (process.argv.includes("--client-by-id")) {
    await backfillClientKeyById();
    return;
  }

  let contactById = new Map<number, { name: string; phone: string | null }>();
  let companyNameById = new Map<number, string>();
  if (!sourceOnly) {
    const [contacts, companies] = await Promise.all([fetchAllContacts(), fetchAllCompanies()]);
    contactById = new Map(contacts.map((c) => [c.id, { name: c.name, phone: extractPhone(c) }]));
    companyNameById = new Map(companies.map((c) => [c.id, c.name]));
    console.log(`Loaded ${companyNameById.size} companies, ${contactById.size} contacts. Streaming deals...`);
  } else {
    console.log("Source-only mode: skipping contacts/companies. Streaming deals...");
  }

  let updated = 0;
  let seen = 0;
  await forEachDealPage(async (batch) => {
    await Promise.all(
      batch.map(async (deal) => {
        const src = extractLeadSource(deal);
        if (sourceOnly) {
          const result = await pool.query(
            `UPDATE deals SET utm_source = $2, lead_generator = $3, client_source = $4, lead_channel = $5
               WHERE kommo_id = $1`,
            [deal.id, src.utmSource, src.leadGenerator, src.clientSource, src.channel]
          );
          updated += result.rowCount ?? 0;
          return;
        }
        const { name, key } = resolveClientKey(deal, companyNameById, contactById);
        const result = await pool.query(
          `UPDATE deals SET client_name = $2, client_key = $3,
                  utm_source = $4, lead_generator = $5, client_source = $6, lead_channel = $7
             WHERE kommo_id = $1`,
          [deal.id, name, key, src.utmSource, src.leadGenerator, src.clientSource, src.channel]
        );
        updated += result.rowCount ?? 0;
      })
    );
    seen += batch.length;
    if (seen % 2500 === 0) console.log(`  …processed ${seen} deals, updated ${updated}`);
  }, yearStart);

  console.log(`Backfilled ${updated} of ${seen} deals created since ${new Date(yearStart * 1000).toISOString()}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillClientKeys()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
