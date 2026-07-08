import { pool } from "../db/pool.js";
import {
  extractPhone,
  extractLeadSource,
  extractPaymentType,
  fetchAllDeals,
  fetchContactsByIds,
  fetchCompaniesByIds,
  fetchUsers,
} from "../kommo/client.js";
import { isLegalEntityName, normalizeClientName, normalizePhone } from "../utils/clientName.js";
import { provisionUsers } from "../db/userProvisioning.js";

function toTimestamp(unixSeconds: number | null): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

/** Fetches records by id in chunks of 250 (Kommo's per-request id limit). */
async function fetchByIdsBatched<T>(
  fetcher: (ids: number[]) => Promise<T[]>,
  ids: number[]
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 250) {
    out.push(...(await fetcher(ids.slice(i, i + 250))));
  }
  return out;
}

export async function syncManagers(): Promise<number> {
  const users = await fetchUsers();

  const teamIdByGroupId = new Map<number, number>();
  for (const user of users) {
    const group = user._embedded?.groups?.[0];
    if (!group || teamIdByGroupId.has(group.id)) continue;
    // Match by the STABLE Kommo group id first, so a team renamed locally in
    // the dashboard (e.g. "Тендери" → "Самостійний") keeps its custom name and
    // the sync never tries to re-insert the old name (which would collide on
    // the unique kommo_group_id and crash the whole job).
    let teamId: number;
    const existing = await pool.query<{ id: number }>(
      `SELECT id FROM teams WHERE kommo_group_id = $1`,
      [group.id]
    );
    if (existing.rows.length) {
      teamId = existing.rows[0].id;
    } else {
      const result = await pool.query<{ id: number }>(
        `INSERT INTO teams (name, kommo_group_id)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET kommo_group_id = EXCLUDED.kommo_group_id
         RETURNING id`,
        [group.name, group.id]
      );
      teamId = result.rows[0].id;
    }
    teamIdByGroupId.set(group.id, teamId);
  }

  // Display-name overrides keyed by Kommo user id — survive syncs (the CRM name
  // would otherwise overwrite any manual DB rename every 5 min).
  const NAME_OVERRIDES: Record<string, string> = {
    "904923": "Операційний директор", // was "Admin"
  };

  // Team-lead overrides keyed by Kommo user id — forces is_team_lead=true when
  // the CRM role is missing/misnamed. Яцик Дмитро (#3379102) leads team «Яцик»
  // but has NO role assigned in Kommo, so the "тимл" role heuristic misses him;
  // remove this once his CRM role is set to «Тимлид».
  const TEAM_LEAD_OVERRIDES = new Set<string>(["3379102"]);

  for (const user of users) {
    const group = user._embedded?.groups?.[0];
    const teamId = group ? teamIdByGroupId.get(group.id) ?? null : null;
    const role = user._embedded?.roles?.[0]?.name ?? "";
    const isTeamLead = role.toLowerCase().includes("тимл") || TEAM_LEAD_OVERRIDES.has(String(user.id));
    const displayName = NAME_OVERRIDES[String(user.id)] ?? user.name;

    await pool.query(
      `INSERT INTO managers (name, kommo_user_id, team_id, is_team_lead, is_active, email)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (kommo_user_id) DO UPDATE SET
         name = EXCLUDED.name,
         team_id = EXCLUDED.team_id,
         is_team_lead = EXCLUDED.is_team_lead,
         is_active = true,
         email = COALESCE(EXCLUDED.email, managers.email)`,
      [displayName, user.id, teamId, isTeamLead, user.email ?? null]
    );
  }

  const activeKommoIds = users.map((user) => user.id);
  await pool.query(
    `UPDATE managers SET is_active = false
     WHERE kommo_user_id IS NOT NULL AND NOT (kommo_user_id = ANY($1))`,
    [activeKommoIds]
  );

  // Keep dashboard logins in sync with the CRM roster automatically.
  await provisionUsers();

  return users.length;
}

const FULL_SYNC_LOOKBACK_DAYS = 180;

async function getSyncWindowStart(): Promise<number> {
  const result = await pool.query<{ last_synced_at: Date | null }>(
    `SELECT last_synced_at FROM sync_state WHERE id = 1`
  );
  const lastSyncedAt = result.rows[0]?.last_synced_at;
  if (lastSyncedAt) {
    return Math.floor(lastSyncedAt.getTime() / 1000);
  }
  // First-ever sync: only pull recent history to avoid an unbounded
  // full-account import (some Kommo accounts have years of leads).
  return Math.floor(Date.now() / 1000) - FULL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60;
}

// Qualification ("Кваліфікація") pipelines — the marketing/inbound funnel.
const QUALIFICATION_PIPELINES = [8921928, 7336928];
// «Нова заявка від лідогенератора» stages in the Qualification pipelines.
const QUAL_LEADGEN_STAGES = [69716164, 63019380];

/**
 * Channel re-attribution for full-cycle deals (правило власника):
 *   • «лідоген» — клієнт кваліфікувався З ЕТАПУ «Нова заявка від лідогенератора»:
 *     його лід Кваліфікації зараз на цьому етапі, АБО входив у нього
 *     (deal_stage_events), АБО був переданий менеджеру (lead_transfer_events —
 *     передача відбувається саме з цього етапу).
 *   • «реклама» — усе інше, що перейшло з Кваліфікації в повний цикл (клієнт
 *     має лід Кваліфікації, крім «Сміття» 143).
 * Runs every sync — the incremental upsert resets window deals back to their
 * raw channel, so re-attribution is re-applied over the whole table each pass.
 */
export async function reclassifyAdChannel(): Promise<number> {
  const FC = [8921932, 155304];
  // 1) Лідоген: проходження етапу «Нова заявка від лідогенератора».
  const lg = await pool.query(
    `UPDATE deals d SET lead_channel = 'leadgen'
       WHERE d.pipeline_id = ANY($1)
         AND d.lead_channel IS DISTINCT FROM 'leadgen'
         AND d.client_key IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM deals q
            WHERE q.client_key = d.client_key
              AND q.pipeline_id = ANY($2)
              AND (
                q.status_id = ANY($3)
                OR EXISTS (SELECT 1 FROM deal_stage_events dse
                            WHERE dse.kommo_id = q.kommo_id AND dse.status_id = ANY($3))
                OR EXISTS (SELECT 1 FROM lead_transfer_events lte
                            WHERE lte.kommo_id = q.kommo_id)
              )
         )`,
    [FC, QUALIFICATION_PIPELINES, QUAL_LEADGEN_STAGES]
  );
  // 2) Реклама: решта клієнтів з Кваліфікації (крім «Сміття» 143).
  const ad = await pool.query(
    `UPDATE deals d SET lead_channel = 'ad'
       WHERE d.pipeline_id = ANY($1)
         AND d.lead_channel = 'other'
         AND d.client_key IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM deals q
            WHERE q.client_key = d.client_key
              AND q.pipeline_id = ANY($2)
              AND q.status_id <> 143
         )`,
    [FC, QUALIFICATION_PIPELINES]
  );
  return (lg.rowCount ?? 0) + (ad.rowCount ?? 0);
}

// In-process guard: a single tick of the 5-min cron must never start while the
// previous run is still going. Overlapping runs were a likely cause of the sync
// "freezing" — heavy runs stacked up, exhausted resources and stopped advancing
// the watermark. Reconciliation runs are gated by the same flag.
let syncRunning = false;

/**
 * Pulls fresh CRM data into Postgres.
 * @param opts.reconcileDays  When set, ignores the incremental watermark and
 *   re-pulls everything updated in the last N days. Used by the nightly
 *   reconciliation job to heal gaps left by missed incremental updates (a deal
 *   whose status changed during a past outage is never re-fetched by the
 *   watermark-based sync, because its updated_at is now older than the mark).
 */
export async function syncKommo(opts: { reconcileDays?: number } = {}): Promise<void> {
  if (syncRunning) {
    console.warn("syncKommo: previous run still in progress — skipping this tick.");
    return;
  }
  syncRunning = true;
  const syncStartedAt = new Date();
  const startMs = Date.now();

  // Mark the run as started so monitoring can detect an in-flight or hung sync.
  await pool.query(
    `INSERT INTO sync_state (id, last_run_started_at) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_run_started_at = EXCLUDED.last_run_started_at`,
    [syncStartedAt]
  );

  try {
    const windowStart = opts.reconcileDays
      ? Math.floor(Date.now() / 1000) - opts.reconcileDays * 24 * 60 * 60
      : await getSyncWindowStart();

    const [deals, managerCount] = await Promise.all([
      fetchAllDeals(windowStart),
      syncManagers(),
    ]);

    // Fetch ONLY the contacts/companies referenced by the deals in this window,
    // by id. Fetching every contact/company (fetchAllContacts/fetchAllCompanies)
    // loads the whole CRM into memory and OOM-kills the job — see CLAUDE.md.
    const contactIds = new Set<number>();
    const companyIds = new Set<number>();
    for (const deal of deals) {
      for (const c of deal._embedded?.contacts ?? []) contactIds.add(c.id);
      for (const c of deal._embedded?.companies ?? []) companyIds.add(c.id);
    }
    const [contacts, companies] = await Promise.all([
      fetchByIdsBatched(fetchContactsByIds, [...contactIds]),
      fetchByIdsBatched(fetchCompaniesByIds, [...companyIds]),
    ]);

    const managerRows = await pool.query<{ id: number; kommo_user_id: string }>(
      `SELECT id, kommo_user_id FROM managers WHERE kommo_user_id IS NOT NULL`
    );
    const managerIdByKommoUserId = new Map(
      managerRows.rows.map((row) => [Number(row.kommo_user_id), row.id])
    );

    const contactById = new Map(
      contacts.map((c) => [c.id, { name: c.name, phone: extractPhone(c) }])
    );
    const companyNameById = new Map(companies.map((c) => [c.id, c.name]));

    const CONCURRENCY = 20;
    for (let i = 0; i < deals.length; i += CONCURRENCY) {
      const batch = deals.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((deal) => upsertDeal(deal, managerIdByKommoUserId, companyNameById, contactById))
      );
    }

    // Re-attribute ad-sourced full-cycle deals (client came via a Qualification
    // ad lead but the deal was created "manually"). Runs over the whole table so
    // it stays correct despite the incremental upsert resetting window deals.
    const reclassified = await reclassifyAdChannel();

    // Success: advance the watermark and record health for monitoring.
    await pool.query(
      `UPDATE sync_state SET
         last_synced_at = $1,
         last_success_at = now(),
         last_deal_count = $2,
         last_duration_ms = $3,
         last_error = NULL,
         consecutive_failures = 0
       WHERE id = 1`,
      [syncStartedAt, deals.length, Date.now() - startMs]
    );

    console.log(`Synced ${managerCount} users and ${deals.length} deals. Reclassified ${reclassified} full-cycle deals to ad-channel.`);
  } catch (err) {
    // Record the failure WITHOUT advancing the watermark, so the next run
    // retries the same window instead of skipping the missed updates.
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await pool
      .query(
        `UPDATE sync_state SET
           last_error = $1,
           last_duration_ms = $2,
           consecutive_failures = consecutive_failures + 1
         WHERE id = 1`,
        [message.slice(0, 2000), Date.now() - startMs]
      )
      .catch(() => {});
    throw err;
  } finally {
    syncRunning = false;
  }
}

/**
 * Resolves the actual client (not the carrier — Kommo leads in the
 * "Перевозки" pipeline often have extra non-main contacts for the
 * carrier/driver, which we ignore by only ever using the main
 * company/contact) and a stable identity key for it. Companies are
 * keyed by normalized name (e.g. "ТОВ Смартекс" == "Смартекс"). A bare
 * contact (no company) whose name is a person (ПІБ, not a legal entity)
 * is keyed by phone number instead, since personal names are not a
 * reliable identity match across deals.
 */
function resolveClient(
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

async function upsertDeal(
  deal: Awaited<ReturnType<typeof fetchAllDeals>>[number],
  managerIdByKommoUserId: Map<number, number>,
  companyNameById: Map<number, string>,
  contactById: Map<number, { name: string; phone: string | null }>
): Promise<void> {
  const managerId = managerIdByKommoUserId.get(deal.responsible_user_id) ?? null;
  const { name: clientName, key: clientKey } = resolveClient(deal, companyNameById, contactById);
  const source = extractLeadSource(deal);

  // "Мінусові" угоди: Kommo's calculator can't store a negative budget, so it
  // shows it as positive. These deals are marked by the word "мінус" in the
  // name — persist their budget as NEGATIVE so every money sum nets correctly.
  const isMinusDeal = /мінус/i.test(deal.name ?? "");
  const signedPrice = isMinusDeal ? -Math.abs(Number(deal.price) || 0) : deal.price;

  await pool.query(
    `INSERT INTO deals (
         kommo_id, name, manager_id, kommo_user_id, pipeline_id, status_id,
         price, created_at_kommo, updated_at_kommo, closed_at_kommo, synced_at,
         client_name, client_key, utm_source, lead_generator, client_source, lead_channel, payment_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (kommo_id) DO UPDATE SET
         name = EXCLUDED.name,
         manager_id = EXCLUDED.manager_id,
         pipeline_id = EXCLUDED.pipeline_id,
         status_id = EXCLUDED.status_id,
         price = EXCLUDED.price,
         updated_at_kommo = EXCLUDED.updated_at_kommo,
         closed_at_kommo = EXCLUDED.closed_at_kommo,
         synced_at = now(),
         client_name = EXCLUDED.client_name,
         client_key = EXCLUDED.client_key,
         utm_source = EXCLUDED.utm_source,
         lead_generator = EXCLUDED.lead_generator,
         client_source = EXCLUDED.client_source,
         lead_channel = EXCLUDED.lead_channel,
         payment_type = EXCLUDED.payment_type`,
      [
        deal.id,
        deal.name,
        managerId,
        deal.responsible_user_id,
        deal.pipeline_id,
        deal.status_id,
        signedPrice,
        toTimestamp(deal.created_at),
        toTimestamp(deal.updated_at),
        toTimestamp(deal.closed_at),
        clientName,
        clientKey,
        source.utmSource,
        source.leadGenerator,
        source.clientSource,
        source.channel,
        extractPaymentType(deal),
      ]
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncKommo()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
