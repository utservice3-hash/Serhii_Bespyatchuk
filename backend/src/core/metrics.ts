import { pool } from "../db/pool.js";
import { revenueProjection, newBusinessDobir, type MoneyScope } from "./money.js";
import { monthEndOf } from "./dates.js";

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

// Не-комерційні команди: 11 = лідогенерація (Ковтонюк), 12 = фінанси. Джерело правди
// (== KVP_LEADGEN_TEAM_IDS ∪ KVP_FINANCE_TEAM_IDS у routes/dashboard.ts).
export const NON_COMMERCIAL_TEAM_IDS = [11, 12];
/**
 * SQL-предикат «КОМЕРЦІЙНИЙ менеджер» (рішення власника 24.07, Опція 2 — строго):
 * має команду І команда не лідген/фінанси. Ловить усі три класи не-комерц: team NULL
 * (Левентова/Операційний директор/Денисюк), team 11 (лідген), team 12 (фінанси).
 * ЄДИНЕ джерело для обох поверхонь (/report roster + stuckDealsGrouped) — не дублювати SQL.
 * `alias` — аліас таблиці managers у запиті (дефолт "m").
 */
export const commercialManagerSql = (alias = "m") =>
  `(${alias}.team_id IS NOT NULL AND NOT (${alias}.team_id = ANY(ARRAY[${NON_COMMERCIAL_TEAM_IDS.join(", ")}]::int[])))`;

// Команди РНК (рекламний напрям, тімліди Безпамʼятний/Михальчевська). Джерело правди
// (== RNK_TEAM_IDS у routes/dashboard.ts, який тепер імпортує звідси — не дублювати число).
export const RNK_TEAM_IDS = [13, 15];
/**
 * SQL-предикат «команда типу РНК» (рекламний напрям). Використовується у `stuckDealsGrouped`:
 * РНК — усі застряглі; РПК/Самостійний (не-РНК) — лише лідген-угоди. `alias` — аліас managers.
 */
export const rnkTeamSql = (alias = "m") =>
  `(${alias}.team_id = ANY(ARRAY[${RNK_TEAM_IDS.join(", ")}]::int[]))`;

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
  bucket: string; // YYYY-MM-DD (день / понеділок тижня / 1-е місяця)
  deals: number;
  channel?: "ad" | "leadgen" | "other"; // лише коли byChannel=true (BE-1)
}

// Спільний вираз бакета за подією стадії (день / тиждень-Пн / місяць-1).
const eventBucket = (granularity: "day" | "week" | "month") =>
  granularity === "day"
    ? `(dse.changed_at ${KYIV})::date`
    : `date_trunc('${granularity === "month" ? "month" : "week"}', (dse.changed_at ${KYIV}))::date`;

/**
 * `/funnel-weekly` FACT — пропускна здатність: скільки угод УВІЙШЛО в кожну стадію
 * у кожному тижні/дні/місяці (`deal_stage_events`, анкер `changed_at`, DISTINCT по угоді).
 * На відміну від funnelCohort (когорта створення), це потік входів у стадію.
 *
 * BE-1: `byChannel=true` → додає розріз `deals.lead_channel` ('ad'/'leadgen'/'other',
 * last-touch reclassifyAdChannel). Для «ліди взято» = фільтр stage='lead_taken'. За
 * замовчуванням OFF → форма й числа наявних викликів (/funnel-weekly матриця) незмінні.
 * Σ каналів per (stage,bucket) = байт-у-байт значення byChannel=false (угода має 1 канал).
 */
export async function funnelWeekly(s: MetricScope, granularity: "day" | "week" | "month" = "week", byChannel = false): Promise<FunnelWeekRow[]> {
  const bucket = eventBucket(granularity);
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "psm.funnel_stage IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(dse.changed_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(dse.changed_at ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const chanSel = byChannel ? `, COALESCE(d.lead_channel, 'other') AS channel` : "";
  const chanGrp = byChannel ? `, COALESCE(d.lead_channel, 'other')` : "";
  const r = await pool.query<{ stage: string; bucket: string; deals: string; channel?: string }>(
    `SELECT psm.funnel_stage AS stage, to_char(${bucket}, 'YYYY-MM-DD') AS bucket,
            COUNT(DISTINCT dse.kommo_id) AS deals${chanSel}
     FROM deal_stage_events dse
     JOIN deals d ON d.kommo_id = dse.kommo_id
     JOIN managers m ON m.id = d.manager_id ${activeJoin}
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
     WHERE ${conds.join(" AND ")}
     GROUP BY psm.funnel_stage, bucket${chanGrp}`,
    params
  );
  return r.rows.map((x) => ({
    stage: x.stage, bucket: x.bucket, deals: Number(x.deals),
    ...(byChannel ? { channel: (x.channel as "ad" | "leadgen" | "other") ?? "other" } : {}),
  }));
}

export interface FunnelWeekMgrRow {
  managerId: number;
  name: string;
  stage: string;
  bucket: string; // YYYY-MM-DD (день / понеділок тижня / 1-е місяця, київський)
  deals: number;
  channel?: "ad" | "leadgen" | "other"; // лише коли byChannel=true (BE-1)
}

/**
 * `/funnel-weekly` FACT по МЕНЕДЖЕРУ — той самий потік входів у стадію, що й
 * `funnelWeekly`, але з розрізом по менеджеру (роут малює матрицю менеджер×тиждень).
 * 🔴 Другий виправданий per-manager аґреґат (Fork 2 виняток): funnel-weekly показує
 * рядок на кожного менеджера, чого overall `funnelWeekly` не дає. Числа FACT ІДЕНТИЧНІ
 * старому інлайн-запиту роуту (той самий SQL, лише винесений) — форма (тижні, план,
 * гроші) лишається в роуті. Лише активні менеджери.
 */
export async function funnelWeeklyByManager(s: MetricScope, granularity: "day" | "week" | "month" = "week", byChannel = false): Promise<FunnelWeekMgrRow[]> {
  const bucket = eventBucket(granularity);
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "psm.funnel_stage IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(dse.changed_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(dse.changed_at ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const chanSel = byChannel ? `, COALESCE(d.lead_channel, 'other') AS channel` : "";
  const chanGrp = byChannel ? `, COALESCE(d.lead_channel, 'other')` : "";
  const r = await pool.query<{ manager_id: number; name: string; stage: string; bucket: string; deals: string; channel?: string }>(
    `SELECT d.manager_id, m.name, psm.funnel_stage AS stage, to_char(${bucket}, 'YYYY-MM-DD') AS bucket,
            COUNT(DISTINCT dse.kommo_id) AS deals${chanSel}
     FROM deal_stage_events dse
     JOIN deals d ON d.kommo_id = dse.kommo_id
     JOIN managers m ON m.id = d.manager_id ${activeJoin}
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
     WHERE ${conds.join(" AND ")}
     GROUP BY d.manager_id, m.name, psm.funnel_stage, bucket${chanGrp}`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id, name: x.name, stage: x.stage, bucket: x.bucket, deals: Number(x.deals),
    ...(byChannel ? { channel: (x.channel as "ad" | "leadgen" | "other") ?? "other" } : {}),
  }));
}

export interface LeadsTakenRow { bucket: string; deals: number; channel?: "ad" | "leadgen" | "other" }

/**
 * «Взято лідів» SINGLE-ANCHOR — кожна угода РАЗ, за ПЕРШИМ входом у «Взято в роботу»
 * (`funnel_stage='lead_taken'`) У МЕЖАХ періоду (MIN(changed_at) серед входів у вікні).
 * На відміну від `funnelWeekly` (потік входів, DISTINCT-per-bucket → реоупени дублюються),
 * тут один анкер/угода → **день сходиться в тиждень і місяць** (Σ бакетів = унікальні угоди).
 * `byChannel=true` → розріз `deals.lead_channel` (ad/leadgen/other, last-touch). Scope-aware.
 */
export async function leadsTakenByBucket(s: MetricScope, granularity: "day" | "week" | "month", byChannel = false): Promise<LeadsTakenRow[]> {
  const gran = granularity === "day" ? "day" : granularity === "month" ? "month" : "week";
  const bucket = granularity === "day" ? `(f.anchor_at ${KYIV})::date` : `date_trunc('${gran}', (f.anchor_at ${KYIV}))::date`;
  const params: unknown[] = [FC_PIPELINES];
  const winConds = ["d.pipeline_id = ANY($1)", "psm.funnel_stage = 'lead_taken'"];
  if (s.from) { params.push(s.from); winConds.push(`(dse.changed_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); winConds.push(`(dse.changed_at ${KYIV})::date <= $${params.length}`); }
  const scopeConds: string[] = [];
  if (s.managerId) { params.push(s.managerId); scopeConds.push(`d2.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const chanSel = byChannel ? `, COALESCE(d2.lead_channel, 'other') AS channel` : "";
  const chanGrp = byChannel ? `, COALESCE(d2.lead_channel, 'other')` : "";
  const scopeWhere = scopeConds.length ? "WHERE " + scopeConds.join(" AND ") : "";
  const r = await pool.query<{ bucket: string; deals: string; channel?: string }>(
    `WITH first_lt AS (
       SELECT dse.kommo_id, MIN(dse.changed_at) AS anchor_at
         FROM deal_stage_events dse
         JOIN deals d ON d.kommo_id = dse.kommo_id
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
        WHERE ${winConds.join(" AND ")}
        GROUP BY dse.kommo_id
     )
     SELECT to_char(${bucket}, 'YYYY-MM-DD') AS bucket, COUNT(*) AS deals${chanSel}
       FROM first_lt f
       JOIN deals d2 ON d2.kommo_id = f.kommo_id
       LEFT JOIN managers m ON m.id = d2.manager_id ${activeJoin}
       ${scopeWhere}
       GROUP BY bucket${chanGrp}
       ORDER BY bucket`,
    params
  );
  return r.rows.map((x) => ({
    bucket: x.bucket, deals: Number(x.deals),
    ...(byChannel ? { channel: (x.channel as "ad" | "leadgen" | "other") ?? "other" } : {}),
  }));
}

export interface CreatedBucketRow { bucket: string; deals: number }

export interface CreatedSplitRow {
  managerId: number;
  name: string;
  teamId: number | null;
  created: number;
  newCount: number;
  repeatCount: number;
  undefCount: number;
}
export interface CreatedSplitBucketRow { bucket: string; created: number; newCount: number; repeatCount: number; undefCount: number }

// Дженерик/порожні client_key, що НЕ беруть участі в матчингу історії клієнта
// (колізійні: «названиенеуказано» = 1.3к угод різних клієнтів; порожній ключ).
// Живе тут, а не в коді СИНКУ, бо це правило ЗВІРКИ, не нормалізації ключа.
const GENERIC_CLIENT_KEYS = ["названиенеуказано", ""];

// ЄДИНЕ джерело правила класифікації (B→C→A) — щоб by-manager і by-bucket не
// розходились. Читає lead_channel / vkey / has_prior / sales_channel з CTE `classed`.
const CREATED_KLASS_CASE = `
  CASE
    WHEN lead_channel IN ('ad','leadgen') THEN 'new'
    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'
    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND NOT has_prior THEN 'new'
    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'
    WHEN sales_channel = 'Нові клієнти' THEN 'new'
    ELSE 'undef'
  END`;

// РОЗБИВКА ЗА ДЖЕРЕЛОМ (реклама / лідоген / постійний / невизн) — та сама база сигналів,
// що CREATED_KLASS_CASE, але ЧОТИРИ категорії за ПОХОДЖЕННЯМ угоди (а не new/repeat).
// Пріоритет каналу-першим = правило реатрибуції «останній дотик» («реактивація б'є мітки»):
//   ad → реклама · leadgen → лідоген · other+історія(has_prior) АБО декларація «Постійні» →
//   постійний · решта (other без історії, невідома декларація) → невизн. Σ 4 категорій = total.
const SOURCE_KLASS_CASE = `
  CASE
    WHEN lead_channel = 'ad' THEN 'ad'
    WHEN lead_channel = 'leadgen' THEN 'leadgen'
    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'
    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'
    ELSE 'undef'
  END`;

/** Спільний CTE-конвеєр класифікації (base→classed→final з `klass`). Мутує `params`
 * (додає $1 FC, $2 дженерик-ключі + scope). Опції:
 *   • `windowCol` — колонка АНКЕРА вікна періоду (дефолт `d.created_at_kommo`; для
 *     відправлених авто — `d.load_at`). `has_prior` ЗАВЖДИ рахується проти
 *     `created_at_kommo` (історія клієнта на момент СТВОРЕННЯ угоди — інваріант джерела).
 *   • `klassCase` — вираз класу (`CREATED_KLASS_CASE` / `SOURCE_KLASS_CASE`).
 *   • `bucketExpr` — необов'язковий бакет (день/тиждень/місяць за `windowCol`); без нього
 *     final несе лише manager_id.
 *   • `carryPrice` — тягнути `d.price` у final (для суми ₴ по відправлених авто; signed).
 * Повертає ТІЛО WITH (без «WITH»). */
function classifyCte(
  s: MetricScope,
  params: unknown[],
  opts: { windowCol?: string; klassCase: string; bucketExpr?: string; carryPrice?: boolean; carryVkey?: boolean; channel?: "leadgen" | "ad" | null }
): string {
  const windowCol = opts.windowCol ?? "d.created_at_kommo";
  params.push(FC_PIPELINES, GENERIC_CLIENT_KEYS);
  const conds = ["d.pipeline_id = ANY($1)", `${windowCol} IS NOT NULL`];
  if (opts.channel) { params.push(opts.channel); conds.push(`d.lead_channel = $${params.length}`); }
  if (s.from) { params.push(s.from); conds.push(`(${windowCol} ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(${windowCol} ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const bcol = opts.bucketExpr ? `, ${opts.bucketExpr} AS bucket` : "";
  const bcarry = opts.bucketExpr ? ", bucket" : "";
  const pcol = opts.carryPrice ? ", d.price" : "";
  const pcarry = opts.carryPrice ? ", price" : "";
  const vcarry = opts.carryVkey ? ", vkey" : ""; // vkey у final для COUNT(DISTINCT client) — repeatClientsByBucket
  return `base AS (
       SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.sales_channel, d.lead_channel${bcol}${pcol},
              CASE WHEN d.client_key IS NULL OR d.client_key = ANY($2) THEN NULL ELSE d.client_key END AS vkey
         FROM deals d LEFT JOIN managers m ON m.id = d.manager_id ${activeJoin}
        WHERE ${conds.join(" AND ")}
     ),
     classed AS (
       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey${bcarry}${pcarry},
              (b.vkey IS NOT NULL AND EXISTS (
                 SELECT 1 FROM deals p
                  WHERE p.client_key = b.vkey AND p.status_id = 142
                    AND p.closed_at_kommo < b.created_at_kommo AND p.kommo_id <> b.kommo_id
              )) AS has_prior
         FROM base b
     ),
     final AS (
       SELECT manager_id${bcarry}${pcarry}${vcarry}, ${opts.klassCase} AS klass FROM classed
     )`;
}

/** Розкол СТВОРЕНИХ угод (new/repeat/undef) — анкер `created_at_kommo`. Тонка обгортка
 * над `classifyCte` (поведінка НЕ змінилась: той самий порядок params, той самий klass). */
function createdSplitCte(s: MetricScope, params: unknown[], bucketExpr?: string): string {
  return classifyCte(s, params, { klassCase: CREATED_KLASS_CASE, bucketExpr });
}

/**
 * РОЗКОЛ СТВОРЕНИХ угод новий/постійний — звірка 3 сигналів (об'єктивне перебиває
 * декларацію). Query-time, похідне з `deals`, БЕЗ персисту/міграції. Порядок сигналів:
 *   B = `lead_channel`: ad|leadgen → Новий (клієнт із реклами/лідогену — не «постійний»).
 *   C = історія клієнта: ≥1 ІНША виграна (142) угода того ж `client_key`, закрита
 *       (`closed_at`) ДО створення поточної; матч по `client_key` без дженерик/порожніх
 *       ключів. B=other: C≥1 → Постійний · C=0 → Новий.
 *   A = `sales_channel` (декларація) — ФОЛБЕК, коли B=other і придатного ключа немає:
 *       «Постійні клієнти» → Постійний · «Нові клієнти» → Новий · решта → Невизначено.
 * Поріг «постійний = ≥1 попередня виграна поїздка» (бізнес: 2-ге замовлення напряму
 * менеджеру = показник повернення). 🔴 Гроші НЕ рахуються — лише лічильники угод.
 * Σ(new+repeat+undef)=created; Σ менеджерів = команда = відділ (партиція за klass).
 */
export async function createdSplitByManager(s: MetricScope): Promise<CreatedSplitRow[]> {
  const params: unknown[] = [];
  const cte = createdSplitCte(s, params);
  const r = await pool.query<{ manager_id: number; name: string; team_id: number | null; created: string; new_count: string; repeat_count: string; undef_count: string }>(
    `WITH ${cte}
     SELECT m.id AS manager_id, m.name, m.team_id,
            COUNT(*) AS created,
            COUNT(*) FILTER (WHERE klass = 'new') AS new_count,
            COUNT(*) FILTER (WHERE klass = 'repeat') AS repeat_count,
            COUNT(*) FILTER (WHERE klass = 'undef') AS undef_count
       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active
      GROUP BY m.id, m.name, m.team_id
      ORDER BY created DESC`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id, name: x.name, teamId: x.team_id,
    created: Number(x.created), newCount: Number(x.new_count), repeatCount: Number(x.repeat_count), undefCount: Number(x.undef_count),
  }));
}

/**
 * Той самий розкол (нові/постійні/невизн), але по БАКЕТУ (день/тиждень/місяць за
 * `created_at`, той самий анкер і грануляція, що `createdByBucket`) — для тижневого/
 * денного дрилу менеджера. Класифікація СПІЛЬНА (`createdSplitCte` + `CREATED_KLASS_CASE`),
 * тож Σ бакетів = createdSplitByManager того ж скоупу (день=тиждень=місяць інваріант).
 */
export async function createdSplitByBucket(s: MetricScope, granularity: "day" | "week" | "month"): Promise<CreatedSplitBucketRow[]> {
  const col = `(d.created_at_kommo ${KYIV})`;
  const bucketExpr = granularity === "day"
    ? `to_char(${col}::date, 'YYYY-MM-DD')`
    : `to_char(date_trunc('${granularity === "month" ? "month" : "week"}', ${col})::date, 'YYYY-MM-DD')`;
  const params: unknown[] = [];
  const cte = createdSplitCte(s, params, bucketExpr);
  const r = await pool.query<{ bucket: string; created: string; new_count: string; repeat_count: string; undef_count: string }>(
    `WITH ${cte}
     SELECT bucket,
            COUNT(*) AS created,
            COUNT(*) FILTER (WHERE klass = 'new') AS new_count,
            COUNT(*) FILTER (WHERE klass = 'repeat') AS repeat_count,
            COUNT(*) FILTER (WHERE klass = 'undef') AS undef_count
       FROM final
      GROUP BY bucket ORDER BY bucket`,
    params
  );
  return r.rows.map((x) => ({
    bucket: x.bucket, created: Number(x.created), newCount: Number(x.new_count), repeatCount: Number(x.repeat_count), undefCount: Number(x.undef_count),
  }));
}

// ───────────── «ПЛАНИ» — клієнт-спліт нові/постійні/лідоген (won cohort) ─────────────

/**
 * Класифікатор сегмента для «Плани». 🔴 ІДЕНТИЧНИЙ `CREATED_KLASS_CASE` (тому, що ПОКАЗУЄ
 * Звіт: трисигнальна `has_prior` — попередній won 142 по closed_at + `sales_channel` +
 * `lead_channel`), лише `leadgen` ВІДОКРЕМЛЕНО зі спільного 'new' у власний бакет. Тобто
 * якщо злити 'leadgen'→'new', вийде РІВНО `CREATED_KLASS_CASE`. Наслідок (прайм-директива
 * «та сама цифра = те саме»): **repeat(Плани) ≡ repeat(Звіт)**, **leadgen+new(Плани) ≡
 * new(Звіт)**, undef≡undef — 1:1. Гілки в ТОМУ Ж порядку (ad→new ПЕРЕД sales_channel-
 * фолбеком), інакше ad-угода з old-міткою «Постійні» помилково впала б у repeat.
 * ⚠️ НЕ `SEGMENT_CASE` (glossary §9): він розходиться зі Звітом (repeat по prior-PAID/
 * created_at; ad-з-історією→repeat). Рішення власника — тримати консистентність зі Звітом.
 */
const PLAN_SEGMENT_KLASS_CASE = `
  CASE
    WHEN lead_channel = 'leadgen' THEN 'leadgen'
    WHEN lead_channel = 'ad' THEN 'new'
    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND has_prior THEN 'repeat'
    WHEN lead_channel = 'other' AND vkey IS NOT NULL AND NOT has_prior THEN 'new'
    WHEN sales_channel = 'Постійні клієнти' THEN 'repeat'
    WHEN sales_channel = 'Нові клієнти' THEN 'new'
    ELSE 'undef'
  END`;

export interface ClientSplitRow {
  managerId: number; name: string; teamId: number | null;
  newCount: number; newRevenue: number;
  repeatCount: number; repeatRevenue: number;
  leadgenCount: number; leadgenRevenue: number;
  undefCount: number; undefRevenue: number;
  total: number; totalRevenue: number;
}

// WON-когорта = ТОЧНО money.sourceSql("success"): ЗАРАЗ 142, анкер closed_at, signed price,
// FC-пайплайни, active-only. Тримати синхронно з money — від цього залежить Σ-інваріант
// (спліт == successByManagerMonth[міс]). `has_prior`/`vkey` — як у classifyCte.
function wonSplitCte(): string {
  return `base AS (
       SELECT dd.kommo_id, dd.manager_id, dd.created_at_kommo, dd.closed_at_kommo, dd.sales_channel,
              dd.lead_channel, dd.price, dd.client_key, dd.client_name,
              CASE WHEN dd.client_key IS NULL OR dd.client_key = ANY($2) THEN NULL ELSE dd.client_key END AS vkey
         FROM deals dd JOIN managers m ON m.id = dd.manager_id AND m.is_active
        WHERE __CONDS__
     ),
     classed AS (
       SELECT b.manager_id, b.sales_channel, b.lead_channel, b.vkey, b.price,
              b.client_key, b.client_name, b.closed_at_kommo,
              (b.vkey IS NOT NULL AND EXISTS (
                 SELECT 1 FROM deals p
                  WHERE p.client_key = b.vkey AND p.status_id = 142
                    AND p.closed_at_kommo < b.created_at_kommo AND p.kommo_id <> b.kommo_id
              )) AS has_prior
         FROM base b
     )`;
}
/** Спільний скоуп won-когорти (params вже мають $1=FC, $2=generic). Повертає SQL-умови. */
function wonScopeConds(s: MetricScope, params: unknown[]): string {
  const conds = ["dd.status_id = 142", "dd.pipeline_id = ANY($1)", "dd.closed_at_kommo IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(dd.closed_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(dd.closed_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`dd.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  return conds.join(" AND ");
}

/**
 * КЛІЄНТ-СПЛІТ для «Плани» — угоди, УСПІШНО РЕАЛІЗОВАНІ (won 142, closed_at) у періоді,
 * розкладені per-manager по джерелу: нові / постійні / лідоген / невизн (count + signed
 * sum). Класифікація — `PLAN_SEGMENT_KLASS_CASE` (≡ Звіт). Анкер closed_at → Σ(усіх бакетів)
 * = `money.successByManagerMonth` того ж місяця/скоупу (гейт Фази 3). undef ≈ мінімум.
 */
export async function clientSplitForPlan(s: MetricScope): Promise<ClientSplitRow[]> {
  const params: unknown[] = [FC_PIPELINES, GENERIC_CLIENT_KEYS];
  const conds = wonScopeConds(s, params);
  const cte = wonSplitCte().replace("__CONDS__", conds);
  const r = await pool.query<{ manager_id: number; name: string; team_id: number | null;
    new_c: string; new_r: string; repeat_c: string; repeat_r: string; leadgen_c: string; leadgen_r: string;
    undef_c: string; undef_r: string; total: string; total_r: string }>(
    `WITH ${cte},
     final AS (SELECT manager_id, price, ${PLAN_SEGMENT_KLASS_CASE} AS klass FROM classed)
     SELECT m.id AS manager_id, m.name, m.team_id,
            COUNT(*) FILTER (WHERE klass='new')     AS new_c,     COALESCE(SUM(price) FILTER (WHERE klass='new'),0)     AS new_r,
            COUNT(*) FILTER (WHERE klass='repeat')  AS repeat_c,  COALESCE(SUM(price) FILTER (WHERE klass='repeat'),0)  AS repeat_r,
            COUNT(*) FILTER (WHERE klass='leadgen') AS leadgen_c, COALESCE(SUM(price) FILTER (WHERE klass='leadgen'),0) AS leadgen_r,
            COUNT(*) FILTER (WHERE klass='undef')   AS undef_c,   COALESCE(SUM(price) FILTER (WHERE klass='undef'),0)   AS undef_r,
            COUNT(*) AS total, COALESCE(SUM(price),0) AS total_r
       FROM final f JOIN managers m ON m.id = f.manager_id
      GROUP BY m.id, m.name, m.team_id
      ORDER BY total_r DESC`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id, name: x.name, teamId: x.team_id,
    newCount: Number(x.new_c), newRevenue: Number(x.new_r),
    repeatCount: Number(x.repeat_c), repeatRevenue: Number(x.repeat_r),
    leadgenCount: Number(x.leadgen_c), leadgenRevenue: Number(x.leadgen_r),
    undefCount: Number(x.undef_c), undefRevenue: Number(x.undef_r),
    total: Number(x.total), totalRevenue: Number(x.total_r),
  }));
}

export interface RepeatClientRow { clientKey: string; name: string; revenue: number; orders: number; deltaPct: number | null }
export interface RepeatClientsBreakdown {
  clients: RepeatClientRow[];
  rest: { count: number; revenue: number };
  totalRevenue: number; totalClients: number;
}

/**
 * Розклад ПОСТІЙНИХ (repeat-бакет `clientSplitForPlan`) ПО КЛІЄНТАХ для одного менеджера/
 * місяця: назва, signed-сума, к-сть замовлень, динаміка ±% суми до ПОПЕРЕДНЬОГО місяця.
 * Ті самі won-угоди й та сама класифікація (klass='repeat') → Σ(clients+rest) =
 * `clientSplitForPlan.repeatRevenue` цього менеджера (гейт Фази 3). Top-N за сумою +
 * агрегат «ще M клієнтів». Δ% = (цей − минулий)/минулий по won-сумі клієнта в цього
 * менеджера (минулий=0 → null, показуємо як «новий сплеск»).
 */
export async function repeatClientsBreakdown(managerId: number, month: string, topN = 4): Promise<RepeatClientsBreakdown> {
  const from = month.slice(0, 7) + "-01";
  const to = monthEndOf(from);
  const [py, pm] = from.split("-").map(Number);
  const prevFrom = new Date(Date.UTC(py, pm - 2, 1)).toISOString().slice(0, 10);
  const prevTo = new Date(Date.UTC(py, pm - 1, 0)).toISOString().slice(0, 10);

  // Поточний місяць: repeat-угоди (та сама класифікація, klass='repeat'), груповано по
  // client_key. Назва = найсвіжіша client_name клієнта. NULL client_key → «— без клієнта».
  const p1: unknown[] = [FC_PIPELINES, GENERIC_CLIENT_KEYS, from, to, managerId];
  const conds1 = `dd.status_id = 142 AND dd.pipeline_id = ANY($1) AND dd.closed_at_kommo IS NOT NULL
      AND (dd.closed_at_kommo ${KYIV})::date >= $3 AND (dd.closed_at_kommo ${KYIV})::date <= $4
      AND dd.manager_id = $5`;
  const cte1 = wonSplitCte().replace("__CONDS__", conds1);
  const cur = (await pool.query<{ client_key: string | null; name: string | null; revenue: string; orders: string }>(
    `WITH ${cte1},
     final AS (SELECT client_key, client_name, closed_at_kommo, price, ${PLAN_SEGMENT_KLASS_CASE} AS klass FROM classed)
     SELECT client_key,
            (array_agg(client_name ORDER BY closed_at_kommo DESC))[1] AS name,
            COALESCE(SUM(price),0) AS revenue, COUNT(*) AS orders
       FROM final WHERE klass = 'repeat'
      GROUP BY client_key
      ORDER BY revenue DESC`, p1
  )).rows;

  // Попередній місяць: won-сума КЛІЄНТА в цього менеджера (усі сегменти — динаміка бізнесу
  // клієнта, не лише repeat) для Δ%. Одним запитом, лише по потрібних client_key.
  const keys = cur.map((r) => r.client_key).filter((k): k is string => k != null);
  const prevMap = new Map<string, number>();
  if (keys.length) {
    const prev = (await pool.query<{ client_key: string; revenue: string }>(
      `SELECT dd.client_key, COALESCE(SUM(dd.price),0) AS revenue
         FROM deals dd JOIN managers m ON m.id = dd.manager_id
        WHERE dd.status_id = 142 AND dd.pipeline_id = ANY($1) AND dd.closed_at_kommo IS NOT NULL
          AND (dd.closed_at_kommo ${KYIV})::date >= $2 AND (dd.closed_at_kommo ${KYIV})::date <= $3
          AND dd.manager_id = $4 AND dd.client_key = ANY($5)
        GROUP BY dd.client_key`, [FC_PIPELINES, prevFrom, prevTo, managerId, keys]
    )).rows;
    for (const r of prev) prevMap.set(r.client_key, Number(r.revenue));
  }

  const all = cur.map((r) => {
    const revenue = Number(r.revenue);
    const prevRev = r.client_key != null ? (prevMap.get(r.client_key) ?? 0) : 0;
    const deltaPct = prevRev > 0 ? Math.round(((revenue - prevRev) / prevRev) * 100) : null;
    return { clientKey: r.client_key ?? "", name: r.name ?? "— без клієнта", revenue, orders: Number(r.orders), deltaPct };
  });
  const totalRevenue = all.reduce((a, c) => a + c.revenue, 0);
  const clients = all.slice(0, topN);
  const tail = all.slice(topN);
  const rest = { count: tail.length, revenue: tail.reduce((a, c) => a + c.revenue, 0) };
  return { clients, rest, totalRevenue, totalClients: all.length };
}

/**
 * BE-3 «Створено угод» по бакету — угоди повного циклу, СТВОРЕНІ в періоді (анкер
 * `created_at_kommo`, по-київськи). Scope-aware. Σ бакетів = COUNT створених у періоді.
 */
export async function createdByBucket(s: MetricScope, granularity: "day" | "week" | "month"): Promise<CreatedBucketRow[]> {
  const col = `(d.created_at_kommo ${KYIV})`;
  const bucket = granularity === "day" ? `${col}::date` : `date_trunc('${granularity === "month" ? "month" : "week"}', ${col})::date`;
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.created_at_kommo IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`${col}::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`${col}::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const r = await pool.query<{ bucket: string; deals: string }>(
    `SELECT to_char(${bucket}, 'YYYY-MM-DD') AS bucket, COUNT(*) AS deals
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id ${activeJoin}
      WHERE ${conds.join(" AND ")}
      GROUP BY bucket ORDER BY bucket`,
    params
  );
  return r.rows.map((x) => ({ bucket: x.bucket, deals: Number(x.deals) }));
}

export interface ExpectedBucketRow { bucket: string; deals: number; sum: number }

/**
 * BE-4 «Очікування» по тижню/дню — грошова зона EXPECT_ZONE (знімок «зараз»),
 * бакетована за `planned_payment_at` (день / понеділок тижня). Для «очікування тижня».
 * Місячні this/next лишаються в `expectedPaymentsByPlanned` (не дублюємо). SnapshotScope
 * (без from/to — це знімок зони). noDate (без планової дати) сюди НЕ входить. Σ бакетів
 * = сума зони з непорожньою планової датою (= total − noDate у тому самому scope).
 */
export async function expectedByPlannedBucket(s: SnapshotScope, granularity: "day" | "week"): Promise<ExpectedBucketRow[]> {
  const col = `(d.planned_payment_at ${KYIV})`;
  const bucket = granularity === "day" ? `${col}::date` : `date_trunc('week', ${col})::date`;
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)", "d.planned_payment_at IS NOT NULL"];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const r = await pool.query<{ bucket: string; deals: string; sum: string }>(
    `SELECT to_char(${bucket}, 'YYYY-MM-DD') AS bucket, COUNT(*) AS deals, COALESCE(SUM(d.price),0) AS sum
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id ${activeJoin}
      WHERE ${conds.join(" AND ")}
      GROUP BY bucket ORDER BY bucket`,
    params
  );
  return r.rows.map((x) => ({ bucket: x.bucket, deals: Number(x.deals), sum: Number(x.sum) }));
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
  const { where, params, activeJoin } = adsScope({ ...s, activeOnly: true }, adSources); // active-only скрізь
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

// ───────────────────────── НЕЦІЛЬОВІ ЛІДИ (marketing/КВП) ─────────────────────────

/**
 * Категорії «Причина отказа» (`deals.reject_reason`, ТЕКСТ-label), що власник рахує
 * НЕЦІЛЬОВИМИ (рішення КВП, Крок Б/Г): ЛИШЕ «Дубль» + «Перевізник». Інші відмови —
 * «Нецільове звернення», «Немає зв'язку», «Є інші угоди в роботі» тощо — сюди НЕ
 * входять (свідома межа власника). Live-доведено: `reject_reason` заповнюється ЛИШЕ
 * на Кваліфікації 8921928, тож pipeline-фільтр не потрібен (реджект = вже 8921928).
 */
export const REJECT_NONTARGET = ["Дубль", "Перевізник"];

/**
 * Спільний предикат нецільових: РЕКЛАМНИЙ (`adDealSql`) лід із reject_reason ∈
 * {Дубль, Перевізник}. Ad-фільтр обовʼязковий — метрика про ЗЛИТИЙ рекламний бюджет
 * на junk, не про всю відмову (стара Кваліфікація-143-усе-підряд змітала й
 * не-рекламні: live ~989/міс → ~74). `$1`=adSources, `$2`=REJECT_NONTARGET.
 */
const nonTargetPredicate = "(" + adDealSql("$1") + " AND d.reject_reason = ANY($2))";

/**
 * 🕰 ГОРИЗОНТ reject_reason (honest-label guard): перший місяць із МАТЕРІАЛЬНИМ
 * покриттям (≥30 реджектів/міс) — відсікає поодинокі страй-записи (live: 2024-09 n=1,
 * 2025-03 n=1) від реального бекфілу Крок Б (75д → ~2026-05, 656+/міс). Місяці ДО
 * горизонту НЕ мають даних → показуємо «—» (null), а не «0 нецільових». Повертає
 * 'YYYY-MM-01' першого покритого місяця.
 */
export async function rejectReasonHorizon(): Promise<string> {
  const r = await pool.query<{ m: string | null }>(
    `SELECT to_char(MIN(m), 'YYYY-MM-DD') AS m FROM (
       SELECT date_trunc('month', (created_at_kommo ${KYIV})) AS m,
              COUNT(*) FILTER (WHERE reject_reason IS NOT NULL) AS n
         FROM deals GROUP BY 1
     ) x WHERE n >= 30`);
  return r.rows[0]?.m ?? "2026-05-01";
}

/**
 * НЕЦІЛЬОВІ ліди за скоупом і періодом (за датою СТВОРЕННЯ, обидва кінці по-київськи).
 * Additive: Σ менеджерів = команда = відділ (кожен лід має 1 manager). Скаляр — для
 * /lead-quality (КВП). 🕰 Honest-label: якщо ВЕСЬ період до горизонту reject_reason →
 * `null` («—»), щоб старі місяці не читались як «0 нецільових».
 */
export async function nonTargetLeads(s: MetricScope, adSources: string[]): Promise<number | null> {
  if (s.to && s.to < (await rejectReasonHorizon())) return null;
  const params: unknown[] = [adSources, REJECT_NONTARGET];
  const conds = [nonTargetPredicate];
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  if (s.from) { params.push(s.from); conds.push(`(d.created_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.created_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM deals d ${join} WHERE ${conds.join(" AND ")}`, params);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * НЕЦІЛЬОВІ помісячно/потижнево (той самий предикат) — для depstats-бекфілу/перерахунку.
 * `trunc` ∈ 'month'|'week'. Бакет = київський місяць/тиждень дати створення. 🕰 Бакети
 * ДО горизонту reject_reason → `count=null` («—»; споживач НЕ пише 0, лишає imported).
 */
export async function nonTargetLeadsByBucket(adSources: string[], trunc: "month" | "week"): Promise<{ bucket: string; count: number | null }[]> {
  const horizon = await rejectReasonHorizon();
  const r = await pool.query<{ bucket: string; v: string }>(
    `SELECT to_char(date_trunc('${trunc}', (d.created_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket, COUNT(*) AS v
       FROM deals d
      WHERE ${nonTargetPredicate} AND d.created_at_kommo IS NOT NULL
      GROUP BY bucket`,
    [adSources, REJECT_NONTARGET]);
  return r.rows.map((x) => ({ bucket: x.bucket, count: x.bucket < horizon ? null : Number(x.v) }));
}

// ───────────── КЛІЄНТ-GRAIN НОВІ/ПОСТІЙНІ (лінз лояльності, def A) ─────────────

export interface NewRepeatAgg { newClients: number; newRevenue: number; repeatClients: number; repeatRevenue: number }
export interface NewRepeatRow extends NewRepeatAgg { id: number; name: string; teamId: number | null }

/**
 * КЛІЄНТ-GRAIN «нові/постійні» (def A, GLOSSARY): клієнт, чия ПЕРША в житті оплата
 * (`MIN(created_at_kommo)` серед paid-угод, lifetime) припадає на період → 'new';
 * раніше → 'repeat'. БЕЗ періоду — 'new'=разова оплата (cnt=1), 'repeat'=2+.
 * 🔴 ОКРЕМИЙ ЛІНЗ — НЕ плутати з deal-grain `segments()` (SEGMENT_CASE, обсяг угод)
 * і НЕ з team-based РНК/РПК (то ознака команди). Тут одиниця = КЛІЄНТ.
 * **Attribution до PRIMARY-менеджера** (найбільше paid-угод клієнта в періоді,
 * тайбрейк — остання) → кожен клієнт рахується РАЗ → Σ менеджерів = Σ команд =
 * відділ (інваріант, як у /loyalty). Виручка клієнта за період кріпиться цілком до
 * його primary → Σ = загальна виручка периоду (той самий тотал, що dept-версія).
 * `by=null` → лише тотал (dept/scope). Якір — `created_at_kommo`, paid-стадія.
 */
async function newRepeatRows(s: MetricScope, by: "manager" | "team" | null): Promise<NewRepeatRow[]> {
  const params: unknown[] = [];
  const scope: string[] = ["psm.funnel_stage = 'paid'", "d.client_key IS NOT NULL"];
  if (s.from) { params.push(s.from); scope.push(`(d.created_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); scope.push(`(d.created_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); scope.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scope.push(`m.team_id = $${params.length}`); }
  const fromRef = s.from ? (params.push(s.from), `$${params.length}`) : "NULL";
  const idSel = by === "team" ? "pc.team_id AS id, t.name, NULL::int AS team_id"
             : by === "manager" ? "pc.manager_id AS id, mm.name, pc.team_id AS team_id"
             : "0 AS id, ''::text AS name, NULL::int AS team_id";
  // LEFT JOIN teams — клієнти, чий primary-менеджер БЕЗ команди (team_id NULL), мають
  // лишитись у ролапі окремим рядком (id=NULL, name=NULL «Без команди»), інакше
  // Σ команд < відділ (INNER їх мовчки викидав — зловлено гейтом на лютому).
  const idJoin = by === "team" ? "LEFT JOIN teams t ON t.id = pc.team_id"
              : by === "manager" ? "JOIN managers mm ON mm.id = pc.manager_id" : "";
  const grp = by === "team" ? "GROUP BY pc.team_id, t.name"
           : by === "manager" ? "GROUP BY pc.manager_id, mm.name, pc.team_id" : "";

  const r = await pool.query<{ id: number; name: string; team_id: number | null; new_clients: string; new_revenue: string; repeat_clients: string; repeat_revenue: string }>(
    `WITH paid AS (
       SELECT d.client_key, d.manager_id, m.team_id, d.price, d.created_at_kommo
         FROM deals d
         JOIN managers m ON m.id = d.manager_id
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${scope.join(" AND ")}
     ),
     firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
        GROUP BY d.client_key
     ),
     primary_mgr AS (
       SELECT client_key, manager_id, team_id FROM (
         SELECT client_key, manager_id, team_id,
                ROW_NUMBER() OVER (PARTITION BY client_key ORDER BY COUNT(*) DESC, MAX(created_at_kommo) DESC) AS rn
           FROM paid GROUP BY client_key, manager_id, team_id
       ) z WHERE rn = 1
     ),
     per_client AS (
       SELECT p.client_key, pm.manager_id, pm.team_id,
              CASE WHEN ${fromRef}::date IS NOT NULL
                     THEN CASE WHEN f.first_paid >= ${fromRef}::date THEN 'new' ELSE 'repeat' END
                     ELSE CASE WHEN f.cnt = 1 THEN 'new' ELSE 'repeat' END END AS bucket,
              COALESCE(SUM(p.price), 0) AS revenue
         FROM paid p
         JOIN firsts f ON f.client_key = p.client_key
         JOIN primary_mgr pm ON pm.client_key = p.client_key
        GROUP BY p.client_key, pm.manager_id, pm.team_id, bucket
     )
     SELECT ${idSel},
            COUNT(*) FILTER (WHERE bucket = 'new')::int AS new_clients,
            COALESCE(SUM(revenue) FILTER (WHERE bucket = 'new'), 0) AS new_revenue,
            COUNT(*) FILTER (WHERE bucket = 'repeat')::int AS repeat_clients,
            COALESCE(SUM(revenue) FILTER (WHERE bucket = 'repeat'), 0) AS repeat_revenue
       FROM per_client pc ${idJoin} ${grp}`,
    params
  );
  return r.rows.map((x) => ({
    id: Number(x.id), name: x.name, teamId: x.team_id,
    newClients: Number(x.new_clients), newRevenue: Number(x.new_revenue),
    repeatClients: Number(x.repeat_clients), repeatRevenue: Number(x.repeat_revenue),
  }));
}

/** Розріз нові/постійні по менеджеру або команді (primary-attribution, Σ=тотал). */
export const newRepeatByScope = (s: MetricScope, by: "manager" | "team"): Promise<NewRepeatRow[]> => newRepeatRows(s, by);

/** Тотал нові/постійні у скоупі (dept/scope) — той самий грандтотал, що dept-версія. */
export async function newRepeatTotals(s: MetricScope): Promise<NewRepeatAgg> {
  const [row] = await newRepeatRows(s, null);
  return row ?? { newClients: 0, newRevenue: 0, repeatClients: 0, repeatRevenue: 0 };
}

// ───────────── ЛІДГЕН ТРИ ЯКОРІ — «ПОЇХАЛИ» за load_at (Крок Г #5) ─────────────
// Три РІЗНІ якорі, які НЕ зводимо в межах місяця:
//  • «Передані»  = `leadgen_registry.transferred_at` (conversionTransferredByMonth / transferred).
//  • «Поїхали»   = `deals.load_at` (Дата загрузки) — фактичне відправлення авто. Live
//                  fill-rate: 100% на виграних (142), тож для won-популяції coalesce не
//                  потрібен. Тут — саме дата ВІДПРАВЛЕННЯ, окремо від дати грошей.
//  • «Дохід»     = дата отримання коштів (`core/money.receivedByChannel`, канал 'leadgen').

export interface DispatchRow { ym: string; deals: number; revenue: number }
// Розбивка відправлених авто за ДЖЕРЕЛОМ (постійний / лідоген / реклама / невизн).
// Σ(repeat+leadgen+ad+undef) = total авто того ж скоупу/бакета (партиція за SOURCE_KLASS_CASE).
export interface DispatchSplit { repeat: number; leadgen: number; ad: number; undef: number }
const DISPATCH_SPLIT_SELECT = `
       COUNT(*) FILTER (WHERE klass = 'repeat')  AS repeat_c,
       COUNT(*) FILTER (WHERE klass = 'leadgen') AS leadgen_c,
       COUNT(*) FILTER (WHERE klass = 'ad')      AS ad_c,
       COUNT(*) FILTER (WHERE klass = 'undef')   AS undef_c`;
const dispatchSplitOf = (x: { repeat_c: string; leadgen_c: string; ad_c: string; undef_c: string }): DispatchSplit =>
  ({ repeat: Number(x.repeat_c), leadgen: Number(x.leadgen_c), ad: Number(x.ad_c), undef: Number(x.undef_c) });
/**
 * «Поїхали» помісячно за `load_at` (Дата загрузки = відправлення): угоди Повного
 * циклу з проставленою `load_at`, опційно фільтр каналу (`channel`). Сума — signed
 * `price` (мінуси нетяться). Additive по скоупу/бакету. НЕ анкериться на гроші/успіх —
 * це операційний потік «скільки авто поїхало у місяці M».
 */
export async function dispatchedByLoadMonth(s: MetricScope, channel?: "leadgen" | "ad" | null): Promise<DispatchRow[]> {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.load_at IS NOT NULL"];
  if (channel) { params.push(channel); conds.push(`d.lead_channel = $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const r = await pool.query<{ ym: string; deals: string; revenue: string }>(
    `WITH disp AS (
       SELECT date_trunc('month',(d.load_at ${KYIV})) AS m, d.price
         FROM deals d ${join} WHERE ${conds.join(" AND ")}
     ),
     months AS (
       SELECT generate_series(date_trunc('month',(now() ${KYIV})) - INTERVAL '11 months',
                              date_trunc('month',(now() ${KYIV})), INTERVAL '1 month') AS m
     )
     SELECT to_char(mo.m,'YYYY-MM') AS ym,
            COUNT(disp.*)::int AS deals, COALESCE(SUM(disp.price),0) AS revenue
       FROM months mo LEFT JOIN disp ON disp.m = mo.m GROUP BY mo.m ORDER BY mo.m`,
    params
  );
  return r.rows.map((x) => ({ ym: x.ym, deals: Number(x.deals), revenue: Number(x.revenue) }));
}

/**
 * «Поїхали» по БАКЕТУ (день/тиждень/місяць) у [from,to] за `load_at` — для денного
 * дрілу КВП (Крок Д фінал). Scoped, опційний канал. Additive: Σ бакетів = разом у періоді.
 */
export async function dispatchedByLoadBucket(s: MetricScope, granularity: "day" | "week" | "month", channel?: "leadgen" | "ad" | null): Promise<(DispatchRow & DispatchSplit)[]> {
  // Класифікація за ДЖЕРЕЛОМ через спільний `classifyCte` (анкер вікна = load_at,
  // has_prior проти created_at_kommo). Active-only через зовнішній INNER JOIN.
  const bucketExpr = `to_char(date_trunc('${granularity}', (d.load_at ${KYIV})), 'YYYY-MM-DD')`;
  const params: unknown[] = [];
  const cte = classifyCte(s, params, { windowCol: "d.load_at", klassCase: SOURCE_KLASS_CASE, bucketExpr, carryPrice: true, channel: channel ?? null });
  const r = await pool.query<{ ym: string; deals: string; revenue: string; repeat_c: string; leadgen_c: string; ad_c: string; undef_c: string }>(
    `WITH ${cte}
     SELECT f.bucket AS ym, COUNT(*)::int AS deals, COALESCE(SUM(f.price),0) AS revenue,${DISPATCH_SPLIT_SELECT}
       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active
      GROUP BY f.bucket ORDER BY f.bucket`, params);
  return r.rows.map((x) => ({ ym: x.ym, deals: Number(x.deals), revenue: Number(x.revenue), ...dispatchSplitOf(x) }));
}

export interface RepeatBucketRow { bucket: string; activeClients: number; cars: number; revenue: number }
/**
 * ПОСТІЙНІ клієнти по бакету (день/тиждень/місяць): активні постійні (DISTINCT client_key),
 * їхні авто (COUNT) і сума (SUM price) — для категорії «Клієнти» вкладки Статистик. ТА САМА
 * класифікація, що `dispatchedByLoadBucket` (анкер load_at, `SOURCE_KLASS_CASE`, klass='repeat'
 * = has_prior проти created_at) — визначення 1:1 зі Звітом/лояльністю, БЕЗ нового правила.
 * Гейт: `cars` == `dispatchedByLoadBucket.repeat_c` на тому ж бакеті. Active-only.
 */
export async function repeatClientsByBucket(s: MetricScope, granularity: "day" | "week" | "month"): Promise<RepeatBucketRow[]> {
  const bucketExpr = `to_char(date_trunc('${granularity}', (d.load_at ${KYIV})), 'YYYY-MM-DD')`;
  const params: unknown[] = [];
  const cte = classifyCte(s, params, { windowCol: "d.load_at", klassCase: SOURCE_KLASS_CASE, bucketExpr, carryPrice: true, carryVkey: true });
  const r = await pool.query<{ bucket: string; active: string; cars: string; revenue: string }>(
    `WITH ${cte}
     SELECT f.bucket, COUNT(DISTINCT f.vkey)::int AS active, COUNT(*)::int AS cars, COALESCE(SUM(f.price),0) AS revenue
       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active
      WHERE f.klass = 'repeat' GROUP BY f.bucket ORDER BY f.bucket`, params);
  return r.rows.map((x) => ({ bucket: x.bucket, activeClients: Number(x.active), cars: Number(x.cars), revenue: Number(x.revenue) }));
}

export interface MgrDayExp { managerId: number; day: string; deals: number; sum: number }
/**
 * «В очікуванні» по (менеджер × день ПЛАНОВОЇ дати оплати) — знімок EXPECT_ZONE,
 * бакет = `planned_payment_at`::date. Для тижневого розрізу КВП (Крок Д фінал):
 * дні кладуться у фіксовані блоки Т1–Т5. Additive: Σ = зона по менеджеру.
 */
export async function expectedByManagerDay(s: SnapshotScope): Promise<MgrDayExp[]> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)", "d.planned_payment_at IS NOT NULL"];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ manager_id: number; day: string; deals: string; sum: string }>(
    `SELECT d.manager_id, to_char((d.planned_payment_at ${KYIV})::date, 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS deals, COALESCE(SUM(d.price),0) AS sum
       FROM deals d JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")} GROUP BY d.manager_id, 2 ORDER BY 2`, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, day: x.day, deals: Number(x.deals), sum: Number(x.sum) }));
}

export interface MgrDayN { managerId: number; day: string; deals: number; revenue: number }
/** «Поїхали» по (менеджер × день `load_at`) — для тижневої активності КВП (Крок Д).
 *  Повертає к-сть І суму (signed `price`, мінуси нетяться) ОДНИМ запитом — одна функція
 *  «авто» = count+sum (рішення власника PHASE-1 #3). Σ днів = `dispatchedByManager`. */
export async function dispatchedByManagerDay(s: MetricScope): Promise<MgrDayN[]> {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.load_at IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(d.load_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.load_at ${KYIV})::date <= $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const r = await pool.query<{ manager_id: number; bkt: string; deals: string; revenue: string }>(
    `SELECT d.manager_id, to_char((d.load_at ${KYIV})::date,'YYYY-MM-DD') AS bkt, COUNT(*) deals,
            COALESCE(SUM(d.price),0) revenue
       FROM deals d ${join} WHERE ${conds.join(" AND ")} GROUP BY d.manager_id, 2`, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, day: x.bkt, deals: Number(x.deals), revenue: Number(x.revenue) }));
}

export interface MgrDayLeads { managerId: number; day: string; ad: number; leadgen: number }
/** «Взято лідів» по (менеджер × день × канал) — той самий предикат, що `leadsTakenByBucket`. */
export async function leadsByManagerDay(s: MetricScope): Promise<MgrDayLeads[]> {
  const params: unknown[] = [FC_PIPELINES];
  const winConds = ["d.pipeline_id = ANY($1)", "psm.funnel_stage = 'lead_taken'"];
  if (s.from) { params.push(s.from); winConds.push(`(dse.changed_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); winConds.push(`(dse.changed_at ${KYIV})::date <= $${params.length}`); }
  // Active-only: INNER JOIN managers + m.is_active (неактивний зникає з агрегату).
  const teamCond = s.teamId ? (params.push(s.teamId), `AND m.team_id = $${params.length}`) : "";
  const r = await pool.query<{ manager_id: number; bkt: string; ad: string; leadgen: string }>(
    `WITH first_lt AS (
       SELECT dse.kommo_id, MIN(dse.changed_at) AS anchor_at
         FROM deal_stage_events dse
         JOIN deals d ON d.kommo_id = dse.kommo_id
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
        WHERE ${winConds.join(" AND ")} GROUP BY dse.kommo_id
     )
     SELECT d2.manager_id, to_char((f.anchor_at ${KYIV})::date,'YYYY-MM-DD') AS bkt,
            COUNT(*) FILTER (WHERE d2.lead_channel = 'ad') ad,
            COUNT(*) FILTER (WHERE d2.lead_channel = 'leadgen') leadgen
       FROM first_lt f JOIN deals d2 ON d2.kommo_id = f.kommo_id
       JOIN managers m ON m.id = d2.manager_id
      WHERE m.is_active ${teamCond}
      GROUP BY d2.manager_id, 2`, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, day: x.bkt, ad: Number(x.ad), leadgen: Number(x.leadgen) }));
}

// ── ЗВІТ+ЗАДАЧНИК: per-manager агрегати для авто-заповнення KPI (спільне джерело) ──
// Мета: Звіт і evaluateKpiTasks беруть факт із ОДНИХ функцій → числа не розходяться.
// Авто = load_at (фактична відправка) КАНОНІЧНО (рішення власника), як і у КВП-дрилі.

export interface MgrN { managerId: number; deals: number }
export interface MgrBucketN { managerId: number; bucket: string; deals: number }
export interface MgrLeads { managerId: number; ad: number; leadgen: number }
export interface MgrBucketLeads { managerId: number; bucket: string; ad: number; leadgen: number }

/** «Поїхали» (авто) ПО МЕНЕДЖЕРУ, period-total за `load_at`. Той самий предикат, що
 *  `dispatchedByManagerDay`/`dispatchedByLoadBucket`, лише згрупований по менеджеру. */
export async function dispatchedByManager(s: MetricScope): Promise<(MgrN & { revenue: number } & DispatchSplit)[]> {
  // Класифікація за ДЖЕРЕЛОМ через спільний `classifyCte` (анкер вікна = load_at,
  // has_prior проти created_at_kommo). Active-only через зовнішній INNER JOIN на managers
  // (m.is_active) — консистентно з money-core і зі старою поведінкою. Сума ₴ — signed price.
  const params: unknown[] = [];
  const cte = classifyCte(s, params, { windowCol: "d.load_at", klassCase: SOURCE_KLASS_CASE, carryPrice: true });
  const r = await pool.query<{ manager_id: number; deals: string; revenue: string; repeat_c: string; leadgen_c: string; ad_c: string; undef_c: string }>(
    `WITH ${cte}
     SELECT f.manager_id, COUNT(*) deals, COALESCE(SUM(f.price),0) revenue,${DISPATCH_SPLIT_SELECT}
       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active
      GROUP BY f.manager_id`, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, deals: Number(x.deals), revenue: Number(x.revenue), ...dispatchSplitOf(x) }));
}

/** «Поїхали» ПО (менеджер × бакет день/тиждень/місяць) за `load_at`, з розбивкою за
 *  джерелом. Additive: Σ бакетів = `dispatchedByManager` того ж скоупу (день=тиждень=місяць). */
export async function dispatchedByManagerBucket(s: MetricScope, granularity: "day" | "week" | "month"): Promise<(MgrBucketN & { revenue: number } & DispatchSplit)[]> {
  const bucketExpr = `to_char(date_trunc('${granularity}', (d.load_at ${KYIV}))::date, 'YYYY-MM-DD')`;
  const params: unknown[] = [];
  const cte = classifyCte(s, params, { windowCol: "d.load_at", klassCase: SOURCE_KLASS_CASE, bucketExpr, carryPrice: true });
  const r = await pool.query<{ manager_id: number; bucket: string; deals: string; revenue: string; repeat_c: string; leadgen_c: string; ad_c: string; undef_c: string }>(
    `WITH ${cte}
     SELECT f.manager_id, f.bucket, COUNT(*) deals, COALESCE(SUM(f.price),0) revenue,${DISPATCH_SPLIT_SELECT}
       FROM final f JOIN managers m ON m.id = f.manager_id AND m.is_active
      GROUP BY f.manager_id, f.bucket ORDER BY f.bucket`, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, bucket: x.bucket, deals: Number(x.deals), revenue: Number(x.revenue), ...dispatchSplitOf(x) }));
}

/** «Взято лідів» ПО МЕНЕДЖЕРУ, period-total, канал ad/leadgen (той самий lead_taken
 *  stage-entry анкер, що `leadsByManagerDay`). Закриває GAP лідоген-per-manager. */
export async function leadsByManager(s: MetricScope): Promise<MgrLeads[]> {
  const days = await leadsByManagerDay(s);
  const m = new Map<number, MgrLeads>();
  for (const d of days) { const e = m.get(d.managerId) ?? { managerId: d.managerId, ad: 0, leadgen: 0 }; e.ad += d.ad; e.leadgen += d.leadgen; m.set(d.managerId, e); }
  return [...m.values()];
}

/** «Взято лідів» ПО (менеджер × бакет) — leadsByManagerDay, згорнутий у день/тиждень/
 *  місяць (тижні Пн–Нд Kyiv через date_trunc('week')). Additive по бакетах. */
export async function leadsByManagerBucket(s: MetricScope, granularity: "day" | "week" | "month"): Promise<MgrBucketLeads[]> {
  const days = await leadsByManagerDay(s);
  if (granularity === "day") return days.map((d) => ({ managerId: d.managerId, bucket: d.day, ad: d.ad, leadgen: d.leadgen }));
  const trunc = (day: string): string => {
    const dt = new Date(day + "T00:00:00Z");
    if (granularity === "month") return day.slice(0, 7) + "-01";
    const dow = dt.getUTCDay() === 0 ? 7 : dt.getUTCDay(); // Пн=1..Нд=7
    dt.setUTCDate(dt.getUTCDate() - (dow - 1)); // понеділок тижня
    return dt.toISOString().slice(0, 10);
  };
  const m = new Map<string, MgrBucketLeads>();
  for (const d of days) { const b = trunc(d.day); const key = `${d.managerId}|${b}`; const e = m.get(key) ?? { managerId: d.managerId, bucket: b, ad: 0, leadgen: 0 }; e.ad += d.ad; e.leadgen += d.leadgen; m.set(key, e); }
  return [...m.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** «Прийняв лідогенераторів» ПО МЕНЕДЖЕРУ — з ПЕРСИСТОВАНОГО `leadgen_touch` (не з
 *  живої leadgen_registry, що обрізається ~5 тижнів → історія давала б 0). Те саме
 *  джерело, що класифікує лідоген у проді. Джойн touch→угода→менеджер, DISTINCT
 *  lead_kommo_id за `transfer_date` у [from,to]. Period-total. */
export async function leadgenByManager(s: MetricScope): Promise<MgrN[]> {
  const params: unknown[] = [];
  const conds = ["d.manager_id IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`lt.transfer_date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`lt.transfer_date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const r = await pool.query<{ manager_id: number; deals: string }>(
    `SELECT d.manager_id, COUNT(DISTINCT lt.lead_kommo_id) deals
       FROM leadgen_touch lt JOIN deals d ON d.kommo_id = lt.lead_kommo_id ${join}
      WHERE ${conds.join(" AND ")} GROUP BY d.manager_id`, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, deals: Number(x.deals) }));
}

/** «Прийняв лідогенераторів» ПО (менеджер × бакет) за `transfer_date`. Additive. */
export async function leadgenByManagerBucket(s: MetricScope, granularity: "day" | "week" | "month"): Promise<MgrBucketN[]> {
  const params: unknown[] = [];
  const conds = ["d.manager_id IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`lt.transfer_date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`lt.transfer_date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const r = await pool.query<{ manager_id: number; bucket: string; deals: string }>(
    `SELECT d.manager_id, to_char(date_trunc('${granularity}', lt.transfer_date)::date,'YYYY-MM-DD') bucket, COUNT(DISTINCT lt.lead_kommo_id) deals
       FROM leadgen_touch lt JOIN deals d ON d.kommo_id = lt.lead_kommo_id ${join}
      WHERE ${conds.join(" AND ")} GROUP BY d.manager_id, 2 ORDER BY 2`, params);
  return r.rows.map((x) => ({ managerId: x.manager_id, bucket: x.bucket, deals: Number(x.deals) }));
}

export interface MgrConvTaken { managerId: number; taken: number; won: number; cohortPct: number | null }
/**
 * КОНВЕРСІЯ ПО МЕНЕДЖЕРУ (рішення власника): **виграно ÷ УЗЯТІ ЛІДИ (реклама +
 * лідоген РАЗОМ)**. Знаменник = FC-угоди `lead_channel IN ('ad','leadgen')`, СТВОРЕНІ
 * в періоді (постійні `other` БЕЗ ліда — НЕ входять). Чисельник = з них дійшли до
 * MONEY_ZONE (визнання доходу, ≤100%). Само підлаштовується під канал: РПК≈лідоген,
 * РНК≈ads. cohortPct=null коли taken<10 (UI «—», не «0%»). Scope-aware.
 */
export async function conversionByManager(s: MetricScope): Promise<MgrConvTaken[]> {
  const params: unknown[] = [FC_PIPELINES, MONEY_ZONE];
  const conds = ["d.pipeline_id = ANY($1)", "d.lead_channel IN ('ad','leadgen')", "d.manager_id IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(d.created_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.created_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const r = await pool.query<{ manager_id: number; taken: string; won: string }>(
    `SELECT d.manager_id, COUNT(*) taken,
            COUNT(*) FILTER (WHERE d.status_id = ANY($2)
                 OR EXISTS (SELECT 1 FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id AND e.status_id = ANY($2))) won
       FROM deals d ${join} WHERE ${conds.join(" AND ")} GROUP BY d.manager_id`, params);
  return r.rows.map((x) => {
    const taken = Number(x.taken), won = Number(x.won);
    return { managerId: x.manager_id, taken, won, cohortPct: taken >= 10 ? Math.round((won / taken) * 1000) / 10 : null };
  });
}

// ── Блок A (КВП повна таблиця) — нові метрики ──
// Прострочена оплата = ЗНІМОК «зараз»: планова дата оплати минула, а угода ще НЕ оплачена
// (не 142/143 і не в етапі 9 «оплата отримана»). Не залежить від періоду. sum = Σ price.
const STAGE_PAID_STATUSES = [69716460, 60412544]; // етап 9 «Оплата отримана»
export async function overduePayments(s: MetricScope): Promise<{ count: number; sum: number }> {
  const params: unknown[] = [FC_PIPELINES, STAGE_PAID_STATUSES];
  const conds = [
    "d.pipeline_id = ANY($1)",
    "d.planned_payment_at IS NOT NULL",
    `(d.planned_payment_at ${KYIV})::date < (now() ${KYIV})::date`,
    "d.status_id NOT IN (142, 143)",
    "NOT (d.status_id = ANY($2))",
  ];
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ c: string; s: string }>(
    `SELECT COUNT(*) c, COALESCE(SUM(d.price), 0) s FROM deals d ${join} WHERE ${conds.join(" AND ")}`, params);
  return { count: Number(r.rows[0].c), sum: Math.round(Number(r.rows[0].s)) };
}

// Середній цикл угоди = днів від СТВОРЕННЯ (лід) до ЗАКРИТТЯ (оплата, 142), для угод,
// що стали 142 у періоді. ⓘ: created_at≈лід, closed_at≈оплата (реальної банк-дати нема).
export async function avgDealCycleDays(s: MetricScope): Promise<number | null> {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = 142", "d.created_at_kommo IS NOT NULL", "d.closed_at_kommo IS NOT NULL", "d.closed_at_kommo >= d.created_at_kommo"];
  if (s.from) { params.push(s.from); conds.push(`(d.closed_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.closed_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const r = await pool.query<{ d: string | null }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (d.closed_at_kommo - d.created_at_kommo)) / 86400.0) d
       FROM deals d ${join} WHERE ${conds.join(" AND ")}`, params);
  return r.rows[0].d == null ? null : Math.round(Number(r.rows[0].d));
}

// Втрачені угоди = зайшли в 143 (закрито й не реалізовано) у періоді (за closed_at).
// count + Σ price. Окремо від «нецільових лідів» (nonTargetLeads) — у роуті складаємо.
export async function lostDeals(s: MetricScope): Promise<{ count: number; sum: number }> {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = 143", "d.closed_at_kommo IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(d.closed_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.closed_at_kommo ${KYIV})::date <= $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const r = await pool.query<{ c: string; s: string }>(
    `SELECT COUNT(*) c, COALESCE(SUM(ABS(d.price)), 0) s FROM deals d ${join} WHERE ${conds.join(" AND ")}`, params);
  return { count: Number(r.rows[0].c), sum: Math.round(Number(r.rows[0].s)) };
}

// Втрачені (143) ПО ДНЯХ (для тижневого факту у Повній таблиці). Σднів == lostDeals.
export async function lostByDay(s: MetricScope): Promise<{ day: string; deals: number; sum: number }[]> {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = 143", "d.closed_at_kommo IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`(d.closed_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.closed_at_kommo ${KYIV})::date <= $${params.length}`); }
  const r = await pool.query<{ bkt: string; c: string; s: string }>(
    `SELECT to_char((d.closed_at_kommo ${KYIV})::date, 'YYYY-MM-DD') AS bkt, COUNT(*) c, COALESCE(SUM(ABS(d.price)),0) s
       FROM deals d WHERE ${conds.join(" AND ")} GROUP BY 1`, params);
  return r.rows.map((x) => ({ day: x.bkt, deals: Number(x.c), sum: Math.round(Number(x.s)) }));
}

// ── Блок B (логістика) — часові/дебіторські метрики ──
export interface DaysStat { avg: number | null; median: number | null; n: number }
// Транзитний час = днів load_at → unload_at (дата акта) для FC-угод з обома датами,
// розвантажених у періоді. ⓘ unload_at = ДАТА АКТА (бухг.), не фізичне розвантаження.
export async function transitStats(s: MetricScope): Promise<DaysStat> {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.load_at IS NOT NULL", "d.unload_at IS NOT NULL", "d.unload_at >= d.load_at"];
  if (s.from) { params.push(s.from); conds.push(`(d.unload_at ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.unload_at ${KYIV})::date <= $${params.length}`); }
  const r = await pool.query<{ a: string | null; med: string | null; n: string }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (d.unload_at - d.load_at))/86400.0) a,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d.unload_at - d.load_at))/86400.0) med,
            COUNT(*) n FROM deals d WHERE ${conds.join(" AND ")}`, params);
  const x = r.rows[0];
  return { avg: x.a == null ? null : Math.round(Number(x.a) * 10) / 10, median: x.med == null ? null : Math.round(Number(x.med) * 10) / 10, n: Number(x.n) };
}

// DSO-проксі = днів unload_at (дата акта) → closed_at (оплата/142), для угод, оплачених
// у періоді. ⓘ реальної банк-дати оплати в CRM нема → проксі по даті закриття.
export async function dsoProxyDays(s: MetricScope): Promise<DaysStat> {
  const params: unknown[] = [FC_PIPELINES];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = 142", "d.unload_at IS NOT NULL", "d.closed_at_kommo IS NOT NULL", "d.closed_at_kommo >= d.unload_at"];
  if (s.from) { params.push(s.from); conds.push(`(d.closed_at_kommo ${KYIV})::date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`(d.closed_at_kommo ${KYIV})::date <= $${params.length}`); }
  const r = await pool.query<{ a: string | null; med: string | null; n: string }>(
    `SELECT AVG(EXTRACT(EPOCH FROM (d.closed_at_kommo - d.unload_at))/86400.0) a,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (d.closed_at_kommo - d.unload_at))/86400.0) med,
            COUNT(*) n FROM deals d WHERE ${conds.join(" AND ")}`, params);
  const x = r.rows[0];
  return { avg: x.a == null ? null : Math.round(Number(x.a) * 10) / 10, median: x.med == null ? null : Math.round(Number(x.med) * 10) / 10, n: Number(x.n) };
}

// Aging простроченої дебіторки (знімок «зараз»): неоплачені FC-угоди (не 142/143, не
// етап 9) з planned_payment_at у минулому. Кошики 1-7/8-30/30+ = РЕАЛЬНИЙ БОРГ до стягнення
// (лише не-сторно, price>0) → жоден не відʼємний. Сторно (is_minus, повернення/коригування)
// винесено ОКРЕМИМ рядком, бо це не «борг до стягнення», а зменшення нарахувань. Σ-узгодженість:
// Σ(кошики.sum) + reversals.sum == overduePayments.sum (той самий предикат, знакова сумісність).
export interface AgingBucket { bucket: string; count: number; sum: number }
export interface AgingResult { buckets: AgingBucket[]; reversals: { count: number; sum: number } }
export async function receivablesAging(): Promise<AgingResult> {
  const r = await pool.query<{ bucket: string; c: string; s: string }>(
    `WITH od AS (
       SELECT d.price, d.is_minus, ((now() ${KYIV})::date - (d.planned_payment_at ${KYIV})::date) AS days
         FROM deals d
        WHERE d.pipeline_id = ANY($1) AND d.planned_payment_at IS NOT NULL
          AND (d.planned_payment_at ${KYIV})::date < (now() ${KYIV})::date
          AND d.status_id NOT IN (142, 143) AND NOT (d.status_id = ANY($2))
     )
     SELECT CASE WHEN is_minus THEN 'reversal'
                 WHEN days <= 7 THEN '1-7' WHEN days <= 30 THEN '8-30' ELSE '30+' END AS bucket,
            COUNT(*) c, COALESCE(SUM(price),0) s
       FROM od GROUP BY 1`, [FC_PIPELINES, [69716460, 60412544]]);
  const map = new Map(r.rows.map((x) => [x.bucket, { count: Number(x.c), sum: Math.round(Number(x.s)) }]));
  const buckets = ["1-7", "8-30", "30+"].map((b) => ({ bucket: b, ...(map.get(b) ?? { count: 0, sum: 0 }) }));
  const reversals = map.get("reversal") ?? { count: 0, sum: 0 };
  return { buckets, reversals };
}

/**
 * «В очікуванні» команди/менеджера за плановою датою в місяці зі ЗСУВОМ `monthOffset`
 * (0 = поточний, 1 = наступний) — для сигналів КВП «цей/наступний» (Крок Д фінал #3).
 * Той самий предикат, що `expectedThisMonthByScope` (offset 0). Σ рядків == зона того місяця.
 */
export async function expectedMonthByScope(s: SnapshotScope, by: "team" | "manager", monthOffset: number): Promise<ExpectedScopeRow[]> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = [
    "d.pipeline_id = ANY($1)", "d.status_id = ANY($2)", "d.planned_payment_at IS NOT NULL",
    `to_char((d.planned_payment_at ${KYIV}), 'YYYY-MM') = to_char((now() ${KYIV}) + INTERVAL '${monthOffset} months', 'YYYY-MM')`,
  ];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const sel = by === "team" ? "t.id AS id, t.name AS name, NULL::int AS team_id" : "m.id AS id, m.name AS name, m.team_id";
  const grp = by === "team" ? "GROUP BY t.id, t.name" : "GROUP BY m.id, m.name, m.team_id";
  const join = by === "team" ? "JOIN teams t ON t.id = m.team_id" : "";
  const r = await pool.query<{ id: number; name: string; team_id: number | null; deals: string; sum: string }>(
    `SELECT ${sel}, COUNT(*)::int deals, COALESCE(SUM(d.price),0) sum
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active ${join}
      WHERE ${conds.join(" AND ")} ${grp}`, params);
  return r.rows.map((x) => ({ id: x.id, name: x.name, teamId: x.team_id, deals: Number(x.deals), sum: Number(x.sum) }));
}

// ───────────────────────── RETENTION-РОДИНА (Крок Г #4) ─────────────────────────
// Скоуп-рівень (dept/team/manager через `s`). «Погашено дебіторки» НЕ будуємо —
// `receivables` це TRUNCATE-знімок без історії погашень → метрика = «—» (ⓘ у UI).

/** Спільний скоуп для paid-угод (funnel_stage='paid') за атрибуцією угоди. */
function paidScopeConds(s: MetricScope, params: unknown[], needTeamJoin = false): { conds: string[]; join: string } {
  const conds = ["psm.funnel_stage = 'paid'", "d.client_key IS NOT NULL"];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const join = (needTeamJoin || s.teamId) ? "JOIN managers m ON m.id = d.manager_id" : "";
  return { conds, join };
}

export interface NewToRepeatRow { ym: string; cohort: number; became: number; pct: number | null; mature: boolean }
/**
 * % нових→постійних (12 міс): когорта = клієнти, чия ПЕРША оплата (lifetime,
 * `created_at_kommo`) у місяці M; `became` = із них мають ≥2 оплати lifetime (стали
 * постійними — замовили ще раз БУДЬ-КОЛИ). Скоуп — за менеджером/командою ПЕРШОЇ
 * угоди. Зрілість 90д (свіжа когорта не встигла повернутись) → поточні місяці ⏳.
 */
export async function newToRepeatByMonth(s: MetricScope): Promise<NewToRepeatRow[]> {
  const params: unknown[] = [];
  const { conds, join } = paidScopeConds(s, params);
  const r = await pool.query<{ ym: string; cohort: string; became: string; mature: boolean }>(
    `WITH paid AS (
       SELECT d.client_key, d.manager_id, d.created_at_kommo
         FROM deals d ${join}
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${conds.join(" AND ")}
     ),
     first_deal AS (
       SELECT DISTINCT ON (client_key) client_key, created_at_kommo AS first_paid, manager_id
         FROM paid ORDER BY client_key, created_at_kommo ASC
     ),
     cnt AS (
       SELECT client_key, COUNT(*) AS c
         FROM deals d2
         JOIN pipeline_stage_map psm2 ON psm2.pipeline_id = d2.pipeline_id AND psm2.status_id = d2.status_id
        WHERE psm2.funnel_stage = 'paid' AND d2.client_key IS NOT NULL
        GROUP BY client_key
     ),
     months AS (
       SELECT generate_series(date_trunc('month',(now() ${KYIV})) - INTERVAL '11 months',
                              date_trunc('month',(now() ${KYIV})), INTERVAL '1 month') AS m
     ),
     coh AS (
       SELECT date_trunc('month',(fd.first_paid ${KYIV})) AS m,
              COUNT(*)::int AS cohort,
              COUNT(*) FILTER (WHERE c.c >= 2)::int AS became
         FROM first_deal fd JOIN cnt c ON c.client_key = fd.client_key
        GROUP BY 1
     )
     SELECT to_char(mo.m,'YYYY-MM') AS ym,
            COALESCE(coh.cohort,0) AS cohort, COALESCE(coh.became,0) AS became,
            ((mo.m + INTERVAL '1 month') <= (now() ${KYIV}) - INTERVAL '90 days') AS mature
       FROM months mo LEFT JOIN coh ON coh.m = mo.m ORDER BY mo.m`,
    params
  );
  return r.rows.map((x) => {
    const cohort = Number(x.cohort), became = Number(x.became);
    return { ym: x.ym, cohort, became, pct: cohort > 0 ? Math.round((became / cohort) * 1000) / 10 : null, mature: x.mature };
  });
}

export interface ActiveBaseRow { ym: string; activeClients: number }
/**
 * Активність бази (12 міс): DISTINCT клієнтів з ОПЛАТОЮ (paid) у місяці M за
 * `created_at_kommo`. «Замовили цей місяць». Скоуп за атрибуцією угоди. Це знімок
 * активності, не потік грошей.
 */
export async function activeBaseByMonth(s: MetricScope): Promise<ActiveBaseRow[]> {
  const params: unknown[] = [];
  const { conds, join } = paidScopeConds(s, params);
  const r = await pool.query<{ ym: string; active: string }>(
    `WITH paid AS (
       SELECT DISTINCT d.client_key, date_trunc('month',(d.created_at_kommo ${KYIV})) AS m
         FROM deals d ${join}
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${conds.join(" AND ")}
     ),
     months AS (
       SELECT generate_series(date_trunc('month',(now() ${KYIV})) - INTERVAL '11 months',
                              date_trunc('month',(now() ${KYIV})), INTERVAL '1 month') AS m
     )
     SELECT to_char(mo.m,'YYYY-MM') AS ym, COUNT(p.client_key)::int AS active
       FROM months mo LEFT JOIN paid p ON p.m = mo.m GROUP BY mo.m ORDER BY mo.m`,
    params
  );
  return r.rows.map((x) => ({ ym: x.ym, activeClients: Number(x.active) }));
}

export interface WeeklyRegularsResult { clients: number; windowWeeks: number; minWeeks: number }
/**
 * Постійні, що замовляють ЩОТИЖНЯ (знімок, cadence-евристика — owner-tunable):
 * клієнти з оплатами у ≥ `minWeeks` РІЗНИХ ISO-тижнях за trailing вікно `windowWeeks`
 * (дефолт: ≥4 з останніх 8 тижнів). Не серія — поточний зріз. Скоуп за угодою.
 */
export async function weeklyRegulars(s: MetricScope, windowWeeks = 8, minWeeks = 4): Promise<WeeklyRegularsResult> {
  const params: unknown[] = [];
  const { conds, join } = paidScopeConds(s, params);
  const r = await pool.query<{ n: string }>(
    `WITH weeks AS (
       SELECT d.client_key, date_trunc('week',(d.created_at_kommo ${KYIV})) AS wk
         FROM deals d ${join}
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${conds.join(" AND ")}
          AND (d.created_at_kommo ${KYIV})::date >= (now() ${KYIV})::date - (${windowWeeks} * 7)
     )
     SELECT COUNT(*)::int AS n FROM (
       SELECT client_key FROM weeks GROUP BY client_key HAVING COUNT(DISTINCT wk) >= ${minWeeks}
     ) z`,
    params
  );
  return { clients: Number(r.rows[0]?.n ?? 0), windowWeeks, minWeeks };
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
  entered: number;       // знаменник обох версій: вхідна когорта, що зайшла в зону в місяці
  wonEventually: number; // чисельник КОГОРТИ: із цих — скільки ЗРЕШТОЮ дійшли до MONEY_ZONE
  cohortPct: number | null;
  wonInMonth: number;    // чисельник ПЕРІОДУ: дійшли до MONEY_ZONE у цьому місяці
  periodPct: number | null;
  mature: boolean;       // когорта дозріла (≥90 днів від кінця місяця)
}
/** Уніфікований рядок когортної конверсії — спільний для всіх 4 конверсій (Крок В). */
export type ConversionCohortRow = ConversionAdsRow;

/**
 * Опис ВХІДНОЇ КОГОРТИ (знаменника) для `conversionByCohort`. Чисельник скрізь
 * ОДНАКОВИЙ — «дійшов до MONEY_ZONE у Повному циклі» — тут задається лише ЯК
 * формується вхідна когорта та її ЗЕРНО дедупу:
 *   • `deal`   — зерно `kommo_id` (та сама угода йде Кваліфікація→FC, id зберігає):
 *     РЕКЛАМА. Вхід = подія входу в `entryStatuses`; знаменник — платні нові
 *     (`paidAdSql`+SEGMENT='new'), тому потрібен `adSources`.
 *   • `client`+`stage` — зерно `client_key` (угода лідогену і виграна FC — РІЗНІ
 *     id, спільний client_key): ПРОДЗВІН / РЕАКТИВАЦІЯ. Вхід = стадія у своїй воронці.
 *   • `client`+`transferred` — зерно `client_key`: ЛІДОГЕН-ПЕРЕДАЧІ. Вхід =
 *     `leadgen_registry.transferred_at` (виключаючи лідоген-команди).
 */
type CohortEntry =
  | { grain: "deal"; entryStatuses: number[]; adSources: string[] }
  | { grain: "client"; kind: "stage"; entryStatuses: number[]; entryPipelines: number[] }
  | { grain: "client"; kind: "transferred" };

/**
 * СПІЛЬНЕ ЯДРО ЧИСЕЛЬНИКА для DEAL-grain (реклама): `adzone`(вхід у ADZONE) →
 * `won`(MONEY_ZONE у FC) → `pop`. Одне джерело SQL для ОБОХ агрегацій —
 * помісячної (`conversionByCohort`) і per-manager (`conversionAdsByManager`), щоб
 * рейтинг менеджерів гарантовано збігався з Оглядом ДО одного коду, а не лише
 * до однакової межі. `pop` віддає manager_id/team_id (для групування) — помісячна
 * агрегація їх ігнорує. Вимагає $1=MONEY_ZONE, $2=FC у `params`.
 */
// Конверсія реклами ПО НАПРЯМКУ (Тип запиту) — той самий когортний контракт, що
// conversionAdsByManager (вхід ADZONE → дійшли MONEY_ZONE, ad-new), лише GROUP BY request_type.
export interface DirConversion { key: string; entered: number; won: number; cohortPct: number | null }
export async function conversionAdsByDirection(s: MetricScope, adSources: string[]): Promise<DirConversion[]> {
  const params: unknown[] = [MONEY_ZONE, FC_PIPELINES, ADZONE_TAKEN, adSources];
  const fromRef = (params.push(s.from ?? null), `$${params.length}`);
  const toRef = (params.push(s.to ?? null), `$${params.length}`);
  const r = await pool.query<{ key: string; entered: string; won: string }>(
    `WITH ${dealCohortCte("$3", "$4", "")}
     SELECT COALESCE(pop.request_type, '—') AS key,
            COUNT(*)::int AS entered, COUNT(*) FILTER (WHERE pop.won_at IS NOT NULL)::int AS won
       FROM pop
      WHERE ((${fromRef})::date IS NULL OR (pop.entered_at ${KYIV})::date >= (${fromRef})::date)
        AND ((${toRef})::date IS NULL OR (pop.entered_at ${KYIV})::date <= (${toRef})::date)
      GROUP BY 1`, params);
  return r.rows.map((x) => { const entered = Number(x.entered), won = Number(x.won); return { key: x.key, entered, won, cohortPct: entered >= 10 ? Math.round((won / entered) * 1000) / 10 : null }; });
}

function dealCohortCte(entryRef: string, srcRef: string, scopeWhere: string): string {
  return `adzone AS (
         SELECT kommo_id, MIN(changed_at) AS entered_at
           FROM deal_stage_events WHERE status_id = ANY(${entryRef}) GROUP BY kommo_id
       ),
       won AS (
         SELECT kommo_id, MIN(changed_at) AS won_at
           FROM deal_stage_events WHERE pipeline_id = ANY($2) AND status_id = ANY($1) GROUP BY kommo_id
       ),
       pop AS (
         SELECT a.entered_at, w.won_at, d.manager_id, m.team_id, d.request_type
           FROM adzone a
           JOIN deals d ON d.kommo_id = a.kommo_id
           LEFT JOIN managers m ON m.id = d.manager_id
           LEFT JOIN won w ON w.kommo_id = a.kommo_id
          WHERE ${paidAdSql(srcRef)} AND (${SEGMENT_CASE}) = 'new' ${scopeWhere}
       )`;
}

/**
 * 🎯 ЄДИНЕ ЯДРО КОНВЕРСІЇ (Крок В) — знаменник ВСІХ 4 конверсій формує `entry`,
 * а ЧИСЕЛЬНИК завжди однаковий: із вхідної когорти — скільки БУДЬ-КОЛИ дійшли до
 * **MONEY_ZONE** (`EXPECT_ZONE∪PAID∪{142}`) у Повному циклі, дедуп по зерну.
 *  • `cohort` = зайшли в місяці → з них зрештою дійшли до грошей. Чисельник ⊆
 *    знаменник → стеля ≤100% (математичний інваріант).
 *  • `period` = дійшли до грошей у місяці ÷ зайшли в місяці (різні когорти) → може
 *    перевищувати 100% при зростанні потоку (артефакт когорт, не баг коду).
 * Дозрівання — ЄДИНА формула скрізь: `(кінець міс.+1 міс) ≤ now−90д`; поточний
 * місяць `mature=false` (UI → ⏳). client-grain: чисельник ПІСЛЯ входу
 * (`changed_at >= entered_at`) — інакше стара виграна угода до дотику хибно
 * зараховувалась би. `client_key IS NULL` виключено (немає по чому трекати).
 */
async function conversionByCohort(s: MetricScope, entry: CohortEntry): Promise<ConversionCohortRow[]> {
  const params: unknown[] = [MONEY_ZONE, FC_PIPELINES]; // $1 = MONEY_ZONE (won), $2 = FC pipelines
  let cte: string;

  if (entry.grain === "deal") {
    params.push(entry.entryStatuses);              // $3
    const entryRef = `$${params.length}`;
    params.push(entry.adSources);                  // $4
    const srcRef = `$${params.length}`;
    const scopeConds: string[] = [];
    if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
    if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
    const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";
    cte = dealCohortCte(entryRef, srcRef, scopeWhere); // спільне ядро deal-grain (реклама)
  } else if (entry.kind === "stage") {
    params.push(entry.entryStatuses);              // $3
    const entryRef = `$${params.length}`;
    params.push(entry.entryPipelines);             // $4
    const entryPipeRef = `$${params.length}`;
    const scopeConds: string[] = [];
    if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
    if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
    const scopeJoin = s.teamId ? "LEFT JOIN managers m ON m.id = d.manager_id" : "";
    const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";
    cte = `entered AS (
         SELECT d.client_key, MIN(e.changed_at) AS entered_at
           FROM deal_stage_events e
           JOIN deals d ON d.kommo_id = e.kommo_id ${scopeJoin}
          WHERE e.status_id = ANY(${entryRef}) AND e.pipeline_id = ANY(${entryPipeRef})
            AND d.client_key IS NOT NULL ${scopeWhere}
          GROUP BY d.client_key
       ),
       won AS (
         SELECT en.client_key, MIN(e.changed_at) AS won_at
           FROM entered en
           JOIN deals d ON d.client_key = en.client_key
           JOIN deal_stage_events e ON e.kommo_id = d.kommo_id
          WHERE e.status_id = ANY($1) AND e.pipeline_id = ANY($2) AND e.changed_at >= en.entered_at
          GROUP BY en.client_key
       ),
       pop AS (
         SELECT en.entered_at, w.won_at
           FROM entered en LEFT JOIN won w ON w.client_key = en.client_key
       )`;
  } else {
    // client / transferred — знаменник = передані заявки (leadgen_registry) за
    // transferred_at, ВИКЛЮЧаючи лідоген-команди (передача = лідоген→продажі, а не
    // раунд-робін усередині лідогену). Дедуп по client_key.
    const scopeConds: string[] = ["t.name NOT ILIKE '%лідоген%'", "d.client_key IS NOT NULL"];
    if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
    if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
    const scopeWhere = scopeConds.join(" AND ");
    cte = `entered AS (
         SELECT d.client_key, MIN(lr.transferred_at) AS entered_at
           FROM leadgen_registry lr
           JOIN deals d ON d.kommo_id = lr.lead_id
           JOIN managers m ON m.id = d.manager_id
           JOIN teams t ON t.id = m.team_id
          WHERE ${scopeWhere}
          GROUP BY d.client_key
       ),
       won AS (
         SELECT en.client_key, MIN(e.changed_at) AS won_at
           FROM entered en
           JOIN deals d ON d.client_key = en.client_key
           JOIN deal_stage_events e ON e.kommo_id = d.kommo_id
          WHERE e.status_id = ANY($1) AND e.pipeline_id = ANY($2) AND e.changed_at >= en.entered_at
          GROUP BY en.client_key
       ),
       pop AS (
         SELECT en.entered_at, w.won_at
           FROM entered en LEFT JOIN won w ON w.client_key = en.client_key
       )`;
  }

  const r = await pool.query<{
    ym: string; entered: string; won_eventually: string; won_in_month: string; mature: boolean;
  }>(
    `WITH ${cte},
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

/**
 * `conversion_ads` помісячно (GLOSSARY §2b) — тонка обгортка над `conversionByCohort`
 * (deal-grain по `kommo_id`). Знаменник: платні нові ліди, що зайшли в ADZONE_TAKEN.
 * Чисельник (Крок В): їхній `kommo_id` дійшов до MONEY_ZONE у Повному циклі (не
 * лише 142 — тепер уся зона визнання грошей). Скоуп — той самий MetricScope.
 */
export async function conversionAdsByMonth(s: MetricScope, adSources: string[]): Promise<ConversionAdsRow[]> {
  return conversionByCohort(s, { grain: "deal", entryStatuses: ADZONE_TAKEN, adSources });
}

/**
 * `conversion_leadgen` (Огляд, рішення Крок В #4): когорта ПЕРЕДАНИХ заявок за
 * `transferred_at` (client-grain) → скільки client_key дійшли до MONEY_ZONE у
 * Повному циклі. Замінює стару period-ratio (передано÷успіх «як зараз»): тепер
 * когортна, стеля ≤100%, ⏳ до дозрівання, entered<10 → «—» (на рівні агрегатора).
 */
export const conversionTransferredByMonth = (s: MetricScope): Promise<ConversionCohortRow[]> =>
  conversionByCohort(s, { grain: "client", kind: "transferred" });

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
 * згрупованим запитом (не N викликів помісячної) через СПІЛЬНЕ ядро `dealCohortCte`
 * — ТОЙ САМИЙ чисельник, що й Огляд/помісячна (Крок В): рейтинг менеджерів
 * збігається з Оглядом до одного коду. Когорта: платні нові ліди, що зайшли в
 * рекламну зону в [from,to] → з них дійшли до MONEY_ZONE у Повному циклі (той
 * самий kommo_id). Стеля ≤100% (won ⊆ entered). entered<10 → cohortPct=null.
 */
export async function conversionAdsByManager(s: MetricScope, adSources: string[]): Promise<MgrConversion[]> {
  // $1 MONEY_ZONE (won), $2 FC, $3 ADZONE (вхід), $4 adSources — контракт dealCohortCte.
  const params: unknown[] = [MONEY_ZONE, FC_PIPELINES, ADZONE_TAKEN, adSources];
  const scopeConds: string[] = [];
  if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
  const fromRef = (params.push(s.from ?? null), `$${params.length}`);
  const toRef = (params.push(s.to ?? null), `$${params.length}`);
  const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";

  const r = await pool.query<{ manager_id: number; name: string; team_id: number | null; entered: string; won: string }>(
    `WITH ${dealCohortCte("$3", "$4", scopeWhere)}
     SELECT mm.id AS manager_id, mm.name, mm.team_id,
            COUNT(*)::int AS entered, COUNT(*) FILTER (WHERE pop.won_at IS NOT NULL)::int AS won
       FROM pop JOIN managers mm ON mm.id = pop.manager_id
      WHERE ((${fromRef})::date IS NULL OR (pop.entered_at ${KYIV})::date >= (${fromRef})::date)
        AND ((${toRef})::date IS NULL OR (pop.entered_at ${KYIV})::date <= (${toRef})::date)
      GROUP BY mm.id, mm.name, mm.team_id`,
    params
  );
  return r.rows.map((x) => {
    const entered = Number(x.entered), won = Number(x.won);
    return { managerId: x.manager_id, name: x.name, teamId: x.team_id, entered, won,
      cohortPct: entered >= 10 ? Math.round((won / entered) * 1000) / 10 : null };
  });
}

export interface TeamConversion { teamId: number | null; entered: number; won: number; cohortPct: number | null }

/**
 * `conversion_ads` ПО КОМАНДІ (РНК) — РОЛАП per-manager (Крок Г #3), тому Σ мгр =
 * команда ЗА ПОБУДОВОЮ. Той самий чисельник MONEY_ZONE / знаменник, що й Огляд і
 * per-manager. cohortPct рахується на СУМАХ команди (не середнє відсотків),
 * entered<10 → null. Additive: Σ команд = відділ (бо Σ мгр = відділ, доведено Крок В).
 */
export async function conversionAdsByTeam(s: MetricScope, adSources: string[]): Promise<TeamConversion[]> {
  const mgrs = await conversionAdsByManager(s, adSources);
  const byTeam = new Map<number | null, { entered: number; won: number }>();
  for (const r of mgrs) {
    const e = byTeam.get(r.teamId) ?? { entered: 0, won: 0 };
    e.entered += r.entered; e.won += r.won; byTeam.set(r.teamId, e);
  }
  return [...byTeam.entries()].map(([teamId, v]) => ({
    teamId, entered: v.entered, won: v.won,
    cohortPct: v.entered >= 10 ? Math.round((v.won / v.entered) * 1000) / 10 : null,
  }));
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

interface HandoffRow { ym: string; entered: number; handoffEventually: number; handoffInMonth: number; mature: boolean }

/**
 * HANDOFF (Крок В — ОКРЕМА під-метрика, НЕ headline-конверсія): зайшли в entry
 * → дійшли до 142 у СВОЇЙ воронці (`entryPipelines`) = «прорахунок отримано /
 * передано у продажі». Термінальна ВЛАСНА воронка лідогену — money-межу
 * (MONEY_ZONE) на неї НЕ накладаємо; won (наскрізь до грошей FC) рахує
 * `conversionByCohort`. ДЕДУП по `client_key`. Чисельник ПІСЛЯ входу
 * (`changed_at >= entered_at`). Той самий `entered`, що й у `conversionByCohort`
 * (client/stage) → знаменники збігаються при злитті (`mergeLeadgen`).
 */
async function handoffByMonth(
  s: MetricScope,
  cfg: { entryPipelines: number[]; entryStatus: number }
): Promise<HandoffRow[]> {
  // $1 = entryPipelines (handoff-142 теж тут), $2 = entryStatus, $3 = 142
  const params: unknown[] = [cfg.entryPipelines, cfg.entryStatus, STATUS_142];
  const scopeConds: string[] = [];
  if (s.managerId) { params.push(s.managerId); scopeConds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); scopeConds.push(`m.team_id = $${params.length}`); }
  const scopeJoin = s.teamId ? "LEFT JOIN managers m ON m.id = d.manager_id" : "";
  const scopeWhere = scopeConds.length ? "AND " + scopeConds.join(" AND ") : "";

  const r = await pool.query<{
    ym: string; entered: string; handoff_eventually: string; handoff_in_month: string; mature: boolean;
  }>(
    `WITH entered AS (
       SELECT d.client_key, MIN(e.changed_at) AS entered_at
         FROM deal_stage_events e
         JOIN deals d ON d.kommo_id = e.kommo_id ${scopeJoin}
        WHERE e.status_id = $2 AND e.pipeline_id = ANY($1) AND d.client_key IS NOT NULL ${scopeWhere}
        GROUP BY d.client_key
     ),
     handoff AS (
       SELECT en.client_key, MIN(e.changed_at) AS handoff_at
         FROM entered en
         JOIN deals d ON d.client_key = en.client_key
         JOIN deal_stage_events e ON e.kommo_id = d.kommo_id
        WHERE e.status_id = $3 AND e.pipeline_id = ANY($1) AND e.changed_at >= en.entered_at
        GROUP BY en.client_key
     ),
     pop AS (
       SELECT en.entered_at, h.handoff_at
         FROM entered en LEFT JOIN handoff h ON h.client_key = en.client_key
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
       COUNT(*) FILTER (WHERE p.handoff_at IS NOT NULL
                          AND date_trunc('month', (p.handoff_at ${KYIV})) = mo.m)::int AS handoff_in_month,
       ((mo.m + INTERVAL '1 month') <= (now() ${KYIV}) - INTERVAL '90 days') AS mature
     FROM months mo LEFT JOIN pop p ON TRUE
     GROUP BY mo.m ORDER BY mo.m`,
    params
  );
  return r.rows.map((x) => ({
    ym: x.ym,
    entered: Number(x.entered),
    handoffEventually: Number(x.handoff_eventually),
    handoffInMonth: Number(x.handoff_in_month),
    mature: x.mature,
  }));
}

/**
 * Зливає won-когорту (наскрізь до MONEY_ZONE, з `conversionByCohort`) + handoff
 * (термінал власної воронки, з `handoffByMonth`) у `LeadgenConversionRow`.
 * Знаменник = `won.entered` (той самий entered у обох джерел). Стеля ≤100%.
 */
function mergeLeadgen(won: ConversionCohortRow[], handoff: HandoffRow[]): LeadgenConversionRow[] {
  const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  const hByYm = new Map(handoff.map((h) => [h.ym, h]));
  return won.map((w) => {
    const h = hByYm.get(w.ym);
    const he = h?.handoffEventually ?? 0, hm = h?.handoffInMonth ?? 0;
    return {
      ym: w.ym, entered: w.entered,
      handoffEventually: he, handoffCohortPct: pct(he, w.entered),
      wonEventually: w.wonEventually, wonCohortPct: w.cohortPct,
      handoffInMonth: hm, handoffPeriodPct: pct(hm, w.entered),
      wonInMonth: w.wonInMonth, wonPeriodPct: w.periodPct,
      mature: w.mature,
    };
  });
}

/**
 * `conversion_prodzvin` (рішення 6.4 + Крок В). Холодний Продзвін (8921936/7337048),
 * entry «ВЗЯТО В РОБОТУ» 69693696. **won** (headline) = client_key дійшов до
 * MONEY_ZONE у Повному циклі (наскрізь, `conversionByCohort`); **handoff** (окрема
 * під-метрика) = дійшов до Продзвін-142 у своїй воронці (`handoffByMonth`).
 */
export const conversionProdzvinByMonth = async (s: MetricScope): Promise<LeadgenConversionRow[]> => {
  const [won, handoff] = await Promise.all([
    conversionByCohort(s, { grain: "client", kind: "stage", entryStatuses: [PZ_TAKEN], entryPipelines: PRODZVIN_PIPELINES }),
    handoffByMonth(s, { entryPipelines: PRODZVIN_PIPELINES, entryStatus: PZ_TAKEN }),
  ]);
  return mergeLeadgen(won, handoff);
};

/**
 * `conversion_reactivation` (рішення 6.5 + Крок В). Реактивація (8921948), entry
 * «Клієнт підігрівається» 69693740. **won** (headline) = client_key дійшов до
 * MONEY_ZONE у Повному циклі; **handoff** = 142 «Відправлено у відділ продажів»
 * у своїй воронці. Категорії відмов не фільтруємо.
 */
export const conversionReactivationByMonth = async (s: MetricScope): Promise<LeadgenConversionRow[]> => {
  const [won, handoff] = await Promise.all([
    conversionByCohort(s, { grain: "client", kind: "stage", entryStatuses: [REACT_WARMING], entryPipelines: REACTIVATION_PIPELINES }),
    handoffByMonth(s, { entryPipelines: REACTIVATION_PIPELINES, entryStatus: REACT_WARMING }),
  ]);
  return mergeLeadgen(won, handoff);
};

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
 * Спільний скоуп боргу. Неатрибутований борг (manager_id NULL) НЕ ховається
 * (LEFT JOIN, без `IS NOT NULL`) — «Без менеджера» (гол. ПВК АРСЕНАЛ) Є в
 * гугл-таблиці, лише немапнутий у нас, тож лишається в тоталі.
 * 🔴 ЗМІНА (рішення власника 17.07, РЕВЕРС 1:1-фіксу): тотал дебіторки = УСЕ, що є
 * у безнал-таблиці (`source='sheet'`, вкл. «Без менеджера») + готівка МГЕР з CRM
 * (`source='cash'`, insertCashReceivables). Source-фільтр прибрано → готівка входить
 * і в тотал, і в усі розрізи (по клієнту/менеджеру/команді) окремим рядком
 * «МГЕР (готівка)» → тотал == сумі видимих рядків. Готівка лишається доступною
 * під-рядком через `receivablesCash` («з них готівка»). Очік. тотал: 11 502 569
 * (безнал 11 314 369 + готівка МГЕР 188 200).
 */
function debtWhere(s: SnapshotScope): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (s.managerId) { params.push(s.managerId); conds.push(`r.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return { where, params };
}

/** Готівкова дебіторка з CRM (`source='cash'`) — під-рядок «з них готівка»
 *  (МГЕР). ВХОДИТЬ у `receivablesTotal`; тут віддається окремо лише для підпису. */
export async function receivablesCash(s: SnapshotScope): Promise<number> {
  const params: unknown[] = [];
  const conds: string[] = ["r.source = 'cash'"];
  if (s.managerId) { params.push(s.managerId); conds.push(`r.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(r.amount), 0) AS total FROM receivables r LEFT JOIN managers m ON m.id = r.manager_id WHERE ${conds.join(" AND ")}`,
    params
  );
  return Number(r.rows[0]?.total ?? 0);
}

/** Загальний борг «станом на зараз» = `SUM(receivables.amount)` уся безнал-таблиця
 *  (`source='sheet'`, вкл. «Без менеджера») + готівка МГЕР з CRM (`source='cash'`).
 *  Готівка також доступна окремо через `receivablesCash` (під-рядок «з них готівка»). */
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

export interface StuckGroupDeal {
  kommoId: number; name: string; client: string | null; price: number;
  stage: string; days: number; activityDays: number | null;
  lastCallAt: string | null;        // ISO дата останнього дзвінка клієнту (null = не було)
  daysSinceLastCall: number | null; // днів від останнього дзвінка (null = не було)
  noCallFlag: boolean;              // «метушня без контакту»: свіжа активність, але місяць без дзвінка
}
export interface StuckManagerGroup {
  managerId: number; manager: string; teamId: number | null; teamName: string | null;
  count: number; sumAtRisk: number; longestIdleDays: number; deals: StuckGroupDeal[];
}
export interface StuckGrouped {
  total: number; sumRisk: number; managers: number; over90: number; groups: StuckManagerGroup[];
}

/**
 * Застряглі угоди ЗГРУПОВАНІ по менеджерах (переробка секції, рішення власника 24.07):
 *   • Критерій «без руху понад поріг у БУДЬ-ЯКІЙ відкритій стадії включно з «Авто працює»;
 *     виключено paid/успіх/злив; анкер = остання активність; signed price — сторно НЕ виключаємо»,
 *     БЕЗ `LIMIT` → повний набір.
 *   • 🎯 ТИП КОМАНДИ (рішення власника 24.07): РНК — усі застряглі; РПК/Самостійний (не-РНК) —
 *     ЛИШЕ лідген-угоди (`lead_channel='leadgen'`). Через це набір на проді ~270 (РНК 233 +
 *     РПК/Самост-лідген 37), а НЕ ~600. Це свідома РОЗБІЖНІСТЬ із легасі `stuckDeals` — там
 *     team-type-фільтра немає; НЕ «ресинкати» WHERE назад.
 *   • Групування по менеджеру: {count, sumAtRisk(signed), longestIdleDays, deals[]} +
 *     company-summary {total, sumRisk, managers, over90}. Σ(deals по групах) == total (інваріант
 *     за побудовою — групуємо ту саму плоску вибірку). Групи сортуються за к-стю (як макет).
 *   • Роль-клампи — у роуті (manager→own, team_lead→team, admin→all), як у `stuckDeals`.
 */
export async function stuckDealsGrouped(s: SnapshotScope, minDays = 7): Promise<StuckGrouped> {
  const md = Math.max(1, minDays);
  const AVTO = `d.status_id = ANY($2)`;
  const ACT = "COALESCE(d.last_activity_at, d.created_at_kommo)";
  const params: unknown[] = [FC_PIPELINES, AVTO_STATUSES, md];
  const conds = [
    "d.pipeline_id = ANY($1)",
    "psm.funnel_stage <> 'paid'",
    `now() - ${ACT} >= (CASE WHEN (${AVTO} OR psm.funnel_stage = 'invoiced') THEN $3 ELSE $3*3 END || ' days')::interval`,
    "d.created_at_kommo >= now() - interval '180 days'",
    `(${AVTO} OR psm.funnel_stage = 'invoiced' OR d.last_activity_at IS NOT NULL)`,
    commercialManagerSql("m"), // 🔒 СТРОГО: лише комерційні менеджери (не лідген/фінанси/без команди), незалежно від скоупу
    // 🎯 Тип команди (рішення власника 24.07): РНК — усі застряглі; РПК/Самостійний (не-РНК) —
    //    лише лідген-угоди (lead_channel='leadgen'). Реюз rnkTeamSql (без хардкоду ID).
    `(${rnkTeamSql("m")} OR (NOT ${rnkTeamSql("m")} AND d.lead_channel = 'leadgen'))`,
  ];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ kommo_id: string; name: string; client: string | null; price: string;
    manager_id: number; manager: string; team_id: number | null; team_name: string | null;
    stage: string; days: string; activity_days: string | null;
    last_call_at: Date | null; days_since_last_call: string | null; no_call_flag: boolean }>(
    `SELECT d.kommo_id, d.name, d.client_name AS client, d.price,
            m.id AS manager_id, m.name AS manager, m.team_id, t.name AS team_name,
            CASE WHEN ${AVTO} THEN 'Авто працює'
                 WHEN psm.funnel_stage IN ('lead_taken','quote_requested','approved') THEN 'Взято в роботу'
                 WHEN psm.funnel_stage = 'invoiced' THEN 'Виставлено рахунок' END AS stage,
            EXTRACT(DAY FROM now() - ${ACT})::int AS days,
            EXTRACT(DAY FROM now() - d.last_activity_at)::int AS activity_days,
            d.last_call_at,
            EXTRACT(DAY FROM now() - d.last_call_at)::int AS days_since_last_call,
            -- «метушня без контакту»: свіжа активність (<30д) АЛЕ дзвінка не було / місяць без дзвінка (≥30д)
            (   (d.last_call_at IS NULL OR now() - d.last_call_at >= interval '30 days')
                AND d.last_activity_at IS NOT NULL
                AND now() - d.last_activity_at < interval '30 days' ) AS no_call_flag
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     LEFT JOIN teams t ON t.id = m.team_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${conds.join(" AND ")}
     ORDER BY days DESC`,
    params
  );
  const map = new Map<number, StuckManagerGroup>();
  let sumRisk = 0, over90 = 0;
  for (const x of r.rows) {
    const price = Number(x.price), days = Number(x.days);
    sumRisk += price;
    if (days >= 90) over90++;
    let g = map.get(x.manager_id);
    if (!g) { g = { managerId: x.manager_id, manager: x.manager, teamId: x.team_id, teamName: x.team_name, count: 0, sumAtRisk: 0, longestIdleDays: 0, deals: [] }; map.set(x.manager_id, g); }
    g.count++; g.sumAtRisk += price; g.longestIdleDays = Math.max(g.longestIdleDays, days);
    g.deals.push({ kommoId: Number(x.kommo_id), name: x.name, client: x.client, price, stage: x.stage, days, activityDays: x.activity_days == null ? null : Number(x.activity_days),
      lastCallAt: x.last_call_at == null ? null : new Date(x.last_call_at).toISOString(),
      daysSinceLastCall: x.days_since_last_call == null ? null : Number(x.days_since_last_call),
      noCallFlag: x.no_call_flag === true });
  }
  const groups = [...map.values()].sort((a, b) => b.count - a.count || b.longestIdleDays - a.longestIdleDays);
  return { total: r.rows.length, sumRisk, managers: groups.length, over90, groups };
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
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
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
 * «Очікування надходжень» для звіту — САМОДОСТАТНІЙ блок із CRM, ПОВНІСТЮ окремий
 * від дебіторки (жодного зв'язку/дублювання боргу; дебіторка — інше джерело).
 * ЗНІМОК поточної грошової зони (виставлено рахунок → очікуємо оплату, ще не
 * оплачено), сума `price` (бюджет — рішення власника: безнал і готівка однаково,
 * НЕ приход). Бакети — суто за МІСЯЦЕМ поля `planned_payment_at` (Kommo 2097273,
 * «Запланована дата оплати»), розбивка ПОКРИВАЄ всю зону без залишку:
 *   • overdue   — планова дата в МИНУЛОМУ місяці (< поточного). Протерміновані:
 *                 гроші ще не прийшли, але це ОЧІКУВАННЯ з CRM, НЕ борг. Видима картка.
 *   • thisMonth — планова дата у ПОТОЧНОМУ місяці (ВЕСЬ календарний місяць, вкл. дні,
 *                 що вже минули — «протерміновано на кілька днів» ≠ борг рівня минулих міс);
 *   • nextMonth — планова дата в наступному місяці;
 *   • later     — планова дата далі за наступний місяць;
 *   • noDate    — у зоні, але дата не заповнена.
 * `total` = уся зона; за побудовою total = overdue+thisMonth+nextMonth+later+noDate
 * (чотири видимі числа + noDate сходяться в загальне без залишку). Дедуп інерентний
 * (1 рядок = 1 угода). Знімок → SnapshotScope (дати заборонені на рівні типу).
 */
// Грошова зона = від «Виставлення рахунку» ДО «Оплата отримана» = 5 стадій (рішення
// власника): New(8921932) Виставлення рахунку 100274340 · Авто працює 69716300 ·
// Перевезення завершено 98470988 · Дзвінок після розвантаж. 69716304 · Очікуємо
// оплату 69716312. + старі 155304 еквіваленти (легасі, ~0 поточних). Раніше було
// лише 3 (пропущено Авто працює/Перевезення завершено) → зона занижена на ~160 угод.
export const EXPECT_ZONE = [100274340, 69716300, 98470988, 69716304, 69716312, 10937178, 42639144, 42639147, 25044997, 62940068];

/**
 * 🎯 MONEY_ZONE — межа ЧИСЕЛЬНИКА конверсій (рішення власника Крок В). Угода
 * «дійшла до грошей» = потрапила в зону визнання доходу (`EXPECT_ZONE`) АБО
 * «Оплата отримана» (STAGE_PAID 69716460/60412544) АБО «Успішна» (142). Це
 * ЄДИНА money-межа наскрізного `won` для ВСІХ 4 конверсій (реклама / продзвін /
 * реактивація / лідоген-передачі) — ширша за саме-142, тож нова конверсія ≥
 * старої (142-only), а стеля лишається ≤100% (won ⊆ entered).
 * ⚠️ Це НЕ money-СУМА (суми виручки — виключно `core/money.ts`): MONEY_ZONE лише
 * відповідає на «дійшов / не дійшов угода до грошей», а не «скільки грошей».
 * Порядок визначення (після EXPECT_ZONE) — щоб уникнути TDZ: конверсії читають
 * MONEY_ZONE лише у тілі async-функцій (call-time), не при оцінці модуля.
 */
export const MONEY_ZONE = [...EXPECT_ZONE, 69716460, 60412544, 142];

// «Авто працює» — New 8921932 → 69716300; Old 155304 → 10937178 (обидва ⊆ EXPECT_ZONE).
export const AUTO_WORKING = [69716300, 10937178];

export interface ReachedAutoChan { ad: number; leadgen: number }
/**
 * ЛАЙФТАЙМ-ЧИСЕЛЬНИК конверсії РНК/РПК (Варіант A — ЧЕСНА ВОРОНКА: чисельник ТОГО САМОГО
 * каналу, що знаменник). Угоди, що БУДЬ-КОЛИ досягли «авто працює» (подія у
 * `deal_stage_events` зі status_id ∈ AUTO_WORKING), за ВЕСЬ ЧАС, ПО МЕНЕДЖЕРУ, РОЗБИТІ ПО
 * КАНАЛУ:
 *   • `ad`      — рекламна угода (`adDealSql`) → пара до знаменника adsAccepted (РНК);
 *   • `leadgen` — `lead_channel='leadgen'`      → пара до знаменника leadgen (РПК).
 * Active-only (як знаменники) → num ⊆ den → командна конверсія ≤100%. Дедуп по `kommo_id`.
 * Команда = Σ менеджерів (Σ-інваріант). `adSources` — канонічний список рекламних джерел.
 */
export async function reachedAutoByManager(adSources: string[]): Promise<Map<number, ReachedAutoChan>> {
  const ad = adDealSql("$3");
  const r = await pool.query<{ manager_id: number; ad: string; leadgen: string }>(
    `SELECT d.manager_id,
            COUNT(DISTINCT d.kommo_id) FILTER (WHERE ${ad}) ad,
            COUNT(DISTINCT d.kommo_id) FILTER (WHERE d.lead_channel = 'leadgen') leadgen
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE d.pipeline_id = ANY($1)
        AND EXISTS (SELECT 1 FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id AND e.status_id = ANY($2))
      GROUP BY d.manager_id`, [FC_PIPELINES, AUTO_WORKING, adSources]);
  return new Map(r.rows.map((x) => [x.manager_id, { ad: Number(x.ad), leadgen: Number(x.leadgen) }]));
}

export interface MgrRepeatForecast { managerId: number; forecast: number; clients: number }
/** Вікно прогнозу по постійних, КАЛЕНДАРНИХ місяців (поточний неповний виключено). */
export const REPEAT_FORECAST_MONTHS = 6;
/**
 * ПРОГНОЗ ПО ПОСТІЙНИХ, сума по менеджеру (рекомендація «скільки лідів треба»).
 *
 * 🔴 ФОРМУЛА (виправлено 30.07.2026): внесок клієнта = його виторг за N КАЛЕНДАРНИХ
 * місяців ÷ N. ПОРОЖНІ МІСЯЦІ ВХОДЯТЬ У ЗНАМЕННИК — це очікуваний внесок У МІСЯЦЬ,
 * а не «скільки платить, коли платить».
 *
 * Було: середнє по 3 АКТИВНИХ місяцях (порожні викидались) — і клієнт, що замовляє раз
 * на 3 міс по 30к, рахувався як 30к/міс замість 10к/міс. По десятках клієнтів це давало
 * нереальні суми. Звірка з фактом (прод, 30.07.2026) — прогноз проти реального
 * середньомісячного виторгу від постійних:
 *     Дмитрук    758 720 проти 227 859 → ×3.33      Самохвалов 499 938 проти 275 863 → ×1.81
 *     Шаврова    253 135 проти  63 084 → ×4.01      Андрусенко 144 848 проти  21 843 → ×6.63
 * Причина видна в ритмі: у Дмитрука з 57 постійних лише 5 замовляють щомісяця, а 42 —
 * періодично (2-4 активні місяці з 13). Саме їх стара формула рахувала як щомісячних.
 *
 * Тепер Σ прогнозів менеджера ДОРІВНЮЄ його фактичному середньомісячному виторгу від
 * постійних за вікно — не «приблизно», а тотожно, за побудовою (Σ(виторг_клієнта)/N =
 * Σвиторг/N). Це і є гейт чесності.
 * «Постійний» = ≥2 активні місяці У ТОМУ Ж вікні (щоб чисельник і знаменник збігались).
 */
export async function repeatForecastByManager(s: MetricScope = {}, months = REPEAT_FORECAST_MONTHS): Promise<MgrRepeatForecast[]> {
  const N = Math.max(1, months);
  const params: unknown[] = [FC_PIPELINES];
  const conds = [
    "d.status_id = 142", "d.pipeline_id = ANY($1)",
    "d.closed_at_kommo IS NOT NULL", "d.client_key IS NOT NULL",
    // вікно = N ПОВНИХ календарних місяців до поточного; поточний неповний виключено,
    // інакше на початку місяця прогноз штучно провалювався б.
    `(d.closed_at_kommo ${KYIV}) >= date_trunc('month', CURRENT_DATE) - INTERVAL '${N} months'`,
    `(d.closed_at_kommo ${KYIV}) <  date_trunc('month', CURRENT_DATE)`,
  ];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ manager_id: number; forecast: string; clients: string }>(
    `WITH won AS (
        SELECT d.manager_id, d.client_key,
               date_trunc('month', (d.closed_at_kommo ${KYIV})) AS mth,
               SUM(d.price) AS rev
          FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
         WHERE ${conds.join(" AND ")}
         GROUP BY 1, 2, 3
        HAVING SUM(d.price) > 0),
      per_client AS (
        SELECT manager_id, client_key,
               SUM(rev) / ${N}::numeric AS monthly_share,   -- порожні місяці У ЗНАМЕННИКУ
               COUNT(*) AS active_months
          FROM won GROUP BY 1, 2)
     SELECT manager_id, COALESCE(SUM(monthly_share), 0) AS forecast, COUNT(*) AS clients
       FROM per_client WHERE active_months >= 2
      GROUP BY manager_id`,
    params
  );
  return r.rows.map((x) => ({
    managerId: x.manager_id, forecast: Math.round(Number(x.forecast)), clients: Number(x.clients),
  }));
}

/**
 * `conversion_leadgen` ПО МЕНЕДЖЕРУ (пара до `conversionAdsByManager`, для РПК).
 * Побудовано ЗА ЗРАЗКОМ лайфтайм-конверсії РПК (Варіант A, `reachedAutoByManager`) —
 * когорту й чисельник не винаходимо заново:
 *   знаменник — лідоген-заявки менеджера (`leadgen_touch` за `transfer_date` у періоді,
 *               DISTINCT lead_kommo_id — той самий вираз, що в `leadgenByManager`);
 *   чисельник — ТІ САМІ заявки, чия угода БУДЬ-КОЛИ досягла «авто працює»
 *               (`deal_stage_events.status_id ∈ AUTO_WORKING`).
 * Чисельник ⊆ знаменника ЗА ПОБУДОВОЮ (фільтр над тим самим набором) → конверсія ≤100%
 * без окремого клампа. entered<10 → cohortPct=null (як у рекламній).
 */
export async function conversionLeadgenByManager(s: MetricScope): Promise<MgrConversion[]> {
  const params: unknown[] = [AUTO_WORKING];
  const conds = ["d.manager_id IS NOT NULL"];
  if (s.from) { params.push(s.from); conds.push(`lt.transfer_date >= $${params.length}`); }
  if (s.to) { params.push(s.to); conds.push(`lt.transfer_date <= $${params.length}`); }
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ manager_id: number; name: string; team_id: number | null; entered: string; won: string }>(
    `SELECT d.manager_id, m.name, m.team_id,
            COUNT(DISTINCT lt.lead_kommo_id) AS entered,
            COUNT(DISTINCT lt.lead_kommo_id) FILTER (
              WHERE EXISTS (SELECT 1 FROM deal_stage_events e
                             WHERE e.kommo_id = d.kommo_id AND e.status_id = ANY($1))) AS won
       FROM leadgen_touch lt
       JOIN deals d ON d.kommo_id = lt.lead_kommo_id
       JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE ${conds.join(" AND ")}
      GROUP BY d.manager_id, m.name, m.team_id`,
    params
  );
  return r.rows.map((x) => {
    const entered = Number(x.entered), won = Number(x.won);
    return { managerId: x.manager_id, name: x.name, teamId: x.team_id, entered, won,
      cohortPct: entered >= 10 ? Math.round((won / entered) * 1000) / 10 : null };
  });
}

export interface MgrMaxLeads { ad: number; leadgen: number }
/**
 * ІСТОРИЧНИЙ МАКСИМУМ лідів за місяць по менеджеру (за останні `months` місяців), окремо
 * по каналах. Потрібен, щоб позначити рекомендацію «треба N лідів» як НЕДОСЯЖНУ, коли N
 * більший за все, що менеджер брав у найкращий місяць: арифметично цифра правильна, але
 * читати її як ціль не можна — це сигнал «план не забезпечений структурою», а не завдання.
 *
 * Знаменники — ТІ САМІ, що в конверсіях (інакше порівнювали б різні сутності):
 *   • ad      — вхід у рекламну зону (`ADZONE_TAKEN`), платний новий лід (`paidAdSql`+SEGMENT='new'),
 *               помісячно за датою входу — тобто знаменник `conversionAdsByManager`;
 *   • leadgen — `leadgen_touch` за `transfer_date` — знаменник `conversionLeadgenByManager`.
 * Поточний (неповний) місяць ВИКЛЮЧЕНО: інакше максимум занижувався б у першій половині
 * місяця й позначка спрацьовувала б хибно.
 */
export async function maxMonthlyLeadsByManager(adSources: string[], months = 6): Promise<Map<number, MgrMaxLeads>> {
  const since = `date_trunc('month', CURRENT_DATE) - INTERVAL '${Math.max(1, months)} months'`;
  const curMonth = `date_trunc('month', CURRENT_DATE)`;
  const [adRes, lgRes] = await Promise.all([
    pool.query<{ manager_id: number; mx: string }>(
      `WITH adzone AS (
          SELECT kommo_id, MIN(changed_at) AS entered_at
            FROM deal_stage_events WHERE status_id = ANY($1) GROUP BY kommo_id),
        pop AS (
          SELECT d.manager_id, date_trunc('month', (a.entered_at ${KYIV})) AS mth, a.kommo_id
            FROM adzone a
            JOIN deals d ON d.kommo_id = a.kommo_id
            JOIN managers m ON m.id = d.manager_id AND m.is_active
           WHERE ${paidAdSql("$2")} AND (${SEGMENT_CASE}) = 'new'
             AND (a.entered_at ${KYIV}) >= ${since} AND (a.entered_at ${KYIV}) < ${curMonth}),
        per_month AS (
          SELECT manager_id, mth, COUNT(DISTINCT kommo_id) AS n FROM pop GROUP BY 1, 2)
       SELECT manager_id, MAX(n) AS mx FROM per_month GROUP BY manager_id`,
      [ADZONE_TAKEN, adSources]),
    pool.query<{ manager_id: number; mx: string }>(
      `WITH per_month AS (
          SELECT d.manager_id, date_trunc('month', lt.transfer_date) AS mth,
                 COUNT(DISTINCT lt.lead_kommo_id) AS n
            FROM leadgen_touch lt
            JOIN deals d ON d.kommo_id = lt.lead_kommo_id
            JOIN managers m ON m.id = d.manager_id AND m.is_active
           WHERE lt.transfer_date >= ${since} AND lt.transfer_date < ${curMonth}
           GROUP BY 1, 2)
       SELECT manager_id, MAX(n) AS mx FROM per_month GROUP BY manager_id`),
  ]);
  const out = new Map<number, MgrMaxLeads>();
  const put = (id: number, k: "ad" | "leadgen", v: number) => {
    const e = out.get(id) ?? { ad: 0, leadgen: 0 };
    e[k] = v; out.set(id, e);
  };
  for (const x of adRes.rows) put(x.manager_id, "ad", Number(x.mx));
  for (const x of lgRes.rows) put(x.manager_id, "leadgen", Number(x.mx));
  return out;
}

export interface ExpectedBucket { deals: number; sum: number }
export interface ExpectedPaymentsByPlanned {
  total: ExpectedBucket;
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
  // Бакети СУТО за МІСЯЦЕМ планової дати (по-київськи), взаємовиключні й покривають
  // усю зону → total = сума бакетів без залишку. Дні, що минули В ПОТОЧНОМУ місяці,
  // лишаються в thisMonth (не «борг»); overdue = лише МИНУЛІ місяці.
  const curYm = `to_char((now() ${KYIV}), 'YYYY-MM')`;
  const nextYm = `to_char((now() ${KYIV}) + INTERVAL '1 month', 'YYYY-MM')`;
  const pYm = `to_char((d.planned_payment_at ${KYIV}), 'YYYY-MM')`;
  const HAS = "d.planned_payment_at IS NOT NULL";
  const r = await pool.query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE ${HAS} AND ${pYm} < ${curYm})::int overdue_n,
       COALESCE(sum(d.price) FILTER (WHERE ${HAS} AND ${pYm} < ${curYm}),0) overdue_s,
       count(*) FILTER (WHERE ${HAS} AND ${pYm} = ${curYm})::int this_n,
       COALESCE(sum(d.price) FILTER (WHERE ${HAS} AND ${pYm} = ${curYm}),0) this_s,
       count(*) FILTER (WHERE ${HAS} AND ${pYm} = ${nextYm})::int next_n,
       COALESCE(sum(d.price) FILTER (WHERE ${HAS} AND ${pYm} = ${nextYm}),0) next_s,
       count(*) FILTER (WHERE ${HAS} AND ${pYm} > ${nextYm})::int later_n,
       COALESCE(sum(d.price) FILTER (WHERE ${HAS} AND ${pYm} > ${nextYm}),0) later_s,
       count(*) FILTER (WHERE d.planned_payment_at IS NULL)::int nodate_n,
       COALESCE(sum(d.price) FILTER (WHERE d.planned_payment_at IS NULL),0) nodate_s,
       count(*)::int total_n,
       COALESCE(sum(d.price),0) total_s
     FROM deals d LEFT JOIN managers m ON m.id = d.manager_id ${activeJoin}
     WHERE ${conds.join(" AND ")}`,
    params
  );
  const x = r.rows[0] ?? {};
  const b = (n: string, sum: string): ExpectedBucket => ({ deals: Number(x[n] ?? 0), sum: Number(x[sum] ?? 0) });
  return {
    total: b("total_n", "total_s"),
    thisMonth: b("this_n", "this_s"),
    nextMonth: b("next_n", "next_s"),
    overdue: b("overdue_n", "overdue_s"),
    later: b("later_n", "later_s"),
    noDate: b("nodate_n", "nodate_s"),
  };
}

export interface CarryoverResult { amount: number; deals: number }

/**
 * «Перенесені» (carried-over) угоди — ДЕТЕРМІНОВАНА реконструкція з `deal_stage_events`:
 * стан стадії КОЖНОЇ угоди на 00:00 дня-1 місяця `monthStart` (київський), відфільтрований
 * по ТІЙ САМІЙ грошовій зоні `EXPECT_ZONE`, що й `expectedPaymentsByPlanned` (та сама
 * константа, не копія списку стадій). Без фріз-таблиць → одне відтворюване число, без
 * дрейфу від рестартів. Замінює `monthly_carryover` / `monthly_carryover_mgr` (обидві
 * корумпувались startup-знімком: dept-рядок морозився цілим, `_mgr` ріс per-manager на
 * кожному рестарті). `monthStart` = 'YYYY-MM-01'. Зріз відділ→команда→менеджер (SnapshotScope).
 */
export async function carryoverByScope(s: SnapshotScope, monthStart: string): Promise<CarryoverResult> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE, monthStart];
  const conds: string[] = [];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  // stage_at = остання подія стадії КОЖНОЇ угоди ДО 00:00 дня-1 місяця (київський інстант).
  const r = await pool.query<{ amt: string; dl: string }>(
    `WITH stage_at AS (
       SELECT DISTINCT ON (dse.kommo_id) dse.kommo_id, dse.status_id
         FROM deal_stage_events dse
        WHERE dse.pipeline_id = ANY($1)
          AND dse.changed_at < ($3::date AT TIME ZONE 'Europe/Kyiv')
        ORDER BY dse.kommo_id, dse.changed_at DESC
     )
     SELECT COALESCE(SUM(d.price),0) amt, COUNT(*)::int dl
       FROM stage_at sa
       JOIN deals d ON d.kommo_id = sa.kommo_id
       LEFT JOIN managers m ON m.id = d.manager_id
      WHERE d.pipeline_id = ANY($1) AND sa.status_id = ANY($2)
        ${conds.length ? "AND " + conds.join(" AND ") : ""}`,
    params
  );
  return { amount: Number(r.rows[0]?.amt ?? 0), deals: Number(r.rows[0]?.dl ?? 0) };
}

export interface CarryoverMgrRow { managerId: number; amount: number; deals: number }

/**
 * Розріз `carryoverByScope` ПО МЕНЕДЖЕРУ (та сама реконструкція з deal_stage_events на
 * 00:00 дня-1 місяця, зона EXPECT_ZONE) — для колонки carryover у /plans-grid. Σ рядків =
 * carryoverByScope(той самий скоуп) для угод з менеджером (інваріант матрьошки). Тому
 * plans-grid.carryover(менеджер) == Огляд carryover({managerId}) байт-у-байт.
 */
export async function carryoverByManager(s: SnapshotScope, monthStart: string): Promise<CarryoverMgrRow[]> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE, monthStart];
  const conds: string[] = ["d.manager_id IS NOT NULL"];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const r = await pool.query<{ manager_id: number; amt: string; dl: string }>(
    `WITH stage_at AS (
       SELECT DISTINCT ON (dse.kommo_id) dse.kommo_id, dse.status_id
         FROM deal_stage_events dse
        WHERE dse.pipeline_id = ANY($1)
          AND dse.changed_at < ($3::date AT TIME ZONE 'Europe/Kyiv')
        ORDER BY dse.kommo_id, dse.changed_at DESC
     )
     SELECT d.manager_id, COALESCE(SUM(d.price),0) amt, COUNT(*)::int dl
       FROM stage_at sa
       JOIN deals d ON d.kommo_id = sa.kommo_id
       LEFT JOIN managers m ON m.id = d.manager_id
      WHERE d.pipeline_id = ANY($1) AND sa.status_id = ANY($2) AND ${conds.join(" AND ")}
      GROUP BY d.manager_id`,
    params
  );
  return r.rows.map((x) => ({ managerId: x.manager_id, amount: Number(x.amt), deals: Number(x.dl) }));
}

export interface ExpectedScopeRow { id: number; name: string; teamId: number | null; deals: number; sum: number }

/**
 * Розріз бакета «Цей місяць» очікувань (planned-date у поточному місяці, зона EXPECT_ZONE)
 * по КОМАНДІ або МЕНЕДЖЕРУ — для дрілдауну картки «Цей місяць». Те саме джерело, що
 * `expectedPaymentsByPlanned.thisMonth` → інваріант: Σ менеджерів = команда = відділ.
 * `by`='team' → id/name = команда (teamId=null); `by`='manager' → id/name = менеджер (+teamId).
 */
export async function expectedThisMonthByScope(s: SnapshotScope, by: "team" | "manager"): Promise<ExpectedScopeRow[]> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = [
    "d.pipeline_id = ANY($1)", "d.status_id = ANY($2)",
    "d.planned_payment_at IS NOT NULL",
    `to_char((d.planned_payment_at ${KYIV}), 'YYYY-MM') = to_char((now() ${KYIV}), 'YYYY-MM')`,
  ];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const sel = by === "team"
    ? "t.id AS id, t.name AS name, NULL::int AS team_id"
    : "m.id AS id, m.name AS name, m.team_id";
  const grp = by === "team" ? "GROUP BY t.id, t.name" : "GROUP BY m.id, m.name, m.team_id";
  const join = by === "team" ? "JOIN teams t ON t.id = m.team_id" : "";
  const r = await pool.query<{ id: number; name: string; team_id: number | null; deals: string; sum: string }>(
    `SELECT ${sel}, COUNT(*)::int deals, COALESCE(SUM(d.price),0) sum
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active ${join}
      WHERE ${conds.join(" AND ")} ${grp} ORDER BY sum DESC`,
    params
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, teamId: x.team_id, deals: Number(x.deals), sum: Number(x.sum) }));
}

/**
 * Розріз ПОВНОЇ грошової зони очікувань (EXPECT_ZONE, усі 5 стадій за статусом, БЕЗ
 * фільтра планової дати) по КОМАНДІ або МЕНЕДЖЕРУ — дрілдаун плитки «Очікування» Огляду.
 * Те саме джерело, що `expectedPaymentsByPlanned.total` → Σ рядків = total (той самий
 * інваріант матрьошки). `by`='team' → id/name = команда; 'manager' → id/name = менеджер.
 */
export async function expectedZoneByScope(s: SnapshotScope, by: "team" | "manager"): Promise<ExpectedScopeRow[]> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)"];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const sel = by === "team"
    ? "t.id AS id, t.name AS name, NULL::int AS team_id"
    : "m.id AS id, m.name AS name, m.team_id";
  const grp = by === "team" ? "GROUP BY t.id, t.name" : "GROUP BY m.id, m.name, m.team_id";
  const join = by === "team" ? "JOIN teams t ON t.id = m.team_id" : "";
  const r = await pool.query<{ id: number; name: string; team_id: number | null; deals: string; sum: string }>(
    `SELECT ${sel}, COUNT(*)::int deals, COALESCE(SUM(d.price),0) sum
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active ${join}
      WHERE ${conds.join(" AND ")} ${grp} ORDER BY sum DESC`,
    params
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, teamId: x.team_id, deals: Number(x.deals), sum: Number(x.sum) }));
}

export interface ExpectedSegment { newSeg: ExpectedBucket; repeatSeg: ExpectedBucket; unattributed: ExpectedBucket }
/**
 * «Дохід в очікуванні» РОЗКЛАДЕНИЙ по сегменту КЛІЄНТА (Крок Д owner-review #3, ДРУГИЙ
 * етап структури виручки): ТА САМА зона визнання `EXPECT_ZONE` (знімок «зараз»), що й
 * `expectedPaymentsByPlanned`/`expectedZoneByScope`, лише розбита client-grain:
 *   • new    — клієнт ще НЕ платив (first_paid NULL → новий проспект) АБО перша оплата у періоді;
 *   • repeat — перша оплата була ДО періоду;
 *   • unattributed — угода без `client_key`.
 * Σ(new+repeat+unattributed) == `expectedPaymentsByPlanned.total` (той самий предикат зони).
 * `from` — лише для класифікації new/repeat (сама зона — знімок, без періоду).
 */
export async function expectedBySegment(s: { managerId?: number | null; teamId?: number | null; from?: string | null }): Promise<ExpectedSegment> {
  const params: unknown[] = [FC_PIPELINES, EXPECT_ZONE];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)"];
  if (s.managerId) { params.push(s.managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (s.teamId) { params.push(s.teamId); conds.push(`m.team_id = $${params.length}`); }
  const fromRef = s.from ? (params.push(s.from), `$${params.length}`) : "NULL";
  // Active-only скрізь (рішення власника 22.07): неактивний менеджер зникає з усіх
  // агрегатів. INNER JOIN + m.is_active у ON — консистентно з money-core (activeOnly).
  const join = "JOIN managers m ON m.id = d.manager_id AND m.is_active";
  const rows = (await pool.query<{ seg: string; deals: string; sum: string }>(
    `WITH firsts AS (
       SELECT d2.client_key, MIN(d2.created_at_kommo) AS first_paid
         FROM deals d2
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d2.pipeline_id AND psm.status_id = d2.status_id
        WHERE psm.funnel_stage = 'paid' AND d2.client_key IS NOT NULL GROUP BY d2.client_key
     ),
     pop AS (
       SELECT d.price, d.client_key, f.first_paid
         FROM deals d ${join}
         LEFT JOIN firsts f ON f.client_key = d.client_key
        WHERE ${conds.join(" AND ")}
     )
     SELECT CASE WHEN client_key IS NULL THEN 'u'
                 WHEN first_paid IS NULL THEN 'n'
                 WHEN ${fromRef}::date IS NOT NULL AND first_paid >= ${fromRef}::date THEN 'n'
                 ELSE 'r' END AS seg,
            COUNT(*)::int AS deals, COALESCE(SUM(d.price),0) AS sum
       FROM pop d GROUP BY 1`, params)).rows;
  const g = (k: string): ExpectedBucket => { const r = rows.find((x) => x.seg === k); return { deals: Number(r?.deals ?? 0), sum: Number(r?.sum ?? 0) }; };
  return { newSeg: g("n"), repeatSeg: g("r"), unattributed: g("u") };
}

// ───────────────────────── ПРОГНОЗ ВИРУЧКИ — ЄДИНЕ ЯДРО (Формула A) ─────────────────────────

export interface ProjectionScope {
  from?: string | null;
  to?: string | null;
  managerId?: number | null;
  teamId?: number | null;
  granularity?: "month" | "week" | "day";
}
export interface Projection {
  fact: number;              // = receivedMoney (ЄДИНЕ джерело «факту»)
  projected: number;         // Формула A = факт + повна зона + добір (для міс, що триває)
  projectedPct: number | null;
  zoneFull: number;          // expectedPaymentsByPlanned.total.sum (0 поза активним місяцем)
  zoneDeals: number;
  dobir: number;             // newBusinessDobir (новий бізнес, трейл-3м)
  byPace: number;            // наївний run-rate по факту (ЛИШЕ показ)
  floor: number;             // стара модель D (ЛИШЕ показ, як низ)
  elapsedWorkingDays: number;
  totalWorkingDays: number;
  monthInProgress: boolean;
}

/**
 * 🔴 ЄДИНА КОМПОЗИЦІЯ ПРОГНОЗУ (Формула A) — і Звіт 2.0 (buildPeriod), і плитка «Прогноз»
 * Огляду кличуть САМЕ ЦЮ функцію (нуль дублювання). Прогноз = факт (receivedMoney) +
 * ПОВНА грошова зона (expectedPaymentsByPlanned.total — усі 5 стадій за статусом) + добір
 * (newBusinessDobir, новий бізнес). Складові диз'юнктні (доведено). Зону/добір додаємо
 * ЛИШЕ для поточного місяця, що ТРИВАЄ (місячна гранулярність, elapsed<total); минулий/
 * завершений/тиждень → прогноз = факт. Бектест: зміщення −3.9%, MAE 4.6% (D давала −46%).
 * ⚠️ Легасі inline-D (successMTD×k+paidOnly) з роутів ВИДАЛЕНО — прогноз рахується ЛИШЕ тут.
 */
export async function buildProjection(s: ProjectionScope, plan?: number | null): Promise<Projection> {
  const scope: MoneyScope = { from: s.from, to: s.to, managerId: s.managerId, teamId: s.teamId };
  const [proj, expected] = await Promise.all([
    revenueProjection(scope),
    expectedPaymentsByPlanned({ managerId: s.managerId, teamId: s.teamId }),
  ]);
  const fact = proj.fact;
  const gran = s.granularity ?? "month";
  const monthInProgress = gran === "month" && proj.elapsedWorkingDays < proj.totalWorkingDays;
  const zoneFull = monthInProgress ? expected.total.sum : 0;
  const zoneDeals = monthInProgress ? expected.total.deals : 0;
  const dobir = monthInProgress ? await newBusinessDobir({ managerId: s.managerId, teamId: s.teamId }) : 0;
  const projected = fact + zoneFull + dobir;
  return {
    fact, projected,
    projectedPct: plan && plan > 0 ? Math.round((projected / plan) * 100) : null,
    zoneFull, zoneDeals, dobir,
    byPace: proj.byPace, floor: proj.floor,
    elapsedWorkingDays: proj.elapsedWorkingDays, totalWorkingDays: proj.totalWorkingDays,
    monthInProgress,
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
