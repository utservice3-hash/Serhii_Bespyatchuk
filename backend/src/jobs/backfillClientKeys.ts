import { pool } from "../db/pool.js";
import {
  extractLeadSource,
  extractPhone,
  fetchAllCompanies,
  fetchAllContacts,
  fetchAllDeals,
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
  deal: Awaited<ReturnType<typeof fetchAllDeals>>[number],
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

  const [deals, contacts, companies] = await Promise.all([
    fetchAllDeals(undefined, yearStart),
    fetchAllContacts(),
    fetchAllCompanies(),
  ]);

  const contactById = new Map(
    contacts.map((c) => [c.id, { name: c.name, phone: extractPhone(c) }])
  );
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));

  let updated = 0;
  const CONCURRENCY = 20;
  for (let i = 0; i < deals.length; i += CONCURRENCY) {
    const batch = deals.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (deal) => {
        const { name, key } = resolveClientKey(deal, companyNameById, contactById);
        const src = extractLeadSource(deal);
        const result = await pool.query(
          `UPDATE deals SET client_name = $2, client_key = $3,
                  utm_source = $4, lead_generator = $5, client_source = $6, lead_channel = $7
             WHERE kommo_id = $1`,
          [deal.id, name, key, src.utmSource, src.leadGenerator, src.clientSource, src.channel]
        );
        updated += result.rowCount ?? 0;
      })
    );
  }

  console.log(`Backfilled client_name/client_key for ${updated} of ${deals.length} deals created since ${new Date(yearStart * 1000).toISOString()}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillClientKeys()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
