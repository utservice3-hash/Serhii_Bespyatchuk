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
const SEGMENT_CASE = `
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
