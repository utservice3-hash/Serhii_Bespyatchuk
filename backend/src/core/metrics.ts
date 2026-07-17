import { pool } from "../db/pool.js";

/**
 * ЄДИНЕ місце в проєкті з SQL по НЕ-грошових бізнес-метриках (гроші — `core/money.ts`).
 * Той самий патерн, що й money.ts: спільний фільтр-скоуп + функції-аґрегати.
 *
 * КРОК 5 (14.07.2026), ця сесія — ТРИ метрики: ВОРОНКА · СЕГМЕНТИ · ЛІДИ (ads_accepted).
 * Дебіторка / застряглі / час опрацювання — наступна сесія. Конверсію НЕ чіпаємо
 * (В2/В3/В4 відкриті). Стару логіку в роутах НЕ видаляємо — вона живе паралельно до
 * міграції (КРОК 9); тут будуємо канонічне ядро й звіряємо стара↔core↔Kommo.
 */
export const FC_PIPELINES = [8921932, 155304];
const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

export interface MetricScope {
  from?: string | null;
  to?: string | null;
  managerId?: number | null;
  teamId?: number | null;
  activeOnly?: boolean;
}
export interface MetricAgg {
  deals: number;
  revenue: number;
}

/**
 * Скоуп для метрик-ЗНІМКІВ «станом на зараз» (дебіторка, застряглі) — БЕЗ періоду.
 * 🔴 `from`/`to` заборонені НА РІВНІ ТИПУ (`never`), а не в коментарі: хто передасть
 * дату — отримає помилку компіляції, а не тихий знімок. (`never` ловить і об'єктні
 * літерали, і змінні типу `MetricScope` — бо `string|null` не присвоїться до `never`.)
 * Причина: борг/застряглість — це «зараз», не період; тихий знімок при поданні дат
 * — рівно той клас прихованих розбіжностей, який ми ловили весь reset.
 */
export interface SnapshotScope {
  managerId?: number | null;
  teamId?: number | null;
  activeOnly?: boolean;
  from?: never;
  to?: never;
}

/**
 * ЄДИНЕ правило «рекламна угода» (рішення власника 10.07): повний цикл, де
 * «Источник клиента» ∈ adSources АБО дотик Кваліфікації без лідоген-маркерів
 * (`lead_channel='ad'`), і це НЕ реактивація. БЕЗ фільтра поточного етапу.
 * `srcRef` — плейсхолдер параметра з масивом adSources (напр. "$3").
 * 🔴 Канонічний адДілSQL — раніше дублювався в `routes/dashboard.ts:26` та
 * `statistics/computeAuto.ts:14`; при міграції (КРОК 9) обидва беруть звідси.
 */
export const adDealSql = (srcRef: string): string =>
  `((d.client_source = ANY(${srcRef}) OR d.lead_channel = 'ad') AND COALESCE(d.client_source, '') NOT ILIKE '%реактив%')`;

/**
 * СЕГМЕНТ УГОДИ (не глобальна мітка клієнта), пріоритет-партиція (GLOSSARY §9):
 *   1. leadgen — угода атрибутована лідогену (`lead_channel='leadgen'`, вже містить
 *      «реактивація б'є мітки»).
 *   2. repeat  — НЕ лідоген І клієнт мав ≥1 ПОПЕРЕДНЄ успішне перевезення
 *      (paid-угода того ж `client_key`, створена РАНІШЕ за цю → тобто це 2+).
 *   3. new     — решта.
 * Вичерпний CASE → кожна угода рівно в один сегмент → Лідоген+Постійні+Нові=Загал.
 * «Попереднє» — за `created_at` (як існуючий `firsts` = MIN(created_at) по paid).
 */
export const SEGMENT_CASE = `
  CASE
    WHEN d.lead_channel = 'leadgen' THEN 'leadgen'
    WHEN d.client_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM deals pr
      JOIN pipeline_stage_map psm2 ON psm2.pipeline_id = pr.pipeline_id AND psm2.status_id = pr.status_id
      WHERE pr.client_key = d.client_key
        AND psm2.funnel_stage = 'paid'
        AND pr.created_at_kommo < d.created_at_kommo
    ) THEN 'repeat'
    ELSE 'new'
  END`;

/** Спільний скоуп «когорта створення» по повному циклу: $1 = FC_PIPELINES, далі
 *  фільтри періоду (по `created_at`), менеджера/команди. Повертає SQL-умови + params. */
function cohortScope(s: MetricScope): { where: string; params: unknown[]; activeJoin: string } {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)"];
  if (s.from) { params.push(s.from); conds.push(`(d.created_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.created_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  return { where: conds.join(" AND "), params, activeJoin: s.activeOnly ? "AND m.is_active" : "" };
}

// ───────────────────────── СЕГМЕНТИ ─────────────────────────

export interface SegmentBreakdown {
  new: MetricAgg;
  repeat: MetricAgg;
  leadgen: MetricAgg;
  total: MetricAgg;
}

/**
 * Розподіл угод повного циклу, СТВОРЕНИХ у періоді, по сегментах new/repeat/leadgen
 * (deal-grain). Інваріант: new+repeat+leadgen = total (перевіряти явно).
 * revenue = SUM(price) когорти (нетто мінусів; це НЕ гроші з money.ts — це обсяг
 * когорти, підписувати відповідно).
 */
export async function segments(s: MetricScope): Promise<SegmentBreakdown> {
  const { where, params, activeJoin } = cohortScope(s);
  const r = await pool.query<{ segment: string; deals: string; revenue: string }>(
    `SELECT segment, COUNT(*) AS deals, COALESCE(SUM(price), 0) AS revenue FROM (
       SELECT d.price, ${SEGMENT_CASE} AS segment
       FROM deals d
       JOIN managers m ON m.id = d.manager_id ${activeJoin}
       WHERE ${where}
     ) seg GROUP BY segment`,
    params
  );
  const z = (): MetricAgg => ({ deals: 0, revenue: 0 });
  const out: SegmentBreakdown = { new: z(), repeat: z(), leadgen: z(), total: z() };
  for (const row of r.rows) {
    const key = (row.segment as "new" | "repeat" | "leadgen") ?? "new";
    const agg = { deals: Number(row.deals), revenue: Number(row.revenue) };
    out[key] = agg;
    out.total.deals += agg.deals;
    out.total.revenue += agg.revenue;
  }
  return out;
}

// ───────────────────────── ВОРОНКА ─────────────────────────

export const FUNNEL_ORDER = ["lead_taken", "quote_requested", "approved", "invoiced", "paid"] as const;

export interface StageRow {
  stage: string;
  deals: number;
  revenue: number;
}

/**
 * `/funnel` — розподіл угод «зараз» по стадіях воронки (усі пайплайни, INNER psm,
 * когорта створення). Проста заміна поточного `/funnel`.
 */
export async function funnelByStage(s: MetricScope): Promise<StageRow[]> {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  if (s.from) { params.push(s.from); conds.push(`(d.created_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.created_at_kommo ${KYIV})::date <= $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const r = await pool.query<{ stage: string; deals: string; revenue: string }>(
    `SELECT psm.funnel_stage AS stage, COUNT(*) AS deals, COALESCE(SUM(d.price), 0) AS revenue
     FROM deals d
     JOIN managers m ON m.id = d.manager_id ${activeJoin}
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
     GROUP BY psm.funnel_stage`,
    params
  );
  return r.rows.map((x) => ({ stage: x.stage, deals: Number(x.deals), revenue: Number(x.revenue) }));
}

export interface FunnelCohortRow {
  stage: string;
  new: number;
  repeat: number;
  leadgen: number;
  total: number;
}

/**
 * `/funnel-report` — воронка клієнтів: 5 стадій × сегмент, НАКОПИЧУВАЛЬНА за когортою
 * створення (повний цикл, INNER psm, лише активні менеджери). Угода зараховується в
 * КОЖНУ стадію до найглибшої досягнутої включно.
 * ⚠️ Сегмент — НОВИЙ канонічний (deal-time, prior-paid), тому цифри «постійні» можуть
 * відрізнятись від старого `/funnel-report` (той рахував lifetime cnt≥2 — глобальну
 * мітку). Це очікувана, пояснена дельта (GLOSSARY §9).
 */
export async function funnelCohort(s: MetricScope): Promise<FunnelCohortRow[]> {
  const scope: MetricScope = { ...s, activeOnly: s.activeOnly ?? true }; // funnel-report завжди активні
  const { where, params, activeJoin } = cohortScope(scope);
  const r = await pool.query<{ stage: string; segment: string; c: string }>(
    `SELECT psm.funnel_stage AS stage, ${SEGMENT_CASE} AS segment, COUNT(*) AS c
     FROM deals d
     JOIN managers m ON m.id = d.manager_id ${activeJoin}
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${where}
     GROUP BY psm.funnel_stage, segment`,
    params
  );
  const reached = FUNNEL_ORDER.map(() => ({ new: 0, repeat: 0, leadgen: 0, total: 0 }));
  for (const row of r.rows) {
    const idx = FUNNEL_ORDER.indexOf(row.stage as (typeof FUNNEL_ORDER)[number]);
    if (idx < 0) continue;
    const seg = (row.segment as "new" | "repeat" | "leadgen") ?? "new";
    const c = Number(row.c);
    for (let i = 0; i <= idx; i++) { reached[i][seg] += c; reached[i].total += c; }
  }
  return FUNNEL_ORDER.map((stage, i) => ({ stage, ...reached[i] }));
}

export interface FunnelSegmentRow {
  managerId: number;
  name: string;
  stage: string;
  segment: "new" | "repeat" | "leadgen";
  count: number;
}

/**
 * RAW per-(manager, stage, segment) cohort counts для `/funnel-report`. НЕ накопичує —
 * роут сам робить кумуляцію (buildStages) для overall і по кожному менеджеру, накладає
 * план і формує відповідь (Fork 2: «core дає числа, роут добудовує форму»).
 * 🔴 Це ЄДИНИЙ виправданий per-manager аґреґат (Fork 2 виняток): funnel-report малює
 * матрицю менеджер×стадія×сегмент, якої жоден скалярний/overall аґреґат (funnelCohort)
 * не дає. Сегмент — канонічний `SEGMENT_CASE` (deal-grain, prior-paid), що ЗАМІНЮЄ старий
 * lifetime-ярлик `cnt>=2 → regular`: розподіл new/repeat зсувається (сума по стадії — та
 * сама; GLOSSARY §9). Лише активні менеджери (як старий роут).
 */
export async function funnelSegmentRows(s: MetricScope): Promise<FunnelSegmentRow[]> {
  const scope: MetricScope = { ...s, activeOnly: s.activeOnly ?? true };
  const { where, params, activeJoin } = cohortScope(scope);
  const r = await pool.query<{ manager_id: number; name: string; stage: string; segment: string; c: string }>(
    `SELECT m.id AS manager_id, m.name, psm.funnel_stage AS stage, ${SEGMENT_CASE} AS segment, COUNT(*) AS c
     FROM deals d
     JOIN managers m ON m.id = d.manager_id ${activeJoin}
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${where}
     GROUP BY m.id, m.name, psm.funnel_stage, segment`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id,
    name: x.name,
    stage: x.stage,
    segment: (x.segment as "new" | "repeat" | "leadgen") ?? "new",
    count: Number(x.c),
  }));
}

export interface FunnelWeekRow {
  stage: string;
  bucket: string; // YYYY-MM-DD (початок тижня або день)
  deals: number;
}

/**
 * `/funnel-weekly` FACT — пропускна здатність: скільки угод УВІЙШЛО в кожну стадію
 * у кожному тижні/дні (`deal_stage_events`, анкер `changed_at`, DISTINCT по угоді).
 * На відміну від funnelCohort (когорта створення), це потік входів у стадію.
 */
export async function funnelWeekly(s: MetricScope, granularity: "day" | "week" = "week"): Promise<FunnelWeekRow[]> {
  const bucket = granularity === "day"
    ? `(dse.changed_at ${KYIV})::date`
    : `date_trunc('week', (dse.changed_at ${KYIV}))::date`;
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "psm.funnel_stage IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(dse.changed_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(dse.changed_at ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const r = await pool.query<{ stage: string; bucket: string; deals: string }>(
    `SELECT psm.funnel_stage AS stage, to_char(${bucket}, 'YYYY-MM-DD') AS bucket,
            COUNT(DISTINCT dse.kommo_id) AS deals
     FROM deal_stage_events dse
     JOIN deals d ON d.kommo_id = dse.kommo_id
     JOIN managers m ON m.id = d.manager_id ${activeJoin}
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
     WHERE ${conds.join(" AND ")}
     GROUP BY psm.funnel_stage, bucket`,
    params
  );
  return r.rows.map((x) => ({ stage: x.stage, bucket: x.bucket, deals: Number(x.deals) }));
}

export interface FunnelWeekMgrRow {
  managerId: number;
  name: string;
  stage: string;
  bucket: string; // YYYY-MM-DD (понеділок тижня або день, київський)
  deals: number;
}

/**
 * `/funnel-weekly` FACT по МЕНЕДЖЕРУ — той самий потік входів у стадію, що й
 * `funnelWeekly`, але з розрізом по менеджеру (роут малює матрицю менеджер×тиждень).
 * 🔴 Другий виправданий per-manager аґреґат (Fork 2 виняток): funnel-weekly показує
 * рядок на кожного менеджера, чого overall `funnelWeekly` не дає. Числа FACT ІДЕНТИЧНІ
 * старому інлайн-запиту роуту (той самий SQL, лише винесений) — форма (тижні, план,
 * гроші) лишається в роуті. Лише активні менеджери.
 */
export async function funnelWeeklyByManager(s: MetricScope, granularity: "day" | "week" = "week"): Promise<FunnelWeekMgrRow[]> {
  const bucket = granularity === "day"
    ? `(dse.changed_at ${KYIV})::date`
    : `date_trunc('week', (dse.changed_at ${KYIV}))::date`;
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "psm.funnel_stage IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(dse.changed_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(dse.changed_at ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const r = await pool.query<{ manager_id: number; name: string; stage: string; bucket: string; deals: string }>(
    `SELECT d.manager_id, m.name, psm.funnel_stage AS stage, to_char(${bucket}, 'YYYY-MM-DD') AS bucket,
            COUNT(DISTINCT dse.kommo_id) AS deals
     FROM deal_stage_events dse
     JOIN deals d ON d.kommo_id = dse.kommo_id
     JOIN managers m ON m.id = d.manager_id ${activeJoin}
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
     WHERE ${conds.join(" AND ")}
     GROUP BY d.manager_id, m.name, psm.funnel_stage, bucket`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id, name: x.name, stage: x.stage, bucket: x.bucket, deals: Number(x.deals),
  }));
}

// ───────────────────────── ЛІДИ (ads_accepted) ─────────────────────────

/** Спільний скоуп для ads_accepted: FC + період по created_at + adDealSql. */
function adsScope(s: MetricScope, adSources: string[]): { where: string; params: unknown[]; activeJoin: string } {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)"];
  if (s.from) { params.push(s.from); conds.push(`(d.created_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.created_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  params.push(adSources);
  conds.push(adDealSql(`$${params.length}`));
  return { where: conds.join(" AND "), params, activeJoin: s.activeOnly ? "AND m.is_active" : "" };
}

/**
 * `ads_accepted` («Прийнято реклами») — угоди повного циклу, СТВОРЕНІ в періоді, що
 * відповідають `adDealSql`. Канонічна заміна 8 розкиданих `ad_leads` + дубля в
 * computeAuto (рероутинг — КРОК 9). `adSources` беруться з `getSettings()`.
 */
export async function adsAccepted(s: MetricScope, adSources: string[]): Promise<number> {
  const { where, params, activeJoin } = adsScope(s, adSources);
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM deals d JOIN managers m ON m.id = d.manager_id ${activeJoin} WHERE ${where}`,
    params
  );
  return Number(r.rows[0]?.n ?? 0);
}

export interface MgrCount {
  managerId: number;
  name: string;
  teamId: number | null;
  count: number;
}

/** `ads_accepted` по менеджеру (для звіту/КВП). */
export async function adsAcceptedByMgr(s: MetricScope, adSources: string[]): Promise<MgrCount[]> {
  const { where, params, activeJoin } = adsScope(s, adSources);
  const r = await pool.query<{ manager_id: number; name: string; team_id: number | null; n: string }>(
    `SELECT m.id AS manager_id, m.name, m.team_id, COUNT(*) AS n
     FROM deals d JOIN managers m ON m.id = d.manager_id ${activeJoin}
     WHERE ${where}
     GROUP BY m.id, m.name, m.team_id
     ORDER BY n DESC`,
    params
  );
  return r.rows.map((x) => ({ managerId: x.manager_id, name: x.name, teamId: x.team_id, count: Number(x.n) }));
}

// ───────────────────────── КОНВЕРСІЯ РЕКЛАМИ (conversion_ads) ─────────────────────────

/**
 * Рекламна зона Кваліфікації — «взяті в роботу» (Варіант A, рішення власника
 * КРОК 6.3). Анкер по ПОДІЯХ (`deal_stage_events`): «Лід взятий у роботу» +
 * «Дзвінки» + «Дзвінки з сайту», ОБИДВІ воронки Кваліфікації (New 8921928 /
 * old 7336928). Нерозібране (Incoming, type 1) і eLogist НЕ входять — ліди там
 * СТВОРЮЮТЬСЯ, події входу немає (доведено: 0 подій), а Нерозібране — сирий
 * прекваліфікаційний інбокс зі сміттям. Порядок: New(taken,call,web) + old.
 */
const ADZONE_TAKEN = [69693652, 69693656, 69693660, 68671948, 68065144, 67888780];

/**
 * ПЛАТНИЙ фільтр знаменника (CONVERSION_RULES §1 + рішення 6.3): веб-платний
 * (`traf_type='cpc'` OR `utm_medium='cpc'` OR `utm_campaign` присутній) АБО
 * рекламний коллтрекінг (`adDealSql`), але з коллтрекінгу ВИРІЗАНА органіка
 * (`traf_type<>'organic'`) — інакше adDealSql змітав би ~1.7к органічних угод
 * у знаменник (доведено 6.3). `srcRef` — плейсхолдер параметра з adSources.
 */
const paidAdSql = (srcRef: string): string =>
  `((d.traf_type = 'cpc' OR d.utm_medium = 'cpc' OR d.utm_campaign IS NOT NULL)
    OR (${adDealSql(srcRef)} AND COALESCE(lower(d.traf_type), '') <> 'organic'))`;

export interface ConversionAdsRow {
  ym: string;
  entered: number;       // знаменник обох версій: платні нові, що зайшли в зону в місяці
  wonEventually: number; // чисельник КОГОРТИ: із цих — скільки ЗРЕШТОЮ виграли (FC 142)
  cohortPct: number | null;
  wonInMonth: number;    // чисельник ПЕРІОДУ: виграли (FC 142) у цьому місяці
  periodPct: number | null;
  mature: boolean;       // когорта дозріла (≥90 днів від кінця місяця)
}

/**
 * `conversion_ads` помісячно за 12 міс (GLOSSARY §2b): дві версії —
 *  • `cohort`  = зайшли в зону в місяці → скільки з них ЗРЕШТОЮ виграли (наскрізь
 *    до FC 142). Чисельник ⊆ знаменник → стеля ≤100% (математичний інваріант).
 *  • `period`  = виграли у місяці ÷ зайшли в місяці (різні когорти) → може
 *    перевищувати 100% при зростанні потоку (артефакт когорт, не баг коду).
 * Знаменник: платні (paidAdSql) нові (SEGMENT_CASE='new', вже без лідогену)
 * ліди, що зайшли в ADZONE_TAKEN. Чисельник: їхній `deal_id` має подію входу в
 * 142 у Повному циклі. Скоуп — той самий MetricScope (manager/team).
 */
export async function conversionAdsByMonth(s: MetricScope, adSources: string[]): Promise<ConversionAdsRow[]> {
  const params: unknown[] = [ADZONE_TAKEN, FC_PIPELINES, adSources];
  const scopeConds: string[] = [];
  if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
  const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";

  const r = await pool.query<{
    ym: string; entered: string; won_eventually: string; won_in_month: string; mature: boolean;
  }>(
    `WITH adzone AS (
       SELECT kommo_id, MIN(changed_at) AS entered_at
         FROM deal_stage_events WHERE status_id = ANY($1) GROUP BY kommo_id
     ),
     won AS (
       SELECT kommo_id, MIN(changed_at) AS won_at
         FROM deal_stage_events WHERE pipeline_id = ANY($2) AND status_id = 142 GROUP BY kommo_id
     ),
     pop AS (
       SELECT a.entered_at, w.won_at
         FROM adzone a
         JOIN deals d ON d.kommo_id = a.kommo_id
         LEFT JOIN managers m ON m.id = d.manager_id
         LEFT JOIN won w ON w.kommo_id = a.kommo_id
        WHERE ${paidAdSql("$3")}
          AND (${SEGMENT_CASE}) = 'new'
          ${scopeWhere}
     ),
     months AS (
       SELECT generate_series(
         date_trunc('month', (now() ${KYIV})) - INTERVAL '11 months',
         date_trunc('month', (now() ${KYIV})),
         INTERVAL '1 month') AS m
     )
     SELECT to_char(mo.m, 'YYYY-MM') AS ym,
       COUNT(*) FILTER (WHERE p.entered_at IS NOT NULL
                          AND date_trunc('month', (p.entered_at ${KYIV})) = mo.m)::int AS entered,
       COUNT(*) FILTER (WHERE p.entered_at IS NOT NULL AND p.won_at IS NOT NULL
                          AND date_trunc('month', (p.entered_at ${KYIV})) = mo.m)::int AS won_eventually,
       COUNT(*) FILTER (WHERE p.won_at IS NOT NULL
                          AND date_trunc('month', (p.won_at ${KYIV})) = mo.m)::int AS won_in_month,
       ((mo.m + INTERVAL '1 month') <= (now() ${KYIV}) - INTERVAL '90 days') AS mature
     FROM months mo LEFT JOIN pop p ON TRUE
     GROUP BY mo.m ORDER BY mo.m`,
    params
  );
  return r.rows.map((x) => {
    const entered = Number(x.entered);
    const wonEventually = Number(x.won_eventually);
    const wonInMonth = Number(x.won_in_month);
    return {
      ym: x.ym,
      entered,
      wonEventually,
      cohortPct: entered > 0 ? Math.round((wonEventually / entered) * 1000) / 10 : null,
      wonInMonth,
      periodPct: entered > 0 ? Math.round((wonInMonth / entered) * 1000) / 10 : null,
      mature: x.mature,
    };
  });
}

export interface MgrConversion {
  managerId: number;
  name: string;
  teamId: number | null;
  entered: number;
  won: number;
  cohortPct: number | null; // null коли entered < 10 → UI показує «—» (не «0%»)
}

/**
 * `conversion_ads` ПО МЕНЕДЖЕРУ, period-aggregate (для таблиці Звіту). Одним
 * згрупованим запитом (не N викликів помісячної). Когорта: платні нові ліди,
 * що зайшли в рекламну зону в [from,to] → з них дійшли до FC-142 (той самий
 * deal_id). Стеля ≤100% (won ⊆ entered). entered<10 → cohortPct=null (нерекламні
 * менеджери не плутаються з «0%»).
 */
export async function conversionAdsByManager(s: MetricScope, adSources: string[]): Promise<MgrConversion[]> {
  const params: unknown[] = [ADZONE_TAKEN, FC_PIPELINES, adSources];
  const scopeConds: string[] = [];
  if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
  const fromRef = (params.push(s.from ?? null), `$${params.length}`);
  const toRef = (params.push(s.to ?? null), `$${params.length}`);
  const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";

  const r = await pool.query<{ manager_id: number; name: string; team_id: number | null; entered: string; won: string }>(
    `WITH adzone AS (
       SELECT kommo_id, MIN(changed_at) AS entered_at
         FROM deal_stage_events WHERE status_id = ANY($1) GROUP BY kommo_id
     ),
     won AS (
       SELECT kommo_id, MIN(changed_at) AS won_at
         FROM deal_stage_events WHERE pipeline_id = ANY($2) AND status_id = 142 GROUP BY kommo_id
     ),
     pop AS (
       SELECT d.manager_id, (w.won_at IS NOT NULL) AS won
         FROM adzone a
         JOIN deals d ON d.kommo_id = a.kommo_id
         LEFT JOIN managers m ON m.id = d.manager_id
         LEFT JOIN won w ON w.kommo_id = a.kommo_id
        WHERE ${paidAdSql("$3")} AND (${SEGMENT_CASE}) = 'new'
          AND ((${fromRef})::date IS NULL OR (a.entered_at ${KYIV})::date >= (${fromRef})::date)
          AND ((${toRef})::date IS NULL OR (a.entered_at ${KYIV})::date <= (${toRef})::date)
          ${scopeWhere}
     )
     SELECT mm.id AS manager_id, mm.name, mm.team_id,
            COUNT(*)::int AS entered, COUNT(*) FILTER (WHERE pop.won)::int AS won
       FROM pop JOIN managers mm ON mm.id = pop.manager_id
      GROUP BY mm.id, mm.name, mm.team_id`,
    params
  );
  return r.rows.map((x) => {
    const entered = Number(x.entered), won = Number(x.won);
    return { managerId: x.manager_id, name: x.name, teamId: x.team_id, entered, won,
      cohortPct: entered >= 10 ? Math.round((won / entered) * 1000) / 10 : null };
  });
}

// ───────────────────────── КОНВЕРСІЯ ЛІДОГЕНУ (Продзвін + Реактивація) ─────────────────────────

const PRODZVIN_PIPELINES = [8921936, 7337048]; // холодний лідоген (NEW / old)
const PZ_TAKEN = 69693696;                     // Продзвін «ВЗЯТО В РОБОТУ» — entry-анкер
const REACTIVATION_PIPELINES = [8921948];      // реактивація існуючих клієнтів
const REACT_WARMING = 69693740;                // Реактивація «Клієнт підігрівається» — entry-анкер
const STATUS_142 = 142;                        // handoff (Продзвін/Реактивація) + won (FC) «Успішна»

export interface LeadgenConversionRow {
  ym: string;
  entered: number;            // знаменник: DISTINCT client_key, що зайшли в entry-стадію у місяці
  handoffEventually: number;  // cohort: із них — дійшли до 142 у СВОЇЙ воронці (прорахунок/передача)
  handoffCohortPct: number | null;
  wonEventually: number;      // cohort: із них — client_key дійшов до FC-142 (гроші, наскрізь)
  wonCohortPct: number | null;
  handoffInMonth: number;     // period: handoff у місяці
  handoffPeriodPct: number | null;
  wonInMonth: number;         // period: won у місяці
  wonPeriodPct: number | null;
  mature: boolean;
}

/**
 * СПІЛЬНЕ ЯДРО конверсії лідогену (Продзвін і Реактивація мають ідентичну
 * структуру, різняться лише воронкою + entry-стадією). ДЕДУП по `client_key` —
 * одиниця = КЛІЄНТ, не deal_id (угода лідогену і виграна FC-угода — РІЗНІ
 * deal_id, спільний client_key; доведено на даних КРОК 6.4/6.5). Категорії
 * відмов НЕ фільтруємо, БЕЗ new-фільтра.
 *  • handoff = зайшли в entry → дійшли до 142 у СВОЇЙ воронці (`entryPipelines`).
 *  • won     = → `client_key` дійшов до 142 у Повному циклі (крос-пайплайн).
 * Обидва чисельники — ПІСЛЯ входу (`changed_at >= entered_at`), інакше стара
 * виграна угода клієнта (до дотику лідогену) хибно зараховувалась би йому.
 * cohort: чисельник ⊆ знаменник → стеля ≤100%. period: може >100% (різні когорти).
 * `client_key IS NULL` виключено (немає по чому дедупити/трекати наскрізь).
 */
async function leadgenConversionByMonth(
  s: MetricScope,
  cfg: { entryPipelines: number[]; entryStatus: number }
): Promise<LeadgenConversionRow[]> {
  // $1 = entryPipelines (also handoff-142 lives here), $2 = FC (won), $3 = entryStatus, $4 = 142
  const params: unknown[] = [cfg.entryPipelines, FC_PIPELINES, cfg.entryStatus, STATUS_142];
  const scopeConds: string[] = [];
  if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
  const scopeJoin = s.teamId ? "LEFT JOIN managers m ON m.id = d.manager_id" : "";
  const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";

  const r = await pool.query<{
    ym: string; entered: string; handoff_eventually: string; won_eventually: string;
    handoff_in_month: string; won_in_month: string; mature: boolean;
  }>(
    `WITH entered AS (
       SELECT d.client_key, MIN(e.changed_at) AS entered_at
         FROM deal_stage_events e
         JOIN deals d ON d.kommo_id = e.kommo_id ${scopeJoin}
        WHERE e.status_id = $3 AND e.pipeline_id = ANY($1) AND d.client_key IS NOT NULL ${scopeWhere}
        GROUP BY d.client_key
     ),
     handoff AS (
       SELECT en.client_key, MIN(e.changed_at) AS handoff_at
         FROM entered en
         JOIN deals d ON d.client_key = en.client_key
         JOIN deal_stage_events e ON e.kommo_id = d.kommo_id
        WHERE e.status_id = $4 AND e.pipeline_id = ANY($1) AND e.changed_at >= en.entered_at
        GROUP BY en.client_key
     ),
     won AS (
       SELECT en.client_key, MIN(e.changed_at) AS won_at
         FROM entered en
         JOIN deals d ON d.client_key = en.client_key
         JOIN deal_stage_events e ON e.kommo_id = d.kommo_id
        WHERE e.status_id = $4 AND e.pipeline_id = ANY($2) AND e.changed_at >= en.entered_at
        GROUP BY en.client_key
     ),
     pop AS (
       SELECT en.client_key, en.entered_at, h.handoff_at, w.won_at
         FROM entered en
         LEFT JOIN handoff h ON h.client_key = en.client_key
         LEFT JOIN won w ON w.client_key = en.client_key
     ),
     months AS (
       SELECT generate_series(
         date_trunc('month', (now() ${KYIV})) - INTERVAL '11 months',
         date_trunc('month', (now() ${KYIV})),
         INTERVAL '1 month') AS m
     )
     SELECT to_char(mo.m, 'YYYY-MM') AS ym,
       COUNT(*) FILTER (WHERE p.entered_at IS NOT NULL
                          AND date_trunc('month', (p.entered_at ${KYIV})) = mo.m)::int AS entered,
       COUNT(*) FILTER (WHERE p.handoff_at IS NOT NULL
                          AND date_trunc('month', (p.entered_at ${KYIV})) = mo.m)::int AS handoff_eventually,
       COUNT(*) FILTER (WHERE p.won_at IS NOT NULL
                          AND date_trunc('month', (p.entered_at ${KYIV})) = mo.m)::int AS won_eventually,
       COUNT(*) FILTER (WHERE p.handoff_at IS NOT NULL
                          AND date_trunc('month', (p.handoff_at ${KYIV})) = mo.m)::int AS handoff_in_month,
       COUNT(*) FILTER (WHERE p.won_at IS NOT NULL
                          AND date_trunc('month', (p.won_at ${KYIV})) = mo.m)::int AS won_in_month,
       ((mo.m + INTERVAL '1 month') <= (now() ${KYIV}) - INTERVAL '90 days') AS mature
     FROM months mo LEFT JOIN pop p ON TRUE
     GROUP BY mo.m ORDER BY mo.m`,
    params
  );
  const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  return r.rows.map((x) => {
    const entered = Number(x.entered);
    const he = Number(x.handoff_eventually), we = Number(x.won_eventually);
    const hm = Number(x.handoff_in_month), wm = Number(x.won_in_month);
    return {
      ym: x.ym, entered,
      handoffEventually: he, handoffCohortPct: pct(he, entered),
      wonEventually: we, wonCohortPct: pct(we, entered),
      handoffInMonth: hm, handoffPeriodPct: pct(hm, entered),
      wonInMonth: wm, wonPeriodPct: pct(wm, entered),
      mature: x.mature,
    };
  });
}

/**
 * `conversion_prodzvin_handoff` + `conversion_prodzvin_won` (рішення 6.4).
 * Холодний Продзвін (8921936/7337048), entry «ВЗЯТО В РОБОТУ» 69693696 →
 * handoff Продзвін-142 (прорахунок отримано) / won FC-142. Реактивація НЕ тут.
 */
export const conversionProdzvinByMonth = (s: MetricScope): Promise<LeadgenConversionRow[]> =>
  leadgenConversionByMonth(s, { entryPipelines: PRODZVIN_PIPELINES, entryStatus: PZ_TAKEN });

/**
 * `conversion_reactivation_handoff` + `conversion_reactivation_won` (рішення 6.5).
 * Реактивація (8921948), entry «Клієнт підігрівається» 69693740 (не мертвий
 * «Дзвінок ВКЯ» 69693736) → handoff 142 «Відправлено у відділ продажів» / won
 * FC-142 (client_key повіз знову). Категорії відмов не фільтруємо.
 */
export const conversionReactivationByMonth = (s: MetricScope): Promise<LeadgenConversionRow[]> =>
  leadgenConversionByMonth(s, { entryPipelines: REACTIVATION_PIPELINES, entryStatus: REACT_WARMING });

// ───────────────────────── ЧЕСНА КОГОРТНА ВОРОНКА (Р1) ─────────────────────────

/**
 * ЧЕСНА когортна воронка продажів (Р1) — виправляє >100%/1600% у старій воронці.
 * Той самий патерн, що conversion_ads: КОГОРТА = угоди, що зайшли в «Взято в
 * роботу» (`funnel_stage='lead_taken'` у Повному циклі 8921932/155304) у бакеті.
 * Трек уперед: рахуємо НАЙГЛИБШУ досягнуту стадію (за подіями, після входу).
 * `reached[стадія]` = скільки з когорти дійшло ДО НЕЇ АБО ГЛИБШЕ → чисельник ⊆
 * знаменник → **завжди ≤100%**, монотонно спадає. **Готівка пропускає «Рахунок»
 * (invoiced)** — але, дійшовши до `paid`, зараховується і в invoiced (reached ≥
 * стадії), тож пропуск не ламає монотонність.
 * «Зайшли посередині» = угоди з подією стадії ≥ quote_requested у бакеті, що
 * НЕ мають події `lead_taken` взагалі → окремий рядок, НЕ в знаменнику.
 * Стадії Повного циклу — канонічний `pipeline_stage_map` (не вигадані id).
 */
export interface FunnelHonestRow {
  bucket: string;               // YYYY-MM (month) або YYYY-MM-DD (week, понеділок)
  cohort: number;               // зайшли в lead_taken у бакеті
  reached: { lead_taken: number; quote_requested: number; approved: number; invoiced: number; paid: number };
  pct: { lead_taken: number; quote_requested: number | null; approved: number | null; invoiced: number | null; paid: number | null };
  midfunnel: number;            // «зайшли посередині» (не через lead_taken)
  mature: boolean;              // когорта дозріла (≥90 днів)
}

export async function funnelCohortHonest(
  s: MetricScope,
  granularity: "month" | "week" = "month"
): Promise<FunnelHonestRow[]> {
  const gran = granularity === "week" ? "week" : "month";
  const params: unknown[] = [FC_PIPELINES];
  const scopeConds: string[] = [];
  if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
  const fromRef = (params.push(s.from ?? null), `$${params.length}`);
  const toRef = (params.push(s.to ?? null), `$${params.length}`);
  const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";
  const inPeriod = (col: string) =>
    `((${fromRef})::date IS NULL OR (${col} ${KYIV})::date >= (${fromRef})::date)
     AND ((${toRef})::date IS NULL OR (${col} ${KYIV})::date <= (${toRef})::date)`;

  const r = await pool.query<{
    bucket: string; cohort: string; r1: string; r2: string; r3: string; r4: string; r5: string; midfunnel: string; mature: boolean;
  }>(
    `WITH ev AS (
       SELECT e.kommo_id, e.changed_at,
         CASE psm.funnel_stage
           WHEN 'lead_taken' THEN 1 WHEN 'quote_requested' THEN 2 WHEN 'approved' THEN 3
           WHEN 'invoiced' THEN 4 WHEN 'paid' THEN 5 END AS rk
         FROM deal_stage_events e
         JOIN pipeline_stage_map psm ON psm.pipeline_id = e.pipeline_id AND psm.status_id = e.status_id
        WHERE e.pipeline_id = ANY($1)
     ),
     coh AS (   -- зайшли в lead_taken у періоді (з урахуванням скоупу менеджера/команди)
       SELECT ev.kommo_id, MIN(ev.changed_at) AS entered_at
         FROM ev
         JOIN deals d ON d.kommo_id = ev.kommo_id
         LEFT JOIN managers m ON m.id = d.manager_id
        WHERE ev.rk = 1 AND ${inPeriod("ev.changed_at")} ${scopeWhere}
        GROUP BY ev.kommo_id
     ),
     depth AS (  -- найглибша стадія, досягнута ПІСЛЯ входу
       SELECT c.kommo_id, c.entered_at, MAX(ev.rk) AS deepest
         FROM coh c JOIN ev ON ev.kommo_id = c.kommo_id AND ev.changed_at >= c.entered_at
        GROUP BY c.kommo_id, c.entered_at
     ),
     mid AS (   -- «зайшли посередині»: подія rk>=2 у періоді, БЕЗ жодного lead_taken
       SELECT ev.kommo_id, MIN(ev.changed_at) AS first_at
         FROM ev
         JOIN deals d ON d.kommo_id = ev.kommo_id
         LEFT JOIN managers m ON m.id = d.manager_id
        WHERE ev.rk >= 2 AND ${inPeriod("ev.changed_at")} ${scopeWhere}
          AND NOT EXISTS (SELECT 1 FROM ev e2 WHERE e2.kommo_id = ev.kommo_id AND e2.rk = 1)
        GROUP BY ev.kommo_id
     ),
     buckets AS (
       SELECT date_trunc('${gran}', (entered_at ${KYIV})) AS b,
              count(*)::int cohort,
              count(*) FILTER (WHERE deepest >= 1)::int r1,
              count(*) FILTER (WHERE deepest >= 2)::int r2,
              count(*) FILTER (WHERE deepest >= 3)::int r3,
              count(*) FILTER (WHERE deepest >= 4)::int r4,
              count(*) FILTER (WHERE deepest >= 5)::int r5
         FROM depth GROUP BY 1
     ),
     midb AS (
       SELECT date_trunc('${gran}', (first_at ${KYIV})) AS b, count(*)::int midfunnel FROM mid GROUP BY 1
     )
     SELECT to_char(COALESCE(bk.b, mb.b), 'YYYY-MM-DD') AS bucket,
            COALESCE(bk.cohort,0) cohort, COALESCE(bk.r1,0) r1, COALESCE(bk.r2,0) r2,
            COALESCE(bk.r3,0) r3, COALESCE(bk.r4,0) r4, COALESCE(bk.r5,0) r5,
            COALESCE(mb.midfunnel,0) midfunnel,
            ((COALESCE(bk.b, mb.b) + INTERVAL '1 ${gran}') <= (now() ${KYIV}) - INTERVAL '90 days') AS mature
       FROM buckets bk FULL OUTER JOIN midb mb ON bk.b = mb.b
      ORDER BY 1`,
    params
  );
  return r.rows.map((x) => {
    const cohort = Number(x.cohort);
    const rc = { lead_taken: Number(x.r1), quote_requested: Number(x.r2), approved: Number(x.r3), invoiced: Number(x.r4), paid: Number(x.r5) };
    const pc = (n: number) => (cohort > 0 ? Math.round((n / cohort) * 1000) / 10 : null);
    return {
      bucket: x.bucket,
      cohort,
      reached: rc,
      pct: { lead_taken: cohort > 0 ? 100 : 0, quote_requested: pc(rc.quote_requested), approved: pc(rc.approved), invoiced: pc(rc.invoiced), paid: pc(rc.paid) },
      midfunnel: Number(x.midfunnel),
      mature: x.mature,
    };
  });
}

// ───────────────────────── ДЕБІТОРКА (знімок, БЕЗ дат) ─────────────────────────

/**
 * Спільний скоуп боргу. 🔴 ЗМІНА ПОВЕДІНКИ (рішення власника 15.07): дебіторка =
 * ПОВНА сума, неатрибутований борг (manager_id NULL) БІЛЬШЕ НЕ ховається. Тому
 * **LEFT JOIN** managers і **БЕЗ** `manager_id IS NOT NULL`. Скоуп по менеджеру/команді
 * природно виключає null-рядки (вони не в жодній команді) → «Без менеджера» видно лише
 * в загальному/адмін-розрізі. Стара логіка (INNER + `IS NOT NULL`) ховала 1.575 млн
 * (гол. ПВК АРСЕНАЛ 1.56 млн) — це знайдений прихований борг, а не помилка core.
 * Тому звіряти core проти ДЖЕРЕЛА (`SUM(receivable_invoices)`), а не проти старої.
 * Джерело `receivables` уже містить і безнал (файл), і готівку (`insertCashReceivables`).
 */
function debtWhere(s: SnapshotScope): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (s.managerId) { params.push(s.managerId); conds.push(`r.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

/** Загальний борг «станом на зараз» = ПОВНИЙ `SUM(receivables.amount)` (безнал +
 *  готівка + неатрибутований). = `SUM(receivable_invoices)`. */
export async function receivablesTotal(s: SnapshotScope): Promise<number> {
  const { where, params } = debtWhere(s);
  const r = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
     FROM receivables r LEFT JOIN managers m ON m.id = r.manager_id
     ${where}`,
    params
  );
  return Number(r.rows[0]?.total ?? 0);
}

export interface ManagerDebt { managerId: number | null; name: string; teamId: number | null; debt: number }

/** Борг по менеджеру (знімок). Неатрибутований борг → окремий рядок «Без менеджера»
 *  (managerId=null) — НЕ губиться (стара логіка відкидала його в JS). */
export async function receivablesByManager(s: SnapshotScope): Promise<ManagerDebt[]> {
  const { where, params } = debtWhere(s);
  const r = await pool.query<{ manager_id: number | null; name: string | null; team_id: number | null; debt: string }>(
    `SELECT m.id AS manager_id, m.name, m.team_id, COALESCE(SUM(r.amount), 0) AS debt
     FROM receivables r LEFT JOIN managers m ON m.id = r.manager_id
     ${where}
     GROUP BY m.id, m.name, m.team_id
     ORDER BY debt DESC`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id,
    name: x.name ?? "Без менеджера",
    teamId: x.team_id,
    debt: Number(x.debt),
  }));
}

export interface ClientDebt {
  managerId: number | null;
  managerName: string;
  clientKey: string | null;
  clientName: string | null;
  amount: number;
  limitDays: number | null;
  overdueDays: number | null;
}

/** Борг по клієнту (знімок). Неатрибутовані клієнти теж показуються (managerName =
 *  «Без менеджера»). Коментар/дедлайн тімліда (`receivable_notes`) — метадані, лишаються
 *  в роуті (це не метрика, а редаговане поле). */
export async function receivablesByClient(s: SnapshotScope): Promise<ClientDebt[]> {
  const { where, params } = debtWhere(s);
  const r = await pool.query<{ manager_id: number | null; manager_name: string | null; client_key: string | null; client_name: string | null; amount: string; limit_days: number | null; overdue_days: number | null }>(
    `SELECT r.manager_id, m.name AS manager_name, r.client_key, r.client_name, r.amount, r.limit_days, r.overdue_days
     FROM receivables r LEFT JOIN managers m ON m.id = r.manager_id
     ${where}
     ORDER BY r.amount DESC`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id, managerName: x.manager_name ?? "Без менеджера", clientKey: x.client_key, clientName: x.client_name,
    amount: Number(x.amount), limitDays: x.limit_days, overdueDays: x.overdue_days,
  }));
}

// ───────────────────────── ЗАСТРЯГЛІ УГОДИ (знімок, БЕЗ дат) ─────────────────────────

const AVTO_STATUSES = [69716300, 98470988, 10937178];

export interface StuckDeal {
  kommoId: number;
  name: string;
  client: string | null;
  manager: string;
  price: number;
  stage: string;
  days: number; // днів від ОСТАННЬОЇ активності (або створення, якщо активності не було)
  activityDays: number | null; // днів без РЕАЛЬНОЇ людської активності; null = ніколи не вели
}

/**
 * Активні угоди повного циклу БЕЗ реальної людської активності понад поріг.
 * Годинник — `COALESCE(last_activity_at, created_at_kommo)` (Salesbot-proof; НЕ `updated_at`).
 * Пороги: грошові стадії (Авто працює / Виставлено рахунок) — `minDays` (деф. 7);
 * рання «Взято в роботу» — `minDays×3` (природно «крутиться»). Вікно створення 180 днів
 * (старіші покинуті = мертві, не «застряглі»). Рання стадія рахується лише якщо угоду
 * ВЖЕ вели (`last_activity_at IS NOT NULL`). Порт `/stuck-deals` 1-в-1 (та сама к-сть/ID).
 */
export async function stuckDeals(s: SnapshotScope, minDays = 7, limit = 50): Promise<StuckDeal[]> {
  const md = Math.max(1, minDays);
  const AVTO = `d.status_id = ANY($2)`;
  const ACT = "COALESCE(d.last_activity_at, d.created_at_kommo)";
  const params: unknown[] = [FC_PIPELINES, AVTO_STATUSES, md, md * 3];
  const conds = [
    "d.pipeline_id = ANY($1)",
    "psm.funnel_stage <> 'paid'",
    `now() - ${ACT} >= (CASE WHEN (${AVTO} OR psm.funnel_stage = 'invoiced') THEN $3 ELSE $4 END || ' days')::interval`,
    "d.created_at_kommo >= now() - interval '180 days'",
    `(${AVTO} OR psm.funnel_stage = 'invoiced' OR d.last_activity_at IS NOT NULL)`,
  ];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  params.push(limit);
  const r = await pool.query<{ kommo_id: string; name: string; client: string | null; manager: string; price: string; stage: string; days: string; activity_days: string | null }>(
    `SELECT d.kommo_id, d.name, d.client_name AS client, m.name AS manager, d.price,
            CASE WHEN ${AVTO} THEN 'Авто працює'
                 WHEN psm.funnel_stage IN ('lead_taken','quote_requested','approved') THEN 'Взято в роботу'
                 WHEN psm.funnel_stage = 'invoiced' THEN 'Виставлено рахунок' END AS stage,
            EXTRACT(DAY FROM now() - ${ACT})::int AS days,
            EXTRACT(DAY FROM now() - d.last_activity_at)::int AS activity_days
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${conds.join(" AND ")}
     ORDER BY days DESC
     LIMIT $${params.length}`,
    params
  );
  return r.rows.map((x) => ({
    kommoId: Number(x.kommo_id), name: x.name, client: x.client, manager: x.manager, price: Number(x.price),
    stage: x.stage, days: Number(x.days), activityDays: x.activity_days == null ? null : Number(x.activity_days),
  }));
}

// ───────────────────────── ЧАС ОПРАЦЮВАННЯ (період по created_at) ─────────────────────────

const QUALIFICATION_PIPELINES = [8921928, 7336928];

export interface ResponseBucket {
  key: string;
  count: number;
  avgMin: number | null;
  medianMin: number | null;
  immediatePct: number; // % ≤2 хв
}
export interface ResponseTimeResult {
  buckets: ResponseBucket[]; // work / evening / night / weekend
  totalCount: number;
  overallMedianMin: number | null;
  overallAvgMin: number | null;
  taken2minPct: number;
  taken15minPct: number;
  neglectedOver24h: number;
}

/**
 * «Час опрацювання ліда» = від СТВОРЕННЯ ліда Кваліфікації до ПЕРШОГО реального
 * людського контакту (`first_activity_at`, created_by<>0). Розбито по київському часу
 * надходження: work(9–18)/evening(18–21)/night(21–9)/weekend. Порт `/response-time` як є
 * (означення не чіпаємо). Період — по `created_at` (дефолт: поточний місяць у роуті).
 */
export async function responseTime(s: MetricScope): Promise<ResponseTimeResult> {
  const KY = "AT TIME ZONE 'Europe/Kyiv'";
  const params: unknown[] = [QUALIFICATION_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.first_activity_at IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(d.created_at_kommo ${KY})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.created_at_kommo ${KY})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const RESP_MIN = `GREATEST(0, EXTRACT(EPOCH FROM (q.first_activity_at - q.created_at_kommo)) / 60.0)`;
  const bucketCase = `CASE WHEN dow IN (0,6) THEN 'weekend' WHEN hr >= 9 AND hr < 18 THEN 'work' WHEN hr >= 18 AND hr < 21 THEN 'evening' ELSE 'night' END`;
  const cte = `
     WITH quals AS (
       SELECT d.kommo_id, d.created_at_kommo, d.first_activity_at
       FROM deals d JOIN managers m ON m.id = d.manager_id
       WHERE ${conds.join(" AND ")}
     ),
     resp AS (
       SELECT ${RESP_MIN} AS minutes,
              EXTRACT(DOW  FROM (q.created_at_kommo ${KY})) AS dow,
              EXTRACT(HOUR FROM (q.created_at_kommo ${KY})) AS hr
       FROM quals q
     )`;
  const r = await pool.query<{ bucket: string; n: string; avg_min: string | null; median_min: string | null; le2: string }>(
    `${cte}, bucketed AS (SELECT ${bucketCase} AS bucket, minutes FROM resp)
     SELECT bucket, COUNT(*) AS n, AVG(LEAST(minutes, 1440)) AS avg_min,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY minutes) AS median_min,
            COUNT(*) FILTER (WHERE minutes <= 2) AS le2
       FROM bucketed GROUP BY bucket`,
    params
  );
  const ov = await pool.query<{ n: string; avg_min: string | null; median_min: string | null; le2: string; le15: string; gt1440: string }>(
    `${cte}
     SELECT COUNT(*) AS n, AVG(LEAST(minutes, 1440)) AS avg_min,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY minutes) AS median_min,
            COUNT(*) FILTER (WHERE minutes <= 2) AS le2,
            COUNT(*) FILTER (WHERE minutes <= 15) AS le15,
            COUNT(*) FILTER (WHERE minutes > 1440) AS gt1440
       FROM resp`,
    params
  );
  const map = new Map(r.rows.map((x) => [x.bucket, x]));
  const buckets: ResponseBucket[] = ["work", "evening", "night", "weekend"].map((k) => {
    const x = map.get(k);
    const n = x ? Number(x.n) : 0;
    return {
      key: k,
      count: n,
      avgMin: x?.avg_min != null ? Math.round(Number(x.avg_min)) : null,
      medianMin: x?.median_min != null ? Math.round(Number(x.median_min)) : null,
      immediatePct: n > 0 ? Math.round((Number(x!.le2) / n) * 100) : 0,
    };
  });
  const o = ov.rows[0];
  const totalN = o ? Number(o.n) : 0;
  return {
    buckets, totalCount: totalN,
    overallMedianMin: o?.median_min != null ? Math.round(Number(o.median_min)) : null,
    overallAvgMin: o?.avg_min != null ? Math.round(Number(o.avg_min)) : null,
    taken2minPct: totalN > 0 ? Math.round((Number(o!.le2) / totalN) * 100) : 0,
    taken15minPct: totalN > 0 ? Math.round((Number(o!.le15) / totalN) * 100) : 0,
    neglectedOver24h: o ? Number(o.gt1440) : 0,
  };
}

// ───────────────────────── СУМА ОЧІКУВАННЯ ПО ЗАПЛАНОВАНІЙ ДАТІ (Р2) ─────────────────────────

/**
 * Р2 — «Сума очікування» для звіту. ЗНІМОК поточної грошової зони (виставлено
 * рахунок → очікуємо оплату, ще не оплачено), сума `price` (бюджет — рішення
 * власника: безнал і готівка однаково, НЕ приход), розбивка по `planned_payment_at`
 * (Kommo 2097273, «Запланована дата оплати»):
 *   • thisMonth — планова дата в поточному місяці й НЕ в минулому;
 *   • nextMonth — планова дата в наступному місяці;
 *   • overdue — планова дата В МИНУЛОМУ, гроші ще не прийшли. ⚠️ У ЗВІТІ (UI) НЕ
 *     показується: прострочене/борг — територія ДЕБІТОРКИ (окреме джерело, банки/1С),
 *     не дублювати тут, щоб не було двох правд про борг (рішення власника Р4b).
 *     Бакет лишається в core ІНЕРТНИМ (може знадобитись для звірки), але з очікування
 *     виключений — «очікування надходжень» = лише thisMonth + nextMonth;
 *   • later — далі за наступний місяць; noDate — у зоні, але дата не заповнена.
 * Знімок → SnapshotScope (дати заборонені на рівні типу).
 */
const EXPECT_ZONE = [100274340, 69716304, 69716312, 42639144, 42639147, 25044997, 62940068];

export interface ExpectedBucket { deals: number; sum: number }
export interface ExpectedPaymentsByPlanned {
  thisMonth: ExpectedBucket;
  nextMonth: ExpectedBucket;
  overdue: ExpectedBucket;
  later: ExpectedBucket;
  noDate: ExpectedBucket;
}

export async function expectedPaymentsByPlanned(s: SnapshotScope): Promise<ExpectedPaymentsByPlanned> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)"];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  // Порівнюємо по-київськи; overdue має пріоритет (дата в минулому → overdue,
  // навіть якщо місяць поточний). Далі серед майбутніх — cur/next/later по місяцю.
  const P = `(d.planned_payment_at ${KYIV})::date`;
  const today = `(now() ${KYIV})::date`;
  const curYm = `to_char((now() ${KYIV}), 'YYYY-MM')`;
  const nextYm = `to_char((now() ${KYIV}) + INTERVAL '1 month', 'YYYY-MM')`;
  const pYm = `to_char((d.planned_payment_at ${KYIV}), 'YYYY-MM')`;
  const r = await pool.query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} < ${today})::int overdue_n,
       COALESCE(sum(d.price) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} < ${today}),0) overdue_s,
       count(*) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} >= ${today} AND ${pYm} = ${curYm})::int this_n,
       COALESCE(sum(d.price) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} >= ${today} AND ${pYm} = ${curYm}),0) this_s,
       count(*) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} >= ${today} AND ${pYm} = ${nextYm})::int next_n,
       COALESCE(sum(d.price) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} >= ${today} AND ${pYm} = ${nextYm}),0) next_s,
       count(*) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} >= ${today} AND ${pYm} > ${nextYm})::int later_n,
       COALESCE(sum(d.price) FILTER (WHERE d.planned_payment_at IS NOT NULL AND ${P} >= ${today} AND ${pYm} > ${nextYm}),0) later_s,
       count(*) FILTER (WHERE d.planned_payment_at IS NULL)::int nodate_n,
       COALESCE(sum(d.price) FILTER (WHERE d.planned_payment_at IS NULL),0) nodate_s
     FROM deals d LEFT JOIN managers m ON m.id = d.manager_id ${activeJoin}
     WHERE ${conds.join(" AND ")}`,
    params
  );
  const x = r.rows[0] ?? {};
  const b = (n: string, sum: string): ExpectedBucket => ({ deals: Number(x[n] ?? 0), sum: Number(x[sum] ?? 0) });
  return {
    thisMonth: b("this_n", "this_s"),
    nextMonth: b("next_n", "next_s"),
    overdue: b("overdue_n", "overdue_s"),
    later: b("later_n", "later_s"),
    noDate: b("nodate_n", "nodate_s"),
  };
}

// ───────────────────────── ЦІЛЬОВІ КОНВЕРСІЇ (Р4a) ─────────────────────────

/**
 * Р4a — цільові конверсії (рішення власника; задокументовано в
 * CONVERSION_RULES.md §8). Дефолти в коді; per-manager override — пізніше.
 *   ads          — РНК, конверсія реклами: 15%
 *   leadgen      — лідген (Продзвін/Реактивація won): 7-8% → ціль 7.5%
 *   managerLeadgenWon — менеджер: лід від лідогена → успіх: 10%
 */
export const CONVERSION_TARGETS = { ads: 15, leadgen: 7.5, managerLeadgenWon: 10 } as const;
