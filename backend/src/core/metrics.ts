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
