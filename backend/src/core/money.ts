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

/**
 * PHASE-1 #4 — ЛАНЦЮГ «в роботі до оплати»: усі стадії від «Авто працює» ДО «Оплата
 * отримана» ВКЛЮЧНО, БЕЗ 142 (обидва пайплайни). 🔴 in-flight пул — ЗНІМОК «станом на
 * зараз» (угоди, що ПРЯМО ЗАРАЗ на цих стадіях, БЕЗ фільтра періоду; рішення власника).
 * Пули СЕРЕДНЬОГО ЧЕКУ:
 *   • Звіт /report:  {chainInflight ЗАРАЗ} ∪ {success(142) за місяць по closed_at}
 *                    → «угоди в роботі зараз + виграні за місяць»
 *   • КВП «в очікуванні оплат»:  лише {chainInflight ЗАРАЗ} (снапшот, без 142)
 *   • КВП «успішно реалізовано»: лише success(142) за місяць (= avg_check_success_only)
 * НЕ входить «Виставлення рахунку» (100274340 / old 62940064-контроль) — операційна, ДО
 * «Авто працює». Success і chainInflight ДИЗ'ЮНКТНІ за поточним статусом (угода або ЗАРАЗ
 * 142, або ЗАРАЗ in-flight — ніколи обидва) → reportChain = проста сума без подвійного рахунку.
 * New(8921932): 69716300 Авто працює · 98470988 Перевезення завершено · 69716304 Виставлено
 *   рахунок після розвантаж. · 69716312 Очікуємо оплату · 69716460 Оплата отримана.
 * Old(155304):  10937178 Авто працює · 42639144 Виставлено рахунок · 42639147 Документи
 *   получены · 25044997 Очікуємо оплату (оплачений) · 62940068 Очікуємо оплату (не опл.) ·
 *   60412544 Оплата отримана.
 */
export const CHAIN_INFLIGHT = [69716300, 98470988, 69716304, 69716312, 69716460, 10937178, 42639144, 42639147, 25044997, 62940068, 60412544];

export interface MoneyScope {
  from?: string | null;
  to?: string | null;
  managerId?: number | null;
  teamId?: number | null;
  activeOnly?: boolean;
}
export interface MoneyAgg { revenue: number; deals: number }
export interface TeamRow { teamId: number; teamName: string; revenue: number; deals: number }
export interface MgrRow { managerId: number; name: string; teamId: number | null; revenue: number; deals: number
  /** 🔴 `false` = звільнений. Гроші лишаються, але в розрізі мусить бути ПІДПИС. */
  isActive?: boolean;
}
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
  // 🔴 `is_active` КЕРУЄ СПИСКАМИ Й ВИБОРОМ, А НЕ ІСТОРИЧНИМИ СУМАМИ
  // (рішення власника 05.08.2026). Гроші зароблені тоді, коли людина працювала, і
  // заднім числом не зникають. Жоден грошовий розріз більше не ставить `activeOnly`.
  //
  // ⚠️ ЧОМУ ЦЕ НЕ ТЕОРІЯ. 05.08.2026 менеджера деактивували в Kommo, а його угоди
  // перепризначили лише за пів години. У цю щілину `Σ(менеджери)` стало на
  // **16 567 ₴** менше за `Σ(команди)` — бо по менеджерах фільтр стояв, по командах
  // ні. Гейт `#37` тримає: деактивація НЕ рухає жодної історичної суми.
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
  const rows = await query<{ manager_id: number; name: string; team_id: number | null; is_active: boolean; revenue: string; deals: string }>(
    kind, s,
    "m.id AS manager_id, m.name, m.team_id, m.is_active, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals",
    "GROUP BY m.id, m.name, m.team_id, m.is_active"
  );
  return rows.map((x) => ({ managerId: x.manager_id, name: x.name, teamId: x.team_id,
    isActive: x.is_active, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

// «Отримані кошти» = success ⊎ paidOnly.
export const receivedMoney = (s: MoneyScope) => agg("received", s);
export const receivedByTeam = (s: MoneyScope) => aggByTeam("received", s);
export const receivedByMgr = (s: MoneyScope) => aggByMgr("received", s);

// Блок B — «отримані кошти» РОЗКЛАДЕНІ по атрибуту угоди (напрямок / канал продажу /
// клієнт). ТА САМА каса, що receivedMoney (received src = success ⊎ paidOnly, анкер+дедуп),
// лише GROUP BY атрибут. Σ рядків == receivedMoney (COALESCE «—» ловить NULL → повний
// розподіл). НЕ новий money-SQL — reuse sourceSql (ядро одне).
export interface DimRow { key: string; revenue: number; deals: number }
/**
 * Розклад грошей ЯДРА по атрибуту угоди. Параметризовано `kind`, бо той самий
 * розріз потрібен і для ② («отримані кошти», Огляд), і для ① («успішно
 * реалізовано» — усе інше). Ядро одне, змінюється лише джерело.
 */
async function byDealAttr(kind: Kind, s: MoneyScope, expr: string): Promise<DimRow[]> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [];
  const src = sourceSql(kind, p);
  const conds: string[] = [];
  if (s.from) { p.push(s.from); conds.push(`(src.anchor_at ${K})::date >= $${p.length}`); }
  if (s.to) { p.push(s.to); conds.push(`(src.anchor_at ${K})::date <= $${p.length}`); }
  if (s.managerId) { p.push(s.managerId); conds.push(`src.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const rows = (await pool.query<{ k: string; revenue: string; deals: string }>(
    `SELECT ${expr} AS k, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals
       FROM (${src}) src
       JOIN managers m ON m.id = src.manager_id
       JOIN deals dd ON dd.kommo_id = src.kommo_id
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      GROUP BY 1 ORDER BY revenue DESC`, p)).rows;
  return rows.map((x) => ({ key: x.k, revenue: Number(x.revenue), deals: Number(x.deals) }));
}
const receivedByDealAttr = (s: MoneyScope, expr: string) => byDealAttr("received", s, expr);
export const receivedByRequestType = (s: MoneyScope) => receivedByDealAttr(s, "COALESCE(dd.request_type, '—')");
// «Тендерний напрямок» (реальне enum-значення Kommo 2099549) бізнес зве «Самостійні»
// (самостійні менеджери) — relabel на показ, БЕЗ зміни сум (Σ == received тримається).
export const receivedBySalesChannel = (s: MoneyScope) => receivedByDealAttr(s, "COALESCE(CASE WHEN dd.sales_channel = 'Тендерний напрямок' THEN 'Самостійні' ELSE dd.sales_channel END, '—')");
// По клієнту (для концентрації + розподілу повторних рейсів). Без client_key → «—».
export const receivedByClientKey = (s: MoneyScope) => receivedByDealAttr(s, "COALESCE(dd.client_key, '—')");

/**
 * ① «УСПІШНО РЕАЛІЗОВАНО» ПО КЛІЄНТУ (канонічний `client_key`).
 *
 * 🔴 Це та сама функція ядра, що дає `successByMgr`/`successMoney` — інший лише
 * GROUP BY. Тому Σ по клієнтах менеджера СХОДИТЬСЯ з `successByMgr` того ж
 * періоду за побудовою, а не «бо ми написали схожий SQL». Саме на цьому стоїть
 * гейт екрана «Постійні клієнти · план місяця».
 *
 * Клієнт = КАНОНІЧНИЙ ключ: злиті телефони й назви рахуються разом (`client_key`
 * — похідна від `client_key_raw` через реєстр псевдонімів).
 */
export const successByClientKey = (s: MoneyScope) => byDealAttr("success", s, "COALESCE(dd.client_key, '—')");

export interface ClientBucketRow { clientKey: string; bucket: string; revenue: number; deals: number }
/**
 * ① по клієнту × календарному бакету (день/тиждень/місяць) — для міні-барів
 * «історія 6 міс». Один запит замість N: групування по клієнту І бакету.
 *
 * `onlyClientKey` звужує вибірку до ОДНОГО клієнта (картка клієнта, 12 міс.).
 * 🔴 Чому окремий АРГУМЕНТ, а не поле в `MoneyScope`: поле у скоупі мовчки нічого
 * не робило б у решті функцій ядра (`successMoney`, `successByMgr`, …), і перший,
 * хто його туди передасть, отримає цифру по ВСІХ клієнтах, думаючи, що звузив.
 * Аргумент існує рівно там, де він діє.
 */
export async function successByClientBucket(
  s: MoneyScope, granularity: "day" | "week" | "month", onlyClientKey?: string,
): Promise<ClientBucketRow[]> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [];
  const src = sourceSql("success", p);
  const conds: string[] = [];
  if (s.from) { p.push(s.from); conds.push(`(src.anchor_at ${K})::date >= $${p.length}`); }
  if (s.to) { p.push(s.to); conds.push(`(src.anchor_at ${K})::date <= $${p.length}`); }
  if (s.managerId) { p.push(s.managerId); conds.push(`src.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  if (onlyClientKey) { p.push(onlyClientKey); conds.push(`dd.client_key = $${p.length}`); }
  const rows = (await pool.query<{ ck: string; b: string; revenue: string; deals: string }>(
    `SELECT COALESCE(dd.client_key, '—') AS ck,
            to_char(date_trunc('${granularity}', (src.anchor_at ${K})), 'YYYY-MM-DD') AS b,
            COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals
       FROM (${src}) src
       JOIN managers m ON m.id = src.manager_id
       JOIN deals dd ON dd.kommo_id = src.kommo_id
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      GROUP BY 1, 2`, p)).rows;
  return rows.map((x) => ({ clientKey: x.ck, bucket: x.b, revenue: Number(x.revenue), deals: Number(x.deals) }));
}

export interface ClientWeekRow { clientKey: string; weekIndex: number; revenue: number; deals: number }
/**
 * ① по клієнту × ТИЖНЮ місяця. Межі тижнів беруться з `monthWeeks` — тієї самої
 * функції, що живить Звіт; інакше «тиждень 2» на двох екранах означав би різні дні.
 * `s.from` має бути 1-м числом місяця.
 */
export async function successByClientWeek(s: MoneyScope): Promise<ClientWeekRow[]> {
  const monthStr = (s.from ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" })).slice(0, 7);
  const weeks = monthWeeks(monthStr);
  // 🔴 ОДИН запит по днях, а не пʼять по тижнях. Перша версія робила
  // `successByClientKey` на кожен тиждень — пʼять повних сканів `deals` заради
  // розрізу, який дає один GROUP BY. У пісочниці це коштувало 8.5 с на запит; на
  // проді (146 тис. угод) було б помітно гірше, і виглядало б як «екран гальмує»,
  // а не як «ми пʼять разів спитали те саме».
  const days = await successByClientBucket(s, "day");
  const idxOf = (ymd: string): number => {
    const d = Number(ymd.slice(8, 10));
    for (const w of weeks) if (d >= w.fromDay && d <= w.toDay) return w.index;
    return weeks.length - 1;
  };
  const acc = new Map<string, ClientWeekRow>();
  for (const r of days) {
    if (r.bucket.slice(0, 7) !== monthStr) continue;
    const wi = idxOf(r.bucket);
    const k = `${r.clientKey}|${wi}`;
    const cur = acc.get(k) ?? { clientKey: r.clientKey, weekIndex: wi, revenue: 0, deals: 0 };
    cur.revenue += r.revenue; cur.deals += r.deals;
    acc.set(k, cur);
  }
  return [...acc.values()];
}

export interface SegmentAgg { newSeg: MoneyAgg; repeatSeg: MoneyAgg; unattributed: MoneyAgg }

/**
 * «Отримані кошти» РОЗКЛАДЕНІ по сегменту КЛІЄНТА (Крок Д owner-review #3): ТА САМА
 * каса, що `receivedMoney` (received src = success ⊎ paidOnly, анкер stage-entry/
 * closed_at, дедуп), лише розбита client-grain:
 *   • new    — перша оплата клієнта (lifetime MIN(created_at) серед paid) у періоді;
 *   • repeat — перша оплата була ДО періоду;
 *   • unattributed — угода без `client_key` (немає по чому віднести) → ЗАЛИШОК показуємо
 *     ЯВНО, не ховаємо. Σ(new+repeat+unattributed) == `receivedMoney` (той самий src).
 */
export async function receivedBySegment(s: MoneyScope): Promise<SegmentAgg> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [];
  const src = sourceSql("received", p);
  const conds: string[] = [];
  if (s.from) { p.push(s.from); conds.push(`(src.anchor_at ${K})::date >= $${p.length}`); }
  if (s.to) { p.push(s.to); conds.push(`(src.anchor_at ${K})::date <= $${p.length}`); }
  if (s.managerId) { p.push(s.managerId); conds.push(`src.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const fromRef = s.from ? (p.push(s.from), `$${p.length}`) : "NULL";
  const rows = (await pool.query<{ seg: string; revenue: string; deals: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL GROUP BY d.client_key
     ),
     pop AS (
       SELECT src.price, dd.client_key, f.first_paid
         FROM (${src}) src
         JOIN managers m ON m.id = src.manager_id
         JOIN deals dd ON dd.kommo_id = src.kommo_id
         LEFT JOIN firsts f ON f.client_key = dd.client_key
        ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
     )
     SELECT CASE WHEN client_key IS NULL OR first_paid IS NULL THEN 'u'
                 WHEN ${fromRef}::date IS NOT NULL AND first_paid >= ${fromRef}::date THEN 'n'
                 ELSE 'r' END AS seg,
            COALESCE(SUM(price),0) AS revenue, COUNT(*) AS deals
       FROM pop GROUP BY 1`, p)).rows;
  const g = (k: string): MoneyAgg => { const r = rows.find((x) => x.seg === k); return { revenue: Number(r?.revenue ?? 0), deals: Number(r?.deals ?? 0) }; };
  return { newSeg: g("n"), repeatSeg: g("r"), unattributed: g("u") };
}

// receivedBySegment РОЗБИТИЙ ПО ДНЯХ (для тижневого факту Нові/Постійні у Повній таблиці).
// Той самий src/сегментація (сегмент відносно ПЕРІОДУ), лише + день анкера. Σднів == місяць.
export interface SegDayRow { day: string; newRev: number; repeatRev: number }
export async function receivedSegByDay(s: MoneyScope): Promise<SegDayRow[]> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [];
  const src = sourceSql("received", p);
  const conds: string[] = [];
  if (s.from) { p.push(s.from); conds.push(`(src.anchor_at ${K})::date >= $${p.length}`); }
  if (s.to) { p.push(s.to); conds.push(`(src.anchor_at ${K})::date <= $${p.length}`); }
  const fromRef = s.from ? (p.push(s.from), `$${p.length}`) : "NULL";
  const rows = (await pool.query<{ day: string; seg: string; revenue: string }>(
    `WITH firsts AS (
       SELECT d.client_key, MIN(d.created_at_kommo) AS first_paid
         FROM deals d JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL GROUP BY d.client_key),
     pop AS (
       SELECT src.price, to_char((src.anchor_at ${K})::date, 'YYYY-MM-DD') AS day, dd.client_key, f.first_paid
         FROM (${src}) src JOIN managers m ON m.id = src.manager_id
         JOIN deals dd ON dd.kommo_id = src.kommo_id LEFT JOIN firsts f ON f.client_key = dd.client_key
        ${conds.length ? "WHERE " + conds.join(" AND ") : ""})
     SELECT day, CASE WHEN client_key IS NULL OR first_paid IS NULL THEN 'u'
                      WHEN ${fromRef}::date IS NOT NULL AND first_paid >= ${fromRef}::date THEN 'n' ELSE 'r' END AS seg,
            COALESCE(SUM(price),0) AS revenue FROM pop GROUP BY 1, 2`, p)).rows;
  const map = new Map<string, SegDayRow>();
  for (const x of rows) {
    const d = map.get(x.day) ?? { day: x.day, newRev: 0, repeatRev: 0 };
    if (x.seg === "n") d.newRev += Number(x.revenue); else if (x.seg === "r") d.repeatRev += Number(x.revenue);
    map.set(x.day, d);
  }
  return [...map.values()];
}

// «Успішно реалізовано» (ЗАРАЗ 142, за closed_at) — знаменник avg_check_success_only.
export const successMoney = (s: MoneyScope) => agg("success", s);
export const successByTeam = (s: MoneyScope) => aggByTeam("success", s);
export const successByMgr = (s: MoneyScope) => aggByMgr("success", s);
export interface MgrAvgCheck { managerId: number; revenue: number; successDeals: number; avgCheck: number | null }
/**
 * СЕРЕДНІЙ ЧЕК ПО МЕНЕДЖЕРУ (`avg_check_success_only`) — ЄДИНЕ джерело для Звіту й
 * задачника. = successByMgr.revenue ÷ successByMgr.deals (успіх 142, closed_at,
 * signed). 🔴 Знаменник = К-ТЬ ВИГРАНИХ УГОД (не dispatched): саме це число
 * звіряється з ручним листом (діапазон 2600–2900) і саме його рахує КВП-звіт
 * (dashboard.ts) → крос-екран Звіт==КВП по менеджеру тримається. avgCheck=null
 * коли виграних угод 0 (UI показує «—», не «0»). Scope-aware.
 */
export async function avgCheckByManager(s: MoneyScope): Promise<MgrAvgCheck[]> {
  const succ = await successByMgr(s);
  return succ.map((x) => ({
    managerId: x.managerId, revenue: x.revenue, successDeals: x.deals,
    avgCheck: x.deals > 0 ? Math.round(x.revenue / x.deals) : null,
  }));
}

/**
 * ЗНІМОК «станом на зараз» по НАБОРУ стадій — угоди, що ПРЯМО ЗАРАЗ на цих стадіях
 * (з `deals`, БЕЗ періоду й анкера). Дзеркало `awaitingNowSnapshot`, але параметризоване
 * набором стадій і з грейном total/team/mgr. Active-only на ВСІХ грейнах → Σ менеджерів =
 * команда = відділ. signed price (мінуси нетяться).
 */
async function snapshotBy(stages: number[], s: MoneyScope, extraSelect: string, groupBy: string): Promise<Record<string, string>[]> {
  const p: unknown[] = [FC_PIPELINES, stages];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)"];
  if (s.managerId) { p.push(s.managerId); conds.push(`d.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const teamsJoin = /\bt\./.test(extraSelect + groupBy) ? "LEFT JOIN teams t ON t.id = m.team_id" : "";
  const sql = `SELECT ${extraSelect}
     FROM deals d JOIN managers m ON m.id = d.manager_id AND m.is_active ${teamsJoin}
    WHERE ${conds.join(" AND ")} ${groupBy}`;
  return (await pool.query(sql, p)).rows as Record<string, string>[];
}
async function snapshotAgg(stages: number[], s: MoneyScope): Promise<MoneyAgg> {
  const r = await snapshotBy(stages, s, "COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals", "");
  return { revenue: Number(r[0]?.revenue ?? 0), deals: Number(r[0]?.deals ?? 0) };
}
async function snapshotByTeam(stages: number[], s: MoneyScope): Promise<TeamRow[]> {
  const r = await snapshotBy(stages, s, "t.id AS team_id, t.name AS team_name, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals", "GROUP BY t.id, t.name");
  return r.map((x) => ({ teamId: Number(x.team_id), teamName: x.team_name, revenue: Number(x.revenue), deals: Number(x.deals) }));
}
async function snapshotByMgr(stages: number[], s: MoneyScope): Promise<MgrRow[]> {
  const r = await snapshotBy(stages, s, "m.id AS manager_id, m.name, m.team_id, COALESCE(SUM(d.price),0) AS revenue, COUNT(*) AS deals", "GROUP BY m.id, m.name, m.team_id");
  return r.map((x) => ({ managerId: Number(x.manager_id), name: x.name, teamId: x.team_id == null ? null : Number(x.team_id), revenue: Number(x.revenue), deals: Number(x.deals) }));
}

/**
 * PHASE-1 #4 — ЄДИНА параметризована функція СЕРЕДНЬОГО ЧЕКУ (одна метрика = одна функція,
 * усі екрани кличуть її). `avgCheck = Σ signed price ÷ COUNT угод` → для команди/відділу
 * автоматично Σsum÷Σcount (НЕ середнє середніх — old-per-route формули пенсіонуються).
 * Пул (рішення власника — in-flight ЗНІМОК, success за МІСЯЦЕМ):
 *   • `success`       — лише 142 за [from,to] по `closed_at` (= avg_check_success_only, gate 2878);
 *   • `chainInflight` — ЗНІМОК угод ЗАРАЗ у ланцюгу «авто→оплата» (БЕЗ 142, БЕЗ періоду);
 *   • `reportChain`   — {chainInflight ЗАРАЗ} ⊎ {success за місяць} (Звіт /report).
 * Success і chainInflight диз'юнктні за поточним статусом → reportChain = проста сума.
 * `avgCheck=null` коли угод 0 (UI показує «—»). Active-only скрізь → Σмгр = команда = відділ.
 */
export type AvgPool = "reportChain" | "chainInflight" | "success";
export interface AvgCheckAgg extends MoneyAgg { avgCheck: number | null }
const withAvg = <T extends MoneyAgg>(x: T): T & { avgCheck: number | null } =>
  ({ ...x, avgCheck: x.deals > 0 ? Math.round(x.revenue / x.deals) : null });
const addAgg = (a: MoneyAgg, b: MoneyAgg): MoneyAgg => ({ revenue: a.revenue + b.revenue, deals: a.deals + b.deals });
// success за період. БЕЗ фільтра активності — див. правило нижче: гроші зароблені
// тоді, коли людина працювала, і заднім числом не зникають.
const successAggActive = (s: MoneyScope) => agg("success", s);

export async function avgCheck(pool: AvgPool, s: MoneyScope): Promise<AvgCheckAgg> {
  if (pool === "success") return withAvg(await successAggActive(s));
  if (pool === "chainInflight") return withAvg(await snapshotAgg(CHAIN_INFLIGHT, s));
  const [su, ci] = await Promise.all([successAggActive(s), snapshotAgg(CHAIN_INFLIGHT, s)]);
  return withAvg(addAgg(su, ci));
}

export async function avgCheckByTeam(pool: AvgPool, s: MoneyScope): Promise<(TeamRow & { avgCheck: number | null })[]> {
  if (pool === "chainInflight") return (await snapshotByTeam(CHAIN_INFLIGHT, s)).map(withAvg);
  const su = await aggByTeam("success", s);
  if (pool === "success") return su.map(withAvg);
  const ci = await snapshotByTeam(CHAIN_INFLIGHT, s);
  return mergeTeam(su, ci).map(withAvg);
}

export async function avgCheckPerManager(pool: AvgPool, s: MoneyScope): Promise<(MgrRow & { avgCheck: number | null })[]> {
  if (pool === "chainInflight") return (await snapshotByMgr(CHAIN_INFLIGHT, s)).map(withAvg);
  const su = await aggByMgr("success", s); // aggByMgr already active-only
  if (pool === "success") return su.map(withAvg);
  const ci = await snapshotByMgr(CHAIN_INFLIGHT, s);
  return mergeMgr(su, ci).map(withAvg);
}

// Злиття success+inflight по ключу (диз'юнктні за статусом, але той самий менеджер/команда
// може мати угоди в ОБОХ множинах → сумуємо revenue+deals по ключу; Σ тримається).
function mergeTeam(a: TeamRow[], b: TeamRow[]): TeamRow[] {
  const m = new Map<number, TeamRow>();
  for (const r of [...a, ...b]) {
    const e = m.get(r.teamId) ?? { teamId: r.teamId, teamName: r.teamName, revenue: 0, deals: 0 };
    e.revenue += r.revenue; e.deals += r.deals; m.set(r.teamId, e);
  }
  return [...m.values()].sort((x, y) => y.revenue - x.revenue);
}
function mergeMgr(a: MgrRow[], b: MgrRow[]): MgrRow[] {
  const m = new Map<number, MgrRow>();
  for (const r of [...a, ...b]) {
    const e = m.get(r.managerId) ?? { managerId: r.managerId, name: r.name, teamId: r.teamId, revenue: 0, deals: 0 };
    e.revenue += r.revenue; e.deals += r.deals; m.set(r.managerId, e);
  }
  return [...m.values()].sort((x, y) => y.revenue - x.revenue);
}

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

export interface MgrBucketRow { managerId: number; bucket: string; revenue: number; deals: number }
async function mgrBucketAgg(kind: Kind, s: MoneyScope, granularity: "day" | "week" | "month"): Promise<MgrBucketRow[]> {
  const rows = await query<{ manager_id: number; bucket: string; revenue: string; deals: string }>(
    kind, s,
    `src.manager_id AS manager_id, to_char(date_trunc('${granularity}', (src.anchor_at AT TIME ZONE 'Europe/Kyiv')), 'YYYY-MM-DD') AS bucket, COALESCE(SUM(src.price),0) AS revenue, COUNT(*) AS deals`,
    "GROUP BY 1, 2 ORDER BY 2"
  );
  return rows.map((x) => ({ managerId: x.manager_id, bucket: x.bucket, revenue: Number(x.revenue), deals: Number(x.deals) }));
}
/** received по (менеджер × день/тиждень) ОДНИМ запитом — для денного дрілу КВП (Крок Д #4). */
export const receivedByManagerBucket = (s: MoneyScope, granularity: "day" | "week") => mgrBucketAgg("received", s, granularity);
/**
 * ① «Успішно реалізовано» по (менеджер × день/тиждень/місяць) — дзеркало
 * `receivedByManagerBucket` з `kind='success'`. Та сама каса, лише анкер = `closed_at`
 * і множина = ЗАРАЗ 142. Σ бакетів менеджера = `successByMgr` того ж періоду.
 */
export const successByManagerBucket = (s: MoneyScope, granularity: "day" | "week" | "month") => mgrBucketAgg("success", s, granularity);
/** ⑨ «оплата отримана, ще не закрито» по (менеджер × бакет) — щоб день міг показати
 *  РОЗКЛАД ② , а не лише суму. Сума без розкладу і є та поломка, з якої почалась
 *  історія картки Антипенка: 23 632 ₴ виглядали як нуль, бо ① і ⑨ не були розділені. */
export const paidOnlyByManagerBucket = (s: MoneyScope, granularity: "day" | "week" | "month") => mgrBucketAgg("paidOnly", s, granularity);

/**
 * «Успішно реалізовано» (won 142, анкер `closed_at`, signed price) по (менеджер × МІСЯЦЬ)
 * — для 6-міс історії-барів у «Плани» і для 3-міс бази рекомендації. ТА САМА success-каса
 * (`sourceSql("success")`), лише бакет = київський місяць. Active-only. Σ менеджерів на
 * кожен місяць = команда = відділ (той самий інваріант, що всі money-per-manager функції).
 * Вікно [from,to] задає викликач (напр. 6 повних місяців перед target-місяцем).
 */
export const successByManagerMonth = (s: MoneyScope) => mgrBucketAgg("success", s, "month");

/** received по (менеджер × тиждень) за місяць — для тижневої сітки план/факт. */
export const receivedByManagerWeek = (managerIds: number[], monthStart: string) =>
  mgrWeekAgg("received", managerIds, monthStart);
/**
 * ① «Успішно реалізовано» по (менеджер × тиждень) за місяць — дзеркало
 * `receivedByManagerWeek`. Σ тижнів менеджера = `successByMgr` за той самий місяць.
 */
export const successByManagerWeek = (managerIds: number[], monthStart: string) =>
  mgrWeekAgg("success", managerIds, monthStart);
async function mgrWeekAgg(kind: Kind, managerIds: number[], monthStart: string): Promise<MgrWeekRow[]> {
  const p: unknown[] = [];
  const src = sourceSql(kind, p);
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

/** Батчева двійня `newBusinessDobir` — ТОЙ САМИЙ предикат, лише GROUP BY менеджер, щоб не
 *  кликати `buildProjection` по 35 разів у Звіті. Σ/к-сть місяців рахується per-manager
 *  так само (середнє по наявних ≤3 завершених місяцях) → out.get(id) == newBusinessDobir({managerId:id}). */
export async function newBusinessDobirByManager(s: MoneyScope): Promise<Map<number, number>> {
  const K = "AT TIME ZONE 'Europe/Kyiv'";
  const p: unknown[] = [FC_PIPELINES];
  const conds = [
    "d.status_id = 142", "d.pipeline_id = ANY($1)", "d.closed_at_kommo IS NOT NULL",
    `to_char((d.created_at_kommo ${K}),'YYYY-MM') = to_char((d.closed_at_kommo ${K}),'YYYY-MM')`,
    `extract(day from (d.created_at_kommo ${K})) > extract(day from (now() ${K}))`,
    `(d.closed_at_kommo ${K})::date >= (date_trunc('month', now() ${K}) - interval '3 months')::date`,
    `(d.closed_at_kommo ${K})::date < date_trunc('month', now() ${K})::date`,
  ];
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ manager_id: number; ym: string; s: string }>(
    `SELECT d.manager_id, to_char((d.closed_at_kommo ${K}),'YYYY-MM') ym, COALESCE(SUM(d.price),0) s
       FROM deals d LEFT JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")} AND d.manager_id IS NOT NULL GROUP BY 1, 2`, p);
  const acc = new Map<number, { sum: number; months: Set<string> }>();
  for (const x of r.rows) {
    const e = acc.get(x.manager_id) ?? { sum: 0, months: new Set<string>() };
    e.sum += Number(x.s); e.months.add(x.ym); acc.set(x.manager_id, e);
  }
  const out = new Map<number, number>();
  for (const [id, e] of acc) out.set(id, e.months.size ? Math.round(e.sum / e.months.size) : 0);
  return out;
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

/**
 * 🗓 ЄДИНЕ ДЖЕРЕЛО МЕЖ ТИЖНІВ МІСЯЦЯ — фіксовані 7-денні блоки від 1-го:
 * [1-7], [8-14], [15-21], [22-28], [29-кінець]. Правило КВП.
 *
 * 🔴 НАВІЩО ОКРЕМА ФУНКЦІЯ. Той самий `[1, 8, 15, 22, 29].filter(...)` стояв
 * у ТРЬОХ місцях (`weeklyBreakdown` + два блоки в `routes/dashboard.ts`). Поки
 * копії однакові, різниці не видно; варто одній поїхати — і «тиждень 2» у Звіті
 * означатиме інші дні, ніж «тиждень 2» у плані по клієнтах, а зійтись вони мають
 * ДО ГРИВНІ. Такі розходження не падають — вони тихо дають дві правди.
 */
export interface MonthWeek {
  index: number;      // 0-based
  label: string;      // «Тиждень 1»
  from: string; to: string;   // YYYY-MM-DD, обидва кінці включно
  fromDay: number; toDay: number;
  workingDays: number;
  status: "past" | "current" | "future";
}
export function monthWeeks(monthStr: string, todayStr?: string): MonthWeek[] {
  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  const wdBetween = (from: number, to: number): number => {
    let n = 0;
    for (let d = from; d <= to; d++) { const dow = new Date(y, mo - 1, d).getDay(); if (dow !== 0 && dow !== 6) n++; }
    return n;
  };
  const today = todayStr ?? new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
  const todayDay = today.slice(0, 7) === monthStr ? Number(today.slice(8, 10)) : (today.slice(0, 7) > monthStr ? 99 : 0);
  const pad = (d: number) => `${monthStr}-${String(d).padStart(2, "0")}`;
  return [1, 8, 15, 22, 29].filter((s2) => s2 <= daysInMonth).map((from, i) => {
    const to = Math.min(from + 6, daysInMonth);
    return {
      index: i, label: `Тиждень ${i + 1}`, from: pad(from), to: pad(to),
      fromDay: from, toDay: to, workingDays: wdBetween(from, to),
      status: (to < todayDay ? "past" : from > todayDay ? "future" : "current") as MonthWeek["status"],
    };
  });
}
/** Робочі дні місяця цілком — знаменник розкидання плану. */
export function monthWorkingDays(monthStr: string): number {
  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  let n = 0;
  for (let d = 1; d <= daysInMonth; d++) { const dow = new Date(y, mo - 1, d).getDay(); if (dow !== 0 && dow !== 6) n++; }
  return n;
}

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
  const totalWd = monthWorkingDays(monthStr);
  const weeks = monthWeeks(monthStr).map((w) => ({ i: w.index, from: w.from, to: w.to, wd: w.workingDays, status: w.status }));

  // ФАКТ по тижнях — датований success.
  const facts = await Promise.all(
    weeks.map((w) => successMoney({ ...s, from: w.from, to: w.to }).then((r) => r.revenue))
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
      label: `Тиждень ${w.i + 1}`, from: w.from, to: w.to,
      plan, fact, pct: plan > 0 ? Math.round((fact / plan) * 100) : null,
      remaining: Math.max(0, plan - fact), status: w.status,
    };
  });
}
