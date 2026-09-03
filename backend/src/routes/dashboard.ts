import { Router } from "express";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { roleHasTab, isAdminScope, isAdminOrLead, roleHasPerm } from "../auth/rbac.js";
import { mergePairAllowed, mergeDenyReason, mergeSourceOf, revokeAllowed, revokeDenyReason,
         type MergePairScope } from "../auth/mergeScope.js";
import type { AuthPayload } from "../auth/auth.js";
import { dayItems, isDayItemKind, DAY_ITEM_KINDS } from "../core/dayItems.js";
import { klassOf } from "../core/klassFilter.js";
import { overviewCache } from "../core/lazyCache.js";

/** Порожній зріз джерела — для менеджера, якого немає в розкладі створених. */
const EMPTY_SRC = { created: 0, adCount: 0, leadgenCount: 0, otherCount: 0, noChannelCount: 0 } as const;
import { kommoLeadUrl } from "../core/kommoLinks.js";
import { accumulateKpiTargets } from "../core/kpiTargets.js";

/** Direct link to a deal (lead) card in Kommo/amoCRM. */
// Посилання на картку угоди — з `core/kommoLinks` (одне місце на весь продукт).

/**
 * «Очікування оплати» = deals from "Виставлено рахунок" through the pre-payment
 * stages (Авто працює → Перевезення завершено → Очікуємо оплату), not yet won.
 * ⚠️ In this account "Виставлення рахунку" (status 100274340) maps to funnel_stage
 * 'approved' (coarse mapping) — so filtering by 'invoiced' alone returns 0. This
 * matches the CRM board and the existing КВП "expected" figure.
 */
const EXPECTED_STAGES =
  "(psm.funnel_stage IN ('approved','invoiced') OR d.status_id IN (69716300, 98470988, 10937178))";

// КРОК 9 Фаза 3: `adDealSql` більше НЕ дублюється тут — єдине джерело `core/metrics.ts`
// (`metrics.adDealSql`). Усі усе ще-інлайнові вжитки (конверсія /conversion,
// /conversion-timeseries, /overview.adConversion, /report.adLeads) — це
// свідомо-лишена КОНВЕРСІЯ (КРОК 6, блок В2/В3/В4) + денумератор реклами; логіку не
// чіпаємо, лише централізуємо хелпер.
import { getSettings } from "./settings.js";
import { syncKommo } from "../jobs/syncKommo.js";
import { syncStageEvents } from "../jobs/syncStageEvents.js";
import * as money from "../core/money.js";
import { planTotals, SUBMIT_SQL, approveAllSql, RETURN_SQL,
  isPlannableClientKey, NOT_PLANNABLE_MSG, rosterWithPlans, splitUnattached } from "./clientPlanRules.js";
import * as reactivation from "../core/reactivation.js";
import { buildOverrideUpsert } from "../core/loyaltyOverride.js";
import { loadClientSegments, factsFor, keepInReactivation } from "../core/clientSegments.js";
import { archivedSql, isArchived, LAST_PAID_CTE, LAST_PAID_JOIN, ARCHIVE_REASONS, ARCHIVE_REASON_KEYS } from "../core/clientArchive.js";
import { recomputeClientKeys } from "../jobs/recomputeClientKeys.js";
import { runJob } from "../jobs/jobRuns.js";
import * as metrics from "../core/metrics.js";
import { FUNNEL_STAGE_LABELS, stageName } from "../core/stageNames.js";
import { ORPHAN_DEFAULT_MONTHS, ORPHAN_REASON_LABEL } from "../core/orphanClients.js";
import * as plans from "../core/plans.js";
import * as forecast from "../core/forecast.js";
import * as reportCuts from "../core/reportCuts.js";
import * as receivablesFacts from "../core/receivablesFacts.js";
import * as receivablesCounterparty from "../core/receivablesCounterparty.js";
import * as receivableNotePick from "../core/receivableNotePick.js";
import { WRITE_OFF_PERM, noteIsValid, WRITEOFF_TARGETS_SQL } from "../core/receivablesWriteoff.js";
import { debtAgeDays, CLIENT_DEBT_AGE_SQL } from "../core/receivablesAge.js";
import * as mergeLimits from "../core/mergeLimits.js";
import * as unmergePreview from "../core/unmergePreview.js";
import * as paymentMatch from "../core/paymentMatch.js";
import { marginCell } from "../core/receivablesMargin.js";
import { clientFullyWrittenOff, WRITTEN_OFF_STILL_IN_ZONE } from "../core/writeoffScope.js";
import { receivablesScope } from "../auth/receivablesScope.js";
import {
  fkErrorMessage, limitRequestTitle, amountLimitState, amountLimitLabel,
  LIMIT_REQUEST_TASK_TYPE,
} from "../core/creditLimits.js";
import { canRequestLimitFor, canAssignTaskToOthers } from "../auth/taskAssignScope.js";
import { activeManagerSql } from "../core/activeManager.js";
import * as managerState from "../core/managerState.js";
import { monthsInRange, fixedWeekBlocks, weekBlocksForRange, workingDaysBetween, monthEndOf, kyivToday } from "../core/dates.js";
import { weekPlansForMonth } from "../core/weekPlan.js";
import { sumDaysIntoBlocks } from "../core/weekFacts.js";
import { syncReceivables } from "../jobs/syncReceivables.js";
import { recomputeOwners } from "../core/receivablesOwnerStore.js";
import { RECOMPUTE_RECEIVABLES_SQL } from "../jobs/clientKeySql.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/**
 * КРОК 9-conv Фаза 1: агрегує ПОМІСЯЧНИЙ масив конверсії ядра (cohort+period) у
 * період [from,to]. cohort — основне число (стеля ≤100% гарантована ядром);
 * period — вторинний тренд. entered<10 → pct=null (UI показує «—», щоб не плутати
 * «немає реклами» з «нульовою конверсією» — рішення власника).
 */
type ConvMonthly = {
  ym: string; entered: number; mature: boolean;
  wonEventually?: number; wonInMonth?: number; handoffEventually?: number; handoffInMonth?: number;
};
function sumConv(rows: ConvMonthly[], from?: string | null, to?: string | null) {
  const fy = from ? String(from).slice(0, 7) : null;
  const ty = to ? String(to).slice(0, 7) : null;
  const sel = rows.filter((r) => (!fy || r.ym >= fy) && (!ty || r.ym <= ty));
  const s = (k: keyof ConvMonthly) => sel.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const entered = s("entered");
  const pct = (n: number) => (entered >= 10 ? Math.round((n / entered) * 1000) / 10 : null);
  return {
    entered,
    wonCount: s("wonEventually"),      // сира к-ть виграних (для сумісності: adConversion.paid)
    handoffCount: s("handoffEventually"),
    mature: sel.length > 0 && sel[sel.length - 1].mature,
    wonCohort: pct(s("wonEventually")), wonPeriod: pct(s("wonInMonth")),
    handoffCohort: pct(s("handoffEventually")), handoffPeriod: pct(s("handoffInMonth")),
  };
}

/**
 * Returns deal counts/amounts grouped by funnel stage (per pipeline_stage_map)
 * for a given manager or team, scoped by the caller's role.
 */
dashboardRouter.get("/funnel", async (req, res) => {
  const auth = req.auth!;
  const managerIdParam = req.query.managerId ? Number(req.query.managerId) : null;
  const teamIdParam = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  let managerId = managerIdParam;
  let teamId = teamIdParam;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  // КРОК 9: рероут на канонічне ядро (core/metrics). Той самий предикат/скоуп, що й
  // раніше (усі пайплайни, INNER psm, БЕЗ фільтра is_active) — числа не змінюються.
  // Роут лишає лише мапінг у старі wire-ключі (funnel_stage/deal_count/total_amount).
  const rows = await metrics.funnelByStage({ from, to, managerId, teamId });
  res.json({
    stages: rows.map((r) => ({ funnel_stage: r.stage, deal_count: r.deals, total_amount: r.revenue })),
  });
});

/**
 * Lead-generation performance per lead generator. Their working pipelines are
 * Продзвін (8921936 / 7337048) and Реактивація (8921948): each deal there is a
 * lead they handled. "Reached payment" means that client later has a paid deal
 * in the sales funnel (matched by client_key). Broken down by client source
 * (Холодна база, Реактивація, Google, …) and optionally date-scoped.
 */
/**
 * 🎯 ЛІДОГЕНЕРАЦІЯ — ЛІД = РЯДОК РЕЄСТРУ БОТА (рішення власника 04.08.2026).
 *
 * 🔴 ЩО ЗМІНИЛОСЬ І ЧОМУ. Було: `COUNT(*)` угод у воронках Продзвін+Реактивація
 * за датою СТВОРЕННЯ. Це рахувало не передані заявки, а всі угоди, що будь-коли
 * завелись у цих воронках, — черв. 3 198 і лип. 12 599 проти 358/575 передач.
 * Тобто екран показував іншу сутність під назвою «лід».
 *
 * Стало: канонічне визначення БОТА лідогенератора — передача заявки менеджеру.
 * Джерело — `leadgen_registry` (Google-таблиця бота, синк `syncLeadgenRegistry`),
 * уже оголошена в проєкті «ДЖЕРЕЛОМ ПРАВДИ для переданих заявок».
 *
 * 🔴 ЧОМУ НЕ З `deal_stage_events`, як просив промт: події входу в
 * «НОВА ЗАЯВКА ВІД ЛІДОГЕНЕРАТОРА» (69716164) у Kommo практично НЕМАЄ —
 * заміряно 2 із 831 ліда реєстру за черв.+лип. (0.24%), при тому що подій тієї
 * самої воронки за період тисячі. Реалізація «з подій» рахувала б 2 замість 831
 * і виглядала б робочою. Деталі — `docs/AD_LEADS_RECON.md` §6.
 *
 * 🔴 ОДИНИЦЯ ЛІЧБИ — ПЕРЕДАЧА, а не унікальний лід (рішення власника): один лід,
 * переданий двічі, це дві передачі. `uniqueLeads` віддаємо ПОРУЧ як довідку —
 * щоб різницю було видно, а не щоб її складали.
 *
 * 🔴 ФІЛЬТР ПОВТОРНИХ ПРОХОДІВ НЕ ДУБЛЮЄМО. За LOGIC.md бота (слова власника)
 * для переходів із робочих етапів кваліфікації «сповіщення й запис НЕ йдуть» —
 * тобто SKIP застосований ДО запису в реєстр. Накладати його вдруге тут означало
 * б різати те, чого в даних уже немає, і мовчки занижувати.
 */
dashboardRouter.get("/leadgen", async (req, res) => {
  const auth = req.auth!;
  // 🔴 ГЕЙТ ПЕРШИМ ОПЕРАТОРОМ (рішення власника 04.08.2026: екран не для менеджерів).
  // Порядок не дрібниця — валідація перед межею дала б 400 замість 403 і зламала б
  // гарантію зліпка #11, на чому ми вже раз відкочували прод.
  if (auth.role === "manager") return res.status(403).json({ error: "Forbidden" });
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  // Тімлід — ТІЛЬКИ своя команда, кламп на СЕРВЕРІ: фільтр у браузері не межа,
  // той самий запит curl-ом віддав би чужі передачі.
  if (auth.role === "team_lead") { teamId = auth.teamId ?? -1; managerId = null; }

  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const params: unknown[] = [];
  const conds: string[] = [];
  if (from) { params.push(from); conds.push(`(lr.transferred_at ${K})::date >= $${params.length}`); }
  if (to) { params.push(to); conds.push(`(lr.transferred_at ${K})::date <= $${params.length}`); }
  // Скоуп — по ЗМАПОВАНОМУ менеджеру, а не по текстовій назві команди з аркуша:
  // назва в таблиці бота може розійтись із нашою, і тімлід тоді побачив би чуже.
  if (managerId) { params.push(managerId); conds.push(`m.id = $${params.length}`); }
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const result = await pool.query<{
    manager_id: number | null; manager_name: string; team_name: string;
    client_source: string; leads: string; unique_leads: string; reached_paid: string;
  }>(
    `WITH paid_clients AS (
       SELECT DISTINCT d.client_key FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     )
     SELECT m.id AS manager_id,
            COALESCE(m.name, lr.manager_name, 'Не вказано') AS manager_name,
            COALESCE(t.name, lr.team_name, 'Без команди') AS team_name,
            COALESCE(NULLIF(d.client_source, ''), 'Не вказано') AS client_source,
            COUNT(*) AS leads,
            COUNT(DISTINCT lr.lead_id) AS unique_leads,
            COUNT(*) FILTER (WHERE d.client_key IN (SELECT client_key FROM paid_clients)) AS reached_paid
       FROM leadgen_registry lr
       -- Лід реєстру → наша угода: назва джерела й клієнт живуть у deals.
       -- LEFT JOIN — передача, чиєї угоди ми ще не бачили, НЕ має зникати з лічби:
       -- це була б тиха втрата саме тих рядків, заради яких реєстр і заводили.
       LEFT JOIN deals d ON d.kommo_id = lr.lead_id
       LEFT JOIN managers m ON m.name = lr.manager_name
       LEFT JOIN teams t ON t.id = m.team_id
       ${where}
      GROUP BY m.id, COALESCE(m.name, lr.manager_name, 'Не вказано'),
               COALESCE(t.name, lr.team_name, 'Без команди'),
               COALESCE(NULLIF(d.client_source, ''), 'Не вказано')`,
    params
  );

  type Gen = { managerId: number; managerName: string; teamName: string; leads: number;
    uniqueLeads: number; reachedPaid: number;
    bySource: { source: string; leads: number; reachedPaid: number; conversion: number }[] };
  const byManager = new Map<string, Gen>();
  for (const row of result.rows) {
    const leads = Number(row.leads);
    const reached = Number(row.reached_paid);
    // Ключ — ІМʼЯ, а не id: незмаплений лідогенератор (id = null) інакше злився б
    // з усіма іншими незмапленими в один рядок «Не вказано».
    const key = `${row.manager_id ?? "x"}|${row.manager_name}`;
    let entry = byManager.get(key);
    if (!entry) {
      entry = { managerId: row.manager_id ?? -1, managerName: row.manager_name,
                teamName: row.team_name, leads: 0, uniqueLeads: 0, reachedPaid: 0, bySource: [] };
      byManager.set(key, entry);
    }
    entry.leads += leads;
    entry.uniqueLeads += Number(row.unique_leads);
    entry.reachedPaid += reached;
    entry.bySource.push({ source: row.client_source, leads, reachedPaid: reached,
      conversion: leads > 0 ? Math.round((reached / leads) * 100) : 0 });
  }

  const allGenerators = Array.from(byManager.values())
    .map((g) => ({
      ...g,
      conversion: g.leads > 0 ? Math.round((g.reachedPaid / g.leads) * 100) : 0,
      bySource: g.bySource.sort((a, b) => b.leads - a.leads),
    }))
    .sort((a, b) => b.leads - a.leads);

  const teamsMap = new Map<string, typeof allGenerators>();
  for (const g of allGenerators) {
    if (!teamsMap.has(g.teamName)) teamsMap.set(g.teamName, []);
    teamsMap.get(g.teamName)!.push(g);
  }
  const isLeadgenTeam = (name: string) => /лідоген|лидоген/i.test(name);
  const groups = Array.from(teamsMap.entries())
    .map(([teamName, gens]) => ({
      teamName,
      isLeadgen: isLeadgenTeam(teamName),
      leads: gens.reduce((s, g) => s + g.leads, 0),
      uniqueLeads: gens.reduce((s, g) => s + g.uniqueLeads, 0),
      reachedPaid: gens.reduce((s, g) => s + g.reachedPaid, 0),
      generators: gens,
    }))
    .sort((a, b) => Number(b.isLeadgen) - Number(a.isLeadgen) || b.leads - a.leads);

  res.json({
    generators: allGenerators, groups,
    unit: "передача заявки менеджеру (рядок реєстру бота); «унікальних» — довідково",
    /**
     * 🔴 РОЗРІЗ ЗМІНИВСЯ РАЗОМ ІЗ ДЖЕРЕЛОМ, і це треба сказати вголос. Реєстр
     * бота несе менеджера, ЯКОМУ передали заявку, — імені лідогенератора в ньому
     * немає взагалі. Тому екран тепер відповідає на питання «хто СКІЛЬКИ ОТРИМАВ»,
     * а не «хто скільки згенерував». Промовчати означало б лишити стару назву над
     * іншою цифрою — рівно та підміна, від якої ми й ішли.
     */
    dimensionNote: "розріз — менеджер, ЯКОМУ передали заявку (реєстр бота не містить "
      + "імені лідогенератора)",
  });
});

/**
 * Executive summary for the head of sales: revenue by team, the top managers
 * by paid revenue, total outstanding receivables and a new-vs-repeat client
 * split — everything scoped by role/team and the selected date range.
 */
dashboardRouter.get("/overview", async (req, res) => {
  const auth = req.auth!;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  if (auth.role === "team_lead") teamId = auth.teamId;
  const managerId = auth.role === "manager" ? auth.managerId : null;

  const paidConds = ["psm.funnel_stage = 'paid'"];
  const params: unknown[] = [];
  if (managerId) {
    params.push(managerId);
    paidConds.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    paidConds.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    paidConds.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    paidConds.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }
  const paidWhere = `WHERE ${paidConds.join(" AND ")}`;

  // Money filter: paid deals by CLOSE date (revenue is recognised when the deal
  // is won, not when the lead was created).
  const closedConds = ["psm.funnel_stage = 'paid'", "d.closed_at_kommo IS NOT NULL"];
  const closedParams: unknown[] = [];
  if (managerId) {
    closedParams.push(managerId);
    closedConds.push(`d.manager_id = $${closedParams.length}`);
  }
  if (teamId) {
    closedParams.push(teamId);
    closedConds.push(`m.team_id = $${closedParams.length}`);
  }
  if (from) {
    closedParams.push(from);
    closedConds.push(`(d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${closedParams.length}`);
  }
  if (to) {
    closedParams.push(to);
    closedConds.push(`(d.closed_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${closedParams.length}`);
  }
  const closedWhere = `WHERE ${closedConds.join(" AND ")}`;

  // "Угоди" = deals that reached the money part of the funnel — from
  // "Виставлено рахунок" (invoiced) through "Успішно реалізовано" (paid) —
  // created within the period.
  const dealConds = paidConds.map((c) =>
    c.includes("funnel_stage") ? "psm.funnel_stage IN ('invoiced','paid')" : c
  );
  const createdLeadsResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${dealConds.join(" AND ")}`,
    params
  );

  // КРОК В: легасі period-ratio «конверсія реклами» (paid ÷ ad_leads по СТВОРЕННЮ,
  // same-deal) ВИДАЛЕНО — Огляд віддає КОГОРТНУ adConversion з ядра
  // (metrics.conversionAdsByMonth → MONEY_ZONE, стеля ≤100%, ⏳ дозрівання) нижче.
  // `adSources` лишається — потрібен для історії та core-конверсій.
  //
  // ⏱ ДАЛІ ПО ЦЬОМУ РОУТУ — ЛІНИВИЙ КЕШ (`overviewCache`, TTL 60 с, рішення власника
  // 25.08.2026, обсяг V3′). Обгорнуто РІВНО девʼять іменованих викликів, що дають
  // 11 із 29 запитів роуту; усі вони НЕ ЗАЛЕЖАТЬ ВІД ПЕРІОДУ **за побудовою** — дати
  // не входять у їхній SQL узагалі, роут ріже період уже після (`sumConv`, проратація).
  // Ключ будується з АРГУМЕНТІВ (`overviewCache.call`), тож забути `teamId` у ключі
  // структурно неможливо; гейт `#211c` саботується саме цим.
  // 🔴 `metrics.buildProjection` СВІДОМО НЕ КЕШУЄТЬСЯ, хоч її три запити теж сталі:
  // вона приймає `planMonthTotal`, який залежить від `to`. Ціна відмови заміряна —
  // ×4 2 421 проти 2 598 мс, тобто в межах шуму Neon; інваріант «набір ключів
  // однаковий для будь-яких двох періодів» вартий більше.
  const { adSources } = await overviewCache.call("getSettings", getSettings);

  // MASTER_PLAN КРОК 2: гроші анкеряться по ДАТІ ВХОДУ В ЕТАП (deal_stage_events),
  // дедуп по угоді — знімки прибрано (недатований знімок мутував минулі місяці).
  //   received  = «Отримані кошти» = увійшли в етап 9 (Оплата отримана) АБО 10
  //               (Успішна) у періоді, РАЗ (9 і 10 — одні гроші).
  //   success   = лише етап 10 (142) — знаменник avg_check_success_only.
  //   paidOnly  = етап 9 без 142 у періоді → received = success ⊎ paidOnly (disjoint).
  //   expected  = етап 8 «Очікуємо оплату» (НЕ «Виставлення рахунку»!).
  const moneyScope: money.MoneyScope = { from, to, managerId, teamId };
  // ⚡ Чотири тотали — ОДНИМ проходом (`moneyTotals`), а не чотирма запитами.
  // Означення грошей не змінилось ані на символ: та сама `sourceSql`, ті самі
  // умови скоупу; `received` і далі агрегується по обʼєднанню success+paidOnly,
  // а не додається як два числа. Рівність двох форм на живих даних — гейт #137.
  const [totals, receivedTeamAgg, receivedMgrAgg, awaitingNow] = await Promise.all([
    money.moneyTotals(moneyScope),
    money.receivedByTeam(moneyScope),
    money.receivedByMgr(moneyScope),
    // 🔑 ЗВУЖЕНИЙ СКОУП, А НЕ `moneyScope` — І ЦЕ НЕ «ВІДКИНУТИ ЧАСТИНУ КЛЮЧА».
    // `awaitingNowSnapshot` — знімок «станом на зараз»: у її SQL стоять лише
    // `managerId`/`teamId`, а `from`/`to` вона не читає взагалі. Передавши повний
    // скоуп, ми поклали б період у КЛЮЧ і кеш не влучив би НІКОЛИ — тобто мовчки
    // виродився б у нуль. Що звуження безпечне, доводиться РІВНІСТЮ РЕЗУЛЬТАТІВ на
    // живих даних (`#211e`), а не читанням тіла функції.
    overviewCache.call("awaitingNowSnapshot", money.awaitingNowSnapshot, { managerId, teamId }),
  ]);
  const receivedTot = totals.received, successTot = totals.success;
  const paidOnlyTot = totals.paidOnly, expectedTot = totals.expected;

  // «Отримані кошти» по командах / менеджерах — анкеровані, дедуп (див. moneyScope).
  const byTeam = {
    rows: [...receivedTeamAgg]
      .sort((a, b) => b.revenue - a.revenue)
      .map((x) => ({ team_id: x.teamId, team_name: x.teamName, revenue: String(x.revenue), deals: String(x.deals) })),
  };
  const topManagers = {
    rows: [...receivedMgrAgg]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((x) => ({ manager_id: x.managerId, name: x.name, revenue: String(x.revenue), deals: String(x.deals) })),
  };

  // New vs repeat (КРОК Г #2): client-grain «нові/постійні» (def A) — винесено в
  // ЯДРО (metrics.newRepeatTotals, primary-attribution, Σ мгр=тотал). Тотал байт-у-байт
  // збігається зі старим inline-firsts (live-звірено). Розріз per team/manager —
  // metrics.newRepeatByScope (для КВП).
  const newRepeatAgg = await metrics.newRepeatTotals({ from, to, managerId, teamId });

  // КРОК 9: загальний борг = core/metrics.receivablesTotal (LEFT JOIN — включає
  // неатрибутований борг при адмін-розрізі; скоуп по менеджеру/команді природно
  // виключає null-рядки, тож роль-скоуп не змінюється).
  // ⚡ Борг і готівка — ОДНИМ запитом: та сама таблиця, той самий скоуп, різниця
  // лише в `source='cash'`, що й виражає FILTER. Готівкова дебіторка з CRM —
  // ОКРЕМА позначка (НЕ в основному тоталі, який 1:1 з таблицею).
  const debtSnap = await overviewCache.call("receivablesSnapshot", metrics.receivablesSnapshot, { managerId, teamId });
  const receivablesTotalValue = debtSnap.total;
  const receivablesCashValue = debtSnap.cash;

  // Plan (monthly payment_amount targets) prorated to the SELECTED period by
  // day-overlap, so the gauge responds to week/month/quarter just like the
  // other stats. Fact = received money for the period (computed below as
  // successRevenue + paymentRevenue, i.e. the same as "Отримані кошти").
  const monthAnchor = to ?? new Date().toISOString().slice(0, 10);
  const planScope: string[] = [];
  const planParams: unknown[] = [];
  if (managerId) { planParams.push(managerId); planScope.push(`p.manager_id = $${planParams.length}`); }
  if (teamId) { planParams.push(teamId); planScope.push(`mp.team_id = $${planParams.length}`); }
  // ⏱ Кешується САМ ЗАПИТ (у ньому немає дат — плани лежать по місяцях), а
  // ПРОРАТАЦІЯ під [from, to] лишається нижче, поза кешем. Ключ містить і текст
  // умови скоупу, і її параметри: SQL тут будується рядком, тож ключ без `planScope`
  // склеїв би адмінський запит із тімлідівським.
  const planMonthsRes = await overviewCache.call(
    "overviewPlanMonths",
    (scopeSql: string, prms: unknown[]) => pool.query<{ mon: string; plan: string }>(
      `SELECT to_char(date_trunc('month', p.plan_date), 'YYYY-MM-DD') AS mon,
              COALESCE(SUM(p.planned_value), 0) AS plan
       FROM plans p JOIN managers mp ON mp.id = p.manager_id
       WHERE p.metric = 'payment_amount'
         ${scopeSql}
       GROUP BY 1`,
      prms
    ),
    planScope.length ? "AND " + planScope.join(" AND ") : "",
    planParams
  );
  // Prorate each month's plan by how many of its days fall inside [from, to].
  const periodFrom = from ? new Date(from + "T00:00:00") : null;
  const periodTo = to ? new Date(to + "T00:00:00") : null;
  const anchorMonth = (to ?? monthAnchor).slice(0, 7);
  let planTotal = 0;
  for (const row of planMonthsRes.rows) {
    const mStart = new Date(row.mon + "T00:00:00");
    const daysInMonth = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0).getDate();
    const planVal = Number(row.plan);
    if (!periodFrom || !periodTo) {
      // No date range (alltime): count only the current anchor month's plan.
      if (row.mon.slice(0, 7) === anchorMonth) planTotal += planVal;
      continue;
    }
    const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
    const ovStart = mStart > periodFrom ? mStart : periodFrom;
    const ovEnd = mEnd < periodTo ? mEnd : periodTo;
    const overlapDays = Math.max(0, Math.round((ovEnd.getTime() - ovStart.getTime()) / 86400000) + 1);
    planTotal += planVal * (overlapDays / daysInMonth);
  }
  planTotal = Math.round(planTotal);
  // Full (un-prorated) plan for the anchor month — so the gauge can show the
  // whole monthly target next to the period-prorated one.
  const planMonthTotal = Math.round(
    planMonthsRes.rows
      .filter((r) => r.mon.slice(0, 7) === anchorMonth)
      .reduce((s, r) => s + Number(r.plan), 0)
  );

  // «Отримані кошти» (анкер по даті входу + дедуп): received = success ⊎ paidOnly,
  // тож successRevenue + paymentRevenue === receivedTot.revenue (без подвійного рахунку).
  const successRevenue = successTot.revenue;
  const successDeals = successTot.deals;
  const paymentRevenue = paidOnlyTot.revenue; // «досі в оплаті» (етап 9, ще не 142)
  const paymentDeals = paidOnlyTot.deals;
  const closedRes = {
    rows: [{ revenue: String(receivedTot.revenue), deals: String(receivedTot.deals) }],
  };

  // All deals created in the Full-cycle funnel within the period (by create date).
  const FULL_CYCLE_PIPELINES = [8921932, 155304];
  const cfScope: string[] = ["d.pipeline_id = ANY($1)"];
  const cfParams: unknown[] = [FULL_CYCLE_PIPELINES];
  if (managerId) { cfParams.push(managerId); cfScope.push(`d.manager_id = $${cfParams.length}`); }
  if (teamId) { cfParams.push(teamId); cfScope.push(`m.team_id = $${cfParams.length}`); }
  if (from) { cfParams.push(from); cfScope.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${cfParams.length}`); }
  if (to) { cfParams.push(to); cfScope.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${cfParams.length}`); }
  const createdFullRes = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM deals d JOIN managers m ON m.id = d.manager_id
     WHERE ${cfScope.join(" AND ")}`,
    cfParams
  );
  // Where those created deals are now — breakdown by current funnel stage (for
  // the "Створені угоди" drill-down: скільки угод на якому етапі).
  const createdByStageRes = await pool.query<{ stage: string | null; c: string; amount: string }>(
    `SELECT psm.funnel_stage AS stage, COUNT(*) AS c, COALESCE(SUM(d.price),0) AS amount
     FROM deals d JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${cfScope.join(" AND ")}
     GROUP BY psm.funnel_stage`,
    cfParams
  );
  const STAGE_ORDER = ["lead_taken", "quote_requested", "approved", "invoiced", "paid"];
  // Підписи кошиків — зі спільного `core/stageNames.ts`: одна стадія має зватись
  // однаково на всіх поверхнях, інакше «Виставлено рахунок» у воронці й у
  // застряглих означають різне.
  const STAGE_LBL = FUNNEL_STAGE_LABELS;
  const createdByStage = [
    ...STAGE_ORDER.map((st) => {
      const r = createdByStageRes.rows.find((x) => x.stage === st);
      return { stage: st, label: STAGE_LBL[st], deals: Number(r?.c ?? 0), amount: Number(r?.amount ?? 0) };
    }),
    (() => {
      const other = createdByStageRes.rows.filter((x) => !x.stage || !STAGE_ORDER.includes(x.stage));
      return { stage: "other", label: "Інші етапи", deals: other.reduce((s, x) => s + Number(x.c), 0), amount: other.reduce((s, x) => s + Number(x.amount), 0) };
    })(),
  ].filter((s) => s.deals > 0);

  // «Перенесені» — ДЕТЕРМІНОВАНА реконструкція з deal_stage_events на 00:00 дня-1
  // місяця (ядро metrics.carryoverByScope, зона EXPECT_ZONE). Замінює знімок-таблицю
  // monthly_carryover (корумпувалась startup-джобою). Скоуп як у решті Огляду →
  // збігається зі Звітом 2.0 (та сама функція).
  const carryMonth = (from ? from.slice(0, 7) : new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" }).slice(0, 7)) + "-01";
  const carryover = await metrics.carryoverByScope({ managerId, teamId }, carryMonth);

  // Repeat clients active in the period (for the "Постійні клієнти" drill-down):
  // their in-period order count and revenue. "Repeat" = first-ever paid before
  // the period (or 2+ lifetime when no date range), matching the KPI logic.
  const repeatListRes = await pool.query<{ name: string; orders: string; revenue: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key
     )
     SELECT COALESCE(MAX(d.client_name), 'Клієнт') AS name,
            COUNT(*) AS orders,
            COALESCE(SUM(d.price), 0) AS revenue
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     ${paidWhere}
       AND ${from ? `f.first_paid < $${params.length + 1}::date` : `f.cnt >= 2`}
     GROUP BY d.client_key
     ORDER BY revenue DESC
     LIMIT 300`,
    from ? [...params, from] : params
  );
  const repeatClientsList = repeatListRes.rows.map((r) => ({
    clientName: r.name,
    orders: Number(r.orders),
    revenue: Number(r.revenue),
  }));

  // New clients (first-ever paid in the period) split by acquisition channel:
  // ad (context/target), leadgen, or other (manually-created / previously
  // unseen client). For the "Нові клієнти" drill-down.
  const newBySourceRes = await pool.query<{ ch: string; clients: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key
     )
     SELECT COALESCE(d.lead_channel, 'other') AS ch, COUNT(DISTINCT d.client_key) AS clients
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     ${paidWhere}
       AND ${from ? `f.first_paid >= $${params.length + 1}::date` : `f.cnt = 1`}
     GROUP BY 1`,
    from ? [...params, from] : params
  );
  const newClientsBySource = { ad: 0, leadgen: 0, other: 0 } as { ad: number; leadgen: number; other: number };
  for (const r of newBySourceRes.rows) {
    if (r.ch === "ad" || r.ch === "leadgen") newClientsBySource[r.ch] = Number(r.clients);
    else newClientsBySource.other += Number(r.clients);
  }

  // New clients list (name + orders + revenue in the period) for the "Виручка
  // від нових клієнтів" drill-down — same cohort as newClientsBySource.
  const newListRes = await pool.query<{ name: string; orders: string; revenue: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key
     )
     SELECT COALESCE(MAX(d.client_name), 'Клієнт') AS name,
            COUNT(*) AS orders,
            COALESCE(SUM(d.price), 0) AS revenue
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     ${paidWhere}
       AND ${from ? `f.first_paid >= $${params.length + 1}::date` : `f.cnt = 1`}
     GROUP BY d.client_key
     ORDER BY revenue DESC
     LIMIT 300`,
    from ? [...params, from] : params
  );
  const newClientsList = newListRes.rows.map((r) => ({
    clientName: r.name,
    orders: Number(r.orders),
    revenue: Number(r.revenue),
  }));

  const newRow = { clients: newRepeatAgg.newClients, revenue: newRepeatAgg.newRevenue };
  const repeatRow = { clients: newRepeatAgg.repeatClients, revenue: newRepeatAgg.repeatRevenue };

  // Передані заявки: lead-gen qualification leads handed to a SALES manager
  // (entity_responsible_changed on a Кваліфікація lead) in the period, by team.
  //
  // Two corrections vs. the old logic:
  //  1) Exclude lead-gen teams themselves — a "передача" is lead-gen → sales, so
  //     leads whose owner sits in a lead-gen team (name містить «лідоген») are
  //     round-robin within lead-gen, not a real handover to a manager.
  //  2) "Успішно" is measured CROSS-PIPELINE by client: the transferred lead
  //     itself stays in Кваліфікація (never reaches 'paid'), so counting the
  //     team's own won deals is the wrong population (gave conversion >100%).
  //     A transferred lead counts as успішна коли його КЛІЄНТ (client_key)
  //     дійшов до виграної угоди повного циклу — same logic as lead-quality.
  const trParams: unknown[] = [];
  const trConds: string[] = ["t.name NOT ILIKE '%лідоген%'"];
  if (managerId) { trParams.push(managerId); trConds.push(`d.manager_id = $${trParams.length}`); }
  if (teamId) { trParams.push(teamId); trConds.push(`m.team_id = $${trParams.length}`); }
  if (from) { trParams.push(from); trConds.push(`(lr.transferred_at AT TIME ZONE 'Europe/Kyiv')::date >= $${trParams.length}`); }
  if (to) { trParams.push(to); trConds.push(`(lr.transferred_at AT TIME ZONE 'Europe/Kyiv')::date <= $${trParams.length}`); }
  const trWhere = trConds.join(" AND ");
  // Counts: transferred leads and, of them, how many whose client won a full-cycle deal.
  const transferredRes = await pool.query<{ team_id: number; team_name: string; transferred: string; success: string }>(
    `WITH won_clients AS (
       SELECT DISTINCT d.client_key FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.pipeline_id IN (8921932, 155304) AND d.client_key IS NOT NULL
         AND (d.status_id = 142 OR psm.funnel_stage = 'paid')
     ),
     tl AS (
       -- «Реєстр» лідоген-бота — джерело правди для переданих (НЕ lead_transfer_events,
       -- який рахує кожну зміну відповідального і завищує в рази).
       SELECT DISTINCT lr.lead_id AS kommo_id, d.client_key, t.id AS team_id, t.name AS team_name
       FROM leadgen_registry lr
       JOIN deals d ON d.kommo_id = lr.lead_id
       JOIN managers m ON m.id = d.manager_id
       JOIN teams t ON t.id = m.team_id
       WHERE ${trWhere}
     )
     SELECT team_id, team_name,
            COUNT(*) AS transferred,
            COUNT(*) FILTER (WHERE client_key IN (SELECT client_key FROM won_clients)) AS success
     FROM tl GROUP BY team_id, team_name`, trParams);
  // Revenue of the won full-cycle deals for the DISTINCT converted clients per team.
  const transferRevRes = await pool.query<{ team_id: number; revenue: string }>(
    `WITH won AS (
       SELECT d.client_key, SUM(d.price) AS rev FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.pipeline_id IN (8921932, 155304) AND d.client_key IS NOT NULL
         AND (d.status_id = 142 OR psm.funnel_stage = 'paid')
       GROUP BY d.client_key
     ),
     tlc AS (
       SELECT DISTINCT d.client_key, t.id AS team_id
       FROM leadgen_registry lr
       JOIN deals d ON d.kommo_id = lr.lead_id
       JOIN managers m ON m.id = d.manager_id
       JOIN teams t ON t.id = m.team_id
       WHERE ${trWhere} AND d.client_key IS NOT NULL
     )
     SELECT tlc.team_id, COALESCE(SUM(won.rev), 0) AS revenue
     FROM tlc JOIN won ON won.client_key = tlc.client_key
     GROUP BY tlc.team_id`, trParams);
  const trMap = new Map<number, { teamId: number; teamName: string; transferred: number; success: number; successRevenue: number }>();
  const trGet = (id: number, name: string) => {
    let e = trMap.get(id);
    if (!e) { e = { teamId: id, teamName: name, transferred: 0, success: 0, successRevenue: 0 }; trMap.set(id, e); }
    return e;
  };
  for (const r of transferredRes.rows) { const e = trGet(r.team_id, r.team_name); e.transferred += Number(r.transferred); e.success += Number(r.success); }
  for (const r of transferRevRes.rows) { const e = trMap.get(r.team_id); if (e) e.successRevenue += Number(r.revenue); }
  const transferred = {
    total: [...trMap.values()].reduce((s, e) => s + e.transferred, 0),
    success: [...trMap.values()].reduce((s, e) => s + e.success, 0),
    byTeam: [...trMap.values()].filter((e) => e.transferred > 0 || e.success > 0).sort((a, b) => b.transferred - a.transferred),
  };

  // Last 3 complete months (deals / paid / revenue) for the drill-down trend.
  const histScope: string[] = [];
  if (managerId) histScope.push(`d.manager_id = ${Number(managerId)}`);
  if (teamId) histScope.push(`m.team_id = ${Number(teamId)}`);
  const histWhere = histScope.length ? "AND " + histScope.join(" AND ") : "";
  const histRes = await pool.query<{
    month: string;
    deals: string;
    paid: string;
    new_clients: string;
    repeat_clients: string;
    dispatched: string;
  }>(
    `WITH firsts AS (
       SELECT d2.client_key, MIN(d2.created_at_kommo) AS first_paid
       FROM deals d2
       JOIN pipeline_stage_map p2 ON p2.pipeline_id = d2.pipeline_id AND p2.status_id = d2.status_id
       WHERE p2.funnel_stage = 'paid' AND d2.client_key IS NOT NULL
       GROUP BY d2.client_key
     )
     SELECT to_char(date_trunc('month', d.created_at_kommo), 'YYYY-MM') AS month,
            COUNT(*) FILTER (WHERE psm.funnel_stage IN ('invoiced','paid')) AS deals,
            COUNT(*) FILTER (WHERE psm.funnel_stage IN ('invoiced','paid') OR d.status_id IN (69716300,98470988,10937178)) AS dispatched,
            COUNT(*) FILTER (WHERE psm.funnel_stage = 'paid') AS paid,
            COUNT(DISTINCT d.client_key) FILTER (
              WHERE psm.funnel_stage = 'paid'
                AND date_trunc('month', f.first_paid) = date_trunc('month', d.created_at_kommo)) AS new_clients,
            COUNT(DISTINCT d.client_key) FILTER (
              WHERE psm.funnel_stage = 'paid'
                AND date_trunc('month', f.first_paid) < date_trunc('month', d.created_at_kommo)) AS repeat_clients
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     -- LEFT: немапнуті статуси (АВТО/143) мають рахуватись у created/ad_leads/dispatched
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     LEFT JOIN firsts f ON f.client_key = d.client_key
     WHERE d.created_at_kommo >= date_trunc('month', $1::date) - interval '2 months'
       AND d.created_at_kommo < date_trunc('month', $1::date) + interval '1 month'
       ${histWhere}
     GROUP BY 1 ORDER BY 1`,
    // ⚠️ Ця вибірка має ЛИШЕ $1 (monthAnchor). adSources тут НЕ використовується —
    // передача 2-го параметра → Postgres 08P01 «bind supplies 2 params, requires 1»
    // → unhandledRejection → відповідь /overview НІКОЛИ не надсилалась → воркер PHP-FPM
    // висів до таймауту → ранковий herd вичерпував пул → edge 503. НЕ додавати сюди $2.
    [monthAnchor]
  );
  // 🔴 ПРАВИЛО ВЛАСНИКА (02.08.2026): ГРОШІ в «Історії за 3 місяці» — це ① «успішно
  // реалізовано», анкер = дата входу в 142, а НЕ місяць створення угоди.
  //
  // Було: `SUM(price) FILTER (funnel_stage='paid')` згруповане по `created_at_kommo`.
  // Тобто угода, створена в червні й оплачена в липні, не потрапляла НІКУДИ, а створена
  // в липні й ще не оплачена — теж. Похибка структурно найбільша саме в поточному
  // місяці: липень показував 2 079 764 ₴ замість 2 765 155 ₴ (−24.8%).
  //
  // Кількісні поля (deals/dispatched/newClients/repeatClients) лишаються когортою
  // СТВОРЕННЯ — вони про «скільки завели», і це інше питання, ніж «скільки грошей».
  // Той самий поділ, що вже діє в `/managers`: кількості з SQL, гроші з ядра.
  const histFrom = `${histRes.rows[0]?.month ?? monthAnchor.slice(0, 7)}-01`;
  const succByMonth = new Map(
    (await money.successByBucket({ from: histFrom, to: monthAnchor, managerId, teamId }, "month"))
      .map((b) => [b.bucket.slice(0, 7), b])
  );
  const monthlyHistory = histRes.rows.map((r) => {
    const deals = Number(r.deals);
    const paid = Number(r.paid);
    const succ = succByMonth.get(r.month);
    const revenue = succ?.revenue ?? 0;
    return {
      month: r.month,
      deals,
      paid,
      revenue,
      conversion: deals > 0 ? Math.round((paid / deals) * 100) : 0,
      // Чек історії — той самий `avg_check_success_only`, що й на картці: ① виручка
      // місяця ÷ ① угоди місяця. Раніше знаменником стояли «поставлені машини» з
      // когорти СТВОРЕННЯ — чисельник і знаменник рахувались за різними подіями,
      // тож число не дорівнювало нічому в системі (еталон листа 2600–2900).
      avgCheck: succ && succ.deals > 0 ? Math.round(revenue / succ.deals) : 0,
      // Крок В: adConversion/leadgenConversion — КОГОРТНІ з ядра (MONEY_ZONE),
      // перекриваються нижче по ym (adByYm/trByYm). Легасі period-ratio знято.
      adConversion: 0,
      leadgenConversion: 0,
      newClients: Number(r.new_clients),
      repeatClients: Number(r.repeat_clients),
    };
  });

  // Прогноз ПОТОЧНОГО МІСЯЦЯ (незалежно від обраного періоду) — ФОРМУЛА A через ЄДИНЕ
  // ЯДРО metrics.buildProjection (та сама функція, що й Звіт 2.0 → число байт-у-байт
  // збігається зі Звітом 2.0 на тому ж місяці). Легасі inline-D (successMTD×k+paidOnly)
  // ВИДАЛЕНО: прогноз більше НЕ рахується у роуті. Період = весь поточний місяць
  // [1-е … кінець], granularity='month' → buildProjection сам клампить elapsed до сьогодні.
  const nowK = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const mStartP = nowK.slice(0, 7) + "-01";
  const [mY, mM] = mStartP.split("-").map(Number);
  const mEndP = `${mStartP.slice(0, 7)}-${String(new Date(mY, mM, 0).getDate()).padStart(2, "0")}`;
  const proj = await metrics.buildProjection(
    { from: mStartP, to: mEndP, managerId, teamId, granularity: "month" },
    planMonthTotal
  );
  const projection = {
    monthFact: proj.fact,
    projected: proj.projected,
    plan: planMonthTotal,
    projectedPct: proj.projectedPct,
    elapsedWorkingDays: proj.elapsedWorkingDays,
    totalWorkingDays: proj.totalWorkingDays,
  };

  // «Очікування» плитки Огляду = ПОВНА грошова зона (expectedPaymentsByPlanned.total —
  // усі 5 стадій за статусом), те саме джерело й число, що «Очікувані оплати» Звіту 2.0
  // (НЕ вузький етап-8-знімок money.expectedMoney, який лишається лише для avgCheckExpected).
  // byTeam — розріз ТІЄЇ САМОЇ зони (Σ рядків = total) для дрілдауну картки.
  // 🔴 ЗОНУ БЕРЕМО З ПРОГНОЗУ, А НЕ РАХУЄМО ВДРУГЕ. `buildProjection` вище вже
  // викликав `expectedPaymentsByPlanned` із ТИМИ САМИМИ аргументами — це був
  // ідентичний SQL з ідентичними параметрами, тобто чиста втрата зʼєднання й часу
  // (заміряно 05.08.2026). Число те саме за побудовою: один виклик, одне джерело.
  const expectedZone = proj.expectedZone;
  const expectedZoneTeams = await overviewCache.call("expectedZoneByScope:team", metrics.expectedZoneByScope, { managerId, teamId }, "team");

  // КРОК 9-conv Фаза 1: конверсія — з ЯДРА (core/metrics), стеля ≤100%.
  //   Реклама → conversion_ads (cohort основне, period тренд).
  //   Лідоген → ДВІ окремі: Продзвін + Реактивація (won велике, handoff дрібне).
  // Стару adConversion/leadgenConversion-логіку не видалено (Фаза 3); тут лише
  // перемикаємо, що ВІДДАЄ роут. entered<10 → «—».
  const adsMonthlyOv = await overviewCache.call("conversionAdsByMonth", metrics.conversionAdsByMonth, { managerId, teamId }, adSources);
  const pzMonthlyOv = await overviewCache.call("conversionProdzvinByMonth", metrics.conversionProdzvinByMonth, { managerId, teamId });
  const reMonthlyOv = await overviewCache.call("conversionReactivationByMonth", metrics.conversionReactivationByMonth, { managerId, teamId });
  // Крок В #4: «Конверсія лідогену» = КОГОРТА переданих заявок (transferred_at) →
  // дійшли до MONEY_ZONE (когортна, стеля ≤100%, ⏳). Замінює стару period-ratio.
  const trMonthlyOv = await overviewCache.call("conversionTransferredByMonth", metrics.conversionTransferredByMonth, { managerId, teamId });
  const adAgg = sumConv(adsMonthlyOv, from, to);
  const pzAgg = sumConv(pzMonthlyOv, from, to);
  const reAgg = sumConv(reMonthlyOv, from, to);
  const trAgg = sumConv(trMonthlyOv, from, to);
  const adConversionOut = { leads: adAgg.entered, paid: adAgg.wonCount, conversion: adAgg.wonCohort, conversionPeriod: adAgg.wonPeriod, mature: adAgg.mature };
  const prodzvinConversion = { entered: pzAgg.entered, won: pzAgg.wonCohort, wonPeriod: pzAgg.wonPeriod, handoff: pzAgg.handoffCohort, mature: pzAgg.mature };
  const reactivationConversion = { entered: reAgg.entered, won: reAgg.wonCohort, wonPeriod: reAgg.wonPeriod, handoff: reAgg.handoffCohort, mature: reAgg.mature };
  // Спарклайни: adConversion + won-лідоген + лідоген-передачі по місяцях із ядра
  // (перекриваємо старі period-ratio у monthlyHistory).
  const adByYm = new Map(adsMonthlyOv.map((r) => [r.ym, r.cohortPct]));
  const pzByYm = new Map(pzMonthlyOv.map((r) => [r.ym, r.wonCohortPct]));
  const reByYm = new Map(reMonthlyOv.map((r) => [r.ym, r.wonCohortPct]));
  const trByYm = new Map(trMonthlyOv.map((r) => [r.ym, r.cohortPct]));
  for (const h of monthlyHistory) {
    h.adConversion = adByYm.get(h.month) ?? 0;
    h.leadgenConversion = trByYm.get(h.month) ?? 0;
    (h as Record<string, unknown>).prodzvinWon = pzByYm.get(h.month) ?? 0;
    (h as Record<string, unknown>).reactivationWon = reByYm.get(h.month) ?? 0;
  }

  res.json({
    /**
     * 🔴 ЧИ ПОТОЧНИЙ ПЕРІОД — ПОТРІБНО ЕКРАНУ, А НЕ ЛИШЕ НАМ (рішення власника 07.08.2026).
     *
     * На Огляді є ЗНІМКОВІ показники — дебіторка, перехідні, очікування. Вони
     * показують стан «зараз» і НЕ залежать від обраного періоду: заміряно 07.08 —
     * `receivablesTotal` 9 446 853 ₴ однаковий і за липень, і за тиждень 21–27.07,
     * і за один день 15.07. Числа при цьому ПРАВИЛЬНІ — бреше подача: людина читає
     * їх як «за липень».
     *
     * Рішення — ПІДПИСУВАТИ, не ховати: сховане число шукають і питають, чи не
     * зламалось. Той самий вибір, що вже зробили для «ще попереду» і «мало історії».
     * Фронту для цього потрібен рівно один прапорець.
     */
    scope: { from: from ?? null, to: to ?? null,
      isCurrent: (() => {
        const kyivToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
        // Без меж (alltime) — вважаємо поточним: знімок і період там про одне й те саме.
        if (!from || !to) return true;
        return from <= kyivToday && kyivToday <= to;
      })() },
    plan: planTotal,
    planMonthTotal,
    projection,
    // 🔴 ПРАВИЛО ВЛАСНИКА (02.08.2026): «Виконано плану» — це РЕЗУЛЬТАТ, тож ① лише
    // «успішно реалізовано» (142). Було `successRevenue + paymentRevenue` = ②: частково
    // оплачені угоди переносяться в наступний місяць, і зараховувати їх зараз означало б
    // рахувати незавершене. ② лишається окремою карткою «Отримані кошти», підписаною
    // як орієнтир, — і `paymentRevenue` нижче у відповіді для неї.
    fact: successRevenue,
    planPct: planTotal > 0 ? Math.round((successRevenue / planTotal) * 100) : 0,
    closedRevenue: Number(closedRes.rows[0]?.revenue ?? 0),
    closedDeals: Number(closedRes.rows[0]?.deals ?? 0),
    successRevenue,
    successDeals,
    paymentRevenue,
    paymentDeals,
    // ДВА середні чеки (складати заборонено): фактичний (received) і очікуваний
    // (етап 8). avgCheckSuccessOnly — лише успіх, для звірки з листом (2600–2900).
    avgCheckSuccessOnly: successDeals > 0 ? Math.round(successRevenue / successDeals) : 0,
    avgCheckReceived: receivedTot.deals > 0 ? Math.round(receivedTot.revenue / receivedTot.deals) : 0,
    avgCheckExpected: expectedTot.deals > 0 ? Math.round(expectedTot.revenue / expectedTot.deals) : 0,
    expectedPayments: { deals: expectedTot.deals, revenue: expectedTot.revenue },
    // Знімок «станом на зараз» (етапи 8+9 зараз) — прогноз, НІКОЛИ не у виручці періоду.
    awaitingNow: { asOf: "now", deals: awaitingNow.deals, revenue: awaitingNow.revenue, byTeam: awaitingNow.byTeam },
    pendingPayments: {
      deals: expectedZone.total.deals,
      revenue: expectedZone.total.sum,
      byTeam: expectedZoneTeams.map((r) => ({
        teamId: r.teamId,
        teamName: r.name,
        deals: r.deals,
        revenue: r.sum,
      })),
    },
    createdFullCycle: Number(createdFullRes.rows[0]?.c ?? 0),
    // Правило №1 (словник): «Поставлені машини» = угоди, що ПЕРЕЙШЛИ в «Успішно
    // реалізовано» в періоді — той самий якір, що й дохід. Снапшот-проксі видалено.
    dispatchedCount: successDeals,
    createdByStage,
    carryover,
    repeatClientsList,
    newClientsList,
    newClientsBySource,
    transferred,
    // КРОК 9-conv Фаза 1: реклама з ядра (cohort, стеля ≤100%).
    adConversion: adConversionOut,
    // ДВІ лідоген-плитки з ядра (won велике, handoff дрібне; рішення власника).
    prodzvinConversion,
    reactivationConversion,
    // Крок В #4: «Конверсія лідогену» — КОГОРТА переданих заявок (transferred_at,
    // дедуп по client_key) → дійшли до MONEY_ZONE у Повному циклі. Стеля ≤100%,
    // ⏳ дозрівання, entered<10 → «—» (conversion=null). Стару period-ratio знято.
    leadgenConversion: {
      leads: trAgg.entered,
      paid: trAgg.wonCount,
      conversion: trAgg.wonCohort,
      conversionPeriod: trAgg.wonPeriod,
      mature: trAgg.mature,
    },
    monthlyHistory,
    byTeam: byTeam.rows.map((r) => ({
      teamId: r.team_id,
      teamName: r.team_name,
      revenue: Number(r.revenue),
      deals: Number(r.deals),
    })),
    topManagers: topManagers.rows.map((r) => ({
      managerId: r.manager_id,
      name: r.name,
      revenue: Number(r.revenue),
      deals: Number(r.deals),
    })),
    receivablesTotal: receivablesTotalValue,
    receivablesCash: receivablesCashValue,
    createdLeads: Number(createdLeadsResult.rows[0]?.count ?? 0),
    newClients: Number(newRow?.clients ?? 0),
    newRevenue: Number(newRow?.revenue ?? 0),
    repeatClients: Number(repeatRow?.clients ?? 0),
    repeatRevenue: Number(repeatRow?.revenue ?? 0),
  });
});

/**
 * Conversion split by lead channel — paid ads/targeting vs. the lead-gen
 * department vs. other — so each acquisition source can be tracked
 * separately. Scoped by role/team and optional date range like /funnel.
 */
dashboardRouter.get("/conversion", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }
  // Source conversion is about the FULL-CYCLE sales funnel only: every deal
  // created in the period there is either "ad" (contextual/google-utm) or
  // "other" = created manually by a manager. Leadgen leads live in their own
  // pipelines and have a dedicated "Конверсія лідогену" card, so they are not
  // part of this table.
  conditions.push(`d.pipeline_id = ANY(ARRAY[8921932, 155304])`);
  const where = `WHERE ${conditions.join(" AND ")}`;

  // «Реклама» = угоди повного циклу з рекламним «Источник клиента» (той самий
  // перелік adSources, що й «прийняв рекламу») — не lead_channel='ad'.
  const { adSources } = await getSettings();
  params.push(adSources);
  const adCase = `CASE WHEN ${metrics.adDealSql(`$${params.length}`)} THEN 'ad' ELSE 'other' END`;

  // "paid" = leads whose CLIENT reached a paid full-cycle deal (client_key
  // match). "paid_amount" is the lead's own paid value.
  const result = await pool.query<{
    lead_channel: string | null;
    leads: string;
    paid: string;
    paid_amount: string;
  }>(
    `WITH paid_clients AS (
       SELECT DISTINCT d.client_key
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     )
     SELECT ${adCase} AS lead_channel,
            COUNT(*) AS leads,
            COUNT(*) FILTER (WHERE d.client_key IN (SELECT client_key FROM paid_clients)) AS paid,
            COALESCE(SUM(d.price) FILTER (WHERE psm.funnel_stage = 'paid'), 0) AS paid_amount
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     LEFT JOIN pipeline_stage_map psm
       ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
     GROUP BY ${adCase}`,
    params
  );

  const labels: Record<string, string> = {
    ad: "Таргет / реклама (контекст)",
    other: "Створені вручну (інше)",
  };

  // КРОК 9-conv Фаза 1: рядок «ad» — конверсія з ЯДРА (conversion_ads, cohort,
  // стеля ≤100%). Рядок «other» (створені вручну) — на старому (не одна з 3 нових).
  const adAggConv = sumConv(await metrics.conversionAdsByMonth({ managerId, teamId }, adSources), from, to);

  const channels = ["ad", "other"].map((ch) => {
    const row = result.rows.find((r) => r.lead_channel === ch);
    const leads = Number(row?.leads ?? 0);
    const paid = Number(row?.paid ?? 0);
    return {
      channel: ch,
      label: labels[ch],
      leads: ch === "ad" ? adAggConv.entered : leads,
      // ad: paid = сира к-ть виграних когорти (щоб leads/paid узгоджувалось із cohort%).
      paid: ch === "ad" ? adAggConv.wonCount : paid,
      paidAmount: Number(row?.paid_amount ?? 0),
      conversion: ch === "ad" ? adAggConv.wonCohort : (leads > 0 ? Math.round((paid / leads) * 100) : 0),
      conversionPeriod: ch === "ad" ? adAggConv.wonPeriod : undefined,
      mature: ch === "ad" ? adAggConv.mature : undefined,
    };
  });

  res.json({ channels });
});

/**
 * Динаміка конверсії в часі (по днях/тижнях/місяцях) — для графіка тренду в Звіті.
 * Когорта = угоди повного циклу, СТВОРЕНІ у бакеті; «конвертована» = клієнт угоди
 * дійшов до оплаченої угоди повного циклу (крос-пайплайн, як у /conversion).
 * Скоуп: manager/team (роль-обмежений). Опційно розріз реклама vs інше.
 */
dashboardRouter.get("/conversion-timeseries", async (req, res) => {
  const auth = req.auth!;
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const gran = req.query.granularity === "month" ? "month" : req.query.granularity === "day" ? "day" : "week";
  const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth() - 2, 1).toISOString().slice(0, 10);
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") teamId = auth.teamId;

  const { adSources } = await getSettings();
  const params: unknown[] = [from, to, adSources];
  const conds = [
    "d.pipeline_id = ANY(ARRAY[8921932, 155304])",
    `(d.created_at_kommo ${KYIV})::date BETWEEN $1 AND $2`,
  ];
  if (managerId) { params.push(managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }

  const r = await pool.query<{ bucket: string; leads: string; paid: string; ad_leads: string; ad_paid: string }>(
    `WITH paid_clients AS (
       SELECT DISTINCT d.client_key FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     )
     SELECT to_char(date_trunc('${gran}', (d.created_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket,
            COUNT(*) AS leads,
            COUNT(*) FILTER (WHERE d.client_key IN (SELECT client_key FROM paid_clients)) AS paid,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql("$3")}) AS ad_leads,
            COUNT(*) FILTER (WHERE ${metrics.adDealSql("$3")} AND d.client_key IN (SELECT client_key FROM paid_clients)) AS ad_paid
       FROM deals d JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")}
      GROUP BY 1 ORDER BY 1`,
    params
  );
  // КРОК 9-conv Фаза 1: лінія «Конверсія реклами» — з ЯДРА (conversion_ads,
  // помісячний cohort, стеля ≤100%). Кожен бакет мапиться на cohort свого місяця
  // (для day/week — сходинками по місяцю; це чесна помісячна роздільність когорти).
  // Лінія «Загальна конверсія» (points.conversion) — на старому (full-cycle, В4).
  const adsTsByYm = new Map(
    (await metrics.conversionAdsByMonth({ managerId, teamId }, adSources)).map((m) => [m.ym, m.cohortPct])
  );
  const points = r.rows.map((x) => {
    const leads = Number(x.leads), paid = Number(x.paid), adLeads = Number(x.ad_leads), adPaid = Number(x.ad_paid);
    return {
      bucket: x.bucket, leads, paid,
      conversion: leads > 0 ? Math.round((paid / leads) * 100) : 0,
      adLeads, adPaid,
      adConversion: adsTsByYm.get(x.bucket.slice(0, 7)) ?? null,
    };
  });
  res.json({ from, to, granularity: gran, points });
});

/**
 * Returns deal counts/amounts per funnel stage, bucketed by day or month,
 * for trend charts (used by the company-wide / head-of-sales overview).
 */
dashboardRouter.get("/timeseries", async (req, res) => {
  const auth = req.auth!;
  const granularity =
    req.query.granularity === "month"
      ? "month"
      : req.query.granularity === "week"
        ? "week"
        : "day";
  const managerIdParam = req.query.managerId ? Number(req.query.managerId) : null;
  const teamIdParam = req.query.teamId ? Number(req.query.teamId) : null;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  let managerId = managerIdParam;
  let teamId = teamIdParam;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }
  // admin (e.g. head of sales / КВП): no forced scoping, sees everything
  // unless managerId/teamId is explicitly passed as a query param.

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT date_trunc('${granularity}', d.created_at_kommo) AS period,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${where}
     GROUP BY period, psm.funnel_stage
     ORDER BY period`,
    params
  );

  res.json({ points: result.rows });
});

const METRICS = ["lead_taken", "quote_requested", "approved", "invoiced", "paid", "payment_amount"] as const;

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function elapsedDaysInMonth(month: string, today = new Date()): number {
  const total = daysInMonth(month);
  const todayMonth = today.toISOString().slice(0, 7);
  if (month < todayMonth) return total;
  if (month > todayMonth) return 0;
  return today.getDate();
}

type Forecast = {
  plan: number;
  fact: number;
  remaining: number;
  projected: number;
  projectedPct: number;
  status: "no_plan" | "on_track" | "at_risk" | "behind";
};

function buildForecast(plan: number, fact: number, month: string): Forecast {
  if (plan <= 0) {
    return { plan, fact, remaining: 0, projected: fact, projectedPct: 0, status: "no_plan" };
  }
  const total = daysInMonth(month);
  const elapsed = elapsedDaysInMonth(month);
  const projected = elapsed > 0 ? (fact / elapsed) * total : fact;
  const projectedPct = projected / plan;
  const status: Forecast["status"] =
    projectedPct >= 0.97 ? "on_track" : projectedPct >= 0.85 ? "at_risk" : "behind";
  return { plan, fact, remaining: Math.max(plan - fact, 0), projected, projectedPct, status };
}

/**
 * Per-manager plan-vs-fact breakdown for a team, bucketed by week, for a
 * given month. Fact comes from synced Kommo deals; plan comes from the
 * manually-entered `plans` table (targets are a management decision, not
 * CRM data, so that part stays manual).
 */
dashboardRouter.get("/managers", async (req, res) => {
  const auth = req.auth!;
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;

  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") {
    return res.status(403).json({ error: "Forbidden" });
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }
  if (!teamId) {
    return res.status(400).json({ error: "teamId is required" });
  }

  const managersResult = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM managers WHERE team_id = $1 AND is_active = true ORDER BY name`,
    [teamId]
  );
  const managers = managersResult.rows;
  if (managers.length === 0) {
    return res.json({ managers: [] });
  }
  const managerIds = managers.map((m) => m.id);

  const factResult = await pool.query<{
    manager_id: number;
    week_start: string;
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT d.manager_id,
            date_trunc('week', d.created_at_kommo AT TIME ZONE 'Europe/Kyiv') AS week_start,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = ANY($1)
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
     GROUP BY d.manager_id, week_start, psm.funnel_stage`,
    [managerIds, monthStart]
  );

  const planResult = await pool.query<{
    manager_id: number;
    week_start: string;
    metric: string;
    planned_value: string;
  }>(
    `SELECT manager_id,
            date_trunc('week', plan_date) AS week_start,
            metric,
            SUM(planned_value) AS planned_value
     FROM plans
     WHERE manager_id = ANY($1)
       AND plan_date >= $2::date
       AND plan_date < ($2::date + interval '1 month')
     GROUP BY manager_id, week_start, metric`,
    [managerIds, monthStart]
  );

  type WeekRow = { weekStart: string; metric: string; plan: number; fact: number };
  const rowsByManager = new Map<number, WeekRow[]>();

  function getOrInit(managerId: number, weekStart: string, metric: string): WeekRow {
    const rows = rowsByManager.get(managerId) ?? [];
    rowsByManager.set(managerId, rows);
    let row = rows.find((r) => r.weekStart === weekStart && r.metric === metric);
    if (!row) {
      row = { weekStart, metric, plan: 0, fact: 0 };
      rows.push(row);
    }
    return row;
  }

  for (const r of factResult.rows) {
    if (METRICS.includes(r.funnel_stage as (typeof METRICS)[number])) {
      const row = getOrInit(r.manager_id, r.week_start, r.funnel_stage);
      row.fact = Number(r.deal_count);
    }
  }
  for (const r of planResult.rows) {
    const row = getOrInit(r.manager_id, r.week_start, r.metric);
    row.plan = Number(r.planned_value);
  }
  // КРОК 2: payment_amount ФАКТ = «Отримані кошти» по тижнях (анкер по даті входу в
  // етап 9∪10 + дедуп), а НЕ created-cohort знімок funnel_stage='paid' (той мутував:
  // минулі тижні росли, коли угоди доходили до оплати). Сума тижнів = місячний received.
  const recvWeeks = await money.successByManagerWeek(managerIds, monthStart);   // ① результат менеджера
  for (const r of recvWeeks) getOrInit(r.managerId, r.weekStart, "payment_amount").fact += r.revenue;

  // «Очікування оплат» = вхід у етап 8 «Очікуємо оплату» в місяці (анкер по даті
  // входу, НЕ знімок і НЕ «Виставлення рахунку»). Core/money.ts.
  const [expY, expM] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(expY, expM, 0)).toISOString().slice(0, 10);
  const expList = await money.expectedByMgr({ teamId, from: monthStart, to: monthEnd });
  const expByMgr = new Map(expList.map((x) => [x.managerId, x.revenue]));

  const managersOut = managers.map((m) => {
    const weeks = rowsByManager.get(m.id) ?? [];
    const totals: Record<string, { plan: number; fact: number }> = {};
    for (const metric of METRICS) {
      const matching = weeks.filter((w) => w.metric === metric);
      totals[metric] = {
        plan: matching.reduce((sum, w) => sum + w.plan, 0),
        fact: matching.reduce((sum, w) => sum + w.fact, 0),
      };
    }
    const forecast = buildForecast(
      totals.payment_amount.plan,
      totals.payment_amount.fact,
      month
    );
    return { id: m.id, name: m.name, weeks, totals, forecast, expected: expByMgr.get(m.id) ?? 0 };
  });

  res.json({ managers: managersOut });
});

/**
 * Personal "CRM mirror" view for a single manager: month totals + pace
 * forecast, daily breakdown for the selected month, and a 12-month history
 * trend. All fact data comes from synced Kommo deals; only plan targets are
 * manual.
 */
dashboardRouter.get("/personal", async (req, res) => {
  const auth = req.auth!;
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7);
  const monthStart = `${month}-01`;

  let managerId: number | null;
  if (auth.role === "manager") {
    managerId = auth.managerId;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    if (!managerId) return res.status(400).json({ error: "managerId is required" });
  }
  if (!managerId) return res.status(400).json({ error: "managerId is required" });

  const managerResult = await pool.query<{ id: number; name: string; team_id: number | null }>(
    `SELECT id, name, team_id FROM managers WHERE id = $1`,
    [managerId]
  );
  const manager = managerResult.rows[0];
  if (!manager) return res.status(404).json({ error: "Manager not found" });
  if (auth.role === "team_lead" && manager.team_id !== auth.teamId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const factResult = await pool.query<{
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT psm.funnel_stage, COUNT(*) AS deal_count, COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
     GROUP BY psm.funnel_stage`,
    [managerId, monthStart]
  );

  const planResult = await pool.query<{ metric: string; planned_value: string }>(
    `SELECT metric, SUM(planned_value) AS planned_value
     FROM plans
     WHERE manager_id = $1
       AND plan_date >= $2::date
       AND plan_date < ($2::date + interval '1 month')
     GROUP BY metric`,
    [managerId, monthStart]
  );

  const totals: Record<string, { plan: number; fact: number }> = {};
  for (const metric of METRICS) totals[metric] = { plan: 0, fact: 0 };
  for (const r of factResult.rows) {
    if (METRICS.includes(r.funnel_stage as (typeof METRICS)[number])) {
      totals[r.funnel_stage].fact = Number(r.deal_count);
    }
    // 🔴 Гроші сюди БІЛЬШЕ НЕ ЙДУТЬ із цього SQL: він групує по місяцю СТВОРЕННЯ
    // угоди, а не по даті входу в «успішно реалізовано». Кількості (`deal_count`)
    // лишаються когортою створення — це інше питання, ніж «скільки грошей».
  }
  // 🔴 ПРАВИЛО ВЛАСНИКА (02.08.2026): факт «Мого звіту» = ① «успішно реалізовано» (142),
  // анкер = `closed_at`. Це стосується всіх трьох блоків нижче — місяць, поденно,
  // 12 місяців — і ПРОГНОЗУ, який рахується з місячного факту.
  const monthEndP = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString().slice(0, 10);
  const succScope = { from: `${month}-01`, to: monthEndP, managerId: manager.id };
  totals.payment_amount.fact = (await money.successMoney(succScope)).revenue;
  for (const r of planResult.rows) {
    if (totals[r.metric]) totals[r.metric].plan = Number(r.planned_value);
  }

  const dailyResult = await pool.query<{
    day: string;
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT date_trunc('day', d.created_at_kommo AT TIME ZONE 'Europe/Kyiv') AS day,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
     GROUP BY day, psm.funnel_stage
     ORDER BY day`,
    [managerId, monthStart]
  );

  const dailyByDate = new Map<string, Record<string, number>>();
  for (const r of dailyResult.rows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    const row = dailyByDate.get(key) ?? {};
    row[r.funnel_stage] = Number(r.deal_count);
    dailyByDate.set(key, row);
  }
  // Гроші дня — з ядра, тим самим анкером. Σ днів == totals.payment_amount.fact.
  for (const b of await money.successByManagerBucket(succScope, "day")) {
    const row = dailyByDate.get(b.bucket) ?? {};
    row.payment_amount = b.revenue;
    dailyByDate.set(b.bucket, row);
  }
  const daily = Array.from(dailyByDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, row]) => ({ ...row, date }));

  const historyFactResult = await pool.query<{
    month: string;
    funnel_stage: string;
    deal_count: string;
    total_amount: string;
  }>(
    `SELECT date_trunc('month', d.created_at_kommo AT TIME ZONE 'Europe/Kyiv') AS month,
            psm.funnel_stage,
            COUNT(*) AS deal_count,
            COALESCE(SUM(d.price), 0) AS total_amount
     FROM deals d
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.manager_id = $1
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $2::date - interval '11 months'
       AND (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date < ($2::date + interval '1 month')
     GROUP BY month, psm.funnel_stage`,
    [managerId, monthStart]
  );

  const historyPlanResult = await pool.query<{ month: string; metric: string; planned_value: string }>(
    `SELECT date_trunc('month', plan_date) AS month, metric, SUM(planned_value) AS planned_value
     FROM plans
     WHERE manager_id = $1
       AND plan_date >= $2::date - interval '11 months'
       AND plan_date < ($2::date + interval '1 month')
     GROUP BY month, metric`,
    [managerId, monthStart]
  );

  const historyByMonth = new Map<string, { factPaymentAmount: number; factPaid: number; planPaymentAmount: number }>();
  function getHistoryRow(monthKey: string) {
    let row = historyByMonth.get(monthKey);
    if (!row) {
      row = { factPaymentAmount: 0, factPaid: 0, planPaymentAmount: 0 };
      historyByMonth.set(monthKey, row);
    }
    return row;
  }
  for (const r of historyFactResult.rows) {
    const monthKey = new Date(r.month).toISOString().slice(0, 7);
    if (r.funnel_stage === "paid") {
      const row = getHistoryRow(monthKey);
      row.factPaid = Number(r.deal_count);
    }
  }
  // Гроші історії — з ядра. Місяць у бакеті вже київський, тож ключ збігається з тим,
  // що будує `getHistoryRow`.
  {
    const histStart = new Date(`${month}-01T00:00:00Z`);
    histStart.setUTCMonth(histStart.getUTCMonth() - 11);
    for (const b of await money.successByManagerBucket(
      { from: histStart.toISOString().slice(0, 10), to: monthEndP, managerId: manager.id }, "month"
    )) getHistoryRow(b.bucket.slice(0, 7)).factPaymentAmount = b.revenue;
  }
  for (const r of historyPlanResult.rows) {
    if (r.metric === "payment_amount") {
      const monthKey = new Date(r.month).toISOString().slice(0, 7);
      getHistoryRow(monthKey).planPaymentAmount = Number(r.planned_value);
    }
  }
  const history = Array.from(historyByMonth.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([monthKey, row]) => ({ month: monthKey, ...row }));

  const forecast = buildForecast(totals.payment_amount.plan, totals.payment_amount.fact, month);

  res.json({
    manager: { id: manager.id, name: manager.name },
    month,
    daysInMonth: daysInMonth(month),
    daysElapsed: elapsedDaysInMonth(month),
    totals,
    forecast,
    daily,
    history,
  });
});

/**
 * Loyal-client KPI per manager: a client is "loyal" if they have 3+ paid
 * orders in the trailing 3-month window, and "at_risk" if they were loyal
 * in the prior 3-month window but have dropped below that threshold now.
 * Clients are identified by normalized `client_key` (legal-entity prefixes
 * like ТОВ/ФОП stripped) so e.g. "Смартекс" and "ТОВ Смартекс" count as
 * the same client.
 */
dashboardRouter.get("/loyalty", async (req, res) => {
  const auth = req.auth!;
  const asOf = (req.query.asOf as string) ?? new Date().toISOString().slice(0, 10);

  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;

  if (auth.role === "manager") {
    managerId = auth.managerId;
    teamId = null;
  } else if (auth.role === "team_lead") {
    teamId = auth.teamId;
  }

  const conditions: string[] = ["d.client_key IS NOT NULL"];
  const params: unknown[] = [asOf];

  if (managerId) {
    params.push(managerId);
    conditions.push(`d.manager_id = $${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    conditions.push(`m.team_id = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // Loyalty rules are admin-configurable; the window values are clamped ints.
  const settings = await getSettings();
  const recentMonths = settings.loyaltyWindowMonths;
  const sleepingMonths = settings.sleepingWindowMonths;
  const threshold = settings.loyaltyThreshold;

  // Aggregate every client's paid-order history (per manager) into time
  // windows so we can both flag regulars and segment everyone else for
  // reactivation work.
  // Each client is counted ONCE and attributed to a single PRIMARY manager (the
  // one with the most paid orders for that client), so a client handled by two
  // managers no longer shows as two rows. Windows/totals are per client_key.
  const result = await pool.query<{
    manager_id: number;
    manager_name: string;
    client_key: string;
    client_name: string;
    p_recent: string; // paid in last `recentMonths`
    p_prior: string; // paid in prior `recentMonths`–`sleepingMonths`
    total_paid: string; // all-time paid orders
    last_paid: string;
  }>(
    `WITH scoped AS (
       SELECT d.client_key, d.manager_id, m.name AS manager_name,
              d.client_name, d.created_at_kommo
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       ${where}
         AND psm.funnel_stage = 'paid'
     ),
     primary_mgr AS (
       SELECT client_key, manager_id, manager_name FROM (
         SELECT client_key, manager_id, manager_name,
                ROW_NUMBER() OVER (
                  PARTITION BY client_key
                  ORDER BY COUNT(*) DESC, MAX(created_at_kommo) DESC
                ) AS rn
         FROM scoped GROUP BY client_key, manager_id, manager_name
       ) z WHERE rn = 1
     ),
     agg AS (
       SELECT client_key,
              (array_agg(client_name ORDER BY created_at_kommo DESC))[1] AS client_name,
              COUNT(*) FILTER (
                WHERE created_at_kommo >= $1::date - interval '${recentMonths} months'
                  AND created_at_kommo < $1::date
              ) AS p_recent,
              COUNT(*) FILTER (
                WHERE created_at_kommo >= $1::date - interval '${sleepingMonths} months'
                  AND created_at_kommo < $1::date - interval '${recentMonths} months'
              ) AS p_prior,
              COUNT(*) AS total_paid,
              MAX(created_at_kommo) AS last_paid
       FROM scoped GROUP BY client_key
     )
     SELECT pm.manager_id, pm.manager_name, a.client_key, a.client_name,
            a.p_recent, a.p_prior, a.total_paid, a.last_paid
     FROM agg a JOIN primary_mgr pm ON pm.client_key = a.client_key`,
    params
  );

  type Client = {
    clientKey: string;
    clientName: string;
    isCompany: boolean; // company (name key) vs фізособа (phone key)
    identifier: string | null; // phone identifier for individuals
    orders: number;
    totalPaid: number;
    lastPaid: string;
  };
  const isPhoneKey = (k: string) => /^\d{9,}$/.test(k);
  type Segments = {
    regular: Client[]; // 2+ paid in last 2 months
    occasional: Client[]; // exactly 1 paid in last 2 months
    sleeping: Client[]; // none recent, but bought in prior 2–6 months
    lost: Client[]; // last purchase older than 6 months
  };

  // Clients that currently have outstanding receivables (active debtors) are
  // excluded from the reactivation (sleeping/lost) segments below.
  const recvKeysRes = await pool.query<{ client_key: string }>(
    `SELECT DISTINCT client_key FROM receivables WHERE client_key IS NOT NULL`
  );
  const receivableKeys = new Set(recvKeysRes.rows.map((r) => r.client_key));
  // Ручні правки адміна: прибрати / передати іншому менеджеру / примусово постійний.
  const overrides = await loadLoyaltyOverrides();

  const byManager = new Map<
    number,
    { managerId: number; managerName: string; segments: Segments }
  >();
  const ensureEntry = (id: number, name: string) => {
    let e = byManager.get(id);
    if (!e) { e = { managerId: id, managerName: name, segments: { regular: [], occasional: [], sleeping: [], lost: [] } }; byManager.set(id, e); }
    return e;
  };

  for (const row of result.rows) {
    const ov = overrides.get(row.client_key);
    if (ov?.hidden) continue; // в архіві (archivedSql) — не показуємо ніде
    const recent = Number(row.p_recent);
    const prior = Number(row.p_prior);
    // Передача: якщо адмін закріпив клієнта за іншим менеджером — переносимо туди
    // (з можливим переходом в іншу команду). Скоуп: у режимі команди показуємо,
    // лише якщо цільова команда збігається / без фільтра.
    let mgrId = row.manager_id, mgrName = row.manager_name;
    if (ov?.pinnedManagerId) {
      if (teamId && ov.pinnedTeamId && ov.pinnedTeamId !== teamId && row.manager_id !== null) {
        // передано в іншу команду, а зараз дивимось конкретну — пропускаємо, якщо
        // клієнт «пішов» з цієї команди (його вихідний менеджер у цій команді).
      }
      mgrId = ov.pinnedManagerId;
      mgrName = ov.pinnedManagerName ?? row.manager_name;
    }
    const entry = ensureEntry(mgrId, mgrName);
    const totalPaid = Number(row.total_paid);
    const individual = isPhoneKey(row.client_key);
    const client: Client = {
      clientKey: row.client_key,
      clientName: row.client_name,
      isCompany: !individual,
      identifier: individual ? row.client_key : null,
      orders: totalPaid,
      totalPaid,
      lastPaid: row.last_paid,
    };

    // "Постійний клієнт" = ordered `threshold`+ times AND is still ACTIVE
    // (ordered within the last `sleepingMonths`, i.e. recent OR prior window),
    // OR currently sits in receivables (has open invoices → active client).
    // A client who ordered 2+ times back in 2023 and went quiet is NOT a
    // regular anymore — they fall through to sleeping/lost for reactivation.
    const inReceivables = receivableKeys.has(row.client_key);
    const isActive = recent >= 1 || prior >= 1 || inReceivables;
    if (ov?.forceRegular || (totalPaid >= threshold && isActive)) {
      entry.segments.regular.push(client);
    } else if (recent >= 1 || inReceivables) {
      entry.segments.occasional.push(client);
    } else if (prior >= 1) {
      entry.segments.sleeping.push(client);
    } else {
      entry.segments.lost.push(client);
    }
  }

  const sortByLast = (a: Client, b: Client) => (a.lastPaid < b.lastPaid ? 1 : -1);

  const managers = Array.from(byManager.values()).map((entry) => {
    const s = entry.segments;
    for (const list of [s.regular, s.occasional, s.sleeping, s.lost]) list.sort(sortByLast);
    return {
      managerId: entry.managerId,
      managerName: entry.managerName,
      segments: s,
      regularCount: s.regular.length,
      occasionalCount: s.occasional.length,
      sleepingCount: s.sleeping.length,
      lostCount: s.lost.length,
    };
  });

  // 🔴 ПРАВИЛО ВЛАСНИКА (02.08.2026): «Замовлень / Сума (міс.)» — це ① «успішно
  // реалізовано», анкер = дата входу в 142.
  //
  // Було: `SUM(price)` + `COUNT(*)` по `funnel_stage='paid'`, згруповані за МІСЯЦЕМ
  // СТВОРЕННЯ угоди. Тобто картка «Сума (міс.)» і «% до попер. міс.» рахували когорту
  // створення, а підписані були як гроші місяця. Найбільше розходилось у свіжому
  // місяці — там угоди ще не встигали дійти до оплати.
  //
  // Тепер обидва числа беруться з ЯДРА однією функцією, тією самою, що живить
  // «успішно реалізовано» в Звіті: Σ місяців тут == successMoney(той самий scope).
  const dynFrom = `${asOf.slice(0, 7)}-01`;
  const dynStart = new Date(`${dynFrom}T00:00:00Z`);
  dynStart.setUTCMonth(dynStart.getUTCMonth() - 11);
  const months = (await money.successByBucket(
    { from: dynStart.toISOString().slice(0, 10), to: asOf, managerId, teamId }, "month"
  )).map((b) => ({ month: b.bucket.slice(0, 7), orders: b.deals, amount: b.revenue }));


  // Growth compares the last two COMPLETE months — the current calendar month
  // is still partial, so including it would understate the trend.
  const pct = (cur: number, prev: number) =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0;
  const currentMonthKey = asOf.slice(0, 7);
  const complete = months.filter((m) => m.month < currentMonthKey);
  const last = complete[complete.length - 1];
  const prev = complete[complete.length - 2];
  const dynamics = {
    months,
    currentMonth: currentMonthKey,
    deltaOrders: last && prev ? pct(last.orders, prev.orders) : 0,
    deltaAmount: last && prev ? pct(last.amount, prev.amount) : 0,
    latestMonth: last?.month ?? null,
    latestOrders: last?.orders ?? 0,
    latestAmount: last?.amount ?? 0,
  };

  res.json({ asOf, managers, dynamics });
});

/**
 * Outstanding receivables ("Дебіторська заборгованість") synced from the
 * accounting Google Sheet every 30 minutes. Scoped by role like /loyalty:
 * a manager only sees their own clients' balances, a team lead sees their
 * team, admin sees everyone.
 */
dashboardRouter.get("/receivables", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;

  // 🔒 Скоуп — СПІЛЬНИЙ вираз (`auth/receivablesScope.ts`), а не правило,
  // записане в цьому обробнику. Поки воно жило тут, сусідні двері тієї самої
  // вкладки (`/writeoffs`, `/note-history`) відчинились БЕЗ нього — і це не
  // недбалість, а властивість: копіювати нема чого, бо копіювати нічого не видно.
  const sc = receivablesScope(auth, req.query);
  if (!sc.ok) return res.status(sc.status).json({ error: sc.error });
  managerId = sc.managerId;
  teamId = sc.teamId;


  // КРОК 9: борг рахує core/metrics.receivablesByClient (LEFT JOIN — неатрибутований
  // борг БІЛЬШЕ не ховається; при адмін-розрізі додається група «Без менеджера»,
  // managerId=null — свідома зміна, рішення власника 15.07). Скоуп по менеджеру/
  // команді природно виключає null-рядки. Роут добудовує форму (не метрику): нотатки
  // тімліда (receivable_notes) + syncedAt + групування менеджер→клієнти.
  const rows = await metrics.receivablesByClient({ managerId, teamId });

  const clientKeys = rows.map((r) => r.clientKey).filter((k): k is string => k != null);
  const notesRes = clientKeys.length
    ? await pool.query<{ client_key: string; canon_key: string; comment: string | null; due_date: string | null; updated_at: string | null; hist: number }>(
        // 🗓 `updated_at` їде НА ЕКРАН, бо саме він вирішує, чи домовленість ще
        // актуальна: активним є запис ПІСЛЯ понеділка 00:00 за Києвом. Без нього
        // фронт мусив би вгадувати, і торішній текст читався б як сьогоднішня
        // обіцянка — рівно те, від чого власник і просив позбутись.
        // 🔗 НАБІР, А НЕ ОДИН КЛЮЧ: канонічний ∪ його живі псевдоніми. Нотатка
        // лежить на тому ключі, який був канонічним у мить запису, тож після
        // обʼєднання частина записів опиняється на псевдонімах і зникає з екрана
        // — хоча нікуди не поділась (заміряно 01.09.2026: таких 3, усі з
        // дедлайнами). Реєстр приєднується ТИМ САМИМ запитом: стеля `#158` —
        // чотири походи, і пʼятий заборонено її ж текстом.
        // ⚠️ `hist` навмисно лишається ПО СВОЄМУ ключу: журнал (`/note-history`)
        // теж читає канонічний ключ, і лічильник, більший за вміст діалогу, був
        // би двома джерелами одного числа. Розширення журналу — окремий обсяг.
        `SELECT n.client_key, COALESCE(a.canonical_key, n.client_key) AS canon_key,
                n.comment, to_char(n.due_date, 'YYYY-MM-DD') AS due_date,
                -- 🔴 OF ВІДДАЄ ДВОЗНАЧНЕ ЗМІЩЕННЯ (+03), А ECMAScript ВИМАГАЄ +HH:MM.
                -- new Date("2026-08-26T10:21:50+03") дає Invalid Date, Intl.format
                -- кидає, і виняток усередині .map по рядках убиває ВСЮ секцію —
                -- саме це поклало розділ дебіторки 26.08.2026. Віддаємо UTC із Z:
                -- єдиний формат, який усі рушії читають однаково.
                -- (зворотні лапки тут заборонені — це тіло шаблонного рядка)
                to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
                (SELECT count(*)::int FROM receivable_note_history h WHERE h.client_key = n.client_key) AS hist
           FROM receivable_notes n
           LEFT JOIN client_key_alias a
                  ON a.alias_key = n.client_key AND a.revoked_at IS NULL
          WHERE n.client_key = ANY($1) OR a.canonical_key = ANY($1)`,
        [clientKeys]
      )
    : { rows: [] as { client_key: string; canon_key: string; comment: string | null; due_date: string | null; updated_at: string | null; hist: number }[] };
  // 🗒 Групуємо ПО КАНОНІЧНОМУ ключу — рядок один, записів у наборі може бути кілька.
  const notesByCanon = new Map<string, typeof notesRes.rows>();
  for (const n of notesRes.rows) {
    const bucket = notesByCanon.get(n.canon_key);
    if (bucket) bucket.push(n); else notesByCanon.set(n.canon_key, [n]);
  }
  /**
   * 🔗 ДВА ФАКТИ В ОДНОМУ ПОХОДІ — І ЦЕ НЕ ОХАЙНІСТЬ, А `#158`.
   *
   * `synced_at` і реєстр псевдонімів не звʼязані нічим, окрім того, що обидва
   * потрібні цьому екрану й обидва — крихітні агрегати. Окремим запитом реєстр
   * коштував би +30 мс RTT на КОЖНЕ відкриття списку (заміряно 24.08.2026), а
   * стеля `#158` — 4 походи. 🔴 Підняти стелю «щоб пройшло» заборонено окремо:
   * вона тоді пропустить наступний зайвий похід непоміченим. Я цей регрес уже
   * зробив — саме він і почервонів у `test:prod` викату `d6f7edf`.
   *
   * 🔗 НАВІЩО РЕЄСТР ТУТ. Тригер `client_key_alias_no_chain` забороняє ланцюжок:
   * ключ, що вже є канонічним, псевдонімом стати не може. Без цієї позначки
   * людина обирає такий рядок, тисне «Обʼєднати» і дізнається правило з тексту
   * помилки 409. Заміряно 27.08.2026: канонічних із псевдонімами 16, один тримає 11.
   */
  const syncRes = await pool.query<{
    synced_at: string | null; canonical_of: Record<string, number>;
    payments: paymentMatch.RawPaymentRow[] | null;
    open_universe: paymentMatch.RawOpenRow[] | null;
  }>(
    `SELECT MAX(r.synced_at) AS synced_at,
            (SELECT COALESCE(jsonb_object_agg(a.canonical_key, a.n), '{}'::jsonb)
               FROM (SELECT canonical_key, COUNT(*)::int AS n
                       FROM client_key_alias WHERE revoked_at IS NULL
                      GROUP BY canonical_key) a) AS canonical_of,
            -- 💰 ВХІДНІ ПЛАТЕЖІ — ТИМ САМИМ ПОХОДОМ. Стеля #158 — чотири запити,
            -- і пʼятий заборонено її ж текстом. Текст підзапиту приїжджає з ядра
            -- (invoicePaymentsSql), а не написаний тут удруге.
            -- (зворотні лапки тут заборонені — це тіло шаблонного рядка)
            (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
               FROM (${paymentMatch.invoicePaymentsSql(1)}) p) AS payments,
            -- 🌍 УСІ живі рахунки, БЕЗ скоупу: «платіж називає кілька рахунків» —
            -- твердження про ПЛАТІЖ, а не про глядача. Поки всесвіт будувався зі
            -- скоупу, менеджер і адмін бачили різні відмітки на одному платежі.
            (SELECT COALESCE(jsonb_agg(u), '[]'::jsonb)
               FROM (${paymentMatch.OPEN_UNIVERSE_SQL}) u) AS open_universe
       FROM receivables r`, [paymentMatch.PAYMENT_LOOKBACK_DAYS]
  );
  const syncedAt = syncRes.rows[0]?.synced_at ?? null;
  const canonicalOf: Record<string, number> = syncRes.rows[0]?.canonical_of ?? {};
  const incoming = paymentMatch.toPayments(syncRes.rows[0]?.payments ?? []);
  const openUniverse = paymentMatch.toUniverse(syncRes.rows[0]?.open_universe ?? []);

  // 📇 ФАКТИ ПРО РАХУНКИ — юрособа, стан перевізника, вік, звʼязок із CRM.
  // ОДИН запит на всі зрізи екрана (RTT до Neon = 30 мс, тож ціна тут — кількість
  // походів, а не важкість; `#158`). Скоуп — по ключах УЖЕ відфільтрованих
  // клієнтів, а не по `ri.manager_id`: інакше Σ плиток розійшлася б із Σ рядків.
  const facts = await receivablesFacts.loadInvoiceFacts(pool, clientKeys);
  const folded = receivablesFacts.foldFacts(facts);

  /**
   * 💰 «ГРОШІ ЗАЙШЛИ» — рішення ухвалює ЯДРО, роут лише зводить операнди.
   *
   * 🔴 ЗІСТАВЛЯЄМО ПАКЕТОМ І ПО ВСІХ ВІДКРИТИХ РАХУНКАХ СКОУПУ, а не по одному:
   * стан «платіж називає кілька рахунків» — це питання про ПЛАТІЖ, і з одного
   * рахунка його не видно. Списані сюди не входять: у них гроші вже не чекають.
   */
  const openForMatch = facts
    .filter((f) => !f.writtenOff && (f.invoiceNo ?? "") !== "")
    .map((f) => ({ invoiceNo: f.invoiceNo as string, amount: f.amount, edrpou: f.edrpou }));
  const seenByInvoice = paymentMatch.matchAll(openForMatch, openUniverse, incoming, kyivToday());
  // Згортка по клієнту — ТИМ САМИМ виразом ядра, що й бейджі в розкритті.
  const seenPerClient = new Map<string, paymentMatch.PaymentSeen[]>();
  for (const f of facts) {
    if (f.writtenOff || !f.invoiceNo) continue;
    const st = seenByInvoice.get(f.invoiceNo);
    if (!st) continue;
    const bucket = seenPerClient.get(f.clientKey) ?? [];
    bucket.push(st);
    seenPerClient.set(f.clientKey, bucket);
  }
  const seenRoll = new Map<string, paymentMatch.SeenRoll>();
  for (const [k, v] of seenPerClient) seenRoll.set(k, paymentMatch.rollUp(v));

  type Client = {
    clientKey: string | null; clientName: string | null; amount: number;
    limitDays: number | null; limitAmount: number | null; overdueDays: number | null; comment: string | null; dueDate: string | null;
    ownerSource: string; majorityName: string | null;
    noteUpdatedAt: string | null; noteHistoryCount: number;
    /** Юрособа, з ключа якої взято показаний запис; `null` — запис канонічний. */
    noteFrom: string | null;
    /** Назви юросіб решти записів набору — для підпису «ще N». */
    noteOthers: string[];
    /** 🏢 Розклад боргу по юрособах клієнта + звірка з сумою рядка. */
    counterparties: receivablesCounterparty.Reconciled;
    facts: receivablesFacts.ClientFacts | null;
    margin: ReturnType<typeof marginCell> | null;
    /** 💰 Скільки рахунків клієнта вже мають гроші у виписці; `null` — не рахували. */
    paymentSeen: paymentMatch.SeenRoll | null;
  };
  const byManager = new Map<number | null, { managerId: number | null; managerName: string; clients: Client[]; total: number }>();
  for (const r of rows) {
    let entry = byManager.get(r.managerId);
    if (!entry) { entry = { managerId: r.managerId, managerName: r.managerName, clients: [], total: 0 }; byManager.set(r.managerId, entry); }
    const cf = r.clientKey ? folded.byClient.get(r.clientKey) ?? null : null;
    /**
     * 🗒 ЗАПИС ДЛЯ РЯДКА — З УСЬОГО НАБОРУ ПСЕВДОНІМІВ, за порядком ядра.
     *
     * Назва юрособи береться з ТИХ САМИХ фактів, що й розклад сум нижче
     * (`cf.counterparty`), а не окремим запитом: два джерела однієї назви
     * розійшлись би мовчки, і підпис «ще 1 · X» суперечив би рядку розкладу «X».
     */
    const noteSet = (r.clientKey ? notesByCanon.get(r.clientKey) ?? [] : []).map((x) => ({
      clientKey: x.client_key,
      counterpartyName: cf?.counterparty[x.client_key]?.name ?? null,
      comment: x.comment, dueDate: x.due_date, updatedAt: x.updated_at,
      isCanonical: x.client_key === r.clientKey,
    }));
    const picked = receivableNotePick.pickRowNote(noteSet);
    const n = picked.primary;
    // 📚 Журнал лишається канонічним — див. коментар біля запиту.
    const canonHist = r.clientKey
      ? notesRes.rows.find((x) => x.client_key === r.clientKey)?.hist ?? 0
      : 0;
    // 🔴 СПИСАНЕ ВІДНІМАЄТЬСЯ І ВІД РЯДКА, А НЕ ЛИШЕ ВІД ПЛИТКИ.
    //
    // Борг рядка приходить із `receivables` (ядро `metrics.receivablesByClient`),
    // а плитка складається з ФАКТІВ по рахунках — це два різні джерела одного
    // числа. Поки списання зменшувало лише факти, екран показував просілу плитку
    // й НЕзмінений рядок, тобто Σ рядків ≠ плитці, а в самому рядку одночасно
    // стояли «борг 3 ₴» і «списано: 1 на 3 ₴».
    //
    // 📐 ЗНАЙШОВ ЦЕ НЕ Я, А ЧУЖИЙ ГЕЙТ `#150c` на живих даних приймання
    // (Δ 3.00) і `#157` поіменно. Мій власний цикл цю різницю ДРУКУВАВ —
    // `рядок.сума` лишалась 3 у всіх трьох станах — і я її не побачив, бо
    // дивився на Δ плитки, яку сам і перевіряв. Рівно те, від чого береже
    // правило «жоден показник не має двох джерел на одному екрані».
    // 🗑 КЛІЄНТ, У ЯКОГО СПИСАНІ ВСІ РАХУНКИ, У ВІДПОВІДЬ НЕ ПОТРАПЛЯЄ ВЗАГАЛІ.
    //
    // 🔴 САМЕ ТУТ, А НЕ НА ФРОНТІ, І НЕ ДВОМА ФІЛЬТРАМИ. Заголовок «Боржники (N)»
    // і плитка «N боржників» обидва рахують `all.length` — одну й ту саму
    // множину, що приходить звідси. Прибрати рядок у ВІДПОВІДІ означає, що
    // обидва лічильники, `total`, `overdueClients` і підсумок менеджера підуть
    // за ним самі. Фільтр на фронті завів би ДРУГЕ джерело тієї самої множини —
    // рівно те, від чого береже правило «жоден показник не має двох джерел».
    //
    // 📐 Заміряно 26.08.2026: пʼятеро таких клієнтів стояли з боргом 0 ₴ і
    // датою «—», заголовок казав 78 замість 73. Сума при цьому була ПРАВИЛЬНА
    // (їхній видимий борг уже нуль) — тому Σ-гейти мовчали, і мовчали чесно.
    //
    // ⚠️ Частково списаний клієнт ЛИШАЄТЬСЯ: УКРЕНЕРГО (списано 28 000 з
    // 325 500) видно з боргом 297 500 і віком 22 дні. Умова — ВСІ рахунки.
    if (clientFullyWrittenOff(cf)) continue;
    const visibleAmount = r.amount - (cf?.writtenOffAmount ?? 0);
    entry.clients.push({
      clientKey: r.clientKey, clientName: r.clientName, amount: visibleAmount,
      limitDays: r.limitDays, limitAmount: r.limitAmount, overdueDays: r.overdueDays,
      comment: n?.comment ?? null, dueDate: n?.dueDate ?? null,
      noteUpdatedAt: n?.updatedAt ?? null, noteHistoryCount: canonHist,
      // 🏢 Звідки саме цей запис і скільки їх іще в наборі. Порожній масив —
      // звичайний незлитий клієнт, і рядок виглядає точно як раніше.
      noteFrom: n && !n.isCanonical ? n.counterpartyName ?? n.clientKey : null,
      noteOthers: picked.otherNames,
      // 🏢 РОЗКЛАД БОРГУ ПО ЮРОСОБАХ — рахує ядро, роут лише подає.
      // Звіряється з сумою рядка ТУТ, поки обидва числа поруч; залишок їде на
      // екран числом, а не ховається (див. `core/receivablesCounterparty.ts`).
      counterparties: receivablesCounterparty.reconcileBreakdown(
        visibleAmount, receivablesCounterparty.counterpartyBreakdown(cf)),
      // 🔴 ЧОМУ саме цей відповідальний — їде НА ЕКРАН, а не лишається в ядрі.
      // Без цього «звільнений мажоритар без команди» і «в рахунках узагалі немає
      // менеджера» виглядали б однаково порожньо, і людина не мала б як їх
      // розрізнити. Порожнє місце читається як «нічого немає», а не як відповідь.
      ownerSource: r.ownerSource, majorityName: r.majorityName,
      // 🔖 Ярлики рядка — з ТОГО САМОГО зведення, з якого рахуються плитки вгорі.
      // Два вирази для одного числа розходяться мовчки; тут вираз один.
      facts: cf,
      /**
       * 💰 ЗГОРТКА «ГРОШІ ЗАЙШЛИ» ПО КЛІЄНТУ — з ТОГО САМОГО зведення, що й
       * бейджі в розкритті. Два вирази для одного числа розходяться мовчки.
       * `total` — скільки живих рахунків узагалі, щоб «2 з 5» читалось як
       * частка, а не як загадкове число.
       */
      paymentSeen: r.clientKey ? seenRoll.get(r.clientKey) ?? null : null,
      // 💰 МАРЖИНАЛЬНІСТЬ РАХУЄ СЕРВЕР — ОДНИМ ВИРАЗОМ ДЛЯ РЯДКА Й ДЛЯ ПЛИТКИ.
      // Фронт лише форматує. Якби він рахував сам, правило існувало б у двох
      // місцях, і копії збігалися б одна з одною, а не з правилом — рівно те,
      // що дало чипи «новий/постійний» (12.6% угод серпня розходились).
      margin: r.clientKey ? marginCell(cf?.earned ?? null, cf?.clientPay ?? null) : null,
    });
    entry.total += visibleAmount;
  }

  // 🔴 ПРАВО ВІДДАЄ СЕРВЕР, І ТИМИ САМИМИ ВИРАЗАМИ, ЩО ГЕЙТЯТЬ РОУТИ.
  //
  // Фронт свого правила не має — інакше екран мав би власну думку про доступ,
  // і вона розійшлася б із сервером мовчки (урок `canHide` у `#30l`). Кнопки,
  // якої не має бути, тут просто НЕМАЄ — це не «є, але дає 403».
  //
  // ⚠️ `canSetOwner` ІСТИННИЙ і для ФІНАНСИСТА, і це ОЧІКУВАНО, а не діра:
  // рішення власника 31.07.2026 підняло фінансиста до рівня адміна (`admin_scope`),
  // а `isAdminScope` саме його й читає. Підтверджено власником 24.08.2026 окремо.
  // Слід лишається: override без примітки не приймає ні роут, ні `CHECK` у БД.
  // Склейки у фінансиста НЕМАЄ — `merge_receivables` він не має. Тримає `#159b`.
  // 🧾 `canSetLimit` — ОКРЕМЕ право, а не `isAdminScope` (Е4, рішення власника
  // 24.08.2026): СЕО · опердир · адмін · КВП · ФІНАНСИСТ. Фінансист тут Є свідомо —
  // ліміт відстрочки це фінансове рішення; склейки клієнтів він так само свідомо
  // НЕ має. Дві сусідні межі з різними відповідями — саме тому право, а не роль.
  res.json({
    syncedAt, managers: Array.from(byManager.values()),
    // Плитка бере ТУ САМУ функцію, що й рядок. Два вирази для одного числа
    // розходяться мовчки — саме так «Команда за місяць 12%» жила поруч із
    // плиткою «11.8%».
    totals: { ...folded.totals, margin: marginCell(folded.totals.earned, folded.totals.clientPay) },
    canSetOwner: isAdminScope(auth),
    canMerge: roleHasPerm(auth.roleKey, "merge_receivables"),
    // 🔒 Реєстр їде ЛИШЕ тому, хто має право зливати: решті він ні до чого, а
    // «віддамо всім, бо не таємниця» — це те, як поле одного дня опиняється на
    // екрані, для якого його не робили. Порожньо у merge-ролі означає «ще
    // нікого», а не «невідомо»: реєстр читається цілком.
    ...(roleHasPerm(auth.roleKey, "merge_receivables") ? { canonicalOf } : {}),
    canSetLimit: roleHasPerm(auth.roleKey, "manage_credit_limits"),
    // 🗑 СПИСАННЯ — РІВНО ДВІ РОЛІ (рішення власника 25.08.2026): СЕО й опердир.
    // Не фінансист і не тімліди: це визнання втрати грошей, а не операційна дія.
    // Право в БД окремим записом, як `merge_receivables`, — не список у коді.
    canWriteOff: roleHasPerm(auth.roleKey, WRITE_OFF_PERM),
    /**
     * 🧾 ЧИ МАЛЮВАТИ КНОПКУ «ЗАПИТ НА ЛІМІТ» (рішення власника 26.08.2026:
     * «Кнопка тільки в тімліда»). Це ПІДКАЗКА ФРОНТУ, а не право: право
     * гейтить роут, і тімлід ще й звужується до СВОЄЇ команди вже там, по
     * конкретному клієнту. Поле відповідає лише на питання «чи є сенс
     * показувати кнопку взагалі» — менеджеру її не видно ніде.
     */
    canRequestLimit: canAssignTaskToOthers({ role: auth.role, teamId: auth.teamId }),
  });
});

/**
 * 🗑 СПИСАННЯ БЕЗНАДІЙНОГО БОРГУ — рівень рахунка або клієнта цілком.
 *
 * 🔴 ЧОМУ ОКРЕМА ТАБЛИЦЯ, А НЕ ПРАПОРЕЦЬ У `receivable_invoices`:
 * `syncReceivables` робить `TRUNCATE` обох таблиць дебіторки кожні 15 хвилин —
 * прапорець зник би за один прохід. Прецедент: `receivable_invoice_notes`.
 *
 * 🔴 КЛЮЧ — `client_key_raw`: канонічний рухає склейка, і списання переїхало б
 * на обʼєднаного клієнта, прибравши ЧУЖИЙ борг.
 *
 * 🔴 СПИСАННЯ КЛІЄНТА РОЗГОРТАЄТЬСЯ В ПЕРЕЛІК ЙОГО РАХУНКІВ У МОМЕНТ ДІЇ.
 * Інакше завтрашній НОВИЙ рахунок цього клієнта теж мовчки вважався б списаним —
 * дія в минулому тихо застосовувалась би до майбутнього.
 */
dashboardRouter.post("/receivables/writeoff", async (req, res) => {
  const auth = req.auth!;
  // 🔴 ГЕЙТ ПЕРШИМ ЗНАЧУЩИМ ОПЕРАТОРОМ. Валідація тіла перед ним дала б 400
  // замість 403 і зламала гарантію «403 == спрацював гейт» (на цьому вже раз
  // відкочували прод 04.08.2026).
  if (!roleHasPerm(auth.roleKey, WRITE_OFF_PERM)) return res.status(403).json({ error: "Немає права списувати борг" });

  const clientKey = String(req.body?.clientKey ?? "").trim();
  const invoiceNo = req.body?.invoiceNo == null ? null : String(req.body.invoiceNo).trim();
  const note = String(req.body?.note ?? "");
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!noteIsValid(note)) return res.status(400).json({ error: "Причина списання обовʼязкова" });

  // 🔴 ПРИЙМАЄМО КАНОНІЧНИЙ КЛЮЧ, А ЗБЕРІГАЄМО СИРИЙ — і це не суперечність, а
  // рівно те, що робить дію правильною в обидва боки. На екрані клієнт ОДИН
  // рядок; після склейки за ним стоять кілька сирих ключів, і приймати сирий
  // означало б списати лише ЧАСТИНУ того, що людина бачить. Тому розгортаємо
  // канонічним, а пишемо кожному рядку його власний `client_key_raw`: майбутня
  // склейка не перетягне списання на чужий борг.
  //
  // 🔴 `GROUP BY` — НЕ ОПТИМІЗАЦІЯ, А УМОВА ЧЕСНОСТІ ЖУРНАЛУ. `invoice_no` у
  // `receivable_invoices` буває порожнім, а ключ списання — пара (сирий ключ,
  // номер). Кілька безномерних рахунків одного клієнта згортаються в ОДИН ключ,
  // тож без агрегації `ON CONFLICT DO UPDATE` записав би суму ОСТАННЬОГО рядка.
  // На екрані це не було б видно взагалі: join накриває всі рядки з тим самим
  // ключем, і плитка просіла б на повну суму — а в журналі лежала б частина.
  // Тобто розбіжність тиха, і саме тому вона тут і закрита.
  const target = await pool.query<{ client_key_raw: string; invoice_no: string; amount: string }>(
    WRITEOFF_TARGETS_SQL(invoiceNo != null),
    invoiceNo ? [clientKey, invoiceNo] : [clientKey]
  );
  // ⚠️ ПОРОЖНІЙ РЕЗУЛЬТАТ — ВІДМОВА, А НЕ ТИХИЙ УСПІХ: «списали 0 рахунків»
  // виглядало б як спрацювала дія, і людина вважала б борг списаним.
  if (target.rowCount === 0) return res.status(404).json({ error: "Таких рахунків немає" });

  for (const row of target.rows) {
    await pool.query(
      `INSERT INTO receivable_writeoffs (client_key_raw, invoice_no, amount, note, written_off_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_key_raw, invoice_no) DO UPDATE SET
         amount = EXCLUDED.amount, note = EXCLUDED.note,
         written_off_by = EXCLUDED.written_off_by, written_off_at = now(),
         revoked_by = NULL, revoked_at = NULL, revoke_note = NULL`,
      [row.client_key_raw, row.invoice_no, Number(row.amount), note, auth.userId]
    );
  }
  res.json({ ok: true, written: target.rowCount });
});

/**
 * 🗄 АРХІВ СПИСАНИХ БОРГІВ — окрема вкладка (рішення власника 26.08.2026).
 *
 * Списаний рахунок зникає з активного списку ПОВНІСТЮ й сліду в рядку клієнта
 * не лишає. Але зникнути з очей і зникнути з обліку — різні речі: тут він лежить
 * із причиною, автором і датою, і повертається однією кнопкою.
 *
 * 🔴 ЛІЧИЛЬНИК РОЗБІЖНОСТІ З CRM — НЕ ПРИКРАСА, А УМОВА ЧЕСНОСТІ. Списана угода
 * лишається в Kommo на грошовій стадії, а в нас її вже немає: дашборд показує
 * МЕНШЕ за CRM, що прямо суперечить «дашборд — дзеркало CRM». Власник закрив цю
 * суперечність не забороною, а ВИДИМІСТЮ. Сховати її було б найгіршим варіантом:
 * тиха розбіжність — найдорожчий клас помилок, який у нас є.
 */
dashboardRouter.get("/receivables/writeoffs", async (req, res) => {
  const auth = req.auth!;
  /**
   * 🔒 ЗВУЖЕННЯ ТИМ САМИМ МЕХАНІЗМОМ, ЩО ЗА СУСІДНІМИ ДВЕРИМА (26.08.2026).
   *
   * 🔴 ЩО БУЛО ВІДКРИТО, І ЦЕ ЗАМІРЯНО ВІДПОВІДЯМИ СЕРВЕРА, А НЕ ЧИТАННЯМ:
   * менеджер отримував БАЙТ-У-БАЙТ ту саму відповідь, що адмін — усі 8 списань
   * на 68 178 ₴ разом із `clientName`, `amount`, `note` й автором. Тобто хто,
   * кому й скільки простив, із припискою «чому». Вкладковий гейт на цих дверях
   * діяв (HR отримує 403), а звуження ДАНИХ не було жодного.
   *
   * ⚠️ НЕ НОВИЙ ВИРАЗ, А ТА САМА ФУНКЦІЯ. Множину «мої клієнти» дає
   * `metrics.receivablesByClient` — рівно те, чим будується список на екрані.
   * Другий вираз для того самого питання розійшовся б зі списком тихо: людина
   * бачила б клієнта в таблиці й не бачила його списань, або навпаки.
   *
   * 🔴 КЛЮЧ СПИСАННЯ — СИРИЙ, А СКОУП — КАНОНІЧНИЙ, і зводить їх `receivable_invoices`,
   * де є обидва. Порівнювати `client_key_raw` із `client_key` навпростець можна
   * рівно доти, доки клієнта не склеїли аліасом — а тоді списання мовчки випало б
   * із видимості власного менеджера.
   */
  const sc = receivablesScope(auth, req.query);
  if (!sc.ok) return res.status(sc.status).json({ error: sc.error });
  const mine = await metrics.receivablesByClient(sc);
  const myKeys = mine.map((r) => r.clientKey).filter((k): k is string => k != null);
  const rows = await pool.query<{
    client_key_raw: string; client_name: string | null; invoice_no: string;
    amount: string; note: string; author: string | null; at: string;
  }>(
    `SELECT w.client_key_raw, w.invoice_no, w.amount, w.note,
            u.email AS author,
            to_char(w.written_off_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
            (SELECT min(ri.client_name) FROM receivable_invoices ri
              WHERE COALESCE(ri.client_key_raw, ri.client_key) = w.client_key_raw) AS client_name
       FROM receivable_writeoffs w
       LEFT JOIN users u ON u.id = w.written_off_by
      WHERE w.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM receivable_invoices ri
                     WHERE COALESCE(ri.client_key_raw, ri.client_key) = w.client_key_raw
                       AND ri.client_key = ANY($1))
      ORDER BY w.written_off_at DESC`,
    [myKeys]
  );
  // Лічильник розбіжності — тим самим виразом, що виключає угоди з очікуваних.
  const div = await pool.query<{ deals: number; amount: number }>(
    WRITTEN_OFF_STILL_IN_ZONE, [metrics.FC_PIPELINES, metrics.EXPECT_ZONE]
  );
  const list = rows.rows.map((x) => ({
    clientKeyRaw: x.client_key_raw, clientName: x.client_name, invoiceNo: x.invoice_no,
    amount: Number(x.amount), note: x.note, author: x.author, at: x.at,
  }));
  res.json({
    writeoffs: list,
    totals: {
      n: list.length,
      amount: list.reduce((a, x) => a + x.amount, 0),
      // Плитка «за цей місяць» — київський місяць, як усі періоди продукту.
      thisMonth: list.filter((x) => x.at.slice(0, 7) === new Date().toISOString().slice(0, 7))
        .reduce((a, x) => a + x.amount, 0),
      oldestAt: list.length ? list[list.length - 1].at : null,
      clients: new Set(list.map((x) => x.clientKeyRaw)).size,
    },
    /**
     * 🔴 РОЗБІЖНІСТЬ ІЗ CRM, НАЗВАНА ЧИСЛОМ. Ці угоди ми зі своїх очікуваних
     * прибрали, а в Kommo вони досі на грошовій стадії — тобто їх треба закрити
     * і там. Поки не закриті, наші числа менші за CRM, і це видно.
     */
    stillInZone: { deals: div.rows[0]?.deals ?? 0, amount: div.rows[0]?.amount ?? 0 },
    canWriteOff: roleHasPerm(auth.roleKey, WRITE_OFF_PERM),
  });
});

/** Скасувати списання — тим самим інтерфейсом, із тим самим журналом. */
dashboardRouter.delete("/receivables/writeoff", async (req, res) => {
  const auth = req.auth!;
  if (!roleHasPerm(auth.roleKey, WRITE_OFF_PERM)) return res.status(403).json({ error: "Немає права списувати борг" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const invoiceNo = req.body?.invoiceNo == null ? null : String(req.body.invoiceNo).trim();
  const note = String(req.body?.note ?? "");
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!noteIsValid(note)) return res.status(400).json({ error: "Причина скасування обовʼязкова" });

  // 🔴 РЯДОК НЕ ВИДАЛЯЄМО — журнал мусить лишитись поіменним. Дія на грошах,
  // сліду якої не лишилось, через місяць нічим не відрізняється від помилки.
  //
  // Сирі ключі беремо з ТИХ САМИХ рахунків, якими розгорталось списання, — так
  // скасування покриває рівно те, що покрила дія, включно зі злитим клієнтом.
  const r = await pool.query(
    `UPDATE receivable_writeoffs w
        SET revoked_by = $1, revoked_at = now(), revoke_note = $2
      WHERE w.revoked_at IS NULL
        AND w.client_key_raw IN (
          SELECT COALESCE(client_key_raw, client_key) FROM receivable_invoices WHERE client_key = $3
        )
        ${invoiceNo ? "AND w.invoice_no = $4" : ""}`,
    invoiceNo ? [auth.userId, note, clientKey, invoiceNo] : [auth.userId, note, clientKey]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Активних списань не знайдено" });
  res.json({ ok: true, revoked: r.rowCount });
});

/**
 * 🧾 Узгоджена відстрочка платежу — записати або зняти (Е4).
 *
 * ЧОМУ ЦЕ РОУТ, А НЕ КОЛОНКА В `receivables`: `receivables` перебудовується
 * щосинку (TRUNCATE+insert), тож будь-яка правка там жила б до 15 хвилин.
 * Ліміт — НАЛАШТУВАННЯ, воно мусить пережити синк, тому окрема таблиця.
 *
 * 🔴 `limitDays = 0` — ПОВНОЦІННЕ ЗНАЧЕННЯ, а не «порожньо». Означає «розглянули
 * і не дали», тобто перевізника не сплачуємо. Зняти ліміт зовсім — це DELETE,
 * і це ТРЕТІЙ стан («не встановлювали»). Плутати їх не можна: обидва ведуть до
 * однакового наслідку, але відповідають різне на питання «чому».
 */
dashboardRouter.put("/receivables/limit", requirePerm("manage_credit_limits"), async (req, res) => {
  /**
   * 🔒 ПРАВО — В MIDDLEWARE, А НЕ В ТІЛІ (переїзд 26.08.2026).
   *
   * ⚠️ ПОВЕДІНКА НЕ ЗМІНИЛАСЬ, І ЦЕ ТРЕБА СКАЗАТИ ПРЯМО: перевірка
   * `roleHasPerm(auth.roleKey, "manage_credit_limits")` стояла тут ПЕРШИМ
   * значущим оператором і віддавала ті самі 403. Тобто «менеджер знімає чужий
   * ліміт» НЕ був відкритий — він був закритий іншим механізмом.
   *
   * 🔴 Переїзд потрібен не заради безпеки, а заради ВИДИМОСТІ: ворота `#17`
   * вимагають, щоб у роута була МЕЖА — `ROUTE_TAB` або `requirePerm` у стеку.
   * Перевірку всередині тіла вони не бачать у принципі, тож роут числився
   * «без межі» й був невидимий для `ACCESS_MATRIX`. Правило, якого не видно
   * інструменту, наступні двері відчиняють без нього — рівно те, що сталося зі
   * `/writeoffs` і `/note-history` за сусідніми дверима.
   *
   * ⚠️ Дубль усередині тіла ПРИБРАНО, а не лишено «про всяк випадок»: два
   * записи одного правила розходяться, і тоді незрозуміло, котрий чинний.
   */
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const note = String(req.body?.note ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!note) {
    return res.status(400).json({
      error: "Примітка обовʼязкова — ліміт без причини через місяць не відрізнити від помилки",
    });
  }
  /**
   * 🔴 ОБИДВА ЛІМІТИ НЕОБОВʼЯЗКОВІ ПООКРЕМО, АЛЕ ХОЧА Б ОДИН МУСИТЬ БУТИ.
   * `undefined` = «поле не передали, не чіпай», `null` = «зняти цей ліміт».
   * Плутати їх не можна: частковий upsert, що трактує відсутнє поле як `null`,
   * тихо зніс би сусідній ліміт — рівно та поломка, що вже була в
   * `loyalty-override` (затирало `pinned_manager_id`).
   */
  const parseLimit = (raw: unknown, whole: boolean): number | null | "skip" | "bad" => {
    if (raw === undefined) return "skip";
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return "bad";
    return whole && !Number.isInteger(n) ? "bad" : n;
  };
  const days = parseLimit(req.body?.limitDays, true);
  const amount = parseLimit(req.body?.limitAmount, false);
  if (days === "bad") return res.status(400).json({ error: "Ліміт днів — ціле число, 0 або більше" });
  if (amount === "bad") return res.status(400).json({ error: "Ліміт суми — число, 0 або більше" });
  if (days === "skip" && amount === "skip") {
    return res.status(400).json({ error: "Передайте ліміт днів або ліміт суми" });
  }

  const target = await pool.query(
    `SELECT 1 FROM receivables WHERE client_key = $1 LIMIT 1`, [clientKey]);
  if (!target.rowCount) return res.status(404).json({ error: "Клієнта немає в дебіторці" });

  /**
   * 🔴 `COALESCE(EXCLUDED.x, cl.x)` НЕ ГОДИТЬСЯ: він не вміє ЗНЯТИ ліміт —
   * `null` у EXCLUDED означав би «лиши як було», і кнопка «зняти» мовчки не
   * працювала б. Тому передані поля перелічуються явно, як у
   * `core/loyaltyOverride.ts`: оновлюється РІВНО те, що прийшло.
   */
  const sets: string[] = ["note = EXCLUDED.note", "set_by = EXCLUDED.set_by", "set_at = now()"];
  if (days !== "skip") sets.push("limit_days = EXCLUDED.limit_days");
  if (amount !== "skip") sets.push("limit_amount = EXCLUDED.limit_amount");
  await pool.query(
    `INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note, set_by, set_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (client_key) DO UPDATE SET ${sets.join(", ")}`,
    [clientKey, days === "skip" ? null : days, amount === "skip" ? null : amount,
     note.slice(0, 300), auth.userId]
  );
  // Той самий перерахунок, що й у синку — інакше екран до 15 хв показував би старий
  // ліміт при новому підписі. Вік боргу не чіпаємо: він похідний від дат рахунків.
  const cur = await pool.query<{ limit_days: number | null; limit_amount: string | null }>(
    `SELECT limit_days, limit_amount FROM client_credit_limits WHERE client_key = $1`, [clientKey]);
  const row = cur.rows[0];
  await pool.query(
    `UPDATE receivables SET limit_days = $2, limit_amount = $3 WHERE client_key = $1`,
    [clientKey, row?.limit_days ?? null, row?.limit_amount ?? null]);
  res.json({ ok: true, limitDays: row?.limit_days ?? null,
             limitAmount: row?.limit_amount == null ? null : Number(row.limit_amount) });
});

/**
 * 🧾 ЗАПИТ НА ПЕРЕГЛЯД ЛІМІТУ → ЗАДАЧА В ЗАДАЧНИКУ.
 *
 * 🔴 РОУТ НЕ СТВОРЮЄ ЗАДАЧУ МОВЧКИ. Він повертає ЗАГОТОВКУ — клієнта, борг,
 * стан ліміту й готовий заголовок, — а виконавця й дедлайн обирає тімлід у
 * формі задачі (рішення власника 26.08.2026). Ми нічого не проставляємо за
 * нього: дефолтний дедлайн, вигаданий нами, через тиждень стане цифрою, якій
 * вірять.
 *
 * 🔴 ПОДВІЙНЕ НАТИСКАННЯ НЕ СТВОРЮЄ ДРУГОЇ ЗАДАЧІ, І ТРИМАЄ ЦЕ БД, А НЕ КНОПКА.
 * Заблокована кнопка — це ВИГЛЯД: два відкриті вікна, повтор запиту, швидкі
 * пальці — і задач дві. Частковий унікальний індекс
 * `idx_tasks_credit_limit_open` не дає існувати другому ВІДКРИТОМУ запиту на
 * того самого клієнта. Роут не «мовчазно успішний»: він віддає 200 із
 * `existing`, тобто НАЯВНУ задачу, і фронт показує саме її.
 * ⚠️ Мовчазний успіх тут був би тією самою «операцією, що звітує про роботу,
 * якої не зробила», що й «успіх за 0 мс».
 *
 * ЗАДАЧНИК — ЗОВНІШНЯ СИСТЕМА: пишемо в `tasks` рівно тими колонками, що вже
 * існують (`task_type`, `client_key`, `title`, `description`), без жодної
 * зміни контракту. Нових обовʼязкових полів не додано.
 */
dashboardRouter.get("/receivables/limit-request", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });

  // Клієнт + його команда — потрібні ОБИДВА: команда гейтить тімліда.
  const row = await pool.query<{
    client_name: string; amount: string; limit_amount: string | null; team_id: number | null;
  }>(
    `SELECT r.client_name, r.amount, r.limit_amount, m.team_id
       FROM receivables r LEFT JOIN managers m ON m.id = r.manager_id
      WHERE r.client_key = $1 LIMIT 1`, [clientKey]);
  if (!row.rowCount) return res.status(404).json({ error: "Клієнта немає в дебіторці" });
  const c = row.rows[0];

  // 🔴 ГЕЙТ — ПЕРШИМ ЗНАЧУЩИМ ОПЕРАТОРОМ ПІСЛЯ ЗЧИТУВАННЯ СКОУПУ. Валідація
  // тіла перед гейтом дала б 400 замість 403 і зламала б гарантію зліпка #11
  // («403 = спрацював гейт») — на цьому ми вже раз відкотили прод 04.08.2026.
  if (!canRequestLimitFor({ role: auth.role, teamId: auth.teamId }, c.team_id)) {
    return res.status(403).json({ error: "Задачу про ліміт ставить тімлід у межах своєї команди" });
  }

  const debt = Number(c.amount);
  const limitAmount = c.limit_amount == null ? null : Number(c.limit_amount);
  const title = limitRequestTitle(c.client_name, debt, limitAmount);

  // Наявний ВІДКРИТИЙ запит — віддаємо його, а не робимо другий.
  const open = await pool.query<{ id: number; title: string; assignee_id: number | null; status: string }>(
    `SELECT id, title, assignee_id, status FROM tasks
      WHERE task_type = $1 AND client_key = $2 AND status <> 'done' LIMIT 1`,
    [LIMIT_REQUEST_TASK_TYPE, clientKey]);
  if (open.rowCount) {
    const e = open.rows[0];
    // ⚠️ Ключі назовні — camelCase, як у решті API. Віддати рядок БД «як є»
    // означало б протягнути `assignee_id` у контракт: фронт мовчки читав би
    // `undefined` і показував «без виконавця» там, де виконавець є.
    return res.json({
      ok: true, draft: null,
      existing: { id: e.id, title: e.title, assigneeId: e.assignee_id, status: e.status },
      note: "Запит на цього клієнта вже відкритий",
    });
  }

  res.json({
    ok: true,
    existing: null,
    draft: {
      taskType: LIMIT_REQUEST_TASK_TYPE,
      clientKey,
      clientName: c.client_name,
      debt,
      limitAmount,
      limitState: amountLimitState(limitAmount),
      title,
      // Дедлайн, пріоритет і виконавця НЕ проставляємо — їх обирає тімлід.
      description: `Переглянути ліміт по сумі для клієнта «${c.client_name}».\n`
        + `Поточний борг: ${Math.round(debt).toLocaleString("uk-UA")} ₴.\n`
        + `Ліміт суми: ${amountLimitLabel(limitAmount)}.`,
    },
  });
});

/**
 * 🧾 СТВОРЕННЯ ЗАДАЧІ ПРО ЛІМІТ — окремий роут, а не режим заготовки.
 *
 * 🔴 КОНТРАКТ ЗАДАЧНИКА НЕ ЧІПАЄМО. `POST /tasks` не приймає `task_type`,
 * `client_key` і `description`, а `routes/tasks.ts` — файл контракту, який
 * правиться лише окремою задачею з окремим прийманням. Тому пишемо тим самим
 * способом, що вже існує поруч: `POST /reactivation-task` у цьому ж файлі
 * створює задачу з тими самими трьома полями й теж не чіпає `routes/tasks.ts`.
 * Форма прецеденту скопійована свідомо, включно з перевіркою відкритої задачі.
 *
 * 🔴 ВИКОНАВЦЯ Й ДЕДЛАЙН ОБИРАЄ ТОЙ, ХТО СТАВИТЬ (рішення власника 26.08.2026).
 * Нічого не проставляємо за нього: дефолт, вигаданий нами, через тиждень стане
 * цифрою, якій вірять.
 */
dashboardRouter.post("/receivables/limit-task", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });

  const row = await pool.query<{ client_name: string; amount: string; limit_amount: string | null; team_id: number | null }>(
    `SELECT r.client_name, r.amount, r.limit_amount, m.team_id
       FROM receivables r LEFT JOIN managers m ON m.id = r.manager_id
      WHERE r.client_key = $1 LIMIT 1`, [clientKey]);
  if (!row.rowCount) return res.status(404).json({ error: "Клієнта немає в дебіторці" });
  const c = row.rows[0];

  // 🔴 ГЕЙТ ПЕРШИМ ЗНАЧУЩИМ ОПЕРАТОРОМ ПІСЛЯ СКОУПУ — див. пояснення в
  // `/receivables/limit-request`: валідація тіла перед ним дала б 400 замість
  // 403 і зламала гарантію зліпка `#11`.
  if (!canRequestLimitFor({ role: auth.role, teamId: auth.teamId }, c.team_id)) {
    return res.status(403).json({ error: "Задачу про ліміт ставить тімлід у межах своєї команди" });
  }

  const assigneeId = req.body?.assigneeId == null ? null : Number(req.body.assigneeId);
  if (assigneeId == null || !Number.isInteger(assigneeId)) {
    return res.status(400).json({ error: "Оберіть виконавця" });
  }
  // Тімлід ставить задачу лише СВОЇЙ команді — тією ж межею, що й у Задачнику.
  if (auth.role === "team_lead") {
    const ok = await pool.query(
      `SELECT 1 FROM managers WHERE id = $1 AND team_id = $2`, [assigneeId, auth.teamId]);
    if (!ok.rowCount) return res.status(403).json({ error: "Можна ставити задачі лише своїй команді" });
  }

  // Наявний ВІДКРИТИЙ запит — віддаємо його, а не робимо другий. Друга лінія
  // оборони — частковий унікальний індекс `idx_tasks_credit_limit_open`: гонка
  // двох вкладок пройде повз цю перевірку, але не повз БД.
  const open = await pool.query<{ id: number }>(
    `SELECT id FROM tasks WHERE task_type = $1 AND client_key = $2 AND status <> 'done' LIMIT 1`,
    [LIMIT_REQUEST_TASK_TYPE, clientKey]);
  if (open.rowCount) {
    return res.status(409).json({ error: "Запит на цього клієнта вже відкритий", taskId: open.rows[0].id });
  }

  const debt = Number(c.amount);
  const limitAmount = c.limit_amount == null ? null : Number(c.limit_amount);
  const dept = await pool.query<{ name: string | null }>(
    `SELECT t.name FROM managers m LEFT JOIN teams t ON t.id = m.team_id WHERE m.id = $1`, [assigneeId]);
  const priority = ["low", "medium", "high"].includes(String(req.body?.priority))
    ? String(req.body.priority) : "medium";
  const deadline = req.body?.deadline ? String(req.body.deadline) : null;

  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO tasks (title, status, deadline, assignee_id, priority, department, created_by,
                          task_type, client_key, description)
       VALUES ($1,'not_started',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [limitRequestTitle(c.client_name, debt, limitAmount), deadline, assigneeId, priority,
       dept.rows[0]?.name ?? null, auth.userId, LIMIT_REQUEST_TASK_TYPE, clientKey,
       `Переглянути ліміт по сумі для клієнта «${c.client_name}».\n`
       + `Поточний борг: ${Math.round(debt).toLocaleString("uk-UA")} ₴.\n`
       + `Ліміт суми: ${amountLimitLabel(limitAmount)}.`]);
    res.json({ id: r.rows[0].id });
  } catch (e) {
    // Гонка: індекс спрацював між перевіркою й вставкою. Це НЕ помилка користувача
    // і не мовчазний успіх — кажемо те саме, що й перевірка вище.
    if (/idx_tasks_credit_limit_open/.test(String((e as { message?: string }).message ?? ""))) {
      return res.status(409).json({ error: "Запит на цього клієнта вже відкритий" });
    }
    throw e;
  }
});

/** Зняти ліміт зовсім → стан «не встановлювали». Дзеркальна дія до PUT. */
dashboardRouter.delete("/receivables/limit/:clientKey", requirePerm("manage_credit_limits"), async (req, res) => {
  /**
   * 🔒 ПРАВО — В MIDDLEWARE, А НЕ В ТІЛІ (переїзд 26.08.2026).
   *
   * ⚠️ ПОВЕДІНКА НЕ ЗМІНИЛАСЬ, І ЦЕ ТРЕБА СКАЗАТИ ПРЯМО: перевірка
   * `roleHasPerm(auth.roleKey, "manage_credit_limits")` стояла тут ПЕРШИМ
   * значущим оператором і віддавала ті самі 403. Тобто «менеджер знімає чужий
   * ліміт» НЕ був відкритий — він був закритий іншим механізмом.
   *
   * 🔴 Переїзд потрібен не заради безпеки, а заради ВИДИМОСТІ: ворота `#17`
   * вимагають, щоб у роута була МЕЖА — `ROUTE_TAB` або `requirePerm` у стеку.
   * Перевірку всередині тіла вони не бачать у принципі, тож роут числився
   * «без межі» й був невидимий для `ACCESS_MATRIX`. Правило, якого не видно
   * інструменту, наступні двері відчиняють без нього — рівно те, що сталося зі
   * `/writeoffs` і `/note-history` за сусідніми дверима.
   *
   * ⚠️ Дубль усередині тіла ПРИБРАНО, а не лишено «про всяк випадок»: два
   * записи одного правила розходяться, і тоді незрозуміло, котрий чинний.
   */
  const auth = req.auth!;
  const clientKey = String(req.params.clientKey ?? "").trim();
  const r = await pool.query(`DELETE FROM client_credit_limits WHERE client_key = $1`, [clientKey]);
  if (!r.rowCount) return res.status(404).json({ error: "Ліміт не встановлений" });
  // Знімаються ОБИДВА — рядок один на клієнта, і його більше немає.
  await pool.query(
    `UPDATE receivables SET limit_days = NULL, limit_amount = NULL WHERE client_key = $1`, [clientKey]);
  res.json({ ok: true });
});

/**
 * Per-invoice breakdown behind a client's receivable balance (the "выгрузка"
 * detail): every unpaid invoice with its number, date, amount and service link.
 * Role-scoped like /receivables — a manager only sees their own clients.
 */
dashboardRouter.get("/receivables/invoices", async (req, res) => {
  const auth = req.auth!;
  /**
   * 📋 ДВА РЕЖИМИ, ОДИН ОБРОБНИК (реєстр рахунків, 27.08.2026).
   *   `?clientKey=…` — розкриття одного клієнта (як було);
   *   без ключа      — ПЛАСКИЙ РЕЄСТР усіх рахунків у скоупі.
   *
   * 🔴 ЧОМУ НЕ ОКРЕМИЙ РОУТ. Два роути означали б два предикати «живий
   * рахунок», два скоупи й два набори полів — тобто рівно ту конструкцію, яка
   * щойно дала «рядок 2 323 000 проти розкриття 691 000». Тут один запит,
   * одна умова відмінності (`ri.client_key = $1` або нічого) і спільний хвіст.
   *
   * 📐 Ціна плаского режиму ЗАМІРЯНА, не оцінена (27.08.2026, жива БД):
   * `loadInvoiceFacts` робить ОДИН запит незалежно від кількості ключів —
   * 1 ключ 34 мс / 1 запит, 73 ключі 95 мс / **1 запит**, 298 рядків. Тобто
   * реєстр коштує +61 мс і НУЛЬ додаткових запитів. Я називав це головним
   * ризиком проходу — замір це спростував.
   */
  const clientKey = String(req.query.clientKey ?? "").trim();
  const flat = clientKey === "";

  /**
   * 🔴 СКОУП ПО КЛІЄНТУ, А НЕ ПО РАХУНКУ (рішення власника 27.08.2026).
   * «Показуємо повністю всю обʼєктивну картину: відкрив клієнта — бачиш УСІ
   * виставлені й неоплачені рахунки».
   *
   * 📐 ЩО ЦЕ ЛІКУЄ — ЖИВИЙ ДЕФЕКТ, ЗАМІРЯНИЙ НА ПРОДІ 27.08.2026. Фільтр по
   * `ri.manager_id` різав рахунки ВСЕРЕДИНІ клієнта, а рядок клієнта показував
   * повний борг. ПВК АРСЕНАЛ ТОВ, той самий екран, три ролі:
   *
   *   адмін     рядок 2 323 000 ₴ · розкриття 33 рах. · Σ 2 323 000 ₴ · Δ 0
   *   тімлід    рядок 2 323 000 ₴ · розкриття 22 рах. · Σ   763 000 ₴ · Δ 1 560 000
   *   менеджер  рядок 2 323 000 ₴ · розкриття 19 рах. · Σ   691 000 ₴ · Δ 1 632 000
   *
   * Тобто Яцик бачив «2.3М ₴» у рядку і «691 тис ₴» у шапці розкриття — два
   * числа про одне на одному екрані, різниця 1.6 млн. Причина: 11 рахунків ПВК
   * виставлені напряму в 1С, повз CRM, тож `ri.manager_id` у них NULL, і фільтр
   * відрізав їх усім, крім адміна.
   *
   * 🔴 ВИРАЗ СКОУПУ — ОДИН НА ТРИ МІСЦЯ: список клієнтів, це розкриття і реєстр.
   * Той самий `receivablesScope` + `receivablesByClient`, що вже стоїть у
   * `/receivables` і `/receivables/writeoffs`. Другий вираз тут одного дня
   * розійшовся б із першим — і саме так цей дефект і зʼявився.
   *
   * ⚠️ Клієнт поза скоупом дістає 403, а не порожній список: «нічого немає» і
   * «вам не видно» — різні відповіді, і перша читається як відсутність боргу.
   */
  const sc = receivablesScope(auth, req.query);
  if (!sc.ok) return res.status(sc.status).json({ error: sc.error });
  const mine = await metrics.receivablesByClient(sc);
  const visibleKeys = mine.map((r) => r.clientKey).filter((k): k is string => k != null);
  if (!flat && !visibleKeys.includes(clientKey))
    return res.status(403).json({ error: "Клієнт поза вашим скоупом" });

  // Умова рівно одна: рахунки клієнтів у скоупі. Хто їх виставив — інформація
  // в колонці «Менеджер», а не критерій видимості.
  const conds = [flat ? "ri.client_key = ANY($1)" : "ri.client_key = $1"];
  const params: unknown[] = [flat ? visibleKeys : clientKey];

  const r = await pool.query<{ client_key: string; invoice_time: string | null; invoice_no: string | null; invoice_date: string | null; amount: string; service_url: string | null; note: string | null; edrpou: string | null; due_date: string | null; inv_comment: string | null; entity_name: string | null; entity_key: string | null; invoice_manager: string | null }>(
    `SELECT ri.client_key, ri.invoice_no, to_char(ri.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            -- 🕐 ЧАС ВИСТАВЛЕННЯ. NULL = часу не записано (сентинел 00:00:00 у
            -- 1С — 121 із 293 рядків), і це «не знаємо», а не «опівночі».
            -- Київ накладається ТУТ, у SQL; парсер зони не знає навмисно.
            -- ⚠️ Без бектиків: усередині шаблонного літерала вони обірвали б рядок.
            to_char(ri.invoice_at AT TIME ZONE 'Europe/Kyiv', 'HH24:MI:SS') AS invoice_time,
            ri.amount, ri.service_url, ri.note, ri.edrpou,
            -- 👤 Менеджер САМОГО РАХУНКУ (колонка «Відповідальний» у розкритті).
            -- Це НЕ той, хто веде клієнта: після override або склейки це різні
            -- люди, і саме тому колонка стоїть під «Відповідальним» — щоб різницю
            -- було ВИДНО, а не щоб її згладити. Сире імʼя з 1С — фолбек: рахунок
            -- буває на людині, якої в наших менеджерах немає.
            COALESCE(m.name, ri.manager_name_raw) AS invoice_manager,
            -- 🔗 Юрособа, з якої прийшов рахунок. Для злитого клієнта їх кілька,
            -- і людина мусить бачити, ЩО саме всередині одного рядка — інакше
            -- склейка виглядає як зникнення другої компанії.
            ri.client_name AS entity_name, ri.client_key_raw AS entity_key,
            to_char(nn.due_date, 'YYYY-MM-DD') AS due_date, nn.comment AS inv_comment
     FROM receivable_invoices ri
     LEFT JOIN managers m ON m.id = ri.manager_id
     -- 🔗 ПО СИРОМУ КЛЮЧУ, А НЕ ПО КАНОНІЧНОМУ (27.08.2026). Канонічний рухає
     -- склейка, тож після обʼєднання нотатка мовчки відчепилась би від свого
     -- рахунка: рядок є, дедлайн порожній, і ніщо не каже, що запис існує.
     LEFT JOIN receivable_invoice_notes nn
            ON nn.client_key_raw = ri.client_key_raw AND nn.invoice_no = COALESCE(ri.invoice_no, '')
     WHERE ${conds.join(" AND ")}
     -- Час бере участь у сортуванні там, де він є; де немає — рахунок стає в
     -- кінець свого дня, а не на його початок (NULLS LAST), бо «не знаємо»
     -- не має вдавати найранішу мить доби.
     ORDER BY ri.invoice_date DESC NULLS LAST, ri.invoice_at DESC NULLS LAST, ri.amount DESC`,
    params
  );
  // 🏢 НАША ЮРОСОБА ПО КОЖНОМУ РАХУНКУ — З ТОГО САМОГО ЯДРА, ЩО Й ПЛИТКА (Е4b).
  //
  // Плитка «За нашою юрособою» обіцяє «ЮТС 26 · Автомув 3 · невідомо 11», а
  // всередині клієнта цього видно не було — людина бачила підсумок і не бачила,
  // ЯКІ саме рахунки складають «невідомо». Тому розкриття тягне `loadInvoiceFacts`,
  // а не виводить юрособу вдруге з `payment_type`: друге виведення одного дня
  // розійшлося б із плиткою, і кожна половина виглядала б правдоподібно.
  //
  // ⚠️ Ключ звірки — номер рахунку. Він унікальний у межах клієнта (на ньому вже
  // стоять нотатки `receivable_invoice_notes`), тож нового припущення тут немає.
  // 🔴 ОДИН ВИКЛИК НА ВЕСЬ СПИСОК, а не цикл по клієнтах: функція приймає масив
  // і робить `= ANY($1)`, тож запит один незалежно від кількості ключів
  // (заміряно: 73 ключі → 1 запит, 95 мс). Цикл дав би 73 запити — саме це
  // стереже `#158`.
  const factKeys = flat ? visibleKeys : [clientKey];
  const ourFacts = await receivablesFacts.loadInvoiceFacts(pool, factKeys);

  /**
   * 💰 «ГРОШІ ЗАЙШЛИ» — ТЕ САМЕ ЯДРО, ЩО В СПИСКУ КЛІЄНТІВ.
   *
   * 🔴 Другого виразу тут бути не може: список показує згортку «2 з 5», а
   * розкриття — які саме два. Розійдуться вони мовчки, і кожна половина
   * лишиться правдоподібною — рівно так «Команда за місяць 12%» жила поруч із
   * плиткою «11.8%».
   *
   * ⚠️ Тут це ОКРЕМИЙ запит, і це не суперечність зі списком: стеля `#158`
   * стереже `/receivables`, а не цей роут. У списку той самий текст їде
   * підзапитом, і саме тому він живе однією функцією в ядрі.
   */
  const payRows = await pool.query<paymentMatch.RawPaymentRow>(
    paymentMatch.invoicePaymentsSql(1), [paymentMatch.PAYMENT_LOOKBACK_DAYS]);
  // 🌍 ВСЕСВІТ — ТОЙ САМИЙ, ЩО В СПИСКУ, і саме тому окремим запитом: якби
  // неоднозначність рахувалась із рахунків ЦЬОГО клієнта, розкриття казало б
  // «зайшли» там, де список каже «кілька рахунків». Дві відповіді про один
  // платіж на сусідніх екранах — і кожна виглядала б правильною.
  const uniRows = await pool.query<paymentMatch.RawOpenRow>(paymentMatch.OPEN_UNIVERSE_SQL);
  const seenByInvoice = paymentMatch.matchAll(
    ourFacts.filter((f) => !f.writtenOff && (f.invoiceNo ?? "") !== "")
      .map((f) => ({ invoiceNo: f.invoiceNo as string, amount: f.amount, edrpou: f.edrpou })),
    paymentMatch.toUniverse(uniRows.rows),
    paymentMatch.toPayments(payRows.rows), kyivToday());
  /**
   * 🔴 КЛЮЧ — ПАРА (КЛІЄНТ, №), А НЕ САМ №. Номер унікальний У МЕЖАХ КЛІЄНТА —
   * так і написано в коментарі нижче, і для розкриття одного клієнта голого
   * номера вистачало. У ПЛАСКОМУ режимі клієнтів 72, і голий номер зліпив би
   * рахунки різних клієнтів в один запис.
   *
   * 📐 Заміряно 27.08.2026: однакових номерів у різних клієнтів СЬОГОДНІ нуль —
   * але це властивість ДАНИХ, не гарантія. І одна колізія існує вже зараз:
   * рахунки БЕЗ номера згортаються в ключ `""` — усі, у всіх клієнтів. Живих
   * таких нуль, списаних два; тобто на плаский список це впливає, щойно
   * зʼявиться перший безномерний живий.
   */
  const fkey = (ck: string, no: string | null) => `${ck}\u0000${no ?? ""}`;
  const factByNo = new Map(ourFacts.map((f) => [fkey(f.clientKey, f.invoiceNo), f]));
  // 🗑 СПИСАНИЙ РАХУНОК ЗНИКАЄ З АКТИВНОГО РОЗКРИТТЯ ПОВНІСТЮ (рішення власника
  // 26.08.2026, скасовує попереднє «лишається закресленим із підписом»). Зникнути
  // з очей і зникнути з обліку — різні речі: він лежить у вкладці «Архів» із
  // причиною, автором і датою, і повертається однією кнопкою.
  const writtenOffNos = new Set(ourFacts.filter((f) => f.writtenOff).map((f) => fkey(f.clientKey, f.invoiceNo)));

  const alive = r.rows.filter((x) => !writtenOffNos.has(fkey(x.client_key, x.invoice_no)));

  /**
   * 🕰 ВІК БОРГУ ЇДЕ З СЕРВЕРА, А НЕ РАХУЄТЬСЯ ШАПКОЮ РОЗКРИТТЯ.
   *
   * 🔴 Шапка мала власний `Math.floor((Date.now() - min) / 86400000)`, і на
   * УКРЕНЕРГО-АЛЬЯНСІ це давало ДВА ГОЛОСИ НА ОДНОМУ ЕКРАНІ: рядок клієнта
   * «1128 дн.» (вік по ВСІХ рахунках, включно зі списаним), шапка розкриття
   * під ним — «найстаріший 22 дн.». Обидва правильні кожен у своєму всесвіті,
   * і саме тому їх ніхто не помітив. Тепер число одне й приходить звідси.
   */
  const oldestAliveDays = debtAgeDays(
    alive.map((x) => (x.invoice_date ? new Date(String(x.invoice_date)) : null)), new Date());

  res.json({
    oldestAliveDays,
    invoices: alive.map((x) => {
      const f = factByNo.get(fkey(x.client_key, x.invoice_no));
      return {
        // 🔗 Ключ клієнта — у ПЛАСКОМУ режимі рядок мусить знати, чий він.
        clientKey: x.client_key,
        clientName: x.entity_name,
        invoiceNo: x.invoice_no,
        invoiceDate: x.invoice_date,
        // 🕐 «HH:MM:SS» або `null` = часу не записано. Порожнеча тут — ВІДПОВІДЬ,
        // і екран мусить сказати її словами, а не показати «00:00».
        invoiceTime: x.invoice_time,
        amount: Number(x.amount),
        serviceUrl: x.service_url,
        note: x.note,
        edrpou: x.edrpou,
        dueDate: x.due_date,
        comment: x.inv_comment,
        entityName: x.entity_name,
        entityKey: x.entity_key,
        managerName: x.invoice_manager,
        // Наша юрособа (ЮТС / Автомув / ФОП / невідомо) і ПРИЧИНА, коли невідомо.
        // Причина обовʼязкова: «невідомо» без «чому» — це порожнє місце, а воно
        // читається як «нічого немає», а не як «ми не знаємо».
        ourEntity: f?.entity ?? null,
        ourEntityReason: f?.entityReason ?? null,
        // Чи є за рахунком угода. Мертвий 🔗 у сорока рядках поспіль гірший за
        // чесний підпис «угоди немає»: він обіцяє перехід, якого не буде.
        // 🚚 ПЕРЕВІЗНИК ОПЛАЧЕНИЙ — ПО КОЖНОМУ РАХУНКУ, а не лише в плитці.
        // Те саме ядро (`classifyCarrierPaid`), що живить плитку «Перевізник
        // оплачений»: друге виведення з `status_id` у роуті одного дня
        // розійшлося б із нею, і кожна половина виглядала б правдоподібно.
        //
        // 🔴 `na` НЕСЕ ПРИЧИНУ, і це не косметика: «угоди немає» — це НЕ ФАКТ
        // НЕОПЛАТИ. Заміряно на живому проді 25.08.2026: 15 рахунків на
        // 1 604 500 ₴ виставлено через 1С. Показати їх як «ще не оплачено»
        // означало б домалювати 1.6 млн неіснуючого факту.
        carrierPaid: f?.carrierPaid ?? null,
        carrierReason: f?.carrierReason ?? null,
        /**
         * 💰 ЧИ ПРИЙШЛИ ГРОШІ ЗА ЦИМ РАХУНКОМ (28.08.2026).
         *
         * Чотири стани, і жоден не порожній: `seen` · `stale` (зайшли давно,
         * рознесення не сталося) · `ambiguous` (платіж називає кілька рахунків) ·
         * `none` (не зіставлено). 🔴 Порожня клітинка тут заборонена: вона
         * читається як «нічого немає», а не як «ми не зіставили».
         */
        paymentSeen: x.invoice_no ? seenByInvoice.get(x.invoice_no) ?? null : null,
        // 🚚 СКІЛЬКИ заплачено перевізнику. `null` — «суму не вказано», і це
        // ОКРЕМИЙ стан від «не оплачено»: заміряно 25.08.2026 — умови виплати
        // не заповнені у 84 із 279 угод дебіторки (30%). Показати їх нулем
        // означало б стверджувати, що перевізник отримав нуль.
        carrierPayAmount: f?.carrierPayAmount ?? null,
        carrierPayType: f?.carrierPayType ?? null,
        dealId: f?.dealId ?? null,
        dealFound: f?.dealFound ?? false,
        // 🗑 Списаний рахунок лишається ВИДИМИМ у розкритті — просто не входить
        // у суму. Сховати його означало б, що зменшення плитки нічим не
        // пояснюється, а число, що змінилось без сліду, читається як поломка.
        writtenOff: f?.writtenOff ?? false,
        // 💰 ЗАРОБІТОК УГОДИ, ДО ЯКОЇ ПРИВʼЯЗАНИЙ ЦЕЙ РАХУНОК — те саме поле, з
        // якого складається «Заробили» в рядку клієнта (`deals.price`, у цьому
        // продукті це вже маржа). Віддаємо СИРИМ, по кожному рахунку; рішення
        // «кому з них малювати число» ухвалює ФРОНТ (`earnedCells`), бо воно
        // залежить від порядку відображення. Порахувати його ще й тут означало б
        // завести другий вираз для одного числа — рівно те, що вчора дало просілу
        // плитку при незміненому рядку клієнта.
        earned: f?.earned ?? null,
      };
    }),
  });
});

/**
 * Дедлайн оплати + коментар до КОНКРЕТНОГО рахунку дебіторки. Менеджер ставить
 * по СВОЇХ клієнтах, тімлід — по команді, адмін — по всіх. Якщо дедлайн минув,
 * а рахунок досі неоплачений — щоденний джоб створює менеджеру задачу
 * «отримати оплату» (див. jobs/receivableDeadlineTasks).
 */
dashboardRouter.put("/receivables/invoice-note", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const invoiceNo = String(req.body?.invoiceNo ?? "").trim();
  if (!clientKey || !invoiceNo) return res.status(400).json({ error: "clientKey та invoiceNo обовʼязкові" });

  /**
   * 🔴 ПРАВО ПИСАТИ — ЗА КЛІЄНТОМ, А НЕ ЗА МЕНЕДЖЕРОМ РАХУНКА
   * (рішення власника 27.08.2026). «Відповідаєш за клієнта — ведеш усі його
   * рахунки; домовленість про оплату стосується КЛІЄНТА, а не того, хто набрав
   * рахунок у 1С».
   *
   * 📐 ЩО БУЛО Б ІНАКШЕ. Читання перевели на скоуп клієнта тим самим проходом,
   * і без цієї правки виникла б асиметрія: Яцик БАЧИТЬ 30 рахунків ПВК АРСЕНАЛ,
   * а дедлайн може поставити на 19 — бо 11 із них виставлені напряму в 1С і
   * `manager_id` у них NULL. «Видно, але не чіпай» без жодного пояснення на
   * екрані — це той самий клас, що 41 кнопка в DOM із нуля видимих.
   *
   * 🔗 ЧЕТВЕРТЕ МІСЦЕ ОДНОГО ВИРАЗУ: список клієнтів, розкриття, реєстр і цей
   * запис. Тотожність усіх чотирьох стереже `#199cg`.
   */
  const sc = receivablesScope(auth, {});
  if (!sc.ok) return res.status(sc.status).json({ error: sc.error });
  const mine = await metrics.receivablesByClient(sc);
  if (!mine.some((r) => r.clientKey === clientKey))
    return res.status(403).json({ error: "Клієнт поза вашим скоупом" });

  // Рахунок мусить існувати В ЦЬОГО клієнта: інакше нотатка осіла б під ключем,
  // якому нічого не відповідає, і зникла б з екрана мовчки.
  //
  // 🔗 ЗВІДСИ Ж БЕРЕМО СИРИЙ КЛЮЧ, ПІД ЯКИМ НОТАТКА ЖИТИМЕ. Приймаємо
  // канонічний (людина бачить ОДИН рядок), зберігаємо сирий (він не рухається
  // ніколи) — рівно як списання. Без цього обʼєднання відчіпляло б нотатку від
  // рахунка мовчки.
  //
  // ⚠️ `ORDER BY` — не косметика: `invoice_no` у 1С буває ПОРОЖНІМ, і в злитого
  // клієнта такі рахунки є під кількома сирими ключами. Без сортування нотатка
  // чіплялась би до випадкового з них, і те саме збереження двічі поспіль
  // лягало б у різні рядки.
  const own = await pool.query<{ client_key_raw: string }>(
    `SELECT ri.client_key_raw FROM receivable_invoices ri
      WHERE ri.client_key = $1 AND COALESCE(ri.invoice_no,'') = $2
      ORDER BY ri.client_key_raw LIMIT 1`,
    [clientKey, invoiceNo]);
  if (!own.rowCount) return res.status(404).json({ error: "Такого рахунку в цього клієнта немає" });
  const rawKey = own.rows[0].client_key_raw;

  const dueDate = req.body?.dueDate ? String(req.body.dueDate).slice(0, 10) : null;
  const comment = req.body?.comment != null ? String(req.body.comment) : null;
  // 🪤 ВОСКРЕСЛА ОСИРОТІЛА НОТАТКА. Із 24 наявних 20 не мають живого рахунка,
  // тож сирого ключа в них NULL (рішення власника: не вигадувати його). Якщо
  // 1С колись поверне такий рахунок, вставка нижче зіткнулась би зі СТАРИМ PK
  // `(client_key, invoice_no)`, якого `ON CONFLICT (client_key_raw, …)` не
  // бачить — і роут віддав би 500 замість збереження. Рядок усиновлюється
  // рівно в цю мить і рівно тому, що його рахунок ожив.
  await pool.query(
    `UPDATE receivable_invoice_notes SET client_key_raw = $3
      WHERE client_key = $1 AND invoice_no = $2 AND client_key_raw IS NULL`,
    [clientKey, invoiceNo, rawKey]);
  await pool.query(
    `INSERT INTO receivable_invoice_notes (client_key, client_key_raw, invoice_no, due_date, comment, updated_by, updated_at)
     VALUES ($1, $6, $2, $3, $4, $5, now())
     ON CONFLICT (client_key_raw, invoice_no) DO UPDATE SET
       due_date = EXCLUDED.due_date, comment = EXCLUDED.comment,
       -- Канонічний ключ — ІСТОРІЯ «під ким писали», і він оновлюється разом із
       -- записом: після склейки нотатка мусить називати ПОТОЧНОГО клієнта.
       client_key = EXCLUDED.client_key,
       -- зміна дедлайну знімає анти-дубль, щоб нова прострочка знову створила задачу
       task_created_at = CASE WHEN receivable_invoice_notes.due_date IS DISTINCT FROM EXCLUDED.due_date
                              THEN NULL ELSE receivable_invoice_notes.task_created_at END,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, invoiceNo, dueDate, comment, auth.userId, rawKey]
  );
  res.json({ ok: true });
});

// ── Реактивація клієнтів (сплячі/втрачені → в роботу менеджеру) ─────────────
/*
 * 🪦 ТУТ СТОЯВ `GET /api/dashboard/reactivation` — ВИДАЛЕНО 26.08.2026.
 *
 * Грід «🔄 Реактивація — клієнти в роботі» прибрано ще 04.08.2026; роут відтоді
 * лежав у `DEAD_ROUTE_CANDIDATES` з терміном перегляду 01.10.2026.
 *
 * 🔴 ЧОМУ НЕ ДОЧЕКАЛИСЬ ТЕРМІНУ. Він рахував ГРОШІ ВЛАСНИМ SQL — «Успішно (142)
 * закриті після added_at + Оплата отримана», тобто повз `core/money.ts` з його
 * анкером по даті входу й дедупом 9∪10. Ворота `#17c` цього не бачили: їхній
 * розбір SQL мовчки пропускав дві третини запитів файла (54 зі 158 — заміряно
 * 26.08.2026), і запит виплив лише тоді, коли стороння правка зсунула парність
 * беклапок. Тримати заради терміну код, який ворота щойно назвали порушенням,
 * означало б або узаконити виняток, або лишити гілку червоною.
 *
 * МЕРТВІСТЬ ДОВЕДЕНА, А НЕ ПРИПУЩЕНА (усе — по ЗІБРАНОМУ бандлу, за РЯДКОВИМИ
 * літералами, бо в мініфікованому бандлі греп по імені дає нуль для будь-чого):
 *   · голий шлях `/dashboard/reactivation` — 0 входжень (усі 4 збіги виявились
 *     дефісними сусідами: `-candidates`, `-list`, `-task`, `-task/close`);
 *   · власні тексти гріда — «з реактивації?», «Мої клієнти в реактивації»,
 *     «1-й контакт», «2-й контакт» — 0 · 0 · 0 · 0;
 *   · `ReportSection.tsx`, єдиний споживач гріда, не імпортує ніхто.
 *
 * ⚠️ ДАНІ НЕ ЧІПАЛИ: у `reactivation_clients` лишаються 6 рядків (рішення
 * власника 04.08.2026 — СПИСАТИ, не переносити). `POST`/`PUT`/`DELETE` на цьому
 * шляху теж без жодного споживача, але вони ПИШУТЬ, тож знімаються окремим
 * словом власника, а не побічним ефектом прибирання читача.
 */

/** Додати клієнта в реактивацію (тімлід — менеджеру СВОЄЇ команди, адмін — будь-кому). */
dashboardRouter.post("/reactivation", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const clientName = String(req.body?.clientName ?? "").trim();
  const managerId = Number(req.body?.managerId);
  const category = req.body?.category === "lost" ? "lost" : "sleeping";
  if (!clientKey || !clientName || !managerId) {
    return res.status(400).json({ error: "clientKey, clientName і managerId обовʼязкові" });
  }
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Менеджер не з вашої команди" });
  }
  await pool.query(
    `INSERT INTO reactivation_clients (client_key, client_name, manager_id, category, added_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_key) DO UPDATE SET
       manager_id = EXCLUDED.manager_id, category = EXCLUDED.category,
       updated_by = EXCLUDED.added_by, updated_at = now()`,
    [clientKey, clientName, managerId, category, auth.userId]
  );
  res.json({ ok: true });
});

/** Оновити робочі поля реактивації (план, контакти→результати, статус, коментар). */
dashboardRouter.put("/reactivation", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });

  // Право: менеджер — свій клієнт; тімлід — команда; адмін — усі.
  const conds = ["rc.client_key = $1"];
  const p: unknown[] = [clientKey];
  if (auth.role === "manager") { p.push(auth.managerId); conds.push(`rc.manager_id = $${p.length}`); }
  else if (auth.role === "team_lead") { p.push(auth.teamId); conds.push(`m.team_id = $${p.length}`); }
  const own = await pool.query(
    `SELECT 1 FROM reactivation_clients rc JOIN managers m ON m.id = rc.manager_id
     WHERE ${conds.join(" AND ")} LIMIT 1`, p);
  if (!own.rowCount) return res.status(403).json({ error: "Немає доступу до цього клієнта" });

  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const b = req.body ?? {};
  if ("plan" in b) set("plan", Number(b.plan) || 0);
  if ("contact1Date" in b) set("contact1_date", b.contact1Date ? String(b.contact1Date).slice(0, 10) : null);
  if ("contact1Result" in b) set("contact1_result", b.contact1Result != null ? String(b.contact1Result) : null);
  if ("contact2Date" in b) set("contact2_date", b.contact2Date ? String(b.contact2Date).slice(0, 10) : null);
  if ("contact2Result" in b) set("contact2_result", b.contact2Result != null ? String(b.contact2Result) : null);
  if ("status" in b && ["in_progress", "reactivated", "refused"].includes(String(b.status))) set("status", String(b.status));
  if ("comment" in b) set("comment", b.comment != null ? String(b.comment) : null);
  if ("managerId" in b && (isAdminOrLead(auth))) {
    const mid = Number(b.managerId);
    if (auth.role === "team_lead") {
      const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [mid]);
      if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Менеджер не з вашої команди" });
    }
    set("manager_id", mid);
  }
  if (!sets.length) return res.status(400).json({ error: "Немає полів для оновлення" });
  set("updated_by", auth.userId);
  vals.push(clientKey);
  await pool.query(
    `UPDATE reactivation_clients SET ${sets.join(", ")}, updated_at = now() WHERE client_key = $${vals.length}`,
    vals
  );
  res.json({ ok: true });
});

/**
 * «Постійні від лідогену» — накопичений ефект лідогенераторів за ВЕСЬ час:
 * клієнти з лідоген-дотиком (угода повного циклу з каналом leadgen), які після
 * першого дотику зробили 2+ оплачені угоди (= стали постійними), і скільки
 * грошей принесли ПІСЛЯ дотику. Безіменні клієнти («Название не указано»)
 * виключені — під одним ключем злипаються сотні різних клієнтів.
 */
dashboardRouter.get("/leadgen-regulars", async (_req, res) => {
  const r = await pool.query<{
    touched: string; paid_once: string; paid_once_sum: string;
    regulars: string; regulars_new: string; regulars_react: string;
    revenue_after: string; revenue_new: string; revenue_react: string;
    lifetime: string; pays_after: string;
  }>(
    `WITH junk AS (
       SELECT DISTINCT client_key FROM deals
       WHERE client_name ILIKE '%название не указано%' OR client_name ILIKE '%назва не вказана%'
     ),
     lg_first AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_lg
       FROM deals d
       WHERE d.pipeline_id IN (8921932, 155304) AND d.lead_channel = 'leadgen'
         AND d.client_key IS NOT NULL
         AND d.client_key NOT IN (SELECT client_key FROM junk)
       GROUP BY d.client_key
     ),
     paid AS (
       SELECT d.client_key, d.created_at_kommo, d.price
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.pipeline_id IN (8921932, 155304) AND psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
     ),
     agg AS (
       SELECT lf.client_key,
         COUNT(p.*) FILTER (WHERE p.created_at_kommo < lf.first_lg)  AS before_n,
         COUNT(p.*) FILTER (WHERE p.created_at_kommo >= lf.first_lg) AS after_n,
         COALESCE(SUM(p.price) FILTER (WHERE p.created_at_kommo >= lf.first_lg), 0) AS after_sum,
         COALESCE(SUM(p.price), 0) AS life_sum
       FROM lg_first lf LEFT JOIN paid p ON p.client_key = lf.client_key
       GROUP BY lf.client_key
     )
     SELECT COUNT(*) AS touched,
       COUNT(*) FILTER (WHERE after_n = 1) AS paid_once,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n = 1), 0) AS paid_once_sum,
       COUNT(*) FILTER (WHERE after_n >= 2) AS regulars,
       COUNT(*) FILTER (WHERE after_n >= 2 AND before_n = 0) AS regulars_new,
       COUNT(*) FILTER (WHERE after_n >= 2 AND before_n > 0) AS regulars_react,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n >= 2), 0) AS revenue_after,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n >= 2 AND before_n = 0), 0) AS revenue_new,
       COALESCE(SUM(after_sum) FILTER (WHERE after_n >= 2 AND before_n > 0), 0) AS revenue_react,
       COALESCE(SUM(life_sum) FILTER (WHERE after_n >= 2), 0) AS lifetime,
       COALESCE(SUM(after_n) FILTER (WHERE after_n >= 2), 0) AS pays_after
     FROM agg`
  );
  const x = r.rows[0];
  const regulars = Number(x?.regulars ?? 0);
  const paysAfter = Number(x?.pays_after ?? 0);
  const revenueAfter = Number(x?.revenue_after ?? 0);
  res.json({
    touched: Number(x?.touched ?? 0),
    paidOnce: Number(x?.paid_once ?? 0),
    paidOnceSum: Number(x?.paid_once_sum ?? 0),
    regulars,
    regularsNew: Number(x?.regulars_new ?? 0),
    regularsReact: Number(x?.regulars_react ?? 0),
    revenueAfter,
    revenueNew: Number(x?.revenue_new ?? 0),
    revenueReact: Number(x?.revenue_react ?? 0),
    lifetime: Number(x?.lifetime ?? 0),
    avgPays: regulars > 0 ? Math.round((paysAfter / regulars) * 10) / 10 : 0,
    avgCheck: paysAfter > 0 ? Math.round(revenueAfter / paysAfter) : 0,
  });
});

/** Прибрати клієнта з реактивації (тімлід — своєї команди, адмін — будь-кого). */
dashboardRouter.delete("/reactivation/:clientKey", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const clientKey = String(req.params.clientKey ?? "").trim();
  if (auth.role === "team_lead") {
    const chk = await pool.query(
      `SELECT 1 FROM reactivation_clients rc JOIN managers m ON m.id = rc.manager_id
       WHERE rc.client_key = $1 AND m.team_id = $2`, [clientKey, auth.teamId]);
    if (!chk.rowCount) return res.status(403).json({ error: "Клієнт не у вашій команді" });
  }
  await pool.query(`DELETE FROM reactivation_clients WHERE client_key = $1`, [clientKey]);
  res.json({ ok: true });
});

// Team ranking: per-team revenue (success+payment), deals, avg check,
// conversion and receivables for the selected period.
dashboardRouter.get("/teams", async (req, res) => {
  // Team ranking compares teams — a manager must never see other teams.
  if (req.auth!.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  // КРОК 2: гроші з core/money.ts (анкер по даті входу + дедуп). revenue = received
  // (етап 9∪10); avgCheck — success-only (142). Знімки прибрано.
  const teamScope: money.MoneyScope = { from, to };
  // 🔴 ПРАВИЛО ВЛАСНИКА (02.08.2026): «Рейтинг команд» ОЦІНЮЄ роботу, а не показує
  // стан каси, тож і виручка, і угоди тут — ① «успішно реалізовано». Було: revenue/deals
  // з `receivedBy*` (②), а dispatched/successRev з `successBy*` — тобто в ОДНОМУ рядку
  // рейтингу сусідили дві різні множини угод, і «середній чек» ділив ② на ①.
  // Тепер обидві пари з одного джерела, тож чек ділить те саме на те саме.
  const [sucTeamAgg, sucMgrAgg] = await Promise.all([
    money.successByTeam(teamScope),
    money.successByMgr(teamScope),
  ]);
  const recvTeamAgg = sucTeamAgg, recvMgrAgg = sucMgrAgg;
  const lc: string[] = [];
  const lp: unknown[] = [];
  if (from) { lp.push(from); lc.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${lp.length}`); }
  if (to) { lp.push(to); lc.push(`(d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${lp.length}`); }
  // Словник §2: знаменник БЕЗ INNER psm (немапнуті не зникають), база — повний цикл.
  const conv = await pool.query<{ tid: number; leads: string; paid: string }>(
    `SELECT t.id AS tid, COUNT(*) AS leads, COUNT(*) FILTER (WHERE psm.funnel_stage='paid') AS paid
     FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE d.pipeline_id IN (8921932,155304) ${lc.length ? "AND " + lc.join(" AND ") : ""} GROUP BY t.id`,
    lp
  );
  // КРОК 9 Фаза 3: борг по командах і менеджерах — з core/metrics.receivablesByManager
  // (єдине джерело; прибрано 2 інлайн SUM(receivables)). Неатрибутований борг (teamId/
  // managerId = null) у /teams НЕ показується — так само, як стара логіка (немає команди
  // → немає рядка), тож числа команд ідентичні; «Без менеджера» видно лише в /overview
  // та /receivables.
  const debtByMgr = await metrics.receivablesByManager({});
  const teamDebt = new Map<number, number>();
  for (const d of debtByMgr) if (d.teamId != null) teamDebt.set(d.teamId, (teamDebt.get(d.teamId) || 0) + d.debt);


  // Per-manager breakdown for the team drill-down: revenue (success+payment),
  // deals, the month's plan and receivables — one row per active manager.
  const planMonth = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  // 🔴 План на менеджера — ЄДИНЕ ЯДРО core/plans.managerPlan (базовий + розподіл планів
  // звільнених одноплемінників), ТА САМА функція, що й світлофор Звіту 2.0 → per-mgr план
  // на /teams == світлофор. Прибрано сирий `SUM(planned_value) … AND is_active` без розподілу
  // (він губив план звільнених → живий розрив з світлофором, team14: −25 000).
  const mPlan = await plans.managerPlan({ month: planMonth });
  // 🔴 `isActive` ЇДЕ ПОРУЧ ІЗ ГРІШМИ (рішення власника 05.08.2026): історичні суми
  // рахують і звільнених, але екран мусить це СКАЗАТИ — інакше вчорашня людина
  // виглядає як діючий менеджер, і хтось поставить їй задачу.
  // 🗑 `expected` ТУТ БІЛЬШЕ НЕМАЄ — і це прибирання, а не втрата функції. Поле
  // оголошувалось, ініціалізувалось нулем і НІКОЛИ не заповнювалось та не
  // серіалізувалось: жодне джерело йому нічого не присвоювало, у `res.json` воно не
  // потрапляло. Тобто «Очікування» в цьому роуті було не зламане, а неіснуюче —
  // мертвий нуль, який при читанні коду виглядав як робоча метрика і рано чи пізно
  // спокусив би когось «полагодити» його підстановкою випадкового джерела.
  // Живе «Очікування» по менеджеру віддає `/dashboard/managers` (гейт #47).
  type MgrRow = { id: number; name: string; teamId: number; isActive: boolean; revenue: number; deals: number; plan: number; receivables: number; dispatched: number; successRev: number };
  const mmap = new Map<number, MgrRow>();
  const mget = (id: number, tid: number | null, name: string, isActive?: boolean): MgrRow => {
    let e = mmap.get(id);
    if (!e) { e = { id, name, teamId: tid ?? 0, isActive: true, revenue: 0, deals: 0, plan: 0, receivables: 0, dispatched: 0, successRev: 0 }; mmap.set(id, e); }
    if (name) e.name = name;
    if (isActive === false) e.isActive = false;
    if (tid) e.teamId = tid;
    return e;
  };
  // revenue/deals = received (анкер+дедуп); dispatched/successRev = success-only (avgCheck).
  for (const r of recvMgrAgg) { const e = mget(r.managerId, r.teamId, r.name, r.isActive); e.revenue += r.revenue; e.deals += r.deals; }
  for (const r of sucMgrAgg) { const e = mget(r.managerId, r.teamId, r.name, r.isActive); e.dispatched += r.deals; e.successRev += r.revenue; }
  for (const r of mPlan.rows) { mget(r.managerId, r.teamId, r.name).plan += r.plan; }
  for (const d of debtByMgr) { if (d.managerId != null) { const e = mmap.get(d.managerId); if (e) e.receivables += d.debt; } }

  // `expected` прибрано з тієї ж причини, що й у `MgrRow` вище — мертвий нуль.
  const map = new Map<number, { teamId: number; teamName: string; revenue: number; deals: number; leads: number; paid: number; receivables: number; dispatched: number; successRev: number }>();
  const get = (id: number, name?: string) => {
    let e = map.get(id);
    if (!e) { e = { teamId: id, teamName: name ?? "", revenue: 0, deals: 0, leads: 0, paid: 0, receivables: 0, dispatched: 0, successRev: 0 }; map.set(id, e); }
    if (name) e.teamName = name;
    return e;
  };
  /**
   * 🔴 «ПОЗА КОМАНДАМИ» — ІМЕНОВАНИЙ РЯДОК, А НЕ ПОРОЖНІЙ (рішення власника 05.08.2026).
   *
   * Ядро гроші НЕ губить: `successByTeam` віддає рядок із `teamId = null`
   * (LEFT JOIN teams), і Σ команд == Σ відділу точно, Δ = 0 — заміряно.
   * Але рядок приходив БЕЗ імені (`teamName: ""`), тож на екрані читався як
   * порожній, і 618 648 ₴ за 12 міс виглядали як зниклі.
   *
   * `teamId: 0` — не вигадка: менеджери без команди вже зводяться сюди рядком
   * `teamId: tid ?? 0` нижче, тож нуль уже є домовленістю «немає команди» в
   * цьому роуті. Лишалось дати йому ІМʼЯ.
   *
   * ⚠️ Рядок тимчасовий за задумом: клієнти службового акаунта йдуть у пул
   * «Нічийні», тімліди їх розбирають — і рядок худне сам. Прибирати його
   * руками не треба; коли він стане нулем, фільтр «без активності» прибере
   * його автоматично.
   */
  const NO_TEAM_ID = 0;
  const NO_TEAM_NAME = "Поза командами";
  const teamKey = (id: number | null) => id ?? NO_TEAM_ID;
  // 🔴 НАЗВИ КОМАНД — З ДОВІДНИКА, а не лише з грошових агрегатів. Команда, що в
  // періоді має лише ЛІДИ або БОРГ (грошей 0), у грошових агрегатах не зʼявляється
  // взагалі, тож імені їй не давав ніхто — і вона теж виходила безіменним рядком.
  // Це не наслідок перейменування «поза командами»: так було й до нього, просто
  // ніхто не дивився. Спіймав #43b на живому проді, уже після першого фікса.
  const teamNames = new Map((await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM teams`)).rows.map((t) => [t.id, t.name]));
  // ⚠️ Для НЕ-null команди повертаємо `undefined`, а не "": `get` затирає імʼя лише
  // непорожнім значенням, і порожній рядок із пізнішого джерела не має стерти назву,
  // яку вже дало попереднє.
  const teamLabel = (id: number | null, name: string | null) =>
    (id == null ? NO_TEAM_NAME : name ?? teamNames.get(id) ?? `Команда #${id}`);
  for (const r of recvTeamAgg) { const e = get(teamKey(r.teamId), teamLabel(r.teamId, r.teamName)); e.revenue += r.revenue; e.deals += r.deals; }
  for (const r of sucTeamAgg) { const e = get(teamKey(r.teamId), teamLabel(r.teamId, r.teamName)); e.dispatched += r.deals; e.successRev += r.revenue; }
  // 🔴 `teamKey` ТУТ ТЕЖ, І САМЕ ЦЕ Я СПЕРШУ ПРОҐАВИВ. Перейменувати два джерела з
  // чотирьох означало розколоти рядок надвоє: іменований під ключем 0 і безіменний
  // під ключем null. Гейт #43b спіймав це на живому проді — тобто перевірка була
  // не формальністю. Джерел рівно чотири, і всі мусять зводитись до ОДНОГО ключа.
  for (const r of conv.rows) { const e = get(teamKey(r.tid), teamLabel(r.tid, null)); e.leads += Number(r.leads); e.paid += Number(r.paid); }
  for (const [tid, debt] of teamDebt) { get(teamKey(tid), teamLabel(tid, null)).receivables += debt; }

  const teams = [...map.values()]
    // Drop teams with no activity in the period (they leak in via the payment /
    // receivables snapshots) — they showed up as empty rows like "7 —".
    .filter((e) => e.revenue > 0 || e.deals > 0 || e.leads > 0 || e.receivables > 0)
    .map((e) => ({
      teamId: e.teamId,
      teamName: e.teamName,
      revenue: e.revenue,
      deals: e.deals,
      // ПРОМТ 0.9: один якір — успішна виручка ÷ машини (без снапшотів).
      avgCheck: e.dispatched > 0 ? Math.round(e.successRev / e.dispatched) : 0,
      conversion: e.leads > 0 ? Math.round((e.paid / e.leads) * 100) : 0,
      receivables: e.receivables,
      managers: [...mmap.values()]
        .filter((m) => m.teamId === e.teamId && (m.revenue > 0 || m.deals > 0 || m.plan > 0 || m.receivables > 0))
        .map((m) => ({
          id: m.id,
          name: m.name,
          revenue: m.revenue,
          deals: m.deals,
          avgCheck: m.dispatched > 0 ? Math.round(m.successRev / m.dispatched) : 0,
          plan: m.plan,
          planPct: m.plan > 0 ? Math.round((m.revenue / m.plan) * 100) : 0,
          receivables: m.receivables,
        }))
        .sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);
  res.json({ teams });
});

// All regular clients across teams (2+ lifetime paid orders), with lifetime
// order count + revenue, sorted for the "усі постійні клієнти" drill-down.
// ── Ручні правки постійних клієнтів (лише адмін) ───────────────────────────
/** Список активних оверрайдів + довідник менеджерів для UI. */
dashboardRouter.get("/loyalty-overrides", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  // 🗄 Показуємо АРХІВНІСТЬ (з автоповерненням), а не мертву колонку `hidden`:
  // список оверрайдів має відповідати тому, що бачать екрани.
  const r = await pool.query<{ client_key: string; client_name: string | null; hidden: boolean; pinned_manager_id: number | null; force_regular: boolean; note: string | null; manager_name: string | null; updated_at: string }>(
    `WITH ${LAST_PAID_CTE}
     SELECT o.client_key, o.client_name, ${archivedSql("o", "ap")} AS hidden,
            o.pinned_manager_id, o.force_regular, o.note,
            m.name AS manager_name, o.updated_at
     FROM loyalty_overrides o
     LEFT JOIN managers m ON m.id = o.pinned_manager_id
     LEFT JOIN arch_paid ap ON ap.client_key = o.client_key
     ORDER BY o.updated_at DESC`
  );
  res.json({
    overrides: r.rows.map((x) => ({
      clientKey: x.client_key, clientName: x.client_name,
      hidden: x.hidden, pinnedManagerId: x.pinned_manager_id, pinnedManagerName: x.manager_name,
      forceRegular: x.force_regular, note: x.note, updatedAt: x.updated_at,
    })),
  });
});

/**
 * Прибрати / передати / додати постійного клієнта (upsert).
 *
 * Правило «оновлюються лише передані поля» і причина, чому воно існує, — у
 * `core/loyaltyOverride.ts` (там же його доводить тест #32 проти справжньої БД).
 */
dashboardRouter.post("/loyalty-override", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const q = buildOverrideUpsert(req.body ?? {}, req.auth!.userId);
  try {
    await pool.query(q.sql, q.params);
  } catch (e) {
    // 🔴 БД ЛИШАЄТЬСЯ ВАРТОВИМ, роут лише ПЕРЕКЛАДАЄ її відмову людською мовою.
    // Переносити правило у валідацію роуту не можна — її обходить будь-який
    // скрипт. Але 500 «internal error» на очікувану відмову теж неправильно:
    // людина бачить поломку там, де насправді спрацювало правило.
    // ⚠️ Ловимо САМЕ цей CHECK за іменем, а не будь-яку помилку: «зловив усе»
    // перетворив би справжню аварію БД на охайне 400.
    const err = e as { code?: string; constraint?: string };
    if (err.code === "23514" && err.constraint === "loyalty_overrides_force_regular_note_chk")
      return res.status(400).json({
        error: "Щоб вважати клієнта постійним попри правило, потрібна примітка «чому»" });
    throw e;
  }
  res.json({ ok: true });
});

/**
 * 🗄 В АРХІВ / З АРХІВУ — ОДНА ДІЯ (рішення власника 05.08.2026).
 *
 * 🔴 ГЕЙТ ПЕРШИМ ЗНАЧУЩИМ ОПЕРАТОРОМ, валідація ПІСЛЯ — та сама гарантія, що й у
 * `/client-merge`: «403 = спрацював гейт». Порядок навпаки дав би 400 замість 403
 * і зламав би зліпок доступу (на цьому вже раз відкочували прод 04.08.2026).
 *
 * ПРАВА: КВП / ОД / адмін (`isAdminScope`) — рішення власника.
 * ПРИЧИНА обовʼязкова й перевіряється ДВІЧІ: тут (щоб віддати 400 з людським
 * текстом) і `CHECK`-ом у БД (щоб її не обійшов скрипт повз роут).
 */
dashboardRouter.post("/client-archive", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише КВП, ОД або адміністратор" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const restore = req.body?.restore === true;
  if (restore) {
    await pool.query(
      `UPDATE loyalty_overrides SET archived_at = NULL, archive_reason = NULL, archived_by = NULL,
              updated_by = $2, updated_at = now() WHERE client_key = $1`,
      [clientKey, req.auth!.userId]);
    return res.json({ ok: true, archived: false });
  }
  const reason = String(req.body?.reason ?? "").trim();
  if (!ARCHIVE_REASON_KEYS.includes(reason))
    return res.status(400).json({ error: `Причина обовʼязкова: ${ARCHIVE_REASON_KEYS.join(", ")}` });
  await pool.query(
    `INSERT INTO loyalty_overrides (client_key, archived_at, archive_reason, archived_by, updated_by, updated_at)
     VALUES ($1, now(), $2, $3, $3, now())
     ON CONFLICT (client_key) DO UPDATE
       SET archived_at = now(), archive_reason = EXCLUDED.archive_reason,
           archived_by = EXCLUDED.archived_by, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, reason, req.auth!.userId]);
  res.json({ ok: true, archived: true });
});

/**
 * 🗄 СПИСОК АРХІВУ. Показує ЛИШЕ тих, хто в архіві ЗАРАЗ (з автоповерненням), плюс
 * причину, дату й хто поклав — щоб «чому клієнта немає» мало відповідь на екрані,
 * а не в чиїйсь памʼяті.
 */
dashboardRouter.get("/client-archive", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише КВП, ОД або адміністратор" });
  const r = await pool.query<{
    client_key: string; client_name: string | null; reason: string; archived_at: string;
    by_name: string | null; orders: string; revenue: string; last_paid: string | null;
  }>(
    `WITH ${LAST_PAID_CTE},
     agg AS (
       SELECT d.client_key, COUNT(*)::int AS orders, COALESCE(SUM(d.price),0) AS revenue
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
        GROUP BY d.client_key
     )
     SELECT o.client_key, COALESCE(o.client_name, nm.client_name) AS client_name,
            o.archive_reason AS reason,
            to_char(o.archived_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS archived_at,
            COALESCE(u.full_name, u.email) AS by_name,
            COALESCE(a.orders,0) AS orders, COALESCE(a.revenue,0) AS revenue,
            to_char(ap.last_paid AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS last_paid
       FROM loyalty_overrides o
       LEFT JOIN arch_paid ap ON ap.client_key = o.client_key
       LEFT JOIN agg a ON a.client_key = o.client_key
       LEFT JOIN users u ON u.id = o.archived_by
       -- 🔴 ІМʼЯ КЛІЄНТА БЕРЕТЬСЯ З deals, ТИМ САМИМ LATERAL, ЩО Й У РЕАКТИВАЦІЇ.
       -- loyalty_overrides.client_name ніхто не заповнює (архівація пише лише
       -- ключ і причину), тож фолбек "?? client_key" показував НОРМАЛІЗОВАНИЙ
       -- ключ: «АМС ФАРМ ТОВ» на екрані виглядало як «амсфарм». Спіймано живою
       -- пробою на проді, не читанням коду.
       LEFT JOIN LATERAL (
         SELECT d2.client_name FROM deals d2
          WHERE d2.client_key = o.client_key AND d2.client_name IS NOT NULL
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
      WHERE ${archivedSql("o", "ap")}
      ORDER BY o.archived_at DESC`);
  res.json({
    reasons: ARCHIVE_REASONS,
    clients: r.rows.map((x) => ({
      clientKey: x.client_key, clientName: x.client_name ?? x.client_key,
      reason: x.reason, reasonLabel: ARCHIVE_REASONS.find((z) => z.key === x.reason)?.label ?? x.reason,
      archivedAt: x.archived_at, archivedBy: x.by_name,
      orders: Number(x.orders), lifetimeRevenue: Number(x.revenue), lastPaid: x.last_paid,
    })),
  });
});

/** Скасувати ручну правку (повернути авто-логіку). */
dashboardRouter.delete("/loyalty-override/:clientKey", async (req, res) => {
  if (!isAdminScope(req.auth!)) return res.status(403).json({ error: "Лише адміністратор" });
  await pool.query(`DELETE FROM loyalty_overrides WHERE client_key = $1`, [String(req.params.clientKey)]);
  res.json({ ok: true });
});

/** Мапа оверрайдів постійних + імена pinned-менеджерів (для застосування). */
/**
 * 🗄 `hidden` ТУТ ТЕЖ БІЛЬШЕ НЕ ЧИТАЄТЬСЯ — інакше «одна дія замість hidden»
 * лишилась би гаслом: свіжо заархівований клієнт зникав би з двох головних
 * екранів і далі висів би на цьому. Архівність рахує ТОЙ САМИЙ `archivedSql`,
 * включно з автоповерненням по новій оплаті.
 */
async function loadLoyaltyOverrides(): Promise<Map<string, { hidden: boolean; pinnedManagerId: number | null; pinnedManagerName: string | null; pinnedTeamId: number | null; forceRegular: boolean }>> {
  const r = await pool.query<{ client_key: string; hidden: boolean; pinned_manager_id: number | null; force_regular: boolean; manager_name: string | null; team_id: number | null }>(
    `WITH ${LAST_PAID_CTE}
     SELECT o.client_key, ${archivedSql("o", "ap")} AS hidden,
            o.pinned_manager_id, o.force_regular, m.name AS manager_name, m.team_id
     FROM loyalty_overrides o
     LEFT JOIN managers m ON m.id = o.pinned_manager_id
     LEFT JOIN arch_paid ap ON ap.client_key = o.client_key`
  );
  const map = new Map<string, { hidden: boolean; pinnedManagerId: number | null; pinnedManagerName: string | null; pinnedTeamId: number | null; forceRegular: boolean }>();
  for (const x of r.rows) map.set(x.client_key, {
    hidden: x.hidden, pinnedManagerId: x.pinned_manager_id, pinnedManagerName: x.manager_name,
    pinnedTeamId: x.team_id, forceRegular: x.force_regular,
  });
  return map;
}

dashboardRouter.get("/regular-clients", async (req, res) => {
  const auth = req.auth!;
  if (auth.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const params: unknown[] = [];
  const conds = ["psm.funnel_stage = 'paid'", "d.client_key IS NOT NULL"];
  if (auth.role === "team_lead") { params.push(auth.teamId); conds.push(`m.team_id = $${params.length}`); }
  else if (req.query.teamId) { params.push(Number(req.query.teamId)); conds.push(`m.team_id = $${params.length}`); }
  // "Постійний" = 2+ paid orders AND still active (ordered within the sleeping
  // window) — a client who stopped ordering >6 міс тому is not a current
  // regular. Grouping is by client_key, so each client appears ONCE (no
  // per-manager duplication). Type is derived from the key: a numeric key is a
  // phone (фізособа, identified by phone); anything else is a named company.
  const settings = await getSettings();
  const activeMonths = settings.sleepingWindowMonths;
  const r = await pool.query<{ client_key: string; name: string; orders: string; revenue: string; last_paid: string | null }>(
    `SELECT d.client_key,
            COALESCE((array_agg(d.client_name ORDER BY d.created_at_kommo DESC))[1], 'Клієнт') AS name,
            COUNT(*) AS orders,
            COALESCE(SUM(d.price), 0) AS revenue,
            MAX(d.closed_at_kommo) AS last_paid
     FROM deals d
     JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${conds.join(" AND ")}
     GROUP BY d.client_key
     HAVING COUNT(*) >= 2
        AND MAX(d.created_at_kommo) >= now() - interval '${activeMonths} months'
     ORDER BY revenue DESC
     LIMIT 500`,
    params
  );
  const isPhoneKey = (k: string) => /^\d{9,}$/.test(k);
  const ov = await loadLoyaltyOverrides();
  res.json({
    clients: r.rows
      .filter((x) => !ov.get(x.client_key)?.hidden) // прибрані адміном не показуємо
      .map((x) => {
        const individual = isPhoneKey(x.client_key);
        return {
          clientKey: x.client_key,
          clientName: x.name,
          isCompany: !individual,
          identifier: individual ? x.client_key : null,
          orders: Number(x.orders),
          revenue: Number(x.revenue),
          lastPaid: x.last_paid,
        };
      }),
  });
});

/**
 * Reactivation candidates for the task planner: former good clients (2+ paid
 * lifetime) who went quiet (last order older than the active window) and are NOT
 * current debtors — grouped by their primary manager, best clients first. The
 * team lead picks whom to assign for reactivation.
 */
dashboardRouter.get("/reactivation-candidates", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const teamId: number | null = auth.role === "team_lead" ? (auth.teamId ?? null) : (req.query.teamId ? Number(req.query.teamId) : null);
  const activeMonths = (await getSettings()).sleepingWindowMonths;

  const params: unknown[] = [];
  let teamAnd = "";
  if (teamId != null) { params.push(teamId); teamAnd = `AND m.team_id = $${params.length}`; }

  const r = await pool.query<{ manager_id: number; manager_name: string; client_key: string; name: string; orders: string; revenue: string; last_paid: string; last_activity: string | null; category: string; payment_type: string | null }>(
    `WITH scoped AS (
       SELECT d.client_key, d.manager_id, d.client_name, d.created_at_kommo, d.price, d.payment_type
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.client_key IS NOT NULL AND psm.funnel_stage = 'paid' ${teamAnd}
     ),
     agg AS (
       SELECT client_key,
              (array_agg(client_name ORDER BY created_at_kommo DESC))[1] AS name,
              COUNT(*) AS orders, COALESCE(SUM(price),0) AS revenue, MAX(created_at_kommo) AS last_paid,
              (array_agg(payment_type ORDER BY created_at_kommo DESC))[1] AS payment_type
       FROM scoped GROUP BY client_key
     ),
     primary_mgr AS (
       SELECT client_key, manager_id FROM (
         SELECT client_key, manager_id,
                ROW_NUMBER() OVER (PARTITION BY client_key ORDER BY COUNT(*) DESC, MAX(created_at_kommo) DESC) AS rn
         FROM scoped GROUP BY client_key, manager_id
       ) z WHERE rn = 1
     )
     SELECT pm.manager_id, mm.name AS manager_name, a.client_key, a.name, a.orders, a.revenue, a.last_paid,
            a.payment_type,
            (SELECT MAX(last_activity_at) FROM deals dd WHERE dd.client_key = a.client_key) AS last_activity,
            CASE WHEN a.orders = 1 THEN 'oneshot_bg' ELSE 'lapsed' END AS category
     FROM agg a
     JOIN primary_mgr pm ON pm.client_key = a.client_key
     JOIN managers mm ON mm.id = pm.manager_id
     -- ЛИШЕ компанії (ключ по назві). Фізосіб (ключ по телефону) не пропонуємо.
     WHERE a.client_key !~ '^\\d{9,}$'
       AND a.client_key NOT IN (SELECT client_key FROM receivables WHERE client_key IS NOT NULL)
       AND (
         -- давні хороші клієнти (3+ перевезень), що замовкли
         (a.orders >= 3 AND a.last_paid < now() - interval '${activeMonths} months')
         -- або компанія з 1 перевезенням, оплаченим БЕЗНАЛОМ (форма расчета б/г)
         OR (a.orders = 1 AND a.payment_type ILIKE 'безнал%')
       )
     ORDER BY a.revenue DESC`,
    params
  );

  const byMgr = new Map<number, { managerId: number; managerName: string; clients: unknown[] }>();
  for (const x of r.rows) {
    if (!byMgr.has(x.manager_id)) byMgr.set(x.manager_id, { managerId: x.manager_id, managerName: x.manager_name, clients: [] });
    byMgr.get(x.manager_id)!.clients.push({
      clientKey: x.client_key,
      clientName: x.name,
      isCompany: true,
      identifier: null,
      orders: Number(x.orders),
      revenue: Number(x.revenue),
      lastPaid: x.last_paid,
      lastActivity: x.last_activity,
      category: x.category, // 'lapsed' | 'oneshot_bg'
      paymentType: x.payment_type, // «форма расчета» для oneshot: Безнал с/без НДС
    });
  }
  res.json({ managers: Array.from(byMgr.values()) });
});

/**
 * Середній час опрацювання заявки: від появи ліда в Кваліфікації (дата створення)
 * до моменту, коли менеджер ВЗЯВ відповідального (перша подія
 * entity_responsible_changed = lead_transfer_events). Розбито за часом ПРИХОДУ
 * заявки (за Києвом): робочий 9–18, вечір 18–21, ніч 21–9, вихідний. Роль-скоуп.
 */
dashboardRouter.get("/response-time", async (req, res) => {
  const auth = req.auth!;
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const from = (req.query.from as string) || new Date().toISOString().slice(0, 8) + "01";
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") teamId = auth.teamId;

  // КРОК 9: рероут на core/metrics.responseTime (означення й числа ідентичні). Роут
  // лишає презентаційну форму: підписи/підказки бакетів + луна from/to у відповіді.
  const rt = await metrics.responseTime({ from, to, managerId, teamId });
  const LABELS: Record<string, { label: string; hint: string }> = {
    work: { label: "🟢 Робочий (9–18)", hint: "Заявки, що надійшли в робочий час пн–пт 9:00–18:00" },
    evening: { label: "🟡 Вечір (18–21)", hint: "Заявки пн–пт 18:00–21:00" },
    night: { label: "🌙 Ніч (21–9)", hint: "Заявки пн–пт 21:00–09:00" },
    weekend: { label: "🔴 Вихідний", hint: "Заявки в суботу/неділю" },
  };
  res.json({
    from, to,
    buckets: rt.buckets.map((b) => ({
      key: b.key, label: LABELS[b.key]?.label ?? b.key, hint: LABELS[b.key]?.hint ?? "",
      count: b.count, avgMin: b.avgMin, medianMin: b.medianMin, immediatePct: b.immediatePct,
    })),
    totalCount: rt.totalCount,
    overallMedianMin: rt.overallMedianMin,
    overallAvgMin: rt.overallAvgMin,
    taken2minPct: rt.taken2minPct,
    taken15minPct: rt.taken15minPct,
    neglectedOver24h: rt.neglectedOver24h,
  });
});

/**
 * ⏱ ЧАС РЕАКЦІЇ ПО МЕНЕДЖЕРАХ — колонка табличного вигляду Звіту.
 *
 * 🔴 ЧОМУ ОКРЕМИЙ РОЗРІЗ, А НЕ N ВИКЛИКІВ `/response-time`. Агрегат уміє звузитись
 * до одного менеджера, але тридцять один запит на рендер таблиці — це тридцять один
 * шанс упертися в `REQ_TIMEOUT_MS`. Предикат спільний із агрегатом (`responseScope`
 * у ядрі), тож розріз не може розійтися з карткою над таблицею.
 *
 * 🔴 ШЛЯХ ЧЕРЕЗ СЛЕШ (`response-time/by-manager`), А НЕ ЧЕРЕЗ ДЕФІС. `pre()` у
 * `routeTab` матчить лише по слешу: `response-time-by-manager` був би ІНШИМ роутом
 * і лишився б без вкладкової межі — рівно та пастка, що описана в `#17g`.
 *
 * Менеджер, у якого в періоді не було вхідних лідів, у видачі ВІДСУТНІЙ. Це
 * «лідів не було», а не «нуль хвилин»; домальовувати йому нуль означало б
 * приписати результат там, де його нема з чого взяти.
 */
dashboardRouter.get("/response-time/by-manager", async (req, res) => {
  const auth = req.auth!;
  const from = (req.query.from as string) || new Date().toISOString().slice(0, 8) + "01";
  const to = (req.query.to as string) || new Date().toISOString().slice(0, 10);
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") teamId = auth.teamId;
  const rows = await metrics.responseTimeByManager({ from, to, managerId, teamId });
  res.json({ from, to, managers: rows });
});

/**
 * «Очікування» — deals currently sitting at the "Виставлено рахунок" (invoiced)
 * stage: bills issued, payment expected (not yet «Оплата отримана»/won). A live
 * snapshot per manager. Role-scoped. Used in the Managers and Report tabs.
 */
dashboardRouter.get("/expected-deals", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") { teamId = auth.teamId; }

  const conds = [EXPECTED_STAGES];
  const params: unknown[] = [];
  if (managerId) { params.push(managerId); conds.push(`d.manager_id = $${params.length}`); }
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }

  const r = await pool.query<{ kommo_id: string; manager_id: number; manager_name: string; client_name: string | null; price: string; created_at_kommo: string; invoiced_at: string | null }>(
    `SELECT d.kommo_id, d.manager_id, m.name AS manager_name, d.client_name, d.price, d.created_at_kommo,
            (SELECT MAX(changed_at) FROM deal_stage_events e WHERE e.kommo_id = d.kommo_id AND e.funnel_stage = 'invoiced') AS invoiced_at
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE ${conds.join(" AND ")}
      ORDER BY d.price DESC`,
    params
  );
  const deals = r.rows.map((x) => ({
    kommoId: Number(x.kommo_id),
    managerId: x.manager_id,
    managerName: x.manager_name,
    clientName: x.client_name,
    amount: Number(x.price),
    createdAt: x.created_at_kommo,
    invoicedAt: x.invoiced_at,
  }));
  res.json({ deals, total: deals.reduce((s, d) => s + d.amount, 0) });
});

// Team-lead / admin: save a comment + planned payment date for a receivable
// client (keyed by client_key so it survives sheet re-syncs).
dashboardRouter.put("/receivables/note", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const comment = req.body?.comment != null ? String(req.body.comment) : null;
  const dueDate = req.body?.dueDate ? String(req.body.dueDate) : null;
  await pool.query(
    `INSERT INTO receivable_notes (client_key, comment, due_date, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (client_key) DO UPDATE SET
       comment = EXCLUDED.comment, due_date = EXCLUDED.due_date,
       -- зміна дедлайну знімає анти-дубль авто-задачі «отримати оплату»
       task_created_at = CASE WHEN receivable_notes.due_date IS DISTINCT FROM EXCLUDED.due_date
                              THEN NULL ELSE receivable_notes.task_created_at END,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, comment, dueDate, auth.userId]
  );
  // 🗓 ІСТОРІЯ ДОПИСУЄТЬСЯ, А НЕ ЗАМІНЮЄТЬСЯ. Поле щотижня «порожніє» правилом
  // (`isCurrentWeekNote`), і без цього рядка минулі домовленості справді б
  // зникали — тобто «очищення» стало б тим, чого власник прямо не хоче.
  // Порожній коментар у журнал не пишемо: «стер текст» не є домовленістю.
  if (comment && comment.trim()) {
    await pool.query(
      `INSERT INTO receivable_note_history (client_key, comment, written_by) VALUES ($1, $2, $3)`,
      [clientKey, comment.trim(), auth.userId]
    );
  }
  res.json({ ok: true });
});

/**
 * 🗓 ІСТОРІЯ ДОМОВЛЕНОСТЕЙ ПО КЛІЄНТУ — по тижнях, з датами й авторами.
 * Межу тримає `ROUTE_TAB` (вкладка `receivables`), як і в решти роутів екрана.
 */
dashboardRouter.get("/receivables/note-history", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  /**
   * 🔒 ЖУРНАЛ ДОМОВЛЕНОСТЕЙ — ТІЛЬКИ ПО СВОЇХ КЛІЄНТАХ (26.08.2026).
   *
   * 🔴 Було відкрито ВСІМ: коментар тімліда про будь-якого клієнта читав будь-який
   * менеджер, і ключі не таємниця — їх віддає `client-search`. Це не гірше й не
   * краще за списання: це та сама діра за сусідніми дверима.
   *
   * ⚠️ ЧОМУ 403, А НЕ ПОРОЖНІЙ СПИСОК. Порожньо означає «записів немає» —
   * відповідь про ДАНІ. Тут відповідь про ПРАВО, і плутати їх не можна: інакше
   * «чужий клієнт» і «свій клієнт без історії» виглядають однаково, а це два
   * різні стани, з яких лише один — привід щось робити.
   */
  const sc = receivablesScope(auth, {});
  if (!sc.ok) return res.status(sc.status).json({ error: sc.error });
  if (sc.managerId != null || sc.teamId != null) {
    const mine = await metrics.receivablesByClient(sc);
    if (!mine.some((r) => r.clientKey === clientKey)) {
      return res.status(403).json({ error: "Клієнт поза вашим скоупом" });
    }
  }
  const r = await pool.query<{ comment: string; author: string | null; at: string }>(
    `SELECT h.comment, u.email AS author,
            to_char(h.written_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD"T"HH24:MI:SS') AS at
       FROM receivable_note_history h
       LEFT JOIN users u ON u.id = h.written_by
      WHERE h.client_key = $1
      ORDER BY h.written_at DESC LIMIT 100`,
    [clientKey]
  );
  res.json({ entries: r.rows });
});

/**
 * 👤 РУЧНЕ ПРИЗНАЧЕННЯ ВІДПОВІДАЛЬНОГО ЗА БОРГ КЛІЄНТА (рішення власника 22.08.2026).
 *
 * `managerId: null` — СВІДОМИЙ вибір «без відповідального» (бухгалтерські рахунки),
 * а не порожнє поле: рядок у таблиці вимикає авто-правило, його відсутність —
 * вмикає. Тому «зняти призначення» — це DELETE, а не PUT з порожнім менеджером.
 *
 * Примітка обовʼязкова і стережеться `CHECK`-ом у БД; 400 тут — лише щоб людина
 * побачила зрозумілу відмову раніше, ніж помилку драйвера.
 */
dashboardRouter.put("/receivables/owner", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminScope(auth)) return res.status(403).json({ error: "Лише КВП, ОД або адміністратор" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const note = String(req.body?.note ?? "").trim();
  if (!note) return res.status(400).json({ error: "Примітка обовʼязкова — призначення без причини через місяць не відрізнити від помилки" });
  const raw = req.body?.managerId;
  const managerId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (managerId != null && !Number.isFinite(managerId)) return res.status(400).json({ error: "managerId має бути числом або null" });

  // ⚠️ Готівкові рядки CRM перебудовує щосинку, тож ручне призначення там
  // відкотилось би саме — «кнопка, що не тримає» гірша за відсутню.
  const target = await pool.query(
    `SELECT 1 FROM receivables WHERE client_key = $1 AND source = 'sheet' LIMIT 1`, [clientKey]);
  if (!target.rowCount) return res.status(404).json({ error: "Клієнта немає в безготівковій дебіторці" });

  try {
    await pool.query(
      `INSERT INTO receivable_manager_override (client_key, manager_id, note, set_by, set_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (client_key) DO UPDATE SET
         manager_id = EXCLUDED.manager_id, note = EXCLUDED.note,
         set_by = EXCLUDED.set_by, set_at = now()`,
      [clientKey, managerId, note.slice(0, 300), auth.userId]
    );
  } catch (e) {
    // 🔴 ПОВІДОМЛЕННЯ НАЗИВАЄ ТУ КОЛОНКУ, ЩО СПРАВДІ ВПАЛА (успадковано з Е6).
    //
    // Було: БУДЬ-ЯКА FK-помилка ставала «Такого менеджера немає». У рядку два
    // зовнішні ключі — `manager_id` і `set_by` — і коли впав другий, підпис
    // звинувачував менеджера. Заміряно на собі: пішло два зайві заходи в
    // діагностику, поки не прочитав текст помилки БД замість власного.
    //
    // Підпис, що показує не на ту причину, гірший за підпис «щось не так»:
    // перший веде розслідування хибним шляхом, другий хоча б не веде.
    const friendly = fkErrorMessage(String((e as Error).message ?? e));
    if (friendly) return res.status(400).json({ error: friendly });
    throw e;
  }
  // Той самий перерахунок, що й у синку: інакше екран до 15 хв показував би старого.
  const r = await recomputeOwners(pool, [clientKey]);
  res.json({ ok: true, recomputed: r.clients });
});

/**
 * 🔗 СКЛЕЙКА КЛІЄНТІВ У ДЕБІТОРЦІ (рішення власника 22.08.2026, варіант A).
 *
 * Пише в ТОЙ САМИЙ реєстр `client_key_alias`, що й екран «Клієнти»: спільні
 * тригер проти ланцюжків, `CHECK` на причину і `revoke`. Це не другий механізм —
 * один реєстр, дві двері з різними межами.
 *
 * 🔴 МЕЖА ОКРЕМА, І ЦЕ НЕ ДУБЛЮВАННЯ. `merge_clients` не має СЕО і має тімлідську
 * гілку; `isAdminScope` має зайвого ФІНАНСИСТА. Підганяти будь-яку з них означало б
 * скасувати інше рішення власника — про адмінство фінансиста (31.07) або про
 * тімлідів у «Клієнтах» (04.08). Тому третє право: `merge_receivables`.
 *
 * ⚠️ ВІДКІТ — СПІЛЬНИЙ (`POST /client-merge/revoke`), і він оновлює УГОДИ негайно,
 * а дебіторку — на наступному синку (≤15 хв), бо вираз застосовується там.
 * Другої кнопки відкоту тут навмисно немає: два відкоти до одного реєстру
 * розійшлися б у поведінці швидше, ніж ми про це дізнались би.
 */
dashboardRouter.post("/receivables/merge", async (req, res) => {
  const auth = req.auth!;
  // Гейт — ПЕРШИЙ значущий оператор. Валідація тіла перед ним дала б 400 замість
  // 403 і зламала б гарантію матриці «403 = спрацював гейт» (на цьому вже
  // відкочували прод 04.08.2026).
  if (!roleHasPerm(auth.roleKey, "merge_receivables")) {
    return res.status(403).json({ error: "Обʼєднання в дебіторці доступне КВП, СЕО, Опер. директору та адміну" });
  }
  /**
   * 🔗 N ПСЕВДОНІМІВ ЗА РАЗ (рішення власника 27.08.2026).
   *
   * Модель `client_key_alias` це вміла завжди — заміряно на проді:
   * «компаніяштайнерукраїна» тримає 11 псевдонімів. Роут не вмів, тож людина
   * робила N запитів поспіль, і кожен НЕПОВНИЙ стан між ними був видимий на
   * екрані. Одиничне поле лишається прийнятним ВХОДОМ, щоб не зламати нічого,
   * що ще шле старе тіло.
   */
  const rawAliases: unknown[] = Array.isArray(req.body?.aliases)
    ? req.body.aliases
    : req.body?.alias != null ? [req.body.alias] : [];
  const aliases = [...new Set(rawAliases.map((a) => String(a ?? "").trim()).filter(Boolean))];
  const canonical = String(req.body?.canonical ?? "").trim();
  const reason = String(req.body?.reason ?? "").trim();
  if (!aliases.length || !canonical) return res.status(400).json({ error: "alias і canonical обовʼязкові" });
  if (aliases.includes(canonical)) return res.status(400).json({ error: "Не можна зливати ключ сам із собою" });
  if (!reason) return res.status(400).json({ error: "Причина обовʼязкова — реєстр без причини стає смітником" });

  /**
   * 🔒 ПʼЯТЕ МІСЦЕ ОДНОГО ВИРАЗУ СКОУПУ (`#199cg`). Зливати можна лише тих
   * клієнтів, яких ти БАЧИШ — інакше дія над невидимим об'єктом.
   *
   * ⚠️ Чесна межа: для ролей, що мають `merge_receivables` (КВП/СЕО/ОД/адмін),
   * скоуп повний, тож СЬОГОДНІ ця перевірка нікого не зупиняє. Вона тут не
   * заради сьогодні: щойно право дістане тімлід, межа звузиться сама, а не
   * чекатиме, поки хтось згадає дописати сюди фільтр.
   */
  const sc = receivablesScope(auth, {});
  if (!sc.ok) return res.status(sc.status).json({ error: sc.error });
  const mine = await metrics.receivablesByClient(sc);
  const visibleKeys = new Set(mine.map((r) => r.clientKey));
  const unseen = [canonical, ...aliases].filter((k) => !visibleKeys.has(k));
  if (unseen.length) return res.status(403).json({ error: `Поза вашим скоупом: ${unseen.join(", ")}` });

  /**
   * 🧾 ЛІМІТИ ЗВОДЯТЬСЯ ЯДРОМ (`core/mergeLimits.ts`), А НЕ SQL-ЕМ ТУТ.
   * Дні — менший із погоджених; сума — СУМА, включно з відмовою «0 ₴»
   * (рішення власника 27.08.2026, причина записана над самою функцією).
   * Слід відмови по сумі лишається СЛОВАМИ в примітці — з числа він зникає.
   */
  const keys = [canonical, ...aliases];
  // 📸 Тягнемо НЕ лише значення, а й авторство з датою: знімок мусить дати змогу
  // сказати «ліміт стояв 10 дн., поставив N, 25.08», а не лише «було 10».
  const limRows = await pool.query<mergeLimits.RawLimitRow>(
    `SELECT client_key, limit_days, limit_amount, note, set_by, set_at
       FROM client_credit_limits WHERE client_key = ANY($1)`, [keys]);
  const limitSides: mergeLimits.MergeLimitRow[] = limRows.rows.map((l) => ({
    clientKey: l.client_key,
    limitDays: l.limit_days == null ? null : Number(l.limit_days),
    limitAmount: l.limit_amount == null ? null : Number(l.limit_amount),
  }));
  const mergedDays = mergeLimits.mergedLimitDays(limitSides);
  const mergedAmount = mergeLimits.mergedLimitAmount(limitSides);
  const today = new Date().toISOString().slice(0, 10);

  /**
   * 📸 ЗНІМОК ЛІМІТІВ ДО ЗВЕДЕННЯ — у реєстр, ПЕРШ ніж їх перезаписати.
   *
   * Заміряно 01.09.2026: `ON CONFLICT DO UPDATE` затирає рядок канонічного, а
   * таблиці історії лімітів у базі немає, і `min(x, 0) = 0` не лишає з чого
   * вивести попереднє. Для двох уже злитих груп це втрачено назавжди; знімок
   * робить так, щоб наступне злиття цієї незворотності не створювало.
   *
   * 🔴 Один запис на КОЖНУ сторону, навіть без ліміту (`hadNoRow: true`), щоб
   * порожній масив означав рівно одне — «знімок не робився». Стереже `#263`.
   */
  const limitsBefore = mergeLimits.limitsBeforeSnapshot(keys, limRows.rows, new Date().toISOString());

  /**
   * 🔴 УСЕ В ОДНІЙ ТРАНЗАКЦІЇ, ВКЛЮЧНО З РЕЄСТРОМ.
   *
   * Раніше запис у `client_key_alias` стояв ОКРЕМИМ запитом ПЕРЕД транзакцією:
   * падіння перебудови лишало псевдонім у реєстрі, а рядок дебіторки —
   * старим. Наступна спроба діставала 409 «такий псевдонім уже є», тобто
   * дія була і незавершеною, і неповторюваною одночасно.
   */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const alias of aliases) {
      await client.query(
        `INSERT INTO client_key_alias (alias_key, canonical_key, reason, evidence, approved_by)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [alias, canonical, reason.slice(0, 300),
         JSON.stringify({ source: "receivables", approvedAt: today, limitsBefore }), auth.userId]);
    }
    await client.query(RECOMPUTE_RECEIVABLES_SQL);
    await client.query(`DELETE FROM receivables WHERE client_key = ANY($1) AND source = 'sheet'`, [keys]);
    /**
     * 🧾 РЯДОК ПЕРЕБУДОВУЄТЬСЯ З ЛІМІТАМИ Й ВІКОМ, А НЕ З NULL-АМИ.
     *
     * 🔴 ЩО БУЛО ЗЛАМАНО. `limit_days` вставлявся як NULL, `limit_amount` не
     * було в переліку колонок узагалі — тобто рівно до наступного синку (до
     * 15 хв) злитий клієнт стояв «ліміт не узгоджено» і, за правилом власника
     * «неузгоджений ліміт поводиться як нульовий», ПЕРЕЛІМІТНИКОМ. Вікно
     * коротке, число неправильне, і ніщо на екрані про це не казало.
     */
    await client.query(mergeLimits.MERGED_RECEIVABLE_ROW_SQL, [canonical, mergedDays, mergedAmount]);
    // Вік боргу — ТИМ САМИМ виразом ядра, що й синк. Другий вираз для «скільки
    // нам винні найдовше» розійшовся б із синком мовчки.
    await client.query(
      `UPDATE receivables r SET overdue_days = a.max_age
         FROM (${CLIENT_DEBT_AGE_SQL}) a
        WHERE a.client_key = r.client_key AND r.client_key = $1`, [canonical]);
    // 🧾 Зведений ліміт лягає і в САМУ таблицю лімітів — інакше найближчий синк
    // перезаписав би рядок старим значенням канонічного, і виправлення вікна
    // прожило б 15 хвилин. Пишемо лише тоді, коли є що зводити: рядок із
    // порожніми лімітами означав би «ліміт розглядали», а його не розглядали.
    if (mergedDays != null || mergedAmount != null) {
      await client.query(
        `INSERT INTO client_credit_limits (client_key, limit_days, limit_amount, note, set_by, set_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (client_key) DO UPDATE SET
           limit_days = EXCLUDED.limit_days, limit_amount = EXCLUDED.limit_amount,
           note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = now()`,
        [canonical, mergedDays, mergedAmount,
         mergeLimits.mergedLimitNote(limitSides, today).slice(0, 300), auth.userId]);
    }
    // Відповідальний — у ТІЙ САМІЙ транзакції: інакше зовні існував би стан
    // «рядок є, відповідального немає».
    const owners = await recomputeOwners(client, [canonical]);
    await client.query("COMMIT");
    res.json({ ok: true, merged: aliases.length, recomputed: owners.clients,
               limitDays: mergedDays, limitAmount: mergedAmount });
  } catch (e) {
    await client.query("ROLLBACK");
    const msg = String((e as Error).message ?? e);
    if (/ланцюжок заборонено/.test(msg)) return res.status(409).json({ error: msg });
    if (/duplicate key/.test(msg)) return res.status(409).json({ error: "Такий псевдонім уже є в реєстрі" });
    if (/alias_key <> canonical_key/.test(msg)) return res.status(400).json({ error: "Не можна зливати ключ сам із собою" });
    throw e;
  } finally {
    client.release();
  }
});

/** Зняти ручне призначення — авто-правило вмикається назад. */
dashboardRouter.delete("/receivables/owner/:clientKey", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminScope(auth)) return res.status(403).json({ error: "Лише КВП, ОД або адміністратор" });
  const clientKey = String(req.params.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  await pool.query(`DELETE FROM receivable_manager_override WHERE client_key = $1`, [clientKey]);
  const r = await recomputeOwners(pool, [clientKey]);
  res.json({ ok: true, recomputed: r.clients });
});

// Kommo-sync health for the admin Settings indicator: when the data was last
// refreshed, whether it looks stalled, and the last error if any.
dashboardRouter.get("/sync-status", async (_req, res) => {
  const r = await pool.query<{
    last_success_at: Date | null;
    last_run_started_at: Date | null;
    last_error: string | null;
    last_deal_count: number | null;
    consecutive_failures: number;
  }>(
    `SELECT last_success_at, last_run_started_at, last_error, last_deal_count, consecutive_failures
     FROM sync_state WHERE id = 1`
  );
  const row = r.rows[0];
  const lastSuccessAt = row?.last_success_at ?? null;
  const ageMinutes = lastSuccessAt
    ? Math.round((Date.now() - new Date(lastSuccessAt).getTime()) / 60000)
    : null;
  res.json({
    lastSuccessAt,
    lastRunStartedAt: row?.last_run_started_at ?? null,
    ageMinutes,
    stale: ageMinutes == null || ageMinutes > 15,
    lastDealCount: row?.last_deal_count ?? null,
    consecutiveFailures: row?.consecutive_failures ?? 0,
    lastError: row?.last_error ?? null,
  });
});

// Manual "Синхронізувати зараз": kick a fresh Kommo pull + stage-events pull on
// demand (a safety net over the automatic cron). Fire-and-forget — the jobs'
// own in-process guards prevent overlap; the UI polls /sync-status for progress.
dashboardRouter.post("/sync", (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  // 🔴 ЧЕРЕЗ `runJob`, А НЕ НАПРЯМУ. Раніше ручний запуск ішов повз обгортку —
  // і був НЕВИДИМИЙ для нагляду так само, як колись стартові прогони: успіх не
  // чистив `job_runs.last_error`, тож після інциденту 03.08.2026 банер горів ще
  // довго ПІСЛЯ того, як синк уже відпрацював. Той самий однорядковий клас, що
  // й `deferredStartup`: джоба, яку викликали не тією дверима, зникає з обліку.
  void runJob("syncKommo", () => syncKommo())
    .then(() => runJob("syncStageEvents", () => syncStageEvents()));
  res.json({ started: true });
});

// Manual "Оновити дебіторку зараз": перечитати дебіторку ПРЯМО З 1С на вимогу,
// щоб оплачений рахунок зник з екрана одразу, а не чекав тіку крону.
// ⚠️ Підпис кнопки був «Оновити з файлу» — після переходу на 1С це стало
// неправдою, тож підпис і підказку переписано разом із джерелом (правило
// «підпис мусить називати ту величину, що за ним стоїть»).
dashboardRouter.post("/sync-receivables", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  // Те саме: ручний запуск має лишати слід у `job_runs`, інакше «оновив руками»
  // і «джоба відпрацювала» — два різні факти, і нагляд бачить лише другий.
  // `runJob` сам ловить виняток, тож помилку читаємо з `job_runs`.
  try {
    await runJob("syncReceivables", () => syncReceivables());
    const st = await pool.query<{ err: string | null }>(
      `SELECT last_error AS err FROM job_runs WHERE name = 'syncReceivables'`);
    if (st.rows[0]?.err) return res.status(502).json({ error: "Не вдалося оновити дебіторку" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Manual receivables sync failed:", err);
    res.status(502).json({ error: "Не вдалося оновити дебіторку" });
  }
});

/**
 * Detailed report for a manager (own data) or a team-lead (their team, summed
 * with a per-manager breakdown). Same money logic as the overview, plus a
 * day/week/month time breakdown. Admin can target any team/manager via query.
 */
dashboardRouter.get("/report", async (req, res) => {
  const auth = req.auth!;
  const g = String(req.query.granularity);
  const granularity = g === "day" || g === "month" ? g : "week";
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;

  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    teamId = auth.teamId;
    // Team-lead can drill into one of their managers; both filters apply, so a
    // manager outside the team yields nothing (safe).
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    teamId = req.query.teamId ? Number(req.query.teamId) : null;
  }
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

  const scopeSql = (params: unknown[]) => {
    const c: string[] = [];
    if (managerId) { params.push(managerId); c.push(`d.manager_id = $${params.length}`); }
    if (teamId) { params.push(teamId); c.push(`m.team_id = $${params.length}`); }
    return c;
  };
  const dateSql = (col: string, params: unknown[]) => {
    const c: string[] = [];
    if (from) { params.push(from); c.push(`(d.${col} ${KYIV})::date >= $${params.length}`); }
    if (to) { params.push(to); c.push(`(d.${col} ${KYIV})::date <= $${params.length}`); }
    return c;
  };

  // КРОК 2: усі гроші звіту — з core/money.ts (анкер по даті входу + дедуп, без знімків).
  const reportScope: money.MoneyScope = { from, to, managerId, teamId };
  // Часовий ряд «Отримані кошти» по бакетах (received = етап 9∪10, дедуп по угоді).
  const recvBuckets = await money.receivedByBucket(reportScope, granularity);

  // Created full-cycle deals per bucket (by create date).
  const p2: unknown[] = [[8921932, 155304]];
  const createdWhere = ["d.pipeline_id = ANY($1)", ...scopeSql(p2), ...dateSql("created_at_kommo", p2)].join(" AND ");
  const createdPeriod = await pool.query<{ bucket: string; c: string }>(
    `SELECT to_char(date_trunc('${granularity}', (d.created_at_kommo ${KYIV})), 'YYYY-MM-DD') AS bucket, COUNT(*) AS c
     FROM deals d JOIN managers m ON m.id = d.manager_id WHERE ${createdWhere} GROUP BY 1`, p2);

  const byPeriodMap = new Map<string, { period: string; revenue: number; deals: number; created: number }>();
  const bp = (b: string) => {
    let e = byPeriodMap.get(b);
    if (!e) { e = { period: b, revenue: 0, deals: 0, created: 0 }; byPeriodMap.set(b, e); }
    return e;
  };
  for (const r of recvBuckets) { const e = bp(r.bucket); e.revenue += r.revenue; e.deals += r.deals; }
  for (const r of createdPeriod.rows) bp(r.bucket).created += Number(r.c);
  const byPeriod = [...byPeriodMap.values()]
    .sort((a, b) => (a.period < b.period ? -1 : 1))
    .map((e) => ({ ...e, avgCheck: e.deals > 0 ? Math.round(e.revenue / e.deals) : 0 }));

  // Summary totals (period): received = success ⊎ paidOnly (анкер+дедуп, знімки прибрано).
  const [reportReceived, reportSuccess, reportPaidOnly] = await Promise.all([
    money.receivedMoney(reportScope),
    money.successMoney(reportScope),
    money.paidOnlyMoney(reportScope),
  ]);
  const createdTotal = byPeriod.reduce((s, e) => s + e.created, 0);

  const p4: unknown[] = [];
  const nrScope = scopeSql(p4);
  const nrDate = dateSql("created_at_kommo", p4);
  const nrWhere = ["psm.funnel_stage = 'paid'", ...nrScope, ...nrDate].join(" AND ");
  const fromIdx = from ? (p4.push(from), p4.length) : null;
  const newRepeat = await pool.query<{ bucket: string; clients: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid, COUNT(*) AS cnt
       FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL GROUP BY d.client_key
     )
     SELECT CASE WHEN ${fromIdx ? `f.first_paid >= $${fromIdx}::date` : `f.cnt = 1`} THEN 'new' ELSE 'repeat' END AS bucket,
            COUNT(DISTINCT d.client_key) AS clients
     FROM deals d JOIN managers m ON m.id = d.manager_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     JOIN firsts f ON f.client_key = d.client_key
     WHERE ${nrWhere} GROUP BY 1`, p4);
  const newClients = Number(newRepeat.rows.find((r) => r.bucket === "new")?.clients ?? 0);
  const repeatClients = Number(newRepeat.rows.find((r) => r.bucket === "repeat")?.clients ?? 0);

  // КРОК 9: борг = core/metrics.receivablesTotal (LEFT JOIN — повна сума; скоуп по
  // менеджеру/команді виключає null-рядки, тож роль-скоуп звіту не змінюється).
  const receivablesTotalValue = await metrics.receivablesTotal({ managerId, teamId });

  const successRevenue = reportSuccess.revenue;
  const successDeals = reportSuccess.deals;
  const paymentRevenue = reportPaidOnly.revenue; // «досі в оплаті» (етап 9, ще не 142)
  const paymentDeals = reportPaidOnly.deals;
  const revenue = reportReceived.revenue;
  const deals = reportReceived.deals;
  // Full per-manager scorecard (the metrics from the manual Excel report).
  const { adSources: reportAdSources } = await getSettings();
  const actP: unknown[] = [[8921932, 155304]];
  const actConds = ["d.pipeline_id = ANY($1)", ...scopeSql(actP), ...dateSql("created_at_kommo", actP)];
  actP.push(reportAdSources);
  const actAdIdx = actP.length;
  const actByMgr = await pool.query<{ id: number; name: string; ad_leads: string; quotes: string; success: string; success_sum: string }>(
    // 🚀 JOIN-ФОРМА ПРЕДИКАТА, А НЕ КОРЕЛЬОВАНА (31.08.2026). Корельований
    // `EXISTS` виконувався ТУТ 28 728 разів і давав 97% усіх буферів запиту —
    // рівно та поломка, заради якої 05.08.2026 переписували `/overview`
    // (8 090 → 2 695 мс). Форму `joined` тоді написали й довели, але сюди вона
    // не доїхала: правило, застосоване в одному місці, не застосоване ніде.
    // Еквівалентність форм порядково стереже `#35`, ad_leads по менеджерах — `#24p`.
    //
    // 📐 ЗАМІРЯНО НА ЖИВОМУ ПРОДІ (7 прогонів на форму, з переставленим порядком пар):
    //   · без періоду (скан усієї історії, 53 619 угод): 347 → 93 мс, −250 мс, 3.7×;
    //     `SubPlan` зникає, buffers −90.6%, план стає паралельним;
    //   · серпень (2 762 угоди): 79 → 95 мс, тобто joined на ~15 мс ПОВІЛЬНІШИЙ —
    //     CTE `first_paid` агрегує ВСЮ `deals` незалежно від періоду, і на вузькому
    //     вікні ця фіксована ціна більша за виграш.
    //
    // 🔴 І ГОЛОВНЕ, ЩОБ НАСТУПНИЙ НЕ ПРОЧИТАВ ЦЕ ЯК «РОУТ ШВИДШИЙ НА 250 мс».
    // A/B двох збірок в ОДНОМУ процесі, чергуючи, 5 прогонів: сам `actByMgr` без
    // періоду впав 543 → 227 мс (−58%), а КРИТИЧНИЙ ШЛЯХ роута — лише 1974 → 1840
    // (−7%); із періодом — 0. Запитів як було 21, так і лишилось.
    // Причина: 21 запит іде хвилями через `Promise.all`, тож виграш в одному з них
    // ховається за сусідами, і після фіксу вузьким місцем став ІНШИЙ запит —
    // `stage_at` з `DISTINCT ON (dse.kommo_id)` (~500 мс, сортування виливається
    // на диск). Тобто цей коміт `#36` сам по собі НЕ закриває.
    // Це той самий урок, що вже записаний у CLAUDE.md: «заміряй ЕНДПОІНТ, а не
    // фрагмент». Я на ньому спіймався: оцінку −250 мс роуту вивів із заміру
    // ФРАГМЕНТА, і вона виявилась завищеною вп'ятеро.
    // 🔴 ГІЛКУ «вузький період → correlated» СВІДОМО НЕ РОБИМО, хоч вона й швидша
    // на 15 мс: тоді гейт `#36` (він б'є БЕЗ періоду) міряв би шлях, яким не ходить
    // жоден користувач — рівно та хвороба, яку цей прохід і лікує. Один шлях для
    // всіх, ціна названа.
    `WITH ${metrics.FIRST_PAID_CTE}
     SELECT m.id, m.name,
       COUNT(*) FILTER (WHERE ${metrics.adDealSqlMode(`$${actAdIdx}`, "joined")}) AS ad_leads,
       COUNT(*) FILTER (WHERE psm.funnel_stage IN ('quote_requested','approved','invoiced','paid')) AS quotes
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
     -- LEFT JOIN: «Прийнято реклами» рахує ВСІ ад-угоди повного циклу незалежно від
     -- поточного етапу (мапиться лише 5 із 15 статусів); quotes/dispatched і далі
     -- фільтрують по funnel_stage, тож null-етап їх природно виключає.
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     ${metrics.FIRST_PAID_JOIN}
     WHERE ${actConds.join(" AND ")}
     GROUP BY m.id, m.name`, actP);

  // «Озвучення ціни в перший дотик» — ДЖЕРЕЛО ПРАВДИ = автоматизація AI-
  // транскрибації дзвінка (uts-bot): вона слухає перший дзвінок менеджера з
  // лідом і шле пуш «ціну озвучено». Результат лягає в Google-лист «Перший
  // дотик», який ми синкаємо в `first_touch_analysis` (job syncFirstTouch).
  // Знаменник = усі проаналізовані перші дотики періоду; чисельник = ті, де
  // ціну озвучено. Скоуп по менеджеру/команді — через lead_id → deals.kommo_id
  // (manager_id авторитетний; лист теж має manager/team, але текст ненадійний).
  const ftP: unknown[] = [];
  const ftConds: string[] = [];
  if (from) { ftP.push(from); ftConds.push(`fta.analyzed_at >= $${ftP.length}::date`); }
  if (to) { ftP.push(to); ftConds.push(`fta.analyzed_at <= $${ftP.length}::date`); }
  let ftJoin = "";
  if (managerId) {
    ftP.push(managerId);
    ftJoin = "JOIN deals d ON d.kommo_id = fta.lead_id";
    ftConds.push(`d.manager_id = $${ftP.length}`);
  } else if (teamId) {
    ftP.push(teamId);
    ftJoin = "JOIN deals d ON d.kommo_id = fta.lead_id JOIN managers m ON m.id = d.manager_id";
    ftConds.push(`m.team_id = $${ftP.length}`);
  }
  const ftRes = await pool.query<{ analyzed: string; voiced: string }>(
    `SELECT COUNT(*) AS analyzed, COUNT(*) FILTER (WHERE fta.price_voiced) AS voiced
       FROM first_touch_analysis fta ${ftJoin}
       ${ftConds.length ? "WHERE " + ftConds.join(" AND ") : ""}`,
    ftP
  );
  const adPriceVoiced = Number(ftRes.rows[0]?.voiced ?? 0);
  const adFirstTouchAnalyzed = Number(ftRes.rows[0]?.analyzed ?? 0);

  // Per-manager гроші — анкер+дедуп (core/money.ts). success=142; paidOnly=етап 9 без 142.
  // 🔴 expected = ЗОНА (expectedPaymentsByPlanned) по менеджеру — НЕ вузький etap-8 (як
  // Огляд/Звіт 2.0). dobir = декомпозований по історичній частці. scopeProj — для
  // monthInProgress + звірки Σ = buildProjection(scope). Усе адитивне: Σ мгр = команда = відділ.
  const [succByMgrAgg, paidByMgrAgg, zoneByMgr, dobirByMgr, scopeProj] = await Promise.all([
    money.successByMgr(reportScope),
    money.paidOnlyByMgr(reportScope),
    metrics.expectedZoneByScope({ managerId, teamId }, "manager"),
    money.dobirByManager({ managerId, teamId }),
    metrics.buildProjection({ from, to, managerId, teamId, granularity }),
  ]);
  const zoneMap = new Map(zoneByMgr.map((r) => [r.id, r.sum]));
  const dobirMap = new Map(dobirByMgr.map((r) => [r.managerId, r.dobir]));

  // Передані заявки per manager (period) — з «Реєстру» лідоген-бота: один лід =
  // один вхід у «Нова заявка від лідогенератора», DISTINCT lead_id за період.
  // (Раніше lead_transfer_events рахував зміни відповідального → завищення в рази.)
  const trP: unknown[] = [];
  const trScope = scopeSql(trP);
  const trDate: string[] = [];
  if (from) { trP.push(from); trDate.push(`(lr.transferred_at ${KYIV})::date >= $${trP.length}`); }
  if (to) { trP.push(to); trDate.push(`(lr.transferred_at ${KYIV})::date <= $${trP.length}`); }
  const trConds = [...trScope, ...trDate];
  const transfByMgr = await pool.query<{ id: number; c: string }>(
    `SELECT d.manager_id AS id, COUNT(DISTINCT lr.lead_id) AS c
     FROM leadgen_registry lr JOIN deals d ON d.kommo_id = lr.lead_id JOIN managers m ON m.id = d.manager_id
     ${trConds.length ? "WHERE " + trConds.join(" AND ") : ""}
     GROUP BY d.manager_id`, trP);

  // Перенесені (carryover) per manager — ЯДРО metrics.carryoverByManager (детермінована
  // реконструкція з deal_stage_events на 00:00 дня-1, зона EXPECT_ZONE), ТА САМА функція,
  // що Огляд / Звіт 2.0 / plans-grid. Прибрано читання знімок-таблиці monthly_carryover_mgr
  // (легасі, корупція рестартами). Display-only: у розрахунки не входить.
  const coMonth = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const carryByMgr = await metrics.carryoverByManager({ managerId, teamId }, coMonth);

  type Score = {
    managerId: number; name: string;
    adLeads: number; quotes: number; dispatched: number; dispatchedSum: number;
    successRevenue: number; successDeals: number; paymentReceived: number;
    transfers: number; carryover: number; carryoverDeals: number; plan: number; expected: number; projection: number;
  };
  const scoreMap = new Map<number, Score>();
  const sc = (id: number, name = ""): Score => {
    let e = scoreMap.get(id);
    if (!e) { e = { managerId: id, name, adLeads: 0, quotes: 0, dispatched: 0, dispatchedSum: 0, successRevenue: 0, successDeals: 0, paymentReceived: 0, transfers: 0, carryover: 0, carryoverDeals: 0, plan: 0, expected: 0, projection: 0 }; scoreMap.set(id, e); }
    if (name) e.name = name;
    return e;
  };
  for (const r of actByMgr.rows) { const e = sc(r.id, r.name); e.adLeads = Number(r.ad_leads); e.quotes = Number(r.quotes); }
  for (const r of succByMgrAgg) {
    const e = sc(r.managerId, r.name);
    e.successRevenue = r.revenue; e.successDeals = r.deals;
    // Правило №1: «Поставлені машини» = перейшли в успіх у періоді (= успішні угоди).
    e.dispatched = r.deals; e.dispatchedSum = r.revenue;
  }
  for (const r of paidByMgrAgg) sc(r.managerId).paymentReceived = r.revenue;
  // A: expected = ЗОНА по менеджеру. Заводимо рядок і для zone/dobir-only менеджерів
  // (щоб не випадали з декомпозиції — Σ мгр має = відділ).
  for (const [id, zone] of zoneMap) sc(id).expected = zone;
  for (const [id] of dobirMap) sc(id);
  for (const r of transfByMgr.rows) sc(r.id).transfers = Number(r.c);
  for (const r of carryByMgr) { const e = sc(r.managerId); e.carryover = r.amount; e.carryoverDeals = r.deals; }
  // B: projection_m = факт(received) + зона + добір — ЛИШЕ коли місяць триває (як buildProjection);
  // інакше = факт. Σ мгр = buildProjection(scope).projected (добір-частка адитивна).
  const projMonthInProgress = scopeProj.monthInProgress;
  for (const e of scoreMap.values()) {
    const factM = e.successRevenue + e.paymentReceived;
    e.projection = projMonthInProgress ? factM + e.expected + (dobirMap.get(e.managerId) ?? 0) : factM;
  }
  // Monthly payment_amount plan per manager (for the План/Факт drill-down).
  const planMonthR = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const planScoreP: unknown[] = [planMonthR];
  const planScoreC = ["p.plan_date = $1", "p.metric = 'payment_amount'"];
  // ⚠️ Скоуп на обраного менеджера — інакше план сумується по ВСІЙ команді
  // (навіть коли вибрано одного менеджера) і плитка «Виконання плану» показує
  // командний план замість плану менеджера.
  if (managerId) { planScoreP.push(managerId); planScoreC.push(`p.manager_id = $${planScoreP.length}`); }
  if (teamId) { planScoreP.push(teamId); planScoreC.push(`m.team_id = $${planScoreP.length}`); }
  const planByMgr = await pool.query<{ id: number; plan: string }>(
    `SELECT p.manager_id AS id, SUM(p.planned_value) AS plan
     FROM plans p JOIN managers m ON m.id = p.manager_id
     WHERE ${planScoreC.join(" AND ")} GROUP BY p.manager_id`,
    planScoreP
  );
  for (const r of planByMgr.rows) sc(r.id).plan = Number(r.plan);
  const sumK = (k: keyof Score) => [...scoreMap.values()].reduce((s, e) => s + (e[k] as number), 0);

  const summary = {
    successRevenue, successDeals, paymentRevenue, paymentDeals,
    revenue, deals,
    // ПРОМТ 0.9: чисельник і знаменник — ОДИН якір (перехід в успіх у періоді).
    // Додавання поточних снапшотів до чисельника мішало якорі (Правило №1.3)
    // і роздувало чек удвічі (5313 замість ~2800 у листі).
    avgCheck: successDeals > 0 ? Math.round(successRevenue / successDeals) : 0,
    createdDeals: createdTotal,
    newClients, repeatClients,
    receivables: receivablesTotalValue,
    adLeads: sumK("adLeads"), quotes: sumK("quotes"),
    adPriceVoiced, // ціну озвучено в перший дотик (AI-транскрибація дзвінка)
    adFirstTouchAnalyzed, // усього проаналізовано перших дотиків (знаменник)
    dispatched: sumK("dispatched"), dispatchedSum: sumK("dispatchedSum"),
    transfers: sumK("transfers"),
    carryover: sumK("carryover"), carryoverDeals: sumK("carryoverDeals"),
    expected: sumK("expected"),        // A: зона (Σ мгр = expectedPaymentsByPlanned.total)
    projection: sumK("projection"),    // B: декомпозований прогноз (Σ мгр = buildProjection.projected)
    plan: sumK("plan"), // сума місячних планів виручки в скоупі (для плитки план/факт)
  };

  // КРОК 9-conv Фаза 1: конверсія по менеджеру — з ЯДРА (conversion_ads cohort,
  // стеля ≤100%). Стара формула (successDeals(ВСІ виграші)/adLeads) давала >100%
  // (до 2909% у РПК, бо ділила всі виграші на жменю ad-лідів). entered<10 →
  // cohortPct=null → «—» (нерекламний менеджер, не «0%»). Стару лишено для Фази 3.
  const adConvByMgr = new Map(
    (await metrics.conversionAdsByManager({ teamId, from, to }, reportAdSources)).map((m) => [m.managerId, m])
  );
  const byManager = managerId
    ? []
    : [...scoreMap.values()]
        // Включаємо й zone/dobir/projection-only менеджерів (напр. teamless) — щоб рядок
        // НЕ випадав мовчки й Σ видимих = summary (декомпозиція повна).
        .filter((e) => e.successRevenue > 0 || e.dispatched > 0 || e.quotes > 0 || e.paymentReceived > 0 || e.transfers > 0 || e.expected > 0 || e.projection > 0)
        .map((e) => {
          const ac = adConvByMgr.get(e.managerId);
          return {
            ...e,
            avgCheck: e.successDeals > 0 ? Math.round(e.successRevenue / e.successDeals) : 0,
            conversion: ac?.cohortPct ?? null,           // null → «—»
            conversionEntered: ac?.entered ?? 0,
            conversionBase: "реклама (cohort)",
          };
        })
        .sort((a, b) => b.successRevenue - a.successRevenue);

  res.json({ granularity, scope: managerId ? "manager" : "team", summary, byPeriod, byManager });
});

/**
 * Client-funnel report (auto version of the managers' manual "воронка клієнтів"
 * sheet). For deals created in the period (full-cycle pipeline), counts how many
 * reached each stage — Взято в роботу → Запит на прорахунок → Погоджено →
 * Рахунок → Оплата — split by client type (Нові / Постійні / Від лідогенератора),
 * per manager and summed for the team. Cumulative by creation cohort: a deal
 * counts toward every stage up to and including the deepest it has reached.
 */
const FUNNEL_ORDER = ["lead_taken", "quote_requested", "approved", "invoiced", "paid"];
// Явним переліком, а не спредом: ворота #17e2 вимагають, щоб кожне поле у
// відповіді було НАЗВАНЕ (спред одного дня протягне зайве поле назовні).
// Значення беруться зі спільного джерела — стадія має зватись однаково скрізь.
const FUNNEL_LABELS: Record<string, string> = {
  lead_taken: "Взято в роботу лідів",   // тут саме ЛІДИ — когорта створення, не угоди
  quote_requested: FUNNEL_STAGE_LABELS.quote_requested,
  approved: FUNNEL_STAGE_LABELS.approved,
  invoiced: FUNNEL_STAGE_LABELS.invoiced,
  paid: FUNNEL_STAGE_LABELS.paid,
};

/** Working days (Mon–Fri) in [start, end] inclusive. */
function workingDays(start: Date, end: Date): number {
  let n = 0;
  const d = new Date(start);
  while (d <= end) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}
dashboardRouter.get("/funnel-report", async (req, res) => {
  const auth = req.auth!;
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    teamId = auth.teamId;
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    teamId = req.query.teamId ? Number(req.query.teamId) : null;
  }
  // КРОК 9: сегментний розподіл рахує core/metrics.funnelSegmentRows (deal-grain,
  // канонічний prior-paid). 🔴 ЗМІНА проти старого: сегмент був lifetime-ярлик
  // `cnt>=2 → regular` (глобальна мітка клієнта); тепер «постійний» = у клієнта є
  // ПОПЕРЕДНЯ оплачена угода, створена раніше за цю (GLOSSARY §9). Сума по стадії —
  // ТА САМА (INNER psm, та сама когорта створення, лише активні менеджери); зсув лише
  // у розкладі new↔regular. Роут добудовує форму: кумуляція, план, підписи, wire-ключ
  // `regular` (core повертає `repeat`).
  const segRows = (await metrics.funnelSegmentRows({ from, to, managerId, teamId })).map((r) => ({
    manager_id: r.managerId,
    name: r.name,
    stage: r.stage,
    bucket: r.segment === "repeat" ? "regular" : r.segment,
    c: r.count,
  }));

  type Buckets = { new: number; regular: number; leadgen: number; total: number };
  const emptyStage = (): Buckets => ({ new: 0, regular: 0, leadgen: 0, total: 0 });
  const buildStages = (raw: { stage: string; bucket: string; c: number }[]) => {
    const reached = FUNNEL_ORDER.map(() => emptyStage());
    for (const r of raw) {
      const idx = FUNNEL_ORDER.indexOf(r.stage);
      if (idx < 0) continue;
      const b = r.bucket as "new" | "regular" | "leadgen";
      for (let i = 0; i <= idx; i++) {
        reached[i][b] += r.c;
        reached[i].total += r.c;
      }
    }
    return FUNNEL_ORDER.map((stage, i) => ({ stage, label: FUNNEL_LABELS[stage], ...reached[i] }));
  };

  const allRaw = segRows.map((r) => ({ stage: r.stage, bucket: r.bucket, c: r.c }));
  const stages = buildStages(allRaw);

  const byMgrMap = new Map<number, { managerId: number; name: string; raw: { stage: string; bucket: string; c: number }[] }>();
  for (const r of segRows) {
    let e = byMgrMap.get(r.manager_id);
    if (!e) { e = { managerId: r.manager_id, name: r.name, raw: [] }; byMgrMap.set(r.manager_id, e); }
    e.raw.push({ stage: r.stage, bucket: r.bucket, c: r.c });
  }
  const byManager = managerId
    ? []
    : [...byMgrMap.values()]
        .map((e) => ({ managerId: e.managerId, name: e.name, stages: buildStages(e.raw) }))
        .filter((e) => e.stages[0].total > 0)
        .sort((a, b) => b.stages[FUNNEL_ORDER.length - 1].total - a.stages[FUNNEL_ORDER.length - 1].total);

  // Plan overlay: the month's plan per stage (funnel_plans), prorated to date by
  // working days, so "план на сьогодні"/"відставання"/"темп" can be shown.
  const planMonthDate = (to ? to.slice(0, 7) : new Date().toISOString().slice(0, 7)) + "-01";
  const planParams: unknown[] = [planMonthDate];
  const planConds: string[] = ["fp.month = $1"];
  if (managerId) { planParams.push(managerId); planConds.push(`fp.manager_id = $${planParams.length}`); }
  if (teamId) { planParams.push(teamId); planConds.push(`m.team_id = $${planParams.length}`); }
  const planRows = await pool.query<{ manager_id: number; stage: string; planned: string }>(
    `SELECT fp.manager_id, fp.stage, fp.planned_value AS planned
     FROM funnel_plans fp JOIN managers m ON m.id = fp.manager_id
     WHERE ${planConds.join(" AND ")}`,
    planParams
  );
  const mStart = new Date(planMonthDate + "T00:00:00");
  const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const toDate = to ? new Date(to + "T00:00:00") : today;
  const elapsedEnd = toDate < today ? toDate : today;
  const totalWd = workingDays(mStart, mEnd);
  const elapsedWd = elapsedEnd >= mStart ? workingDays(mStart, elapsedEnd < mEnd ? elapsedEnd : mEnd) : 0;
  const proratio = totalWd > 0 ? elapsedWd / totalWd : 0;

  const overallPlan: Record<string, number> = {};
  const mgrPlan = new Map<number, Record<string, number>>();
  for (const r of planRows.rows) {
    const p = Number(r.planned);
    overallPlan[r.stage] = (overallPlan[r.stage] ?? 0) + p;
    let mp = mgrPlan.get(r.manager_id);
    if (!mp) { mp = {}; mgrPlan.set(r.manager_id, mp); }
    mp[r.stage] = (mp[r.stage] ?? 0) + p;
  }
  const enrich = <T extends { stage: string }>(arr: T[], plan: Record<string, number>) =>
    arr.map((s) => {
      const pm = plan[s.stage] ?? 0;
      return { ...s, planMonth: pm, planToDate: Math.round(pm * proratio) };
    });

  res.json({
    scope: managerId ? "manager" : "team",
    month: planMonthDate,
    workingDays: { total: totalWd, elapsed: elapsedWd },
    stages: enrich(stages, overallPlan),
    byManager: byManager.map((m) => ({ ...m, stages: enrich(m.stages, mgrPlan.get(m.managerId) ?? {}) })),
  });
});

/**
 * Weekly funnel matrix ("Звіт по воронці клієнтів") — the operational report the
 * team-lead reviews Mon/Thu. Unlike /funnel-report (a creation cohort), FACT here
 * counts STAGE-ENTRY events (deal_stage_events): how many deals entered each stage
 * within each week of the month, regardless of when the deal was created — so
 * "Отримано заявку" can exceed "Взято в роботу" in a given week. Plan comes from
 * funnel_plans, prorated across weeks by working days. Returns overall + per manager.
 */
dashboardRouter.get("/funnel-weekly", async (req, res) => {
  const auth = req.auth!;
  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    teamId = auth.teamId;
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
  } else {
    managerId = req.query.managerId ? Number(req.query.managerId) : null;
    teamId = req.query.teamId ? Number(req.query.teamId) : null;
  }
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Month is taken from ?month=YYYY-MM (or the `to` filter, or current month).
  const monthQ = (req.query.month as string) || (req.query.to as string) || new Date().toISOString().slice(0, 7);
  const planMonthDate = monthQ.slice(0, 7) + "-01";
  const mStart = new Date(planMonthDate + "T00:00:00");
  const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const factUpper = today < mEnd ? today : mEnd; // cap facts at today for the current month

  // Buckets = колонки звіту: тижні (Пн–Нд, кліпнуті до меж місяця) або дні
  // (?granularity=day). `key` — ключ для мапінгу фактів (Пн тижня або сам день).
  const granularity = String(req.query.granularity) === "day" ? "day" : "week";
  const WEEKDAY = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const weeks: { label: string; from: string; to: string; key: string; wd: number }[] = [];
  if (granularity === "week") {
    let cur = new Date(mStart);
    while (cur <= mEnd) {
      const daysToSun = (7 - cur.getDay()) % 7;
      let wEnd = new Date(cur); wEnd.setDate(cur.getDate() + daysToSun);
      if (wEnd > mEnd) wEnd = new Date(mEnd);
      const mon = new Date(cur); mon.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
      weeks.push({ label: `ТИЖДЕНЬ ${weeks.length + 1}`, from: fmt(cur), to: fmt(wEnd), key: fmt(mon), wd: workingDays(cur, wEnd) });
      cur = new Date(wEnd); cur.setDate(wEnd.getDate() + 1);
    }
  } else {
    // Дні: поточний місяць — до сьогодні; минулий — весь місяць (кап через factUpper).
    const dEnd = factUpper < mEnd ? factUpper : mEnd;
    let cur = new Date(mStart);
    while (cur <= dEnd) {
      const iso = fmt(cur);
      const wknd = cur.getDay() === 0 || cur.getDay() === 6;
      weeks.push({ label: `${WEEKDAY[cur.getDay()]} ${String(cur.getDate()).padStart(2, "0")}.${String(cur.getMonth() + 1).padStart(2, "0")}`, from: iso, to: iso, key: iso, wd: wknd ? 0 : 1 });
      cur = new Date(cur); cur.setDate(cur.getDate() + 1);
    }
  }
  const totalWd = workingDays(mStart, mEnd);
  const elapsedEnd = factUpper >= mStart ? factUpper : mStart;
  const elapsedWd = factUpper >= mStart ? workingDays(mStart, elapsedEnd) : 0;
  const proratio = totalWd > 0 ? elapsedWd / totalWd : 0;

  // 5 класичних етапів воронки (як у ручному звіті менеджера): Взято в роботу →
  // Прорахунок → Погоджено → Рахунок → Оплата. Беремо прямо з funnel_stage
  // (LIVE pipeline_stage_map). «Авто працює» тут НЕ окремий етап — авто-статуси
  // мапляться у свій funnel_stage (approved/invoiced), як у ручній воронці.
  // FACT: distinct deals that entered each funnel stage, per manager, per bucket.
  // КРОК 9: рероут на core/metrics.funnelWeeklyByManager (той самий SQL, лише винесений
  // — FACT-числа ідентичні). Форма (тижні/дні, план, гроші) лишається в роуті. Вікно
  // фактів кліпнуте до сьогодні для поточного місяця (fmt(mStart)..fmt(factUpper)).
  const factRows = {
    rows: (await metrics.funnelWeeklyByManager(
      { from: fmt(mStart), to: fmt(factUpper), managerId, teamId, activeOnly: true },
      granularity
    )).map((r) => ({ manager_id: r.managerId, name: r.name, stage: r.stage, wk: r.bucket, c: r.deals })),
  };

  // PLAN: monthly funnel plan per stage (funnel_plans).
  const pParams: unknown[] = [planMonthDate];
  const pConds = ["fp.month = $1"];
  if (managerId) { pParams.push(managerId); pConds.push(`fp.manager_id = $${pParams.length}`); }
  if (teamId) { pParams.push(teamId); pConds.push(`m.team_id = $${pParams.length}`); }
  const planRows = await pool.query<{ manager_id: number; stage: string; planned: string }>(
    `SELECT fp.manager_id, fp.stage, fp.planned_value AS planned
     FROM funnel_plans fp JOIN managers m ON m.id = fp.manager_id
     WHERE ${pConds.join(" AND ")}`,
    pParams
  );

  // MONEY per manager (live sums, so they follow the deal's current budget):
  //  • carryover = deals still "Авто працює"/in progress (not paid) that were
  //    created BEFORE the 1st of this month — "перенесені з минулого місяця".
  //  • expected  = ALL deals in progress not yet paid — expected payments this month.
  //  • received  = paid: "Оплата отримана" snapshot (69716460/60412544) +
  //    "Успішна угода" (142) closed within the month.
  const IN_PROGRESS =
    "(psm.funnel_stage IN ('approved','invoiced') OR d.status_id IN (69716300, 98470988, 10937178))";
  // carryover/expected — знімки in-progress (окремі метрики, не чіпаємо). received —
  // 🔴 Крок А: винесено в ЯДРО money.receivedByMgr (нижче), недатований paidOnly-знімок
  // прибрано. Тому тут лишились ЛИШЕ carryover/expected (параметри $1=FC, $2=mStart).
  const mParams: unknown[] = [[8921932, 155304], fmt(mStart)];
  const mConds = ["d.pipeline_id = ANY($1)"];
  if (managerId) { mParams.push(managerId); mConds.push(`d.manager_id = $${mParams.length}`); }
  if (teamId) { mParams.push(teamId); mConds.push(`m.team_id = $${mParams.length}`); }
  const moneyRows = await pool.query<{ manager_id: number; carryover: string; expected: string }>(
    `SELECT d.manager_id,
       COALESCE(SUM(d.price) FILTER (WHERE ${IN_PROGRESS} AND (d.created_at_kommo ${KYIV})::date < $2), 0) AS carryover,
       COALESCE(SUM(d.price) FILTER (WHERE ${IN_PROGRESS}), 0) AS expected
     FROM deals d
     JOIN managers m ON m.id = d.manager_id AND m.is_active
     LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
     WHERE ${mConds.join(" AND ")}
     GROUP BY d.manager_id`,
    mParams
  );
  // received/receivedDeals (місячні, per manager) = ЯДРО (датований, дедуп). Той самий
  // scope і вікно (mStart..factUpper), що й факт-воронка → КВП == Огляд == Звіт.
  const recvByMgr = await money.receivedByMgr({ from: fmt(mStart), to: fmt(factUpper), managerId, teamId });
  type MoneyWeek = { plan: number; fact: number; expected: number };
  type Money = {
    carryover: number; expected: number; received: number; receivedDeals: number;
    planMonth: number; weeks: MoneyWeek[]; daily: { date: string; v: number }[];
  };
  const emptyMoney = (): Money => ({
    carryover: 0, expected: 0, received: 0, receivedDeals: 0, planMonth: 0,
    weeks: weeks.map(() => ({ plan: 0, fact: 0, expected: 0 })), daily: [],
  });
  const overallMoney = emptyMoney();
  const mgrMoney = new Map<number, Money>();
  const moneyOf = (id: number): Money => {
    let m = mgrMoney.get(id);
    if (!m) { m = emptyMoney(); mgrMoney.set(id, m); }
    return m;
  };
  for (const r of moneyRows.rows) {
    const m = moneyOf(r.manager_id);
    m.carryover = Number(r.carryover); m.expected = Number(r.expected);
    overallMoney.carryover += m.carryover;
    overallMoney.expected += m.expected;
  }
  for (const rr of recvByMgr) {
    const m = moneyOf(rr.managerId);
    m.received = Math.round(rr.revenue); m.receivedDeals = rr.deals;
    overallMoney.received += m.received;
    overallMoney.receivedDeals += m.receivedDeals;
  }

  // Місячний план виручки (plans.payment_amount) → пропорційно на тижні за
  // робочими днями; факт по тижнях/днях = «Успішно» (142), закриті в тижні/дні
  // (снапшот «оплата отримана» по тижнях не ділиться — він у місячному received).
  const rpParams: unknown[] = [planMonthDate];
  const rpConds = ["p.plan_date = $1", "p.metric = 'payment_amount'"];
  if (managerId) { rpParams.push(managerId); rpConds.push(`p.manager_id = $${rpParams.length}`); }
  if (teamId) { rpParams.push(teamId); rpConds.push(`m.team_id = $${rpParams.length}`); }
  const revPlanRows = await pool.query<{ manager_id: number; v: string }>(
    `SELECT p.manager_id, SUM(p.planned_value) AS v
       FROM plans p JOIN managers m ON m.id = p.manager_id
      WHERE ${rpConds.join(" AND ")} GROUP BY p.manager_id`,
    rpParams
  );
  for (const r of revPlanRows.rows) {
    const v = Number(r.v);
    moneyOf(r.manager_id).planMonth = v;
    overallMoney.planMonth += v;
  }
  for (const m of [overallMoney, ...mgrMoney.values()]) {
    m.weeks = weeks.map((w) => ({ plan: Math.round(m.planMonth * (totalWd > 0 ? w.wd / totalWd : 0)), fact: 0, expected: 0 }));
  }

  // Тижневий/денний ФАКТ оплат = сума угод, у яких оплата ВПЕРШЕ надійшла в цьому
  // бакеті (перший вхід у «Успішно» 142 або «Оплата отримана» 69716460/60412544,
  // за подіями). Кожна оплачена угода рахується один раз — у тиждень першої оплати
  // → тижні сумуються в місячний факт (як у ручному звіті менеджера). Це ширше за
  // старе «142 закрито» і ловить снапшот-платників (гроші є, але угоду ще не закрито).
  const paidP: unknown[] = [[8921932, 155304], fmt(mStart), fmt(mEnd)];
  const paidC = ["d.pipeline_id = ANY($1)", `(x.first_paid ${KYIV})::date BETWEEN $2 AND $3`];
  if (managerId) { paidP.push(managerId); paidC.push(`d.manager_id = $${paidP.length}`); }
  if (teamId) { paidP.push(teamId); paidC.push(`m.team_id = $${paidP.length}`); }
  const paidWeekly = await pool.query<{ manager_id: number; day: string; v: string }>(
    `SELECT d.manager_id, to_char((x.first_paid ${KYIV})::date, 'YYYY-MM-DD') AS day, SUM(d.price) AS v
       FROM (SELECT kommo_id, MIN(changed_at) AS first_paid FROM deal_stage_events
             WHERE status_id IN (142, 69716460, 60412544) GROUP BY kommo_id) x
       JOIN deals d ON d.kommo_id = x.kommo_id
       JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE ${paidC.join(" AND ")} GROUP BY d.manager_id, day ORDER BY day`,
    paidP
  );
  const overallDaily = new Map<string, number>();
  for (const r of paidWeekly.rows) {
    const v = Number(r.v);
    overallDaily.set(r.day, (overallDaily.get(r.day) ?? 0) + v);
    const wi = weeks.findIndex((w) => r.day >= w.from && r.day <= w.to);
    if (wi >= 0) {
      moneyOf(r.manager_id).weeks[wi].fact += v;
      overallMoney.weeks[wi].fact += v;
    }
  }
  overallMoney.daily = [...overallDaily.entries()].map(([date, v]) => ({ date, v }));

  // Тижневе/денне ОЧІКУВАННЯ = сума угод, у яких рахунок ВПЕРШЕ виставлено в цьому
  // бакеті (перший вхід у funnel_stage='invoiced' за подіями) — «виставлено рахунків
  // на суму X цього тижня». Кожна угода один раз, у тиждень першого рахунку.
  const expP: unknown[] = [[8921932, 155304], fmt(mStart), fmt(mEnd)];
  const expC = ["d.pipeline_id = ANY($1)", `(x.first_inv ${KYIV})::date BETWEEN $2 AND $3`];
  if (managerId) { expP.push(managerId); expC.push(`d.manager_id = $${expP.length}`); }
  if (teamId) { expP.push(teamId); expC.push(`m.team_id = $${expP.length}`); }
  const expWeekly = await pool.query<{ manager_id: number; day: string; v: string }>(
    `SELECT d.manager_id, to_char((x.first_inv ${KYIV})::date, 'YYYY-MM-DD') AS day, SUM(d.price) AS v
       FROM (SELECT dse.kommo_id, MIN(dse.changed_at) AS first_inv
               FROM deal_stage_events dse
               JOIN deals dd ON dd.kommo_id = dse.kommo_id
               JOIN pipeline_stage_map psm ON psm.pipeline_id = dd.pipeline_id AND psm.status_id = dse.status_id
              WHERE psm.funnel_stage = 'invoiced' GROUP BY dse.kommo_id) x
       JOIN deals d ON d.kommo_id = x.kommo_id
       JOIN managers m ON m.id = d.manager_id AND m.is_active
      WHERE ${expC.join(" AND ")} GROUP BY d.manager_id, day`,
    expP
  );
  for (const r of expWeekly.rows) {
    const v = Number(r.v);
    const wi = weeks.findIndex((w) => r.day >= w.from && r.day <= w.to);
    if (wi >= 0) {
      moneyOf(r.manager_id).weeks[wi].expected += v;
      overallMoney.weeks[wi].expected += v;
    }
  }

  // Aggregate facts: overall + per manager, keyed stage → mondayWeek → count.
  type WkMap = Record<string, Record<string, number>>;
  const overallFacts: WkMap = {};
  const mgrFacts = new Map<number, { name: string; facts: WkMap }>();
  for (const r of factRows.rows) {
    const c = Number(r.c);
    (overallFacts[r.stage] ??= {})[r.wk] = ((overallFacts[r.stage] ??= {})[r.wk] ?? 0) + c;
    let e = mgrFacts.get(r.manager_id);
    if (!e) { e = { name: r.name, facts: {} }; mgrFacts.set(r.manager_id, e); }
    (e.facts[r.stage] ??= {})[r.wk] = ((e.facts[r.stage] ??= {})[r.wk] ?? 0) + c;
  }
  const overallPlan: Record<string, number> = {};
  const mgrPlan = new Map<number, Record<string, number>>();
  const mgrName = new Map<number, string>();
  for (const r of planRows.rows) {
    const p = Number(r.planned);
    overallPlan[r.stage] = (overallPlan[r.stage] ?? 0) + p;
    let mp = mgrPlan.get(r.manager_id);
    if (!mp) { mp = {}; mgrPlan.set(r.manager_id, mp); }
    mp[r.stage] = (mp[r.stage] ?? 0) + p;
  }
  for (const [id, e] of mgrFacts) mgrName.set(id, e.name);

  const WK_STAGES = FUNNEL_ORDER; // 5 класичних етапів
  const WK_LABELS = FUNNEL_LABELS;
  const buildStages = (facts: WkMap, plan: Record<string, number>) =>
    WK_STAGES.map((stage) => {
      const pm = plan[stage] ?? 0;
      const wkOut = weeks.map((w) => ({
        plan: Math.round(pm * (totalWd > 0 ? w.wd / totalWd : 0)),
        fact: facts[stage]?.[w.key] ?? 0,
      }));
      const factToday = wkOut.reduce((a, w) => a + w.fact, 0);
      return {
        stage,
        label: WK_LABELS[stage],
        planMonth: pm,
        planToday: Math.round(pm * proratio),
        factToday,
        weeks: wkOut,
      };
    });

  const managerIds = new Set<number>([...mgrFacts.keys(), ...mgrPlan.keys(), ...mgrMoney.keys()]);
  // Names for managers that appear only in the plan (no facts yet) need a lookup.
  const missingNames = [...managerIds].filter((id) => !mgrName.has(id));
  if (missingNames.length) {
    const nr = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM managers WHERE id = ANY($1)`,
      [missingNames]
    );
    for (const r of nr.rows) mgrName.set(r.id, r.name);
  }
  const byManager = managerId
    ? []
    : [...managerIds]
        .map((id) => ({ managerId: id, name: mgrName.get(id) ?? `#${id}`, stages: buildStages(mgrFacts.get(id)?.facts ?? {}, mgrPlan.get(id) ?? {}), money: mgrMoney.get(id) ?? emptyMoney() }))
        .sort((a, b) => {
          if (b.money.received !== a.money.received) return b.money.received - a.money.received;
          const pa = a.stages.reduce((s, x) => s + x.factToday, 0);
          const pb = b.stages.reduce((s, x) => s + x.factToday, 0);
          if (pb !== pa) return pb - pa;
          return a.name.localeCompare(b.name, "uk");
        });

  res.json({
    scope: managerId ? "manager" : "team",
    granularity,
    month: planMonthDate,
    today: fmt(today),
    workingDays: { total: totalWd, elapsed: elapsedWd },
    weeks: weeks.map((w) => ({ label: w.label, from: w.from, to: w.to })),
    overall: { name: "ЗАГАЛЬНИЙ", stages: buildStages(overallFacts, overallPlan), money: overallMoney },
    byManager,
  });
});

/**
 * A single manager's daily productivity for the picked day: leads taken,
 * dispatched ("Авто працює"), payments received (count + ₴), the pro-rated
 * daily plan, plus a 14-day payment-sum trend. Manager sees themselves; a
 * team-lead any manager in their team; admin/КВП anyone.
 */
dashboardRouter.get("/daily", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  if (auth.role === "manager") managerId = auth.managerId;
  else if (auth.role === "team_lead") {
    if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });

  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const day = (req.query.date as string) || new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const AVTO = "dse.status_id IN (69716300, 98470988, 10937178)";
  const GROUP_CASE = `CASE
    WHEN ${AVTO} THEN 'avto'
    WHEN psm.funnel_stage IN ('lead_taken','quote_requested','approved') THEN 'taken'
    WHEN psm.funnel_stage = 'invoiced' THEN 'invoiced'
    WHEN psm.funnel_stage = 'paid' THEN 'paid' END`;

  // Distinct deals entering each grouped stage on the day.
  const grpRes = await pool.query<{ g: string; c: string }>(
    `SELECT ${GROUP_CASE} AS g, COUNT(DISTINCT dse.kommo_id) AS c
     FROM deal_stage_events dse
     JOIN deals d ON d.kommo_id = dse.kommo_id
     JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
     WHERE d.manager_id = $1 AND (dse.changed_at ${KYIV})::date = $2
     GROUP BY 1`,
    [managerId, day]
  );
  const grp = (g: string) => Number(grpRes.rows.find((r) => r.g === g)?.c ?? 0);

  // Payment sum on the day (distinct paid-stage entries).
  const paidSumRes = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(x.price), 0) AS s FROM (
       SELECT DISTINCT dse.kommo_id, d.price
       FROM deal_stage_events dse
       JOIN deals d ON d.kommo_id = dse.kommo_id
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
       WHERE d.manager_id = $1 AND psm.funnel_stage = 'paid' AND (dse.changed_at ${KYIV})::date = $2
     ) x`,
    [managerId, day]
  );

  // 14-day payment-sum trend (ending on the picked day).
  const from14 = new Date(day + "T00:00:00"); from14.setDate(from14.getDate() - 13);
  const fmtd = (d: Date) => d.toLocaleDateString("en-CA");
  const trendRes = await pool.query<{ day: string; s: string }>(
    `SELECT day, SUM(price) AS s FROM (
       SELECT DISTINCT (dse.changed_at ${KYIV})::date AS day, dse.kommo_id, d.price
       FROM deal_stage_events dse
       JOIN deals d ON d.kommo_id = dse.kommo_id
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = dse.status_id
       WHERE d.manager_id = $1 AND psm.funnel_stage = 'paid'
         AND (dse.changed_at ${KYIV})::date BETWEEN $2 AND $3
     ) x GROUP BY day`,
    [managerId, fmtd(from14), day]
  );
  const trendMap = new Map(trendRes.rows.map((r) => [String(r.day).slice(0, 10), Number(r.s)]));
  const trend: { day: string; amount: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(from14); d.setDate(from14.getDate() + i);
    trend.push({ day: fmtd(d), amount: trendMap.get(fmtd(d)) ?? 0 });
  }

  // Per-day plan = month's payment_amount plan / working days in the month.
  const monthStart = new Date(day + "T00:00:00"); monthStart.setDate(1);
  const planRes = await pool.query<{ p: string }>(
    `SELECT COALESCE(SUM(planned_value), 0) AS p FROM plans
     WHERE manager_id = $1 AND metric = 'payment_amount' AND plan_date = $2`,
    [managerId, fmtd(monthStart)]
  );
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const totalWd = workingDays(monthStart, monthEnd);
  const monthPlan = Number(planRes.rows[0]?.p ?? 0);
  const planDay = totalWd > 0 ? Math.round(monthPlan / totalWd) : 0;
  const paidSum = Number(paidSumRes.rows[0]?.s ?? 0);

  const nameRes = await pool.query<{ name: string; team: string | null }>(
    `SELECT m.name, t.name AS team FROM managers m LEFT JOIN teams t ON t.id = m.team_id WHERE m.id = $1`,
    [managerId]
  );
  res.json({
    date: day,
    managerName: nameRes.rows[0]?.name ?? "",
    teamName: nameRes.rows[0]?.team ?? null,
    taken: grp("taken"),
    avto: grp("avto"),
    paidCount: grp("paid"),
    paidSum,
    planDay,
    planPct: planDay > 0 ? Math.round((paidSum / planDay) * 100) : null,
    trend,
  });
});

/**
 * "Застряглі угоди" — active full-cycle deals that haven't moved to a new stage
 * for ≥ minDays (default 7). Days-in-stage = now − last stage-change event (or
 * creation if no events). Excludes closed deals (paid/won/lost). Role-scoped.
 */
dashboardRouter.get("/stuck-deals", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") { teamId = auth.teamId; managerId = req.query.managerId ? Number(req.query.managerId) : null; }
  const minDays = Math.max(1, Number(req.query.minDays) || metrics.STUCK_MIN_DAYS);

  // КРОК 9: рероут на core/metrics.stuckDeals (SQL/пороги ідентичні: minDays для
  // грошових стадій, ×3 для ранньої, вікно 180 днів, годинник COALESCE(last_activity,
  // created), LIMIT 50). Роут лишає крос-посилання в CRM (`crmUrl`).
  const stuck = await metrics.stuckDeals({ managerId, teamId }, minDays);
  res.json({
    minDays,
    deals: stuck.map((d) => ({
      kommoId: d.kommoId,
      crmUrl: kommoLeadUrl(d.kommoId),
      name: d.name,
      client: d.client,
      manager: d.manager,
      price: d.price,
      stage: d.stage,
      days: d.days,
      activityDays: d.activityDays,
    })),
  });
});

/**
 * Застряглі угоди ЗГРУПОВАНІ по менеджерах (переробка секції) — БЕЗ «стелі 50»,
 * повний набір + company-summary. Роль-клампи ідентичні `/stuck-deals`:
 * manager→свої, team_lead→свій відділ, admin→вся компанія (з опц. ?teamId/?managerId).
 * Кожна угода несе `crmUrl`; кожна група — `teamTag` (rpk/rnk/leadgen) для чипа.
 */
dashboardRouter.get("/stuck-deals-grouped", async (req, res) => {
  const auth = req.auth!;
  let managerId = req.query.managerId ? Number(req.query.managerId) : null;
  let teamId = req.query.teamId ? Number(req.query.teamId) : null;
  if (auth.role === "manager") { managerId = auth.managerId; teamId = null; }
  else if (auth.role === "team_lead") { teamId = auth.teamId; managerId = req.query.managerId ? Number(req.query.managerId) : null; }
  const minDays = Math.max(1, Number(req.query.minDays) || metrics.STUCK_MIN_DAYS);

  const g = await metrics.stuckDealsGrouped({ managerId, teamId }, minDays);
  // Нотатки менеджера — одним запитом по вже відібраних угодах (без N+1). Видимість
  // успадковується від роль-клампу вище: у відповідь потрапляють ЛИШЕ ті угоди, які
  // ця роль і так бачить, тож окремого гейта на читання нотатки не потрібно.
  const ids = g.groups.flatMap((grp) => grp.deals.map((d) => d.kommoId));
  const noteMap = new Map<number, { comment: string | null; author: string | null; at: string | null }>();
  if (ids.length) {
    const nr = await pool.query<{ kommo_id: string; comment: string | null; author: string | null; updated_at: string | null }>(
      `SELECT n.kommo_id, n.comment, u.email AS author, to_char(n.updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS updated_at
         FROM deal_notes n LEFT JOIN users u ON u.id = n.updated_by
        WHERE n.kommo_id = ANY($1::bigint[])`, [ids]);
    for (const r of nr.rows) noteMap.set(Number(r.kommo_id), { comment: r.comment, author: r.author, at: r.updated_at });
  }
  res.json({
    minDays,
    role: auth.role,
    scope: auth.role === "manager" ? "own" : auth.role === "team_lead" ? "team" : "company",
    total: g.total, sumRisk: g.sumRisk, managers: g.managers, over90: g.over90,
    // 🕰 «Дані станом на» — не косметика: лічильник рахується від ЦЬОГО моменту, а не
    // від годинника, тож без підпису екран не пояснив би, чому число не росте.
    asOf: g.asOf, talkAmbiguousCount: g.talkAmbiguousCount,
    // Хвіст «(N год тому)» вирішує СЕРВЕР: поріг = 2× інтервал тієї джоби, що відстає.
    asOfStale: g.asOfStale, asOfAgeMin: g.asOfAgeMin,
    asOfStaleAfterMin: g.asOfStaleAfterMin, asOfJob: g.asOfJob,
    groups: g.groups.map((grp) => ({
      managerId: grp.managerId, manager: grp.manager, teamId: grp.teamId,
      teamTag: grp.teamId != null ? kvpTeamKind(grp.teamId, grp.teamName ?? "") : null,
      count: grp.count, sumAtRisk: grp.sumAtRisk, longestIdleDays: grp.longestIdleDays,
      deals: grp.deals.map((d) => ({
        kommoId: d.kommoId, crmUrl: kommoLeadUrl(d.kommoId), name: d.name, client: d.client,
        price: d.price, stage: d.stage, days: d.days, activityDays: d.activityDays,
        lastCallAt: d.lastCallAt, daysSinceLastCall: d.daysSinceLastCall, noCallFlag: d.noCallFlag,
        talkSource: d.talkSource, talkAmbiguous: d.talkAmbiguous,
        note: noteMap.get(d.kommoId)?.comment ?? null,
        noteAuthor: noteMap.get(d.kommoId)?.author ?? null,
        noteAt: noteMap.get(d.kommoId)?.at ?? null,
        // Право на правку рахує СЕРВЕР (не фронт): відповідальний менеджер + тімлід/адмін.
        canEditNote: isAdminOrLead(auth) || auth.managerId === grp.managerId,
      })),
    })),
  });
});

/**
 * Нотатка менеджера по угоді (позначки в «Застряглих угодах»). Автозбереження з фронту.
 * ПРАВО НА ПРАВКУ ПЕРЕРАХОВУЄТЬСЯ ТУТ, від живої угоди — прапорець `canEditNote` у
 * GET-і суто косметичний, серверу він не джерело істини:
 *   • admin (і всі, кого scopeCompatRole зводить до admin — ceo/opdir/kvp) — будь-яка угода;
 *   • team_lead — угоди менеджерів СВОГО відділу;
 *   • manager — лише де він відповідальний.
 * Порожній коментар = зняти нотатку (DELETE), щоб не лишати порожніх рядків.
 */
dashboardRouter.post("/deal-note", async (req, res) => {
  const auth = req.auth!;
  const kommoId = Number(req.body?.kommoId);
  if (!Number.isFinite(kommoId) || kommoId <= 0) return res.status(400).json({ error: "kommoId обовʼязковий" });
  const raw = req.body?.comment;
  const comment = typeof raw === "string" ? raw.trim().slice(0, 2000) : "";

  // Хто відповідальний і в якому відділі — беремо з БД, не з тіла запиту.
  const own = await pool.query<{ manager_id: number | null; team_id: number | null }>(
    `SELECT d.manager_id, m.team_id FROM deals d
       LEFT JOIN managers m ON m.id = d.manager_id
      WHERE d.kommo_id = $1`, [kommoId]);
  if (!own.rows[0]) return res.status(404).json({ error: "Угоду не знайдено" });
  const { manager_id, team_id } = own.rows[0];

  const may = isAdminScope(auth)
    || (auth.role === "team_lead" && team_id != null && team_id === auth.teamId)
    || (manager_id != null && manager_id === auth.managerId);
  if (!may) return res.status(403).json({ error: "Нотатку може редагувати відповідальний менеджер або тімлід/адмін" });

  if (!comment) {
    await pool.query(`DELETE FROM deal_notes WHERE kommo_id = $1`, [kommoId]);
    return res.json({ ok: true, note: null, noteAuthor: null, noteAt: null });
  }
  const up = await pool.query<{ author: string | null; updated_at: string }>(
    `INSERT INTO deal_notes (kommo_id, comment, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (kommo_id) DO UPDATE SET comment = EXCLUDED.comment,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING (SELECT email FROM users WHERE id = $3) AS author,
               to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF') AS updated_at`,
    [kommoId, comment, auth.userId]);
  res.json({ ok: true, note: comment, noteAuthor: up.rows[0]?.author ?? null, noteAt: up.rows[0]?.updated_at ?? null });
});

/**
 * Data-quality control (ТЗ §7) — surfaces records that silently distort every
 * other metric: deals with no manager, no amount, an unmapped status, negative
 * amounts that aren't real "minus" deals, and probable duplicates. Admin/lead.
 */
dashboardRouter.get("/data-quality", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Доступ лише для тімліда/адміна" });
  }
  const teamAnd = auth.role === "team_lead" && auth.teamId ? `AND m.team_id = ${auth.teamId}` : "";
  const FC = "d.pipeline_id IN (8921932, 155304)";
  const AVTO = "d.status_id IN (69716300, 98470988, 10937178)";
  const MONEY = `(${AVTO} OR psm.funnel_stage IN ('invoiced','paid'))`;
  const ACTIVE = "psm.funnel_stage <> 'paid'";
  const recent = "d.created_at_kommo >= now() - interval '180 days'";

  const sample = (rows: { kommo_id: string; name: string | null; manager: string | null; extra?: string | null }[]) =>
    rows.map((x) => ({ kommoId: Number(x.kommo_id), name: x.name, manager: x.manager, extra: x.extra ?? null }));

  // 1) Full-cycle deals with no manager assigned.
  const noManager = await pool.query<{ kommo_id: string; name: string; manager: null; extra: string }>(
    `SELECT d.kommo_id, d.name, NULL::text AS manager, to_char(d.created_at_kommo,'YYYY-MM-DD') AS extra
       FROM deals d WHERE ${FC} AND d.manager_id IS NULL AND ${recent}
       ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 2) Money-stage deals with no amount (price ≤ 0), excluding real "minus" deals (поле 2098529).
  const noAmount = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `SELECT d.kommo_id, d.name, m.name AS manager, psm.funnel_stage AS extra
       FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE ${FC} AND ${MONEY} AND ${ACTIVE} AND COALESCE(d.price,0) <= 0
        AND NOT d.is_minus AND ${recent} ${teamAnd}
      ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 3) Full-cycle deals whose (pipeline,status) is not mapped → invisible to funnel analytics.
  const unmapped = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `SELECT d.kommo_id, d.name, m.name AS manager, d.status_id::text AS extra
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
       LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE ${FC} AND psm.funnel_stage IS NULL AND ${recent}
      ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 4) Negative price without the "minus" FIELD (2098529) → likely a data-entry error.
  const negatives = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `SELECT d.kommo_id, d.name, m.name AS manager, d.price::text AS extra
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${FC} AND d.price < 0 AND NOT d.is_minus AND ${recent}
      ORDER BY d.created_at_kommo DESC LIMIT 100`);

  // 5) Probable duplicates — same client with 2+ active full-cycle deals.
  const duplicates = await pool.query<{ kommo_id: string; name: string; manager: string; extra: string }>(
    `WITH dup AS (
        SELECT client_key FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${FC} AND ${ACTIVE} AND d.client_key IS NOT NULL AND ${recent}
        GROUP BY client_key HAVING COUNT(*) >= 2)
     SELECT d.kommo_id, d.name, m.name AS manager, d.client_name AS extra
       FROM deals d JOIN dup ON dup.client_key = d.client_key
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${FC} AND ${ACTIVE} ${teamAnd}
      ORDER BY d.client_key, d.created_at_kommo DESC LIMIT 120`);

  // Нічна авто-звірка (data_check_state) — інваріанти-запобіжники з датою прогону.
  const recon = await pool.query<{ ran_at: string; warnings: number; checks: unknown }>(
    `SELECT ran_at, warnings, checks FROM data_check_state WHERE id = 1`
  );
  res.json({
    checks: [
      { key: "noManager", label: "Угоди без менеджера", count: noManager.rowCount ?? 0, sample: sample(noManager.rows) },
      { key: "noAmount", label: "Угоди без суми (грошові етапи)", count: noAmount.rowCount ?? 0, sample: sample(noAmount.rows) },
      { key: "unmapped", label: "Угоди без статусу (не змаплено)", count: unmapped.rowCount ?? 0, sample: sample(unmapped.rows) },
      { key: "negatives", label: "Відʼємна сума без позначки «мінус»", count: negatives.rowCount ?? 0, sample: sample(negatives.rows) },
      { key: "duplicates", label: "Можливі дублі (клієнт з 2+ активними угодами)", count: duplicates.rowCount ?? 0, sample: sample(duplicates.rows) },
    ],
    reconciliation: recon.rows[0]
      ? { ranAt: recon.rows[0].ran_at, warnings: recon.rows[0].warnings, checks: recon.rows[0].checks }
      : null,
  });
});

/**
 * Lead quality for the КВП report — target vs non-target leads created in the
 * period (Kyiv dates, both ends inclusive):
 *   target      = full-cycle pipeline 8921932 (a real transport deal was opened)
 *   non-target  = Кваліфікація 8921928 closed as lost (status 143) — rejected.
 * Both counts come from our synced `deals` (syncKommo pulls all pipelines).
 */
dashboardRouter.get("/lead-quality", async (req, res) => {
  const auth = req.auth!;
  // Company-wide lead-quality is a КВП/lead metric — managers never see it.
  if (auth.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  const teamId = auth.role === "team_lead" ? auth.teamId ?? null : (req.query.teamId ? Number(req.query.teamId) : null);
  const dateScope = (alias: string, params: unknown[]) => {
    const c: string[] = [];
    if (from) { params.push(from); c.push(`(${alias}.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date >= $${params.length}`); }
    if (to) { params.push(to); c.push(`(${alias}.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date <= $${params.length}`); }
    return c;
  };
  const teamJoin = teamId ? "JOIN managers m ON m.id = d.manager_id" : "";
  const countFor = async (extra: string): Promise<number> => {
    const params: unknown[] = [];
    const conds = [extra, ...dateScope("d", params)];
    if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM deals d ${teamJoin} WHERE ${conds.join(" AND ")}`,
      params
    );
    return Number(r.rows[0]?.n ?? 0);
  };
  const adParams: unknown[] = [];
  const adConds: string[] = [];
  if (from) { adParams.push(from); adConds.push(`day >= $${adParams.length}`); }
  if (to) { adParams.push(to); adConds.push(`day <= $${adParams.length}`); }
  const adWhere = adConds.length ? `WHERE ${adConds.join(" AND ")}` : "";
  // КРОК Г #1: нецільові — КОГОРТА реклама ∩ reject_reason {Дубль|Перевізник} з ядра
  // (metrics.nonTargetLeads), а НЕ стара Кваліфікація-143-усе-підряд (яка змітала й
  // не-рекламні відмови). Загальні/цільові ліди не чіпаємо.
  const { adSources: lqAdSources } = await getSettings();
  /**
   * 🔴 ЦІЛЬОВІ ЛІДИ — ДЕДУП ПО КЛІЄНТУ В МЕЖАХ ПЕРІОДУ (рішення власника 04.08.2026).
   * Один клієнт у місяць = ОДИН цільовий лід. Було `COUNT(*)` по угодах: клієнт,
   * що звернувся тричі, давав три «ліди». Заміряно на проді: 652 зайвих із 2 503
   * у червні (26%) і 624 з 2 929 у липні (21%).
   *
   * Угоди БЕЗ `client_key` рахуються поштучно, а не зливаються в один рядок:
   * `COUNT(DISTINCT client_key)` викинув би їх зовсім (NULL не рахується), і ми
   * втратили б реальні звернення. Тому дві частини й додавання.
   */
  const targetLeadsDedup = async (): Promise<{ deals: number; clients: number }> => {
    const p2: unknown[] = [];
    const c2 = ["d.pipeline_id = 8921932", ...dateScope("d", p2)];
    if (teamId) { p2.push(teamId); c2.push(`m.team_id = $${p2.length}`); }
    const r = await pool.query<{ deals: string; clients: string }>(
      `SELECT COUNT(*)::int AS deals,
              (COUNT(DISTINCT d.client_key)
               + COUNT(*) FILTER (WHERE d.client_key IS NULL))::int AS clients
         FROM deals d ${teamJoin} WHERE ${c2.join(" AND ")}`, p2);
    return { deals: Number(r.rows[0]?.deals ?? 0), clients: Number(r.rows[0]?.clients ?? 0) };
  };
  const [targetLeads, nonTargetLeads, adRes] = await Promise.all([
    targetLeadsDedup(),
    metrics.nonTargetLeads({ from, to, teamId }, lqAdSources),
    pool.query<{ plan: string; fact: string; conv: string }>(
      `SELECT COALESCE(SUM(budget_plan),0) AS plan, COALESCE(SUM(budget_fact),0) AS fact,
              COALESCE(SUM(conversions),0) AS conv
         FROM ad_budget_daily ${adWhere}`,
      adParams
    ),
  ]);
  res.json({
    // Головна цифра — УНІКАЛЬНІ клієнти; сира кількість угод іде поруч, щоб
    // різницю було видно, а не щоб її десь склали.
    targetLeads: targetLeads.clients,
    targetLeadDeals: targetLeads.deals,
    targetLeadsNote: "унікальних клієнтів у періоді (один клієнт = один лід); "
      + `угод у Повному циклі за той самий період: ${targetLeads.deals}`,
    nonTargetLeads,
    adBudgetPlan: Math.round(Number(adRes.rows[0]?.plan ?? 0)),
    adBudgetFact: Math.round(Number(adRes.rows[0]?.fact ?? 0)),
    adBudgetLeads: Number(adRes.rows[0]?.conv ?? 0),
  });
});

/**
 * Plan grid for the plan editor — every active manager (grouped by team) with
 * their monthly payment_amount plan for the chosen month, plus the calendar so
 * the frontend can decompose the plan by week (fixed 7-day blocks) and per
 * working day. Team-lead sees only their team; admin sees all (optional teamId).
 */
dashboardRouter.get("/plans-grid", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Доступ лише для тімліда/адміна" });
  }
  const monthStr = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const planDate = `${monthStr}-01`;
  let teamId: number | null = auth.role === "team_lead" ? auth.teamId ?? null : (req.query.teamId ? Number(req.query.teamId) : null);

  const params: unknown[] = [planDate];
  let teamCond = "";
  if (teamId != null) { params.push(teamId); teamCond = `AND m.team_id = $${params.length}`; }

  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null; plan: string }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name, COALESCE(p.planned_value, 0) AS plan
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN plans p ON p.manager_id = m.id AND p.metric = 'payment_amount' AND p.plan_date = $1
      WHERE m.is_active ${teamCond}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );

  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  // Межі тижнів і робочі дні — ЯДРО (`money.monthWeeks`/`monthWorkingDays`).
  // Тут стояла власна копія `[1, 8, 15, 22, 29]`; поки копії збігались, різниці
  // не було видно, але «тиждень 2» на двох екранах мусить означати ОДНІ дні.
  const workingDays = money.monthWorkingDays(monthStr);
  const weeks = money.monthWeeks(monthStr).map((w) => ({
    label: w.label, from: w.fromDay, to: w.toDay, days: w.toDay - w.fromDay + 1,
  }));

  // Per-manager money for the month (teamId is a validated number → safe to inline):
  //  fact = «Успішно» (142, закрито в місяці) + «Оплата отримана» (снапшот);
  //  carryover = ЯДРО metrics.carryoverByManager (детермінована реконструкція з
  //    deal_stage_events на 00:00 дня-1, зона EXPECT_ZONE) — та сама функція, що Огляд/
  //    Звіт 2.0. Прибрано читання знімок-таблиці monthly_carryover_mgr (легасі, корупція
  //    рестартами). СИРІ ПЛАНИ (row.plan/planned_value) НЕ чіпано.
  //  expected = очікувані кошти = снапшот угод з етапу «Виставлено рахунок» (invoiced).
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const teamAnd = teamId != null ? `AND m.team_id = ${teamId}` : "";
  // 🔴 Крок А: fact = ЯДРО (датований анкер, дедуп, signed price). Прибрано недатований
  // paidOnly-знімок (він додавав поза-періодні оплати в кожен місяць).
  // 🔴 02.08.2026 — ПРАВИЛО ВЛАСНИКА: тут ① `successByMgr` (лише 142 по closed_at), а не
  // ② received. План ставиться людині за РЕЗУЛЬТАТ, а частково оплачена угода
  // переїздить у наступний місяць — зараховувати її зараз означало б рахувати
  // незавершене. expected/carryover — без змін.
  const [recvMgr, exp, carry] = await Promise.all([
    money.successByMgr({ from: planDate, to: monthEnd, teamId }),   // ① результат менеджера
    pool.query<{ id: string; s: string }>(
      `SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE ${EXPECTED_STAGES} ${teamAnd}
        GROUP BY d.manager_id`),
    metrics.carryoverByManager({ teamId }, planDate),
  ]);
  const numMap = (rows: { id: string; s: string }[]) => new Map(rows.map((x) => [Number(x.id), Number(x.s)]));
  const factM = new Map(recvMgr.map((x) => [x.managerId, Math.round(x.revenue)]));
  const expM = numMap(exp.rows);
  const carryM = new Map(carry.map((x) => [x.managerId, x.amount]));

  const teamsMap = new Map<number, { teamId: number; teamName: string; teamPlan: number; teamFact: number; teamCarryover: number; teamExpected: number; managers: { managerId: number; name: string; plan: number; fact: number; carryover: number; expected: number }[] }>();
  let totalPlan = 0, totalFact = 0, totalCarryover = 0, totalExpected = 0;
  for (const row of r.rows) {
    const tid = row.team_id ?? 0;
    if (!teamsMap.has(tid)) teamsMap.set(tid, { teamId: tid, teamName: row.team_name ?? "Без команди", teamPlan: 0, teamFact: 0, teamCarryover: 0, teamExpected: 0, managers: [] });
    const plan = Number(row.plan);
    const fact = factM.get(row.id) ?? 0;
    const carryover = carryM.get(row.id) ?? 0;
    const expected = expM.get(row.id) ?? 0;
    const t = teamsMap.get(tid)!;
    t.managers.push({ managerId: row.id, name: row.name, plan, fact, carryover, expected });
    t.teamPlan += plan; t.teamFact += fact; t.teamCarryover += carryover; t.teamExpected += expected;
    totalPlan += plan; totalFact += fact; totalCarryover += carryover; totalExpected += expected;
  }

  res.json({
    month: monthStr,
    daysInMonth,
    workingDays,
    weeks,
    teams: Array.from(teamsMap.values()),
    totalPlan, totalFact, totalCarryover, totalExpected,
  });
});

/**
 * Repeat-client revenue plan grid. Each month a team lead sets, per manager, a
 * revenue target that must be earned FROM regular (repeat) clients; the fact is
 * auto-filled from CRM (received money whose client has 2+ lifetime paid orders)
 * and the frontend decomposes the remaining target across the month's weeks.
 * Team-lead sees only their team; admin sees all (optional teamId).
 */
/** Сьогодні по-київськи, YYYY-MM-DD. */


/**
 * Чи має роль право бачити цього клієнта. МЕЖА ОДНА для читання і для запису
 * коментарів — інакше «не бачить» і «не може писати» роз'їхались би, і одне з
 * двох тихо стало б ширшим.
 *
 * Основний менеджер клієнта = закріплений (`loyalty_overrides.pinned_manager_id`)
 * або той, у кого найбільше оплачених угод цього клієнта.
 */
async function canSeeClient(auth: NonNullable<typeof import("express")["request"]["auth"]>, clientKey: string): Promise<boolean> {
  if (isAdminScope(auth)) return true;
  const r = await pool.query<{ manager_id: number; team_id: number | null }>(
    `WITH paid AS (
       SELECT d.manager_id, d.closed_at_kommo FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE psm.funnel_stage = 'paid' AND d.client_key = $1
     ), pm AS (
       SELECT manager_id FROM (
         SELECT manager_id, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(closed_at_kommo) DESC) rn
           FROM paid GROUP BY manager_id) z WHERE rn = 1
     )
     SELECT COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id, m.team_id
       FROM pm LEFT JOIN loyalty_overrides lo ON lo.client_key = $1
       JOIN managers m ON m.id = COALESCE(lo.pinned_manager_id, pm.manager_id)`, [clientKey]);
  const row = r.rows[0];
  if (!row) return false;
  if (auth.role === "manager") return row.manager_id === auth.managerId;
  if (auth.role === "team_lead") return row.team_id === auth.teamId;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ФАЗА A · «ПОСТІЙНІ КЛІЄНТИ · ПЛАН МІСЯЦЯ»
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Рядок = клієнт по КАНОНІЧНОМУ `client_key`; постійний = 2+ оплат lifetime.
 *
 * 🔴 ФАКТ РАХУЄ ЯДРО, і саме тому Σ сходиться. `money.successByClientKey` —
 * та сама функція, що дає `successByMgr`: інший лише GROUP BY. Попередній екран
 * (`/repeat-plans-grid`) рахував факт ВЛАСНИМ SQL і додавав НЕДАТОВАНИЙ знімок
 * етапу 9 — тобто (а) метрику ②, якої тут бути не повинно за правилом власника
 * від 02.08.2026, і (б) знімок, що мутує минулі місяці. Через це «факт по
 * клієнтах» і «факт менеджера у Звіті» розходились за побудовою.
 *
 * 🔴 ТИЖНІ — з `money.monthWeeks`, тієї самої функції, що живить Звіт. Копії
 * `[1,8,15,22,29]` більше немає ніде.
 */
dashboardRouter.get("/client-plans", async (req, res) => {
  const auth = req.auth!;
  const monthStr = String(req.query.month ?? "").match(/^\d{4}-\d{2}$/)
    ? String(req.query.month) : kyivToday().slice(0, 7);
  const monthStart = `${monthStr}-01`;
  const daysInMonth = new Date(Number(monthStr.slice(0, 4)), Number(monthStr.slice(5, 7)), 0).getDate();
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const prevMonthStart = (() => {
    const d = new Date(`${monthStart}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 10);
  })();

  // Скоуп: менеджер — лише свої клієнти; тімлід — своя команда; КВП/ОД — усі
  // (з необовʼязковим вибором менеджера). HR сюди не потрапляє — межа вкладки.
  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") managerId = auth.managerId ?? -1;
  else if (auth.role === "team_lead") {
    teamId = auth.teamId ?? -1;
    if (req.query.managerId) {
      const wanted = Number(req.query.managerId);
      const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [wanted]);
      if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
      managerId = wanted; teamId = null;
    }
  } else {
    if (req.query.managerId) managerId = Number(req.query.managerId);
    else if (req.query.teamId) teamId = Number(req.query.teamId);
  }
  const scope: money.MoneyScope = { from: monthStart, to: monthEnd, managerId: managerId ?? undefined, teamId: teamId ?? undefined };

  const weeks = money.monthWeeks(monthStr);

  // ── ПОСТІЙНІ КЛІЄНТИ (2+ оплат lifetime) з основним менеджером.
  // lifetime-факт, ГОРИЗОНТ НЕ ЗАСТОСОВУЄТЬСЯ (правило: горизонт не стосується
  // lifetime-фактів — постійність, лояльність, реактивація).
  // 🔴 ДЖЕНЕРИК-КЛЮЧІ ВИКИДАЄМО. Пісочниця показала «Название не указано» першим
  // рядком: 612 замовлень і 80 878 ₴ за місяць. Це не клієнт, а плейсхолдер Kommo,
  // під яким лежать сотні РІЗНИХ замовників — план на нього поставити неможливо, а
  // в топі він витісняє справжніх. Список спільний зі звіркою (`GENERIC_CLIENT_KEYS`),
  // щоб два екрани не розійшлись у тому, що вважати клієнтом.
  const mgrParams: unknown[] = [metrics.GENERIC_CLIENT_KEYS];
  let mgrCond = "";
  if (managerId != null) { mgrParams.push(managerId); mgrCond = `AND pm.manager_id = $${mgrParams.length}`; }
  else if (teamId != null) { mgrParams.push(teamId); mgrCond = `AND mm.team_id = $${mgrParams.length}`; }

  // 🔴 Сегмент/стан — зі СПІЛЬНОГО джерела (`core/clientSegments.ts`), того самого,
  // що живить реактивацію. Окремим запитом, а не CTE всередині запиту нижче:
  // підстановка фрагмента в цей запит коштувала 20.8 с при вартовому 20.0 с, тобто
  // 503 на екрані (замір 05.08.2026, деталі й таблиця — у шапці `clientSegments.ts`).
  const seg = await loadClientSegments();

  const clientsRes = await pool.query<{
    client_key: string; name: string | null; orders: string; revenue: string;
    first_paid: string | null; last_paid: string | null; manager_id: number;
    manager_name: string; payment_type: string | null; pinned_manager_id: number | null;
    team_id: number | null; team_name: string | null;
  }>(
    // 🔴 ЧОМУ САМЕ ТАК, А НЕ «як зручніше читати». Перша версія брала назву й тип
    // розрахунку через `(array_agg(client_name ORDER BY closed_at DESC))[1]` —
    // тобто СОРТУВАЛА всередині кожної групи по ~19.5 тис. рядках, і ще раз для
    // другого поля, плюс ROW_NUMBER-вікно для основного менеджера. У пісочниці
    // (18 тис. угод) це коштувало 0.1 с і виглядало нормально; на проді (146 тис.)
    // — 21.4 с, тобто ДОВШЕ за 20-секундного вартового в index.ts, і екран КВП
    // віддавав 503. Заміряно, не припущено.
    //
    // Тепер: DISTINCT ON замість вікна, а назва/тип — латералом ЛИШЕ для тих
    // ~1.1 тис. клієнтів, що пройшли відбір. 21.4 с → 0.7 с, рядки ті самі (1133).
    //
    // ⚠️ Урок ширший за цей роут: пісочниця на 18 тис. рядків НЕ доводить нічого
    // про 146 тис. Порядок даних — частина умов задачі, а не деталь.
    `WITH ${LAST_PAID_CTE},
     paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
          AND NOT (d.client_key = ANY($1))
     ),
     agg AS (
       SELECT client_key, COUNT(*)::int AS orders, COALESCE(SUM(price),0) AS revenue,
              MIN(closed_at_kommo) AS first_paid, MAX(closed_at_kommo) AS last_paid
         FROM paid GROUP BY client_key HAVING COUNT(*) >= 2
     ),
     per_cm AS (
       SELECT client_key, manager_id, COUNT(*) AS n, MAX(closed_at_kommo) AS mx
         FROM paid GROUP BY 1, 2
     ),
     primary_mgr AS (
       SELECT DISTINCT ON (client_key) client_key, manager_id
         FROM per_cm ORDER BY client_key, n DESC, mx DESC
     )
     SELECT a.client_key, a.orders, a.revenue, nm.client_name AS name, nm.payment_type,
            to_char(a.first_paid AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS first_paid,
            to_char(a.last_paid  AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS last_paid,
            COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id,
            mm.name AS manager_name, lo.pinned_manager_id,
            mm.team_id, tt.name AS team_name
       FROM agg a
       JOIN primary_mgr pm ON pm.client_key = a.client_key
       -- 🔴 БЕЗ умови AND NOT lo.hidden У ЦЬОМУ JOIN — І ЦЕ НЕ КОСМЕТИКА.
       -- Було: LEFT JOIN … AND NOT lo.hidden, а нижче WHERE COALESCE(lo.hidden,false)=false.
       -- Для ПРИХОВАНОГО клієнта join не давав рядка → lo.hidden = NULL →
       -- COALESCE(NULL,false)=false → умова ІСТИННА, і клієнт лишався на екрані.
       -- Тобто дія «прибрати з постійних» роками писалась у базу й не робила НІЧОГО.
       -- Заміряно на живому сервері: hidden=true, а клієнт у видачі обох екранів.
       LEFT JOIN loyalty_overrides lo ON lo.client_key = a.client_key
       ${LAST_PAID_JOIN}
       JOIN managers mm ON mm.id = COALESCE(lo.pinned_manager_id, pm.manager_id) AND mm.is_active
       LEFT JOIN teams tt ON tt.id = mm.team_id
       LEFT JOIN LATERAL (
         SELECT d2.client_name, d2.payment_type FROM deals d2
           JOIN pipeline_stage_map p2 ON p2.pipeline_id = d2.pipeline_id AND p2.status_id = d2.status_id
                                      AND p2.funnel_stage = 'paid'
          WHERE d2.client_key = a.client_key
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
      -- 🗄 Архів замість hidden — те саме джерело, що в реактивації (гейт #38).
      WHERE NOT ${archivedSql("lo", "ap")} ${mgrCond}
      ORDER BY a.revenue DESC`,
    mgrParams
  );
  const clientKeys = clientsRes.rows.map((c) => c.client_key);
  const keySet = new Set(clientKeys);

  // ── ФАКТ І ТИЖНІ — ЯДРО (①). Один виклик на місяць + один на тиждень.
  const histFrom = (() => { const d = new Date(`${monthStr}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 5); return d.toISOString().slice(0, 7) + "-01"; })();
  // Явний обʼєкт, а не спред scope: ворота #17e2 вимагають, щоб кожен спред був
  // названим у реєстрі — тут дешевше не спредити, ніж пояснювати спред.
  const histScope: money.MoneyScope = {
    from: histFrom, to: monthEnd,
    managerId: managerId ?? undefined, teamId: teamId ?? undefined,
  };

  type PlanDbRow = { client_key: string; plan: string; status: string; manager_id: number | null;
    review_note: string | null; manager_name: string | null };
  /** Плани МІСЯЦЯ у скоупі перегляду — без огляду на те, чи клієнт активний зараз. */
  const planQ = () => {
    const pp: unknown[] = [monthStart];
    let cond = "";
    if (managerId != null) { pp.push(managerId); cond = `AND rp.manager_id = $${pp.length}`; }
    else if (teamId != null) { pp.push(teamId); cond = `AND m.team_id = $${pp.length}`; }
    return pool.query<PlanDbRow>(
      `SELECT rp.client_key, rp.plan, rp.status, rp.manager_id, rp.review_note, m.name AS manager_name
         FROM repeat_client_plans rp
         LEFT JOIN managers m ON m.id = rp.manager_id
        WHERE rp.month = $1 ${cond}`, pp);
  };

  const [monthFact, weekFact, hist, plansRes, commentsRes, prevPlans] = await Promise.all([
    money.successByClientKey(scope),
    money.successByClientWeek(scope),
    money.successByClientBucket(histScope, "month"),
    // 🔴 ПЛАНИ ЧИТАЮТЬСЯ ПО МІСЯЦЮ, А НЕ ПО СПИСКУ АКТИВНИХ (виправлено 21.08.2026).
    //
    // Було: `AND client_key = ANY(clientKeys)`, де `clientKeys` — це ті, хто
    // активний СЬОГОДНІ. Для минулого місяця це означало, що план клієнта, який
    // відтоді заснув, зникав з екрана мовчки. Заміряно на проді за липень: у БД
    // 92 плани / 954 171 ₴, на екрані 27 / 367 901 ₴ — випало 586 270 ₴.
    //
    // ⚠️ СКОУП ПЕРЕЇХАВ РАЗОМ ІЗ ФІЛЬТРОМ, інакше менеджер побачив би чужі плани.
    // Раніше межу тримав `clientKeys` (він уже був у скоупі); тепер її тримає
    // `rp.manager_id` / `m.team_id` — це ТА САМА межа, лише названа явно.
    planQ(),
    clientKeys.length ? pool.query<{ client_key: string; n: string }>(
      `SELECT client_key, COUNT(*) AS n FROM client_comments WHERE client_key = ANY($1) GROUP BY client_key`,
      [clientKeys]) : { rows: [] as { client_key: string; n: string }[] },
    // 💡 ПІДКАЗКА «минулого місяця було N планів на X ₴» — щоб порожній поточний
    // місяць читався як «ще не заповнювали», а не як «дані зникли». Той самий
    // скоуп, той самий вираз, лише інший місяць — копії правила тут немає.
    (() => {
      const pp: unknown[] = [prevMonthStart];
      let cond = "";
      if (managerId != null) { pp.push(managerId); cond = `AND rp.manager_id = $${pp.length}`; }
      else if (teamId != null) { pp.push(teamId); cond = `AND m.team_id = $${pp.length}`; }
      return pool.query<{ n: string; s: string }>(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(rp.plan),0)::numeric AS s
           FROM repeat_client_plans rp
           LEFT JOIN managers m ON m.id = rp.manager_id
          WHERE rp.month = $1 ${cond}`, pp);
    })(),
  ]);
  const factByKey = new Map(monthFact.filter((r) => keySet.has(r.key)).map((r) => [r.key, r.revenue]));
  const weekByKey = new Map<string, number[]>();
  for (const w of weekFact) {
    if (!keySet.has(w.clientKey)) continue;
    const arr = weekByKey.get(w.clientKey) ?? weeks.map(() => 0);
    arr[w.weekIndex] = w.revenue;
    weekByKey.set(w.clientKey, arr);
  }
  const histMonths: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(`${monthStr}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i);
    histMonths.push(d.toISOString().slice(0, 7));
  }
  const histByKey = new Map<string, number[]>();
  for (const h of hist) {
    if (!keySet.has(h.clientKey)) continue;
    const idx = histMonths.indexOf(h.bucket.slice(0, 7));
    if (idx < 0) continue;
    const arr = histByKey.get(h.clientKey) ?? histMonths.map(() => 0);
    arr[idx] += h.revenue;
    histByKey.set(h.clientKey, arr);
  }
  const planByKey = new Map(plansRes.rows.map((p) => [p.client_key, p]));
  const commentsByKey = new Map(commentsRes.rows.map((c) => [c.client_key, Number(c.n)]));

  // ── ПЛАН ТИЖНЯ = місячний план × робочі дні тижня / робочі дні місяця.
  const totalWd = money.monthWorkingDays(monthStr);
  const todayStr = kyivToday();
  const dayOf = (ymd: string | null) =>
    ymd ? Math.round((Date.parse(`${todayStr}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86400000) : null;

  /**
   * 🌉 МІСТОК + РОЗБИВКА АКТИВНИХ — з ТИХ САМИХ рядків, що й список.
   *
   * 🔴 Рахувати їх окремим запитом було б помилкою того самого класу, що й
   * окремий COUNT для лічильника пулу: два добори рано чи пізно розійдуться, і
   * «910 у реактивації» перестане дорівнювати тому, що там справді лежить. Тут
   * добір ОДИН — `clientsRes` (уже в потрібному скоупі), а стан лише розкладає
   * його на три купки.
   *
   * 🔴 ЖОРСТКИЙ ПОДІЛ ЕКРАНІВ (рішення власника 05.08.2026): у плануванні
   * лишаються ТІЛЬКИ активні; сплячі й втрачені живуть у реактивації. Тому їхня
   * кількість МУСИТЬ бути названа тут — інакше вони зникли б мовчки, а це
   * читається як «клієнти загубились» (гейт #30n).
   *
   * 🔴 МІСТОК РАХУЄ ТИМ САМИМ ДОБОРОМ, ЩО Й ВКЛАДКА (виправлено 05.08.2026).
   * Було: місток обіцяв **631**, а вкладка показувала **456**. Обидві цифри
   * «правильні» — місток рахував ДО фільтра телефонних дженериків, список після, —
   * але поруч вони читаються як поломка. Тепер `keepInReactivation` стоїть в обох
   * місцях, тож місток дорівнює тому, що в реактивації справді лежить (гейт #30p).
   *
   * ⚠️ ФІЛЬТР ДЖЕНЕРИКІВ АСИМЕТРИЧНИЙ, і це не помилка: рішення власника звучало
   * «геть із РЕАКТИВАЦІЇ», а не «геть звідусіль». Активний клієнт із ключем-телефоном
   * лишається в плануванні. Тому ті, кого фільтр прибрав зі сплячих/втрачених, не
   * зникають у тиші — вони окремим числом `skippedGeneric`, інакше ми повторили б
   * рівно ту помилку, яку цією правкою й лікуємо.
   */
  const bridge = { sleeping: 0, lost: 0, longLapsed: 0, oneOff: 0, skippedGeneric: 0,
    bySegment: { vip: 0, regular: 0, episodic: 0, unknown: 0 } as Record<string, number> };
  const activeRows = clientsRes.rows.filter((c) => {
    const f = factsFor(seg, c.client_key);
    // 🎯 РАЗОВІ — НЕ постійні (двошляхова кваліфікація, рішення власника 05.08.2026).
    // Їх немає ні тут, ні в реактивації; але вони НАЗВАНІ числом, бо інакше 1 137 → 795
    // читалось би як «третина клієнтів кудись поділась».
    if (!f.qualified) { bridge.oneOff++; return false; }
    if (f.state === "sleeping" || f.state === "lost") {
      if (!keepInReactivation(f)) { bridge.skippedGeneric++; return false; }
      if (f.longLapsed) bridge.longLapsed++;   // підмножина втрачених, не окрема купка
      if (f.state === "sleeping") bridge.sleeping++; else bridge.lost++;
      return false;
    }
    bridge.bySegment[f.segment] = (bridge.bySegment[f.segment] ?? 0) + 1;
    return true;
  });

  /**
   * 🧩 РОСТЕР = АКТИВНІ ∪ ТІ, ХТО МАЄ ПЛАН НА ЦЕЙ МІСЯЦЬ.
   *
   * 🔴 ЛІЧИЛЬНИКИ ЛИШАЮТЬСЯ НА `activeRows`, І ЦЕ ГОЛОВНА МЕЖА ЦІЄЇ ПРАВКИ.
   * `bridge` (сплячі/втрачені/разові/skippedGeneric/bySegment) і `totalClients`
   * відповідають на питання «кому МОЖНА ставити новий план» — воно не змінилось
   * ані на клієнта. Ростер відповідає на інше: «чиї плани цього місяця треба
   * показати». Змішати їх означало б, що «Активних клієнтів» тихо поповзе вгору
   * від того, що ми глянули в минулий місяць. Тримає `#109`.
   *
   * Дедуп — за побудовою (`rosterWithPlans` фільтрує другий список по ключах
   * першого), а не за домовленістю. `#108`.
   */
  const { rows: rosterRows, planOnlyKeys } = rosterWithPlans(
    activeRows, clientsRes.rows, (c) => c.client_key, (k) => planByKey.has(k));

  /** Стан клієнта словом — для ВИДИМОЇ позначки в рядку (`#110`). */
  const stateOf = (key: string): "active" | "sleeping" | "lost" | "oneoff" => {
    if (!planOnlyKeys.has(key)) return "active";
    const f = factsFor(seg, key);
    if (!f.qualified) return "oneoff";
    return f.state === "sleeping" || f.state === "lost" ? f.state : "sleeping";
  };

  const lastComment = await latestCommentByClient();
  const clients = rosterRows.map((c) => {
    const p = planByKey.get(c.client_key);
    const plan = p ? Number(p.plan) : 0;
    const fact = factByKey.get(c.client_key) ?? 0;
    const wf = weekByKey.get(c.client_key) ?? weeks.map(() => 0);
    return {
      clientKey: c.client_key,
      clientName: c.name ?? c.client_key,
      paymentType: c.payment_type ?? null,
      segment: factsFor(seg, c.client_key).segment,
      /**
       * 🔵 СТАН — ВИДИМИЙ, а не виведений читачем із того, що рядок «якийсь не
       * такий». Клієнт із планом, який відтоді заснув, тепер на екрані Є; без
       * позначки він читався б як активний, тобто екран мовчки стверджував би
       * неправду про людину, якій цей план виконувати. `planOnly` каже, ЧОМУ він
       * тут: не «його можна планувати», а «за ним лишився план». Тримає `#110`.
       */
      state: stateOf(c.client_key),
      planOnly: planOnlyKeys.has(c.client_key),
      // ⭐ Позначка «включений вручну» + примітка. Без примітки поруч позначка
      // через місяць нічим не відрізняється від помилки — тому обидва поля, а
      // не лише прапорець.
      forcedRegular: factsFor(seg, c.client_key).forcedRegular,
      forceNote: factsFor(seg, c.client_key).forceNote,
      // 💬 Останній коментар — щоб причину «чому не замовляє» було видно з рядка,
      // а не лише тому, хто розгорнув картку.
      lastComment: lastComment.get(c.client_key) ?? null,
      orders: Number(c.orders),
      lifetimeRevenue: Number(c.revenue),
      since: c.first_paid ? c.first_paid.slice(0, 7) : null,   // YYYY-MM
      lastOrderDays: dayOf(c.last_paid),
      history: histByKey.get(c.client_key) ?? histMonths.map(() => 0),
      plan,
      planStatus: p?.status ?? "none",
      reviewNote: p?.review_note ?? null,
      weeks: weeks.map((w, i) => ({
        label: w.label, from: w.from, to: w.to, status: w.status,
        plan: totalWd > 0 ? Math.round(plan * (w.workingDays / totalWd)) : 0,
        fact: Math.round(wf[i] ?? 0),
      })),
      fact: Math.round(fact),
      pct: plan > 0 ? Math.round((fact / plan) * 100) : null,
      managerId: c.manager_id,
      managerName: c.manager_name,
      // Команда — щоб адмінський зріз можна було згорнути в ієрархію
      // «команда → менеджер → клієнти». Це ПОДАЧА, не скоуп: сам добір рядків
      // не змінився ані на клієнта (доведено гейтом #29b).
      teamId: c.team_id,
      teamName: c.team_name ?? "Без команди",
      pinned: c.pinned_manager_id != null,
      comments: commentsByKey.get(c.client_key) ?? 0,
      // 🔴 Дзвінків тут НЕМАЄ і бути поки не може: Ringostat-синк зберігає лише
      // АГРЕГАТ по тімлідах у statistics_values, окремих дзвінків із номером
      // абонента ми не зберігаємо взагалі. Порожній масив із названою причиною —
      // чесніше за приховану колонку: видно, що місце є, а даних немає.
      calls: [] as never[],
    };
  });

  /**
   * 🕳 ПЛАНИ, ЩО НЕ ЛЯГЛИ НА ЖОДЕН РЯДОК. Сьогодні це рівно один випадок —
   * дженерик-ключ «названиенеуказано» (за липень 40 000 ₴, статус `pending`).
   * Відфільтрувати його означало б повторити ту саму помилку, яку ця правка
   * лікує, лише з іншої причини: гроші зникають, і жодне число не сперечається.
   *
   * 🔒 ВИДИМИЙ ЛИШЕ `isAdminScope` (рішення власника 21.08.2026) — і в Σ він
   * входить РІВНО тоді, коли видимий. Підсумок, якого не пояснює жоден видимий
   * рядок, — це та сама «невидима втрата», лише в інший бік (урок `#59`).
   */
  const rosterKeySet = new Set(clientsRes.rows.map((c) => c.client_key));
  const unattachedRows = splitUnattached(plansRes.rows, (p) => p.client_key, rosterKeySet);
  const canSeeUnattached = isAdminScope(auth);
  const unattachedSum = unattachedRows.reduce((s2, p) => s2 + Number(p.plan), 0);
  const unattachedApproved = unattachedRows
    .filter((p) => p.status === "approved").reduce((s2, p) => s2 + Number(p.plan), 0);

  // Арифметика статусів — у `clientPlanRules`, той самий модуль, що бере гейт.
  const t0 = planTotals(clients);
  const planTotal = t0.planTotal + (canSeeUnattached ? unattachedSum : 0);
  const planApproved = t0.planApproved + (canSeeUnattached ? unattachedApproved : 0);
  const byStatus = t0.byStatus;
  const factTotal = clients.reduce((s2, c) => s2 + c.fact, 0);
  const curIdx = weeks.findIndex((w) => w.status === "current");
  // 🔴 «Без замовлень > 30 дн.» — ПРО ЖИВИХ. Плитка існує, щоб ловити активного
  // клієнта, який почав мовчати; сплячі й втрачені там не новина, вони туди
  // потрапили б усі й одразу, перетворивши сигнал на шум. Тому `activeKeys`, а
  // не весь ростер: ростер виріс, питання плитки — ні.
  const atRisk = clients.filter((c) => !c.planOnly && c.lastOrderDays != null && c.lastOrderDays > 30);

  res.json({
    month: monthStr,
    historyMonths: histMonths,
    weeks: weeks.map((w) => ({ label: w.label, from: w.from, to: w.to, status: w.status, workingDays: w.workingDays })),
    clients,
    totals: {
      planTotal, factTotal,
      pct: planTotal > 0 ? Math.round((factTotal / planTotal) * 100) : null,
      filledClients: clients.filter((c) => c.plan > 0).length
        + (canSeeUnattached ? unattachedRows.filter((p) => Number(p.plan) > 0).length : 0),
      /**
       * 🔴 «АКТИВНІ КЛІЄНТИ» — ВІД `activeRows`, А НЕ ВІД РОСТЕРА. Ростер тепер
       * ширший (у ньому є сплячі з планом), і взяти його довжину означало б, що
       * головна цифра екрана мовчки виросте від погляду в минулий місяць. Це
       * питання «кому можна ставити новий план», і воно не змінилось. `#109`.
       */
      totalClients: activeRows.length,
      /** Скільки рядків ростера тут ЛИШЕ через план — щоб різницю було видно числом. */
      planOnlyClients: planOnlyKeys.size,
      /**
       * 🌉 МІСТОК ДО РЕАКТИВАЦІЇ. Сплячі й втрачені з екрана ЗНИКЛИ (жорсткий
       * поділ), і без цієї цифри вони зникли б МОВЧКИ — виглядало б як «клієнти
       * загубились». Місток лише показує, скільки їх і куди піти; у Σ «постійні
       * принесуть» він НЕ входить, бо це не план.
       */
      inReactivation: bridge.sleeping + bridge.lost,
      inReactivationSleeping: bridge.sleeping,
      inReactivationLost: bridge.lost,
      /**
       * 🗄 Архів — ПІДМНОЖИНА втрачених (>365 дн.), а не четверта купка. У Σ його
       * не додають: `активні + сплячі + втрачені = кваліфікована база`, інакше
       * втрачені порахувались би двічі.
       */
      longLapsedCount: bridge.longLapsed,
      /**
       * 🎯 РАЗОВІ — не проходять двошляхову кваліфікацію. Ні тут, ні в реактивації.
       * Названі числом навмисно: без нього перехід 1 137 → 795 читався б як втрата
       * даних, а не як зміна правила (гейт #30n).
       */
      oneOff: bridge.oneOff,
      /**
       * 📵 Сплячі/втрачені з ключем-телефоном і БЕЗ безготівкових оплат: фільтр
       * реактивації їх прибирає (рішення власника), у плануванні їх теж немає —
       * тож без цього числа вони зникли б мовчки.
       */
      skippedGeneric: bridge.skippedGeneric,
      /** Розбивка ЖИВИХ по сегментах — та, що стоїть над таблицею. */
      activeBySegment: bridge.bySegment,
      currentWeekIndex: curIdx < 0 ? null : curIdx,
      currentWeekFact: curIdx < 0 ? null : clients.reduce((s2, c) => s2 + c.weeks[curIdx].fact, 0),
      currentWeekPlan: curIdx < 0 ? null : clients.reduce((s2, c) => s2 + c.weeks[curIdx].plan, 0),
      atRiskCount: atRisk.length,
      atRiskNames: atRisk.slice(0, 3).map((c) => c.clientName),
      planApproved, byStatus,
      /**
       * Σ ЗАТВЕРДЖЕНИХ по клієнтах = рядок «Затверджено планів по клієнтах» у
       * «Формуванні плану» (`/plans/formation`). Це не окрема цифра, а ТА САМА.
       *
       * 🔴 РАНІШЕ ТУТ СТОЯЛО «гейт вимагає точного збігу» — І ГЕЙТА НЕ БУЛО.
       * Єдині гейти (`core/clientPlans.test.ts`) перевіряють `planTotals()` як
       * чисту функцію на рядках, які тест сам собі й підклав; `plans.ts` вони не
       * бачать взагалі. Саме тому розбіжність у **290 570 ₴** за липень (196 000
       * тут проти 486 570 там) прожила непоміченою: обидва екрани були «зелені»
       * поодинці, а порівняти їх було нічим.
       *
       * Коментар, що стверджує інваріанту, якої ніхто не тримає, гірший за
       * відсутність коментаря — на нього покладаються. Тепер збіг перевіряє
       * СПРАВЖНІЙ гейт `#107c`, який ходить в обидва роути й віднімає.
       */
      goesToManagerPlan: planApproved,
      /**
       * 🕳 РЯДОК «НЕ ПРИВʼЯЗАНО» — плани, під якими немає клієнтського рядка.
       * `canSee` віддає СЕРВЕР (той самий `isAdminScope`, що гейтить показ), а не
       * вгадує фронт: право на екран і право в коді мають бути одним рішенням.
       */
      unattached: {
        canSee: canSeeUnattached,
        count: canSeeUnattached ? unattachedRows.length : 0,
        sum: canSeeUnattached ? unattachedSum : 0,
        rows: canSeeUnattached
          ? unattachedRows.map((p) => ({ clientKey: p.client_key, plan: Number(p.plan),
              status: p.status, managerId: p.manager_id, managerName: p.manager_name }))
          : [],
      },
      /** 💡 «минулого місяця було N планів на X ₴» — контекст для порожнього місяця. */
      prevMonth: {
        month: prevMonthStart.slice(0, 7),
        count: Number(prevPlans.rows[0]?.n ?? 0),
        sum: Number(prevPlans.rows[0]?.s ?? 0),
      },
      canSubmit: byStatus.draft > 0,
      canApprove: byStatus.pending > 0,
    },
    // 🔴 ТЕКСТ ВИПРАВЛЕНО 04.08.2026: попередній казав, що «окремих дзвінків із
    // номером абонента в базі НЕМАЄ». Це перестало бути правдою — `syncCalls`
    // пише саме окремі дзвінки в `ringostat_calls` разом із `client_key`, і
    // сусідній екран реактивації вже показує з них «останній дзвінок». Лишити
    // старе формулювання означало б, що екран стверджує неправду про власну
    // базу — гірше за порожню панель. Сама панель тут поки не побудована, і про
    // це сказано прямо.
    callsUnavailable: "Окремі дзвінки в базі Є (ringostat_calls, звʼязка по client_key) — "
      + "їх уже видно як «останній дзвінок» у «Реактивації». Перелік дзвінків у цій "
      + "картці ще не побудований",
  });
});

// ── ЦИКЛ ЗАТВЕРДЖЕННЯ ПЛАНУ ПО КЛІЄНТУ (рішення власника 03.08.2026)
// ЧЕРНЕТКА → ПОДАНО → ЗАТВЕРДЖЕНО. Той самий цикл, що в місячного плану
// менеджера, і те саме правило: у «постійні принесуть» іде Σ лише
// ЗАТВЕРДЖЕНИХ. Незатверджений план для системи не існує.

/** Менеджер зберігає план по СВОЄМУ клієнту. Затверджений — уже не редагує. */
dashboardRouter.post("/client-plan", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const monthStr = String(req.body?.month ?? "").match(/^\d{4}-\d{2}$/) ? String(req.body.month) : kyivToday().slice(0, 7);
  const month = `${monthStr}-01`;
  const plan = Number(req.body?.plan);
  if (!Number.isFinite(plan) || plan < 0) return res.status(400).json({ error: "plan має бути невідʼємним числом" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });
  // 🔑 План на дженерик-ключ — відмова З ПОЯСНЕННЯМ (`#111`). Дірка не теоретична:
  // за липень такий план у базі вже лежить (40 000 ₴). Перевірка стоїть ПІСЛЯ
  // гейта доступу, щоб 403 лишався 403 — інакше 400 підмінив би відмову доступу
  // і зліпок `#11` перестав би означати те, що означає.
  if (!isPlannableClientKey(clientKey, metrics.GENERIC_CLIENT_KEYS)) {
    return res.status(400).json({ error: NOT_PLANNABLE_MSG });
  }

  const cur = await pool.query<{ status: string }>(
    `SELECT status FROM repeat_client_plans WHERE client_key = $1 AND month = $2`, [clientKey, month]);
  const isLead = isAdminOrLead(auth);
  // 🔴 Після затвердження менеджер план НЕ редагує — зміна лише через тімліда
  // (повернути → виправити → подати знову). Інакше «затверджено» нічого не
  // означало б: цифру можна було б переписати після погодження.
  if (!isLead && cur.rows[0]?.status === "approved") {
    return res.status(409).json({ error: "План затверджено — зміна лише через тімліда (повернути на доопрацювання)" });
  }
  const status = isLead ? "approved" : "draft";
  const mgr = await pool.query<{ manager_id: number }>(
    `SELECT manager_id FROM repeat_client_plans WHERE client_key = $1 AND month = $2`, [clientKey, month]);
  const managerId = mgr.rows[0]?.manager_id ?? (auth.role === "manager" ? auth.managerId ?? null : null);

  await pool.query(
    `INSERT INTO repeat_client_plans (client_key, month, manager_id, plan, status, updated_by, updated_at,
                                      approved_by, approved_at, submitted_at, returned_at, review_note)
     VALUES ($1,$2,$3,$4,$5,$6, now(), CASE WHEN $5='approved' THEN $6 END,
             CASE WHEN $5='approved' THEN now() END, NULL, NULL, NULL)
     ON CONFLICT (client_key, month) DO UPDATE SET
       plan = EXCLUDED.plan, status = EXCLUDED.status, manager_id = COALESCE(repeat_client_plans.manager_id, EXCLUDED.manager_id),
       updated_by = EXCLUDED.updated_by, updated_at = now(),
       approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
       submitted_at = NULL, returned_at = NULL, review_note = NULL`,
    [clientKey, month, managerId, plan, status, auth.userId]);
  await pool.query(
    `INSERT INTO repeat_client_plan_history (client_key, month, changed_by, action, plan, status)
     VALUES ($1,$2,$3,'save',$4,$5)`, [clientKey, month, auth.userId, plan, status]);
  res.json({ ok: true, status });
});

/** Менеджер подає ПАКЕТОМ усі свої чернетки за місяць — одна кнопка, не по одному. */
dashboardRouter.post("/client-plans/submit", async (req, res) => {
  const auth = req.auth!;
  if (auth.role !== "manager" && !isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const monthStr = String(req.body?.month ?? "").match(/^\d{4}-\d{2}$/) ? String(req.body.month) : kyivToday().slice(0, 7);
  const managerId = auth.role === "manager" ? auth.managerId ?? -1 : Number(req.body?.managerId ?? -1);
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const r = await pool.query(SUBMIT_SQL, [`${monthStr}-01`, managerId, auth.userId]);
  res.json({ ok: true, submitted: r.rowCount ?? 0 });
});

/** Тімлід/адмін затверджує ВСІ подані за місяць у своїй зоні — одною кнопкою. */
dashboardRouter.post("/client-plans/approve-all", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const monthStr = String(req.body?.month ?? "").match(/^\d{4}-\d{2}$/) ? String(req.body.month) : kyivToday().slice(0, 7);
  const p: unknown[] = [`${monthStr}-01`, auth.userId];
  let scopeCond = "";
  if (auth.role === "team_lead") { p.push(auth.teamId); scopeCond = `AND m.team_id = $${p.length}`; }
  else if (req.body?.managerId) { p.push(Number(req.body.managerId)); scopeCond = `AND m.id = $${p.length}`; }
  const r = await pool.query(approveAllSql(scopeCond), p);
  res.json({ ok: true, approved: r.rowCount ?? 0 });
});

/** Тімлід повертає план на доопрацювання з коментарем — назад у чернетку. */
dashboardRouter.post("/client-plan/return", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const note = String(req.body?.note ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!note) return res.status(400).json({ error: "Повернення без коментаря не приймається" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });
  const monthStr = String(req.body?.month ?? "").match(/^\d{4}-\d{2}$/) ? String(req.body.month) : kyivToday().slice(0, 7);
  const r = await pool.query(RETURN_SQL, [clientKey, `${monthStr}-01`, note.slice(0, 1000), auth.userId]);
  if (!r.rowCount) return res.status(409).json({ error: "Немає що повертати — план уже в чернетці" });
  res.json({ ok: true });
});

/** Коментарі по клієнту — стрічка з автором і датою (макет 1, розгорнутий рядок). */
/**
 * 💬 ОСТАННІЙ КОМЕНТАР ПО КОЖНОМУ КЛІЄНТУ — для показу ПРЯМО В РЯДКУ списку.
 *
 * 🔴 ПРИВІД (рішення власника 05.08.2026). Епізодичний клієнт мовчить 55 днів і
 * формально ще «активний» (поріг 60) — менеджеру НЕМА ДЕ записати, чому. Поки
 * причина живе лише в картці, її не пише ніхто: заради одного речення ніхто не
 * розгортає рядок.
 *
 * 🔴 ТЕ САМЕ ПОЛЕ, ЩО В КАРТЦІ — `client_comments`. Другої таблиці «коментар
 * списку» не заводимо: два поля з однаковою назвою розійдуться за місяць, і
 * ніхто не знатиме, яке з них бачить клієнт. Тут лише ОСТАННІЙ запис; уся
 * стрічка лишається в картці.
 *
 * ⚠️ `DISTINCT ON` замість корельованого підзапиту: останній коментар потрібен
 * для СОТЕНЬ рядків одразу, і підзапит на кожен рядок — це рівно та помилка,
 * що коштувала `/overview` 9.5 с (див. `core/metrics.hasPriorPaidSql`).
 */
async function latestCommentByClient(): Promise<Map<string, { body: string; author: string | null; createdAt: string }>> {
  const r = await pool.query<{ client_key: string; body: string; author: string | null; created_at: string }>(
    `SELECT DISTINCT ON (c.client_key) c.client_key, c.body,
            COALESCE(u.full_name, u.email) AS author,
            to_char(c.created_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS created_at
       FROM client_comments c LEFT JOIN users u ON u.id = c.author_id
      ORDER BY c.client_key, c.created_at DESC`);
  return new Map(r.rows.map((x) => [x.client_key, { body: x.body, author: x.author, createdAt: x.created_at }]));
}

dashboardRouter.get("/client-comments", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });
  const r = await pool.query<{ id: number; body: string; created_at: string; author: string | null }>(
    `SELECT c.id, c.body, c.created_at, COALESCE(u.full_name, u.email) AS author
       FROM client_comments c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.client_key = $1 ORDER BY c.created_at DESC LIMIT 50`, [clientKey]);
  // Явний список полів — рядок БД назовні спредом не їде.
  res.json(r.rows.map((x) => ({ id: x.id, body: x.body, createdAt: x.created_at, author: x.author })));
});

dashboardRouter.post("/client-comments", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  if (!clientKey || !body) return res.status(400).json({ error: "clientKey і body обовʼязкові" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });
  const r = await pool.query<{ id: number; created_at: string }>(
    `INSERT INTO client_comments (client_key, author_id, body) VALUES ($1,$2,$3) RETURNING id, created_at`,
    [clientKey, auth.userId, body.slice(0, 2000)]);
  res.json({ id: r.rows[0].id, createdAt: r.rows[0].created_at });
});

// ─────────────────────────── ПОШУК КЛІЄНТА ───────────────────────────
/**
 * 🔎 ЖИВИЙ ПОШУК КЛІЄНТА — для форм, де ключ доводилось знати напамʼять
 * (обʼєднання, передача відповідального).
 *
 * 🔴 НАВІЩО. Форма «Обʼєднати клієнтів» мала два поля вільного тексту, а
 * канонічний ключ — це `вкавтострада`, а не «ТОВ ВК Автострада»: дізнатись його
 * було НІЗВІДКИ. Тому пошук віддає ЛЮДСЬКУ назву + менеджера + останню оплату, а
 * ключ лишається технічним значенням, яке підставляє UI.
 *
 * 🔴 ЧОМУ НЕ «постійні» (2+ оплат). Обʼєднують якраз хвости: телефон з ОДНІЄЮ
 * оплатою, що насправді та сама фірма. Обмеж пошук постійними — і половина роботи
 * стане неможливою. Тому поріг тут `>= 1` оплата, і це свідома різниця з екраном
 * планів.
 *
 * 🔴 ДОСТУП — ДВА РІЗНІ ЗАПИТАННЯ, І ЦЕ РІШЕННЯ ВЛАСНИКА (04.08.2026):
 *   ЩО МОЖНА РОБИТИ — обʼєднання й передача лишаються за правом `merge_clients`;
 *   КОГО МОЖНА ЗНАЙТИ — тімлід шукає, але ЛИШЕ у своїй команді.
 * Тому пошук більше не висить на `requirePerm`, а клампиться тут: право дає
 * повний доступ, тімліду дописується `mm.team_id = <його команда>`.
 *
 * ⚠️ КЛАМП НА СЕРВЕРІ, А НЕ ФІЛЬТР НА ФРОНТІ. Фільтр у браузері — це не межа:
 * той самий запит curl-ом віддав би чужу команду. Доводиться тестом `#30f`
 * (тімлід не бачить чужого клієнта) з дзеркалом `#30g` (адмін його бачить —
 * інакше «не бачить» зеленіло б і тоді, коли пошук зламаний для всіх).
 *
 * Менеджер сюди НЕ входить: вкладку `loyalty` він має, тож tab-гейт його
 * пропускає — відмова мусить бути явною й названою в матриці.
 */
dashboardRouter.get("/client-search", async (req, res) => {
  const auth = req.auth!;
  const canAll = roleHasPerm(auth.roleKey, "merge_clients");
  const isLead = auth.role === "team_lead";
  if (!canAll && !isLead) return res.status(403).json({ error: "Forbidden" });
  const teamClamp = !canAll && isLead ? (auth.teamId ?? -1) : null;
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json([]);
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
  // Ключ нормалізований (без пробілів, нижній регістр) — шукаємо і по ньому, і по
  // сирій назві: людина пише «Автострада», у ключі лежить «вкавтострада».
  const keyLike = `%${q.toLowerCase().replace(/[\s'’"«»]/g, "")}%`;
  const nameLike = `%${q}%`;
  const r = await pool.query<{
    client_key: string; client_name: string | null; orders: string; revenue: string;
    last_paid: string | null; manager_name: string | null; manager_active: boolean | null;
    pinned_manager_id: number | null;
  }>(
    // Двокроково: спершу ВІДБІР ключів (індекс по client_key + скан назви), і лише
    // потім агрегація по знайдених. Агрегувати спершу все, а фільтрувати потім —
    // це той самий клас, що коштував екрану КВП 21 секунди (див. /client-plans).
    `WITH hit AS (
       SELECT DISTINCT d.client_key
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
          AND NOT (d.client_key = ANY($1))
          AND (d.client_key LIKE $2 OR d.client_name ILIKE $3)
        LIMIT 300
     ),
     paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
         JOIN hit h ON h.client_key = d.client_key
        WHERE psm.funnel_stage = 'paid'
     ),
     agg AS (
       SELECT client_key, COUNT(*)::int AS orders, COALESCE(SUM(price),0) AS revenue,
              MAX(closed_at_kommo) AS last_paid
         FROM paid GROUP BY 1
     ),
     per_cm AS (SELECT client_key, manager_id, COUNT(*) AS n, MAX(closed_at_kommo) AS mx FROM paid GROUP BY 1,2),
     pm AS (SELECT DISTINCT ON (client_key) client_key, manager_id FROM per_cm ORDER BY client_key, n DESC, mx DESC)
     SELECT a.client_key, nm.client_name, a.orders, a.revenue,
            to_char(a.last_paid AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS last_paid,
            mm.name AS manager_name, mm.is_active AS manager_active, lo.pinned_manager_id
       FROM agg a
       JOIN pm ON pm.client_key = a.client_key
       -- Архівність НЕ впливає на «хто відповідальний»: закріплення лишається,
       -- навіть коли клієнта прибрали з екранів (інакше пошук показав би не того).
       LEFT JOIN loyalty_overrides lo ON lo.client_key = a.client_key
       LEFT JOIN managers mm ON mm.id = COALESCE(lo.pinned_manager_id, pm.manager_id)
       LEFT JOIN LATERAL (
         SELECT d2.client_name FROM deals d2
          WHERE d2.client_key = a.client_key AND d2.client_name IS NOT NULL
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
      ${teamClamp != null ? "WHERE mm.team_id = $4" : ""}
      ORDER BY a.revenue DESC
      LIMIT ${limit}`,
    teamClamp != null
      ? [metrics.GENERIC_CLIENT_KEYS, keyLike, nameLike, teamClamp]
      : [metrics.GENERIC_CLIENT_KEYS, keyLike, nameLike]);
  // Явний перелік полів — рядок БД спредом назовні не їде.
  res.json(r.rows.map((x) => ({
    clientKey: x.client_key,
    clientName: x.client_name ?? x.client_key,
    orders: Number(x.orders),
    lifetimeRevenue: Math.round(Number(x.revenue)),
    lastPaid: x.last_paid,
    // Менеджер — ТА САМА формула, що в передачі відповідального й на екрані планів:
    // COALESCE(закріплений, основний за оплатами). Інакше два екрани показували б
    // різних людей на тому самому клієнті.
    managerName: x.manager_name,
    managerActive: x.manager_active ?? false,
    pinned: x.pinned_manager_id != null,
  })));
});

// ─────────────────────────── КАРТКА КЛІЄНТА ───────────────────────────
/**
 * 💳 КАРТКА КЛІЄНТА — «як він платив»: 12 місяців ① + останні угоди.
 *
 * 🔴 ГІСТОГРАМУ РАХУЄ ЯДРО (`money.successByClientBucket` з ключем клієнта) —
 * та сама функція, що дає `successByMgr`, лише інший GROUP BY. Свій SQL по
 * виручці тут розійшовся б із «фактом» на тому самому екрані через місяці.
 * Клієнт — КАНОНІЧНИЙ ключ, тож злиті телефони й назви рахуються разом.
 *
 * ⚠️ ДВА РІЗНІ ЯКОРІ, І ЦЕ ПІДПИСАНО В UI: стовпчики — гроші ① (анкер = дата
 * входу в «успішно реалізовано»); список угод — журнал сутностей (дата закриття,
 * а для незакритих — створення). Тому Σ стовпчиків НЕ дорівнює Σ списку, і
 * зводити їх не треба: перше — метрика, друге — перелік.
 */
dashboardRouter.get("/client-card", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });

  const MONTHS = 12;
  const today = kyivToday();
  const firstOfThis = `${today.slice(0, 7)}-01`;
  const from = (() => {
    const d = new Date(`${firstOfThis}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - (MONTHS - 1));
    return d.toISOString().slice(0, 10);
  })();
  const to = monthEndOf(today.slice(0, 7));

  const [buckets, head, dealsRes] = await Promise.all([
    money.successByClientBucket({ from, to }, "month", clientKey),
    pool.query<{ client_name: string | null; orders: string; revenue: string; first_paid: string | null;
      last_paid: string | null; payment_type: string | null; manager_name: string | null;
      team_name: string | null; pinned_manager_id: number | null;
      archived_at: string | null; archive_reason: string | null;
      force_regular: boolean | null; force_note: string | null }>(
      `WITH paid AS (
         SELECT d.manager_id, d.price, d.closed_at_kommo
           FROM deals d
           JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
          WHERE psm.funnel_stage = 'paid' AND d.client_key = $1
       ),
       agg AS (
         SELECT COUNT(*)::int AS orders, COALESCE(SUM(price),0) AS revenue,
                MIN(closed_at_kommo) AS first_paid, MAX(closed_at_kommo) AS last_paid FROM paid
       ),
       pm AS (
         SELECT manager_id FROM (
           SELECT manager_id, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(closed_at_kommo) DESC) rn
             FROM paid GROUP BY manager_id) z WHERE rn = 1
       )
       SELECT nm.client_name, nm.payment_type, a.orders, a.revenue,
              to_char(a.first_paid AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS first_paid,
              to_char(a.last_paid  AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS last_paid,
              mm.name AS manager_name, t.name AS team_name, lo.pinned_manager_id,
              -- 🔴 СТАН АРХІВУ — ОКРЕМИМ ПІДЗАПИТОМ. Історично join по lo був
              -- звужений умовою на прибраність, тож саме для прибраного клієнта
              -- він порожній, і стан читався б як «не в архіві»: кнопка
              -- «повернути» не зʼявилась би НІКОЛИ, а виглядало б це як
              -- «дія не спрацювала». Підзапит від звуження join не залежить.
              (SELECT o2.archived_at FROM loyalty_overrides o2 WHERE o2.client_key = $1) AS archived_at,
              (SELECT o2.archive_reason FROM loyalty_overrides o2 WHERE o2.client_key = $1) AS archive_reason,
              (SELECT o2.force_regular FROM loyalty_overrides o2 WHERE o2.client_key = $1) AS force_regular,
              (SELECT o2.note FROM loyalty_overrides o2 WHERE o2.client_key = $1) AS force_note
         FROM agg a
         LEFT JOIN pm ON true
         LEFT JOIN loyalty_overrides lo ON lo.client_key = $1
         LEFT JOIN managers mm ON mm.id = COALESCE(lo.pinned_manager_id, pm.manager_id)
         LEFT JOIN teams t ON t.id = mm.team_id
         LEFT JOIN LATERAL (
           SELECT d2.client_name, d2.payment_type FROM deals d2
            WHERE d2.client_key = $1 AND d2.client_name IS NOT NULL
            ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
         ) nm ON true`, [clientKey]),
    pool.query<{ kommo_id: string; name: string | null; price: string; pipeline_id: string;
      status_id: string; funnel_stage: string | null; dt: string | null; closed: boolean; manager: string | null }>(
      // Перелік угод клієнта, а не метрика періоду: фільтра по даті тут немає
      // взагалі (клас `lifetime` за #17c). Підпис стадії — за СТАТУСОМ Kommo
      // (`stageName`), а не за кошиком `funnel_stage`: кошик `invoiced` містить
      // шість різних статусів і брехав би частині рядків.
      `SELECT d.kommo_id, d.name, d.price, d.pipeline_id, d.status_id, psm.funnel_stage,
              to_char(COALESCE(d.closed_at_kommo, d.created_at_kommo) AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS dt,
              (d.closed_at_kommo IS NOT NULL) AS closed, m.name AS manager
         FROM deals d
         LEFT JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
         LEFT JOIN managers m ON m.id = d.manager_id
        -- 🤖 Службові «Автосделка:» тут не показуємо (рішення власника): предикат
        -- один на весь проєкт, у ядрі — щоб редакція префікса не розійшлась.
        -- 🔴 ЛИШЕ УСПІШНІ Й ЛИШЕ З СУМОЮ (рішення власника 05.08.2026).
        -- Було «останні угоди»: у списку сусідили закриті без грошей, запити на
        -- прорахунок і рядки «( ) – ( )» з нулем. Такий перелік не відповідає на
        -- питання, заради якого його відкривають («як він платив»), — він лише
        -- створює враження активності там, де грошей не було.
        -- status_id = 142 (а не кошик funnel_stage) — той самий анкер ①, що
        -- в гістограмі вище, тож стовпчик і рядок під ним говорять про одне.
        -- price <> 0 — бо нульова сума це або незаповнена угода, або сторно,
        -- і в переліку «за що заплатили» вона нічого не пояснює.
        WHERE d.client_key = $1 AND ${metrics.notAutodealSql("d")}
          AND d.status_id = 142 AND COALESCE(d.price, 0) <> 0
        ORDER BY COALESCE(d.closed_at_kommo, d.created_at_kommo) DESC NULLS LAST
        LIMIT 15`, [clientKey]),
  ]);

  const months: { month: string; revenue: number; deals: number }[] = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(`${firstOfThis}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    const ym = d.toISOString().slice(0, 7);
    const b = buckets.find((x) => x.bucket.slice(0, 7) === ym);
    months.push({ month: ym, revenue: Math.round(b?.revenue ?? 0), deals: b?.deals ?? 0 });
  }
  const h = head.rows[0];
  res.json({
    clientKey,
    clientName: h?.client_name ?? clientKey,
    managerName: h?.manager_name ?? null,
    teamName: h?.team_name ?? null,
    pinned: h?.pinned_manager_id != null,
    paymentType: h?.payment_type ?? null,
    orders: Number(h?.orders ?? 0),
    lifetimeRevenue: Math.round(Number(h?.revenue ?? 0)),
    firstPaid: h?.first_paid ?? null,
    lastPaid: h?.last_paid ?? null,
    months,
    monthsTotal: months.reduce((s2, m) => s2 + m.revenue, 0),
    deals: dealsRes.rows.map((d) => ({
      kommoId: Number(d.kommo_id),
      crmUrl: kommoLeadUrl(Number(d.kommo_id)),
      name: d.name,
      date: d.dt,
      dateKind: d.closed ? "closed" : "created",
      price: Math.round(Number(d.price)),
      stage: stageName(d.pipeline_id, d.status_id, d.funnel_stage ?? undefined),
      won: String(d.status_id) === "142",
      manager: d.manager,
    })),
    anchorNote: "Стовпчики — гроші ① (успішно реалізовано, анкер = дата входу в етап). "
      + "Список — журнал угод (дата закриття; для незакритих — створення). Суми не зводяться між собою.",
    /**
     * 🛠 ПРАВА НА ДІЇ КЕРУВАННЯ — РАХУЄ СЕРВЕР, тими самими функціями, що гейтять
     * самі роути. Інакше кнопка й дозвіл розходяться, і людина бачить кнопку,
     * яка завжди дає 403 (або, гірше, не бачить дії, на яку має право).
     *
     * 🔴 `canHide`/`hidden` ПРИБРАНО, і це не косметика. Хвиля 2 перестала писати
     * `loyalty_overrides.hidden`, але кнопка в картці лишилась і далі слала
     * `{clientKey, hidden}` — тобто **мовчки нічого не робила**: 200 у відповідь,
     * нуль змін у БД, `hidden` завжди false. Заміна — архів: причина, дата, автор.
     */
    canArchive: isAdminScope(auth),
    /**
     * ⭐ «Вважати постійним попри правило» — та сама межа, що архівація
     * (`isAdminScope`: КВП/ОД/адмін), і це не спрощення: рішення власника
     * 05.08.2026 назвало саме цих людей, а сусідня дія на цьому ж екрані вже
     * має рівно такий гейт. Заводити тут ДРУГУ межу означало б, що на одній
     * картці дві дії одного рівня закриті по-різному, і ніхто не памʼятатиме чому.
     */
    canForceRegular: isAdminScope(auth),
    forcedRegular: h?.force_regular ?? false,
    forceNote: h?.force_note ?? null,
    archived: isArchived(h?.archived_at ?? null, h?.last_paid ?? null),
    archiveReason: h?.archive_reason ?? null,
    archiveReasons: ARCHIVE_REASONS,
    canAssign: roleHasPerm(auth.roleKey, "merge_clients"),
    canMerge: roleHasPerm(auth.roleKey, "merge_clients") || auth.role === "team_lead",
    mergeScope: roleHasPerm(auth.roleKey, "merge_clients") ? "all" : "team",
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ФАЗА B · РЕАКТИВАЦІЯ · ОБʼЄДНАННЯ КЛІЄНТІВ · ВІДПОВІДАЛЬНИЙ МЕНЕДЖЕР
// ═══════════════════════════════════════════════════════════════════════════

/** Список кандидатів на реактивацію + плитки. Стани рахуються з дат, не з тумблера. */
/**
 * 🧭 ПУЛ НІЧИЙНИХ КЛІЄНТІВ (рішення власника 05.08.2026).
 *
 * Клієнти, чий основний відповідальний — службовий акаунт або звільнений
 * менеджер. Означення ОДНЕ, з ядра (`core/orphanClients.ts`), а не набір умов,
 * розсипаних по запитах.
 *
 * 🔴 СПІЛЬНИЙ ПУЛ — СВІДОМИЙ ВИНЯТОК ЗІ СКОУПУ. Тімлід бачить ВЕСЬ пул, без
 * клампу по своїй команді: клієнт нічийний саме тому, що не належить нікому,
 * і ділити його по командах немає за чим. Менеджери пулу не бачать зовсім.
 * Виняток стосується ТІЛЬКИ цих роутів; будь-який інший роут кламиться як досі.
 *
 * ⚠️ Лічильники плиток рахуються з ТІЄЇ САМОЇ вибірки, що й список (макет):
 * окремий COUNT-запит із часом розійшовся б зі списком, і ми б довго шукали,
 * чому «27» не сходиться з кількістю рядків.
 */
dashboardRouter.get("/orphan-clients", async (req, res) => {
  const auth = req.auth!;
  if (auth.role === "manager") return res.status(403).json({ error: "Пул нічийних доступний керівникам" });
  const all = String(req.query.scope ?? "") === "all";
  const months = all ? 600 : ORPHAN_DEFAULT_MONTHS;
  const rows = await metrics.orphanClients(months);
  type Row = (typeof rows)[number];
  const groups = new Map<number, { managerId: number; manager: string; reason: string; reasonLabel: string;
    clients: Row[]; sum12: number; sumAll: number }>();
  for (const r of rows) {
    const g = groups.get(r.managerId) ?? { managerId: r.managerId, manager: r.manager, reason: r.reason as string,
      reasonLabel: ORPHAN_REASON_LABEL[r.reason], clients: [] as Row[], sum12: 0, sumAll: 0 };
    g.clients.push(r); g.sum12 += r.revenue12; g.sumAll += r.revenueAll;
    groups.set(r.managerId, g);
  }
  const list = [...groups.values()].sort((a, b) => b.sumAll - a.sumAll);
  for (const g of list) g.clients.sort((a, b) => b.revenueAll - a.revenueAll);
  res.json({
    scope: all ? "all" : `${ORPHAN_DEFAULT_MONTHS}m`,
    // Плитки — з тієї самої вибірки, не окремим запитом.
    tiles: {
      clients: rows.length,
      money12: rows.reduce((s, r) => s + r.revenue12, 0),
      regulars: rows.filter((r) => r.isRegular).length,
      vip: rows.filter((r) => r.segment === "ВІП").length,
      claimedThisMonth: await metrics.orphanClaimedThisMonth(),
      totalAllTime: await metrics.orphanTotalAllTime(),
    },
    groups: list,
  });
});

/**
 * «Взяти в роботу» — закріплення клієнта за виконавцем ОДРАЗУ, щоб двоє не
 * дзвонили тому самому. Гонка: перший виграє, другий отримує 409 (не тихе
 * перезакріплення — інакше другий менеджер вважав би клієнта своїм).
 */
dashboardRouter.post("/orphan-clients/claim", async (req, res) => {
  const auth = req.auth!;
  if (auth.role === "manager") return res.status(403).json({ error: "Пул нічийних доступний керівникам" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const managerId = Number(req.body?.managerId);
  if (!clientKey || !Number.isFinite(managerId)) return res.status(400).json({ error: "clientKey і managerId обовʼязкові" });
  // Тімлід призначає ЛИШЕ свою команду; КВП/ОД/адмін — будь-кого.
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Виконавець має бути з вашої команди" });
  }
  // Атомарно: закріплюємо лише якщо ще НЕ закріплений. Нуль рядків = хтось устиг раніше.
  const up = await pool.query(
    `INSERT INTO loyalty_overrides (client_key, pinned_manager_id, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (client_key) DO UPDATE SET pinned_manager_id = EXCLUDED.pinned_manager_id,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE loyalty_overrides.pinned_manager_id IS NULL
     RETURNING client_key`,
    [clientKey, managerId, auth.userId]);
  if (up.rowCount === 0) {
    const who = await pool.query<{ name: string }>(
      `SELECT m.name FROM loyalty_overrides lo JOIN managers m ON m.id = lo.pinned_manager_id
        WHERE lo.client_key = $1`, [clientKey]);
    return res.status(409).json({ error: `Клієнта вже взяв ${who.rows[0]?.name ?? "інший менеджер"}` });
  }
  res.json({ ok: true, clientKey, managerId });
});

dashboardRouter.get("/reactivation-list", async (req, res) => {
  const auth = req.auth!;
  let scope: reactivation.ReactivationScope = {};
  if (auth.role === "manager") scope = { managerId: auth.managerId ?? -1 };
  else if (auth.role === "team_lead") scope = { teamId: auth.teamId ?? -1 };
  else if (req.query.managerId) scope = { managerId: Number(req.query.managerId) };
  else if (req.query.teamId) scope = { teamId: Number(req.query.teamId) };

  const [clients, returned30] = await Promise.all([
    reactivation.clientStates(scope),
    reactivation.returnedAfterTask(30, scope),
  ]);

  // Ранжування за ЦІННІСТЮ (ядро), сезонні — ВНИЗ списку і без задач.
  // 💬 Останній коментар у рядок — те саме поле `client_comments`, що в картці.
  const lastCommentR = await latestCommentByClient();
  // 🔴 ПРИСВОЄННЯ, А НЕ СПРЕД. `{ ...c, lastComment }` заборонений воротами #17e2:
  // спред у відповіді одного дня винесе назовні нову колонку БД, якої ніхто не
  // питав. Поле оголошене в типі рядка ядра, тож тут — просто заповнення.
  for (const c of clients) c.lastComment = lastCommentR.get(c.clientKey) ?? null;
  const ranked = [...clients].sort((a, b) => {
    if (a.seasonal !== b.seasonal) return a.seasonal ? 1 : -1;
    return b.value - a.value;
  });
  const byState = (st: reactivation.ClientState) => ranked.filter((c) => c.state === st && !c.seasonal);
  const inWork = ranked.filter((c) => c.taskId != null && c.taskStatus !== "done");

  res.json({
    clients: ranked,
    closeReasons: reactivation.CLOSE_REASONS,
    thresholds: {
      sleepingDays: reactivation.SLEEPING_DAYS, lostDays: reactivation.LOST_DAYS,
      // Пороги ПО СЕГМЕНТАХ і межа архіву — з ядра, щоб підпис на екрані не став
      // другою редакцією правила (зашите «14/30/60» почало б брехати мовчки).
      bySegment: reactivation.SEGMENT_SLEEPING_DAYS,
      longLapsedDays: reactivation.LONG_LAPSED_DAYS,
      segmentMinPayments: reactivation.SEGMENT_MIN_PAYMENTS,
    },
    tiles: {
      sleeping: byState("sleeping").length,
      sleepingPotential: Math.round(byState("sleeping").reduce((s2, c) => s2 + c.lifetimeRevenue, 0)),
      lost: byState("lost").length,
      seasonal: ranked.filter((c) => c.seasonal).length,
      inWork: inWork.length,
      // «Повернено за 30 дн.» — метрика РЕЗУЛЬТАТУ: клієнт із реактиваційною
      // задачею, у якого ПІСЛЯ її створення зʼявилась оплата. Не «замовив у
      // періоді» — інакше сюди потрапили б ті, хто й не йшов.
      returned30: returned30.clients,
      returned30Revenue: Math.round(returned30.revenue),
    },
    // ДВА РІЗНІ ПИТАННЯ, і фронт мусить їх розрізняти:
    //   canAssign — передати клієнта іншому менеджеру (лишилось за merge_clients);
    //   canMerge  — обʼєднати клієнтів (тімліду відкрито В МЕЖАХ його команди,
    //               рішення власника 04.08.2026; сам кламп — на сервері).
    canAssign: roleHasPerm(auth.roleKey, "merge_clients"),
    canMerge: roleHasPerm(auth.roleKey, "merge_clients") || auth.role === "team_lead",
    mergeScope: roleHasPerm(auth.roleKey, "merge_clients") ? "all" : "team",
  });
});

/**
 * ＋ ЗАДАЧА РЕАКТИВАЦІЇ — ОДНА ЗАДАЧА = ОДИН КЛІЄНТ (`reactivation_client`).
 *
 * 🔴 Чому саме так (рішення власника 03.08.2026): обидві ключові фічі вимагають
 * привʼязки до клієнта — ПРИЧИНА ВТРАТИ і метрика «повернено після задачі».
 * Пачка їх розмиває: закрив одну задачу на 12 клієнтів — і причина стосується
 * усіх дванадцятьох, хоч насправді одного відлякнула ціна, а другий закрився.
 *
 * Старий `POST /tasks/reactivation` (пачка з чеклістом) НЕ чіпаємо — він
 * лишається для масових кампаній; метрика «повернено» читає обидва типи.
 */
dashboardRouter.post("/reactivation-task", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });

  // Виконавець за замовчуванням — основний менеджер клієнта: задача без
  // виконавця нікому не належить і не зʼявиться в жодному списку.
  const owner = await pool.query<{ manager_id: number; client_name: string | null }>(
    `WITH paid AS (
       SELECT d.manager_id, d.closed_at_kommo, d.client_name FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE psm.funnel_stage = 'paid' AND d.client_key = $1
     ), pm AS (
       SELECT manager_id FROM (SELECT manager_id, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(closed_at_kommo) DESC) rn
                                 FROM paid GROUP BY manager_id) z WHERE rn = 1
     )
     SELECT COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id,
            (SELECT client_name FROM paid WHERE client_name IS NOT NULL ORDER BY closed_at_kommo DESC LIMIT 1) AS client_name
       FROM pm LEFT JOIN loyalty_overrides lo ON lo.client_key = $1`, [clientKey]);
  const defaultAssignee = owner.rows[0]?.manager_id ?? null;
  const clientName = owner.rows[0]?.client_name ?? clientKey;
  const assigneeId = req.body?.assigneeId != null ? Number(req.body.assigneeId) : defaultAssignee;
  if (assigneeId == null) return res.status(400).json({ error: "Не вдалося визначити виконавця" });

  const deadline = String(req.body?.deadline ?? "").match(/^\d{4}-\d{2}-\d{2}$/) ? String(req.body.deadline) : null;
  const note = String(req.body?.comment ?? "").trim().slice(0, 1000) || null;

  // Відкрита задача по цьому клієнту вже може існувати — другу не плодимо,
  // інакше «задач у роботі» рахувало б наміри, а не роботу.
  const open = await pool.query<{ id: number }>(
    `SELECT id FROM tasks WHERE task_type = 'reactivation_client' AND client_key = $1 AND status <> 'done' LIMIT 1`,
    [clientKey]);
  if (open.rowCount) return res.status(409).json({ error: "Задача по цьому клієнту вже відкрита", taskId: open.rows[0].id });

  const dept = await pool.query<{ name: string | null }>(
    `SELECT t.name FROM managers m LEFT JOIN teams t ON t.id = m.team_id WHERE m.id = $1`, [assigneeId]);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO tasks (title, status, deadline, assignee_id, priority, department, created_by,
                        task_type, client_key, description)
     VALUES ($1,'not_started',$2,$3,'high',$4,$5,'reactivation_client',$6,$7) RETURNING id`,
    [`Реактивація: ${clientName}`, deadline, assigneeId, dept.rows[0]?.name ?? null, auth.userId, clientKey, note]);
  res.json({ id: r.rows[0].id, assigneeId, clientName });
});

/**
 * Закриття задачі реактивації — ПРИЧИНА ОБОВʼЯЗКОВА.
 * Межу тримає ще й CHECK у БД: форму обійде будь-який прямий UPDATE, а дані про
 * те, ЧОМУ клієнт не повернувся, існують тільки тут.
 */
dashboardRouter.post("/reactivation-task/close", async (req, res) => {
  const auth = req.auth!;
  const taskId = Number(req.body?.taskId);
  const reasonKey = String(req.body?.reason ?? "").trim();
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: "taskId обовʼязковий" });
  if (!reactivation.CLOSE_REASON_KEYS.includes(reasonKey)) {
    return res.status(400).json({ error: `Причина обовʼязкова: ${reactivation.CLOSE_REASON_KEYS.join(" · ")}` });
  }
  // «Інше» без пояснення — це та сама відсутність причини, лише під іншою назвою.
  if (reasonKey === "other" && !note) return res.status(400).json({ error: "Для «Інше» потрібне пояснення" });

  const t = await pool.query<{ client_key: string | null; assignee_id: number | null }>(
    `SELECT client_key, assignee_id FROM tasks WHERE id = $1 AND task_type = 'reactivation_client'`, [taskId]);
  const row = t.rows[0];
  if (!row) return res.status(404).json({ error: "Задача не знайдена" });
  if (!row.client_key || !(await canSeeClient(auth, row.client_key))) return res.status(403).json({ error: "Forbidden" });

  const stored = note ? `${reasonKey}: ${note}` : reasonKey;
  await pool.query(
    `UPDATE tasks SET status = 'done', close_reason = $2, closed_at = now(), updated_at = now() WHERE id = $1`,
    [taskId, stored]);
  res.json({ ok: true, closeReason: stored });
});

/** Позначка «сезонний» — єдине, що ставиться руками (з дат її вивести неможливо). */
dashboardRouter.post("/client-seasonal", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const clientKey = String(req.body?.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });
  const seasonal = req.body?.seasonal === true;
  const note = String(req.body?.note ?? "").trim().slice(0, 300) || null;
  await pool.query(
    `INSERT INTO loyalty_overrides (client_key, seasonal, seasonal_note, updated_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (client_key) DO UPDATE SET seasonal = EXCLUDED.seasonal,
       seasonal_note = EXCLUDED.seasonal_note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, seasonal, note, auth.userId]);
  res.json({ ok: true, seasonal });
});

// ───────────────────────── ОБʼЄДНАННЯ КЛІЄНТІВ ─────────────────────────
/**
 * Команда ВЛАСНИКА клієнта — та сама формула, що скрізь на цих екранах:
 * COALESCE(закріплений вручну, основний за оплатами) → його `team_id`.
 *
 * 🔴 Дивимось і на `client_key`, і на `client_key_raw`. Після злиття угоди
 * псевдоніма їдуть під канонічним ключем, тож пошук лише по `client_key` дав би
 * `null` для щойно приєднаного боку — і тімлід не зміг би роз'єднати ВЛАСНЕ
 * злиття. Сирий ключ не змінюється ніколи, тому він тут і потрібен.
 */
async function clientOwnerTeam(clientKey: string): Promise<number | null> {
  const r = await pool.query<{ team_id: number | null }>(
    `WITH paid AS (
       SELECT d.manager_id, d.closed_at_kommo FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE psm.funnel_stage = 'paid' AND (d.client_key = $1 OR d.client_key_raw = $1)
     ), pm AS (
       SELECT manager_id FROM (
         SELECT manager_id, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(closed_at_kommo) DESC) rn
           FROM paid GROUP BY manager_id) z WHERE rn = 1
     )
     SELECT m.team_id FROM pm
       LEFT JOIN loyalty_overrides lo ON lo.client_key = $1
       JOIN managers m ON m.id = COALESCE(lo.pinned_manager_id, pm.manager_id)`, [clientKey]);
  return r.rows[0]?.team_id ?? null;
}

/** Рішення «чи можна цій людині зливати ЦЮ пару» — предикат у `auth/mergeScope`. */
async function mergePairScope(auth: NonNullable<typeof import("express")["request"]["auth"]>,
  aliasKey: string, canonicalKey: string): Promise<MergePairScope> {
  const canAll = roleHasPerm(auth.roleKey, "merge_clients");
  const leadTeamId = !canAll && auth.role === "team_lead" ? auth.teamId ?? null : null;
  if (canAll) return { canAll, leadTeamId: null, aliasTeamId: null, canonicalTeamId: null };
  const [aliasTeamId, canonicalTeamId] = await Promise.all([
    clientOwnerTeam(aliasKey), clientOwnerTeam(canonicalKey),
  ]);
  return { canAll, leadTeamId, aliasTeamId, canonicalTeamId };
}
/**
 * 🔴 UI ПОВЕРХ `client_key_alias` — механіка вже на проді (178 псевдонімів,
 * 151 клієнт), нічого нового в даних не вигадуємо. Тут лише передпоказ,
 * підтвердження й журнал.
 *
 * ⚠️ КЛАС B НЕ ПІДКАЗУЄМО: контакт-людина при компанії, гомогліфи, телефон, що
 * веде до ДВОХ фірм. Транзитивне склеювання заборонене тригером у БД; підказувати
 * те, що БД усе одно відкине, означало б вчити людину неправильному.
 */
dashboardRouter.get("/client-merge/preview", async (req, res) => {
  const alias = String(req.query.alias ?? "").trim();
  const canonical = String(req.query.canonical ?? "").trim();
  // Передпоказ клампимо ТАК САМО, як саме злиття (інакше тімлід читав би цифри
  // чужої команди, просто не маючи кнопки), і так само ПЕРШИМ оператором.
  const scope = await mergePairScope(req.auth!, alias, canonical);
  if (!mergePairAllowed(scope)) return res.status(403).json({ error: mergeDenyReason(scope) });
  if (!alias || !canonical) return res.status(400).json({ error: "alias і canonical обовʼязкові" });
  if (alias === canonical) return res.status(400).json({ error: "Ключі однакові" });

  const side = async (key: string) => (await pool.query<{ orders: string; revenue: string; name: string | null; last_paid: string | null }>(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(d.price),0) AS revenue,
            (array_agg(d.client_name ORDER BY d.closed_at_kommo DESC NULLS LAST))[1] AS name,
            to_char(MAX(d.closed_at_kommo) AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS last_paid
       FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
      WHERE psm.funnel_stage = 'paid' AND d.client_key = $1`, [key])).rows[0];

  const [a, c, chain, plans, dealsToMove] = await Promise.all([
    side(alias), side(canonical),
    // Ланцюжок заборонений тригером; попереджаємо ДО спроби, щоб людина бачила
    // причину, а не голий 500 з бази.
    pool.query<{ who: string }>(
      `SELECT 'canonical_is_alias' AS who FROM client_key_alias WHERE revoked_at IS NULL AND alias_key = $2
       UNION ALL
       SELECT 'alias_is_canonical' FROM client_key_alias WHERE revoked_at IS NULL AND canonical_key = $1`,
      [alias, canonical]),
    pool.query<{ ck: string; ym: string; plan: string; status: string }>(
      `SELECT client_key AS ck, to_char(month,'YYYY-MM') AS ym, plan, status
         FROM repeat_client_plans WHERE client_key IN ($1,$2) ORDER BY month`, [alias, canonical]),
    pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM deals WHERE client_key_raw = $1`, [alias]),
  ]);

  const aOrders = Number(a?.orders ?? 0), cOrders = Number(c?.orders ?? 0);
  const aRev = Number(a?.revenue ?? 0), cRev = Number(c?.revenue ?? 0);
  const planRows = plans.rows.map((p) => ({ side: p.ck === alias ? "alias" : "canonical", month: p.ym, plan: Number(p.plan), status: p.status }));
  const conflictMonths = planRows
    .filter((p) => p.side === "alias")
    .filter((p) => planRows.some((q) => q.side === "canonical" && q.month === p.month))
    .map((p) => p.month);

  res.json({
    alias: { key: alias, name: a?.name ?? null, orders: aOrders, revenue: Math.round(aRev), lastPaid: a?.last_paid ?? null },
    canonical: { key: canonical, name: c?.name ?? null, orders: cOrders, revenue: Math.round(cRev), lastPaid: c?.last_paid ?? null },
    after: { orders: aOrders + cOrders, revenue: Math.round(aRev + cRev), regular: aOrders + cOrders >= 2 },
    dealsToMove: Number(dealsToMove.rows[0]?.n ?? 0),
    chainBlocked: chain.rows.map((x) => x.who),
    // 🔴 Плани НЕ переносяться перерахунком (він рухає лише deals.client_key).
    // Показуємо їх окремо: рядок на злитому ключі осиротіє й зникне з екрана.
    plans: planRows,
    planConflictMonths: conflictMonths,
    reversible: "Відкіт = revoked_at + перерахунок; client_key_raw зберігається, бекап не потрібен",
  });
});

dashboardRouter.post("/client-merge", async (req, res) => {
  const auth = req.auth!;
  const alias = String(req.body?.alias ?? "").trim();
  const canonical = String(req.body?.canonical ?? "").trim();
  const reason = String(req.body?.reason ?? "").trim();
  // 🔴 ГЕЙТ — ПЕРШИЙ ЗНАЧУЩИЙ ОПЕРАТОР, І ЦЕ ВИПРАВЛЕННЯ ПІСЛЯ ЧЕРВОНОЇ МАТРИЦІ
  // (04.08.2026). Спершу тут стояла перевірка «alias і canonical обовʼязкові», і
  // проба #11 з невалідним тілом діставала 400 ЗАМІСТЬ 403: запит помирав на
  // валідації, не дійшовши до межі. Дірки в доступі це не робило (з реальними
  // ключами кламп працює — #30h), але ламало ГАРАНТІЮ, на якій стоїть уся
  // матриця: «403 у deny-рядку означає, що спрацював гейт». Порожні ключі дають
  // невизначену команду → для тімліда це відмова, для merge_clients — прохід далі.
  const scope = await mergePairScope(auth, alias, canonical);
  if (!mergePairAllowed(scope)) return res.status(403).json({ error: mergeDenyReason(scope) });
  if (!alias || !canonical) return res.status(400).json({ error: "alias і canonical обовʼязкові" });
  if (!reason) return res.status(400).json({ error: "Причина обовʼязкова — реєстр без причини стає смітником" });
  try {
    await pool.query(
      `INSERT INTO client_key_alias (alias_key, canonical_key, reason, evidence, approved_by)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [alias, canonical, reason.slice(0, 300),
       JSON.stringify({ source: "ui", approvedAt: new Date().toISOString().slice(0, 10) }), auth.userId]);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/ланцюжок заборонено/.test(msg)) return res.status(409).json({ error: msg });
    if (/duplicate key/.test(msg)) return res.status(409).json({ error: "Такий псевдонім уже є в реєстрі" });
    throw e;
  }
  const r = await recomputeClientKeys();
  res.json({ ok: true, recomputed: r.changed });
});

dashboardRouter.post("/client-merge/revoke", async (req, res) => {
  const alias = String(req.body?.alias ?? "").trim();
  // Роз'єднання — той самий кламп, що й злиття, і так само ПЕРШИМ оператором
  // (див. коментар у /client-merge). Канонічний бік беремо з реєстру, бо в тілі
  // запиту його немає — інакше «своє» визначав би той, хто просить.
  const row = (await pool.query<{ canonical_key: string; evidence: unknown }>(
    `SELECT canonical_key, evidence FROM client_key_alias WHERE alias_key = $1 AND revoked_at IS NULL`, [alias])).rows[0];
  // 🔓 ПРАВО НА ВІДКІТ — ЗА ДЖЕРЕЛОМ ЗЛИТТЯ (рішення власника 27.08.2026).
  // Реєстр спільний, а дверей до нього двоє, і гейтяться вони різними правами;
  // одне правило на відкіт ламало правило «скасовне тим самим інтерфейсом» в
  // обидва боки одразу. Розбір — чиста функція, деталі в `auth/mergeScope.ts`.
  const source = mergeSourceOf(row?.evidence);
  const scope = await mergePairScope(req.auth!, alias, row?.canonical_key ?? alias);
  const revokeInput = {
    source, pair: scope,
    hasMergeReceivables: roleHasPerm(req.auth!.roleKey, "merge_receivables"),
  };
  if (!revokeAllowed(revokeInput)) return res.status(403).json({ error: revokeDenyReason(revokeInput) });
  if (!alias) return res.status(400).json({ error: "alias обовʼязковий" });
  const upd = await pool.query(
    `UPDATE client_key_alias SET revoked_at = now() WHERE alias_key = $1 AND revoked_at IS NULL`, [alias]);
  if (!upd.rowCount) return res.status(409).json({ error: "Активного псевдоніма з таким ключем немає" });
  const r = await recomputeClientKeys();
  res.json({ ok: true, recomputed: r.changed });
});

/**
 * 🔓 ПРЕВʼЮ РОЗʼЄДНАННЯ — наслідки ДО дії, не після (01.09.2026).
 *
 * Симетрично до `mergeSummary`, який показує сторони перед обʼєднанням. Сама дія
 * лишається наявним `POST /client-merge/revoke` — його НЕ переписуємо: він уже
 * знімає псевдонім і кличе перерахунок, а дебіторку синк розводить сам за ≤15 хв.
 *
 * 🔴 ГЕЙТ — ТОЙ САМИЙ, ЩО В САМОЇ ДІЇ (`revokeAllowed` за джерелом злиття).
 * Превʼю показує склад групи, суми й тексти нотаток; віддати це тому, хто не має
 * права розʼєднувати, означало б відчинити читання там, де зачинено запис.
 * Стереже `#269`.
 *
 * ⏳ МЕЖА, НАЗВАНА ВГОЛОС: значення з Лист20 читається тим самим
 * `fetchSheetLimitsForReconcile`, який позначено як страховку до 07.09.2026 і
 * тоді прибирається. Коли він зникне або впаде, превʼю НЕ мовчить — стан
 * переходить у `unknown` із причиною. Порожній рядок тут коштував би найдорожче.
 */
dashboardRouter.get("/receivables/unmerge-preview", async (req, res) => {
  const canonical = String(req.query.canonical ?? "").trim();
  if (!canonical) return res.status(400).json({ error: "canonical обовʼязковий" });

  const al = await pool.query<{ alias_key: string; evidence: unknown; created_at: string }>(
    `SELECT alias_key, evidence, created_at FROM client_key_alias
      WHERE canonical_key = $1 AND revoked_at IS NULL ORDER BY alias_key`, [canonical]);
  if (!al.rowCount) return res.status(404).json({ error: "Активних псевдонімів у цього клієнта немає" });

  // Право — за джерелом злиття, тим самим розбором, що й у самої дії.
  const source = mergeSourceOf(al.rows[0].evidence);
  const scope = await mergePairScope(req.auth!, al.rows[0].alias_key, canonical);
  const input = { source, pair: scope,
    hasMergeReceivables: roleHasPerm(req.auth!.roleKey, "merge_receivables") };
  if (!revokeAllowed(input)) return res.status(403).json({ error: revokeDenyReason(input) });

  const aliasKeys = al.rows.map((r) => r.alias_key);
  const keys = [canonical, ...aliasKeys];
  const mergedAt = al.rows[0].created_at;

  const [inv, lim, notes, hidden] = await Promise.all([
    pool.query<{ client_key_raw: string; name: string; amount: string; n: string }>(
      `SELECT ri.client_key_raw, MIN(ri.client_name) AS name,
              COALESCE(SUM(ri.amount),0) AS amount, COUNT(*) AS n
         FROM receivable_invoices ri WHERE ri.client_key_raw = ANY($1)
        GROUP BY ri.client_key_raw`, [keys]),
    pool.query<{ client_key: string; limit_days: number | null; limit_amount: string | null; note: string }>(
      `SELECT client_key, limit_days, limit_amount, note FROM client_credit_limits WHERE client_key = ANY($1)`, [keys]),
    pool.query<{ comment: string | null; due_date: string | null; updated_at: string }>(
      `SELECT comment, to_char(due_date,'YYYY-MM-DD') AS due_date,
              to_char(updated_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS updated_at
         FROM receivable_notes WHERE client_key = $1 AND updated_at > $2`, [canonical, mergedAt]),
    pool.query<{ client_key: string; n: string }>(
      `SELECT client_key, COUNT(*) AS n FROM receivable_notes
        WHERE client_key = ANY($1) GROUP BY client_key`, [aliasKeys]),
  ]);

  const invBy = new Map(inv.rows.map((r) => [r.client_key_raw, r]));
  const limBy = new Map(lim.rows.map((r) => [r.client_key, r]));
  const hidBy = new Map(hidden.rows.map((r) => [r.client_key, Number(r.n)]));
  const num = (v: string | number | null): number | null => v == null ? null : Number(v);

  // 📸 Знімок із реєстру — якщо злиття робилось уже після `#262`.
  const snap = (al.rows[0].evidence as { limitsBefore?: { sides?: { clientKey: string;
    limitDays: number | null; limitAmount: number | null; setAt: string | null }[] } } | null)?.limitsBefore;
  const snapCanon = snap?.sides?.find((x) => x.clientKey === canonical);

  let limitBefore: unmergePreview.LimitBefore;
  if (snapCanon) {
    limitBefore = { kind: "recorded", days: snapCanon.limitDays, amount: snapCanon.limitAmount, setAt: snapCanon.setAt };
  } else {
    // 🔴 Аркуш — ПОКАЗАТИ, не підставити. І будь-який його збій дає названий
    // `unknown`, а не тишу: читання поза базою, воно має право зникнути.
    try {
      const { fetchSheetLimitsForReconcile } = await import("../jobs/syncReceivables.js");
      const sheet = await fetchSheetLimitsForReconcile();
      const days = sheet.get(canonical)?.limitDays;
      limitBefore = days == null
        ? { kind: "unknown", why: "ні знімка в реєстрі, ні рядка в Лист20" }
        : { kind: "sheet", days };
    } catch {
      limitBefore = { kind: "unknown", why: "знімка немає, а Лист20 зараз недоступний" };
    }
  }

  const canonLim = limBy.get(canonical);
  res.json(unmergePreview.buildUnmergePreview({
    canonicalKey: canonical,
    sides: keys.map((k) => {
      const i = invBy.get(k), l = limBy.get(k);
      return { clientKey: k, name: i?.name ?? k, amount: Number(i?.amount ?? 0), invoices: Number(i?.n ?? 0),
               ownLimitDays: l ? num(l.limit_days) : null, ownLimitAmount: l ? num(l.limit_amount) : null,
               hiddenNotes: hidBy.get(k) ?? 0 };
    }),
    canonicalLimitNow: { days: canonLim ? num(canonLim.limit_days) : null,
                         amount: canonLim ? num(canonLim.limit_amount) : null,
                         note: canonLim?.note ?? null },
    limitBefore,
    ownerlessNotes: notes.rows.map((n) => ({
      text: n.comment ?? "", dueDate: n.due_date, createdAt: n.updated_at })),
  }));
});

dashboardRouter.get("/client-merge/journal", async (req, res) => {
  const auth = req.auth!;
  const canAll = roleHasPerm(auth.roleKey, "merge_clients");
  const isLead = auth.role === "team_lead";
  if (!canAll && !isLead) return res.status(403).json({ error: "Forbidden" });
  const r = await pool.query<{ alias_key: string; canonical_key: string; reason: string; created_at: string;
    revoked_at: string | null; approved: string | null }>(
    `SELECT a.alias_key, a.canonical_key, a.reason,
            to_char(a.created_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS created_at,
            to_char(a.revoked_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS revoked_at,
            COALESCE(u.full_name, u.email) AS approved
       FROM client_key_alias a LEFT JOIN users u ON u.id = a.approved_by
      ORDER BY a.created_at DESC LIMIT 200`);
  // 🔴 ТІМЛІДУ — ЛИШЕ ЗАПИСИ ЙОГО КОМАНДИ. Це моє рішення за замовчуванням, а не
  // вказівка власника: він сказав «журнал діє без змін», але тімлід тут НОВИЙ
  // читач, і показати йому ключі всієї компанії було б ширшим розширенням, ніж
  // просили. Звужую до того, що він і так бачить у пошуку. Треба навпаки —
  // прибрати цей фільтр (один рядок), але СВІДОМО.
  const rows = canAll ? r.rows : await (async () => {
    const teams = await Promise.all(r.rows.map(async (x) =>
      mergePairAllowed(await mergePairScope(auth, x.alias_key, x.canonical_key))));
    return r.rows.filter((_, i) => teams[i]);
  })();
  res.json(rows.map((x) => ({
    aliasKey: x.alias_key, canonicalKey: x.canonical_key, reason: x.reason,
    createdAt: x.created_at, revokedAt: x.revoked_at, approvedBy: x.approved,
  })));
});

// ───────────────────────── ВІДПОВІДАЛЬНИЙ МЕНЕДЖЕР ─────────────────────────
/**
 * 🔴 ПРАВИЛО ВЛАСНИКА: поточний місяць лишається за СТАРИМ менеджером, новий
 * планує з наступного. Інакше план/факт/світлофор посеред місяця поїхали б у
 * двох людей одразу, і жоден із них у цьому не винен.
 *
 * Механізм не новий: `loyalty_overrides.pinned_manager_id` існує давно. Нове —
 * ТРИ правила навколо нього: межа місяця, історія передач і бейдж розбіжності
 * з CRM (нижче, у списку клієнтів).
 */
dashboardRouter.post("/client-manager", requirePerm("merge_clients"), async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.body?.clientKey ?? "").trim();
  const toManagerId = Number(req.body?.managerId);
  const reason = String(req.body?.reason ?? "").trim().slice(0, 300) || null;
  if (!clientKey || !Number.isFinite(toManagerId)) return res.status(400).json({ error: "clientKey і managerId обовʼязкові" });

  const chk = await pool.query<{ id: number }>(`SELECT id FROM managers WHERE id = $1 AND is_active`, [toManagerId]);
  if (!chk.rowCount) return res.status(400).json({ error: "Менеджер не знайдений або деактивований" });

  const cur = await pool.query<{ pinned_manager_id: number | null }>(
    `SELECT pinned_manager_id FROM loyalty_overrides WHERE client_key = $1`, [clientKey]);
  const from = cur.rows[0]?.pinned_manager_id ?? null;

  // Наступний місяць по-київськи: передача НЕ рухає поточний.
  const today = kyivToday();
  const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const effectiveFrom = d.toISOString().slice(0, 10);

  await pool.query(
    `INSERT INTO loyalty_overrides (client_key, pinned_manager_id, pinned_from_month, updated_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (client_key) DO UPDATE SET pinned_manager_id = EXCLUDED.pinned_manager_id,
       pinned_from_month = EXCLUDED.pinned_from_month, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, toManagerId, effectiveFrom, auth.userId]);
  await pool.query(
    `INSERT INTO client_manager_history (client_key, from_manager_id, to_manager_id, effective_from, reason, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6)`, [clientKey, from, toManagerId, effectiveFrom, reason, auth.userId]);

  res.json({ ok: true, effectiveFrom, note: "Поточний місяць лишається за попереднім менеджером" });
});

dashboardRouter.get("/client-manager/history", async (req, res) => {
  const auth = req.auth!;
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  if (!(await canSeeClient(auth, clientKey))) return res.status(403).json({ error: "Forbidden" });
  const r = await pool.query<{ from_name: string | null; to_name: string; effective_from: string; reason: string | null; who: string | null; created_at: string }>(
    `SELECT fm.name AS from_name, tm.name AS to_name,
            to_char(h.effective_from,'YYYY-MM-DD') AS effective_from, h.reason,
            COALESCE(u.full_name, u.email) AS who,
            to_char(h.created_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS created_at
       FROM client_manager_history h
       LEFT JOIN managers fm ON fm.id = h.from_manager_id
       JOIN managers tm ON tm.id = h.to_manager_id
       LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.client_key = $1 ORDER BY h.created_at DESC LIMIT 50`, [clientKey]);
  res.json(r.rows.map((x) => ({
    fromManager: x.from_name, toManager: x.to_name, effectiveFrom: x.effective_from,
    reason: x.reason, changedBy: x.who, createdAt: x.created_at,
  })));
});

dashboardRouter.get("/repeat-plans-grid", async (req, res) => {
  const auth = req.auth!;
  const monthStr = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const planDate = `${monthStr}-01`;
  // Managers see only their own row (they propose their clients' plans); team
  // leads see their team; admin sees all (optional teamId).
  const teamId: number | null = auth.role === "manager" ? (auth.teamId ?? null)
    : auth.role === "team_lead" ? (auth.teamId ?? null)
    : (req.query.teamId ? Number(req.query.teamId) : null);
  const managerFilter: number | null = auth.role === "manager" ? (auth.managerId ?? null) : null;
  // includeInactive=1 → also show regulars who stopped ordering long ago
  // (замовклі) for reactivation planning; default shows only active regulars.
  const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";

  const params: unknown[] = [planDate];
  let teamCond = "";
  if (teamId != null) { params.push(teamId); teamCond = `AND m.team_id = $${params.length}`; }
  if (managerFilter != null) { params.push(managerFilter); teamCond += ` AND m.id = $${params.length}`; }

  const r = await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null; plan: string }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name, COALESCE(p.planned_value, 0) AS plan
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN plans p ON p.manager_id = m.id AND p.metric = 'repeat_payment_amount' AND p.plan_date = $1
      WHERE m.is_active ${teamCond}
      ORDER BY t.name NULLS LAST, m.name`,
    params
  );

  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  // Межі тижнів і робочі дні — ЯДРО (`money.monthWeeks`/`monthWorkingDays`).
  // Тут стояла власна копія `[1, 8, 15, 22, 29]`; поки копії збігались, різниці
  // не було видно, але «тиждень 2» на двох екранах мусить означати ОДНІ дні.
  const workingDays = money.monthWorkingDays(monthStr);
  const weeks = money.monthWeeks(monthStr).map((w) => ({
    label: w.label, from: w.fromDay, to: w.toDay, days: w.toDay - w.fromDay + 1,
  }));

  // Fact = received money (успішно 142 закрито в місяці + оплата снапшот) whose
  // client is a REPEAT client (2+ lifetime paid orders) — «заробіток по постійних».
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const monthEnd = `${monthStr}-${String(daysInMonth).padStart(2, "0")}`;
  const teamAnd = teamId != null ? `AND m.team_id = ${teamId}` : "";
  const REPEAT_CTE = `WITH repeat_clients AS (
       SELECT d.client_key FROM deals d
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL
       GROUP BY d.client_key HAVING COUNT(*) >= 2
     )`;
  const [succ, pay] = await Promise.all([
    pool.query<{ id: string; s: string }>(
      `${REPEAT_CTE}
       SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage='paid' AND d.status_id=142 AND d.closed_at_kommo IS NOT NULL
          AND d.client_key IN (SELECT client_key FROM repeat_clients)
          AND (d.closed_at_kommo ${KYIV})::date BETWEEN $1 AND $2 ${teamAnd}
        GROUP BY d.manager_id`, [planDate, monthEnd]),
    pool.query<{ id: string; s: string }>(
      `${REPEAT_CTE}
       SELECT d.manager_id AS id, COALESCE(SUM(d.price),0) AS s FROM deals d
         JOIN managers m ON m.id = d.manager_id AND m.is_active
        WHERE d.status_id IN (69716460,60412544)
          AND d.client_key IN (SELECT client_key FROM repeat_clients) ${teamAnd}
        GROUP BY d.manager_id`),
  ]);
  const numMap = (rows: { id: string; s: string }[]) => new Map(rows.map((x) => [Number(x.id), Number(x.s)]));
  const succM = numMap(succ.rows), payM = numMap(pay.rows);

  // Each manager's active regular clients (2+ lifetime paid AND ordered within
  // the active window), attributed to a single PRIMARY manager (most paid) so a
  // client shows under exactly one manager — same identity rule as /loyalty.
  const activeMonths = (await getSettings()).sleepingWindowMonths;
  const clientsRes = await pool.query<{ manager_id: number; client_key: string; name: string; orders: string; revenue: string; last_paid: string }>(
    `WITH scoped AS (
       SELECT d.client_key, d.manager_id, d.client_name, d.created_at_kommo, d.price
       FROM deals d
       JOIN managers m ON m.id = d.manager_id AND m.is_active
       JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
       WHERE d.client_key IS NOT NULL AND psm.funnel_stage = 'paid' ${teamAnd}
     ),
     agg AS (
       SELECT client_key,
              (array_agg(client_name ORDER BY created_at_kommo DESC))[1] AS name,
              COUNT(*) AS orders, COALESCE(SUM(price),0) AS revenue,
              MAX(created_at_kommo) AS last_paid
       FROM scoped GROUP BY client_key
     ),
     primary_mgr AS (
       SELECT client_key, manager_id FROM (
         SELECT client_key, manager_id,
                ROW_NUMBER() OVER (PARTITION BY client_key ORDER BY COUNT(*) DESC, MAX(created_at_kommo) DESC) AS rn
         FROM scoped GROUP BY client_key, manager_id
       ) z WHERE rn = 1
     )
     SELECT pm.manager_id, a.client_key, a.name, a.orders, a.revenue, a.last_paid
     FROM agg a JOIN primary_mgr pm ON pm.client_key = a.client_key
     WHERE a.orders >= 2 ${includeInactive ? "" : `AND a.last_paid >= now() - interval '${activeMonths} months'`}
     ORDER BY a.revenue DESC`
  );
  const isPhoneKey = (k: string) => /^\d{9,}$/.test(k);
  const clientKeys = clientsRes.rows.map((c) => c.client_key);

  // Per-client month plan + metadata (team-lead editable), and auto fact:
  //  weekFact = «Успішно» (142) closed in that week; monthFact = Σ weekFact +
  //  «Оплата отримана» снапшот для клієнта (снапшот недатований → лише в місяць).
  const [plansRes, factRes, snapRes, actRes] = await Promise.all([
    clientKeys.length ? pool.query<{ client_key: string; plan: string; forecast: string | null; realization_pct: string | null; international: boolean | null; we_do: boolean | null; call_link: string | null; comment: string | null; status: string }>(
      `SELECT client_key, plan, forecast, realization_pct, international, we_do, call_link, comment, status
         FROM repeat_client_plans WHERE month = $1 AND client_key = ANY($2)`, [planDate, clientKeys]) : { rows: [] as never[] },
    clientKeys.length ? pool.query<{ client_key: string; cday: number; s: string }>(
      `SELECT d.client_key, EXTRACT(DAY FROM (d.closed_at_kommo ${KYIV}))::int AS cday, COALESCE(SUM(d.price),0) AS s
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage='paid' AND d.status_id=142 AND d.closed_at_kommo IS NOT NULL
          AND (d.closed_at_kommo ${KYIV})::date BETWEEN $1 AND $2 AND d.client_key = ANY($3)
        GROUP BY d.client_key, cday`, [planDate, monthEnd, clientKeys]) : { rows: [] as never[] },
    clientKeys.length ? pool.query<{ client_key: string; s: string }>(
      `SELECT d.client_key, COALESCE(SUM(d.price),0) AS s FROM deals d
        WHERE d.status_id IN (69716460,60412544) AND d.client_key = ANY($1)
        GROUP BY d.client_key`, [clientKeys]) : { rows: [] as never[] },
    // Last real human activity (call/note from syncDealActivity) per client.
    clientKeys.length ? pool.query<{ client_key: string; la: string | null }>(
      `SELECT client_key, MAX(last_activity_at) AS la FROM deals
        WHERE client_key = ANY($1) GROUP BY client_key`, [clientKeys]) : { rows: [] as never[] },
  ]);
  const planByKey = new Map(plansRes.rows.map((p) => [p.client_key, p]));
  const snapByKey = new Map(snapRes.rows.map((x) => [x.client_key, Number(x.s)]));
  const actByKey = new Map((actRes.rows as { client_key: string; la: string | null }[]).map((x) => [x.client_key, x.la]));
  const weekIdxOfDay = (day: number) => { for (let i = 0; i < weeks.length; i++) if (day >= weeks[i].from && day <= weeks[i].to) return i; return weeks.length - 1; };
  const weekFactByKey = new Map<string, number[]>();
  for (const f of factRes.rows) {
    const arr = weekFactByKey.get(f.client_key) ?? weeks.map(() => 0);
    arr[weekIdxOfDay(Number(f.cday))] += Number(f.s);
    weekFactByKey.set(f.client_key, arr);
  }

  type RepeatClient = {
    clientKey: string; clientName: string; isCompany: boolean; identifier: string | null;
    orders: number; revenue: number; lastPaid: string; lastActivity: string | null; inactive: boolean;
    plan: number; fact: number; weekFact: number[]; status: string;
    forecast: string | null; realizationPct: number | null; international: boolean | null;
    weDo: boolean | null; callLink: string | null; comment: string | null;
  };
  const activeCutoffMs = Date.now() - activeMonths * 30 * 24 * 3600 * 1000;
  const clientsByMgr = new Map<number, RepeatClient[]>();
  for (const c of clientsRes.rows) {
    const individual = isPhoneKey(c.client_key);
    const weekFact = weekFactByKey.get(c.client_key) ?? weeks.map(() => 0);
    const p = planByKey.get(c.client_key);
    const list = clientsByMgr.get(c.manager_id) ?? [];
    list.push({
      clientKey: c.client_key,
      clientName: c.name,
      isCompany: !individual,
      identifier: individual ? c.client_key : null,
      orders: Number(c.orders),
      revenue: Number(c.revenue),
      lastPaid: c.last_paid,
      lastActivity: actByKey.get(c.client_key) ?? null,
      inactive: c.last_paid ? new Date(c.last_paid).getTime() < activeCutoffMs : true,
      plan: p ? Number(p.plan) : 0,
      fact: weekFact.reduce((s, v) => s + v, 0) + (snapByKey.get(c.client_key) ?? 0),
      weekFact,
      status: p?.status ?? "none",
      forecast: p?.forecast ?? null,
      realizationPct: p?.realization_pct != null ? Number(p.realization_pct) : null,
      international: p?.international ?? null,
      weDo: p?.we_do ?? null,
      callLink: p?.call_link ?? null,
      comment: p?.comment ?? null,
    });
    clientsByMgr.set(c.manager_id, list);
  }

  const teamsMap = new Map<number, { teamId: number; teamName: string; teamPlan: number; teamFact: number; managers: { managerId: number; name: string; plan: number; fact: number; clients: RepeatClient[] }[] }>();
  let totalPlan = 0, totalFact = 0;
  for (const row of r.rows) {
    const tid = row.team_id ?? 0;
    if (!teamsMap.has(tid)) teamsMap.set(tid, { teamId: tid, teamName: row.team_name ?? "Без команди", teamPlan: 0, teamFact: 0, managers: [] });
    const plan = Number(row.plan);
    const fact = (succM.get(row.id) ?? 0) + (payM.get(row.id) ?? 0);
    const t = teamsMap.get(tid)!;
    t.managers.push({ managerId: row.id, name: row.name, plan, fact, clients: clientsByMgr.get(row.id) ?? [] });
    t.teamPlan += plan; t.teamFact += fact;
    totalPlan += plan; totalFact += fact;
  }

  res.json({
    month: monthStr,
    daysInMonth,
    workingDays,
    weeks,
    teams: Array.from(teamsMap.values()),
    totalPlan, totalFact,
  });
});

/**
 * Історія «отриманих коштів» по одному постійному клієнту, помісячно (успішно
 * закриті 142 угоди повного циклу за датою закриття). Для плитки план-сітки:
 * піки/падіння замовлень + база для «плану з викликом» (+10–15%).
 * Повертає: history[{month, orders, revenue}] (13 міс), avgRecent (сер. по
 * останніх 3 активних міс.), suggestedPlan (avgRecent × 1.12) для челендж-плану.
 */
/**
 * РЕКОМЕНДАЦІЯ «скільки лідів треба взяти» (вкладка «Плани», розкривний рядок).
 *   залишок = max(0, план − прогноз по постійних)
 *   ₴ з ліда = конверсія × ср.чек;  треба лідів = ceil(залишок ÷ ₴ з ліда)
 * Канал конверсії: РНК → реклама, решта → лідоген (RNK_TEAM_IDS з ядра).
 *
 * 🔴 СУТО ПОХІДНИЙ, READ-ONLY: жодного запису в `plans` чи будь-куди — рекомендація лише
 * показується. План береться з `plans` як є (сирий), ядро планів не чіпається.
 * 🔴 ЧЕСНІСТЬ: немає постійних / конверсія null (entered<10) / немає чека → віддаємо null
 * і причину, а НЕ 0 і НЕ середнє по команді. Фронт малює «—» з підписом.
 */
dashboardRouter.get("/lead-recommendation", async (req, res) => {
  const auth = req.auth!;
  const monthStr = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  const period = (req.query.period as string) || "3m"; // month | 3m | year
  const planDate = `${monthStr}-01`;
  const [y, mo] = monthStr.split("-").map(Number);
  const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const from = period === "month" ? planDate
    : period === "year" ? `${y}-01-01`
    : new Date(Date.UTC(y, mo - 3, 1)).toISOString().slice(0, 10);

  // Роль-скоуп той самий, що в plans-grid: менеджер — себе, тімлід — свою команду.
  const teamId: number | null = auth.role === "manager" || auth.role === "team_lead"
    ? (auth.teamId ?? null) : (req.query.teamId ? Number(req.query.teamId) : null);
  const managerFilter: number | null = auth.role === "manager" ? (auth.managerId ?? null) : null;

  const { adSources } = await getSettings();
  const scope = { from, to: end, teamId, managerId: managerFilter };
  const [plansRes, forecast, convAds, convLg, checks, maxLeads] = await Promise.all([
    pool.query<{ id: number; name: string; team_id: number | null; plan: string }>(
      // 🔒 ЛИШЕ КОМЕРЦІЙНІ (те саме джерело, що stuckDealsGrouped): фінвідділ і команда
      // лідогенерації не продають — рекомендація «скільки лідів взяти» для них безглузда.
      `SELECT m.id, m.name, m.team_id, COALESCE(p.planned_value, 0) AS plan
         FROM managers m
         LEFT JOIN plans p ON p.manager_id = m.id AND p.metric = 'payment_amount' AND p.plan_date = $1
        WHERE m.is_active AND ${metrics.commercialManagerSql("m")}
          ${teamId != null ? "AND m.team_id = " + Number(teamId) : ""}
          ${managerFilter != null ? "AND m.id = " + Number(managerFilter) : ""}
        ORDER BY m.name`, [planDate]),
    metrics.repeatForecastByManager({ teamId, managerId: managerFilter }),
    metrics.conversionAdsByManager(scope, adSources),
    metrics.conversionLeadgenByManager(scope),
    money.avgCheckByManager(scope),
    metrics.maxMonthlyLeadsByManager(adSources, 6),
  ]);

  // ── ФОЛБЕК НА КОМАНДУ: коли в менеджера тонкий знаменник (<10) або немає успішних
  // угод у періоді — беремо показник КОМАНДИ в тому ж каналі. Агрегуємо на СУМАХ
  // (Σentered/Σwon, Σrevenue/Σdeals), а НЕ середнім із середніх — інакше маленький
  // менеджер важив би стільки ж, скільки великий. Пріоритет завжди в особистого.
  // Агрегати рахуємо ЛИШЕ по тому ростеру, який показуємо: інакше «конверсія команди/
  // компанії» включала б менеджерів, яких у видачі немає (напр. лідоген-команду).
  const rosterIds = new Set(plansRes.rows.map((r) => r.id));
  const teamConv = new Map<string, { entered: number; won: number }>();
  const addConv = (ch: string, tid: number | null, e: number, w: number) => {
    if (tid == null) return;
    const k = `${ch}:${tid}`;
    const cur = teamConv.get(k) ?? { entered: 0, won: 0 };
    cur.entered += e; cur.won += w; teamConv.set(k, cur);
  };
  for (const x of convAds) if (rosterIds.has(x.managerId)) addConv("ad", x.teamId, x.entered, x.won);
  for (const x of convLg) if (rosterIds.has(x.managerId)) addConv("leadgen", x.teamId, x.entered, x.won);
  const teamPct = (ch: string, tid: number | null): number | null => {
    const a = tid != null ? teamConv.get(`${ch}:${tid}`) : undefined;
    return a && a.entered >= 10 ? Math.round((a.won / a.entered) * 1000) / 10 : null;
  };
  // Третій рівень — КОМПАНІЯ (той самий канал). Теж на сумах, не середнім із середніх.
  const compConv = new Map<string, { entered: number; won: number }>();
  for (const [k, v] of teamConv) {
    const ch = k.split(":")[0];
    const cur = compConv.get(ch) ?? { entered: 0, won: 0 };
    cur.entered += v.entered; cur.won += v.won; compConv.set(ch, cur);
  }
  const companyPct = (ch: string): number | null => {
    const a = compConv.get(ch);
    return a && a.entered >= 10 ? Math.round((a.won / a.entered) * 1000) / 10 : null;
  };
  let compRev = 0, compDeals = 0;
  for (const x of checks) if (rosterIds.has(x.managerId)) { compRev += x.revenue; compDeals += x.successDeals; }
  const companyAvgCheck = (): number | null => (compDeals > 0 ? Math.round(compRev / compDeals) : null);
  const teamById = new Map(plansRes.rows.map((r) => [r.id, r.team_id]));
  const teamCheck = new Map<number, { revenue: number; deals: number }>();
  for (const x of checks) {
    if (!rosterIds.has(x.managerId)) continue;
    const tid = teamById.get(x.managerId);
    if (tid == null) continue;
    const cur = teamCheck.get(tid) ?? { revenue: 0, deals: 0 };
    cur.revenue += x.revenue; cur.deals += x.successDeals; teamCheck.set(tid, cur);
  }
  const teamAvgCheck = (tid: number | null): number | null => {
    const a = tid != null ? teamCheck.get(tid) : undefined;
    return a && a.deals > 0 ? Math.round(a.revenue / a.deals) : null;
  };

  const fMap = new Map(forecast.map((x) => [x.managerId, x]));
  const adMap = new Map(convAds.map((x) => [x.managerId, x]));
  const lgMap = new Map(convLg.map((x) => [x.managerId, x]));
  const chkMap = new Map(checks.map((x) => [x.managerId, x.avgCheck]));

  const rows = plansRes.rows.map((r) => {
    const plan = Math.round(Number(r.plan));
    const isRnk = r.team_id != null && metrics.RNK_TEAM_IDS.includes(r.team_id);
    const channel = isRnk ? "ad" : "leadgen";
    const conv = (isRnk ? adMap : lgMap).get(r.id) ?? null;
    const f = fMap.get(r.id) ?? null;
    const avgCheck = chkMap.get(r.id) ?? null;
    const forecastVal = f?.forecast ?? 0;
    const remainder = Math.max(0, plan - forecastVal);
    // Пріоритет ОСОБИСТОМУ показнику; команда — лише коли особистого немає.
    // Ланцюг фолбеку СТРОГО зверху вниз: особиста → команда → компанія → «—».
    // Кожен наступний рівень підставляється ЛИШЕ коли попереднього немає.
    const ownPct = conv?.cohortPct ?? null;
    const tPct = ownPct == null ? teamPct(channel, r.team_id) : null;
    const cPct = ownPct == null && tPct == null ? companyPct(channel) : null;
    const convPct = ownPct ?? tPct ?? cPct;
    const conversionSource: "own" | "team" | "company" | null =
      ownPct != null ? "own" : tPct != null ? "team" : cPct != null ? "company" : null;
    const tCheck = avgCheck == null ? teamAvgCheck(r.team_id) : null;
    const cCheck = avgCheck == null && tCheck == null ? companyAvgCheck() : null;
    const effCheck = avgCheck ?? tCheck ?? cCheck;
    const avgCheckSource: "own" | "team" | "company" | null =
      avgCheck != null ? "own" : tCheck != null ? "team" : cCheck != null ? "company" : null;
    const perLead = convPct != null && effCheck != null ? Math.round((convPct / 100) * effCheck) : null;
    // Залишок 0 (постійні покривають план) → треба 0 лідів, і конверсія тут не потрібна:
    // ділити нічого. Інакше менеджер із повністю закритим планом отримував «—» і сигнал
    // «план нижчий за базу» губився саме там, де він найголосніший.
    const leadsNeeded = f != null && plan > 0 && remainder === 0 ? 0
      : perLead != null && perLead > 0 ? Math.ceil(remainder / perLead) : null;

    // Причини «—» — показуємо ЧОМУ, а не мовчазний нуль.
    const reasons: string[] = [];
    if (plan <= 0) reasons.push("немає плану на місяць");
    if (!f || f.clients === 0) reasons.push("немає постійних клієнтів з історією");
    // Коли залишок 0 — конверсія й чек у розрахунку не беруть участі, тож і «бракує даних»
    // про них казати нечесно: рекомендація повна.
    if (remainder !== 0 || f == null || plan <= 0) {
      if (convPct == null) reasons.push("немає конверсії — ні особистої, ні командної, ні по компанії");
      if (effCheck == null) reasons.push("немає середнього чека — ні особистого, ні командного, ні по компанії");
    }

    // Дві позначки (лише сигнал, на розрахунок НЕ впливають):
    //  • planBelowBase — прогноз по постійних перевищує план: «треба 0» насправді означає
    //    не «все добре», а що план нижчий за базу постійних → сигнал перегляду плану;
    //  • unreachable — потреба перевищує історичний максимум менеджера за 6 міс: цифра
    //    арифметично правильна, але як ціль нечитабельна (структура не тягне).
    const mx = maxLeads.get(r.id);
    const maxMonthlyLeads = mx ? (isRnk ? mx.ad : mx.leadgen) : 0;
    const planBelowBase = f != null && f.clients > 0 && plan > 0 && forecastVal > plan;
    const unreachable = leadsNeeded != null && leadsNeeded > 0 && leadsNeeded > maxMonthlyLeads;
    // ⚠️ maxMonthlyLeads === 0 — це НЕ «немає даних», а «за 6 міс не взято жодного ліда
    // в цьому каналі», тобто найбільш недосяжний випадок. Ранній guard `> 0` глушив
    // позначку саме там, де вона найпотрібніша: Семенюк — треба 601, максимум 0 → бейдж
    // не спалахував, а в Дмитрука з максимумом 1 спалахував. Тепер поріг лише на потребі.

    return {
      managerId: r.id, name: r.name, teamId: r.team_id, channel,
      plan,
      maxMonthlyLeads, planBelowBase, unreachable,
      forecast: f ? forecastVal : null, forecastClients: f?.clients ?? 0,
      remainder: f ? remainder : null,
      conversionPct: convPct, conversionEntered: conv?.entered ?? 0, conversionWon: conv?.won ?? 0,
      avgCheck: effCheck, ownAvgCheck: avgCheck, avgCheckSource,
      conversionSource,
      perLead, leadsNeeded,
      enough: leadsNeeded != null && f != null && plan > 0,
      reasons,
    };
  });
  res.json({ month: monthStr, period, scope: { from, to: end }, rows });
});

dashboardRouter.get("/repeat-client-history", async (req, res) => {
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const r = await pool.query<{ month: string; orders: string; revenue: string }>(
    `SELECT to_char(date_trunc('month', (d.closed_at_kommo ${KYIV})), 'YYYY-MM') AS month,
            COUNT(*) AS orders, COALESCE(SUM(d.price), 0) AS revenue
       FROM deals d
      WHERE d.client_key = $1 AND d.pipeline_id = ANY($2) AND d.status_id = 142
        AND d.closed_at_kommo IS NOT NULL
        AND (d.closed_at_kommo ${KYIV})::date >= (CURRENT_DATE - INTERVAL '13 months')
      GROUP BY 1 ORDER BY 1`,
    [clientKey, [8921932, 155304]]
  );
  const history = r.rows.map((x) => ({ month: x.month, orders: Number(x.orders), revenue: Number(x.revenue) }));
  // Середнє по останніх 3 місяцях, де були оплати (щоб пусті місяці не занижували).
  const active = history.filter((h) => h.revenue > 0).slice(-3);
  const avgRecent = active.length ? Math.round(active.reduce((s, h) => s + h.revenue, 0) / active.length) : 0;
  res.json({ history, avgRecent, suggestedPlan: Math.round(avgRecent * 1.12) });
});

/**
 * Save a per-client repeat-plan row (monthly plan + metadata from the КВП sheet:
 * forecast volume, realization %, international y/n, we-do y/n, call link,
 * comment). Admin/team-lead; a team-lead may edit only their own team's clients.
 * The frontend sends the FULL row so the upsert never nulls untouched fields.
 */
dashboardRouter.post("/repeat-client-plan", async (req, res) => {
  const auth = req.auth!;
  const b = req.body ?? {};
  const clientKey = String(b.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const month = ((b.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const managerId = b.managerId != null ? Number(b.managerId) : null;
  // Scope: a manager may edit only their own clients (and their submission needs
  // approval); a team lead only their team; admin anyone.
  if (auth.role === "manager") {
    if (managerId !== auth.managerId) return res.status(403).json({ error: "Лише свої клієнти" });
  } else if (auth.role === "team_lead") {
    if (managerId != null) {
      const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
      if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
    }
  } else if (!isAdminScope(auth)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  // Manager submission → pending (awaits team-lead approval); team-lead/admin → approved.
  const status = auth.role === "manager" ? "pending" : "approved";
  const num = (v: unknown) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v));
  await pool.query(
    `INSERT INTO repeat_client_plans
       (client_key, month, manager_id, plan, forecast, realization_pct, international, we_do, call_link, comment, status, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (client_key, month) DO UPDATE SET
       manager_id = EXCLUDED.manager_id, plan = EXCLUDED.plan, forecast = EXCLUDED.forecast,
       realization_pct = EXCLUDED.realization_pct, international = EXCLUDED.international, we_do = EXCLUDED.we_do,
       call_link = EXCLUDED.call_link, comment = EXCLUDED.comment, status = EXCLUDED.status,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [clientKey, month, managerId, num(b.plan) ?? 0, str(b.forecast), num(b.realizationPct), bool(b.international), bool(b.weDo), str(b.callLink), str(b.comment), status, auth.userId]
  );
  await pool.query(
    `INSERT INTO repeat_client_plan_history (client_key, month, changed_by, action, plan, status, comment)
     VALUES ($1, $2, $3, 'save', $4, $5, $6)`,
    [clientKey, month, auth.userId, num(b.plan) ?? 0, status, str(b.comment)]
  );
  res.json({ ok: true, status });
});

/** Team-lead/admin approves (or rejects) a manager-submitted client plan. */
dashboardRouter.post("/repeat-client-plan/approve", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const b = req.body ?? {};
  const clientKey = String(b.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const month = ((b.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const status = b.status === "pending" ? "pending" : "approved";
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(
      `SELECT m.team_id FROM repeat_client_plans p LEFT JOIN managers m ON m.id = p.manager_id WHERE p.client_key = $1 AND p.month = $2`,
      [clientKey, month]
    );
    if (chk.rows[0] && chk.rows[0].team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  await pool.query(
    `UPDATE repeat_client_plans SET status = $3, approved_by = $4, approved_at = now()
     WHERE client_key = $1 AND month = $2`,
    [clientKey, month, status, auth.userId]
  );
  await pool.query(
    `INSERT INTO repeat_client_plan_history (client_key, month, changed_by, action, status)
     VALUES ($1, $2, $3, 'approve', $4)`,
    [clientKey, month, auth.userId, status]
  );
  res.json({ ok: true, status });
});

/** Затвердити ВСІ pending-плани за місяць (тімлід — своя команда, адмін — усі
 *  або обрана команда). Одним кліком закриває чергу на затвердження. */
dashboardRouter.post("/repeat-client-plan/approve-all", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const b = req.body ?? {};
  const month = ((b.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  let teamId = b.teamId != null ? Number(b.teamId) : null;
  if (auth.role === "team_lead") teamId = auth.teamId;

  const params: unknown[] = [month, auth.userId];
  const conds = ["p.month = $1", "p.status = 'pending'"];
  if (teamId) { params.push(teamId); conds.push(`m.team_id = $${params.length}`); }

  const upd = await pool.query<{ client_key: string }>(
    `UPDATE repeat_client_plans p SET status = 'approved', approved_by = $2, approved_at = now()
       FROM managers m
      WHERE p.manager_id = m.id AND ${conds.join(" AND ")}
      RETURNING p.client_key`,
    params
  );
  for (const row of upd.rows) {
    await pool.query(
      `INSERT INTO repeat_client_plan_history (client_key, month, changed_by, action, status)
       VALUES ($1, $2, $3, 'approve', 'approved')`,
      [row.client_key, month, auth.userId]
    );
  }
  res.json({ ok: true, approved: upd.rowCount });
});

/** Історія змін плану по клієнту (хто/коли/дія/план/статус). */
dashboardRouter.get("/repeat-client-plan/history", async (req, res) => {
  const auth = req.auth!;
  if (auth.role === "manager") return res.status(403).json({ error: "Forbidden" });
  const clientKey = String(req.query.clientKey ?? "").trim();
  if (!clientKey) return res.status(400).json({ error: "clientKey обовʼязковий" });
  const month = ((req.query.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const r = await pool.query<{ changed_at: string; action: string; plan: string | null; status: string | null; comment: string | null; who: string | null }>(
    `SELECT h.changed_at, h.action, h.plan, h.status, h.comment, COALESCE(mm.name, u.email) AS who
       FROM repeat_client_plan_history h
       LEFT JOIN users u ON u.id = h.changed_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE h.client_key = $1 AND h.month = $2
      ORDER BY h.changed_at DESC LIMIT 100`,
    [clientKey, month]
  );
  res.json({
    history: r.rows.map((x) => ({
      changedAt: x.changed_at, action: x.action,
      plan: x.plan != null ? Number(x.plan) : null,
      status: x.status, comment: x.comment, who: x.who,
    })),
  });
});

/** Read a manager's monthly funnel plan (for the plan editor). Admin/team-lead
 *  only; a team-lead may read only their own team's managers. */
dashboardRouter.get("/funnel-plan", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) return res.status(403).json({ error: "Forbidden" });
  const managerId = Number(req.query.managerId);
  const month = ((req.query.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const r = await pool.query<{ stage: string; planned_value: string }>(
    `SELECT stage, planned_value FROM funnel_plans WHERE manager_id = $1 AND month = $2`,
    [managerId, month]
  );
  const plans: Record<string, number> = {};
  for (const row of r.rows) plans[row.stage] = Number(row.planned_value);
  res.json({ managerId, month, plans });
});

/** Set a manager's monthly funnel plan (team-lead / admin). */
dashboardRouter.post("/funnel-plan", async (req, res) => {
  const auth = req.auth!;
  if (!isAdminOrLead(auth)) {
    return res.status(403).json({ error: "Лише тімлід або адміністратор" });
  }
  const managerId = Number(req.body?.managerId);
  const monthRaw = String(req.body?.month ?? "").slice(0, 7);
  const plans = req.body?.plans as Record<string, number> | undefined;
  if (!managerId || !/^\d{4}-\d{2}$/.test(monthRaw) || !plans) {
    return res.status(400).json({ error: "managerId, month (YYYY-MM) та plans обовʼязкові" });
  }
  if (auth.role === "team_lead") {
    const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
    if (chk.rows[0]?.team_id !== auth.teamId) return res.status(403).json({ error: "Лише своя команда" });
  }
  const month = monthRaw + "-01";
  for (const stage of FUNNEL_ORDER) {
    const value = Number(plans[stage] ?? 0);
    await pool.query(
      `INSERT INTO funnel_plans (manager_id, month, stage, planned_value, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (manager_id, month, stage) DO UPDATE SET
         planned_value = EXCLUDED.planned_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [managerId, month, stage, value, auth.userId]
    );
  }
  res.json({ ok: true });
});

// ── Департаментні плани КВП (Звіт КВП) ──────────────────────────────────
// Top-down цілі по відділу на місяць, editable лише КВП (admin). Виручку сюди
// НЕ дублюємо (вона в plans, сума по менеджерах — read-only у звіті); тут решта
// цілей, щоб «Викон.%» був реальним для кожного рядка матриці План/Факт.
// 🔴 КРОК Г #6: ДЕПРЕКЕЙТ дублів виручки. `success`, `new_revenue`, `repeat_revenue`,
// `received_total`, `dispatched_sum` — це та сама виручка, що вже в `plans`
// (Σ payment_amount) → деривуються з `plans.managerPlan` (єдине джерело планів), НЕ
// зберігаються вручну. Прибрані з writable-набору (POST їх відхиляє, GET не віддає).
// kvp_plans лишає ЛИШЕ КВП-ручні (чек, бюджет, цілі, avg_per_manager, к-ті).
const DEPRECATED_KVP_METRICS = new Set([
  "success", "new_revenue", "repeat_revenue", "received_total", "dispatched_sum",
]);
const KVP_PLAN_METRICS = [
  "avg_check",
  "created_full_cycle", "dispatched_cars", "new_clients", "repeat_clients",
  "ad_leads", "ad_conversion", "target_leads",
  "transferred", "transfer_success", "leadgen_conversion",
  // Ручні рядки звіту КВП (структура файлу керівника), яких немає в ядрі:
  "success_deals",       // Успішні угоди, шт
  "paid_deals",          // Оплата отримана, шт
  "managers_count",      // Менеджерів у продажу
  "avg_per_manager",     // Середня сума на менеджера
  "nontarget_leads",     // Не цільові ліди
  "ad_revenue",          // Дохід з реклами, грн
  "ad_dispatched",       // Відправлені авто з реклами, шт
  "ad_avg_check",        // Середній чек реклами
  "leadgen_revenue",     // Дохід з лідогену, грн
  "leadgen_dispatched",  // Відправлені авто з лідогену, шт
  // Повна таблиця v3 — редаговані плани виручки (декомпозуються на тижні) + цілі-відношення.
  "new_revenue_plan",    // Нові — отримано (план РНК)
  "repeat_revenue_plan", // Постійні — отримано (план РПК)
  "success_plan",        // Успішно закриті (142) план
  "cac_target",          // CAC-ціль (місяць-онлі)
  "cycle_target",        // Середній цикл-ціль (днів)
  "conversion_target",   // Конверсія реклами-ціль (%)
];
// Плани по командах team_revenue_<teamId> ТЕЖ депрекейт (Крок Г #6): деривуються з
// managerPlan(teamId). Лишаємо readable у GET для сумісності FE-гріда, доки КВП-UI не
// переведено на derived (наступна фаза) — але POST більше НЕ пише нові.
const kvpMetricAllowed = (m: string) => KVP_PLAN_METRICS.includes(m);

dashboardRouter.get("/kvp-plan", async (req, res) => {
  const auth = req.auth!;
  // Гейт по ЕКРАНУ «Звіт КВП» (screen_access.kvp), а не по scope-compat ролі: роль kvp
  // company-scope → auth.role='company', тож старий `role!=='admin'` її хибно різав.
  // Екран мають admin/ceo/opdir/kvp; решта — ні (поведінка для них байт-у-байт).
  if (!roleHasTab(auth.roleKey, "kvp")) return res.status(403).json({ error: "Forbidden" });
  const month = ((req.query.month as string) || new Date().toISOString().slice(0, 7)) + "-01";
  const r = await pool.query<{ metric: string; planned_value: string }>(
    `SELECT metric, planned_value FROM kvp_plans WHERE month = $1`,
    [month]
  );
  const plans: Record<string, number> = {};
  // КРОК Г #6: депрекейтнуті дублі виручки НЕ віддаємо (деривуються з plans).
  for (const row of r.rows) {
    if (DEPRECATED_KVP_METRICS.has(row.metric)) continue;
    plans[row.metric] = Number(row.planned_value);
  }
  res.json({ month, plans });
});

/** Set department KVP targets for a month (admin/КВП only). Null/empty deletes. */
dashboardRouter.post("/kvp-plan", async (req, res) => {
  const auth = req.auth!;
  if (!roleHasTab(auth.roleKey, "kvp")) return res.status(403).json({ error: "Лише КВП (адміністратор)" });
  const monthRaw = String(req.body?.month ?? "").slice(0, 7);
  const plans = req.body?.plans as Record<string, unknown> | undefined;
  if (!/^\d{4}-\d{2}$/.test(monthRaw) || !plans || typeof plans !== "object") {
    return res.status(400).json({ error: "month (YYYY-MM) та plans обовʼязкові" });
  }
  const month = monthRaw + "-01";
  for (const [metric, raw] of Object.entries(plans)) {
    if (!kvpMetricAllowed(metric)) continue;
    const value = raw === "" || raw == null ? null : Number(raw);
    if (value == null || !Number.isFinite(value)) {
      await pool.query(`DELETE FROM kvp_plans WHERE month = $1 AND metric = $2`, [month, metric]);
      continue;
    }
    await pool.query(
      `INSERT INTO kvp_plans (month, metric, planned_value, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (month, metric) DO UPDATE SET
         planned_value = EXCLUDED.planned_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [month, metric, value, auth.userId]
    );
  }
  res.json({ ok: true });
});

// 🪦 /kvp-extra ЗНЯТО 03.09.2026 — рішення власника: «на Звіті КВП відправлені авто НЕ
// потрібні, у Статистиках — так». А ДЕ ЦЕ ТЕПЕР: «відправлені авто» живуть РІВНО в
// Статистиках (`machines_dispatched`, означення з 07.2026 — `core/dispatched.ts`).
// Споживачів не мав, доведено ТРИЧІ з контролем предиката: `fetchKvpExtra` 0 викликів у
// джерелі (сусіди `fetchKvpReport`/`fetchKvpPlan` по 2), літерала «/dashboard/kvp-extra» у
// прод-бандлі 0 (ті самі сусіди по 2), і те саме незалежно записав інший чат у `gates.ts`.
// Ядрові функції, які він кликав (`money.receivedByChannel`, `money.receivedMoney`),
// лишаються — у кожної по 7 інших вживань, зняття роута нікого не осиротило.

// ───────────────────────── КРОК Д: КОМПОЗИТНИЙ ЗВІТ КВП (/kvp-report) ─────────────────────────

// Класифікація команд для «двигунів» (CLAUDE.md §Канали): РНК (реклама) = Безпамятний/
// Михальчевська; лідоген = назва містить «лідоген» АБО teamId 11 (відділ лідогенерації);
// решта = РПК (повний цикл). Крок Д owner-review: фінвідділ (teamId 12) — НЕ sales, прибрати.
const KVP_FINANCE_TEAM_IDS = new Set([12]);   // «Финансовый отдел» — не sales-юніт → зі звіту геть
const KVP_LEADGEN_TEAM_IDS = new Set([11]);   // «Таня Ковтонюк (лідогенерація)» — лишити, логіка окремо
const RNK_TEAM_IDS = new Set(metrics.RNK_TEAM_IDS); // джерело правди — core/metrics (без дублю числа)
const kvpTeamKind = (teamId: number, name: string): "rpk" | "rnk" | "leadgen" =>
  (KVP_LEADGEN_TEAM_IDS.has(teamId) || /лідоген|лидоген/i.test(name)) ? "leadgen" : RNK_TEAM_IDS.has(teamId) ? "rnk" : "rpk";

/** Резолвер scope КВП: preset (day/week/month/quarter/year) навколо `date` АБО custom from/to. */
function resolveKvpScope(preset: string, date: string, from?: string | null, to?: string | null): { from: string; to: string; prevFrom: string; prevTo: string; label: string; isCurrent: boolean } {
  const kyivToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const anchor = date || kyivToday;
  const d = new Date(anchor + "T00:00:00Z");
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const shift = (x: Date, days: number) => { const c = new Date(x); c.setUTCDate(c.getUTCDate() + days); return c; };
  let f: string, t: string, pf: string, pt: string, label: string;
  if (from && to) {
    f = from; t = to;
    const span = Math.round((new Date(t + "T00:00:00Z").getTime() - new Date(f + "T00:00:00Z").getTime()) / 864e5) + 1;
    pt = iso(shift(new Date(f + "T00:00:00Z"), -1)); pf = iso(shift(new Date(pt + "T00:00:00Z"), -(span - 1)));
    label = `${f} — ${t}`;
  } else if (preset === "day") {
    f = t = iso(d); pf = pt = iso(shift(d, -1)); label = iso(d);
  } else if (preset === "week") {
    const dow = (d.getUTCDay() + 6) % 7; const mon = shift(d, -dow);
    f = iso(mon); t = iso(shift(mon, 6)); pf = iso(shift(mon, -7)); pt = iso(shift(mon, -1)); label = `Тиждень ${f}`;
  } else if (preset === "quarter") {
    const q = Math.floor(d.getUTCMonth() / 3); const y = d.getUTCFullYear();
    f = `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`; t = iso(new Date(Date.UTC(y, q * 3 + 3, 0)));
    pf = `${q === 0 ? y - 1 : y}-${String((q === 0 ? 4 : q) * 3 - 2).padStart(2, "0")}-01`; pt = iso(new Date(Date.UTC(q === 0 ? y - 1 : y, (q === 0 ? 4 : q) * 3, 0)));
    label = `Q${q + 1} ${y}`;
  } else if (preset === "year") {
    const y = d.getUTCFullYear(); f = `${y}-01-01`; t = `${y}-12-31`; pf = `${y - 1}-01-01`; pt = `${y - 1}-12-31`; label = `${y}`;
  } else { // month (default)
    const y = d.getUTCFullYear(), mo = d.getUTCMonth();
    f = `${y}-${String(mo + 1).padStart(2, "0")}-01`; t = iso(new Date(Date.UTC(y, mo + 1, 0)));
    pf = `${mo === 0 ? y - 1 : y}-${String(mo === 0 ? 12 : mo).padStart(2, "0")}-01`; pt = iso(new Date(Date.UTC(mo === 0 ? y - 1 : y, mo === 0 ? 12 : mo, 0)));
    const MN = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
    label = `${MN[mo]} ${y}`;
  }
  const isCurrent = f <= kyivToday && kyivToday <= t;
  return { from: f, to: t, prevFrom: pf, prevTo: pt, label, isCurrent };
}


/**
 * КРОК Д фінал A — ЛІНИВИЙ ДЕТАЛЬНИЙ дрил менеджера (weeks→days). Admin-only. Тижні
 * Т1–Т5 місяця, у кожному — дні; по КОЖНОМУ тижню й дню ОДНАКОВИЙ набір: створено
 * угод · взято лідів (ad/lg) · відправлено авто (load_at) · отримано коштів · очікування
 * (зона за плановою датою). ТІЛЬКИ збірка з ядра. Гейт: Σ днів==тиждень, Σ тижнів==місяць
 * по КОЖНОМУ показнику (тиждень.total = Σ днів; monthTotals = Σ тижнів).
 */
dashboardRouter.get("/kvp-report/manager-detail", async (req, res) => {
  const auth = req.auth!;
  const managerId = Number(req.query.managerId);
  if (!managerId) return res.status(400).json({ error: "managerId обовʼязковий" });
  // Роль-скоуп ЯК У ЗВІТІ (E7): manager/team_lead — лише СВОЯ КОМАНДА (менеджер бачить
  // рядки колег → може розгорнути їхню деталь); admin — будь-хто. requested managerId має
  // належати дозволеному ростеру запитувача, інакше 403 (без витоку в чужі команди).
  if (auth.role === "manager" || auth.role === "team_lead") {
    const myTeam = auth.role === "team_lead"
      ? auth.teamId
      : (await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [auth.managerId])).rows[0]?.team_id ?? null;
    const tgt = (await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId])).rows[0]?.team_id ?? null;
    if (myTeam == null ? managerId !== auth.managerId : tgt !== myTeam) return res.status(403).json({ error: "Forbidden" });
  }
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: "from/to (YYYY-MM-DD) обовʼязкові" });
  const scope: metrics.MetricScope = { managerId, from, to };
  const mRow = (await pool.query<{ name: string; team_id: number | null }>(`SELECT name, team_id FROM managers WHERE id = $1`, [managerId])).rows[0];

  // 📊 Розгортка по днях за макетом 06.08.2026 читається ТИМИ САМИМИ смугами, що
  // рядок менеджера, тож день мусить нести той самий набір: активність (створено /
  // авто / ДЗВІНКИ) · ①/⑨/② · ВИСТАВЛЕНО РАХУНКІВ того дня · сер. чек ② того дня.
  // ① і ⑨ окремо — бо «сума двох станів» без розкладу і є та сама поломка, з якої
  // почалась історія Антипенка.
  const [createdRows, splitRows, leadsRows, dispRows, recvRows, expRows, sucRows, paidRows, callDayRows, invDayRows, cohortRows] = await Promise.all([
    metrics.createdByBucket(scope, "day"),
    metrics.createdSplitByBucket(scope, "day"),
    metrics.leadsTakenByBucket(scope, "day", true),
    metrics.dispatchedByLoadBucket(scope, "day"),
    money.receivedByManagerBucket({ managerId, from, to }, "day"),
    metrics.expectedByManagerDay({ managerId }),
    money.successByManagerBucket({ managerId, from, to }, "day"),
    money.paidOnlyByManagerBucket({ managerId, from, to }, "day"),
    reportCuts.callsByManagerDay(from, to, { managerId }),
    reportCuts.invoicedByManagerDay(from, to, { managerId }),
    reportCuts.dispatchCohortByManagerDay(from, to, { managerId }),
  ]);

  // 🔀 Е4: `crAd/crLeadgen/crOther/crNoChannel` — партиція СТВОРЕНОГО за каналом.
  // 🔴 НЕ плутати з `leadsAd/leadsLeadgen/leadsOther`: ті рахують ЛІДИ (інша
  // популяція, інший запит). Дві сімʼї поруч мусять лишатись підписаними окремо —
  // саме тому вони й названі по-різному, а не «ad/leadgen» двічі.
  type Cell = { created: number; newCount: number; repeatCount: number; undefCount: number; crAd: number; crLeadgen: number; crOther: number; crNoChannel: number; leadsAd: number; leadsLeadgen: number; leadsOther: number; dispatched: number; dispRepeat: number; dispLeadgen: number; dispAd: number; dispUndef: number; dispSum: number; dispPaid: { deals: number; sum: number }; dispAwait: { deals: number; sum: number }; received: { deals: number; revenue: number }; expected: { deals: number; sum: number }; success: { deals: number; revenue: number }; paid: { deals: number; revenue: number }; talks: number; attempts: number; invoiced: { deals: number; sum: number } };
  const zero = (): Cell => ({ created: 0, newCount: 0, repeatCount: 0, undefCount: 0, crAd: 0, crLeadgen: 0, crOther: 0, crNoChannel: 0, leadsAd: 0, leadsLeadgen: 0, leadsOther: 0, dispatched: 0, dispRepeat: 0, dispLeadgen: 0, dispAd: 0, dispUndef: 0, dispSum: 0, dispPaid: { deals: 0, sum: 0 }, dispAwait: { deals: 0, sum: 0 }, received: { deals: 0, revenue: 0 }, expected: { deals: 0, sum: 0 }, success: { deals: 0, revenue: 0 }, paid: { deals: 0, revenue: 0 }, talks: 0, attempts: 0, invoiced: { deals: 0, sum: 0 } });
  const dayMap = new Map<string, Cell>();
  const dget = (d: string) => { let e = dayMap.get(d); if (!e) { e = zero(); dayMap.set(d, e); } return e; };
  for (const r of createdRows) dget(r.bucket).created += r.deals;
  for (const r of splitRows) { const e = dget(r.bucket); e.newCount += r.newCount; e.repeatCount += r.repeatCount; e.undefCount += r.undefCount;
    e.crAd += r.adCount; e.crLeadgen += r.leadgenCount; e.crOther += r.otherCount; e.crNoChannel += r.noChannelCount; }
  for (const r of leadsRows) { const e = dget(r.bucket); const c = (r as { channel?: string }).channel; if (c === "ad") e.leadsAd += r.deals; else if (c === "leadgen") e.leadsLeadgen += r.deals; else e.leadsOther += r.deals; }
  for (const r of dispRows) { const e = dget(r.ym); e.dispatched += r.deals; e.dispRepeat += r.repeat; e.dispLeadgen += r.leadgen; e.dispAd += r.ad; e.dispUndef += r.undef; }
  for (const r of recvRows) if (r.managerId === managerId) { const e = dget(r.bucket); e.received.deals += r.deals; e.received.revenue += r.revenue; }
  for (const r of expRows) if (r.day >= from && r.day <= to) { const e = dget(r.day); e.expected.deals += r.deals; e.expected.sum += r.sum; }
  for (const r of sucRows) if (r.managerId === managerId) { const e = dget(r.bucket); e.success.deals += r.deals; e.success.revenue += r.revenue; }
  for (const r of paidRows) if (r.managerId === managerId) { const e = dget(r.bucket); e.paid.deals += r.deals; e.paid.revenue += r.revenue; }
  for (const r of callDayRows) { const e = dget(r.day); e.talks += r.talks; e.attempts += r.attempts; }
  for (const r of invDayRows) { const e = dget(r.day); e.invoiced.deals += r.deals; e.invoiced.sum += r.sum; }
  // 🟫 Когорта дня: авто, відправлені того дня, і що з ними ЗАРАЗ. `paid + await == deals`
  // за побудовою — саме це робить смугу перевірною очима.
  for (const r of cohortRows) { const e = dget(r.day);
    e.dispSum += r.sum;
    e.dispPaid.deals += r.paidDeals; e.dispPaid.sum += r.paidSum;
    e.dispAwait.deals += r.awaitDeals; e.dispAwait.sum += r.awaitSum; }

  const addCell = (a: Cell, b: Cell): Cell => ({ created: a.created + b.created, newCount: a.newCount + b.newCount, repeatCount: a.repeatCount + b.repeatCount, undefCount: a.undefCount + b.undefCount, crAd: a.crAd + b.crAd, crLeadgen: a.crLeadgen + b.crLeadgen, crOther: a.crOther + b.crOther, crNoChannel: a.crNoChannel + b.crNoChannel, leadsAd: a.leadsAd + b.leadsAd, leadsLeadgen: a.leadsLeadgen + b.leadsLeadgen, leadsOther: a.leadsOther + b.leadsOther, dispatched: a.dispatched + b.dispatched, dispRepeat: a.dispRepeat + b.dispRepeat, dispLeadgen: a.dispLeadgen + b.dispLeadgen, dispAd: a.dispAd + b.dispAd, dispUndef: a.dispUndef + b.dispUndef, dispSum: a.dispSum + b.dispSum, dispPaid: { deals: a.dispPaid.deals + b.dispPaid.deals, sum: a.dispPaid.sum + b.dispPaid.sum }, dispAwait: { deals: a.dispAwait.deals + b.dispAwait.deals, sum: a.dispAwait.sum + b.dispAwait.sum }, received: { deals: a.received.deals + b.received.deals, revenue: a.received.revenue + b.received.revenue }, expected: { deals: a.expected.deals + b.expected.deals, sum: a.expected.sum + b.expected.sum }, success: { deals: a.success.deals + b.success.deals, revenue: a.success.revenue + b.success.revenue }, paid: { deals: a.paid.deals + b.paid.deals, revenue: a.paid.revenue + b.paid.revenue }, talks: a.talks + b.talks, attempts: a.attempts + b.attempts, invoiced: { deals: a.invoiced.deals + b.invoiced.deals, sum: a.invoiced.sum + b.invoiced.sum } });
  const kyivToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  /**
   * 🔴 БЛОКИ — ПО ЗАПИТАНОМУ ДІАПАЗОНУ, А НЕ ПО МІСЯЦЮ `from` (20.08.2026).
   *
   * Було `fixedWeekBlocks(monthStart)`: блоки будувались лише для місяця, у який
   * потрапив `from`, а дні поза ним відсіювались фільтром — і зникали НЕ ЛИШЕ з
   * тижнів, а й із `monthTotals`, бо той рахується як Σ тижнів. Тобто в режимі
   * «Період» через межу місяця (15.07–20.08) підсумок розкриття мовчки не бачив
   * серпня. Для ПОВНОГО місяця обидві функції дають однакові блоки, тож числа
   * місячного вигляду не зрушились ані на копійку — гейт `#93` це й доводить.
   */
  const weeks = weekBlocksForRange(from, to).map((w) => {
    const days = [...dayMap.entries()].filter(([d]) => d >= w.from && d <= w.to).sort((a, b) => a[0].localeCompare(b[0])).map(([day, c]) => ({ day, ...c }));
    const total = days.reduce((acc, d) => addCell(acc, d), zero());
    return { idx: w.idx, from: w.from, to: w.to, isCurrent: w.from <= kyivToday && kyivToday <= w.to, isFuture: w.from > kyivToday, total, days };
  });
  const monthTotals = weeks.reduce((acc, w) => addCell(acc, w.total), zero());
  // 🔴 Е4: поле `isRnk` ПРИБРАНО. Воно їхало з роуту в тип `api.ts`, звідти пропсом
  // у `ManagerDetailDrill` — і НЕ ЧИТАЛОСЬ ніде: у компоненті воно навіть не
  // діструктурувалось, лише стояло в типі. Разом із ним пішов `RNK_MGR_TEAMS` —
  // захардкожений дубль `metrics.RNK_TEAM_IDS`, який існував лише заради нього.
  // ⚠️ Тип команди лишається в рушії РЕКОМЕНДАЦІЇ (`/lead-recommendation`) — там він
  // за задумом власника, і його НЕ чіпаємо. Прибрано лише те, що підміняло ФАКТ.
  res.json({ managerId, name: mRow?.name ?? "", from, to, weeks, monthTotals });
});

/**
 * ЗВІТ (лендинг) — збірка «план із задачника + факт із core» по менеджеру (макет
 * zvit_v2_mockup). ПЛАН = таргети kpi_period (сумовані з daily_kpi за [from,to] →
 * само-вирівнюється під будь-який день/тиждень/місяць). ФАКТ = ті самі core-функції,
 * що задачник (задачник==Звіт за побудовою). Роль-скоуп як /report:
 * manager→свій, team_lead→команда(+дрил), admin→усе. Гроші головного бара = received.
 */
dashboardRouter.get("/report-plan", async (req, res) => {
  const auth = req.auth!;
  const from = (req.query.from as string) || null;
  const to = (req.query.to as string) || null;
  if (!from || !to) return res.status(400).json({ error: "from/to (YYYY-MM-DD) обовʼязкові" });

  // Рольовий скоуп (E7 22.07): menedzher бачить ВСЮ СВОЮ КОМАНДУ (не лише себе) —
  // teamId з `managers`, свій рядок підсвічується (viewerManagerId). team_lead — своя
  // команда (+дрил по managerId). admin — усі команди (перемикач teamId/managerId).
  let managerId: number | null = null;
  let teamId: number | null = null;
  let viewerManagerId: number | null = null;
  if (auth.role === "manager") {
    viewerManagerId = auth.managerId;
    const tr = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [auth.managerId]);
    teamId = tr.rows[0]?.team_id ?? null;
    if (!teamId) managerId = auth.managerId;              // менеджер без команди → лише себе
  } else if (auth.role === "team_lead") { teamId = auth.teamId; managerId = req.query.managerId ? Number(req.query.managerId) : null; }
  else { managerId = req.query.managerId ? Number(req.query.managerId) : null; teamId = req.query.teamId ? Number(req.query.teamId) : null; }
  const scope: metrics.MetricScope = { from, to, managerId, teamId };
  const { adSources } = await getSettings();
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  const kyivToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

  // Ростер менеджерів у скоупі (активні; дрил team_lead/admin по managerId). КОМЕРЦІЙНИЙ
  // скоуп (A1): коли команду НЕ обрано (admin «Всі команди») — у РОСТЕР і в усі агрегати
  // входять лише продажні юніти (РНК/РПК/Самостійні); Финансовый (12) і лідоген-генератор
  // Ковтонюк (11) ВИКЛЮЧАЮТЬСЯ. Фінанси давали факт без плану → інфляція % — цим і чиниться.
  // 🔒 КОМЕРЦІЙНИЙ СКОУП СТРОГО (рішення власника 24.07, Опція 2): лише активні комерційні
  // менеджери — має команду І не лідген(11)/фінанси(12). БЕЗУМОВНО, незалежно від ролі-скоупу
  // (навіть якщо не-комерц залогінений і скоуп = він сам → порожній звіт, очікувано). Раніше
  // предикат дірявив на `team_id IS NULL` (Левентова/Операційний директор течуть) і діяв лише
  // у вигляді «всі команди». Спільний хелвер зі stuckDealsGrouped — не дублюємо SQL.
  const rp: unknown[] = [];
  // 🔴 АКТИВНІСТЬ — ЗА ОБОМА ДЖЕРЕЛАМИ (знайдено 06.08.2026). `m.is_active` пише
  // синк із Kommo, а власник деактивує людей у НАЛАШТУВАННЯХ (`users.is_active`) —
  // і досі ця його дія на Звіт не впливала ЖОДНИМ чином: звільнений і далі стояв
  // із планом, відсотком і світлофором. Тепер він випадає з ростера й потрапляє в
  // рядок «звільнені» нижче — разом зі своїми грошима. Деталі — `core/activeManager.ts`.
  // 🔴 РОСТЕР = ТІ, КОМУ СТАВИТЬСЯ ПЛАН (01.09.2026). «Завершує» плану не має ВЗАГАЛІ —
  //    отже випадає звідси і потрапляє нижче в `dismissed`, тобто РАЗОМ ЗІ СВОЇМИ
  //    ГРІШМИ в суму команди. Це не «сховати людину», це рівно правило власника:
  //    «план його зникає, але результат залишається».
  const rConds = [managerState.hasPlanSql("m", activeManagerSql("m")), metrics.commercialManagerSql("m")];
  if (managerId) { rp.push(managerId); rConds.push(`m.id = $${rp.length}`); }
  if (teamId) { rp.push(teamId); rConds.push(`m.team_id = $${rp.length}`); }
  const roster = (await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null }>(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id ${managerState.stateJoinSql("m")}
      WHERE ${rConds.join(" AND ")} ORDER BY m.name`, rp
  )).rows;

  // ФАКТ per-manager з ЯДРА (ті самі функції, що задачник).
  // #4 ср.чек Звіту = пул `reportChain` (угоди ЗАРАЗ у «авто працює→оплата» ⊎ виграні
  // за період) — signed Σ÷count per manager; команда/відділ = Σsum÷Σcount (glance нижче).
  const [recv, succ, paid, disp, ads, conv, avgc, expZone, split, expDays, convAd, convLg, recvKl, expKl] = await Promise.all([
    money.receivedByMgr(scope), money.successByMgr(scope), money.paidOnlyByMgr(scope),
    metrics.dispatchedByManager(scope),
    metrics.adsAcceptedByMgr(scope, adSources),
    // 🗑 `leadgenByManager` (реєстр бота) ЗВІДСИ ПРИБРАНО РАЗОМ ІЗ ПЕРЕХОДОМ НА КАНАЛ:
    // після зміни його результат не читав ніхто, а живий виклик до обваленого
    // джерела читається як робочий — рівно те, чим колись був мертвий `expected`
    // у /teams. Мінус один запит на кожен /report-plan.
    metrics.conversionByManager(scope), money.avgCheckPerManager("reportChain", scope),
    metrics.expectedZoneByScope({ managerId, teamId }, "manager"),
    metrics.createdSplitByManager(scope),
    // #2 «Очікуємо» = за ПЛАНОВОЮ датою оплати (grid по дню planned_payment_at), розкладемо
    // per manager у поточний/наступний КАЛЕНДАРНИЙ місяць (forward-looking, БЕЗ періоду звіту).
    metrics.expectedByManagerDay({ managerId, teamId }),
    /**
     * 🔀 ТРИ КОНВЕРСІЇ (рішення власника 21.08.2026). Combined вище НЕ чіпаємо —
     * канальні йдуть ДОДАТКОВО, тим самим виразом зі звуженням по `lead_channel`.
     * Показувати конверсію без підпису каналу заборонено правилом глосарію, а
     * одна колонка «Р+Л» ховала різницю в 2.3 раза: реклама 11.0% проти
     * лідогену 24.8% (заміряно на проді за серпень).
     */
    metrics.conversionByManager(scope, "ad"),
    metrics.conversionByManager(scope, "leadgen"),
    /**
     * 🧬 Гроші за новизною клієнта — ТОЙ САМИЙ вираз каси, лише розкладений
     * (`money.receivedByMgrKlass`), і та сама зона очікувань за плановою датою.
     * Числа «всього» рахуються, як рахувались; ці два виклики нічого не
     * перевизначають, а лише пояснюють склад.
     */
    money.receivedByMgrKlass(scope),
    metrics.expectedThisMonthByMgrKlass({ managerId, teamId }),
  ]);
  // 📊 Розрізи макета 06.08.2026: дзвінки (розмови/спроби), затор на «Виставленні
  // рахунку», очікування БЕЗ планової дати. Усі — лічильні або знімок однієї стадії;
  // грошей періоду тут не рахує ніхто, це й далі робота `core/money.ts`.
  const [callsRows, jamRows, noDateRows] = await Promise.all([
    reportCuts.callsByManager(from, to, { managerId, teamId }),
    reportCuts.invoicingJamByManager({ managerId, teamId }),
    reportCuts.expectedNoDateByManager(metrics.EXPECT_ZONE, { managerId, teamId }),
  ]);
  const callsM = new Map(callsRows.map((r) => [r.managerId, r]));
  const jamM = new Map(jamRows.map((r) => [r.managerId, r]));
  const noDateM = new Map(noDateRows.map((r) => [r.managerId, r]));
  const splitM = new Map(split.map((s) => [s.managerId, s]));
  // #1 круг оплати: факт(received) = успішно(142) ⊎ оплачено(етап 9). Per manager → Σ==факт.
  const succM = new Map(succ.map((x) => [x.managerId, x])), paidM = new Map(paid.map((x) => [x.managerId, x]));
  // Бакетуємо планові оплати у поточний/наступний календарний місяць (за київським сьогодні).
  // 🔗 Бакетування — у `core/forecast`, разом із самою формулою прогнозу. Поведінка
  //    та сама (той самий поділ на поточний/наступний київський місяць); винесено,
  //    щоб Звіт КВП рахував прогноз ТИМ САМИМ кодом, а не «за тим самим сенсом» —
  //    рішення 06.08.2026 доїхало сюди й не доїхало туди саме через дві копії.
  const expPlannedM = forecast.expectedSplitByMonth(expDays, kyivToday);
  const mapBy = <T extends { managerId: number }>(rows: T[]) => new Map(rows.map((r) => [r.managerId, r]));
  /** Канальна конверсія в контракт: counts завжди, % лише при taken ≥ 10 — той самий
   *  поріг, що в combined, і рахується ТИМ САМИМ полем `cohortPct` ядра. */
  const cvt = (c?: { taken: number; won: number; cohortPct: number | null }) =>
    ({ taken: c?.taken ?? 0, won: c?.won ?? 0, fact: c && c.taken >= 10 ? c.cohortPct : null });
  // 🔴 ПРАВИЛО ВЛАСНИКА (06.08.2026) — ЗМІНА ДО РІШЕННЯ ВІД 02.08: факт менеджера =
  // ② `receivedMoney` = ① «успішно реалізовано» (142) ⊎ «оплата отримана» (етап 9),
  // з дедупом. Попередня редакція («лише 142») скасована ВЛАСНИКОМ, а не нами.
  //
  // ЧОМУ ЗМІНИЛИ. Картка Антипенка за серпень 2026 показувала факт місяця **0 ₴**,
  // тимчасом як тижневий блок того ж екрана показував **23 632 ₴**: десять угод
  // уже оплачені, жодна ще не переведена в 142. Місяць рахував ①, тиждень — ②
  // (незавершена міграція `989644f`). Тобто людина з десятьма оплатами читалась як
  // «нуль» — і формально це було правильне ①.
  //
  // ⚠️ ЩО ЦЕ ТЯГНЕ ЗА СОБОЮ, НАЗВАНО ВГОЛОС: на цьому числі стоять %, світлофор,
  // `needPerDay` і прогноз. Усі вони тепер рахуються від ②. Розклад ② на дві
  // частини лишається видимим (`factSuccess`/`factPaid`) — саме щоб «гроші прийшли,
  // угода не закрита» читалось як окремий стан, а не розчинялось у сумі.
  const recvM = mapBy(recv), dispM = mapBy(disp), adsM = new Map(ads.map((a) => [a.managerId, a.count])),
    convM = mapBy(conv), avgM = mapBy(avgc),
    convAdM = mapBy(convAd), convLgM = mapBy(convLg);
  /** Розклад за класом → мапа `managerId → {new, repeat, undef}` (гроші й угоди). */
  const klMap = <T extends { managerId: number; klass: string }>(rows: T[], pick: (r: T) => number) => {
    const m = new Map<number, { new: number; repeat: number; undef: number }>();
    for (const r of rows) {
      const e = m.get(r.managerId) ?? { new: 0, repeat: 0, undef: 0 };
      e[r.klass as "new" | "repeat" | "undef"] += pick(r);
      m.set(r.managerId, e);
    }
    return m;
  };
  const recvKlM = klMap(recvKl, (r) => r.revenue), expKlM = klMap(expKl, (r) => r.sum);
  const expM = new Map(expZone.map((e) => [e.id, e.sum]));

  // СПАРКЛАЙН: received по 5 останніх тижнях (Пн–Нд) до `to`, per-manager.
  const sparkFrom = (() => { const d = new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 34); return d.toISOString().slice(0, 10); })();
  // Спарклайн — та сама метрика, що й факт (② з 06.08.2026), інакше смужка й число
  // під нею розповідали б різне про одну людину. Рухається РАЗОМ із фактом навмисно:
  // саме розсинхрон місяця й тижня і дав картку «0 ₴ при 23 632 ₴».
  const sparkRows = await money.receivedByManagerBucket({ from: sparkFrom, to, managerId, teamId }, "week");
  const sparkByMgr = new Map<number, Map<string, number>>();
  for (const r of sparkRows) { const m = sparkByMgr.get(r.managerId) ?? new Map(); m.set(r.bucket, r.revenue); sparkByMgr.set(r.managerId, m); }
  const last5Weeks = (() => {
    const out: string[] = []; const d = new Date(to + "T00:00:00Z");
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (dow - 1)); // понеділок тижня `to`
    for (let i = 4; i >= 0; i--) { const w = new Date(d); w.setUTCDate(w.getUTCDate() - i * 7); out.push(w.toISOString().slice(0, 10)); }
    return out;
  })();

  // ПЛАН із ЗАДАЧНИКА — ГІБРИД (рішення власника 22.07): де є тижнева ПАРАСОЛЬКА
  // `kpi_period` — беремо ЇЇ таргет (діти дрейфують нижче через денний перерозподіл);
  // де парасольки НЕМАЄ (незаплановані тижні / менеджери без парасольки) — падаємо на
  // Σ daily children, щоб МІСЯЦЬ не занижувався. Парасольки тижневі й задаються лише
  // на поточний тиждень, тож чистий umbrella заниження місяця вчетверо.
  //   • Розподіл парасольки — рівномірний по РОБОЧИХ днях: денний пейс = target ÷ wd(парасольки),
  //     внесок за період = target × (робочі дні перетину ÷ робочі дні парасольки).
  //   • Daily-фолбек рахується ЛИШЕ для днів ПОЗА будь-якою парасолькою менеджера (щоб
  //     не подвоювати вже покритий парасолькою проміжок).
  //   • Лічильні (payment_amount/ads/leadgen/dispatch) — сума; ставкові (avg_check/conversion) — MAX.
  // day=week=month сходяться: тиждень із парасолькою = target; без — Σ daily; місяць = Σ обох.
  // 🔴 `period_kind` ТЯГНЕТЬСЯ, А НЕ ФІЛЬТРУЄТЬСЯ В SQL. Місячні парасольки й далі
  // потрібні — але лише щоб їхні дні лишались ПОКРИТИМИ: інакше 21 прихована денна
  // дитина місячного плану стала б «нічийною», і daily-фолбек повернув би зняту ціль
  // через задні двері. Рішення «яку ціль читати» ухвалює `accumulateKpiTargets`.
  const umbRows = (await pool.query<{ assignee_id: number; ps: string; pe: string; kind: string | null; metrics_json: { metric: string; target: number | string }[] | null }>(
    `SELECT t.assignee_id, to_char(t.period_start,'YYYY-MM-DD') ps,
            to_char(COALESCE(t.period_end, t.period_start),'YYYY-MM-DD') pe,
            t.period_kind AS kind, t.metrics_json
       FROM tasks t
      WHERE t.auto AND t.task_type = 'kpi_period' AND t.assignee_id IS NOT NULL
        AND t.metrics_json IS NOT NULL
        AND t.period_start <= $2 AND COALESCE(t.period_end, t.period_start) >= $1`, [from, to]
  )).rows;
  const dayRows = (await pool.query<{ assignee_id: number; pd: string; metrics_json: { metric: string; target: number | string }[] | null }>(
    `SELECT t.assignee_id, to_char(t.plan_date,'YYYY-MM-DD') pd, t.metrics_json
       FROM tasks t
      WHERE t.auto AND t.task_type = 'daily_kpi' AND t.assignee_id IS NOT NULL
        AND t.metrics_json IS NOT NULL AND t.plan_date BETWEEN $1 AND $2`, [from, to]
  )).rows;
  // Накопичення — у ЧИСТІЙ функції `core/kpiTargets` (гейти #80…#80c). Інлайном воно
  // не мало жодної перевірки, окрім живого екрана.
  const planByMgr = accumulateKpiTargets(
    umbRows.map((u) => ({ assigneeId: u.assignee_id, from: u.ps, to: u.pe, kind: u.kind, metrics: u.metrics_json })),
    dayRows.map((r) => ({ assigneeId: r.assignee_id, day: r.pd, metrics: r.metrics_json })),
    from, to
  );

  // ГРОШОВИЙ ПЛАН = СТРАТЕГІЧНИЙ план із таблиці `plans` (core plans.managerPlan — повне
  // покриття, ціль відділу 2.7млн), рішення власника 22.07. НЕ задачник: задачник покриває
  // лише частину менеджерів (15 із 35 без плану) → % роздувався до 331%; plans-table дає
  // реалістичний %. Місячний план апортується РІВНОМІРНО по робочих днях у обраний період
  // (day=week=month сходяться). KPI-під-цілі (реклама/лідоген/авто/чек/конв) лишаються з
  // задачника (planByMgr вище) — це активнісні таргети, не гроші.
  const moneyPlanByMgr = new Map<number, number>();
  for (const mo of monthsInRange(from, to)) {
    const wdMonth = workingDaysBetween(mo, monthEndOf(mo));
    if (wdMonth <= 0) continue;
    const oF = mo > from ? mo : from;                 // перетин [місяць ∩ період]
    const meEnd = monthEndOf(mo);
    const oT = meEnd < to ? meEnd : to;
    if (oF > oT) continue;
    const frac = workingDaysBetween(oF, oT) / wdMonth;
    if (frac <= 0) continue;
    const mp = await plans.managerPlan(teamId ? { month: mo, teamId } : { month: mo });
    for (const row of mp.rows) moneyPlanByMgr.set(row.managerId, (moneyPlanByMgr.get(row.managerId) ?? 0) + row.plan * frac);
  }

  // Темп: частка робочих днів періоду, що минули (для статусу g/a/r як у макеті).
  const wdTotal = workingDaysBetween(from, to);
  const elapsedTo = kyivToday < to ? kyivToday : to;
  const wdElapsed = kyivToday < from ? 0 : workingDaysBetween(from, elapsedTo);
  const elapsed = wdTotal > 0 ? Math.min(1, wdElapsed / wdTotal) : 1;
  const remWd = Math.max(0, wdTotal - wdElapsed);
  const statusOf = (fact: number, plan: number): "g" | "a" | "r" => {
    if (plan <= 0) return "g"; const r = (fact / plan) / (elapsed || 1);
    return r >= 1 ? "g" : r >= 0.7 ? "a" : "r";
  };

  // #17 ПРОГНОЗ per-manager — ТА САМА композиція, що core.buildProjection (факт + зона
  // визнання + добір нового бізнесу), лише для ПОВНОГО ПОТОЧНОГО місяця, що ТРИВАЄ (як у
  // КВП: minule/тиждень → прогноз = факт). Зона = expectedZoneByScope (expM, той самий
  // предикат, що expectedPaymentsByPlanned.total). Добір — батчева двійня newBusinessDobir.
  const isFullMonth = from === from.slice(0, 7) + "-01" && to === monthEndOf(from) && from.slice(0, 7) === to.slice(0, 7);
  const monthInProgress = isFullMonth && wdElapsed < wdTotal;
  // 🔴 ДОБІР — ЧАСТКА, А НЕ ПОВТОРНЕ УСЕРЕДНЕННЯ (рішення власника 06.08.2026).
  // `newBusinessDobirByManager` рахував КОЖНОМУ власне середнє (raw_m ÷ місяців_m), і
  // такі середні НЕ АДИТИВНІ: Σ по менеджерах давала **1 599 273 ₴** проти справжніх
  // **1 511 318 ₴** по відділу — завищення на 87 955 ₴ (105.8%), заміряно на проді.
  // `dobirByManager` розкладає добір ВІДДІЛУ за історичною часткою (raw_m ÷ raw_відділу),
  // тож Σ менеджерів == команда == компанія точно (Δ=0, заміряно). Тримає гейт #49.
  const dobirRows = monthInProgress ? await money.dobirByManager({ teamId }) : [];
  const dobirByMgr = new Map(dobirRows.map((r) => [r.managerId, r.dobir]));

  // #P1 ДИНАМІЧНА ТИЖНЕВА ЦІЛЬ (Variant A: manualWeekTarget ?? dynamicTarget.week — одна
  // цифра скрізь). dynamicTarget рахує по місяцю `to` (ISO Пн–Нд тижні, present-days з
  // урахуванням approved-відсутностей). manual = payment_amount з kpi_period парасольки,
  // що покриває сьогодні (тімлід виставив вручну → перемагає).
  const dynMonth = to.slice(0, 7) + "-01";
  // ЄДИНИЙ вираз тижневої цілі (спільний із /kvp-report і /manager-report) — байт-в-байт.
  const effWeek = await plans.effectiveWeekTargets({ managerId, teamId, month: dynMonth }, kyivToday);

  /**
   * 🔴 РЯДОК «ЗВІЛЬНЕНІ» — ЩОБ ГРОШІ НЕ ЗНИКАЛИ РАЗОМ ІЗ ЛЮДИНОЮ
   * (рішення власника 06.08.2026).
   *
   * Пастка РЕАЛЬНА, а не теоретична: ростер вище фільтрує `m.is_active`, а грошові
   * функції ядра — НІ (правило «is_active керує списками, а не історичними сумами»).
   * Тобто щойно менеджера деактивують у Kommo, його рядок зникає зі Звіту, а його
   * гроші лишаються в `receivedByTeam` — і Σ(менеджери) перестає дорівнювати команді.
   * Саме цей інваріант тримає половину наших гейтів.
   *
   * Рядок навмисно БЕЗ плану, відсотка, світлофора й темпу: ставити план людині,
   * якої немає, безглуздо, а світлофор на ній читався б як докір нікому. Гроші (① і ⑨)
   * ВХОДЯТЬ у суму команди й компанії. Тримає гейт `#50`.
   *
   * ⚠️ Сьогодні цей список ПОРОЖНІЙ, і це не помилка: заміряно 06.08.2026 — жодна
   * угода на етапі «оплата отримана» не висить на деактивованому акаунті, а ② за
   * серпень на деактивованих = 0 ₴. Механізм стоїть заздалегідь і вмикається сам,
   * щойно CRM позначить людину неактивною.
   */
  const rosterIds = new Set(roster.map((m) => m.id));
  const dismissedIds = [...new Set([...recv, ...succ, ...paid].map((r) => r.managerId))]
    .filter((id) => !rosterIds.has(id));
  /**
   * 🔴 `dismissed` ОЗНАЧАЄ НЕ «ЗВІЛЬНЕНИЙ», А «ПОЗА РОСТЕРОМ» — і назва бреже
   * (знайдено 27.08.2026). Ростер вимагає `commercialManagerSql`, тобто
   * `team_id IS NOT NULL`; отже сюди потрапляє і АКТИВНИЙ менеджер, у якого
   * просто немає команди.
   *
   * 📐 Заміряно по 12 місяцях: будильник `#59` спрацював би на **4 акаунти, з
   * них справді деактивованих НУЛЬ**. Операційний директор (`kommo 904923`,
   * `is_active = true`, `team_id = NULL`) дзвонив би **9 місяців із 12** на
   * 610 313 ₴. Тобто за весь час гейт жодного разу не спрацював на те, заради
   * чого стояв, — а постановник, читаючи назву, ухвалив рішення про «звільненого»
   * власника, якого не існує.
   *
   * Тому рядок несе `deactivated` — ЧИ ЛЮДИНА СПРАВДІ ЗВІЛЬНЕНА (за обома
   * прапорцями, `activeManagerSql`). Без цього поля відрізнити дві причини
   * неможливо в принципі, і будильник дзвонить на обидві.
   */
  const dismissed = dismissedIds.length
    ? (await pool.query<{ id: number; name: string; team_id: number | null; team_name: string | null; active: boolean; state: string }>(
        `SELECT m.id, m.name, m.team_id, t.name AS team_name,
                (${activeManagerSql("m")}) AS active,
                (${managerState.stateSql("m", activeManagerSql("m"))}) AS state
           FROM managers m
           LEFT JOIN teams t ON t.id = m.team_id ${managerState.stateJoinSql("m")}
          WHERE m.id = ANY($1) ORDER BY m.name`, [dismissedIds])).rows
      .map((m) => ({
        managerId: m.id, name: m.name, teamId: m.team_id, teamName: m.team_name,
        /**
         * 🔴 ТРИ ПРИЧИНИ БУТИ ТУТ, І ВОНИ РІЗНІ — під одним підписом жили б усі три.
         * `state` називає ту, що є: 'dismissed' — звільнений, 'finishing' — завершує
         * свої угоди (плану немає, гроші рахуються), 'active' — активний, але поза
         * ростером із ІНШОЇ причини (немає команди — Операційний директор).
         */
        state: m.state as managerState.WorkState,
        badge: managerState.STATE_BADGE[m.state as managerState.WorkState],
        // `true` = знято хоч один прапорець активності, тобто СПРАВЖНЄ звільнення.
        deactivated: !m.active,
        fact: Math.round(recvM.get(m.id)?.revenue ?? 0),
        factSuccess: Math.round(succM.get(m.id)?.revenue ?? 0),
        factPaid: Math.round(paidM.get(m.id)?.revenue ?? 0),
        factPaidDeals: paidM.get(m.id)?.deals ?? 0,
        factSuccessDeals: succM.get(m.id)?.deals ?? 0,
      }))
      .filter((m) => m.fact !== 0 || m.factPaid !== 0 || m.factSuccess !== 0)
    : [];

  // Ланцюг періоду по менеджерах — агрегація того самого денного зрізу.
  const cohortByMgr = new Map<number, { deals: number; sum: number; paidDeals: number; paidSum: number;
    awaitDeals: number; awaitSum: number; awaitDatedSum: number; awaitNoDateSum: number }>();
  for (const r of await reportCuts.dispatchCohortByManagerDay(from, to, { managerId, teamId })) {
    const e = cohortByMgr.get(r.managerId) ?? { deals: 0, sum: 0, paidDeals: 0, paidSum: 0,
      awaitDeals: 0, awaitSum: 0, awaitDatedSum: 0, awaitNoDateSum: 0 };
    e.deals += r.deals; e.sum += r.sum; e.paidDeals += r.paidDeals; e.paidSum += r.paidSum;
    e.awaitDeals += r.awaitDeals; e.awaitSum += r.awaitSum;
    e.awaitDatedSum += r.awaitDatedSum; e.awaitNoDateSum += r.awaitNoDateSum;
    cohortByMgr.set(r.managerId, e);
  }
  const managers = roster.map((m) => {
    const fact = Math.round(recvM.get(m.id)?.revenue ?? 0);
    const pl = planByMgr.get(m.id) ?? {};
    const plan = Math.round(moneyPlanByMgr.get(m.id) ?? 0); // грошовий план — plans-table
    const ew = effWeek.get(m.id);
    const kind = m.team_id != null ? kvpTeamKind(m.team_id, m.team_name ?? "") : "rpk";
    const st = statusOf(fact, plan);
    const c = convM.get(m.id);
    return {
      managerId: m.id, name: m.name, teamId: m.team_id, teamName: m.team_name,
      tag: kind === "leadgen" ? "self" : kind, // self=самостійні/лідоген у макеті — зелений тег
      plan, fact, expect: Math.round(expM.get(m.id) ?? 0),
      // #1 круг оплати: розклад факту (received) = успішно(142) + оплачено(етап 9).
      factSuccess: Math.round(succM.get(m.id)?.revenue ?? 0), factPaid: Math.round(paidM.get(m.id)?.revenue ?? 0),
      // 🔴 К-СТЬ угод на етапі 9 — щоб банер міг сказати «гроші зібрані, але N угод не
      // закриті», а не малювати «Зрив» людині, яка зібрала гроші. Без ЧИСЛА порада
      // «дотисни» безадресна: незрозуміло, чи це одна угода, чи десять.
      factPaidDeals: paidM.get(m.id)?.deals ?? 0,
      factSuccessDeals: succM.get(m.id)?.deals ?? 0,
      // #2 очікування за плановою датою оплати (цей / наступний календарний місяць).
      expectThisMonth: Math.round(expPlannedM.get(m.id)?.thisMonth ?? 0),
      expectNextMonth: Math.round(expPlannedM.get(m.id)?.nextMonth ?? 0),
      pct: plan > 0 ? Math.round((fact / plan) * 100) : null,
      // 🔴 ПРОГНОЗ МІСЯЦЯ (рішення власника 06.08.2026) = ФАКТ ② + ОЧІКУВАННЯ З
      // ПЛАНОВОЮ ДАТОЮ ОПЛАТИ В ЦЬОМУ Ж МІСЯЦІ. Контрольне число власника, звірене
      // до правки: Антипенко = 23 632 + 44 282 = **67 914 ₴** (було 0).
      //
      // ⚠️ ДВІ ЗМІНИ ПРОТИ ПОПЕРЕДНЬОЇ РЕДАКЦІЇ — НАЗВАНІ ВГОЛОС, БО ДРУГА
      // ПОБІЧНА:
      //  (1) зона звузилась зі ЗНІМКА всієї `EXPECT_ZONE` (`expM`, БЕЗ дати —
      //      51 782 ₴ у Антипенка) до датованої «цього місяця» (44 282 ₴). Це і
      //      просив власник: прогноз місяця має спиратись на те, що обіцяно
      //      надійти В ЦЬОМУ місяці, а не на всю зону без дати.
      //  (2) 🟡 ДОБІР НОВОГО БІЗНЕСУ (`dobirByMgr`) З ФОРМУЛИ ВИПАВ. Це НЕ
      //      наслідок (1) і не дрібниця: у Антипенка добір = **67 847 ₴**, по
      //      компанії 28 менеджерів на **1 599 273 ₴**. Контрольне число власника
      //      (≈68к) сходиться ЛИШЕ без добору, тож реалізовано за їхньою цифрою —
      //      але це перегляд рішення #17, і повернути добір можна одним словом.
      projected: Math.round(forecast.forecastMonth(fact, expPlannedM.get(m.id)?.thisMonth ?? 0, monthInProgress)),
      // 🟡 Добір лишається ПОРАХОВАНИМ і ВИДИМИМ окремим числом, хоч у `projected`
      // більше не входить. Тихо викинути величину в 1.6 млн по компанії означало б
      // зробити зміну формули непомітною — а вона має читатись і перевірятись.
      dobir: Math.round(monthInProgress ? (dobirByMgr.get(m.id) ?? 0) : 0),
      /**
       * 🔗 ЛАНЦЮГ ПЕРІОДУ: ВІДПРАВЛЕНО → ОЧІКУЄ → ОПЛАЧЕНО (блок «Гроші тижня»).
       * Той самий зріз, що живить коричневу смугу розгортки, лише агрегований за
       * увесь період. Σ тримається за побудовою: `paid + await == dispatched`.
       */
      cohort: (() => {
        const c = cohortByMgr.get(m.id);
        return { deals: c?.deals ?? 0, sum: c?.sum ?? 0,
          paidDeals: c?.paidDeals ?? 0, paidSum: c?.paidSum ?? 0,
          awaitDeals: c?.awaitDeals ?? 0, awaitSum: c?.awaitSum ?? 0,
          awaitDatedSum: c?.awaitDatedSum ?? 0, awaitNoDateSum: c?.awaitNoDateSum ?? 0 };
      })(),
      // 📞 Розмови й спроби — ДВІ цифри, складати заборонено (рішення власника 04.08).
      talks: callsM.get(m.id)?.talks ?? 0, attempts: callsM.get(m.id)?.attempts ?? 0,
      // ⏳ Очікування БЕЗ планової дати — в жодну суму не входить, тому окремо.
      expectNoDate: Math.round(noDateM.get(m.id)?.sum ?? 0), expectNoDateDeals: noDateM.get(m.id)?.deals ?? 0,
      // 🧱 Затор на «Виставленні рахунку»: скільки з очікувань стоїть саме тут.
      jam: Math.round(jamM.get(m.id)?.sum ?? 0), jamDeals: jamM.get(m.id)?.deals ?? 0,
      // 📈 «За темпом» = факт ÷ робочі дні, що минули × усі робочі дні. Це ЕКСТРАПОЛЯЦІЯ,
      // а не прогноз, і на 4-й день місяця вона нестабільна — тому поруч їде `byPaceEarly`,
      // за яким UI малює «⚠ рано». Три числа «скільки вийде» мусять зватись по-різному:
      // «з рахунками» (документи) · «за темпом» (екстраполяція) · «зазвичай добирає» (середнє).
      byPace: wdElapsed > 0 ? Math.round((fact / wdElapsed) * wdTotal) : 0,
      byPaceEarly: wdElapsed > 0 && plan > 0 ? (fact / wdElapsed) * wdTotal > plan * 1.5 : false,
      monthInProgress,
      created: splitM.get(m.id)?.created ?? 0, new: splitM.get(m.id)?.newCount ?? 0, rep: splitM.get(m.id)?.repeatCount ?? 0,
      // ДЖЕРЕЛО — накладка поверх партиції (⊂ created), у суму не додається.
      // 🧺 РОЗКЛАД СТВОРЕНИХ ЗА ДЖЕРЕЛОМ — ПОВНИЙ, тобто ПАРТИЦІЯ (24.08.2026).
      // `srcAd + srcLeadgen + srcOther + srcNoChannel == created`. Раніше віддавались
      // лише перші дві гілки з чотирьох, і 43.2% угод не мали імені на екрані взагалі.
      // ⚠️ `srcNoChannel` (канал не заповнено) — НЕ те саме, що невизначена НОВИЗНА:
      // остання їде окремим полем і належить ІНШІЙ партиції. Тримає `#174`.
      srcAd: splitM.get(m.id)?.adCount ?? 0, srcLeadgen: splitM.get(m.id)?.leadgenCount ?? 0,
      srcOther: splitM.get(m.id)?.otherCount ?? 0, srcNoChannel: splitM.get(m.id)?.noChannelCount ?? 0,
      // 🔀 Е3: той самий розклад ВСЕРЕДИНІ кожного класу новизни. Їде разом із
      // рядком, бо перемикач «усі / лише нові / лише постійні» НЕ ходить на
      // сервер (`/overview` ×4 вже 4 940-5 168 мс при стелі 5 000 — `#36`).
      // Плоскі поля вище лишаються зрізом «усі» і сюди НЕ дублюються.
      srcByKlass: splitM.get(m.id)?.sourceByKlass
        ?? { new: EMPTY_SRC, rep: EMPTY_SRC, undef: EMPTY_SRC },
      /**
       * 🔀 Канальні конверсії — `taken`/`won` ЗАВЖДИ, відсоток лише при taken ≥ 10
       * (рішення власника 21.08.2026). Числа не брешуть при жодній вибірці, а
       * поріг лишається тим самим, що й у combined. Без чисел колонка «Конв.
       * лідоген» була б порожня у 22 із 31 менеджера (заміряно за серпень) і
       * читалась би як зламана.
       */
      conversionAd: cvt(convAdM.get(m.id)),
      conversionLeadgen: cvt(convLgM.get(m.id)),
      /**
       * 🧬 РОЗКЛАД ГРОШЕЙ ЗА НОВИЗНОЮ (рішення власника 21.08.2026). `fact` і
       * `expectThisMonth` НЕ змінюються — це вони ж, розкладені каноном.
       * `undef` віддається окремо й на екран не йде: сьогодні він нуль, а
       * будильник `#102b` червоніє на першому ненульовому — інакше гроші тихо
       * випали б із розкладу «нові + постійні».
       */
      factNew: recvKlM.get(m.id)?.new ?? 0,
      factRepeat: recvKlM.get(m.id)?.repeat ?? 0,
      factUndef: recvKlM.get(m.id)?.undef ?? 0,
      expectThisMonthNew: expKlM.get(m.id)?.new ?? 0,
      expectThisMonthRepeat: expKlM.get(m.id)?.repeat ?? 0,
      expectThisMonthUndef: expKlM.get(m.id)?.undef ?? 0,
      status: st, needPerDay: remWd > 0 ? Math.max(0, Math.round((plan - fact) / remWd)) : 0, remainingWorkdays: remWd,
      // #P1 динамічна тижнева ціль (ЄДИНИЙ вираз effectiveWeekTargets — байт-в-байт з KVP/manager-report).
      week: { target: ew?.target ?? 0, dynamic: ew?.dynamic ?? 0, manual: ew?.manual ?? null, isManual: ew?.isManual ?? false,
        fact: ew?.fact ?? 0, dayTarget: ew?.dayTarget ?? 0, weeksLeft: ew?.weeksLeft ?? 0, presentDaysLeftWeek: ew?.presentDaysLeftWeek ?? 0,
        // 🧊 Заморожений динамічний план: `frozen` — ціль зафіксовано в понеділок і
        // всередині тижня вона не рухається; `reconstructed` — знімок ВІДНОВЛЕНО
        // ретроспективно (чесна межа, яку UI зобовʼязаний показати, а не згладити).
        overPlan: ew?.overPlan ?? 0, frozen: ew?.frozen ?? false, reconstructed: ew?.reconstructed ?? false,
        weekFrom: ew?.weekFrom ?? null, workingDaysWeek: ew?.workingDaysWeek ?? 0 },
      spark: last5Weeks.map((w) => Math.round(sparkByMgr.get(m.id)?.get(w) ?? 0)),
      kpi: {
        ads: { fact: adsM.get(m.id) ?? 0, target: Math.round(pl.ads_count ?? 0) },
        /**
         * 🔀 ЛІДГЕН-ФАКТ — ЗА КАНАЛОМ, А НЕ ЗА РЕЄСТРОМ БОТА (рішення власника 24.08.2026).
         *
         * 🔴 БУЛО: `leadgenByManager` → `leadgen_touch` ← `leadgen_registry` (аркуш
         * лідоген-бота), анкер `transfer_date`. Заміряно: реєстр веде лише від
         * 15.06.2026, тож до червня Звіт показував НЕ «мало лідгену», а НУЛЬ через
         * відсутність даних (бер 0, кві 0, тра 0 — при 107/134/121 за каналом). А з
         * 10.08 реєстр обвалився зі ~130 передач на тиждень до 11-20, і факт поїхав
         * за ним: у Матюніна 1 при 15 у цілі.
         *
         * ✅ СТАЛО: `splitM.leadgenCount` — FC-угоди з `lead_channel='leadgen'`,
         * створені у вікні. Це ТОЙ САМИЙ вираз, що вже живить `srcLeadgen` двома
         * десятками рядків вище: одне джерело на один показник екрана, а не двоє
         * поруч (урок «жоден показник не має двох джерел на одному екрані»).
         * Вхід у «нову заявку від лідогенератора» окремим доданком НЕ потрібен —
         * він уже всередині виведення `lead_channel` у `reclassifyAdChannel`.
         *
         * ⚠️ ОЗНАЧЕННЯ ЗМІНИЛОСЬ → МИНУЛІ ЧИСЛА ЗРОСЛИ, і це очікувано: чер 260→344,
         * лип 571→637, сер 166→339. До обвалу канал і реєстр розходились на 7-20%,
         * тож це не нова величина, а та сама без сліпоти. Тримають `#141`/`#141b`.
         */
        leadgen: { fact: splitM.get(m.id)?.leadgenCount ?? 0, target: Math.round(pl.leadgen_count ?? 0) },
        dispatch: { fact: dispM.get(m.id)?.deals ?? 0, target: Math.round(pl.dispatch_count ?? 0), revenue: Math.round(dispM.get(m.id)?.revenue ?? 0),
          // Розбивка авто за джерелом (постійний / лідоген / реклама / невизн). Σ = fact.
          repeat: dispM.get(m.id)?.repeat ?? 0, leadgen: dispM.get(m.id)?.leadgen ?? 0, ad: dispM.get(m.id)?.ad ?? 0, undef: dispM.get(m.id)?.undef ?? 0 },
        avgCheck: { fact: avgM.get(m.id)?.avgCheck ?? null, target: Math.round(pl.avg_check ?? 0),
          revenue: Math.round(avgM.get(m.id)?.revenue ?? 0), deals: avgM.get(m.id)?.deals ?? 0 },
        conversion: { fact: c && c.taken >= 10 ? c.cohortPct : null, target: Math.round(pl.conversion ?? 0), taken: c?.taken ?? 0, won: c?.won ?? 0 },
      },
    };
  }).sort((a, b) => ({ r: 0, a: 1, g: 2 })[a.status] - ({ r: 0, a: 1, g: 2 })[b.status]); // гірші вгорі

  // #4 ср.чек команди/відділу (glance) = Σsum ÷ Σcount по пулу reportChain (НЕ середнє
  // середніх) → Σ по тих самих менеджерах, що показані. Σ-інваріант тримається за побудовою.
  const acRev = managers.reduce((s, m) => s + m.kpi.avgCheck.revenue, 0);
  const acDeals = managers.reduce((s, m) => s + m.kpi.avgCheck.deals, 0);
  // 🔴 Гроші звільнених ВХОДЯТЬ у підсумок — інакше ми полагодили б рядок і зламали
  // саме той Σ-інваріант, заради якого його й заводили (Σ по екрану == ядру).
  const dFact = dismissed.reduce((s, m) => s + m.fact, 0);
  const dSuc = dismissed.reduce((s, m) => s + m.factSuccess, 0);
  const dPaid = dismissed.reduce((s, m) => s + m.factPaid, 0);
  const glance = {
    plan: managers.reduce((s, m) => s + m.plan, 0),
    fact: managers.reduce((s, m) => s + m.fact, 0) + dFact,
    factSuccess: managers.reduce((s, m) => s + m.factSuccess, 0) + dSuc,
    factPaid: managers.reduce((s, m) => s + m.factPaid, 0) + dPaid,
    expect: managers.reduce((s, m) => s + m.expect, 0),
    expectThisMonth: managers.reduce((s, m) => s + m.expectThisMonth, 0),
    expectNextMonth: managers.reduce((s, m) => s + m.expectNextMonth, 0),
    dispatched: managers.reduce((s, m) => s + m.kpi.dispatch.fact, 0),
    dispatchedRevenue: managers.reduce((s, m) => s + m.kpi.dispatch.revenue, 0),
    created: managers.reduce((s, m) => s + m.created, 0),
    avgCheck: acDeals > 0 ? Math.round(acRev / acDeals) : null,
    /**
     * 🔴 СКЛАДОВА ФАКТУ ВІД МЕНЕДЖЕРІВ БЕЗ ПЛАНУ (рішення власника 06.08.2026).
     *
     * План команди рахується як **Σ планів її менеджерів**, тож гроші людини, якій
     * цілі не ставили, потрапляють у ЧИСЕЛЬНИК, не потрапивши у ЗНАМЕННИК — команда
     * виглядає кращою рівно на її внесок. Заміряно 06.08: у Яцика це **+8.3 п.п.**
     * (24.9% замість 16.5%), по компанії **+2.6 п.п.**; 22.5% усього факту компанії
     * приходить від безпланових.
     *
     * ⚠️ І ЦЕ НЕ РОЗСМОКТУЄТЬСЯ ПІСЛЯ ЗВІЛЬНЕННЯ — перевірено симуляцією в
     * транзакції з ROLLBACK: після деактивації Шевчука факт команди 217 873 → 217 873,
     * план 865 000 → 865 000, % 25.2% → 25.2%. Гроші лише переїжджають із рядка
     * активного в рядок «звільнені», ОБИДВА з яких входять у суму команди. Тому
     * підпис потрібен НАЗАВЖДИ, а не тимчасово.
     *
     * `dismissed` включені навмисно: у них плану немає за побудовою, тож вони
     * спотворюють відсоток рівно так само.
     */
    factNoPlan: managers.filter((m) => m.plan <= 0).reduce((s2, m) => s2 + m.fact, 0)
      + dismissed.reduce((s2, m) => s2 + m.fact, 0),
    expectNoDate: managers.reduce((s2, m) => s2 + m.expectNoDate, 0),
    jam: managers.reduce((s2, m) => s2 + m.jam, 0),
    jamDeals: managers.reduce((s2, m) => s2 + m.jamDeals, 0),
    dobir: managers.reduce((s2, m) => s2 + m.dobir, 0),
    byPace: managers.reduce((s2, m) => s2 + m.byPace, 0),
    talks: managers.reduce((s2, m) => s2 + m.talks, 0),
    attempts: managers.reduce((s2, m) => s2 + m.attempts, 0),
    /**
     * 🟢 ТРИ СТАНИ, І ВОНИ ПОКРИВАЮТЬ УСІХ ЛЮДЕЙ ДО ОДНОГО (рішення власника 07.08.2026).
     *
     * 06.08 тут був ЧЕТВЕРТИЙ стан «гроші є · не закрито»: людей із `factSuccess === 0`
     * і `factPaid > 0` виносили з `r/a/g` окремим чипом, бо при факті = ① вони мали
     * НУЛЬ і читались як «зрив» без власної провини.
     *
     * 🔴 Підстава зникла разом із формулою. Факт тепер = ② (`recvM`, успішно ⊎ оплачено),
     * а статус рахує `statusOf(fact, plan)` — тобто людина з грошима на етапі ⑨ має
     * `fact > 0` і в «Зрив» через нуль НЕ потрапляє. Вона може там опинитись лише за
     * відставання від темпу, як усі інші. Перевірено в коді, не припущено:
     * `const st = statusOf(fact, plan)`, `fact = recvM.get(m.id).revenue`.
     *
     * ⚠️ І ЦЕ НЕ КОСМЕТИКА, А УМОВА ЧИТАНОСТІ ЕКРАНА. Чипи стоять під підписом
     * «N менеджерів», тож Σ чипів МУСИТЬ дорівнювати N. Четвертий стан, якого верстка
     * не малює, зробив би недобір мовчазним — той самий клас, що й «31 менеджер, чипи
     * на 37», лише в інший бік і без жодного видимого сліду.
     */
    statusCounts: {
      g: managers.filter((m) => m.status === "g").length,
      a: managers.filter((m) => m.status === "a").length,
      r: managers.filter((m) => m.status === "r").length,
    },
  };

  res.json({
    scope: { from, to, isCurrent: from <= kyivToday && kyivToday <= to,
      // Робочі дні періоду — ЧИСЛАМИ, а не лише часткою `elapsed`. Фронт мусить
      // писати «минуло 4 з 21 (19%)»: сама частка не дає сказати, ЧОГО 19%.
      workingDaysTotal: wdTotal, workingDaysElapsed: wdElapsed },
    role: auth.role, viewerManagerId, elapsed, remainingWorkdays: remWd, glance, managers,
    // Окремим масивом, а не серед `managers`: у них немає плану, %, світлофора й темпу,
    // тож змішувати їх у той самий список означало б рахувати статуси по людях, яких немає.
    dismissed,
  });
});

/** Дрил Звіту: угоди менеджера, СТВОРЕНІ у конкретний день (для тижень→день→угоди).
 *  new/rep = сигнал каналу (ad|leadgen→новий, інакше→постійний). Роль-скоуп. */
/**
 * Роль-скоуп для дрилів по менеджеру (E7): manager і team_lead — лише СВОЯ КОМАНДА;
 * admin — будь-хто. Винесено в спільну функцію, бо тепер її кличуть ДВА роути:
 * копія перевірки доступу — це два місця, де вона може розійтись.
 */
async function canDrillManager(auth: AuthPayload, managerId: number): Promise<boolean> {
  if (auth.role !== "manager" && auth.role !== "team_lead") return true;
  const myTeam = auth.role === "team_lead"
    ? auth.teamId
    : (await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [auth.managerId])).rows[0]?.team_id ?? null;
  const chk = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
  // менеджер без команди бачить лише себе; інакше — уся команда
  return myTeam == null ? managerId === auth.managerId : chk.rows[0]?.team_id === myTeam;
}

/**
 * 🔎 ДРУГИЙ РІВЕНЬ РОЗГОРТКИ: склад КОНКРЕТНОГО числа в рядку дня.
 *
 * 🔴 ОДИН РОУТ ІЗ ПАРАМЕТРОМ `kind`, а не одинадцять ендпоінтів (вимога власника
 * 07.08.2026). Логіка — у `core/dayItems.ts`, тут лише межа доступу й валідація.
 *
 * ⚠️ ЧОМУ ЦЕ НЕ ЗАМІНЮЄ `/report-plan/deals`: старий роут завжди віддає СТВОРЕНІ
 * того дня незалежно від того, на що клікнули, — тому 04.08 показував список угод
 * при прочерку в «Отримано», і це читалось як суперечність, хоч числа про різне.
 * Новий роут привʼязаний до ЧИСЛА, а не до дня.
 */
dashboardRouter.get("/report-plan/day-items", async (req, res) => {
  const auth = req.auth!;
  const managerId = Number(req.query.managerId);
  const date = String(req.query.date ?? "");
  const kind = String(req.query.kind ?? "");
  if (!managerId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "managerId + date (YYYY-MM-DD) обовʼязкові" });
  }
  if (!isDayItemKind(kind)) {
    return res.status(400).json({ error: `kind має бути одним із: ${DAY_ITEM_KINDS.join(", ")}` });
  }
  // Період: `date` — один день; `to` — той самий механізм на діапазон (блок «Гроші тижня»).
  const to = String(req.query.to ?? "") || date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || to < date) {
    return res.status(400).json({ error: "to має бути датою YYYY-MM-DD не раніше date" });
  }
  if (!(await canDrillManager(auth, managerId))) return res.status(403).json({ error: "Forbidden" });
  res.json(await dayItems(kind, managerId, date, to));
});

/**
 * 🗓 ТИЖНІ МІСЯЦЯ ОДНОГО МЕНЕДЖЕРА — розкриття рядка в табличному вигляді Звіту.
 *
 * 🔴 ПЛАН БЕРЕТЬСЯ ЗІ ЗНІМКІВ, А НЕ ПЕРЕРАХОВУЄТЬСЯ. `weekPlansForMonth` читає
 * `weekly_plan_snapshots`, тобто ту саму цифру, яку людина бачила в понеділок.
 * Проста декомпозиція «місячний план × робочі дні тижня ÷ робочі дні місяця»
 * виглядала б охайніше, але вона: (1) завела б ЧЕТВЕРТЕ означення тижневого плану
 * поруч із `effectiveWeekTargets`, і (2) переписувала б історію — за минулі тижні
 * показувала б не те, що було заморожене. `source='backfill'` віддається назовні
 * саме тому, що екран зобовʼязаний зізнатись: цей знімок ВІДНОВЛЕНО заднім числом.
 *
 * 🔴 ФАКТ РАХУЄТЬСЯ ПО ТИХ САМИХ МЕЖАХ, ЩО Й ПЛАН. Тижні тут — `fixedWeekBlocks`:
 * Пн–Нд, ОБРІЗАНІ межами місяця (перший блок серпня 2026 — це 1–2 число). Тому
 * `receivedByManagerBucket(..., "week")` тут не годиться: `date_trunc('week')`
 * віднесе 1 серпня до понеділка ПОПЕРЕДНЬОГО місяця, і перший рядок розкриття
 * лишився б порожнім при живих грошах. Беремо ДЕННІ бакети ядра й складаємо їх
 * у блоки — одним запитом і без власного SQL по виручці.
 */
dashboardRouter.get("/report-plan/manager-weeks", async (req, res) => {
  const auth = req.auth!;
  const managerId = Number(req.query.managerId);
  const month = String(req.query.month ?? "");
  if (!managerId || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "managerId + month (YYYY-MM) обовʼязкові" });
  }
  if (!(await canDrillManager(auth, managerId))) return res.status(403).json({ error: "Forbidden" });

  const monthStart = `${month}-01`;
  const monthEnd = monthEndOf(monthStart);
  const mgrRow = (await pool.query<{ team_id: number | null }>(
    `SELECT team_id FROM managers WHERE id = $1`, [managerId])).rows[0];

  // Місячний план — ЄДИНИМ джерелом (`plans-grid`), як і всюди: тижневий похідний від нього.
  const mp = await plans.managerPlan(mgrRow?.team_id != null ? { month: monthStart, teamId: mgrRow.team_id } : { month: monthStart });
  const planByMgr = new Map(mp.rows.map((r) => [r.managerId, r.plan]));
  // 🚚 АВТО ПО ТИЖНЯХ (рішення власника 20.08.2026): у розкритті має бути видно не
  // лише гроші, а й скільки авто відправлено проти тижневої цілі. Факт — той самий
  // `dispatchedByManagerDay` (анкер `load_at`), що живить колонку «Авто ф/ц»;
  // ціль — `accumulateKpiTargets` на межах ТОГО САМОГО блоку, тобто той самий вираз,
  // що й у місячному блоці показників. Другого означення цілі не заводимо.
  const [snapRows, dayRows, dispDays, umbRows2, dayRows2] = await Promise.all([
    weekPlansForMonth({ managerId }, monthStart, planByMgr),
    money.receivedByManagerBucket({ from: monthStart, to: monthEnd, managerId }, "day"),
    metrics.dispatchedByManagerDay({ from: monthStart, to: monthEnd, managerId }),
    pool.query<{ assignee_id: number; ps: string; pe: string; kind: string | null; metrics_json: { metric: string; target: number | string }[] | null }>(
      `SELECT t.assignee_id, to_char(t.period_start,'YYYY-MM-DD') ps,
              to_char(COALESCE(t.period_end, t.period_start),'YYYY-MM-DD') pe,
              t.period_kind AS kind, t.metrics_json
         FROM tasks t
        WHERE t.auto AND t.task_type = 'kpi_period' AND t.assignee_id = $1
          AND t.metrics_json IS NOT NULL
          AND t.period_start <= $3 AND COALESCE(t.period_end, t.period_start) >= $2`,
      [managerId, monthStart, monthEnd]),
    pool.query<{ assignee_id: number; pd: string; metrics_json: { metric: string; target: number | string }[] | null }>(
      `SELECT t.assignee_id, to_char(t.plan_date,'YYYY-MM-DD') pd, t.metrics_json
         FROM tasks t
        WHERE t.auto AND t.task_type = 'daily_kpi' AND t.assignee_id = $1
          AND t.metrics_json IS NOT NULL AND t.plan_date BETWEEN $2 AND $3`,
      [managerId, monthStart, monthEnd]),
  ]);
  const snapByWeek = new Map(snapRows.map((r) => [r.weekStart, r]));
  const blocks = fixedWeekBlocks(monthStart);
  // Складання денних сум у блоки — чиста функція (`core/weekFacts`), щоб її можна
  // було перевірити без БД: саме на межах блоків і губляться гроші.
  const { byBlock } = sumDaysIntoBlocks(
    dayRows.filter((r) => r.managerId === managerId).map((r) => ({ day: r.bucket, value: r.revenue })),
    blocks,
  );

  const dispByBlock = sumDaysIntoBlocks(
    dispDays.filter((r) => r.managerId === managerId).map((r) => ({ day: r.day, value: r.deals })),
    blocks,
  ).byBlock;

  const weeks = blocks.map((w, i) => {
    const snap = snapByWeek.get(w.from);
    const fact = byBlock[i];
    const plan = Math.round(snap?.plan ?? 0);
    // 🚚 Ціль авто на ЦЕЙ тиждень — тим самим накопичувачем, що місячний блок
    // показників. Парасольки має не кожен (17 із 31 менеджера), тож відсутність
    // цілі — це `null`, а не 0: нуль читався б як «ціль нульова».
    const wTargets = accumulateKpiTargets(
      umbRows2.rows.map((u) => ({ assigneeId: u.assignee_id, from: u.ps, to: u.pe, kind: u.kind, metrics: u.metrics_json })),
      dayRows2.rows.map((r) => ({ assigneeId: r.assignee_id, day: r.pd, metrics: r.metrics_json })),
      w.from, w.to,
    ).get(managerId) ?? {};
    const dTarget = wTargets.dispatch_count != null ? Math.round(wTargets.dispatch_count) : null;
    return {
      idx: w.idx, from: w.from, to: w.to,
      workingDays: snap?.wdWeek ?? workingDaysBetween(w.from, w.to),
      plan, fact: Math.round(fact),
      pct: plan > 0 ? Math.round((fact / plan) * 100) : null,
      overPlan: Math.round(snap?.overPlan ?? 0),
      // `null` — тиждень ще не почався, тож знімка й не мало бути.
      source: snap?.source ?? null,
      reconstructed: snap?.reconstructed ?? false,
      dispatchFact: dispByBlock[i],
      dispatchTarget: dTarget && dTarget > 0 ? dTarget : null,
      /**
       * ✂️ ТИЖДЕНЬ, ОБРІЗАНИЙ МЕЖЕЮ МІСЯЦЯ (F5). Перший і останній блоки місяця
       * майже завжди коротші за Пн–Нд: серпень 2026 починається в суботу, тож
       * перший блок — це 01–02. Картка при цьому рахує тижневу ЦІЛЬ по повному
       * календарному тижню, і без цієї позначки два правильні числа на сусідніх
       * екранах читались би як розбіжність.
       */
      clipped: !(new Date(w.from + "T00:00:00Z").getUTCDay() === 1
                 && new Date(w.to + "T00:00:00Z").getUTCDay() === 0),
    };
  });
  res.json({ managerId, month, monthPlan: Math.round(planByMgr.get(managerId) ?? 0), weeks });
});

dashboardRouter.get("/report-plan/deals", async (req, res) => {
  const auth = req.auth!;
  const managerId = Number(req.query.managerId);
  const date = String(req.query.date ?? "");
  if (!managerId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "managerId + date (YYYY-MM-DD) обовʼязкові" });
  if (!(await canDrillManager(auth, managerId))) return res.status(403).json({ error: "Forbidden" });
  const KYIV = "AT TIME ZONE 'Europe/Kyiv'";
  // 🔴 Мітка «новий/постійний» І ДЖЕРЕЛО — обидва з ЯДРА (`dealKlassSql` +
  // `dealSourceSql`), а не зі скорочення по
  // `lead_channel`. Тут стояла та сама двогілкова копія правила, що й у dayItems:
  // «реклама/лідоген → новий, усе інше → постійний». Вона робила постійними угоди
  // `other` БЕЗ історії клієнта — тобто сперечалась із лічильником рядка (12.6%
  // угод серпня). Правило тепер одне; форми звіряє гейт `#66`.
  const r = await pool.query<{ kommo_id: string; name: string; klass: string | null; source: string | null; price: string; status_id: number }>(
    `SELECT d.kommo_id, d.name, d.price, d.status_id, (${metrics.dealKlassSql("d")}) AS klass,
            (${metrics.dealSourceSql("d")}) AS source
       FROM deals d WHERE d.manager_id = $1 AND d.pipeline_id = ANY($2)
         AND (d.created_at_kommo ${KYIV})::date = $3::date
      ORDER BY d.price DESC NULLS LAST, d.created_at_kommo`,
    [managerId, [8921932, 155304], date]
  );
  const label = (s: number): string =>
    s === 142 ? "Виграно" : s === 69716460 || s === 60412544 ? "Оплата отримана"
      : s === 69716312 || s === 25044997 ? "Очікуємо оплату" : s === 100274340 ? "Виставлення рахунку"
      : s === 143 ? "Закрито" : "В роботі";
  res.json({
    deals: r.rows.map((x) => ({
      // 🔗 Назва угоди — клікабельна: id угоди в нас уже є, і без лінка людина
      // мусить шукати ту саму угоду в CRM руками. URL будує сервер (`kommoLeadUrl`),
      // фронт піддомену не знає.
      kommoId: Number(x.kommo_id), url: kommoLeadUrl(Number(x.kommo_id)),
      // 🔴 ВІДОБРАЖЕННЯ КЛАСУ — З `core/klassFilter.klassOf`, а не свій потрійний
      // вираз тут. Тут стояла копія, яка зводила `'undef'` у `null` — тобто третій
      // клас (сторно без ключа клієнта, 6 угод / −18 004 ₴ у серпні) ставав на
      // екрані нерозрізненним із «питання незастосовне». Перемикач Е3 фільтрує
      // ЦИМ станом, тож копія означала б два означення новизни на одному екрані.
      name: x.name, src: klassOf(x.klass),
      // ⚠️ БІЛИЙ СПИСОК ІЗ ЧОТИРЬОХ, не з трьох: `undef` («канал не вказано») мусить
      // доїхати окремим станом, інакше він зіллється з `null` («джерело незастосовне»)
      // і незнання читатиметься як відсутність питання. Тримає `#175`.
      source: x.source === "ad" || x.source === "leadgen" || x.source === "other" || x.source === "undef" ? x.source : null,
      price: Math.round(Number(x.price)), status: label(Number(x.status_id)),
    })),
  });
});

/**
 * КРОК Д — КОМПОЗИТНИЙ звіт КВП. Admin-only (роль КВП = вся компанія). ТІЛЬКИ
 * збірка з ядра (money/metrics/plans) — нової бізнес-логіки НЕ додає. Scope-aware
 * (preset day/week/month/quarter/year або custom). Стратегічний план = Σ планів
 * команд (🔒 read-only, managerPlan). Числа звіряються з Оглядом/Звітом (спільне ядро).
 */
dashboardRouter.get("/kvp-report", async (req, res) => {
  const auth = req.auth!;
  if (!roleHasTab(auth.roleKey, "kvp")) return res.status(403).json({ error: "Звіт КВП — лише адміністратор (КВП)" });
  const sc = resolveKvpScope(String(req.query.preset ?? "month"), String(req.query.date ?? ""), (req.query.from as string) || null, (req.query.to as string) || null);
  const { from, to } = sc;
  const scope: metrics.MetricScope = { from, to };
  const mScope: money.MoneyScope = { from, to };
  const { adSources } = await getSettings();
  const months = monthsInRange(from, to);

  const [
    received, receivedPrev, success, paidOnly, expectedZone, awaitingNow,
    projection, receivedTeams, expectedTeams, convTeams, convMgrs,
    newRepeatTot, newRepeatMgr, newRepeatTeam, receivedByCh,
    dispatchedAllSeries, dispatchedLgSeries, transferredSeries,
    newToRepeat, activeBase, weeklyReg, nonTarget, planRes, funnel,
    receivedSeg, expectedSeg, mgrDaily,
    expTeamThis, expTeamNext, mgrDayExp, mgrDayDisp, mgrDayLeads,
    overdue, avgCycle, lost,
    dirSplit, chanSplit, clientRev, transit, dso, aging,
    successDay, segDay, lostDay, dirConv, createdSplitMgr,
  ] = await Promise.all([
    money.receivedMoney(mScope), money.receivedMoney({ from: sc.prevFrom, to: sc.prevTo }),
    money.successMoney(mScope), money.paidOnlyMoney(mScope),
    metrics.expectedPaymentsByPlanned({}), money.awaitingNowSnapshot(mScope),
    metrics.buildProjection({ from, to, granularity: "month" }, null),
    money.receivedByTeam(mScope), metrics.expectedZoneByScope({}, "team"),
    metrics.conversionAdsByTeam(scope, adSources), metrics.conversionAdsByManager(scope, adSources),
    metrics.newRepeatTotals(scope), metrics.newRepeatByScope(scope, "manager"), metrics.newRepeatByScope(scope, "team"),
    money.receivedByChannel(mScope, adSources),
    // 🔴 `dispatchedByLoadMonth` ІГНОРУЄ from/to — вона завжди віддає 12 місяців, а роут
    //    відсіював їх ЦІЛИМИ місяцями (`inRange`). Для тижня 27.07–02.08 це давало
    //    ПОВНИЙ липень + ПОВНИЙ серпень: 1801 авто / 5 031 131 ₴ замість 285 / 723 090.
    //    `dispatchedByLoadBucket` scoped за побудовою; на місячних діапазонах Δ = 0
    //    (заміряно на проді: серпень 652/1 745 882 і липень 1149/3 285 249 обома шляхами,
    //    лідоген 66/270 194 і 107/339 203 — байт у байт), тож джерело одне на всі пресети.
    metrics.dispatchedByLoadBucket(scope, "month"), metrics.dispatchedByLoadBucket(scope, "month", "leadgen"), metrics.conversionTransferredByMonth(scope),
    metrics.newToRepeatByMonth({}), metrics.activeBaseByMonth({}), metrics.weeklyRegulars({}),
    metrics.nonTargetLeads(scope, adSources),
    Promise.all(months.map((m) => plans.managerPlan({ month: m }))),
    metrics.funnelByStage(scope),
    money.receivedBySegment(mScope), metrics.expectedBySegment({ from }), money.receivedByManagerBucket(mScope, "day"),
    metrics.expectedMonthByScope({}, "team", 0), metrics.expectedMonthByScope({}, "team", 1), metrics.expectedByManagerDay({}),
    metrics.dispatchedByManagerDay(scope), metrics.leadsByManagerDay(scope),
    metrics.overduePayments(scope), metrics.avgDealCycleDays(scope), metrics.lostDeals(scope),
    money.receivedByRequestType(mScope), money.receivedBySalesChannel(mScope), money.receivedByClientKey(mScope),
    metrics.transitStats(scope), metrics.dsoProxyDays(scope), metrics.receivablesAging(),
    money.successByBucket(mScope, "day"), money.receivedSegByDay(mScope), metrics.lostByDay(scope),
    metrics.conversionAdsByDirection(scope, adSources),
    metrics.createdSplitByManager(scope),
  ]);
  // Розкол «створено» новий/постійний (3 сигнали B→C→A) по менеджеру → мапа + агрегати.
  const splitByMgr = new Map(createdSplitMgr.map((x) => [x.managerId, x]));
  const mgrDailyMap = new Map<number, { bucket: string; revenue: number; deals: number }[]>();
  for (const r of mgrDaily) { const a = mgrDailyMap.get(r.managerId) ?? []; a.push({ bucket: r.bucket, revenue: r.revenue, deals: r.deals }); mgrDailyMap.set(r.managerId, a); }

  // Крок Д фінал #2: тижневий розріз Т1–Т5 (лише одномісячний скоуп). План тижня =
  // місячний план × (робочі дні тижня ÷ робочі дні місяця) → Σ тижнів план == місяць.
  // Факт тижня = received за датою оплати в тижні → Σ тижнів факт == місяць. RAW (без
  // округлення) — щоб Σ звірялось точно; FE округлює на показ.
  const weekBlocks = months.length === 1 ? fixedWeekBlocks(months[0]) : [];
  const wdMonth = weekBlocks.reduce((a, w) => a + workingDaysBetween(w.from, w.to), 0);
  const mgrDayExpMap = new Map<number, { day: string; sum: number }[]>();
  for (const r of mgrDayExp) { const a = mgrDayExpMap.get(r.managerId) ?? []; a.push({ day: r.day, sum: r.sum }); mgrDayExpMap.set(r.managerId, a); }
  // Крок Д (тижневий вигляд) #7: активність per менеджер×день (авто/ліди) для перемикача.
  const mgrDayDispMap = new Map<number, { day: string; deals: number; revenue: number }[]>();
  for (const r of mgrDayDisp) { const a = mgrDayDispMap.get(r.managerId) ?? []; a.push({ day: r.day, deals: r.deals, revenue: r.revenue }); mgrDayDispMap.set(r.managerId, a); }
  const mgrDayLeadsMap = new Map<number, { day: string; ad: number; leadgen: number }[]>();
  for (const r of mgrDayLeads) { const a = mgrDayLeadsMap.get(r.managerId) ?? []; a.push({ day: r.day, ad: r.ad, leadgen: r.leadgen }); mgrDayLeadsMap.set(r.managerId, a); }
  const kyivTodayW = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  // ONE-NUMBER: тижнева ЦІЛЬ поточного тижня — ЄДИНИЙ вираз (той самий, що /report-plan і
  // /manager-report): effectiveWeekTargets (manual ?? dynamicTarget.week). Замінює власний
  // fixedWeekBlocks-розрахунок для ПОТОЧНОГО тижня (минулі/майбутні лишаються апортованими
  // для показу Т1–Т5). Місяць = months[0] (KVP — одномісячний скоуп для тижневого розрізу).
  const effWeekKvp = weekBlocks.length ? await plans.effectiveWeekTargets({ month: months[0] }, kyivTodayW) : new Map<number, plans.EffWeekTarget>();
  // #2 pace поточного тижня = минулі робочі дні тижня ÷ усі робочі дні тижня.
  const paceOf = (w: { from: string; to: string }, isCurrent: boolean): number | null => {
    if (!isCurrent) return null;
    const wd = workingDaysBetween(w.from, w.to);
    const elapsedTo = kyivTodayW < w.to ? kyivTodayW : w.to;
    return wd > 0 ? workingDaysBetween(w.from, elapsedTo) / wd : null;
  };
  const weeksForMgr = (mid: number, monthPlan: number) => weekBlocks.map((w) => {
    const wd = workingDaysBetween(w.from, w.to);
    const isCur = w.from <= kyivTodayW && kyivTodayW <= w.to;
    // Поточний тиждень — ЄДИНА ціль (manual ?? dynamic); інші — статичний апорт для Т1–Т5.
    const plan = isCur && effWeekKvp.has(mid) ? effWeekKvp.get(mid)!.target : (wdMonth > 0 ? monthPlan * wd / wdMonth : 0);
    const fact = (mgrDailyMap.get(mid) ?? []).filter((d) => d.bucket >= w.from && d.bucket <= w.to).reduce((a, d) => a + d.revenue, 0);
    const expected = (mgrDayExpMap.get(mid) ?? []).filter((d) => d.day >= w.from && d.day <= w.to).reduce((a, d) => a + d.sum, 0);
    const auto = (mgrDayDispMap.get(mid) ?? []).filter((d) => d.day >= w.from && d.day <= w.to).reduce((a, d) => a + d.deals, 0);
    const autoRevenue = (mgrDayDispMap.get(mid) ?? []).filter((d) => d.day >= w.from && d.day <= w.to).reduce((a, d) => a + d.revenue, 0); // #3 сума авто (signed)
    const leadsAd = (mgrDayLeadsMap.get(mid) ?? []).filter((d) => d.day >= w.from && d.day <= w.to).reduce((a, d) => a + d.ad, 0);
    const leadsLeadgen = (mgrDayLeadsMap.get(mid) ?? []).filter((d) => d.day >= w.from && d.day <= w.to).reduce((a, d) => a + d.leadgen, 0);
    const isCurrent = w.from <= kyivTodayW && kyivTodayW <= w.to;
    return { idx: w.idx, from: w.from, to: w.to, plan, fact, expected, auto, autoRevenue, leadsAd, leadsLeadgen, met: fact >= plan && plan > 0, isCurrent, isFuture: w.from > kyivTodayW, pace: paceOf(w, isCurrent) };
  });
  const expTeamThisMap = new Map(expTeamThis.map((r) => [r.id, r.sum]));
  const expTeamNextMap = new Map(expTeamNext.map((r) => [r.id, r.sum]));

  const mgrPlan = new Map<number, { name: string; teamId: number | null; plan: number }>();
  for (const pr of planRes) for (const row of pr.rows) {
    const e = mgrPlan.get(row.managerId) ?? { name: row.name, teamId: row.teamId, plan: 0 };
    e.plan += row.plan; mgrPlan.set(row.managerId, e);
  }
  // Дисп/передані у періоді = сума місячних бакетів у діапазоні (місяць-вирівняні пресети).
  const inRange = (ym: string) => months.includes(ym + "-01");
  const sumSeries = (rows: { ym: string; deals?: number; revenue?: number; wonEventually?: number; entered?: number }[], k: "deals" | "revenue" | "wonEventually" | "entered") =>
    rows.filter((r) => inRange(r.ym)).reduce((a, r) => a + (Number((r as Record<string, unknown>)[k]) || 0), 0);
  // ⚠️ Bucket-рядки ВЖЕ обрізані діапазоном — фільтр по цілих місяцях тут був би тим
  //    самим роздуванням, лише з іншого боку. Сума всіх рядків = сума за період.
  const sumAll = (rows: { deals: number; revenue: number }[], k: "deals" | "revenue") =>
    rows.reduce((acc, r) => acc + (Number(r[k]) || 0), 0);
  const dispatchedAll = { deals: sumAll(dispatchedAllSeries, "deals"), revenue: sumAll(dispatchedAllSeries, "revenue") };
  const dispatchedLg = { deals: sumAll(dispatchedLgSeries, "deals"), revenue: sumAll(dispatchedLgSeries, "revenue") };
  const transferred = { entered: sumSeries(transferredSeries, "entered"), won: sumSeries(transferredSeries, "wonEventually") };

  /**
   * 📐 АРИФМЕТИКА ВІДСОТКА — РІВНО ОДНА, скоуп передається базою.
   *
   * 🔴 Копій цього виразу в роуті було ПʼЯТЬ (менеджер · команда · двигун · компанія
   * · виконання плану), і всі однакові з точністю до знаменника. Поки смуга показувала
   * саме факт, це терпіли. Щойно смуга стала двосегментною, кожна копія мусила б
   * навчитись рахувати ще й прогноз — тобто пʼять місць, де можна дописати в одне
   * й забути в решті. Той самий клас, що `pctOfPlan` проти власного виразу таблиці.
   *
   * ⚠️ ROMI сюди НЕ їде: у нього база — рекламний бюджет, а не план, і сенс інший.
   */
  const pctOf = (v: number, base: number): number | null =>
    base > 0 ? Math.round((v / base) * 100) : null;
  // ── ТЕАМИ (Σ = відділ) ──
  const teamMap = new Map<number, { teamId: number; name: string; kind: string; plan: number; revenue: number; expected: number; conversion: number | null; entered: number; won: number; managers: Record<string, unknown>[] }>();
  const orphanPlan = new Map<number, number>();
  for (const pr of planRes) pr.orphanPlanByTeam.forEach((v, k) => orphanPlan.set(k, (orphanPlan.get(k) ?? 0) + v));
  const teamGet = (id: number, name: string) => {
    let e = teamMap.get(id);
    if (!e) { e = { teamId: id, name, kind: kvpTeamKind(id, name), plan: orphanPlan.get(id) ?? 0, revenue: 0, expected: 0, conversion: null, entered: 0, won: 0, managers: [] }; teamMap.set(id, e); }
    return e;
  };
  for (const t of receivedTeams) teamGet(t.teamId, t.teamName).revenue += t.revenue;
  for (const r of expectedTeams) { const e = teamMap.get(r.id) ?? teamGet(r.id, r.name); e.expected += r.sum; }
  for (const c of convTeams) if (c.teamId != null) { const e = teamMap.get(c.teamId); if (e) { e.entered = c.entered; e.won = c.won; e.conversion = c.cohortPct; } }
  // менеджери під команду
  const succByMgr = new Map((await money.successByMgr(mScope)).map((x) => [x.managerId, x]));
  const recvByMgr = new Map((await money.receivedByMgr(mScope)).map((x) => [x.managerId, x]));
  const convByMgr = new Map(convMgrs.map((x) => [x.managerId, x]));
  const expByMgr = new Map((await metrics.expectedZoneByScope({}, "manager")).map((x) => [x.id, x]));
  // #4 два середні чеки (одна параметризована avgCheck): «успішно» = success за період
  // (= succByMgr), «в очікуванні оплат» = ЗНІМОК chainInflight станом на зараз (per mgr+team).
  // #2 очікування за плановою датою — per manager (цей / наступний календарний місяць).
  const [ciMgr, ciTeam, suTeam, expMgrThisR, expMgrNextR] = await Promise.all([
    money.avgCheckPerManager("chainInflight", {}), money.avgCheckByTeam("chainInflight", {}),
    money.avgCheckByTeam("success", mScope),
    metrics.expectedMonthByScope({}, "manager", 0), metrics.expectedMonthByScope({}, "manager", 1),
  ]);
  const ciMgrMap = new Map(ciMgr.map((x) => [x.managerId, x]));
  const ciTeamMap = new Map(ciTeam.map((x) => [x.teamId, x]));
  const suTeamMap = new Map(suTeam.map((x) => [x.teamId, x]));
  const expMgrThis = new Map(expMgrThisR.map((x) => [x.id, x.sum]));
  const expMgrNext = new Map(expMgrNextR.map((x) => [x.id, x.sum]));

  // #3 ЛАЙФТАЙМ-КОНВЕРСІЯ РНК/РПК (Варіант A — чесна воронка ≤100%; знаменник за весь час,
  // майже не «дозріває»). Чисельник ТОГО САМОГО каналу, що знаменник (reachedAutoByManager):
  //   РНК = рекламні угоди → «авто працює» ÷ adsAccepted (весь час);
  //   РПК = лідген-угоди   → «авто працює» ÷ leadgen (lead_channel, весь час).
  // 🔴 ЗНАМЕННИК ПЕРЕВЕДЕНО НА КАНАЛ (рішення власника 24.08.2026) — і це ЛАГОДИТЬ
  // ЩЕ ОДИН ДЕФЕКТ, а не лише узгоджує означення. Чисельник `reachedAutoByManager`
  // рахував за `lead_channel` ЗАВЖДИ, а знаменник брався з `leadgen_touch`, який
  // веде лише від 15.06.2026 — тобто велика верхівка ділилась на куций низ, і
  // лайфтайм-конверсія РПК була ЗАВИЩЕНА. Заміряно: знаменник 997 (реєстр) проти
  // 4289 (канал), тобто ×4.3. Рядок вище раніше стверджував «чисельник того самого
  // каналу, що знаменник» — це було НЕПРАВДОЮ; тепер стало правдою. Тримає `#143`.
  // per-manager → команда = Σ (Σ-інваріант). Тонкий знаменник (0) → «—», не «0%».
  const [reachedAuto, adsAllTime, lgAllTime, mgrTeamRows] = await Promise.all([
    metrics.reachedAutoByManager(adSources),
    metrics.adsAcceptedByMgr({}, adSources),
    metrics.conversionByManager({}, "leadgen"),
    pool.query<{ id: number; team_id: number | null }>(`SELECT id, team_id FROM managers WHERE is_active`),
  ]);
  const teamOfMgr = new Map(mgrTeamRows.rows.map((r) => [r.id, r.team_id]));
  const adsByMgr = new Map(adsAllTime.map((x) => [x.managerId, x.count]));
  const lgByMgr = new Map(lgAllTime.map((x) => [x.managerId, x.taken]));
  const convLT = new Map<number, { numAd: number; numLg: number; adsDen: number; lgDen: number }>();
  const bumpLT = (tid: number | null, f: (e: { numAd: number; numLg: number; adsDen: number; lgDen: number }) => void) => {
    if (tid == null) return; const e = convLT.get(tid) ?? { numAd: 0, numLg: 0, adsDen: 0, lgDen: 0 }; f(e); convLT.set(tid, e);
  };
  for (const [mid, ch] of reachedAuto) bumpLT(teamOfMgr.get(mid) ?? null, (e) => { e.numAd += ch.ad; e.numLg += ch.leadgen; });
  for (const [mid, n] of adsByMgr) bumpLT(teamOfMgr.get(mid) ?? null, (e) => { e.adsDen += n; });
  for (const [mid, n] of lgByMgr) bumpLT(teamOfMgr.get(mid) ?? null, (e) => { e.lgDen += n; });
  const lifetimeConvFor = (teamId: number, kind: string): { num: number; den: number; pct: number | null } => {
    const e = convLT.get(teamId) ?? { numAd: 0, numLg: 0, adsDen: 0, lgDen: 0 };
    const num = kind === "rnk" ? e.numAd : kind === "rpk" ? e.numLg : 0;
    const den = kind === "rnk" ? e.adsDen : kind === "rpk" ? e.lgDen : 0;
    return { num, den, pct: den > 0 ? Math.round((num / den) * 1000) / 10 : null };
  };

  for (const [mid, mp] of mgrPlan) {
    if (mp.teamId == null) continue;
    const e = teamGet(mp.teamId, "");
    const rev = recvByMgr.get(mid)?.revenue ?? 0;
    const su = succByMgr.get(mid); const cv = convByMgr.get(mid);
    e.plan += mp.plan;
    e.managers.push({
      managerId: mid, name: mp.name, plan: mp.plan, revenue: rev,
      pct: pctOf(rev, mp.plan),
      // #4 два чеки: avgCheck = «успішно реалізовано» (success, за місяць по closed_at, gate 2878);
      // avgCheckAwaiting = «в очікуванні оплат» (chainInflight, ЗНІМОК станом на зараз).
      avgCheck: su && su.deals > 0 ? Math.round(su.revenue / su.deals) : 0,
      successDeals: su?.deals ?? 0,
      avgCheckAwaiting: ciMgrMap.get(mid)?.avgCheck ?? null, awaitingDeals: ciMgrMap.get(mid)?.deals ?? 0,
      // ONE-NUMBER тижнева ціль (effectiveWeekTargets — байт-в-байт зі Звітом).
      weekTarget: effWeekKvp.get(mid)?.target ?? 0,
      conversion: cv && cv.entered >= 10 ? cv.cohortPct : null, convEntered: cv?.entered ?? 0,
      expected: expByMgr.get(mid)?.sum ?? 0,
      // #2 очікування за плановою датою оплати (цей / наступний календарний місяць).
      expectedThisMonth: expMgrThis.get(mid) ?? 0, expectedNextMonth: expMgrNext.get(mid) ?? 0,
      // Розкол створеного (3 сигнали): created N (нові · постійні · невизн).
      // 🔀 Е4: ТРИ КАНАЛИ, А НЕ ДВА. Проєкція віддавала лише `ad`/`leadgen`, хоч ядро
      // рахує всі чотири — і 44% створеного (999-1010 угод серпня, у РПК 74.4%) не
      // потрапляло на екран узагалі. `other`/`noChannel` беруться з ТОГО САМОГО
      // `splitByMgr`: жодного нового запиту, лише перестала губитись частина.
      createdSplit: (() => { const s = splitByMgr.get(mid); return { created: s?.created ?? 0, new: s?.newCount ?? 0, repeat: s?.repeatCount ?? 0, undef: s?.undefCount ?? 0, ad: s?.adCount ?? 0, leadgen: s?.leadgenCount ?? 0, other: s?.otherCount ?? 0, noChannel: s?.noChannelCount ?? 0 }; })(),
      daily: mgrDailyMap.get(mid) ?? [],   // Крок Д #4: денний дрил (received по днях)
      weeks: weeksForMgr(mid, mp.plan),    // Крок Д фінал #2: тижневий розріз Т1–Т5
    });
  }
  // Крок Д owner-review #1: фінвідділ — НЕ sales-юніт → повністю прибрати зі звіту
  // (received=0, тож Σ teams.revenue не зрушиться).
  type WeekAgg = { idx: number; from: string; to: string; plan: number; fact: number; expected: number; auto: number; autoRevenue: number; leadsAd: number; leadsLeadgen: number; met: boolean; isCurrent: boolean; isFuture: boolean; pace: number | null };
  const teams = [...teamMap.values()].filter((t) => !KVP_FINANCE_TEAM_IDS.has(t.teamId)).map((t) => {
    // Крок Д фінал #2: тижні команди = Σ тижнів менеджерів (per idx). met = teamFact ≥ teamPlan.
    const teamWeeks = weekBlocks.map((w) => {
      const ms = t.managers.map((mm) => ((mm.weeks as WeekAgg[]) ?? []).find((x) => x.idx === w.idx)).filter(Boolean) as WeekAgg[];
      const plan = ms.reduce((a, x) => a + x.plan, 0), fact = ms.reduce((a, x) => a + x.fact, 0), expected = ms.reduce((a, x) => a + x.expected, 0);
      const auto = ms.reduce((a, x) => a + x.auto, 0), autoRevenue = ms.reduce((a, x) => a + x.autoRevenue, 0), leadsAd = ms.reduce((a, x) => a + x.leadsAd, 0), leadsLeadgen = ms.reduce((a, x) => a + x.leadsLeadgen, 0);
      const isCurrent = w.from <= kyivTodayW && kyivTodayW <= w.to;
      return { idx: w.idx, from: w.from, to: w.to, plan, fact, expected, auto, autoRevenue, leadsAd, leadsLeadgen, met: fact >= plan && plan > 0, isCurrent, isFuture: w.from > kyivTodayW, pace: paceOf(w, isCurrent) };
    });
    return {
      teamId: t.teamId, name: t.name, kind: t.kind, plan: t.plan, revenue: t.revenue, expected: t.expected,
      pct: pctOf(t.revenue, t.plan),
      // 📊 Прогнозний відсоток для ДРУГОГО сегмента смуги: факт + очікування за
      //    плановою датою ЦЬОГО місяця. Колонки рядка не чіпаються — лише смуга.
      forecastPct: pctOf(t.revenue + (expTeamThisMap.get(t.teamId) ?? 0), t.plan),
      conversion: t.conversion, entered: t.entered, won: t.won,
      // #3 лайфтайм-конверсія за типом команди (Варіант A, чесна воронка ≤100%, весь час).
      convLifetime: lifetimeConvFor(t.teamId, t.kind),
      // #4 два чеки команди (Σsum÷Σcount): «успішно» (success за місяць) + «в очікуванні» (chainInflight знімок).
      avgCheckSuccess: suTeamMap.get(t.teamId)?.avgCheck ?? null,
      avgCheckAwaiting: ciTeamMap.get(t.teamId)?.avgCheck ?? null,
      expectedThisMonth: expTeamThisMap.get(t.teamId) ?? 0, expectedNextMonth: expTeamNextMap.get(t.teamId) ?? 0,
      weeks: teamWeeks,
      managers: t.managers.sort((a, b) => (Number(a.pct) || 0) - (Number(b.pct) || 0)),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  // Стратегічний план (🔒 read-only) = Σ планів команд у таблиці — ОДНЕ джерело з
  // рядками дашборда. Раніше strategicRevenuePlac фільтрував m.is_active і мовчки
  // губив план звільнених (25к) → вердикт 2.675М ≠ таблиця 2.700М. Тепер вердикт ==
  // Σ команд == Σ менеджерів == Σ тижнів байт-у-байт (managerPlan — єдине джерело).
  /**
   * 🎯 СТРАТПЛАН ЗА ДІАПАЗОНОМ, А НЕ ЗА ЦІЛИМИ МІСЯЦЯМИ.
   *
   * 🔴 ЩО БУЛО ЗЛАМАНО. `months = monthsInRange(from, to)` для тижня 27.07-02.08 дає
   * ОБИДВА місяці, і план складався ПОВНИЙ липень + ПОВНИЙ серпень: **5 459 000 ₴**
   * проти місячних 2 759 000. Тобто вкладений період був удвічі більший за той, що
   * його містить, — твердження, хибне за побудовою.
   *
   * 🔴 ЧОМУ САМЕ РОБОЧІ ДНІ. Календарні дали б липню й серпню однакову вагу за
   * однакову кількість дат, хоча відпрацьованих днів у них різна кількість. Той самий
   * базис уже стоїть під тижневим планом (`weeksForMgr`: `monthPlan × wd ÷ wdMonth`),
   * тож третього означення «частки місяця» тут не заводиться.
   *
   * ⚠️ ПОТОЧНИЙ ТИЖДЕНЬ — ВИНЯТОК, І ЦЕ ПОСИЛЕННЯ, А НЕ ДРУГА ФОРМУЛА. Коли діапазон
   * і Є поточним тижнем одного місяця, беремо `plans.effectiveWeekTargets` — ЄДИНИЙ
   * вираз тижневої цілі, яким живуть `/report-plan`, `/kvp-report` і `/manager-report`
   * (manual ?? dynamic). Інакше КВП показував би СВОЮ тижневу ціль поруч зі Звітом,
   * що показує канонічну, — дві цілі, які розійдуться мовчки.
   */
  const monthAligned = /-01$/.test(from)
    && to === new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const isCurrentWeekOfMonth = months.length === 1 && weekBlocks.some((w) => w.from === from && w.to === to)
    && from <= kyivTodayW && kyivTodayW <= to;
  const planWeight = (m: string): number => {
    if (monthAligned) return 1;
    const mEnd = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const wdM = workingDaysBetween(m, mEnd);
    if (wdM <= 0) return 0;
    return workingDaysBetween(from > m ? from : m, to < mEnd ? to : mEnd) / wdM;
  };
  const strategicProrated = months.reduce((acc, m) => {
    const pr = planRes[months.indexOf(m)];
    if (!pr) return acc;
    const full = pr.rows.reduce((a, r) => a + r.plan, 0)
      + [...pr.orphanPlanByTeam.values()].reduce((a: number, v: number) => a + v, 0);
    return acc + full * planWeight(m);
  }, 0);
  const strategic = monthAligned
    ? teams.reduce((s, t) => s + t.plan, 0)
    : isCurrentWeekOfMonth && effWeekKvp.size
      ? [...effWeekKvp.values()].reduce((a, v) => a + v.target, 0)
      : strategicProrated;

  /**
   * 📐 ВІДСОТОК ПРОГНОЗУ — ОДИН ВИРАЗ НА ВЕСЬ ЗВІТ.
   *
   * 🔴 ЧОМУ ЦЕ ЗʼЯВИЛОСЬ. `buildProjection` кличеться в `Promise.all` ВИЩЕ (рядок
   * ~6786), де `strategic` ще не існує, — тому туди йшов `plan = null`, і
   * `projection.projectedPct` був `null` ЗАВЖДИ, за будь-яких даних. Плитка «Прогноз
   * місяця» друкувала його сирою інтерполяцією й показувала слово **«null% плану»**
   * при живому плані 2 759 000 і прогнозі 2 748 167 — тобто відсоток БУЛО чим
   * порахувати, його просто не рахували.
   *
   * 🔴 І ЦЕ БУЛА НЕ ОДНА ГІЛКА, А ДВІ. Повна таблиця нижче рахувала той самий
   * відсоток власним виразом `strategic > 0 ? … : null` — і показувала правильно.
   * Одне число, два шляхи, різні результати на ОДНОМУ екрані: класика, від якої
   * лікує не латка на `null`, а спільний вираз. Обидві поверхні тепер беруть звідси.
   */
  /** Відсоток КОМПАНІЙСЬКОГО плану — тонка обгортка над спільною арифметикою. */
  const pctOfPlan = (v: number): number | null => pctOf(v, strategic);

  // Тижневий факт дод.показників (датовані по дню анкера, Σтижнів==місяць): успіх(142),
  // нові/постійні отримано, втрачені(143), дохід в очікуванні за ПЛАНОВОЮ датою.
  const inBlk = <T,>(rows: T[], day: (r: T) => string, from: string, to: string) =>
    rows.filter((r) => { const d = day(r); return d >= from && d <= to; });
  // Крок Д (тижневий) #5: рядок ВІДДІЛУ по тижнях = Σ команд (per idx). Гейт: Σ команд == відділ.
  const deptWeeks = weekBlocks.map((w) => {
    const ws = teams.map((t) => t.weeks.find((x) => x.idx === w.idx)).filter(Boolean) as WeekAgg[];
    const s = (k: keyof WeekAgg) => ws.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const successW = inBlk(successDay, (r) => r.bucket, w.from, w.to).reduce((a, r) => a + r.revenue, 0);
    const segW = inBlk(segDay, (r) => r.day, w.from, w.to);
    const lostW = inBlk(lostDay, (r) => r.day, w.from, w.to);
    const expPlannedW = mgrDayExp.filter((r) => r.day >= w.from && r.day <= w.to).reduce((a, r) => a + r.sum, 0);
    return {
      idx: w.idx, from: w.from, to: w.to, plan: s("plan"), fact: s("fact"), expected: s("expected"),
      auto: s("auto"), autoRevenue: s("autoRevenue"), leadsAd: s("leadsAd"), leadsLeadgen: s("leadsLeadgen"),
      success: Math.round(successW),
      newRecv: Math.round(segW.reduce((a, r) => a + r.newRev, 0)),
      repeatRecv: Math.round(segW.reduce((a, r) => a + r.repeatRev, 0)),
      lostDeals: lostW.reduce((a, r) => a + r.deals, 0), lostSum: lostW.reduce((a, r) => a + r.sum, 0),
      expectedPlanned: Math.round(expPlannedW),
      isCurrent: w.from <= kyivTodayW && kyivTodayW <= w.to, isFuture: w.from > kyivTodayW, pace: paceOf(w, w.from <= kyivTodayW && kyivTodayW <= w.to),
    };
  });
  // #8 streak «✗ N тижнів поспіль» = trailing consecutive ЗАВЕРШЕНИХ (past) тижнів з факт<план.
  const failStreak = (weeks: { fact: number; plan: number; isFuture: boolean; isCurrent: boolean }[]): number => {
    const past = weeks.filter((w) => !w.isFuture && !w.isCurrent);
    let s = 0; for (let i = past.length - 1; i >= 0; i--) { if (past[i].plan > 0 && past[i].fact < past[i].plan) s++; else break; }
    return s;
  };

  // ── ДВИГУНИ (team-based) ──
  const engineOf = (kind: string) => {
    const ts = teams.filter((t) => t.kind === kind);
    const plan = ts.reduce((a, t) => a + t.plan, 0), revenue = ts.reduce((a, t) => a + t.revenue, 0), expected = ts.reduce((a, t) => a + t.expected, 0);
    const entered = ts.reduce((a, t) => a + t.entered, 0), won = ts.reduce((a, t) => a + t.won, 0);
    /**
     * 🔴 ДВА РІЗНІ «ОЧІКУЄМО», І ПЛИТКА ДОСІ ПОКАЗУВАЛА НЕ ТЕ.
     *   `expected`          — ЗНІМОК УСІЄЇ зони визнання, без прив'язки до дати;
     *   `expectedThisMonth` — за ПЛАНОВОЮ ДАТОЮ оплати цього місяця.
     * У прогноз входить ДРУГЕ (рішення власника 06.08.2026), а плитка малювала перше.
     * Заміряно на проді 20.08.2026: РПК показував 904 462 ₴ там, де в прогнозі стоїть
     * 800 744 — розрив 103 718 ₴ (88 817 наступного місяця + 14 901 прострочене).
     * Тобто смуга, заповнена «очікуванням» плитки, розійшлась би з прогнозом на екрані.
     * Рішення власника (варіант A): видиме число і смуга — `expectedThisMonth`, повна
     * зона лишається у підказці з власним підписом.
     */
    const expectedThisMonth = ts.reduce((a, t) => a + (expTeamThisMap.get(t.teamId) ?? 0), 0);
    return { plan, revenue, expected, expectedThisMonth,
      pct: pctOf(revenue, plan),
      // Другий сегмент смуги. Може бути >100% — обрізає ШИРИНУ фронт, не число.
      forecastPct: pctOf(revenue + expectedThisMonth, plan),
      conversion: entered >= 10 ? Math.round((won / entered) * 1000) / 10 : null, entered };
  };
  const adBudget = (await pool.query<{ fact: string; plan: string; conv: string }>(
    `SELECT COALESCE(SUM(budget_fact),0) fact, COALESCE(SUM(budget_plan),0) plan, COALESCE(SUM(conversions),0) conv FROM ad_budget_daily WHERE day >= $1 AND day <= $2`, [from, to])).rows[0];
  const adMonthly = await metrics.conversionAdsByMonth(scope, adSources);
  const adEntered = adMonthly.filter((r) => inRange(r.ym)).reduce((a, r) => a + r.entered, 0);
  const adWon = adMonthly.filter((r) => inRange(r.ym)).reduce((a, r) => a + r.wonEventually, 0);
  const adMature = adMonthly.filter((r) => inRange(r.ym)).every((r) => r.mature);
  const budgetFact = Number(adBudget.fact);
  const engines = {
    rpk: engineOf("rpk"), rnk: engineOf("rnk"), leadgenTeam: engineOf("leadgen"),
    ad: {
      budget: Math.round(budgetFact), gaLeads: Number(adBudget.conv),
      romi: budgetFact > 0 ? Math.round((receivedByCh.ad.revenue / budgetFact) * 100) : null,
      cpa: adWon > 0 ? Math.round(budgetFact / adWon) : null,
      cplGa: Number(adBudget.conv) > 0 ? Math.round(budgetFact / Number(adBudget.conv)) : null,
      cplCrm: adEntered > 0 ? Math.round(budgetFact / adEntered) : null,
      conversion: adEntered >= 10 ? Math.round((adWon / adEntered) * 1000) / 10 : null, entered: adEntered, won: adWon, mature: adMature,
      revenue: receivedByCh.ad.revenue,
    },
    leadgen: {
      transferred: transferred.entered, transferredWon: transferred.won,
      dispatched: dispatchedLg.deals, dispatchedRevenue: dispatchedLg.revenue,
      revenue: receivedByCh.leadgen.revenue,
    },
  };

  /**
   * 📈 ПРОГНОЗ — ВАРІАНТ A (рішення власника 20.08.2026): ТА САМА ФОРМУЛА, ЩО НА
   * КАРТЦІ МЕНЕДЖЕРА. Факт ② + очікування з ПЛАНОВОЮ ДАТОЮ цього місяця; добір
   * нового бізнесу з формули виведено й показується ОКРЕМО.
   *
   * 🔴 ЩО БУЛО. КВП рахував `факт + УСЯ зона + добір` (`buildProjection`) — тобто
   * старою формулою, яку для картки менеджера скасували ще 06.08.2026. Заміряно на
   * проді 20.08: **2 748 167 ₴ (99.6% плану)** проти **2 306 403 ₴ (84%)** за
   * формулою картки. Збіг зі стратпланом (Δ 10 833 ₴) був ВИПАДКОВИЙ, і читався як
   * «прогноз дублює план».
   *
   * ⚠️ `mgrDayExp` — те саме джерело (`expectedByManagerDay({})`), що живить картку,
   * і бакетується тим самим кодом. Не «схожий сенс», а один виклик.
   */
  const expSplit = forecast.expectedSplitByMonth(mgrDayExp, kyivTodayW);
  const expThisMonthTotal = [...expSplit.values()].reduce((a, v) => a + v.thisMonth, 0);
  const projectedA = forecast.forecastMonth(received.revenue, expThisMonthTotal, projection.monthInProgress);
  const pace = forecast.paceProjection(received.revenue, projection.elapsedWorkingDays, projection.totalWorkingDays);

  // ── ВЕРДИКТ + LIFECYCLE ──
  const verdict = {
    received: { deals: received.deals, revenue: received.revenue },
    receivedPrev: { revenue: receivedPrev.revenue },
    strategicPlan: strategic,
    planPct: pctOfPlan(received.revenue),
    projection: {
      fact: projection.fact,
      projected: projectedA, projectedPct: pctOfPlan(projectedA),
      expectedThisMonth: Math.round(expThisMonthTotal),
      // 🟡 ДОБІР — ПОРУЧ, НЕ В ПРОГНОЗІ (рішення власника 06.08.2026). Він не
      //    підкріплений документами: це середнє за 3 місяці, а не угоди з датою.
      dobir: Math.round(projection.dobir),
      // ⏱ ТЕМП — ІНШЕ ПИТАННЯ, ніж прогноз: «що вийде, якщо нічого не зміниться».
      //    Розрив між ними і є те, заради чого КВП дивиться на екран.
      pace, pacePct: pace == null ? null : pctOfPlan(pace),
      elapsedWorkingDays: projection.elapsedWorkingDays, totalWorkingDays: projection.totalWorkingDays,
    },
    lifecycle: {
      sent: { deals: dispatchedAll.deals, revenue: dispatchedAll.revenue },
      awaiting: { deals: expectedZone.total.deals, revenue: expectedZone.total.sum },
      received: { deals: received.deals, revenue: received.revenue },
    },
    derived: plans.deriveMonthlyTarget(receivedPrev.revenue),
  };

  /**
   * 🏆 «ТРИМАЮТЬ» — ХТО ЛІДИРУЄ (D2, рішення власника 20.08.2026).
   *
   * 🔴 ПРИВІД. «Сигнали» показували ЛИШЕ падіння (<70% плану, «✗ N тижнів поспіль»),
   * тож екран КВП складався з самих проблем — і не було видно, кого ставити в приклад.
   *
   * 🔴 ПОРІГ ЛІДЕРА НЕ ЗАШИТИЙ — і це вимога, а не зручність. Заміряно на проді
   * 20.08.2026: із **29 менеджерів із планом ≥100% має РІВНО ОДИН**. Умова «показувати
   * тих, хто перевиконав» лишала б блок майже завжди порожнім, тобто мертвим. Тому
   * беремо ТОП-3 за відсотком, яким би він не був: «хто попереду сьогодні» — питання,
   * що має відповідь у будь-який день місяця.
   *
   * 🔴 АБСОЛЮТ ПОРУЧ ІЗ ВІДСОТКОМ — ОБОВʼЯЗКОВО. 97% на плані 39 000 і 64% на плані
   * 300 000 (обидва живі приклади того ж заміру) без абсолюту читаються навпаки:
   * менший план дає більший відсоток за вчетверо менші гроші.
   */
  const topPerformers = teams
    .filter((t) => t.kind === "rpk" || t.kind === "rnk")
    .flatMap((t) => (t.managers as { name: string; plan: number; revenue: number; pct: number | null }[])
      .filter((m) => m.plan > 0 && m.pct != null)
      .map((m) => ({ name: m.name, team: t.name, plan: Math.round(m.plan), fact: Math.round(m.revenue), pct: m.pct as number })))
    .sort((a, b) => b.pct - a.pct || b.fact - a.fact)
    .slice(0, 3);

  // ── СИГНАЛИ (деривовані, ранж за гостротою) ──
  const signals: { severity: string; icon: string; title: string; detail: string; action: string; expectedThisMonth?: number; expectedNextMonth?: number }[] = [];
  for (const t of teams.filter((x) => x.kind === "rpk" || x.kind === "rnk")) {
    // Крок Д фінал #3: командний сигнал несе очікування цей/наступний (планова дата).
    if (t.pct != null && t.pct < 70 && t.plan > 0) signals.push({ severity: t.pct < 50 ? "critical" : "serious", icon: "📉", title: `${t.name}: ${t.pct}% плану`, detail: `факт ${Math.round(t.revenue).toLocaleString("uk-UA")} з ${Math.round(t.plan).toLocaleString("uk-UA")}`, action: "перевірити менеджерів команди (дриллдаун нижче)", expectedThisMonth: t.expectedThisMonth, expectedNextMonth: t.expectedNextMonth });
  }
  // #8 «✗ N тижнів поспіль» (≥3) — системний провал → особистий розбір. Команди й менеджери.
  for (const t of teams.filter((x) => x.kind === "rpk" || x.kind === "rnk")) {
    const ts = failStreak(t.weeks);
    if (ts >= 3) signals.push({ severity: "critical", icon: "🔴", title: `${t.name}: ✗ ${ts} тижні поспіль`, detail: `${ts} завершених тижні факт < план поспіль`, action: "системний провал команди → особистий розбір з тімлідом" });
    for (const mm of t.managers as { name: string; weeks: { fact: number; plan: number; isFuture: boolean; isCurrent: boolean }[] }[]) {
      const ms = failStreak(mm.weeks);
      if (ms >= 3) signals.push({ severity: "critical", icon: "🔴", title: `${mm.name}: ✗ ${ms} тижні поспіль`, detail: `${t.name} · ${ms} завершених тижні факт < план поспіль`, action: "системний провал → особистий розбір" });
    }
  }
  if (engines.ad.mature === false && sc.isCurrent) signals.push({ severity: "info", icon: "⏳", title: "Конверсія реклами дозріває", detail: `когорта <90 днів (${engines.ad.entered} лідів)`, action: "оцінювати за зрілий місяць" });
  if (expectedZone.total.sum > 0) signals.push({ severity: "warning", icon: "💰", title: `В очікуванні ${Math.round(expectedZone.total.sum).toLocaleString("uk-UA")} ₴`, detail: `${expectedZone.total.deals} угод у зоні виставлено→оплата`, action: "тиснути на дебіторку/оплати" });
  /**
   * ⏰ ПЛАНОВА ДАТА ВЖЕ МИНУЛА — окремий сигнал, і він НЕ про суму.
   *
   * Заміряно на проді 20.08.2026: **163 угоди на 20 995 ₴** мають планову дату
   * раніше за початок періоду. Багато угод, мізерні гроші — тобто це або дрібні
   * хвости, або зіпсовані дати, і в обох випадках зона очікування містить те, чого
   * там бути не має. Мовчки включати їх у «очікуємо» означало б обіцяти гроші за
   * домовленістю, термін якої вийшов.
   */
  const overdueExp = mgrDayExp.filter((r) => r.day < from).reduce((a, r) => ({ n: a.n + 1, sum: a.sum + r.sum }), { n: 0, sum: 0 });
  if (overdueExp.n > 0) signals.push({ severity: "warning", icon: "⏰",
    title: `Планова дата минула: ${overdueExp.n} записів на ${Math.round(overdueExp.sum).toLocaleString("uk-UA")} ₴`,
    detail: "оплата очікувалась ДО початку періоду — домовленість прострочена або дата не оновлена",
    action: "перепитати дату оплати або зняти з очікувань" });
  signals.sort((a, b) => ({ critical: 0, serious: 1, warning: 2, info: 3 } as Record<string, number>)[a.severity] - ({ critical: 0, serious: 1, warning: 2, info: 3 } as Record<string, number>)[b.severity]);

  res.json({
    // `monthAligned` — чесна ознака для екрана: «передані заявки» лишились МІСЯЧНИМИ
    // (`conversionTransferredByMonth` денного розрізу не має), тож на не-місячному
    // діапазоні вони описують місяці, а не діапазон. Без цієї ознаки екран мовчки
    // видавав би одне за інше — те саме, від чого ми щойно вилікували план і «авто».
    scope: { from, to, prevFrom: sc.prevFrom, prevTo: sc.prevTo, preset: String(req.query.preset ?? "month"), label: sc.label, isCurrent: sc.isCurrent, monthAligned },
    weekBlocks: weekBlocks.map((w) => ({ idx: w.idx, from: w.from, to: w.to, isCurrent: w.from <= kyivTodayW && kyivTodayW <= w.to, isFuture: w.from > kyivTodayW, pace: paceOf(w, w.from <= kyivTodayW && kyivTodayW <= w.to), workingDays: workingDaysBetween(w.from, w.to) })),
    deptWeeks,
    strategicPlan: strategic,   // 🔒 read-only
    verdict, signals, topPerformers, engines, teams,
    retention: {
      newToRepeat, activeBase, weeklyRegulars: weeklyReg,
      nonTarget, receivablesPaidOff: null, // «—»: немає джерела історії погашень
    },
    // Крок Д owner-review #3: СТРУКТУРА ВИРУЧКИ — 2 етапи client-grain.
    //  received — та САМА каса, що verdict (receivedMoney), розкладена по сегменту +
    //             ЯВНИЙ залишок (unattributed). Σ(new+repeat+unattributed) == received.
    //  expected — зона визнання EXPECT_ZONE (знімок) по сегменту. Σ == expectedZone.total.
    //  legacy — стара created-at-based newRepeatByScope (client-grain лінз) для повної таблиці.
    revenueStructure: {
      received: {
        new: receivedSeg.newSeg, repeat: receivedSeg.repeatSeg, unattributed: receivedSeg.unattributed,
        total: { deals: received.deals, revenue: received.revenue },
      },
      expected: {
        new: expectedSeg.newSeg, repeat: expectedSeg.repeatSeg, unattributed: expectedSeg.unattributed,
        total: { deals: expectedZone.total.deals, sum: expectedZone.total.sum },
      },
    },
    // Блок A — НОВІ метрики повної таблиці (місяць-онлі знімки/ратіо).
    //  forecast = прогноз (факт+зона+добір, buildProjection); neededPacePerDay = скільки
    //  треба закривати щодня, щоб дійти плану (залишок ÷ робочі дні, що ЛИШИЛИСЬ);
    //  overdue = прострочена оплата (знімок); cac = бюджет ÷ нові клієнти; avgCycleDays =
    //  сер. цикл угоди; lost = нецільові + відмови(143), к-сть+сума.
    newMetrics: (() => {
      const remainWd = Math.max(0, projection.totalWorkingDays - projection.elapsedWorkingDays);
      const remainPlan = Math.max(0, strategic - received.revenue);
      const newClients = newRepeatTot.newClients ?? 0;
      return {
        forecast: { projected: projectedA, fact: projection.fact, projectedPct: pctOfPlan(projectedA) },
        neededPacePerDay: remainWd > 0 ? Math.round(remainPlan / remainWd) : null,
        remainingWorkingDays: remainWd,
        remainingPlan: remainPlan,
        overduePayments: overdue,                       // { count, sum } — знімок «зараз»
        cac: newClients > 0 ? Math.round(budgetFact / newClients) : null,
        cacBudget: Math.round(budgetFact), cacNewClients: newClients,
        avgCycleDays: avgCycle,
        lost: { deals: lost.count, sum: lost.sum, nonTargetLeads: nonTarget },
      };
    })(),
    segments: { totals: newRepeatTot, byManager: newRepeatMgr, byTeam: newRepeatTeam },
    // Розкол СТВОРЕНОГО: ПАРТИЦІЯ новизни (new+repeat+undef = created, канон
    // `priorClientSql`) + НАКЛАДКА джерела (`ad`/`leadgen` ⊂ партиція, у created НЕ
    // додаються). totals = Σ по відділу; byManager несе teamId (FE зводить у команду/відділ). Погранична
    // деталізація (нові/постійні по тижнях/днях) — у /kvp-report/manager-detail (createdSplitByBucket).
    createdSplit: {
      totals: createdSplitMgr.reduce((a, x) => ({
        created: a.created + x.created, new: a.new + x.newCount, repeat: a.repeat + x.repeatCount, undef: a.undef + x.undefCount,
        ad: a.ad + x.adCount, leadgen: a.leadgen + x.leadgenCount, other: a.other + x.otherCount, noChannel: a.noChannel + x.noChannelCount,
      }), { created: 0, new: 0, repeat: 0, undef: 0, ad: 0, leadgen: 0, other: 0, noChannel: 0 }),
      byManager: createdSplitMgr.map((x) => ({ managerId: x.managerId, name: x.name, teamId: x.teamId, created: x.created, new: x.newCount, repeat: x.repeatCount, undef: x.undefCount, ad: x.adCount, leadgen: x.leadgenCount, other: x.otherCount, noChannel: x.noChannelCount })),
    },
    money: { received: { deals: received.deals, revenue: received.revenue }, success: { deals: success.deals, revenue: success.revenue }, paidOnly: { deals: paidOnly.deals, revenue: paidOnly.revenue }, awaitingNow, expectedThis: expectedZone.thisMonth, expectedNext: expectedZone.nextMonth, expectedZoneTotal: { deals: expectedZone.total.deals, sum: expectedZone.total.sum } },
    funnel: funnel.map((r) => ({ stage: r.stage, deals: r.deals, revenue: r.revenue })),
    // Блок B — ЛОГІСТИКА. direction/salesChannel — розклад received (Σ == received).
    //  concentration = топ-N клієнтів % received; repeatRides = клієнти по к-ті рейсів у
    //  періоді; transit/dso — часові проксі; aging — прострочка по кошиках; margin LOCKED
    //  (собівартість ~0% — поле є, не заповнюється). fillRates — % заповнення нових полів.
    logistics: (() => {
      const fill = (rows: { key: string; deals: number }[]) => {
        const tot = rows.reduce((a, r) => a + r.deals, 0);
        const filled = rows.filter((r) => r.key !== "—").reduce((a, r) => a + r.deals, 0);
        return tot > 0 ? Math.round((filled / tot) * 1000) / 10 : 0;
      };
      const named = clientRev.filter((c) => c.key !== "—").sort((a, b) => b.revenue - a.revenue);
      const totalRev = clientRev.reduce((a, c) => a + c.revenue, 0);
      const topN = 5;
      const topRev = named.slice(0, topN).reduce((a, c) => a + c.revenue, 0);
      const bucketRides = (lo: number, hi: number) => {
        const cs = named.filter((c) => c.deals >= lo && (hi === Infinity || c.deals <= hi));
        return { clients: cs.length, revenue: Math.round(cs.reduce((a, c) => a + c.revenue, 0)) };
      };
      const convByDir = new Map(dirConv.map((c) => [c.key, c]));
      return {
        // напрямок + конверсія реклами по напрямку (когорта ad-new; ⏳ якщо <10 у зоні).
        direction: dirSplit.map((d) => { const c = convByDir.get(d.key); return { ...d, conversion: c?.cohortPct ?? null, convEntered: c?.entered ?? 0 }; }),
        salesChannel: chanSplit,
        transit, dso, aging,
        concentration: { topN, topRevenue: Math.round(topRev), totalRevenue: Math.round(totalRev), pct: totalRev > 0 ? Math.round((topRev / totalRev) * 1000) / 10 : null, clients: named.length,
          topClients: named.slice(0, topN).map((c) => ({ key: c.key, revenue: Math.round(c.revenue), deals: c.deals })) },
        repeatRides: [
          { bucket: "1", ...bucketRides(1, 1) },
          { bucket: "2-3", ...bucketRides(2, 3) },
          { bucket: "4+", ...bucketRides(4, Infinity) },
        ],
        fillRates: { requestType: fill(dirSplit), salesChannel: fill(chanSplit) },
        margin: null,   // LOCKED — собівартість не заповнюється
      };
    })(),
  });
});

// ───────────────────────── Р4a: ЄДИНИЙ ЗВІТ (manager-report) ─────────────────────────

/**
 * Р4a — ЄДИНИЙ звіт (менеджер / тімлід / КВП) з фільтром рівня. Чистий шар
 * ЗБІРКИ: усі секції з наявних core-функцій (money/metrics), сам майже нічого не
 * рахує. scope-резолвер жорстко обмежує за роллю (403 при виході за межі).
 * Легасі (/report,/overview) не чіпаємо — приберемо окремим кроком.
 * (/kvp-extra зі списку прибрано 03.09.2026 разом із самим роутом — див. мітку 🪦 вище.)
 */
dashboardRouter.get("/manager-report", async (req, res) => {
  const auth = req.auth!;
  const reqLevel = (String(req.query.level ?? "department")) as "department" | "team" | "manager";
  const reqId = req.query.id ? Number(req.query.id) : null;

  // ── єдиний scope-резолвер + роль-обмеження ──
  let level: "department" | "team" | "manager";
  let managerId: number | null = null;
  let teamId: number | null = null;
  if (auth.role === "manager") {
    if (reqLevel !== "manager" || (reqId && reqId !== auth.managerId))
      return res.status(403).json({ error: "Менеджер бачить лише свій звіт" });
    level = "manager"; managerId = auth.managerId;
  } else if (auth.role === "team_lead") {
    if (reqLevel === "manager") {
      if (!reqId) return res.status(400).json({ error: "id менеджера обовʼязковий" });
      const chk = await pool.query(`SELECT 1 FROM managers WHERE id = $1 AND team_id = $2`, [reqId, auth.teamId]);
      if (!chk.rowCount) return res.status(403).json({ error: "Менеджер не з вашої команди" });
      level = "manager"; managerId = reqId;
    } else {
      level = "team"; teamId = auth.teamId;
    }
  } else {
    level = reqLevel;
    if (level === "manager") { if (!reqId) return res.status(400).json({ error: "id обовʼязковий" }); managerId = reqId; }
    else if (level === "team") { if (!reqId) return res.status(400).json({ error: "id обовʼязковий" }); teamId = reqId; }
  }

  const from = (req.query.from as string) ?? null;
  const to = (req.query.to as string) ?? null;
  if (!from || !to) return res.status(400).json({ error: "from/to обовʼязкові" });
  const granularity: "month" | "week" = req.query.granularity === "week" ? "week" : "month";
  const compareFrom = (req.query.compareFrom as string) ?? null;
  const compareTo = (req.query.compareTo as string) ?? null;
  const { adSources } = await getSettings();

  const monthStartOf = (d: string) => d.slice(0, 7) + "-01";
  const planScopeSql = (p: unknown[], mgrCol = "p.manager_id", teamCol = "mp.team_id") => {
    const sc: string[] = [];
    if (managerId) { p.push(managerId); sc.push(`${mgrCol} = $${p.length}`); }
    if (teamId) { p.push(teamId); sc.push(`${teamCol} = $${p.length}`); }
    return sc.length ? "AND " + sc.join(" AND ") : "";
  };
  async function fetchPlan(mFrom: string): Promise<number> {
    const p: unknown[] = [monthStartOf(mFrom)];
    // Ціль відділу/команди = УСІ плани (вкл. деактивованих): їхній план не зникає, а
    // РОЗПОДІЛЯЄТЬСЯ на активних членів команди (рішення власника) → депт лишається 2.7 млн.
    const r = await pool.query<{ s: string }>(
      `SELECT COALESCE(SUM(p.planned_value),0) s FROM plans p JOIN managers mp ON mp.id = p.manager_id
        WHERE p.metric='payment_amount' AND date_trunc('month',p.plan_date) = $1::date ${planScopeSql(p)}`, p);
    return Math.round(Number(r.rows[0]?.s ?? 0));
  }
  async function fetchCarryover(mFrom: string): Promise<{ amount: number; deals: number }> {
    // ЄДИНЕ ЯДРО metrics.carryoverByScope (детермінована реконструкція з deal_stage_events
    // на 00:00 дня-1 місяця, зона EXPECT_ZONE) — та сама функція, що й Огляд → Δ=0.
    // Прибрано читання знімок-таблиці monthly_carryover_mgr (корумпувалась рестартами).
    return metrics.carryoverByScope({ managerId, teamId }, monthStartOf(mFrom));
  }

  const T = metrics.CONVERSION_TARGETS;
  const vs = (v: number | null, target: number) => (v == null ? null : Math.round((v - target) * 10) / 10);

  async function buildPeriod(pFrom: string, pTo: string) {
    const [plan, succFlow, funnel, expected, adsRows, pzRows, reRows, carry] = await Promise.all([
      fetchPlan(pFrom),
      money.successMoney({ from: pFrom, to: pTo, managerId, teamId }),
      metrics.funnelCohortHonest({ from: pFrom, to: pTo, managerId, teamId }, granularity),
      metrics.expectedPaymentsByPlanned({ managerId, teamId }),
      metrics.conversionAdsByMonth({ managerId, teamId }, adSources),
      metrics.conversionProdzvinByMonth({ managerId, teamId }),
      metrics.conversionReactivationByMonth({ managerId, teamId }),
      fetchCarryover(pFrom),
    ]);
    // 🔴 ПРОГНОЗ = ФОРМУЛА A через ЄДИНЕ ЯДРО metrics.buildProjection (та сама функція,
    // що й плитка «Прогноз» Огляду — нуль дублювання). Композиція (факт + повна зона +
    // добір, guard monthInProgress) живе ТІЛЬКИ там; тут лише читаємо результат.
    const proj = await metrics.buildProjection({ from: pFrom, to: pTo, managerId, teamId, granularity }, plan);
    const ad = sumConv(adsRows, pFrom, pTo), pz = sumConv(pzRows, pFrom, pTo), re = sumConv(reRows, pFrom, pTo);
    const fact = proj.fact; // ЄДИНЕ джерело «факту» (= receivedMoney)
    return {
      revenue: {
        plan, fact,
        // Датований потік (success по closed_at) — база ЧЕСНОГО Δ між періодами:
        // received-снапшот (paidOnly) несиметричний між «свіжим» і «дозрілим» місяцем.
        successFlow: succFlow.revenue,
        pctComplete: plan > 0 ? Math.round((fact / plan) * 100) : null,
        remaining: Math.max(0, plan - fact),
        projection: {
          projected: proj.projected,
          projectedPct: proj.projectedPct,
          zoneFull: proj.zoneFull, zoneDeals: proj.zoneDeals, dobir: proj.dobir,
          byPace: proj.byPace,
          byPacePct: plan > 0 ? Math.round((proj.byPace / plan) * 100) : null,
          floor: proj.floor,
          floorPct: plan > 0 ? Math.round((proj.floor / plan) * 100) : null,
          elapsedWorkingDays: proj.elapsedWorkingDays, totalWorkingDays: proj.totalWorkingDays,
        },
      },
      funnel,
      expected: { total: expected.total, thisMonth: expected.thisMonth, nextMonth: expected.nextMonth, overdue: expected.overdue, later: expected.later, noDate: expected.noDate },
      conversions: {
        ads: { cohort: ad.wonCohort, period: ad.wonPeriod, entered: ad.entered, mature: ad.mature, target: T.ads, vsTarget: vs(ad.wonCohort, T.ads) },
        prodzvin: { won: pz.wonCohort, handoff: pz.handoffCohort, entered: pz.entered, mature: pz.mature, target: T.leadgen, vsTarget: vs(pz.wonCohort, T.leadgen) },
        reactivation: { won: re.wonCohort, handoff: re.handoffCohort, entered: re.entered, mature: re.mature, target: T.leadgen, vsTarget: vs(re.wonCohort, T.leadgen) },
      },
      carryover: carry,
    };
  }

  const current = await buildPeriod(from, to);
  const compareData = compareFrom && compareTo ? await buildPeriod(compareFrom, compareTo) : null;

  // Тижнева розбивка — по місяцю поточного періоду.
  const weekly = await money.weeklyBreakdown({ from: monthStartOf(from), managerId, teamId }, current.revenue.plan);
  // ONE-NUMBER: ціль ПОТОЧНОГО тижня — ЄДИНИЙ вираз effectiveWeekTargets (той самий, що
  // /report-plan і /kvp-report). Прибираємо другий динамічний розрахунок weeklyBreakdown для
  // поточного тижня: перезаписуємо його plan цією цифрою (manual ?? dynamic), pct/remaining слідом.
  const kyivTodayMR = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const effWeekMR = await plans.effectiveWeekTargets({ managerId, teamId, month: monthStartOf(from) }, kyivTodayMR);
  const effWeekTarget = managerId ? (effWeekMR.get(managerId)?.target ?? 0) : [...effWeekMR.values()].reduce((a, e) => a + e.target, 0);
  for (const w of weekly) {
    if (w.status !== "current") continue;
    w.plan = effWeekTarget;
    w.pct = effWeekTarget > 0 ? Math.round((w.fact / effWeekTarget) * 100) : null;
    w.remaining = Math.max(0, effWeekTarget - w.fact);
  }

  // §3 поденний+потижневий деталь — усі бакет-функції single-anchor (день=тиждень=місяць).
  // Ліди — leadsTakenByBucket (single-anchor, спліт каналу); авто=success; отримано=received;
  // створено=created; план/день = місячний план ÷ робочі дні. Скоуп як у решті звіту.
  const mStartD = monthStartOf(from);
  const [dyY, dyM] = mStartD.split("-").map(Number);
  const daysInMon = new Date(dyY, dyM, 0).getDate();
  const mEndD = `${mStartD.slice(0, 7)}-${String(daysInMon).padStart(2, "0")}`;
  const dayScope = { from: mStartD, to: mEndD, managerId, teamId };
  // `recvDay` більше немає окремим запитом: поденне «Отримано» тепер ① — те саме,
  // що `dispDay`. Тримати два запити, які після переходу дають однакове число,
  // означало б лишити місце, де вони колись знову розійдуться.
  const [leadsDay, createdDay, dispDay, expDayAll, ppd] = await Promise.all([
    metrics.leadsTakenByBucket(dayScope, "day", true),
    metrics.createdByBucket(dayScope, "day"),
    money.successByBucket(dayScope, "day"),
    metrics.expectedByPlannedBucket({ managerId, teamId }, "day"),
    plans.planPerWorkingDay({ managerId, teamId }, mStartD),
  ]);
  type DailyRow = { date: string; leadsAd: number; leadsLeadgen: number; leadsOther: number; leadsTotal: number; created: number; dispatched: number; dispatchedSum: number; received: number; plan: number; working: boolean };
  const dmap = new Map<string, DailyRow>();
  for (let d = 1; d <= daysInMon; d++) {
    const date = `${mStartD.slice(0, 7)}-${String(d).padStart(2, "0")}`;
    const dow = new Date(dyY, dyM - 1, d).getDay();
    const working = dow !== 0 && dow !== 6;
    dmap.set(date, { date, leadsAd: 0, leadsLeadgen: 0, leadsOther: 0, leadsTotal: 0, created: 0, dispatched: 0, dispatchedSum: 0, received: 0, plan: working ? ppd.perWorkingDay : 0, working });
  }
  for (const r of leadsDay) {
    const e = dmap.get(r.bucket); if (!e) continue;
    if (r.channel === "ad") e.leadsAd += r.deals; else if (r.channel === "leadgen") e.leadsLeadgen += r.deals; else e.leadsOther += r.deals;
    e.leadsTotal += r.deals;
  }
  for (const r of createdDay) { const e = dmap.get(r.bucket); if (e) e.created += r.deals; }
  for (const r of dispDay) { const e = dmap.get(r.bucket); if (e) { e.dispatched += r.deals; e.dispatchedSum += r.revenue; } }
  for (const r of dispDay) { const e = dmap.get(r.bucket); if (e) e.received += r.revenue; }
  const daily = [...dmap.values()];
  // Очікування по дню (планова дата) — лише цей місяць (для потижневого згортання блоками
  // 1-7/8-14/… як у weekly). Місяць this/next лишається у current.expected (не дублюємо).
  const expectedByDay = expDayAll.filter((r) => r.bucket >= mStartD && r.bucket <= mEndD).map((r) => ({ date: r.bucket, sum: r.sum, deals: r.deals }));
  const planPerDay = ppd;

  // Розрізи бакета «Цей місяць» очікувань (дрілдаун картки; те саме джерело, що
  // expected.thisMonth → Σ менеджерів = команда = відділ). Скоуп як у решті звіту.
  const [expectedByTeam, expectedByManager] = await Promise.all([
    metrics.expectedThisMonthByScope({ managerId, teamId }, "team"),
    metrics.expectedThisMonthByScope({ managerId, teamId }, "manager"),
  ]);
  const expThisByTeam = new Map(expectedByTeam.map((r) => [r.id, r.sum]));

  // Carryover-РОЗРІЗ по менеджерах/командах — та сама детермінована реконструкція
  // (metrics.carryoverByManager, зона EXPECT_ZONE на 00:00 дня-1), що живить скалярний
  // data.carryover і /report·plans-grid. Інваріант: Σ мгр = команда = скалярний тотал.
  const coByMgrRows = await metrics.carryoverByManager({ managerId, teamId }, monthStartOf(from));
  const coByMgr = new Map(coByMgrRows.map((r) => [r.managerId, { amount: r.amount, deals: r.deals }]));
  const teamOfMgr = new Map(
    (await pool.query<{ id: number; team_id: number | null }>(`SELECT id, team_id FROM managers`)).rows.map((r) => [r.id, r.team_id])
  );
  const coByTeam = new Map<number, { amount: number; deals: number }>();
  for (const r of coByMgrRows) {
    const tid = teamOfMgr.get(r.managerId);
    if (tid == null) continue;
    const e = coByTeam.get(tid) ?? { amount: 0, deals: 0 };
    e.amount += r.amount; e.deals += r.deals; coByTeam.set(tid, e);
  }

  // Світлофор команд — лише на рівні department (найгірші зверху).
  // Δ (flowCur/flowPrev) — like-for-like по ДАТОВАНОМУ потоку (successByTeam): received-
  // снапшот несиметричний між свіжим MTD і дозрілим минулим місяцем. fact (для % плану)
  // лишається received — та сама база, що план/факт.
  let teams: { teamId: number; teamName: string; plan: number; fact: number; pctPlan: number | null; remaining: number; expectedThisMonth: number; carryover: { amount: number; deals: number }; flowCur: number | null; flowPrev: number | null }[] | undefined;
  if (level === "department") {
    const [facts, plansRes, namesRes, flowsCur, flowsPrev] = await Promise.all([
      money.successByTeam({ from, to }),                 // ① результат команди
      pool.query<{ team_id: number; s: string }>(
        // План команди = УСІ плани її членів (вкл. деактивованих) → ціль команди повна;
        // деактивований плану не втрачає, він перерозподіляється на активних (нижче).
        `SELECT mp.team_id, COALESCE(SUM(p.planned_value),0) s FROM plans p JOIN managers mp ON mp.id = p.manager_id
          WHERE p.metric='payment_amount' AND date_trunc('month',p.plan_date) = $1::date AND mp.team_id IS NOT NULL GROUP BY mp.team_id`, [monthStartOf(from)]),
      pool.query<{ id: number; name: string }>(`SELECT id, name FROM teams`),
      compareFrom && compareTo ? money.successByTeam({ from, to }) : Promise.resolve(null),
      compareFrom && compareTo ? money.successByTeam({ from: compareFrom, to: compareTo }) : Promise.resolve(null),
    ]);
    const planByTeam = new Map(plansRes.rows.map((r) => [r.team_id, Math.round(Number(r.s))]));
    const nameByTeam = new Map(namesRes.rows.map((r) => [r.id, r.name]));
    const factByTeam = new Map(facts.filter((t) => t.teamId != null).map((t) => [t.teamId, { name: t.teamName, revenue: Math.round(t.revenue) }]));
    const curByTeam = flowsCur ? new Map(flowsCur.filter((t) => t.teamId != null).map((t) => [t.teamId, Math.round(t.revenue)])) : null;
    const prevByTeam = flowsPrev ? new Map(flowsPrev.filter((t) => t.teamId != null).map((t) => [t.teamId, Math.round(t.revenue)])) : null;
    // Рядки = ОБʼЄДНАННЯ команд-з-планом і команд-з-фактом (не лише факт) → команди з
    // планом і 0 факту видимі при 0%, зверху. Σ планів = дептовий план (без деактивованих).
    const teamIds = new Set<number>([...factByTeam.keys(), ...planByTeam.keys(), ...coByTeam.keys()]);
    teams = [...teamIds].map((tid) => {
      const plan = planByTeam.get(tid) ?? 0;
      const fact = factByTeam.get(tid)?.revenue ?? 0;
      return {
        teamId: tid, teamName: factByTeam.get(tid)?.name ?? nameByTeam.get(tid) ?? "—", plan, fact,
        pctPlan: plan > 0 ? Math.round((fact / plan) * 100) : null, remaining: Math.max(0, plan - fact),
        expectedThisMonth: Math.round(expThisByTeam.get(tid) ?? 0),
        carryover: coByTeam.get(tid) ?? { amount: 0, deals: 0 },
        flowCur: curByTeam ? (curByTeam.get(tid) ?? 0) : null,
        flowPrev: prevByTeam ? (prevByTeam.get(tid) ?? 0) : null,
      };
    }).sort((a, b) => (a.pctPlan ?? 999) - (b.pctPlan ?? 999)); // найгірші зверху (0% вгорі)
  }

  // Рядки ПО МЕНЕДЖЕРАХ (той самий формат, що teams): для дрілу «команда→менеджери»
  // (level=team, скоуп по teamId) і плоского рейтингу «Усі менеджери» (level=department).
  // % плану — нативний план менеджера з `plans` (per manager_id); Σ планів = план команди
  // = відділ (доведено). Менеджери без плану → pctPlan=null («без плану», у низ).
  let managers: { managerId: number; name: string; teamId: number | null; plan: number; fact: number; pctPlan: number | null; remaining: number; expectedThisMonth: number; carryover: { amount: number; deals: number }; flowCur: number | null; flowPrev: number | null }[] | undefined;
  if (level !== "manager") {
    const mStart = monthStartOf(from);
    const [mFacts, planRes, teamFacts, mFlowCur, mFlowPrev] = await Promise.all([
      // 🔴 ПРАВИЛО ВЛАСНИКА (02.08.2026): факт менеджера/команди — ① «успішно
      // реалізовано». Було `receivedByMgr`/`receivedByTeam` (②): план/факт і %
      // ОЦІНЮЮТЬ роботу, а частково оплачена угода переїздить у наступний місяць.
      money.successByMgr({ from, to, managerId, teamId }),
      // 🔴 План на менеджера (базовий + розподіл звільнених) — ЄДИНЕ ЯДРО core/plans.
      // Та сама функція, що й /teams drill → числа світлофора й /teams збігаються.
      plans.managerPlan({ teamId, month: mStart }),
      money.successByTeam({ from, to, teamId }),
      compareFrom && compareTo ? money.successByMgr({ from, to, managerId, teamId }) : Promise.resolve(null),
      compareFrom && compareTo ? money.successByMgr({ from: compareFrom, to: compareTo, managerId, teamId }) : Promise.resolve(null),
    ]);
    const factByMgr = new Map(mFacts.map((m) => [m.managerId, Math.round(m.revenue)]));
    const teamFactMap = new Map(teamFacts.filter((t) => t.teamId != null).map((t) => [t.teamId, { name: t.teamName, revenue: Math.round(t.revenue) }]));
    const expByMgr = new Map(expectedByManager.map((r) => [r.id, r.sum]));
    const curByMgr = mFlowCur ? new Map(mFlowCur.map((m) => [m.managerId, Math.round(m.revenue)])) : null;
    const prevByMgr = mFlowPrev ? new Map(mFlowPrev.map((m) => [m.managerId, Math.round(m.revenue)])) : null;

    const activeFactByTeam = new Map<number | null, number>();
    const activeCarryByTeam = new Map<number | null, { amount: number; deals: number }>();
    const rows: NonNullable<typeof managers> = [];
    for (const r of planRes.rows) {
      const plan = r.plan; // власний + частка звільнених (core/plans)
      const fact = factByMgr.get(r.managerId) ?? 0;
      const carryover = coByMgr.get(r.managerId) ?? { amount: 0, deals: 0 };
      activeFactByTeam.set(r.teamId, (activeFactByTeam.get(r.teamId) ?? 0) + fact);
      const ac = activeCarryByTeam.get(r.teamId) ?? { amount: 0, deals: 0 };
      ac.amount += carryover.amount; ac.deals += carryover.deals; activeCarryByTeam.set(r.teamId, ac);
      // Тримаємо й carryover-only менеджера (немає плану/факту, але є перенесені) —
      // інакше Σ мгр carryover < команда (розрив у дрілдауні).
      if (plan <= 0 && fact <= 0 && carryover.deals === 0) continue;
      rows.push({
        managerId: r.managerId, name: r.name, teamId: r.teamId, plan, fact,
        pctPlan: plan > 0 ? Math.round((fact / plan) * 100) : null, remaining: Math.max(0, plan - fact),
        expectedThisMonth: Math.round(expByMgr.get(r.managerId) ?? 0),
        carryover,
        flowCur: curByMgr ? (curByMgr.get(r.managerId) ?? 0) : null,
        flowPrev: prevByMgr ? (prevByMgr.get(r.managerId) ?? 0) : null,
      });
    }
    // 🔴 ОРФАН-РЯДОК (НЕ ховаємо розрив): факт команди понад Σ активних = гроші звільнених
    // (лишаються в команді, але не на колегах); план деактивованих, який НЕМАЄ куди розподілити
    // (0 активних у команді, core/plans.orphanPlanByTeam) — теж явно, managerId=0. Зазвичай порожньо.
    // Residual carryover команди (teamCo − Σ активних) теж падає сюди, щоб Σ мгр = команда.
    const orphanTids = new Set<number>([...teamFactMap.keys(), ...coByTeam.keys()]);
    for (const tid of orphanTids) {
      const tf = teamFactMap.get(tid);
      const residualPlan = planRes.orphanPlanByTeam.get(tid) ?? 0;
      const residualFact = (tf?.revenue ?? 0) - (activeFactByTeam.get(tid) ?? 0);
      const teamCo = coByTeam.get(tid) ?? { amount: 0, deals: 0 };
      const acc = activeCarryByTeam.get(tid) ?? { amount: 0, deals: 0 };
      const residualCarry = { amount: teamCo.amount - acc.amount, deals: teamCo.deals - acc.deals };
      if (residualPlan > 0 || residualFact > 0 || residualCarry.deals !== 0) {
        rows.push({
          managerId: 0, name: `⚠️ ${tf?.name ?? "команда"}: без активного менеджера (звільнені)`, teamId: tid,
          plan: residualPlan, fact: residualFact,
          pctPlan: residualPlan > 0 ? Math.round((residualFact / residualPlan) * 100) : null,
          remaining: Math.max(0, residualPlan - residualFact), expectedThisMonth: 0,
          carryover: residualCarry,
          flowCur: null, flowPrev: null,
        });
      }
    }
    managers = rows.sort((a, b) => (a.pctPlan ?? 999) - (b.pctPlan ?? 999)); // найгірші зверху (0% вгорі)
  }

  // Δ до compareWith — по ключових скалярах; для когортних — maturityMismatch.
  const delta = (cur: number | null, prev: number | null) => {
    if (cur == null || prev == null) return { current: cur, previous: prev, delta: null, deltaPct: null };
    const d = Math.round((cur - prev) * 10) / 10;
    return { current: cur, previous: prev, delta: d, deltaPct: prev !== 0 ? Math.round((d / Math.abs(prev)) * 1000) / 10 : null };
  };
  let compare: Record<string, unknown> | null = null;
  if (compareData) {
    const cf = (rows: metrics.FunnelHonestRow[]) => rows[0]?.pct?.paid ?? null;
    compare = {
      // 🔴 successFlow — ГОЛОВНА Δ hero (like-for-like по датованому потоку; received-Δ
      // лишається для довідки, але «свіжий снапшот vs дозрілий місяць» перекручує).
      successFlow: delta(current.revenue.successFlow, compareData.revenue.successFlow),
      revenueFact: delta(current.revenue.fact, compareData.revenue.fact),
      revenuePctComplete: delta(current.revenue.pctComplete, compareData.revenue.pctComplete),
      funnelPaidPct: { ...delta(cf(current.funnel), cf(compareData.funnel)), maturityMismatch: current.funnel[0]?.mature === false },
      adsCohort: { ...delta(current.conversions.ads.cohort, compareData.conversions.ads.cohort), maturityMismatch: current.conversions.ads.mature === false },
      prodzvinWon: { ...delta(current.conversions.prodzvin.won, compareData.conversions.prodzvin.won), maturityMismatch: current.conversions.prodzvin.mature === false },
      reactivationWon: { ...delta(current.conversions.reactivation.won, compareData.conversions.reactivation.won), maturityMismatch: current.conversions.reactivation.mature === false },
      expectedThisMonth: delta(current.expected.thisMonth.sum, compareData.expected.thisMonth.sum),
      expectedOverdue: delta(current.expected.overdue.sum, compareData.expected.overdue.sum),
    };
  }

  res.json({
    scope: { level, id: managerId ?? teamId ?? null, period: { from, to, granularity }, compareWith: compareFrom && compareTo ? { from: compareFrom, to: compareTo } : null },
    ...current,
    weekly, weekTarget: effWeekTarget, // ONE-NUMBER тижнева ціль (байт-в-байт зі Звітом/KVP)
    daily, expectedByDay, planPerDay,
    expectedByTeam, expectedByManager,
    ...(teams ? { teams } : {}),
    ...(managers ? { managers } : {}),
    compare,
  });
});
