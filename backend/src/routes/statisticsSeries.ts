import { Router } from "express";
import { isAdminScope, isAdminOrLead, roleHasTab, roleHasPerm } from "../auth/rbac.js";
import { pool } from "../db/pool.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { successByBucket as successByBucketRaw, receivedByBucket as receivedByBucketRaw, type MoneyScope } from "../core/money.js";
import * as money from "../core/money.js";
import { lapsedFrom, prevMonthOf } from "../core/lapsedClients.js";
import { clientOwnersFor } from "../core/clientOwner.js";
import { kyivToday } from "../core/dates.js";
import {
  dispatchedByLoadBucket as dispatchedByLoadBucketRaw, leadsTakenByBucket, repeatClientsByBucket as repeatClientsByBucketRaw,
  createdSplitByBucket as createdSplitByBucketRaw, type MetricScope,
} from "../core/metrics.js";
import { SALES_TEAM_LEAD } from "../statistics/catalog.js";
import { teamAtSql } from "../core/teamAt.js";
import { leadgenBuckets, sumBuckets, leadgenTrend as leadgenTrendRaw } from "../core/leadgenStats.js";
import { getSettings } from "./settings.js";
import { fmRefsFor } from "../core/financeKpiRefs.js";
import { FM_KOMMO_FROM } from "../core/financeKpi.js";
import { churnReport } from "../core/churn.js";
import type { Db } from "../core/secrets.js";
import { leadTakeSeriesRows as leadTakeSeriesRowsRaw, seriesOfTakeRows, SERIES_TAKE_FILTER } from "../core/leadTake.js";
import type { TakeStats } from "../core/leadTakeRules.js";
import {
  STATS_SEAM, STATS_CRM_FROM, isCrmAble, LIVE_TEAMS, DEPSTATS_DEPT, DEPSTATS_METRIC_MAP, hasDepstats,
} from "../statistics/seriesCatalog.js";
import { clipPlanToToday, clipPointsToToday } from "../statistics/statsCompare.js";
import { anomaliesFor } from "../statistics/anomalies.js";
import { mainSpec, firstSpec, sumIntoBuckets, periodStarts, blockDenied } from "../statistics/statsBuckets.js";
import { buildSummary, buildPlanFact, planSeries, dispatchPlanSeries, ARCHIVED_TEAM_IDS } from "../statistics/statsSummary.js";
import type { AuthPayload } from "../auth/auth.js";
import { memoize } from "../statistics/seriesMemo.js";
import { SeriesCache, SERIES_FRESH_MS, SERIES_STALE_MS } from "../statistics/seriesCache.js";
import { SERIES_DEFAULT_FROM, seriesDefaultTo, warmTasks } from "../statistics/seriesWarmSet.js";

/**
 * Вкладка «Статистики» (стіна графіків). Кожна серія — ЛИШЕ з CRM (ядро) або з розділу дашборда («Фінанси», реєстр
 * людей, Ringostat через депстат-авто), від `STATS_CRM_FROM` (Роман 20.11.2026: «всі дані з CRM і дашборду, інших немає»).
 * Ручна таблиця (`stats_series`, source sheet/manual) екраном БІЛЬШЕ НЕ ЧИТАЄТЬСЯ; дані в базі лишились (revert коду
 * повертає історію). Роль-скоуп на сервері. Монтується на /api/statistics ПОРЯД із депстат-роутом.
 */
export const statsSeriesRouter = Router();
statsSeriesRouter.use(requireAuth);

type Gran = "day" | "week" | "month";
interface Point { period: string; value: number; source: "sheet" | "crm" | "manual" }
interface Series { scopeType: string; scopeKey: string; scopeName: string; points: Point[]; benchmark?: boolean; archived?: boolean }
interface ScopeSpec { scopeType: string; scopeKey: string; scopeName: string; teamId: number | null; managerId: number | null; benchmark?: boolean }

// ── LIVE-обчислювачі (реюз ядра). period='YYYY-MM-DD', source='crm'. Метрики без запису
//    тут CRM-продовження через core НЕ мають (calls/finance/hr — через depstats-read нижче). ──
type Computer = (g: Gran, from: string, to: string, teamId: number | null, managerId: number | null) => Promise<Point[]>;
const P = (period: string, value: number): Point => ({ period, value, source: "crm" });

/* ⚡ Виклики ядра, які ділять кілька карток одного відділу, — спільні на `SERIES_MEMO_TTL_MS` (`seriesMemo.ts`): ключ — усі
   аргументи виклику, тож скоуп (`teamId`/`managerId`) і період у ньому завжди. Імена ті самі, що в ядрі, — обчислювачі нижче
   не змінились, змінилось лише те, скільки разів ядро рахує одне й те саме. */
const successByBucket = memoize("successByBucket", successByBucketRaw);
const receivedByBucket = memoize("receivedByBucket", receivedByBucketRaw);
const dispatchedByLoadBucket = memoize("dispatchedByLoadBucket", dispatchedByLoadBucketRaw);
const repeatClientsByBucket = memoize("repeatClientsByBucket", repeatClientsByBucketRaw);
const createdSplitByBucket = memoize("createdSplitByBucket", createdSplitByBucketRaw);
const leadTakeSeriesRows = memoize("leadTakeSeriesRows", leadTakeSeriesRowsRaw);
const leadgenTrend = memoize("leadgenTrend", leadgenTrendRaw);
const adReceivedByDay = memoize("adReceivedByDay", money.adReceivedByDay);
const churnOf = memoize("churnReport", (fromYm: string, toYm: string) => churnReport(pool as unknown as Db, fromYm, toYm));

const moneyC = (kind: "rev" | "deals" | "avg" | "recv"): Computer => async (g, from, to, teamId, managerId) => {
  const s: MoneyScope = { from, to, teamId, managerId };
  const rows = kind === "recv" ? await receivedByBucket(s, g) : await successByBucket(s, g);
  return rows.map((x) => P(x.bucket, kind === "rev" || kind === "recv" ? x.revenue : kind === "deals" ? x.deals : x.deals ? x.revenue / x.deals : 0));
};

/**
 * ⏱ «ЧАС ОПРАЦЮВАННЯ ЗАЯВКИ» — ТЕ САМЕ ЯДРО, ЩО ВІКНО ЗВІТУ (`core/leadTake`), з тим фільтром, з яким вікно
 * відкривається (`SERIES_TAKE_FILTER`). Скоуп — `teamId`/`managerId` серії (команда на дату заявки, як у вікні).
 * Кошик без заявок (або без жодної взятої — для медіани) точки не дає: «не було» ≠ «нуль».
 * ⚡ ОДНА ВИБІРКА НА ВСЕ (21.11.2026): заявки компанії від `STATS_CRM_FROM` вантажаться раз, а команда, менеджер,
 * коротший період картки й усі три кроки беруться з них (`seriesOfTakeRows`) — було сім вибірок на графік і ще дві на картки.
 */
const leadTakeC = (pick: (s: TakeStats) => number | null): Computer => async (g, from, to, teamId, managerId) => {
  const base = from < STATS_CRM_FROM ? from : STATS_CRM_FROM;
  const rows = await leadTakeSeriesRows({ from: base, to, ...SERIES_TAKE_FILTER });
  return seriesOfTakeRows(rows, { from, to, teamId, managerId }, g)
    .flatMap((x) => { const v = pick(x.stats); return v == null ? [] : [P(x.bucket, v)]; });
};

/** 📣 Гроші з реклами по кошиках — лише компанія (ядро не розрізає «Надійшло» по командах). */
const adC = (pick: (x: { revenue: number; deals: number }) => number): Computer => async (g, from, to, teamId, managerId) => {
  if (teamId != null || managerId != null) return [];
  const days = await adReceivedByDay({ from, to }, (await getSettings()).adSources);
  return sumIntoBuckets(days, g, pick).map((x) => P(x.bucket, x.value));
};
type LgMoney = Awaited<ReturnType<typeof leadgenTrend>>["money"][number]["totals"];
/** 🎯 Тренд «Лідогенерації» — помісячно, як на тому екрані; місяці, яких журнал не памʼятає, точок не дають. */
const lgC = (pick: (m: LgMoney) => number): Computer => async (g, from, to, teamId, managerId) => {
  if (g !== "month" || teamId != null || managerId != null) return [];
  const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  const t = await leadgenTrend(to, months, { teamId: null, managerId: null });
  const remembered = new Set(t.monthStarts);
  return t.money.filter((b) => remembered.has(b.bucket) && b.bucket >= from).map((b) => P(b.bucket, pick(b.totals)));
};
/**
 * 💵 Рядок «Фінансів» за кожен період — ТІЄЮ САМОЮ функцією, що екран «Фінанси → Тиждень і місяць» (`fmRefsFor`).
 * Періоди до старту автоматики (`FM_KOMMO_FROM`) рядків не мають — і точок теж (не нуль). Кеш на хвилину: чотири картки
 * відділу питають ті самі періоди, а `fmRefsFor` — це кілька запитів на період.
 */
const finCache = new Map<string, { at: number; v: Promise<{ start: string; refs: Record<string, number> }[]> }>();
function finRows(g: "week" | "month", from: string, to: string) {
  const k = `${g}|${from}|${to}`, hit = finCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const starts = periodStarts(g, from > FM_KOMMO_FROM[g] ? from : FM_KOMMO_FROM[g], to);
  const v = Promise.all(starts.map(async (st) => ({ start: st, refs: (await fmRefsFor(g, st)) as Record<string, number> })));
  v.catch(() => finCache.delete(k));
  finCache.set(k, { at: Date.now(), v });
  return v;
}
const finC = (ref: string): Computer => async (g, from, to, teamId, managerId) => {
  if (g === "day" || teamId != null || managerId != null) return [];
  return (await finRows(g, from, to)).flatMap((r) => (typeof r.refs[ref] === "number" ? [P(r.start, r.refs[ref])] : []));
};
type ChurnM = Awaited<ReturnType<typeof churnReport>>["months"][number];
/** 🧑‍💼 Плинність реєстру людей помісячно — `churnReport` (та сама `monthRow`, що екран «Люди»); `null` плинності — без точки. */
const hrC = (pick: (m: ChurnM) => number | null): Computer => async (g, from, to, teamId, managerId) => {
  if (g !== "month" || teamId != null || managerId != null) return [];
  const r = await churnOf(from.slice(0, 7), to.slice(0, 7));
  return r.months.flatMap((m) => { const v = pick(m); return v == null ? [] : [P(`${m.month}-01`, v)]; });
};

export const COMPUTERS: Record<string, Computer> = {
  // Медіана, а не середнє (рішення власника): один «забутий» лід на добу тягнув би середнє на години.
  lead_take_median: leadTakeC((s) => s.medianMin),
  lead_take_m5_pct: leadTakeC((s) => s.m5Pct),
  revenue_success: moneyC("rev"),
  cars_success: moneyC("deals"),
  avg_check: moneyC("avg"),
  payment_received: moneyC("recv"),
  // Авто (поставлені) — dispatched по load_at, COUNT угод.
  cars_delivered: async (g, from, to, teamId, managerId) => {
    const s: MetricScope = { from, to, teamId, managerId, activeOnly: true };
    return (await dispatchedByLoadBucket(s, g)).map((x) => P(x.ym, x.deals));
  },
  // Ліди з реклами — leadsTakenByBucket(byChannel), канал 'ad'.
  ad_leads: async (g, from, to, teamId, managerId) => {
    const s: MetricScope = { from, to, teamId, managerId, activeOnly: true };
    const rows = await leadsTakenByBucket(s, g, true);
    const agg = new Map<string, number>();
    for (const r of rows as { bucket: string; deals: number; channel?: string }[])
      if (r.channel === "ad") agg.set(r.bucket, (agg.get(r.bucket) ?? 0) + Number(r.deals));
    return [...agg].map(([period, v]) => P(period, v));
  },
  // Прорахунки лідгенів — ТІЄЮ САМОЮ функцією, що екран «Лідогенерація» (`leadgenBuckets` → входи угод у
  // «Кваліфіковано»). Company-level.
  //
  // 🔴 ДЖЕРЕЛО ЗМІНЕНО 02.10.2026 (рішення Романа, варіант А): було `leadgen_touch` — передачі через бот.
  // Бот із серпня майже не пише (вересень — 2 передачі), і графік «Прорахунки лідгенів» показував
  // 2–186, коли «Лідогенерація» під тією самою назвою — десятки на тиждень у кожного лідгена. Два числа
  // під однією назвою на двох екранах — та сама поломка, яку лікує ТЗ Статистик. Обвал БОТА видно й далі —
  // у таблиці передач на екрані «Лідогенерація»; тут показник про роботу лідгенів, а не про бота.
  lg_transfers: async (g, from, to, teamId, managerId) => {
    if (teamId != null || managerId != null) return []; // per-team поки не розрізаємо (лише компанія)
    return sumBuckets(await leadgenBuckets(from, to, g, false)).map((x) => P(x.bucket, x.quotes));
  },
  // Логістика: усі поставлені авто (=dispatched total).
  cars_delivered_all: async (g, from, to, teamId, managerId) =>
    (await dispatchedByLoadBucket({ from, to, teamId, managerId, activeOnly: true }, g)).map((x) => P(x.ym, x.deals)),
  // Клієнти: постійні (has_prior, klass='repeat', анкер load_at) — активні/авто/сума/чек.
  repeat_clients_active: async (g, from, to, teamId, managerId) =>
    (await repeatClientsByBucket({ from, to, teamId, managerId, activeOnly: true }, g)).map((x) => P(x.bucket, x.activeClients)),
  repeat_clients_cars: async (g, from, to, teamId, managerId) =>
    (await repeatClientsByBucket({ from, to, teamId, managerId, activeOnly: true }, g)).map((x) => P(x.bucket, x.cars)),
  repeat_clients_sum: async (g, from, to, teamId, managerId) =>
    (await repeatClientsByBucket({ from, to, teamId, managerId, activeOnly: true }, g)).map((x) => P(x.bucket, x.revenue)),
  repeat_avg_check: async (g, from, to, teamId, managerId) =>
    (await repeatClientsByBucket({ from, to, teamId, managerId, activeOnly: true }, g)).map((x) => P(x.bucket, x.cars ? x.revenue / x.cars : 0)),
  // 🆕 «Машини нових клієнтів» (Роман 20.11.2026, словник §22): відправлені авто клієнтів без жодної попередньої
  //    виграної угоди, джерело не важливе = усі відправлені мінус постійні. ТОЙ САМИЙ виклик ядра, що «Відправлені авто
  //    всього» й «Машини постійних», тож Σ нових + постійних == всього за побудовою.
  new_clients_cars: async (g, from, to, teamId, managerId) =>
    (await dispatchedByLoadBucket({ from, to, teamId, managerId, activeOnly: true }, g)).map((x) => P(x.ym, x.deals - x.repeat)),
  // 🏛 Тендери і LinkedIn (Сергій 20.11): колонки Звіту «зі створених: Prozorro / LinkedIn» — ядро `createdSplitByBucket`
  //    (словник §20, §21), без нового правила.
  prozorro_deals: async (g, from, to, teamId, managerId) =>
    (await createdSplitByBucket({ from, to, teamId, managerId }, g)).map((x) => P(x.bucket, x.prozorroCount)),
  linkedin_deals: async (g, from, to, teamId, managerId) =>
    (await createdSplitByBucket({ from, to, teamId, managerId }, g)).map((x) => P(x.bucket, x.linkedinCount)),
  // 📣 Реклама: плитка «Надійшло» екрана «Реклама» (`money.adReceivedByDay`), поденні суми ядра → кошики. Лише компанія.
  ad_received_sum: adC((x) => x.revenue),
  ad_received_deals: adC((x) => x.deals),
  ad_received_avg: async (g, from, to, teamId, managerId) => {
    if (teamId != null || managerId != null) return [];
    const days = await adReceivedByDay({ from, to }, (await getSettings()).adSources);
    const rev = sumIntoBuckets(days, g, (x) => x.revenue), n = new Map(sumIntoBuckets(days, g, (x) => x.deals).map((x) => [x.bucket, x.value]));
    return rev.filter((x) => (n.get(x.bucket) ?? 0) > 0).map((x) => P(x.bucket, x.value / n.get(x.bucket)!));
  },
  // 🎯 Лідогенерація: гроші й машини тренду екрана «Лідогенерація» (`leadgenTrend`, правило Ярослава). Лише місяць і компанія.
  lg_earned_sum: lgC((m) => m.earned.sum),
  lg_earned_deals: lgC((m) => m.earned.n),
  lg_machines: lgC((m) => m.machines),
  // 💵 Фінанси: рядки екрана «Фінанси → Тиждень і місяць» (`fmRefsFor`) — період за періодом. Лише компанія.
  fin_bank_in: finC("bank_in"),
  fin_bank_out: finC("bank_out"),
  fin_receivables: finC("receivables"),
  fin_delivered_income: finC("delivered_income"),
  // 🧑‍💼 HR: помісячна плинність реєстру людей (`churnReport` → `monthRow`), уже у відсотках. Лише компанія.
  hr_headcount: hrC((m) => m.headcount),
  hr_hired: hrC((m) => m.hired),
  hr_fired: hrC((m) => m.dismissed),
  hr_turnover_total: hrC((m) => m.turnover),
  // План/факт: місячна серія «% виконання» = received-fact ÷ plan (payment_amount). Тижневих планів нема.
  plan_execution: async (g, from, to, teamId, managerId) => {
    if (g !== "month") return [];
    const fact = await receivedByBucket({ from, to, teamId, managerId }, "month");
    const factMap = new Map(fact.map((x) => [x.bucket, x.revenue]));
    const params: unknown[] = [from, to];
    let scope = "";
    if (managerId != null) { params.push(managerId); scope = `AND p.manager_id = $${params.length}`; }
    else if (teamId != null) { params.push(teamId); scope = `AND ${teamAtSql("m", "date_trunc('month', p.plan_date)::date")} = $${params.length}`; } // 🔀 команда на місяць плану (4892)
    const pl = await pool.query<{ period: string; plan: string }>(
      `SELECT to_char(date_trunc('month', p.plan_date), 'YYYY-MM-DD') period, SUM(p.planned_value)::float plan
         FROM plans p JOIN managers m ON m.id = p.manager_id
        WHERE p.metric = 'payment_amount'
          AND date_trunc('month', p.plan_date) >= date_trunc('month', $1::date)
          AND date_trunc('month', p.plan_date) <= $2::date ${scope}
        GROUP BY 1 ORDER BY 1`, params);
    return pl.rows.filter((x) => Number(x.plan) > 0).map((x) => P(x.period, Math.round(((factMap.get(x.period) ?? 0) / Number(x.plan)) * 100)));
  },
};
const hasLive = (block: string, metric: string): boolean => (metric in COMPUTERS) || hasDepstats(block, metric);

// ── depstats-read (calls/finance/hr): statistics_values, лише source IN (auto,manual) ≥шов ──
function teamLeadForStats(teamId: number | null): string | null {
  if (teamId == null) return null;               // company → team_lead IS NULL
  if (teamId === 36283) return "Шевчук Назар";   // «Самостійні» → Шевчук (R2, як у депстаті)
  return SALES_TEAM_LEAD[teamId] ?? null;
}
async function depstatsRead(block: string, metric: string, g: Gran, from: string, to: string, scope: Pick<ScopeSpec, "scopeType" | "teamId">): Promise<Point[]> {
  if (g === "day") return [];                     // statistics_values — лише month|week
  if (scope.scopeType === "manager") return [];   // депстат per-manager нема
  const dept = DEPSTATS_DEPT[block], sv = DEPSTATS_METRIC_MAP[metric];
  if (!dept || !sv) return [];
  const params: unknown[] = [dept, sv, g, from, to]; // `from` уже не раніше `STATS_CRM_FROM` (кламп у `stitch`)
  // sales·calls зберігається ПО team_lead (company-рядка NULL нема) → company = Σ лідів.
  // finance/hr — company-level (team_lead IS NULL). Per-team — конкретний team_lead.
  const salesLeadSum = block === "sales" && scope.scopeType === "company";
  let leadCond: string;
  if (salesLeadSum) leadCond = "team_lead IS NOT NULL";
  else { const lead = teamLeadForStats(scope.teamId); leadCond = lead == null ? "team_lead IS NULL" : `team_lead = $${params.push(lead)}`; }
  const r = await pool.query<{ period: string; v: string; source: string }>(
    `SELECT to_char(period_start,'YYYY-MM-DD') period, SUM(value)::float v, MIN(source) source
       FROM statistics_values
      WHERE department=$1 AND metric_key=$2 AND period_type=$3
        AND source IN ('auto','manual')            -- imported ІГНОРУЄМО (стара копія тієї ж таблиці → без дублів)
        AND period_start >= $4::date AND period_start <= $5::date AND ${leadCond}
      GROUP BY period_start ORDER BY period_start`,
    params
  );
  return r.rows.map((x) => ({ period: x.period, value: Number(x.v), source: "crm" as const }));
}

/**
 * 🧵 СЕРІЯ = ЛИШЕ CRM / ДАШБОРД (Роман 20.11.2026). Була зшивка «таблиця до шва 01.07 + CRM після + ручні точки»;
 * таблиця й ручні точки з екрана прибрані. Ряд рахується від `STATS_CRM_FROM` (з якого місяця CRM має повну історію —
 * замір у `seriesCatalog.ts`), а не від шва: CRM_ABLE-показники тепер мають CRM-історію на всю цю глибину.
 * ⚠️ `stats_series` у базі НЕ видаляли: revert коду повертає таблицю на графік.
 *
 * Аргументи — РІВНО те, від чого залежать точки: вони ж і ключ памʼяті (`seriesCache.call`). Назва розрізу сюди не
 * входить: «Мої» менеджера і його прізвище в тімліда — ті самі точки.
 */
async function seriesPoints(block: string, metric: string, g: Gran, cf: string, to: string,
  scopeType: string, scopeKey: string, teamId: number | null, managerId: number | null): Promise<Point[]> {
  let crm: Point[] = [];
  const liveScope = scopeType === "company" || teamId != null || managerId != null;
  if (liveScope && to >= cf) {
    if (metric in COMPUTERS) crm = await COMPUTERS[metric](g, cf, to, teamId, managerId);
    else if (hasDepstats(block, metric)) crm = await depstatsRead(block, metric, g, cf, to, { scopeType, teamId });
  }
  // Кошик, що почався ДО `cf` (тиждень через межу), — неповний: не показуємо його як повний період.
  return crm.filter((p) => p.period >= cf && p.period <= to).sort((a, b) => a.period.localeCompare(b.period));
}

/** ⚡ Памʼять готових рядів (`seriesCache.ts`): свіже — одразу, придатне — одразу з фоновим перерахунком, старе — чекаємо. */
const seriesCache = new SeriesCache<Point[]>();

/** Ряд розрізу + мить, станом на яку він порахований. `force` — фоновий прогрів: рахує заново, старе число при невдачі лишається. */
async function stitch(block: string, metric: string, g: Gran, from: string, to: string, sc: ScopeSpec, force = false): Promise<{ series: Series; at: number }> {
  const cf = from > STATS_CRM_FROM ? from : STATS_CRM_FROM;
  const args = [block, metric, g, cf, to, sc.scopeType, sc.scopeKey, sc.teamId, sc.managerId] as const;
  const hit = force ? await seriesCache.recompute(seriesPoints, ...args) : await seriesCache.call(seriesPoints, ...args);
  // Точки з памʼяті СПІЛЬНІ для всіх глядачів — обрізання «до сьогодні» нижче працює з копією масиву, а не з ними.
  return { at: hit.at, series: { scopeType: sc.scopeType, scopeKey: sc.scopeKey, scopeName: sc.scopeName, points: hit.value, ...(sc.benchmark ? { benchmark: true } : {}),
    ...(sc.teamId != null && ARCHIVED_TEAM_IDS.has(sc.teamId) ? { archived: true } : {}) } };
}

/**
 * 🔥 ФОНОВИЙ РОЗРАХУНОК СТАНДАРТНОГО НАБОРУ (`seriesWarmSet.warmTasks`): кожен показник стіни, місяць і тиждень,
 * період картки й розгорнутого графіка, розріз «компанія». Іде ПО ОДНОМУ ряду — фон не має права забрати базу в
 * людей (пул 15 зʼєднань, а 18.11 повна матриця вдень уже клала прод на 3 хв). Спільні виклики ядра (`seriesMemo`)
 * роблять так, що показники одного джерела питають базу раз.
 * НЕ КИДАЄ: невдалий ряд рахується, старе число лишається в памʼяті, наступний ряд іде далі. Стан — у `/api/health`.
 */
const COMPANY: ScopeSpec = { scopeType: "company", scopeKey: "company", scopeName: "Компанія", teamId: null, managerId: null };
interface WarmStatus { running: boolean; lastStartedAt: string | null; lastFinishedAt: string | null; lastMs: number | null; tasks: number; failed: number; firstError: string | null }
const warmStatus: WarmStatus = { running: false, lastStartedAt: null, lastFinishedAt: null, lastMs: null, tasks: 0, failed: 0, firstError: null };
export async function warmStatsSeries(): Promise<WarmStatus> {
  if (warmStatus.running) return structuredClone(warmStatus); // попередній прохід ще йде — другий поверх нього лише подвоїв би навантаження
  const t0 = Date.now(), tasks = warmTasks(kyivToday());
  Object.assign(warmStatus, { running: true, lastStartedAt: new Date(t0).toISOString() });
  let failed = 0, firstError: string | null = null;
  try {
    for (const t of tasks) {
      try { await stitch(t.block, t.metric, t.g, t.from, t.to, COMPANY, true); }
      catch (e) { failed++; firstError ??= `${t.metric}/${t.g}: ${String(e).slice(0, 160)}`; }
    }
  } finally {
    Object.assign(warmStatus, { running: false, lastFinishedAt: new Date().toISOString(), lastMs: Date.now() - t0, tasks: tasks.length, failed, firstError });
  }
  if (failed) console.warn(`warmStatsSeries: ${failed} із ${tasks.length} рядів не перераховано — ${firstError}`);
  return structuredClone(warmStatus);
}
/** Стан памʼяті рядів і фонового розрахунку — для `/api/health`. */
export const statsSeriesCacheStatus = () => ({ freshSec: SERIES_FRESH_MS / 1000, staleSec: SERIES_STALE_MS / 1000, cache: seriesCache.stats(), warm: structuredClone(warmStatus) });

// 🔒 СЕРВЕРНИЙ КЛАМП роль-скоупу. Тімлід бачить свою команду + її менеджерів ПЛЮС компанію
// ЛИШЕ як агрегат-бенчмарк (одна серія значень; чужих команд/менеджерів у payload НЕМА).
// `unit` (напрямок: Міжнародка/Тендери/ЛідгенМіжн/ВЛТ) — окрема unit-серія, ЛИШЕ admin/КВП
// (напрямки не командні); team_lead/manager → порожньо.
async function seriesSet(auth: { role: string; roleKey: string; teamId: number | null; managerId: number | null }, unit: string | null): Promise<ScopeSpec[]> {
  if (unit) return isAdminScope(auth)
    ? [{ scopeType: "unit", scopeKey: unit, scopeName: unit, teamId: null, managerId: null }]
    : [];
  const company: ScopeSpec = COMPANY;
  const teamOf = (t: { id: number; name: string }): ScopeSpec => ({ scopeType: "team_lead", scopeKey: String(t.id), scopeName: t.name, teamId: t.id, managerId: null });
  if (isAdminScope(auth)) return [company, ...LIVE_TEAMS.map(teamOf)];
  if (auth.role === "team_lead") {
    const own = LIVE_TEAMS.find((t) => t.id === auth.teamId);
    if (!own) return [company]; // некомерційний тімлід → лише бенчмарк
    const mgrs = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM managers WHERE team_id = $1 AND is_active ORDER BY name`, [own.id]);
    // company = АГРЕГАТ-бенчмарк (без деком­позиції); далі своя команда + її менеджери.
    return [
      { ...company, benchmark: true },
      teamOf(own),
      ...mgrs.rows.map((m): ScopeSpec => ({ scopeType: "manager", scopeKey: String(m.id), scopeName: m.name, teamId: null, managerId: m.id })),
    ];
  }
  if (auth.managerId != null) return [{ scopeType: "manager", scopeKey: String(auth.managerId), scopeName: "Мої", teamId: null, managerId: auth.managerId }];
  return [company];
}

// GET /api/statistics/series?block&metric&granularity&from&to
statsSeriesRouter.get("/series", async (req, res) => {
  const auth = req.auth!;
  const block = String(req.query.block ?? "sales");
  const metric = String(req.query.metric ?? "");
  const g = (["day", "week", "month"].includes(String(req.query.granularity)) ? req.query.granularity : "week") as Gran;
  const today = kyivToday();
  const from = String(req.query.from ?? SERIES_DEFAULT_FROM);
  const to = String(req.query.to ?? seriesDefaultTo(today));
  if (!metric) return res.status(400).json({ error: "metric обовʼязковий" });
  // 🔒 «Фінанси» і HR — числа закритих екранів: та сама межа, що в їхніх джерел (`blockDenied`).
  const denied = blockDenied(block, { tab: (t) => roleHasTab(auth.roleKey, t), perm: (p) => roleHasPerm(auth.roleKey, p) });
  if (denied) return res.status(403).json({ error: denied });
  const unit = req.query.unit ? String(req.query.unit) : null; // напрямок (unit-scope)
  const full = await seriesSet({ role: auth.role, roleKey: auth.roleKey, teamId: auth.teamId ?? null, managerId: auth.managerId ?? null }, unit);
  // 🧱 Картки стіни (20.11.2026): `scope=main` — лише головна серія глядача з УЖЕ обрізаного набору (`mainSpec`),
  //    без команд і без плану. 8 карток відділу × (компанія + 6 команд) вантажились 8,2 с; картці потрібне одне число.
  //    `scope=first` (21.11.2026) — перша лінія розгорнутого графіка (`firstSpec`): її видно одразу, команди — слідом.
  const lite = req.query.scope === "main" || req.query.scope === "first";
  const set = req.query.scope === "main" ? mainSpec(full) : req.query.scope === "first" ? firstSpec(full) : full;
  const got = await Promise.all(set.map((s) => stitch(block, metric, g, from, to, s)));
  const series = got.map((x) => x.series);
  for (const s of series) s.points = clipPointsToToday(s.points, today); // обчислений обʼєкт stitch, не рядок БД
  // 🕐 «Станом на»: найстаріша з митей, коли рахувались ряди відповіді, — екран показує її, а не вдає, що число живе.
  const asOf = got.length ? new Date(Math.min(...got.map((x) => x.at))).toISOString() : null;
  // ⚠️ Аномалії — з реєстру з доказом CRM (ТЗ 28.09, блок 1, п.3); фронт позначає точку, а не мовчки тягне лінію.
  // 📈 План — там, де він є в CRM-дзеркалі, і лише в скоупі глядача (тімлід — своя команда, менеджер — нічого):
  //    ② — план грошей Звіту; «Поставлені» (= плитка «Відправлені авто») — KPI-цілі задачника, від шва.
  let plan: Awaited<ReturnType<typeof planSeries>> = [];
  const keys = new Set(set.map((s) => s.scopeKey));
  const inScope = (p: { scopeKey: string }) => keys.has(p.scopeKey) && !(set.find((s) => s.scopeKey === p.scopeKey)?.benchmark);
  if (lite) plan = [];
  else if (metric === "payment_received" && block === "sales") plan = (await planSeries(g, from, to)).filter(inScope);
  else if (metric === "cars_delivered" && block === "sales") plan = (await dispatchPlanSeries(g, from > STATS_SEAM ? from : STATS_SEAM, to)).filter(inScope);
  plan = clipPlanToToday(plan, today);
  // ✏️ «Виправлено CRM» і «помилка таблиці» стосувались ТОЧОК ТАБЛИЦІ — таблиці на графіку немає, лишаються лише справжні події.
  res.json({ block, metric, granularity: g, crmFrom: STATS_CRM_FROM, crmAble: isCrmAble(block, metric), live: hasLive(block, metric), series, asOf,
    anomalies: anomaliesFor(metric, g).filter((a) => a.kind === "real"), plan });
});

/**
 * 📊 GET /api/statistics/summary?gran=week|month&anchor=YYYY-MM-DD — плитки й таблиця команд (ТЗ 28.09, блоки 1–3).
 * Скоуп — той самий, що в серіях: адмін-рівень бачить компанію й усі команди; тімлід — свою команду
 * (компанія йому лише бенчмарком у серіях, тут — не віддається); менеджер — себе.
 * `anchor` за замовчуванням — сьогодні за Києвом; майбутнє клампиться до сьогодні.
 */
/**
 * Період плиток і «План-факт»: тиждень / місяць (якір ≤ сьогодні) або «з – по» (4632 п.2.3). Погані дати — 400 з
 * поясненням, а не тихий тиждень. Скоуп глядача — той самий для обох роутів.
 */
function statsPeriod(req: { query: Record<string, unknown>; auth?: AuthPayload }, res: { status: (c: number) => { json: (b: unknown) => unknown } }) {
  const auth = req.auth!;
  const today = kyivToday();
  const isDay = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
  if (req.query.gran === "range") {
    const from = String(req.query.from ?? ""), to = String(req.query.to ?? "");
    if (!isDay(from) || !isDay(to) || from > to) { res.status(400).json({ error: "з – по: потрібні дві дати YYYY-MM-DD, «з» не пізніше «по»" }); return null; }
    if (from > today) { res.status(400).json({ error: "період ще не почався" }); return null; }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) { res.status(400).json({ error: "період довший за рік" }); return null; }
  }
  const gran = req.query.gran === "month" ? "month" as const : req.query.gran === "range" ? "range" as const : "week" as const;
  const raw = String(req.query.anchor ?? "");
  const anchor = isDay(raw) && raw <= today ? raw : today;
  const allTeams = isAdminScope(auth);
  const viewer = allTeams ? { allTeams: true, teamId: null, managerId: null }
    : auth.role === "team_lead" ? { allTeams: false, teamId: auth.teamId ?? -1, managerId: null }
    : { allTeams: false, teamId: null, managerId: auth.managerId ?? -1 };
  const range = gran === "range" ? { from: String(req.query.from), to: String(req.query.to) } : undefined;
  return { gran, anchor, viewer, range };
}

statsSeriesRouter.get("/summary", async (req, res) => {
  const p = statsPeriod(req, res);
  if (!p) return;
  res.json(await buildSummary(p.gran, p.anchor, p.viewer, p.range));
});

/**
 * 📋 GET /api/statistics/plan-fact?gran=week|month|range&anchor|from&to — вкладка «План-факт» (ТЗ 4632 п.2.2).
 * Межа — вкладка `statistics` (ROUTE_TAB), скоуп — той самий, що в плиток: адмін-рівень — компанія й усі команди,
 * тімлід — своя команда, менеджер — свій рядок.
 */
statsSeriesRouter.get("/plan-fact", async (req, res) => {
  const p = statsPeriod(req, res);
  if (!p) return;
  res.json(await buildPlanFact(p.gran, p.anchor, p.viewer, p.range));
});

/**
 * 📉 «КУПУВАВ МИНУЛОГО МІСЯЦЯ, НЕ КУПИВ У ЦЬОМУ» по командах (задача 3990, п.3; вкладка
 * «Статистики → Клієнти»). Гроші — ЛИШЕ з ядра (`successByClientBucket`, ті самі бакети, що
 * на Звіті), правило «випав» — чисте (`core/lapsedClients.ts`), команда — за ЕФЕКТИВНИМ
 * менеджером клієнта на поточний місяць (закріплення й передачі), не за менеджером угоди.
 * Скоуп: адмін-скоуп бачить усі команди, тімлід — свою, менеджер — своїх клієнтів.
 */
statsSeriesRouter.get("/lapsed-clients", async (req, res) => {
  const auth = req.auth!;
  const thisYm = /^\d{4}-\d{2}$/.test(String(req.query.month ?? "")) ? String(req.query.month) : kyivToday().slice(0, 7);
  const prevYm = prevMonthOf(thisYm);
  const [y, m] = thisYm.split("-").map(Number);
  const thisEnd = `${thisYm}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const buckets = await money.successByClientBucket({ from: `${prevYm}-01`, to: thisEnd }, "month");
  const lapsed = lapsedFrom(buckets.map((b) => ({ clientKey: b.clientKey, bucket: b.bucket, revenue: b.revenue })), prevYm, thisYm);
  const keys = lapsed.map((l) => l.clientKey);
  // Ефективний менеджер і команда — з ядра (`clientOwnersFor`: оплачені угоди + закріплення).
  const byKey = await clientOwnersFor(keys, thisYm);
  const canAll = isAdminScope(auth);
  type Row = { clientKey: string; clientName: string; manager: string | null; managerId: number | null; teamId: number | null; teamName: string; prevRevenue: number };
  const rows: Row[] = lapsed.map((l) => { const o = byKey.get(l.clientKey); return {
    clientKey: l.clientKey, clientName: o?.clientName ?? l.clientKey, manager: o?.managerName ?? null, managerId: o?.managerId ?? null,
    teamId: o?.teamId ?? null, teamName: o?.teamName ?? "Без команди", prevRevenue: l.prevRevenue }; })
    .filter((r) => canAll || (auth.role === "team_lead" ? r.teamId === auth.teamId : r.managerId === auth.managerId));
  const teams = new Map<string, { teamId: number | null; teamName: string; clients: number; prevRevenue: number; rows: Row[] }>();
  for (const r of rows) {
    const k = String(r.teamId ?? "none");
    const t = teams.get(k) ?? { teamId: r.teamId, teamName: r.teamName, clients: 0, prevRevenue: 0, rows: [] };
    t.clients++; t.prevRevenue += r.prevRevenue; t.rows.push(r); teams.set(k, t);
  }
  res.json({
    month: thisYm, prevMonth: prevYm, monthComplete: thisYm < kyivToday().slice(0, 7),
    total: { clients: rows.length, prevRevenue: rows.reduce((a, r) => a + r.prevRevenue, 0) },
    teams: [...teams.values()].sort((a, b) => b.prevRevenue - a.prevRevenue).map((t) => ({
      teamId: t.teamId, teamName: t.teamName, clients: t.clients, prevRevenue: t.prevRevenue,
      rows: t.rows.map((r) => ({ clientKey: r.clientKey, clientName: r.clientName, manager: r.manager, prevRevenue: r.prevRevenue })),
    })),
  });
});

// POST /api/statistics/series/manual — ручні точки (не CRM-able). admin-only.
statsSeriesRouter.post("/series/manual", requireRole("admin"), async (req, res) => {
  const auth = req.auth!;
  const { block, metric, scopeType, scopeKey, scopeName, granularity, period, value } = req.body ?? {};
  if (!block || !metric || !scopeType || !scopeKey || !granularity || !period || value == null)
    return res.status(400).json({ error: "block/metric/scopeType/scopeKey/granularity/period/value обовʼязкові" });
  if (!["month", "week"].includes(granularity)) return res.status(400).json({ error: "granularity month|week" });
  if (isCrmAble(block, metric)) return res.status(400).json({ error: "CRM-able метрику вручну не вносять (її рахує CRM)" });
  const clash = await pool.query(
    `SELECT 1 FROM stats_series WHERE metric_key=$1 AND scope_type=$2 AND scope_key=$3 AND granularity=$4 AND period_date=$5 AND source='sheet'`,
    [metric, scopeType, scopeKey, granularity, period]
  );
  if (clash.rowCount) return res.status(409).json({ error: "На цей період є sheet-точка — перезапис заборонено" });
  await pool.query(
    `INSERT INTO stats_series (block, metric_key, scope_type, scope_key, scope_name, granularity, period_date, value, source, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9)
     ON CONFLICT (metric_key, scope_type, scope_key, granularity, period_date, source)
     DO UPDATE SET value=EXCLUDED.value, scope_name=EXCLUDED.scope_name, block=EXCLUDED.block, entered_by=EXCLUDED.entered_by, entered_at=now()`,
    [block, metric, scopeType, scopeKey, scopeName ?? scopeKey, granularity, period, Number(value), auth.managerId ?? null]
  );
  res.json({ ok: true });
});
