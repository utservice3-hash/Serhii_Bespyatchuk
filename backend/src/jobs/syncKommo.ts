import { pool } from "../db/pool.js";
import {
  extractPhone,
  extractLeadSource,
  extractPaymentType,
  extractUnloadDate,
  extractLoadDate,
  extractPlannedPaymentDate,
  extractWebTags,
  fetchAllDeals,
  fetchContactsByIds,
  fetchCompaniesByIds,
  fetchUsers,
} from "../kommo/client.js";
import { isLegalEntityName, normalizeClientName, normalizePhone } from "../utils/clientName.js";
import { provisionUsers } from "../db/userProvisioning.js";
import { isHeavyJobActive } from "./jobLock.js";

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

  // Попередня прив'язка (до апдейту) — щоб зафіксувати ЗМІНУ команди в
  // manager_team_history (варіант A: історію переходів пишемо самі, бо Kommo її не
  // веде). Мапа kommo_user_id → {internal id, team_id ДО цього синку}.
  const prevRows = await pool.query<{ id: number; kommo_user_id: string; team_id: number | null }>(
    `SELECT id, kommo_user_id, team_id FROM managers WHERE kommo_user_id IS NOT NULL`
  );
  const prevByUser = new Map(
    prevRows.rows.map((r) => [String(r.kommo_user_id), { id: r.id, teamId: r.team_id }])
  );

  for (const user of users) {
    const group = user._embedded?.groups?.[0];
    const teamId = group ? teamIdByGroupId.get(group.id) ?? null : null;
    const role = user._embedded?.roles?.[0]?.name ?? "";
    const isTeamLead = role.toLowerCase().includes("тимл") || TEAM_LEAD_OVERRIDES.has(String(user.id));
    const displayName = NAME_OVERRIDES[String(user.id)] ?? user.name;

    const up = await pool.query<{ id: number }>(
      `INSERT INTO managers (name, kommo_user_id, team_id, is_team_lead, is_active, email)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (kommo_user_id) DO UPDATE SET
         name = EXCLUDED.name,
         team_id = EXCLUDED.team_id,
         is_team_lead = EXCLUDED.is_team_lead,
         is_active = true,
         email = COALESCE(EXCLUDED.email, managers.email)
       RETURNING id`,
      [displayName, user.id, teamId, isTeamLead, user.email ?? null]
    );
    const managerId = up.rows[0].id;

    // Снапшот у manager_team_history: новий менеджер (немає prev) АБО team_id змінився.
    // null!==null → false (без зайвого рядка); зміна null↔команда → рядок переходу.
    const prev = prevByUser.get(String(user.id));
    if (!prev || prev.teamId !== teamId) {
      await pool.query(
        `INSERT INTO manager_team_history (manager_id, team_id) VALUES ($1, $2)`,
        [managerId, teamId]
      );
    }
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
 * Channel re-attribution for full-cycle deals — «останній дотик» ПО КОЖНІЙ
 * угоді (правило власника, уточнене 08.07.2026): лідоген може реактивувати
 * клієнта, що колись прийшов з реклами, і передати в прорахунок — тоді угоди,
 * створені ПІСЛЯ передачі, рахуються лідогену, а старі рекламні лишаються
 * рекламою. Дотики клієнта (по client_key), що передують створенню угоди
 * (+3 дні слеку на порядок запису в CRM):
 *   • лідоген-дотик — передача заявки (lead_transfer_events), вхід ліда
 *     Кваліфікації в етап «Нова заявка від лідогенератора» (deal_stage_events)
 *     або лід, що зараз стоїть на цьому етапі;
 *   • рекламний дотик — створення ліда Кваліфікації БЕЗ лідоген-маркерів
 *     (крім «Сміття» 143).
 * Канал угоди = найсвіжіший дотик перед нею; поле «Лидогенератор» на самій
 * угоді завжди перемагає; фолбек — utm/«Источник клиента». Ганяється щосинку
 * по всій таблиці (ідемпотентно, вміє і знижувати канал назад).
 */
export async function reclassifyAdChannel(): Promise<number> {
  const res = await pool.query(
    `WITH fc AS (
       SELECT d.kommo_id, d.client_key, d.created_at_kommo, d.lead_channel,
              d.lead_generator, d.utm_source, d.client_source
         FROM deals d
        WHERE d.pipeline_id = ANY($1) AND d.client_key IS NOT NULL
     ),
     lg AS (
       SELECT q.client_key, x.t
         FROM deals q
         JOIN LATERAL (
           SELECT lte.changed_at AS t FROM lead_transfer_events lte WHERE lte.kommo_id = q.kommo_id
           UNION ALL
           SELECT dse.changed_at FROM deal_stage_events dse
            WHERE dse.kommo_id = q.kommo_id AND dse.status_id = ANY($3)
           UNION ALL
           SELECT q.created_at_kommo WHERE q.status_id = ANY($3)
         ) x ON true
        WHERE q.pipeline_id = ANY($2)
     ),
     adq AS (
       SELECT q.client_key, q.created_at_kommo AS t
         FROM deals q
        WHERE q.pipeline_id = ANY($2)
          AND q.status_id <> 143
          AND NOT (q.status_id = ANY($3))
          AND NOT EXISTS (SELECT 1 FROM lead_transfer_events lte WHERE lte.kommo_id = q.kommo_id)
          AND NOT EXISTS (SELECT 1 FROM deal_stage_events dse
                           WHERE dse.kommo_id = q.kommo_id AND dse.status_id = ANY($3))
     ),
     calc AS (
       SELECT f.kommo_id, f.lead_channel, f.lead_generator, f.utm_source, f.client_source,
              (SELECT MAX(lg.t) FROM lg
                WHERE lg.client_key = f.client_key
                  AND lg.t <= f.created_at_kommo + interval '3 days') AS lg_t,
              (SELECT MAX(a.t) FROM adq a
                WHERE a.client_key = f.client_key
                  AND a.t <= f.created_at_kommo + interval '3 days') AS ad_t
         FROM fc f
     )
     UPDATE deals d SET lead_channel = c.target
       FROM (
         SELECT kommo_id, lead_channel,
                CASE
                  WHEN lead_generator IS NOT NULL THEN 'leadgen'
                  WHEN lg_t IS NOT NULL AND (ad_t IS NULL OR lg_t >= ad_t) THEN 'leadgen'
                  WHEN ad_t IS NOT NULL THEN 'ad'
                  WHEN utm_source IS NOT NULL OR client_source IN ('Google','Реактивация ретаргетом') THEN 'ad'
                  ELSE 'other'
                END AS target
           FROM calc
       ) c
      WHERE d.kommo_id = c.kommo_id AND d.lead_channel IS DISTINCT FROM c.target`,
    [[8921932, 155304], QUALIFICATION_PIPELINES, QUAL_LEADGEN_STAGES]
  );
  return res.rowCount ?? 0;
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
  // Поки біжить важка Kommo-джоба (звірка / бекфіл / auto-heal, у т.ч. окремим
  // nohup-процесом) — пропускаємо прохід, щоб їхні потоки не наклались і разом не
  // перевищили ліміт Kommo. Замок у БД з heartbeat → мертва джоба знімає його сама.
  if (await isHeavyJobActive()) {
    console.warn("syncKommo: важка Kommo-джоба активна (job_locks) — пропускаю прохід.");
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

export async function upsertDeal(
  deal: Awaited<ReturnType<typeof fetchAllDeals>>[number],
  managerIdByKommoUserId: Map<number, number>,
  companyNameById: Map<number, string>,
  contactById: Map<number, { name: string; phone: string | null }>
): Promise<void> {
  const managerId = managerIdByKommoUserId.get(deal.responsible_user_id) ?? null;
  const { name: clientName, key: clientKey } = resolveClient(deal, companyNameById, contactById);
  const source = extractLeadSource(deal);
  const webTags = extractWebTags(deal);

  // "Мінусові" угоди: Kommo's calculator can't store a negative budget, so it
  // shows it as positive. These deals are marked by the word "мінус" in the
  // name — persist their budget as NEGATIVE so every money sum nets correctly.
  const isMinusDeal = /мінус/i.test(deal.name ?? "");
  const signedPrice = isMinusDeal ? -Math.abs(Number(deal.price) || 0) : deal.price;

  await pool.query(
    `INSERT INTO deals (
         kommo_id, name, manager_id, kommo_user_id, pipeline_id, status_id,
         price, created_at_kommo, updated_at_kommo, closed_at_kommo, synced_at,
         client_name, client_key, utm_source, lead_generator, client_source, lead_channel, payment_type,
         unload_at, load_at, utm_campaign, adv_camp, traf_src, traf_type, utm_medium, planned_payment_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
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
         payment_type = EXCLUDED.payment_type,
         unload_at = EXCLUDED.unload_at,
         load_at = EXCLUDED.load_at,
         utm_campaign = EXCLUDED.utm_campaign,
         adv_camp = EXCLUDED.adv_camp,
         traf_src = EXCLUDED.traf_src,
         traf_type = EXCLUDED.traf_type,
         utm_medium = EXCLUDED.utm_medium,
         planned_payment_at = EXCLUDED.planned_payment_at`,
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
        extractUnloadDate(deal),
        extractLoadDate(deal),
        webTags.utmCampaign,
        webTags.advCamp,
        webTags.trafSrc,
        webTags.trafType,
        webTags.utmMedium,
        extractPlannedPaymentDate(deal),
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
