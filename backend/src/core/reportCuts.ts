import { pool } from "../db/pool.js";
import { FC_PIPELINES, STAGE_RECEIVED } from "./money.js";

/**
 * 📊 РОЗРІЗИ ЗВІТУ, ЯКИХ НЕ БУЛО В ЯДРІ (макет 06.08.2026).
 *
 * 🔴 ЖОДНОГО ВЛАСНОГО SQL ПО ВИРУЧЦІ. Тут рахуються ЛИЧИЛЬНІ речі (дзвінки,
 * штуки рахунків) і ЗНІМОК однієї стадії — але не гроші періоду: їх і далі
 * рахує лише `core/money.ts`. Це не формальність: свій SQL по виручці розійдеться
 * з дашбордом через місяці, і ніхто не дізнається, який із них правильний.
 */

const K = "AT TIME ZONE 'Europe/Kyiv'";

/**
 * 🔴 `AS` ПЕРЕД ПСЕВДОНІМОМ `day` — ОБОВʼЯЗКОВЕ, І ЦЕ НЕ СТИЛЬ.
 *
 * `day` — ключове слово Postgres (`EXTRACT(DAY FROM …)`, `INTERVAL '1 day'`), і як
 * псевдонім колонки БЕЗ `AS` воно дає `syntax error at or near "day"`. Решта
 * псевдонімів у цьому файлі (`talks`, `attempts`, `n`, `s`) працюють без `AS`, тому
 * пропуск виглядав однорідно й нешкідливо.
 *
 * ⚠️ ЦЕ КОШТУВАЛО ПРОДА: обидві функції нижче падали, роут
 * `/kvp-report/manager-detail` віддавав 500, і розгортка рядка менеджера по днях
 * перестала працювати. Жоден із 202 тестів цього не бачив — жоден не клікає.
 * Сусідній `metrics.expectedByManagerDay` увесь час стояв із `AS day` і працював,
 * тобто правильний зразок лежав поруч.
 */

/** Стадія «Виставлення рахунку» — та, на якій стоїть затор. Значення одне, місце одне. */
export const STAGE_INVOICING = 100274340;

export interface CallsRow { managerId: number; talks: number; attempts: number }
/**
 * 📞 КОНТАКТ = РОЗМОВА (`billsec > 0`), рішення власника 04.08.2026. Недодзвони —
 * ОКРЕМА цифра «спроби», складати їх в одну ЗАБОРОНЕНО: це відповіді на різні
 * питання («чи був контакт» і «чи людина працює»).
 */
export async function callsByManager(from: string, to: string, scope: { managerId?: number | null; teamId?: number | null }): Promise<CallsRow[]> {
  const p: unknown[] = [from, to];
  const conds = [`(rc.calldate ${K})::date BETWEEN $1 AND $2`, "rc.manager_id IS NOT NULL"];
  if (scope.managerId) { p.push(scope.managerId); conds.push(`rc.manager_id = $${p.length}`); }
  if (scope.teamId) { p.push(scope.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ manager_id: number; talks: string; attempts: string }>(
    `SELECT rc.manager_id,
            COUNT(*) FILTER (WHERE rc.billsec > 0)::int talks,
            COUNT(*) FILTER (WHERE rc.billsec = 0)::int attempts
       FROM ringostat_calls rc JOIN managers m ON m.id = rc.manager_id
      WHERE ${conds.join(" AND ")} GROUP BY 1`, p);
  return r.rows.map((x) => ({ managerId: x.manager_id, talks: Number(x.talks), attempts: Number(x.attempts) }));
}

export interface CallsDayRow { managerId: number; day: string; talks: number; attempts: number }
/** Ті самі дві цифри, що `callsByManager`, лише в розрізі днів — для розгортки рядка. */
export async function callsByManagerDay(from: string, to: string, scope: { managerId?: number | null; teamId?: number | null }): Promise<CallsDayRow[]> {
  const p: unknown[] = [from, to];
  const conds = [`(rc.calldate ${K})::date BETWEEN $1 AND $2`, "rc.manager_id IS NOT NULL"];
  if (scope.managerId) { p.push(scope.managerId); conds.push(`rc.manager_id = $${p.length}`); }
  if (scope.teamId) { p.push(scope.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ manager_id: number; day: string; talks: string; attempts: string }>(
    `SELECT rc.manager_id, to_char((rc.calldate ${K})::date,'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE rc.billsec > 0)::int talks,
            COUNT(*) FILTER (WHERE rc.billsec = 0)::int attempts
       FROM ringostat_calls rc JOIN managers m ON m.id = rc.manager_id
      WHERE ${conds.join(" AND ")} GROUP BY 1, 2`, p);
  return r.rows.map((x) => ({ managerId: x.manager_id, day: x.day, talks: Number(x.talks), attempts: Number(x.attempts) }));
}

export interface JamRow { managerId: number; deals: number; sum: number }
/**
 * 🧱 ЗАТОР НА «ВИСТАВЛЕННІ РАХУНКУ» — знімок «зараз» (рішення власника 06.08.2026).
 *
 * Стадія лишається в зоні очікування (це рішення власника), але має бути ВИДНО,
 * скільки очікувань насправді сидить саме тут: заміряно 06.08 — 249 553 ₴ із
 * 578 801 ₴ (43%) по компанії, а в Шаврової це 100% її очікувань. Різниця між
 * «гроші на підході» і «рахунок ще не виставлений» — це різниця між домовленістю
 * і наміром, і на екрані вона мусить читатись.
 */
export async function invoicingJamByManager(scope: { managerId?: number | null; teamId?: number | null }): Promise<JamRow[]> {
  const p: unknown[] = [FC_PIPELINES, STAGE_INVOICING];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = $2"];
  if (scope.managerId) { p.push(scope.managerId); conds.push(`d.manager_id = $${p.length}`); }
  if (scope.teamId) { p.push(scope.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ manager_id: number; n: string; s: string }>(
    `SELECT d.manager_id, COUNT(*)::int n, COALESCE(SUM(d.price),0) s
       FROM deals d JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")} AND d.manager_id IS NOT NULL GROUP BY 1`, p);
  return r.rows.map((x) => ({ managerId: x.manager_id, deals: Number(x.n), sum: Number(x.s) }));
}

export interface NoDateRow { managerId: number; deals: number; sum: number }
/**
 * ⏳ ОЧІКУВАННЯ БЕЗ ПЛАНОВОЇ ДАТИ ОПЛАТИ — окрема цифра, яка в ЖОДНУ суму не
 * входить. Саме тому вона й потрібна: без неї «чекаємо цей місяць» виглядало б як
 * уся зона, а частина угод не має дати взагалі й не належить жодному місяцю.
 */
export async function expectedNoDateByManager(zone: number[], scope: { managerId?: number | null; teamId?: number | null }): Promise<NoDateRow[]> {
  const p: unknown[] = [FC_PIPELINES, zone];
  const conds = ["d.pipeline_id = ANY($1)", "d.status_id = ANY($2)", "d.planned_payment_at IS NULL"];
  if (scope.managerId) { p.push(scope.managerId); conds.push(`d.manager_id = $${p.length}`); }
  if (scope.teamId) { p.push(scope.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ manager_id: number; n: string; s: string }>(
    `SELECT d.manager_id, COUNT(*)::int n, COALESCE(SUM(d.price),0) s
       FROM deals d JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")} AND d.manager_id IS NOT NULL GROUP BY 1`, p);
  return r.rows.map((x) => ({ managerId: x.manager_id, deals: Number(x.n), sum: Number(x.s) }));
}

export interface InvoicedDayRow { managerId: number; day: string; deals: number; sum: number }
/**
 * 🧾 «ВИСТАВЛЕНО РАХУНКІВ ТОГО ДНЯ» — потік, анкер = ВХІД у стадію виставлення
 * рахунку (`deal_stage_events`), а не знімок. Знімок відповів би на питання
 * «скільки лежить», а колонка питає «скільки зробили того дня» — це різні речі,
 * і плутанина між ними вже коштувала нам місяця мутуючих цифр.
 */
export async function invoicedByManagerDay(from: string, to: string, scope: { managerId?: number | null; teamId?: number | null }): Promise<InvoicedDayRow[]> {
  // ⚠️ Індекси параметрів рахує ДОВЖИНА масиву, а не рука. Перший підхід я написав
  // із `$5`/`$6` уручну — і при вимкненому `managerId` вони поїхали б на чужий
  // параметр. Це той самий клас помилки, що NULL-пастки: код виглядає правильним.
  const p: unknown[] = [FC_PIPELINES, STAGE_INVOICING, from, to];
  const conds = [`(ev.first_at ${K})::date BETWEEN $3 AND $4`];
  if (scope.managerId) { p.push(scope.managerId); conds.push(`d.manager_id = $${p.length}`); }
  if (scope.teamId) { p.push(scope.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ manager_id: number; day: string; n: string; s: string }>(
    `SELECT d.manager_id, to_char((ev.first_at ${K})::date,'YYYY-MM-DD') AS day,
            COUNT(*)::int n, COALESCE(SUM(d.price),0) s
       FROM (SELECT dse.kommo_id, MIN(dse.changed_at) first_at
               FROM deal_stage_events dse
              WHERE dse.pipeline_id = ANY($1) AND dse.status_id = $2
              GROUP BY dse.kommo_id) ev
       JOIN deals d ON d.kommo_id = ev.kommo_id
       JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")}
      GROUP BY 1, 2`, p);
  return r.rows.map((x) => ({ managerId: x.manager_id, day: x.day, deals: Number(x.n), sum: Number(x.s) }));
}

export interface DispatchCohortRow {
  managerId: number; day: string;
  deals: number; sum: number;          // усі авто, відправлені того дня
  paidDeals: number; paidSum: number;  // з них ті, що ВЖЕ оплачені (стан «зараз»)
  awaitDeals: number; awaitSum: number;// з них ті, що ще чекають оплати
  /** Очікування з ПЛАНОВОЮ датою оплати — входить у прогноз. */
  awaitDatedSum: number;
  /** Очікування БЕЗ планової дати — у прогноз НЕ входить, тому названо окремо. */
  awaitNoDateSum: number;
}
/**
 * 🟫 КОГОРТА ДНЯ — АВТО, ВІДПРАВЛЕНІ ТОГО ДНЯ, І ЩО З НИМИ ЗАРАЗ (макет `zvit-4`).
 *
 * 🔴 ЦЕ ДРУГА ДАТА НА ТОМУ САМОМУ ЕКРАНІ, І ЦЕ НАВМИСНО. Авто датовані днем
 * ЗАВАНТАЖЕННЯ (`load_at`), гроші — днем ВХОДУ В ЕТАП. Тому «сума відправлених» і
 * «отримано» за той самий день НЕ мусять збігатися: 01.08 авто поїхали на 2 400 ₴,
 * а надійшло 1 500 ₴; 04.08 навпаки — жодного авто, але 1 000 ₴ прийшло за авто,
 * що поїхало раніше. Без цього підпису дві правильні цифри читаються як поломка —
 * рівно та пастка, через яку ми вже проходили з ① і ②.
 *
 * ⚙️ Стан «оплачено» береться ЗА ПОТОЧНИМ статусом угоди (`STAGE_RECEIVED`), а не
 * за подіями: питання тут не «коли заплатили», а «що з цією машиною ЗАРАЗ».
 * Тому `paid + await == deals` за побудовою — і саме це робить смугу перевірною
 * очима, без нас.
 *
 * 🧮 Тотал звіряється з `metrics.dispatchedByLoadBucket` (той самий анкер `load_at`,
 * ті самі пайплайни, active-only) — тримає гейт `#60c`.
 */
export async function dispatchCohortByManagerDay(
  from: string, to: string, scope: { managerId?: number | null; teamId?: number | null }
): Promise<DispatchCohortRow[]> {
  const p: unknown[] = [from, to, FC_PIPELINES, STAGE_RECEIVED];
  const conds = [`(d.load_at ${K})::date BETWEEN $1 AND $2`, "d.pipeline_id = ANY($3)", "m.is_active"];
  if (scope.managerId) { p.push(scope.managerId); conds.push(`d.manager_id = $${p.length}`); }
  if (scope.teamId) { p.push(scope.teamId); conds.push(`m.team_id = $${p.length}`); }
  const r = await pool.query<{ manager_id: number; day: string; n: string; s: string;
    pn: string; ps: string; an: string; as_: string; ad_: string; an_: string }>(
    `SELECT d.manager_id, to_char((d.load_at ${K})::date,'YYYY-MM-DD') AS day,
            COUNT(*)::int AS n, COALESCE(SUM(d.price),0) AS s,
            COUNT(*) FILTER (WHERE d.status_id = ANY($4))::int AS pn,
            COALESCE(SUM(d.price) FILTER (WHERE d.status_id = ANY($4)),0) AS ps,
            COUNT(*) FILTER (WHERE NOT (d.status_id = ANY($4)))::int AS an,
            COALESCE(SUM(d.price) FILTER (WHERE NOT (d.status_id = ANY($4))),0) AS as_,
            COALESCE(SUM(d.price) FILTER (WHERE NOT (d.status_id = ANY($4)) AND d.planned_payment_at IS NOT NULL),0) AS ad_,
            COALESCE(SUM(d.price) FILTER (WHERE NOT (d.status_id = ANY($4)) AND d.planned_payment_at IS NULL),0) AS an_
       FROM deals d JOIN managers m ON m.id = d.manager_id
      WHERE ${conds.join(" AND ")}
      GROUP BY 1, 2`, p);
  return r.rows.map((x) => ({
    managerId: x.manager_id, day: x.day,
    deals: Number(x.n), sum: Number(x.s),
    paidDeals: Number(x.pn), paidSum: Number(x.ps),
    awaitDeals: Number(x.an), awaitSum: Number(x.as_),
    awaitDatedSum: Number(x.ad_), awaitNoDateSum: Number(x.an_),
  }));
}
