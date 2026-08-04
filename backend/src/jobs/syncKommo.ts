import { dedupeDealContactPairs, type DealContactPair } from "./dealContactPairs.js";
import { pool } from "../db/pool.js";
import {
  extractPhone,
  extractLeadSource,
  extractPaymentType,
  extractUnloadDate,
  extractLoadDate,
  extractPlannedPaymentDate,
  extractIsMinus,
  extractRejectReason,
  extractRequestType,
  extractSalesChannel,
  extractWebTags,
  fetchAllDeals,
  fetchLeadsByIds,
  fetchContactsByIds,
  fetchCompaniesByIds,
  fetchUsers,
  type KommoDeal,
} from "../kommo/client.js";
import { isLegalEntityName, normalizeClientName, normalizePhone } from "../utils/clientName.js";
import { provisionUsers } from "../db/userProvisioning.js";
import { isHeavyJobActive } from "./jobLock.js";
import { getSettings } from "../routes/settings.js";

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
 * Персистимо лідоген-дотик у постійну `leadgen_touch` з `leadgen_registry` (бот —
 * ДЖЕРЕЛО ПРАВДИ передач; TRUNCATE+insert, тримає ~5 тижнів). APPEND-ONLY
 * (`ON CONFLICT DO NOTHING`): перший раз, коли лід побачено як лідоген, фіксуємо
 * назавжди — навіть коли реєстр перезапише вікно, слід лишається, тож
 * `reclassifyAdChannel` більше не «забуває» лідоген і угода не мігрує назад у
 * «вручну». `transfer_date` = найраніша дата передачі. Ганяється щосинку ПЕРЕД
 * reclassifyAdChannel.
 *
 * 🔴 ЛИШЕ реєстр, НЕ lead_transfer_events (свідомо, доведено гейтом): transfer_events
 * завищує у рази (зміни відповідального, CLAUDE.md) і ВЖЕ бере участь у reclassify
 * через lg-CTE зі збалансованим last-touch проти реклами. Персист+форс-лідоген із
 * нього перебивав би рекламу: гейт показав 175 хибних ad→leadgen і липень 562 (замість
 * ~356 реєстру). Тільки реєстр → 4 ad→leadgen і липень 373 ≈ 356. Схема лишає колонку
 * `source` під майбутні джерела, але наразі пишемо лише 'registry'.
 */
export async function upsertLeadgenTouch(): Promise<number> {
  const res = await pool.query(
    `INSERT INTO leadgen_touch (lead_kommo_id, transfer_date, source)
     SELECT lead_id,
            (MIN(transferred_at) AT TIME ZONE 'Europe/Kyiv')::date,
            'registry'
       FROM leadgen_registry GROUP BY lead_id
     ON CONFLICT (lead_kommo_id) DO NOTHING`
  );
  return res.rowCount ?? 0;
}

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
  // ЄДИНЕ джерело правди рекламних джерел — той самий список, що adDealSql/ads_accepted
  // (app_settings через getSettings). Раніше «ad» ставився по хардкод-двійці client_source
  // ('Google','Реактивация ретаргетом'), тож РНК-угоди з client_source='uts.ua'/traf='cpc'
  // падали в 'other' → «взято лідів реклама» (читає lead_channel) розходилось з adDealSql.
  // Тепер гілка 'ad' == не-lead_channel-частина adDealSql + traf_type='cpc'/utm (маркери
  // платного трафіку), з тим самим виключенням реактивації. Пріоритет leadgen → ad → other
  // збережено (leadgen-гілки лишаються ПЕРШИМИ, щоб не з'їсти лідоген).
  const { adSources } = await getSettings();
  const res = await pool.query(
    `WITH fc AS (
       SELECT d.kommo_id, d.client_key, d.created_at_kommo, d.lead_channel,
              d.lead_generator, d.utm_source, d.client_source, d.traf_type,
              d.utm_medium, d.utm_campaign
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
       SELECT f.kommo_id, f.lead_channel, f.lead_generator, f.utm_source, f.client_source, f.traf_type,
              f.utm_medium, f.utm_campaign,
              -- ПОСТІЙНИЙ лідоген-слід САМОГО ліда (leadgen_touch, джойн по kommo_id
              -- 1:1). Deal-specific сигнал: якщо цей лід передав лідоген — це лідоген,
              -- незалежно від того, що реєстр уже перезаписав вікно. БЕЗ client_key
              -- (уникаємо колізії порожніх ключів типу «названиенеуказано»).
              EXISTS (SELECT 1 FROM leadgen_touch lt WHERE lt.lead_kommo_id = f.kommo_id) AS has_touch,
              -- 🟢 ПРАВИЛО ВЛАСНИКА 04.08.2026: рекламний дотик = звернення З UTM-МІТКОЮ
              -- АБО від НОВОГО клієнта. Пропущений дзвінок / звернення постійного —
              -- НЕ реклама. Раніше гілка adq вважала рекламним дотиком БУДЬ-ЯКИЙ лід
              -- Кваліфікації, тож дзвінок постійного клієнта, за яким реклами не було
              -- взагалі, потрапляв у знаменник конверсії реклами й у «ціну ліда».
              -- ⚠️ COALESCE на traf_type ОБОВʼЯЗКОВИЙ: умова traf_type = cpc при NULL дає
              -- NULL, і рядок не потрапив би в жодну гілку. На замірі це вже коштувало
              -- 159 угод, що тихо зникли з обох боків підсумку.
              (f.utm_source IS NOT NULL OR f.utm_medium IS NOT NULL
               OR f.utm_campaign IS NOT NULL OR COALESCE(f.traf_type, '') = 'cpc') AS has_tag,
              EXISTS (
                SELECT 1 FROM deals pr
                  JOIN pipeline_stage_map p2 ON p2.pipeline_id = pr.pipeline_id AND p2.status_id = pr.status_id
                 WHERE pr.client_key = f.client_key AND p2.funnel_stage = 'paid'
                   AND pr.created_at_kommo < f.created_at_kommo) AS is_repeat,
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
                  -- Персистентний слід — поруч зі старим лідоген-дотиком, у межах
                  -- того самого пріоритету leadgen → ad → other (leadgen лишається
                  -- ПЕРШИМ; deal-specific слід не з'їдає рекламу через client_key).
                  WHEN has_touch THEN 'leadgen'
                  WHEN lg_t IS NOT NULL AND (ad_t IS NULL OR lg_t >= ad_t) THEN 'leadgen'
                  -- 🟢 ОБИДВІ рекламні гілки тепер під гейтом власника
                  -- (мітка АБО новий клієнт). Ставимо його ОКРЕМИМ доданком, а не
                  -- всередині кожної умови: інакше через півроку хтось додасть третю
                  -- гілку й забуде гейт, і правило тихо перестане діяти.
                  WHEN ad_t IS NOT NULL AND COALESCE(client_source, '') NOT ILIKE '%реактив%'
                       AND (has_tag OR NOT is_repeat) THEN 'ad'
                  WHEN (client_source = ANY($4) OR traf_type = 'cpc' OR utm_source IS NOT NULL)
                       AND COALESCE(client_source, '') NOT ILIKE '%реактив%'
                       AND (has_tag OR NOT is_repeat) THEN 'ad'
                  ELSE 'other'
                END AS target
           FROM calc
       ) c
      WHERE d.kommo_id = c.kommo_id AND d.lead_channel IS DISTINCT FROM c.target`,
    [[8921932, 155304], QUALIFICATION_PIPELINES, QUAL_LEADGEN_STAGES, adSources]
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

    // Звʼязок угода↔контакт — з ТОГО САМОГО знімка `deal._embedded.contacts`, який уже
    // в руках: НУЛЬ додаткових запитів до Kommo. Живить рознесення нотаток контактів
    // (дзвінки Ringostat) по угодах — див. `syncContactActivity`.
    await upsertDealContacts(deals);

    // Персистимо лідоген-слід із поточного знімка реєстру (+ transfer_events) у
    // постійну leadgen_touch ПЕРЕД reclassify — щоб хвіст не губився, коли реєстр
    // перезапише вікно, і угода не мігрувала назад у «вручну».
    const touched = await upsertLeadgenTouch();

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

    console.log(`Synced ${managerCount} users and ${deals.length} deals. Leadgen-touch +${touched}. Reclassified ${reclassified} full-cycle deals.`);
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

/**
 * Пише `deal_contacts` із вже завантаженого знімка угод (ФАЗА 2 «дзвінки»). Kommo вішає
 * телефонію на КОНТАКТ, тож без цього лінка дзвінок нікуди рознести. Джерело — те саме
 * `_embedded.contacts`, яке синк уже отримав разом з угодою → додаткових запитів НЕМАЄ.
 * Ідемпотентно (ON CONFLICT). Відвʼязані контакти чистимо по кожній угоді вікна, щоб
 * старий звʼязок не тягнув чужі дзвінки після перепризначення контакта.
 */
async function upsertDealContacts(deals: KommoDeal[]): Promise<void> {
  // 🔴 ДЕДУП ПАР ОБОВʼЯЗКОВИЙ. Postgres не дозволяє одному INSERT ... ON CONFLICT
  // DO UPDATE зачепити той самий рядок двічі — саме на цьому синк ліг 03.08.2026.
  // Джерело дублікатів — паралельна пагінація у `fetchAllDeals` (та сама угода
  // може прийти у двох сторінках), а не дубль контакта в угоді; див.
  // `dealContactPairs.ts`. Дедуп тут страхує від БУДЬ-ЯКОГО джерела.
  const raw: DealContactPair[] = [];
  const seenDeals = [...new Set(deals.map((d) => d.id))];
  for (const d of deals) {
    for (const c of d._embedded?.contacts ?? []) {
      raw.push({ dealId: d.id, contactId: c.id, isMain: c.is_main === true });
    }
  }
  const pairs = dedupeDealContactPairs(raw);
  const dealIds = pairs.map((p) => p.dealId);
  const contactIds = pairs.map((p) => p.contactId);
  const mains = pairs.map((p) => p.isMain);
  if (!seenDeals.length) return;
  if (dealIds.length) {
    await pool.query(
      `INSERT INTO deal_contacts (deal_kommo_id, contact_id, is_main, updated_at)
       SELECT * FROM (SELECT UNNEST($1::bigint[]) AS d, UNNEST($2::bigint[]) AS c,
                             UNNEST($3::boolean[]) AS m, now() AS u) v
       ON CONFLICT (deal_kommo_id, contact_id)
       DO UPDATE SET is_main = EXCLUDED.is_main, updated_at = now()`,
      [dealIds, contactIds, mains]
    );
  }
  // прибрати звʼязки, яких уже немає в CRM (лише для угод цього вікна)
  await pool.query(
    `DELETE FROM deal_contacts dc
      WHERE dc.deal_kommo_id = ANY($1::bigint[])
        AND NOT EXISTS (SELECT 1 FROM (SELECT UNNEST($2::bigint[]) d, UNNEST($3::bigint[]) c) v
                         WHERE v.d = dc.deal_kommo_id AND v.c = dc.contact_id)`,
    [seenDeals, dealIds, contactIds]
  );
}

/**
 * Разова побудова `deal_contacts` для АКТИВНИХ FC-угод (крок 1 бекфілу ФАЗИ 2). Штатно
 * лінк пише `syncKommo` зі свого вікна — але угоди, які давно не рухались, у це вікно не
 * потрапляють, тож без цього проходу їхні дзвінки нікуди рознести. `fetchLeadsByIds` уже
 * ходить із `with=contacts,companies`, тож це ~10 запитів на 2.3к угод (250/запит).
 */
export async function buildDealContactLinks(): Promise<{ deals: number; requests: number }> {
  const r = await pool.query<{ kommo_id: string }>(
    `SELECT d.kommo_id FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE d.pipeline_id = ANY('{8921932,155304}'::bigint[]) AND psm.funnel_stage <> 'paid'
      ORDER BY d.kommo_id`
  );
  const ids = r.rows.map((x) => Number(x.kommo_id));
  let requests = 0;
  for (let i = 0; i < ids.length; i += 250) {
    requests++;
    const leads = await fetchLeadsByIds(ids.slice(i, i + 250));
    await upsertDealContacts(leads);
  }
  console.log(`buildDealContactLinks: ${ids.length} активних FC-угод, ${requests} запитів.`);
  return { deals: ids.length, requests };
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

  // «Мінусові» угоди (сторно/повернення): Kommo-калькулятор не вміє відʼємний бюджет →
  // показує плюсом. Знак дає ПОЛЕ «Мінусова угода» (2098529 = «Мінус»), НЕ слово в назві.
  // price — чиста функція (бюджет, is_minus): price = is_minus ? -abs(budget) : +abs(budget).
  // Тож при зміні прапорця в CRM синк само-виправляє знак у обидва боки (ідемпотентно).
  const isMinus = extractIsMinus(deal);
  const budget = Math.abs(Number(deal.price) || 0);
  const signedPrice = isMinus ? -budget : budget;
  // «Причина отказа» (2097265) → нецільові = ад ∩ {Дубль, Перевізник}. Populate щосинку.
  const rejectReason = extractRejectReason(deal);

  await pool.query(
    `INSERT INTO deals (
         kommo_id, name, manager_id, kommo_user_id, pipeline_id, status_id,
         price, created_at_kommo, updated_at_kommo, closed_at_kommo, synced_at,
         client_name, client_key_raw, client_key, utm_source, lead_generator, client_source, lead_channel, payment_type,
         unload_at, load_at, utm_campaign, adv_camp, traf_src, traf_type, utm_medium, planned_payment_at, is_minus, reject_reason,
         request_type, sales_channel
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12,
                 -- 🔴 КАНОНІЧНИЙ КЛЮЧ РАХУЄМО ТУТ, а не пишемо сирий. Інакше синк при
                 -- наступному оновленні угоди ЗАТЕР би канонічний ключ сирим, і аліас
                 -- тихо перестав би діяти — рівно для тих угод, що змінюються найчастіше.
                 COALESCE((SELECT a.canonical_key FROM client_key_alias a
                            WHERE a.alias_key = $12 AND a.revoked_at IS NULL), $12),
                 $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
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
         client_key_raw = EXCLUDED.client_key_raw,
         -- те саме на UPDATE: канонічний перераховується з нового сирого, а не
         -- перезаписується ним.
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
         planned_payment_at = EXCLUDED.planned_payment_at,
         is_minus = EXCLUDED.is_minus,
         reject_reason = EXCLUDED.reject_reason,
         request_type = EXCLUDED.request_type,
         sales_channel = EXCLUDED.sales_channel`,
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
        isMinus,
        rejectReason,
        extractRequestType(deal),
        extractSalesChannel(deal),
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
