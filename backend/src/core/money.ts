import { pool } from "../db/pool.js";
// 🔴 Канонічний рекламний предикат — ЄДИНЕ джерело (metrics.adDealSql). Імпорт створює
// циклічну залежність money↔metrics, але вона РАНТАЙМ-безпечна: обидва модулі викликають
// одне одного лише всередині функцій (не на рівні модуля), тож ESM-live-binding резолвиться
// до першого виклику (request-time), коли обидва модулі вже ініціалізовані.
import { adDealSql } from "./metrics.js";

/**
 * ЄДИНЕ джерело грошових метрик (MASTER_PLAN КРОК 2, виправлено КРОКОМ 4 — опція Б).
 *
 * Грошові етапи повного циклу (обидва пайплайни):
 *   етап 8  «Очікуємо оплату від замовника (перевізник оплачений)» → STAGE_EXPECTED
 *   етап 9  «Оплата отримана»                                      → STAGE_PAID
 *   етап 10 «Успішна угода» (142)                                  → SUCCESS
 * ⚠️ Етап 4 «Виставлення рахунку» (100274340) у грошові метрики НЕ входить.
 *
 * 🔴 РЕОУПЕНИ ТРАПЛЯЮТЬСЯ РЕГУЛЯРНО (не «1-2 виключення»). Угода може входити в 142
 * кілька разів (виграли → повернули → знову виграли). Рахуємо РАЗ, за ФІНАЛЬНИМ
 * станом (опція Б власника, 14.07.2026):
 *   • success  = угода ЗАРАЗ у статусі 142; анкер = `closed_at` (= фінальний виграш).
 *   • paidOnly = угода ЗАРАЗ у етапі 9 (гроші прийшли, ще не закрито); анкер = ОСТАННІЙ
 *                вхід у етап 9. received = success ⊎ paidOnly (диз'юнктні за поточним
 *                статусом → без подвійного рахунку НІ всередині, НІ між місяцями).
 *   • expected = угода ЗАРАЗ у етапі 8; анкер = останній вхід у етап 8.
 * У кожної угоди — ОДИН анкер (один closed_at / один поточний етап) → вона потрапляє
 * рівно в ОДИН місяць. Це матчить `deals`(status,closed_at) і Kommo напряму (звірка).
 */
export const FC_PIPELINES = [8921932, 155304];
export const STAGE_EXPECTED = [69716312, 25044997];
export const STAGE_PAID = [69716460, 60412544];
export const STAGE_SUCCESS = [142];
export const STAGE_RECEIVED = [...STAGE_PAID, ...STAGE_SUCCESS];

export interface MoneyScope {
  from?: string | null;
  to?: string | null;
  managerId?: number | null;
  teamId?: number | null;
  activeOnly?: boolean;
}
export interface MoneyAgg { revenue: number; deals: number }
export interface TeamRow { teamId: number; teamName: string; revenue: number; deals: number }
export interface MgrRow { managerId: number; name: string; teamId: number | null; revenue: number; deals: number }
export interface BucketRow { bucket: string; revenue: number; deals: number }
export interface MgrWeekRow { managerId: number; weekStart: string; revenue: number; deals: number }

type Kind = "received" | "success" | "paidOnly" | "expected";

/**
 * Джерело угод для метрики — по одному рядку на угоду з ЄДИНИМ анкером:
 *   success  — ЗАРАЗ 142, anchor = closed_at.
 *   paidOnly — ЗАРАЗ у етапі 9, anchor = MAX(вхід у етап 9).
 *   expected — ЗАРАЗ у етапі 8, anchor = MAX(вхід у етап 8).
 *   received — success ⊎ paidOnly.
 * price береться з `deals` (уже збережено МІНУСОМ для мінус-угод → SUM уже нетто).
 */
function sourceSql(kind: Kind, p: unknown[]): string {
  p.push(FC_PIPELINES);
  const fc = `$${p.length}`;
  const successSrc =
    `SELECT d.kommo_id, d.closed_at_kommo AS anchor_at, d.manager_id, d.price
       FROM deals d
      WHERE d.status_id = 142 AND d.pipeline_id = ANY(${fc}) AND d.closed_at_kommo IS NOT NULL`;
  const currentStageSrc = (stages: number[]): string => {
    p.push(stages);
    const st = `$${p.length}`;
    return `SELECT d.kommo_id, a.anchor_at, d.manager_id, d.price
              FROM deals d
              JOIN (SELECT kommo_id, MAX(changed_at) AS anchor_at
                      FROM deal_stage_events
                     WHERE pipeline_id = ANY(${fc}) AND status_id = ANY(${st})
                     GROUP BY kommo_id) a ON a.kommo_id = d.kommo_id
             WHERE d.status_id = ANY(${st}) AND d.pipeline_id = ANY(${fc})`;
  };
  if (kind === "success") return successSrc;
  if (kind === "paidOnly") return currentStageSrc(STAGE_PAID);
  if (kind === "expected") return currentStageSrc(STAGE_EXPECTED);
  return `${successSrc} UNION ALL ${currentStageSrc(STAGE_PAID)}`; // received
}

async function query<T>(kind: Kind, s: MoneyScope, extraSelect: string, groupBy: string): Promise<T[]> {
  const p: unknown[] = [];
  const src = sourceSql(kind, p);
  const conds: string[] = [];
  if (s.from) { p.push(s.from); conds.push(`(src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date >= $${p.length}`); }
  if (s.to) { p.push(s.to); conds.push(`(src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date <= $${p.length}`); }
  if (s.managerId) { p.push(s.managerId); conds.push(`src.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const activeJoin = s.activeOnly ? "AND m.is_active" : "";
  const teamsJoin = /\bt\./.test(extraSelect + groupBy) ? "LEFT JOIN teams t ON t.id = m.team_id" : "";
  const sql = `
    SELECT ${extraSelect}
    FROM (${src}) src
    JOIN managers m ON m.id = src.manager_id ${activeJoin}
    ${teamsJoin}
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ${groupBy}`;
  const r = await pool.query(sql, p);
  return r.rows as T[];
}

async function agg(kind: Kind, s: MoneyScope): Promise<MoneyAgg> {
  const rows = await query<{ revenue: string; deals: string }>(kind, s, "COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals", "");
  return { revenue: Number(rows[0]?.revenue ?? 0), deals: Number(rows[0]?.deals ?? 0) };
}
async function aggByTeam(kind: Kind, s: MoneyScope): Promise<TeamRow[]> {
  const rows = await query<{ team_id: number; team_name: string; revenue: string; deals: string }>(
    kind, s, "t.id AS team_id, t.name AS team_name, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals", "GROUP BY t.id, t.name"
  );
  return rows.map((x) => ({ teamId: x.team_id, teamName: x.team_name, revenue: Number(x.revenue), deals: Number(x.deals) }));
}
async function aggByMgr(kind: Kind, s: MoneyScope): Promise<MgrRow[]> {
  const rows = await query<{ manager_id: number; name: string; team_id: number | null; revenue: string; deals: string }>(
    kind, { ...s, activeOnly: true },
    "m.id AS manager_id, m.name, m.team_id, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals",
    "GROUP BY m.id, m.name, m.team_id"
  );
  return rows.map((x) => ({ managerId: x.manager_id, name: x.name, teamId: x.team_id, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

// «Отримані кошти» = success ⊎ paidOnly.
export const receivedMoney = (s: MoneyScope) => agg("received", s);
export const receivedByTeam = (s: MoneyScope) => aggByTeam("received", s);
export const receivedByMgr = (s: MoneyScope) => aggByMgr("received", s);
// «Успішно реалізовано» (ЗАРАЗ 142, за closed_at) — знаменник avg_check_success_only.
export const successMoney = (s: MoneyScope) => agg("success", s);
export const successByTeam = (s: MoneyScope) => aggByTeam("success", s);
export const successByMgr = (s: MoneyScope) => aggByMgr("success", s);
// «Досі в оплаті» (ЗАРАЗ етап 9).
export const paidOnlyMoney = (s: MoneyScope) => agg("paidOnly", s);
export const paidOnlyByTeam = (s: MoneyScope) => aggByTeam("paidOnly", s);
export const paidOnlyByMgr = (s: MoneyScope) => aggByMgr("paidOnly", s);
// «Очікування оплат» (ЗАРАЗ етап 8).
export const expectedMoney = (s: MoneyScope) => agg("expected", s);
export const expectedByTeam = (s: MoneyScope) => aggByTeam("expected", s);
export const expectedByMgr = (s: MoneyScope) => aggByMgr("expected", s);

// Спільне ядро бакетування (день/тиждень/місяць) за анкером метрики. Дзеркало для
// received/success — той самий scope-aware SQL, лише kind міняється.
async function bucketAgg(kind: Kind, s: MoneyScope, granularity: "day" | "week" | "month"): Promise<BucketRow[]> {
  const gran = granularity === "day" || granularity === "month" ? granularity : "week";
  const rows = await query<{ bucket: string; revenue: string; deals: string }>(
    kind, s,
    `to_char(date_trunc('${gran}', (src.anchor_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals`,
    "GROUP BY 1 ORDER BY 1"
  );
  return rows.map((x) => ({ bucket: x.bucket, revenue: Number(x.revenue), deals: Number(x.deals) }));
}
// «Отримані кошти» по бакету (received = success ⊎ paidOnly; анкер stage-entry / closed_at).
export const receivedByBucket = (s: MoneyScope, granularity: "day" | "week" | "month") => bucketAgg("received", s, granularity);
// BE-2 «Авто відправлено» по бакету — success (ЗАРАЗ 142), анкер `closed_at_kommo`. Дзеркало
// receivedByBucket з kind='success'. Σ бакетів = successMoney(той самий scope/період).
export const successByBucket = (s: MoneyScope, granularity: "day" | "week" | "month") => bucketAgg("success", s, granularity);

/** received по (менеджер × тиждень) за місяць — для тижневої сітки план/факт. */
export async function receivedByManagerWeek(managerIds: number[], monthStart: string): Promise<MgrWeekRow[]> {
  const p: unknown[] = [];
  const src = sourceSql("received", p);
  p.push(monthStart); const ms = `$${p.length}`;
  p.push(managerIds); const ids = `$${p.length}`;
  const r = await pool.query<{ manager_id: number; week_start: string; revenue: string; deals: string }>(
    `SELECT src.manager_id,
            to_char(date_trunc('week', (src.anchor_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS week_start,
            COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals
       FROM (${src}) src
      WHERE src.manager_id = ANY(${ids})
        AND (src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date >= ${ms}::date
        AND (src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date < (${ms}::date + interval '1 month')
      GROUP BY src.manager_id, week_start`,
    p
  );
  return r.rows.map((x) => ({ managerId: x.manager_id, weekStart: x.week_start, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

/**
 * «Отримані кошти» РОЗРІЗ ПО КАНАЛУ (реклама / лідоген) — те саме ядро `received`
 * (датований анкер: 142 по closed_at ⊎ etap9 по останньому входу; дедуп; signed price),
 * лише з каналовим фільтром. Прибирає недатований paidOnly-знімок, що жив у /kvp-extra.
 * `ad` = канонічний `adDealSql` (client_source ∈ adSources АБО lead_channel='ad', без
 * реактивації); `leadgen` = `lead_channel='leadgen'`. Множини можуть перетинатись (як і
 * раніше в роуті) — це ДВІ незалежні агрегації, не розбиття.
 */
export async function receivedByChannel(s: MoneyScope, adSources: string[]): Promise<{ ad: MoneyAgg; leadgen: MoneyAgg }> {
  const p: unknown[] = [];
  const src = sourceSql("received", p);
  const conds: string[] = [];
  if (s.from) { p.push(s.from); conds.push(`(src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date >= $${p.length}`); }
  if (s.to) { p.push(s.to); conds.push(`(src.anchor_at AT TIME ZONE 'Europe/Kyiv')::date <= $${p.length}`); }
  if (s.managerId) { p.push(s.managerId); conds.push(`src.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  p.push(adSources); const adRef = `$${p.length}`;
  const ad = adDealSql(adRef);
  const r = await pool.query<{ ad_rev: string; ad_deals: string; lg_rev: string; lg_deals: string }>(
    `SELECT COALESCE(SUM(src.price) FILTER (WHERE ${ad}),0) AS ad_rev,
            COUNT(*) FILTER (WHERE ${ad}) AS ad_deals,
            COALESCE(SUM(src.price) FILTER (WHERE d.lead_channel = 'leadgen'),0) AS lg_rev,
            COUNT(*) FILTER (WHERE d.lead_channel = 'leadgen') AS lg_deals
       FROM (${src}) src
       JOIN deals d ON d.kommo_id = src.kommo_id
       JOIN managers m ON m.id = src.manager_id
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}`,
    p
  );
  const x = r.rows[0];
  return {
    ad: { revenue: Number(x?.ad_rev ?? 0), deals: Number(x?.ad_deals ?? 0) },
    leadgen: { revenue: Number(x?.lg_rev ?? 0), deals: Number(x?.lg_deals ?? 0) },
  };
}

/**
 * ЗНІМОК «станом на зараз» — угоди, що ПРЯМО ЗАРАЗ стоять на етапі 8 чи 9. Прогноз-
 * картка, НІКОЛИ не сумується у виручку періоду (підпис «станом на зараз»).
 */
export async function awaitingNowSnapshot(s: MoneyScope): Promise<{ deals: number; revenue: number; byTeam: TeamRow[] }> {
  const p: unknown[] = [FC_PIPELINES, [...STAGE_EXPECTED, ...STAGE_PAID]];
  const scope: string[] = [];
  if (s.managerId) { p.push(s.managerId); scope.push(`d.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); scope.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ team_id: number; team_name: string; revenue: string; deals: string }>(
    `SELECT t.id AS team_id, t.name AS team_name, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals
       FROM deals d JOIN managers m ON m.id = d.manager_id JOIN teams t ON t.id = m.team_id
      WHERE d.pipeline_id = ANY($1) AND d.status_id = ANY($2) ${scope.length ? "AND " + scope.join(" AND ") : ""}
      GROUP BY t.id, t.name ORDER BY revenue DESC`,
    p
  );
  const byTeam = r.rows.map((x) => ({ teamId: x.team_id, teamName: x.team_name, revenue: Number(x.revenue), deals: Number(x.deals) }));
  return { deals: byTeam.reduce((a, b) => a + b.deals, 0), revenue: byTeam.reduce((a, b) => a + b.revenue, 0), byTeam };
}

// ───────────────────────── ПРОГНОЗ ВИРУЧКИ (Р4a) ─────────────────────────

function countWorkingDays(start: Date, end: Date): number {
  let n = 0;
  const d = new Date(start);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

export interface RevenueProjection {
  fact: number;             // = receivedMoney (ТА САМА база, що «факт» у план/факті)
  byPace: number;           // «по темпу дня» = факт ÷ минулі роб. дні × усі роб. дні (ЛИШЕ показ)
  floor: number;            // «підлога» = success×(total/elapsed)+paidOnly (стара модель D; ЛИШЕ показ, як низ)
  elapsedWorkingDays: number;
  totalWorkingDays: number;
}

/**
 * Р4a — база прогнозу. `fact` = `receivedMoney` (та сама, що план/факт; endpoint
 * бере `projection.fact` як ЄДИНЕ джерело «факту»). `byPace` (наївний run-rate по
 * факту) і `floor` (стара модель success×k+paidOnly) — ЛИШЕ для показу/контексту,
 * у прогноз-суму НЕ входять.
 * 🔴 САМ ПРОГНОЗ (Формула A, обрана бектестом — зміщення −3.9%, MAE 4.6%) рахується
 * В РОУТІ (buildPeriod): прогноз = факт + ПОВНА грошова зона (`expected.total`, усі
 * угоди 5 стадій за статусом) + добір (`newBusinessDobir`, новий бізнес). Складові
 * диз'юнктні (доведено). `floor`/`byPace` бектест показав як −46%/під — тому вони
 * контекст, не прогноз. Період [from,to] — місяць або тиждень.
 */
export async function revenueProjection(s: MoneyScope): Promise<RevenueProjection> {
  const [succ, recv] = await Promise.all([successMoney(s), receivedMoney(s)]);
  const fact = recv.revenue;
  const paidOnly = recv.revenue - succ.revenue;
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const start = new Date((s.from ?? todayStr.slice(0, 7) + "-01") + "T00:00:00");
  const end = new Date((s.to ?? todayStr) + "T00:00:00");
  const today = new Date(todayStr + "T00:00:00");
  const total = countWorkingDays(start, end);
  const elapsed = countWorkingDays(start, today < end ? today : end);
  const byPace = elapsed > 0 ? Math.round(fact * (total / elapsed)) : Math.round(fact);
  const floor = elapsed > 0 ? Math.round(succ.revenue * (total / elapsed) + paidOnly) : Math.round(fact);
  return { fact: Math.round(fact), byPace, floor, elapsedWorkingDays: elapsed, totalWorkingDays: total };
}

/**
 * Добір на нові угоди (компонент прогнозу, Формула A) — трейлінг-3-місячне середнє
 * надходжень від угод, СТВОРЕНИХ після поточного дня місяця й ЗАКРИТИХ (142) того ж
 * місяця. Це «новий бізнес», якого ще нема в зоні (на сьогодні ще не створений) →
 * disjoint від пайплайну (доведено: pipeline = створені ≤ сьогодні). Без зазирання
 * вперед — лише ЗАВЕРШЕНІ місяці перед поточним. Скоуп по менеджеру/команді.
 * cutoff-день = поточний день місяця («дні, що лишились»).
 */
export async function newBusinessDobir(s: MoneyScope): Promise<number> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [FC_PIPELINES];
  const conds = [
    "d.status_id = 142", "d.pipeline_id = ANY($1)", "d.closed_at_kommo IS NOT NULL",
    `to_char((d.created_at_kommo ${K}),'YYYY-MM') = to_char((d.closed_at_kommo ${K}),'YYYY-MM')`,
    `extract(day from (d.created_at_kommo ${K})) > extract(day from (now() ${K}))`,
    `(d.closed_at_kommo ${K})::date >= (date_trunc('month', now() ${K}) - interval '3 months')::date`,
    `(d.closed_at_kommo ${K})::date < date_trunc('month', now() ${K})::date`,
  ];
  if (s.managerId) { p.push(s.managerId); conds.push(`d.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ ym: string; s: string }>(
    `SELECT to_char((d.closed_at_kommo ${K}),'YYYY-MM') ym, COALESCE(SUM(d.price),0) s
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")} GROUP BY 1`,
    p
  );
  if (r.rows.length === 0) return 0;
  const sum = r.rows.reduce((a, x) => a + Number(x.s), 0);
  return Math.round(sum / r.rows.length); // середнє по наявних завершених місяцях (≤3)
}

export interface DobirRow { managerId: number; dobir: number }

/**
 * Добір (Формула A) ДЕКОМПОЗОВАНИЙ на менеджерів за ІСТОРИЧНОЮ ЧАСТКОЮ нового бізнесу
 * (рішення власника). Канонічний добір рахується на рівні ВІДДІЛУ (`newBusinessDobir`);
 * вага менеджера = його raw-новий-бізнес(трейл-3м) ÷ raw-відділу. `dobir_m = dobir_відділу
 * × вага_m` → Σ менеджерів = dobir_відділу (адитивно, Σ ваг = 1). Та сама популяція, що й
 * `newBusinessDobir` (створені після cutoff-дня, закриті того ж місяця, 142, 3 завершені
 * місяці). ⚠️ Це МОДЕЛЬОВАНА історична частка, НЕ живий пайплайн менеджера.
 * Значення `dobir` — точне (без округлення), щоб Σ = dobir_відділу; округляти на показі.
 */
export async function dobirByManager(s: MoneyScope): Promise<DobirRow[]> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const POP = (extra: string): string =>
    `d.status_id = 142 AND d.pipeline_id = ANY($1) AND d.closed_at_kommo IS NOT NULL
     AND to_char((d.created_at_kommo ${K}),'YYYY-MM') = to_char((d.closed_at_kommo ${K}),'YYYY-MM')
     AND extract(day from (d.created_at_kommo ${K})) > extract(day from (now() ${K}))
     AND (d.closed_at_kommo ${K})::date >= (date_trunc('month', now() ${K}) - interval '3 months')::date
     AND (d.closed_at_kommo ${K})::date < date_trunc('month', now() ${K})::date ${extra}`;
  const deptDobir = await newBusinessDobir({});
  const deptRawRes = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(d.price),0) s FROM deals d WHERE ${POP("")}`, [FC_PIPELINES]);
  const deptRaw = Number(deptRawRes.rows[0]?.s ?? 0);
  if (deptRaw === 0 || deptDobir === 0) return [];
  const factor = deptDobir / deptRaw;
  const p: unknown[] = [FC_PIPELINES];
  const sc: string[] = [];
  if (s.managerId) { p.push(s.managerId); sc.push(`AND d.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); sc.push(`AND m.team_id = $${p.length}`); }
  const rows = await pool.query<{ manager_id: number; raw: string }>(
    `SELECT d.manager_id, COALESCE(SUM(d.price),0) raw
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${POP(sc.join(" "))} AND d.manager_id IS NOT NULL
      GROUP BY d.manager_id`, p);
  return rows.rows.map((r) => ({ managerId: r.manager_id, dobir: Number(r.raw) * factor }));
}

// ───────────────────────── ТИЖНЕВА РОЗБИВКА (Р4a) ─────────────────────────

export interface WeekBreakdownRow {
  label: string; from: string; to: string;   // YYYY-MM-DD
  plan: number; fact: number; pct: number | null; remaining: number;
  status: "past" | "current" | "future";
}

/**
 * Р4a — динамічна тижнева розбивка місяця (правило KVP): фіксовані 7-денні
 * блоки від 1-го ([1-7],[8-14],[15-21],[22-28],[29-кінець]). Тижневий ФАКТ —
 * `successMoney` (датований по closed_at; снапшот paidOnly недатований, тому в
 * тижні НЕ входить — тижнева база = success). ПЛАН перерозкидається: залишок
 * місячного плану (мінус факт завершених тижнів) ділиться на РОБОЧІ ДНІ ще не
 * завершених тижнів. Минулі тижні — базовий план (monthPlan × wd/totalWd) для %.
 * `s.from` має бути 1-м числом місяця (YYYY-MM-01).
 */
export async function weeklyBreakdown(s: MoneyScope, monthPlan: number): Promise<WeekBreakdownRow[]> {
  const monthStr = (s.from ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" })).slice(0, 7);
  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  const wdBetween = (from: number, to: number): number => {
    let n = 0;
    for (let d = from; d <= to; d++) { const dow = new Date(y, mo - 1, d).getDay(); if (dow !== 0 && dow !== 6) n++; }
    return n;
  };
  const totalWd = wdBetween(1, daysInMonth);
  const starts = [1, 8, 15, 22, 29].filter((s2) => s2 <= daysInMonth);
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const todayDay = todayStr.slice(0, 7) === monthStr ? Number(todayStr.slice(8, 10)) : (todayStr.slice(0, 7) > monthStr ? 99 : 0);
  const pad = (d: number) => `${monthStr}-${String(d).padStart(2, "0")}`;

  const weeks = starts.map((from, i) => {
    const to = Math.min(from + 6, daysInMonth);
    const status: WeekBreakdownRow["status"] = to < todayDay ? "past" : from > todayDay ? "future" : "current";
    return { i, from, to, wd: wdBetween(from, to), status };
  });

  // ФАКТ по тижнях — датований success.
  const facts = await Promise.all(
    weeks.map((w) => successMoney({ ...s, from: pad(w.from), to: pad(w.to) }).then((r) => r.revenue))
  );

  const factCompleted = weeks.reduce((acc, w, i) => acc + (w.status === "past" ? facts[i] : 0), 0);
  const remainingPlan = Math.max(0, monthPlan - factCompleted);
  const remainingWd = weeks.filter((w) => w.status !== "past").reduce((a, w) => a + w.wd, 0);

  return weeks.map((w, i) => {
    const fact = Math.round(facts[i]);
    const plan = w.status === "past"
      ? Math.round(totalWd > 0 ? monthPlan * (w.wd / totalWd) : 0)
      : Math.round(remainingWd > 0 ? remainingPlan * (w.wd / remainingWd) : 0);
    return {
      label: `Тиждень ${w.i + 1}`, from: pad(w.from), to: pad(w.to),
      plan, fact, pct: plan > 0 ? Math.round((fact / plan) * 100) : null,
      remaining: Math.max(0, plan - fact), status: w.status,
    };
  });
}
