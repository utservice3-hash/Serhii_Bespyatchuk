import { pool } from "../db/pool.js";
import { PRODZVIN_PIPELINES, PZ_TAKEN, PZ_OPR, REACTIVATION_PIPELINES, REACT_WARMING } from "./metrics.js";
import { LEADGEN_STAGE_IDS, QUALIFICATION_PIPELINES } from "./leadgenStages.js";
import { stageCountsQuery, bucketKeySql, handoffLinkQuery, firstStageEventQuery,
  type SqlQuery, type LeadgenBucketGrain } from "./leadgenSql.js";
import { FC_PIPELINES, handoffDealStates } from "./money.js";
import { stageName } from "./stageNames.js";
import {
  handoffView, trendWindow, mergeBucketRows, assembleTrend, LINK_BEFORE_SEC, LINK_AFTER_SEC,
  type HandoffEntry, type HandoffScope, type LeadgenDealClass, type LeadgenHandoffMoney,
  type LeadgenPersonBucketRow, type StageBucketRow, type CallBucketRow, type TrendMoneyBucket,
} from "./leadgenHandoffRules.js";
import { kommoLeadUrl } from "./kommoLinks.js";
import { LEADGEN_CALL_MIN_SEC } from "./leadgenRules.js";
// 📐 Правила лідогену живуть у ЧИСТОМУ `leadgenRules.ts` (нуль імпортів) — звідси
// лише реекспорт, щоб зовнішній читач не помітив різниці, а гейти могли дістати
// їх без `config`. Див. доккоментар того файла: там записано, ЧОМУ так.
export { LEADGEN_CALL_MIN_SEC, LEADGEN_CONVERSION_TARGETS, pct, leadGeneratorFillNote } from "./leadgenRules.js";
// Збірка розбивки й тренду — у чистому `leadgenHandoffRules.ts` (`#682`); тут лише реекспорт для роутів.
export { sumBuckets, personBucketWire } from "./leadgenHandoffRules.js";
export type { LeadgenPersonBucketRow } from "./leadgenHandoffRules.js";

/**
 * 📞 ЛІДОГЕНЕРАЦІЯ — сім показників таблиці лідгенів із подій CRM.
 *
 * 🔴 ЧОМУ ПО СИРОМУ `status_id`, А НЕ ПО `funnel_stage`. Мапа `pipeline_stage_map`
 * (`seedKommoMapping.sql:48-53`) веде І «Отримано контакти ОПР» (69716492), І
 * «Кваліфіковано» (142) в ОДИН `funnel_stage = quote_requested`, а воронки Реактивації
 * (8921948) у мапі немає взагалі. Отже через `funnel_stage` два різні показники таблиці
 * не розрізнити В ПРИНЦИПІ. Мапу чіпати не можна — на ній стоять конверсії й воронка.
 *
 * 📐 ЗАМІР ЕТАПУ 0 (08.09.2026, `docs/LEADGEN_ETAP0.md`), серпень 2026, відділ:
 * ліди 2 250 · ОПР 578 · прорахунки 662 · підігрів 814. Таблиця лідгенів каже
 * 1 597 / 685 / 288 — розбіжності названі там поіменно, з причинами.
 *
 * ⚠️ ЧОГО ТУТ НЕМАЄ І ЧОМУ. Машини й гроші рахує ЯДРО (`metrics.dispatchedByLoadBucket`
 * з каналом і `money.receivedByChannel`), а не цей модуль: свій SQL по виручці розійшовся
 * б із дашбордом через місяці (DoD п.1). І вони можливі лише на рівні ВІДДІЛУ — звʼязок
 * «машина → конкретний лідген» у CRM не заповнюють: поле «Лидогенератор» стоїть у 11 зі
 * 103 машин серпня (замір етапу 0).
 */

/**
 * 🔴 «УСПІШНИЙ ДЗВІНОК» — ВИХІДНИЙ ВІД 20 СЕКУНД. Число не вигадане й не взяте зі стелі:
 * таблиця лідгенів за серпень каже 3 627. Замір усіх порогів по живих даних дав рівно
 * один влучний — вихідні `billsec >= 20` → **3 604** (0.6 %). Сусідні промахуються в рази:
 * ≥15 с → 4 828, ≥25 с → 2 574. Поки власник не назвав інше означення, тримаємо це,
 * і саме тут — щоб не розповзлось копіями.
 */

export interface LeadgenPersonRow {
  managerId: number;
  name: string;
  teamId: number | null;
  teamName: string | null;
  isActive: boolean;
  leads: number;      // входи в «Взято в роботу» (Продзвін)
  opr: number;        // входи в «Отримано контакти ОПР»
  quotes: number;     // входи в «Кваліфіковано» = передано на прорахунок
  warming: number;    // входи в «Клієнт підігрівається» (Реактивація)
  calls: number;      // вихідні дзвінки >= LEADGEN_CALL_MIN_SEC
}

export interface LeadgenSourceRow { source: string; leads: number }

export interface LeadgenStats {
  rows: LeadgenPersonRow[];
  bySource: LeadgenSourceRow[];
  totals: Pick<LeadgenPersonRow, "leads" | "opr" | "quotes" | "warming" | "calls">;
}

const K = "AT TIME ZONE 'Europe/Kyiv'";

/**
 * 📞 ЗАПИТ ДЗВІНКІВ — ОДИН НА РЯДКИ ЛЮДЕЙ І НА РОЗБИВКУ. Правило «успішного дзвінка»
 * (вихідний, `billsec >= LEADGEN_CALL_MIN_SEC`) і ростер (лише люди, передані в `ids`)
 * живуть в одному тексті: друга копія для розбивки розійшлась би з рядком мовчки.
 * `bucket` — одиниця розбивки (ключ `bucketKeySql`), `null` — підсумок за період.
 */
function callsQuery(ids: number[], from: string, to: string, bucket: LeadgenBucketGrain | null = null): SqlQuery {
  const key = bucket ? `${bucketKeySql(bucket, "c.calldate")} AS bucket, ` : "";
  return {
    text: `SELECT ${key}c.manager_id, COUNT(*) AS n
         FROM ringostat_calls c
        WHERE c.manager_id = ANY($1)
          AND (c.calldate ${K})::date BETWEEN $2 AND $3
          AND c.call_type = 'out' AND c.billsec >= $4
        GROUP BY ${bucket ? "1, 2" : "1"}`,
    values: [ids, from, to, LEADGEN_CALL_MIN_SEC],
  };
}

/**
 * Ростер визначається ПОДІЯМИ, а не списком команди. Причина заміряна: у серпні
 * лідгенівські дії робила ще й Ковтонюк Тетяна, яка числиться в команді РНК, а
 * Єресько зі списку ТЗ деактивований. Список protікає, події — ні.
 */
export async function leadgenStats(from: string, to: string): Promise<LeadgenStats> {
  // 🧾 Текст запиту — у чистому `leadgenSql.ts`: той самий рядок женуть і пул тут, і гейт
  // на тимчасовій базі. Id стадій — ОДНИМ обʼєктом (`LEADGEN_STAGE_IDS`), не поштучно.
  const sq = stageCountsQuery(from, to, LEADGEN_STAGE_IDS);
  const stages = await pool.query<{
    manager_id: number; name: string; team_id: number | null; team_name: string | null;
    is_active: boolean; leads: string; opr: string; quotes: string; warming: string;
  }>(sq.text, sq.values);

  const ids = stages.rows.map((r) => r.manager_id);
  const callsByMgr = new Map<number, number>();
  if (ids.length) {
    const cq = callsQuery(ids, from, to);
    const calls = await pool.query<{ manager_id: number; n: string }>(cq.text, cq.values);
    for (const c of calls.rows) callsByMgr.set(c.manager_id, Number(c.n));
  }

  /**
   * Розріз за джерелом клієнта — Холодна база проти Реактивації, як просить ТЗ.
   * ⚠️ Порожнє джерело НЕ ховаємо: у серпні таких 17. Невідоме має читатись як невідоме.
   */
  const src = await pool.query<{ source: string; leads: string }>(
    `SELECT COALESCE(NULLIF(d.client_source, ''), 'Джерело не проставлене') AS source,
            COUNT(DISTINCT e.kommo_id) AS leads
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
      WHERE e.pipeline_id = ANY($3) AND e.status_id = $4
        AND (e.changed_at ${K})::date BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY leads DESC`,
    [from, to, PRODZVIN_PIPELINES, PZ_TAKEN]
  );

  const rows: LeadgenPersonRow[] = stages.rows.map((r) => ({
    managerId: r.manager_id,
    name: r.name,
    teamId: r.team_id,
    teamName: r.team_name,
    isActive: r.is_active,
    leads: Number(r.leads),
    opr: Number(r.opr),
    quotes: Number(r.quotes),
    warming: Number(r.warming),
    calls: callsByMgr.get(r.manager_id) ?? 0,
  }));

  const totals = rows.reduce(
    (a, r) => ({
      leads: a.leads + r.leads, opr: a.opr + r.opr, quotes: a.quotes + r.quotes,
      warming: a.warming + r.warming, calls: a.calls + r.calls,
    }),
    { leads: 0, opr: 0, quotes: 0, warming: 0, calls: 0 }
  );

  return { rows, bySource: src.rows.map((s) => ({ source: s.source, leads: Number(s.leads) })), totals };
}

/**
 * Цільові конверсії з таблиці лідгенів (ліди → ОПР 40 % → прорахунок 50 % → машини 10 %).
 * Тримаємо тут, бо це бізнес-правило власника, а не число на екрані.
 */


/**
 * 🔒 ПРИЧИНИ ЗАКРИТТЯ — з поля `reject_reason`, яке лідген проставляє руками.
 *
 * 📐 Заміряно за серпень 2026 (Продзвін, вхід у 143): 4 889 закриттів — БІЛЬШЕ, ніж лідів
 * (2 250). Розклад: «Немає звʼязку» 2 025 (41 %) · «Нецільове звернення» 1 457 (30 %) ·
 * «Дубль» 480 · «Відмова секретаря» 342 · «Відмова ОПР: не актуально» 334 · «Перевізник» 120 ·
 * «Разова поїздка» 115. Причину не проставили в 5 угодах — і ми це показуємо рядком,
 * а не ховаємо: невидима прогалина читається як «таких немає».
 */
export interface LeadgenReasonRow { reason: string; deals: number }

export async function leadgenClosures(from: string, to: string): Promise<LeadgenReasonRow[]> {
  const r = await pool.query<{ reason: string; n: string }>(
    `SELECT COALESCE(NULLIF(d.reject_reason, ''), 'Причину не проставили') AS reason,
            COUNT(DISTINCT e.kommo_id) AS n
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
      WHERE e.pipeline_id = ANY($3) AND e.status_id = 143
        AND (e.changed_at ${K})::date BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY n DESC`,
    [from, to, PRODZVIN_PIPELINES]
  );
  return r.rows.map((x) => ({ reason: x.reason, deals: Number(x.n) }));
}

/**
 * 📋 СПИСОК ПЕРЕДАНИХ ПРОРАХУНКІВ — те, що тімліди сьогодні вклеюють у журнал руками.
 * Момент передачі = вхід у «Кваліфіковано»: саме тоді CRM створює угоду менеджеру.
 * Посилання будує `kommoLeadUrl`, а не власний рядок — інакше зміна піддомену CRM
 * розсипала б лінки в одному місці й лишила робочими в іншому.
 */
export interface LeadgenHandoffRow {
  kommoId: number; day: string; name: string | null; manager: string | null; url: string;
}

export async function leadgenHandoffs(from: string, to: string, limit = 500): Promise<LeadgenHandoffRow[]> {
  const r = await pool.query<{ kommo_id: string; day: string; name: string | null; manager: string | null }>(
    `SELECT e.kommo_id,
            to_char(MIN(e.changed_at) ${K}, 'YYYY-MM-DD') AS day,
            MIN(d.name) AS name, MIN(m.name) AS manager
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
       LEFT JOIN managers m ON m.id = d.manager_id
      WHERE e.pipeline_id = ANY($3) AND e.status_id = 142
        AND (e.changed_at ${K})::date BETWEEN $1 AND $2
      GROUP BY e.kommo_id
      ORDER BY day DESC, e.kommo_id DESC
      LIMIT $4`,
    [from, to, PRODZVIN_PIPELINES, limit]
  );
  return r.rows.map((x) => ({
    kommoId: Number(x.kommo_id), day: x.day, name: x.name, manager: x.manager,
    url: kommoLeadUrl(Number(x.kommo_id)),
  }));
}

/**
 * 🌡 СКІЛЬКИ ВИСИТЬ У «ПІДІГРІВАЄТЬСЯ» ЗАРАЗ — знімок, а не період.
 * 📐 Заміряно 08.09.2026: 1 682 угоди. Це не показник роботи за місяць, а борг,
 * що накопичується, — тому й рахується станом на зараз, окремо від решти.
 */
export async function leadgenWarmingBacklog(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM deals WHERE pipeline_id = ANY($1) AND status_id = $2`,
    [REACTIVATION_PIPELINES, REACT_WARMING]
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * 📅 ТИЖНІ — та сама пʼятірка показників по тижнях, як розклад у таблиці лідгенів.
 * Тиждень київський (`date_trunc('week')` = понеділок), бо і зміни в CRM, і звітність
 * лідгенів ідуть по київському часу.
 */
export interface LeadgenWeekRow { week: string; leads: number; opr: number; quotes: number }

export async function leadgenWeekly(from: string, to: string): Promise<LeadgenWeekRow[]> {
  const r = await pool.query<{ week: string; leads: string; opr: string; quotes: string }>(
    `SELECT to_char(date_trunc('week', (e.changed_at ${K})), 'YYYY-MM-DD') AS week,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.status_id = $4) AS leads,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.status_id = $5) AS opr,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.status_id = 142) AS quotes
       FROM deal_stage_events e
      WHERE e.pipeline_id = ANY($3) AND e.status_id IN ($4, $5, 142)
        AND (e.changed_at ${K})::date BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY 1`,
    [from, to, PRODZVIN_PIPELINES, PZ_TAKEN, PZ_OPR]
  );
  return r.rows.map((x) => ({ week: x.week, leads: Number(x.leads), opr: Number(x.opr), quotes: Number(x.quotes) }));
}

/**
 * Скільки лідоген-угод періоду (за датою створення, Київ) мають особу в полі
 * «Лидогенератор». Лічильник для `leadGeneratorFillNote` — див. там, навіщо.
 */
export async function leadGeneratorFill(from: string, to: string): Promise<{ withPerson: number; total: number }> {
  const r = await pool.query<{ total: string; with_person: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE NULLIF(btrim(lead_generator), '') IS NOT NULL) AS with_person
       FROM deals d
      WHERE d.lead_channel = 'leadgen'
        AND (d.created_at_kommo ${K})::date BETWEEN $1 AND $2`,
    [from, to]
  );
  return { total: Number(r.rows[0]?.total ?? 0), withPerson: Number(r.rows[0]?.with_person ?? 0) };
}

// ═══════════════════════ РОЗБИВКА, ТРЕНД І ГРОШІ З ПЕРЕДАЧ (22.09.2026) ═══════════════════════

/**
 * 📅 РЯДКИ ЗАПИТІВ ДЛЯ РОЗБИВКИ — ТИМИ САМИМИ запитами, що рядки людей.
 *
 * Стадії — `stageCountsQuery` у формі з одиницею (предикат і `JOIN managers` ті самі), дзвінки
 * — `callsQuery` з тим самим правилом і ростером (люди з подіями стадій за ВЕСЬ `from…to`).
 * Злиття й ростер одиниці — чиста `mergeBucketRows`; тут лише запити.
 */
async function bucketQueryRows(from: string, to: string, grain: LeadgenBucketGrain):
  Promise<{ stages: StageBucketRow[]; calls: CallBucketRow[] }> {
  const sq = stageCountsQuery(from, to, LEADGEN_STAGE_IDS, grain);
  const st = await pool.query<{ bucket: string; manager_id: number; team_id: number | null;
    leads: string; opr: string; quotes: string; warming: string }>(sq.text, sq.values);
  const stages = st.rows.map((r): StageBucketRow => ({
    bucket: r.bucket, managerId: r.manager_id, teamId: r.team_id,
    leads: Number(r.leads), opr: Number(r.opr), quotes: Number(r.quotes), warming: Number(r.warming),
  }));
  const ids = [...new Set(stages.map((r) => r.managerId))];
  if (!ids.length) return { stages, calls: [] };
  const cq = callsQuery(ids, from, to, grain);
  const c = await pool.query<{ bucket: string; manager_id: number; n: string }>(cq.text, cq.values);
  return { stages, calls: c.rows.map((x) => ({ bucket: x.bucket, managerId: x.manager_id, calls: Number(x.n) })) };
}

/**
 * 📅 РОЗБИВКА ПОКАЗНИКІВ ПО ОДИНИЦЯХ — для кожної людини. Відділ НЕ рахується окремим запитом:
 * він — сума людей (`sumBuckets`), тож «Σ людей == відділ» тримається побудовою, а не надією.
 * `rosterPerBucket` — див. `mergeBucketRows`.
 */
export async function leadgenBuckets(
  from: string, to: string, grain: LeadgenBucketGrain, rosterPerBucket: boolean,
): Promise<LeadgenPersonBucketRow[]> {
  const q = await bucketQueryRows(from, to, grain);
  return mergeBucketRows(q.stages, q.calls, rosterPerBucket);
}

/** Вхід у 142 з угодою менеджера й описом обох угод — усе, крім грошей (їх дає `money.ts`). */
interface HandoffLinkRow extends HandoffEntry {
  pzName: string | null; pzClient: string | null;
  dealName: string | null; dealClient: string | null; salesManager: string | null;
  dealReason: string | null; closedDay: string | null; planPayDay: string | null;
}

async function handoffLinks(from: string, to: string): Promise<HandoffLinkRow[]> {
  const q = handoffLinkQuery(from, to,
    { pz: LEADGEN_STAGE_IDS.pz, qualified: LEADGEN_STAGE_IDS.qualified,
      managerPipelines: [...QUALIFICATION_PIPELINES, ...FC_PIPELINES] },
    { beforeSec: LINK_BEFORE_SEC, afterSec: LINK_AFTER_SEC });
  const r = await pool.query<{ pz_id: string; lg_id: number; lg_team_id: number | null; at: Date; day: string;
    pz_name: string | null; pz_client: string | null; deal_id: string | null; deal_name: string | null;
    deal_client: string | null; sales_manager: string | null; deal_reason: string | null;
    closed_day: string | null; plan_pay_day: string | null }>(q.text, q.values);
  return r.rows.map((x) => ({
    pzId: Number(x.pz_id), lgId: x.lg_id, lgTeamId: x.lg_team_id, at: new Date(x.at).getTime(), day: x.day,
    dealId: x.deal_id == null ? null : Number(x.deal_id),
    pzName: x.pz_name, pzClient: x.pz_client, dealName: x.deal_name, dealClient: x.deal_client,
    salesManager: x.sales_manager, dealReason: x.deal_reason, closedDay: x.closed_day, planPayDay: x.plan_pay_day,
  }));
}

/** Одна передача в списку «Гроші з передач» — форма, яку читає екран. */
export interface LeadgenHandoffDeal {
  day: string; lgId: number; pzId: number; dealId: number | null;
  route: string | null; client: string | null; salesManager: string | null; stage: string | null;
  cls: LeadgenDealClass; price: number; closedDay: string | null; planPayDay: string | null;
  reason: string | null; url: string | null;
}

const blankToNull = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/** Підпис стадії: Кваліфікацію видно одразу, бо це ще НЕ повний цикл. */
function handoffStage(pipelineId: number, statusId: number): string {
  const name = stageName(pipelineId, statusId);
  return QUALIFICATION_PIPELINES.includes(pipelineId) ? `Кваліфікація · ${name}` : name;
}

export interface LeadgenHandoffMoneyResult {
  totals: LeadgenHandoffMoney;
  byPerson: { managerId: number; money: LeadgenHandoffMoney }[];
  deals: LeadgenHandoffDeal[];
}

/**
 * 💰 ГРОШІ З ПЕРЕДАЧ ЗА ПЕРІОД — ЄДИНА ФУНКЦІЯ для числа в рядку лідгена (`/leadgen-stats`
 * → `handoffMoney`) і для розкривного списку (`/leadgen-handoff-deals`). Список і підсумок
 * беруться з ОДНОГО виклику, тож `totals` списку дорівнюють числу рядка за побудовою (`#677`).
 *
 * Порядок — рішення (правило 3): домен = УСІ передачі періоду; вибір передачі й «та сама
 * угода» — над усім доменом; скоуп (`teamId`/`managerId`) лише звужує ВІДПОВІДЬ.
 */
export async function leadgenHandoffMoney(from: string, to: string, scope: HandoffScope): Promise<LeadgenHandoffMoneyResult> {
  const links = await handoffLinks(from, to);
  const states = await handoffDealStates(links.flatMap((l) => (l.dealId == null ? [] : [l.dealId])));
  const view = handoffView(links, states, scope);
  const deals = view.rows.map((h): LeadgenHandoffDeal => {
    const st = h.dealId == null ? undefined : states.get(h.dealId);
    const linked = h.dealId != null;
    return {
      day: h.day, lgId: h.lgId, pzId: h.pzId, dealId: h.dealId,
      route: blankToNull(linked ? h.dealName : null) ?? blankToNull(h.pzName),
      client: blankToNull(linked ? h.dealClient : null) ?? blankToNull(h.pzClient),
      salesManager: linked ? h.salesManager : null,
      stage: st ? handoffStage(st.pipelineId, st.statusId) : null,
      cls: h.cls, price: h.price,
      closedDay: linked ? h.closedDay : null,
      planPayDay: linked ? h.planPayDay : null,
      reason: h.cls === "lost" ? blankToNull(h.dealReason) : null,
      url: kommoLeadUrl(h.dealId ?? h.pzId),
    };
  });
  return { totals: view.totals, byPerson: view.byPerson, deals };
}

/** Найраніша київська дата подій чотирьох стадій — глибина памʼяті журналу (`null` — подій немає). */
async function firstStageEventDay(): Promise<string | null> {
  const q = firstStageEventQuery(LEADGEN_STAGE_IDS);
  const r = await pool.query<{ day: string | null }>(q.text, q.values);
  return r.rows[0]?.day ?? null;
}

export interface LeadgenTrendResult {
  months: number; to: string;
  /** Місяці, які журнал подій ПАМʼЯТАЄ (кінець місяця не раніше за першу подію). */
  monthStarts: string[];
  byPerson: LeadgenPersonBucketRow[];
  money: TrendMoneyBucket[];
}

/**
 * 📈 ТРЕНД ПО МІСЯЦЯХ: `months` календарних місяців, що закінчуються місяцем `to`.
 *
 * Кожен місяць — ОКРЕМИЙ період `/leadgen-stats`. Запитів — по одному на родину (стадії, дзвінки,
 * передачі, стан угод, глибина журналу) за все вікно; розклад по місяцях, ростер дзвінків на
 * місяць і гроші з передач лише цього місяця — чиста `assembleTrend` (`#682`). Що місяць тренду
 * дорівнює `/leadgen-stats` + грошам того місяця на ЖИВОМУ SQL — тримає `#682b`.
 */
export async function leadgenTrend(to: string, months: number, scope: HandoffScope): Promise<LeadgenTrendResult> {
  const w = trendWindow(to, months);
  const [q, links, firstDay] = await Promise.all([
    bucketQueryRows(w.from, to, "month"),
    handoffLinks(w.from, to),
    firstStageEventDay(),
  ]);
  const states = await handoffDealStates(links.flatMap((l) => (l.dealId == null ? [] : [l.dealId])));
  const t = assembleTrend({ monthStarts: w.monthStarts, stages: q.stages, calls: q.calls, links, states, firstDay, scope });
  return { months: w.months, to, monthStarts: t.monthStarts, byPerson: t.byPerson, money: t.money };
}

/** Команда людини для межі тімліда: `undefined` — такої людини немає. */
export async function leadgenManagerTeam(managerId: number): Promise<number | null | undefined> {
  const r = await pool.query<{ team_id: number | null }>(`SELECT team_id FROM managers WHERE id = $1`, [managerId]);
  return r.rows.length ? r.rows[0].team_id : undefined;
}

