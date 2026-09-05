/**
 * 🔁 ЯДРО РЕАКТИВАЦІЇ — стани клієнтів і результат повернення.
 *
 * 🔴 СТАН — ПОХІДНА ВІД ДАТ, А НЕ ЗБЕРЕЖЕНЕ ПОЛЕ. Постійний → сплячий (60 дн.) →
 * втрачений (180 дн.) → повернений. Жодного тумблера «зробити сплячим» немає й не
 * буде: збережений стан треба комусь оновлювати, а джоба, що тихо не відпрацювала,
 * лишила б «сплячим» клієнта, який учора замовив. Ми це вже проходили зі знімками
 * у грошах — вони мутували минулі місяці.
 *
 * Руками ставиться РІВНО ОДНЕ — позначка «сезонний»: з дат її вивести неможливо
 * (зерно, опалення, ремонти), тож це рішення людини.
 */
import { pool } from "../db/pool.js";
import { GENERIC_CLIENT_KEYS } from "./metrics.js";
import { normalizeClientName } from "../utils/clientName.js";
import { RETURNED_CLOSE_REASON } from "./reactivationRules.js";

export * from "./reactivationRules.js";
import { SLEEPING_DAYS, LOST_DAYS, valueScore, type ClientState,
         type ClientSegment } from "./reactivationRules.js";
import { loadClientSegments, factsFor, inReactivationTab, inClientsScreen } from "./clientSegments.js";
import { archivedSql, LAST_PAID_CTE, LAST_PAID_JOIN } from "./clientArchive.js";
import { lastOrderCte, daysSinceOrderSql, PAID_DEAL_JOIN, PAID_DEAL_WHERE } from "./clientOrder.js";
export type { ClientState, ClientSegment };
void SLEEPING_DAYS; void LOST_DAYS;

export interface ReactivationScope { managerId?: number; teamId?: number }

export interface TaskRef {
  clientKey: string; id: number; status: string; deadline: string | null;
  closeReason: string | null; createdAt: Date; assignee: string | null;
}

/**
 * Найсвіжіша реактиваційна задача ПО КЛІЄНТУ — ОДНИМ запитом, по `client_key`.
 *
 * 🔴 ДРУГОЇ ГІЛКИ БІЛЬШЕ НЕМАЄ, І ОСЬ ДЕ ТОЙ ФОРМАТ ТЕПЕР. Тут читалися ще й старі
 * ПАЧКИ, де клієнти лежали всередині `checklist_json`, — саме тому читання було
 * роздвоєним. 05.09.2026 усі **37 пачок (347 клієнтів)** перенесено в рядки-діти
 * (`tools/backfillPackChildren.ts`), заміряно після перенесення: неперенесених пачок
 * НУЛЬ, напівперенесених НУЛЬ, жоден клієнт із чеклістів не зник із читання.
 *
 * ⚠️ ЧОМУ ЦЕ НЕ ПРОСТО ВИДАЛЕННЯ. Прибрана гілка була єдиним способом побачити клієнта
 * всередині пачки; якби формат повернувся, його клієнти зникали б із карток МОВЧКИ.
 * Тому разом із нею стоїть парне твердження — гейт `#347`, який стежить, що пачок без
 * рядків-дітей у базі не існує. Прибирати перевірку на відсутність без такого
 * твердження — це винагороджувати зникнення (правило 8).
 *
 * 🔴 ПАЧКИ ВРАХОВУЮТЬСЯ ЗА ЗАМІРОМ, НЕ ЗА ПРИПУЩЕННЯМ. Схема обіцяла `clientKey`
 * у чеклісті, але обіцянка схеми — це намір, а не дані. Замір (03.08.2026):
 * 12 задач, 94 елементи, `clientKey` заповнений у 94/94; напряму зіставились 78,
 * решта 16 — старі ключі з ПРОБІЛАМИ (писались до бекфілу нормалізації).
 *
 * 🔴 Нормалізація — ТІЄЮ САМОЮ функцією, що нею користується синк
 * (`normalizeClientName`), а не схожим регекспом у SQL. Регексп «прибрати
 * пробіли» теж відновлював усі 16 — але через півроку він розійшовся б із
 * правилами синку, і ми б цього не помітили. Перевірено ще й на ідемпотентність:
 * на 500 живих ключах функція не змінила ЖОДНОГО.
 */
export async function reactivationTasksByClient(): Promise<Map<string, TaskRef>> {
  const direct = (await pool.query<{ client_key: string; id: number; status: string;
    deadline: string | null; close_reason: string | null; created_at: Date; assignee: string | null }>(
    `SELECT t.client_key, t.id, t.status, to_char(t.deadline,'YYYY-MM-DD') AS deadline,
            t.close_reason, t.created_at, mgr.name AS assignee
       FROM tasks t LEFT JOIN managers mgr ON mgr.id = t.assignee_id
      WHERE t.task_type = 'reactivation_client' AND t.client_key IS NOT NULL`)).rows;

  const out = new Map<string, TaskRef>();
  const put = (key: string | null, t: Omit<TaskRef, "clientKey">) => {
    if (!key) return;
    const prev = out.get(key);
    if (!prev || prev.createdAt < t.createdAt) out.set(key, { clientKey: key, ...t });
  };
  for (const d of direct) {
    put(normalizeClientName(d.client_key) ?? d.client_key,
      { id: d.id, status: d.status, deadline: d.deadline, closeReason: d.close_reason,
        createdAt: d.created_at, assignee: d.assignee });
  }
  return out;
}



export interface ReactivationClient {
  clientKey: string;
  clientName: string;
  managerId: number;
  managerName: string;
  /** Команда ВІДПОВІДАЛЬНОГО менеджера (того самого COALESCE), не «команда клієнта». */
  teamId: number | null;
  teamName: string | null;
  /**
   * Менеджер закріплений вручну (`loyalty_overrides.pinned_manager_id`), а не
   * виведений з оплат. Формула та сама, що в передачі відповідального —
   * COALESCE(закріплений, основний); прапорець лише робить видимим, ЯКА з двох
   * гілок спрацювала, щоб «менеджер біля клієнта» не читався як здогад екрана.
   */
  pinned: boolean;
  orders: number;
  lifetimeRevenue: number;
  lastPaid: string | null;
  daysSince: number;
  /**
   * 🔴 ДРУГА ДАТА — ДОВІДКА, А НЕ ДЖЕРЕЛО СТАНУ. Стан рахується ВИКЛЮЧНО від
   * оплати (`daysSince`): «розмовляли вчора» не робить клієнта активним, він так
   * само не платить. Але без цієї дати екран не пояснював, ЧОМУ клієнт із живим
   * контактом стоїть у сплячих, — і читався як поломка.
   *
   * 🟢 КОНТАКТ = РОЗМОВА (`billsec > 0`), рішення власника 04.08.2026. Було: будь-який
   * дзвінок, включно з недодзвоном. Це два РІЗНІ факти, і змішувати їх не можна:
   * «набирав тричі й не додзвонився» — це робота менеджера, а не контакт із
   * клієнтом. Показавши їх однаково, ми б звітували про контакт, якого не було.
   *
   * `null` = розмов не знайдено. Чесна відповідь, а не порожнє місце: звʼязка
   * дзвінок→клієнт іде через телефон контакту Kommo і покриває не всіх.
   */
  lastTalk: string | null;
  lastTalkDays: number | null;
  /** `in` — клієнт дзвонив нам, `out` — ми йому. */
  lastTalkDirection: "in" | "out" | null;
  /**
   * СПРОБИ — окремо від контакту: дзвінки без відповіді ПІСЛЯ останньої розмови
   * (а якщо розмови не було жодної — усі). Саме цим видно, що менеджер працює,
   * хоча контакту ще немає. Складати зі `lastTalk` в одну цифру ЗАБОРОНЕНО —
   * це відповідь на інше питання.
   */
  attempts: number;
  lastAttempt: string | null;
  lastAttemptDays: number | null;
  /** Сегмент за частотою; `unknown` = менше 3 оплат, сегмент НЕ вгадуємо. */
  segment: ClientSegment;
  /** Медіанний інтервал між оплатами, дні. `null` — інтервалів замало. */
  medianGapDays: number | null;
  /** Втрачений понад рік — у згорнутий блок «Давно втрачені», а не на головну
   *  сцену. НЕ плутати з реєстром архіву (вкладка «Архів»): там ручна дія з
   *  причиною й автором, тут — просто вік без оплат. */
  longLapsed: boolean;
  /** ⭐ Включений КВП вручну попри правило + примітка «чому». */
  forcedRegular: boolean;
  forceNote: string | null;
  /**
   * 💬 Останній коментар клієнта — заповнює РОУТ (`latestCommentByClient`), бо
   * ядро станів про коментарі не знає й знати не повинно. Поле оголошене тут, а
   * не приліплене спредом у відповіді: спред у видачі заборонений воротами
   * `#17e2` — саме щоб нова колонка БД не поїхала назовні непоміченою.
   */
  lastComment?: { body: string; author: string | null; createdAt: string } | null;
  state: ClientState;
  value: number;
  seasonal: boolean;
  seasonalNote: string | null;
  /** Активна задача реактивації по цьому клієнту, якщо є. */
  taskId: number | null;
  taskStatus: string | null;
  taskAssignee: string | null;
  taskDeadline: string | null;
  closeReason: string | null;
  /** Замовив ПІСЛЯ створення реактиваційної задачі — «повернений». */
  returned: boolean;
  returnedRevenue: number;
}

const KYIV = "AT TIME ZONE 'Europe/Kyiv'";

/**
 * Клієнти з їхнім станом. Беремо ВСІХ, у кого 2+ оплат lifetime (та сама межа
 * «постійного», що на екрані планів — інакше два екрани рахували б різних людей).
 */
/**
 * `includeActive` — той самий добір, але БЕЗ відсіву активних. Потрібен злитому
 * екрану клієнтів (05.09.2026): він показує один список, де стан став колонкою, а
 * не вкладкою. Дефолт лишає стару поведінку, тож `/reactivation-list` і шість
 * гейтів, що кличуть цю функцію напряму, не зрушили ні на рядок.
 */
export async function clientStates(
  s: ReactivationScope,
  opts: { includeActive?: boolean } = {}
): Promise<ReactivationClient[]> {
  const taskMap = await reactivationTasksByClient();
  const taskKeys = [...taskMap.keys()];
  const taskDates = taskKeys.map((k) => taskMap.get(k)!.createdAt);
  const p: unknown[] = [GENERIC_CLIENT_KEYS];
  let cond = "";
  if (s.managerId != null) { p.push(s.managerId); cond = `AND mm.id = $${p.length}`; }
  else if (s.teamId != null) { p.push(s.teamId); cond = `AND mm.team_id = $${p.length}`; }
  p.push(taskKeys); const TK = `$${p.length}`;
  p.push(taskDates); const TC = `$${p.length}`;

  const rows = (await pool.query<{
    client_key: string; client_name: string | null; orders: string; revenue: string;
    last_paid: string | null; days_since: string; manager_id: number; manager_name: string;
    team_id: number | null; team_name: string | null;
    pinned_manager_id: number | null; seasonal: boolean | null; seasonal_note: string | null;
    revenue_after_task: string | null;
    last_talk: string | null; last_talk_days: string | null; last_talk_type: string | null;
    attempts: string | null; last_attempt: string | null; last_attempt_days: string | null;
  }>(
    `WITH ${LAST_PAID_CTE},
     paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d ${PAID_DEAL_JOIN}
        WHERE ${PAID_DEAL_WHERE}
          AND NOT (d.client_key = ANY($1))
     ),
     ${lastOrderCte("agg_raw", { extraWhere: "AND NOT (d.client_key = ANY($1))", having: "HAVING COUNT(*) >= 2" })},
     agg AS (SELECT client_key, orders, revenue, last_order_at AS last_paid FROM agg_raw),
     per_cm AS (SELECT client_key, manager_id, COUNT(*) AS n, MAX(closed_at_kommo) AS mx FROM paid GROUP BY 1,2),
     primary_mgr AS (SELECT DISTINCT ON (client_key) client_key, manager_id FROM per_cm ORDER BY client_key, n DESC, mx DESC),
     tasks_in AS (
       SELECT * FROM (SELECT UNNEST(${TK}::text[]) AS client_key, UNNEST(${TC}::timestamptz[]) AS created_at) t
     )
     SELECT a.client_key, nm.client_name, a.orders, a.revenue,
            to_char(a.last_paid ${KYIV}, 'YYYY-MM-DD') AS last_paid,
            GREATEST(0, ${daysSinceOrderSql("a.last_paid")})::int AS days_since,
            COALESCE(lo.pinned_manager_id, pm.manager_id) AS manager_id, mm.name AS manager_name,
            mm.team_id, tm.name AS team_name,
            lo.pinned_manager_id, lo.seasonal, lo.seasonal_note,
            (SELECT COALESCE(SUM(p2.price),0) FROM paid p2
              WHERE p2.client_key = a.client_key AND tk.created_at IS NOT NULL
                AND p2.closed_at_kommo > tk.created_at) AS revenue_after_task,
            to_char(lt.calldate ${KYIV}, 'YYYY-MM-DD') AS last_talk,
            (CURRENT_DATE - (lt.calldate ${KYIV})::date)::int AS last_talk_days,
            lt.call_type AS last_talk_type,
            at.n AS attempts,
            to_char(at.last_at ${KYIV}, 'YYYY-MM-DD') AS last_attempt,
            (CURRENT_DATE - (at.last_at ${KYIV})::date)::int AS last_attempt_days
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
       LEFT JOIN teams tm ON tm.id = mm.team_id
       LEFT JOIN tasks_in tk ON tk.client_key = a.client_key
       LEFT JOIN LATERAL (
         SELECT d2.client_name FROM deals d2
          WHERE d2.client_key = a.client_key AND d2.client_name IS NOT NULL
          ORDER BY d2.closed_at_kommo DESC NULLS LAST LIMIT 1
       ) nm ON true
       -- 🟢 КОНТАКТ = РОЗМОВА (billsec > 0), рішення власника 04.08.2026.
       -- Індекс idx_rc_client_key (client_key, calldate DESC) робить це одним
       -- читанням на клієнта. LEFT JOIN — бо «розмов немає» це РЕЗУЛЬТАТ, а не
       -- привід викинути клієнта зі списку реактивації.
       LEFT JOIN LATERAL (
         SELECT rc.calldate, rc.call_type FROM ringostat_calls rc
          WHERE rc.client_key = a.client_key AND rc.billsec > 0
          ORDER BY rc.calldate DESC LIMIT 1
       ) lt ON true
       -- СПРОБИ — недодзвони ПІСЛЯ останньої розмови (без розмови — всі).
       -- Окремим підзапитом, бо це відповідь на ІНШЕ питання: не «чи є контакт»,
       -- а «чи його добиваються». Складати з розмовою в одну цифру заборонено.
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n, MAX(rc.calldate) AS last_at FROM ringostat_calls rc
          WHERE rc.client_key = a.client_key AND rc.billsec = 0
            AND (lt.calldate IS NULL OR rc.calldate > lt.calldate)
       ) at ON true
      -- 🗄 АРХІВ ЗАМІСТЬ hidden (рішення власника 05.08.2026). Два способи прибрати
      -- клієнта з екрана — це два визначення, які через півроку розійдуться, і ніхто
      -- не памʼятатиме, яке з них дивиться на екран. Тому hidden тут більше НЕ
      -- згадується. Повернення автоматичне: оплата ПІЗНІШЕ за дату архівації сама
      -- виводить клієнта назад, без джоби й без тумблера (гейт #38).
      WHERE NOT ${archivedSql("lo", "ap")} ${cond}`, p)).rows;

  // 🔴 Сегмент/стан — зі СПІЛЬНОГО джерела (`clientSegments.ts`), тим самим, що
  // живить екран планування. Окремим запитом, а не CTE всередині цього: підстановка
  // фрагмента сюди коштувала 10.5 с замість 0.7 с (замір 05.08.2026, деталі у
  // шапці `clientSegments.ts`).
  const seg = await loadClientSegments();

  // 🎯 РАЗОВІ СЮДИ НЕ ПОТРАПЛЯЮТЬ (двошляхова кваліфікація, рішення власника
  // 05.08.2026): реактивувати того, хто ніколи не був постійним, нема сенсу —
  // це не повернення клієнта, а холодний дзвінок. Скільки їх — каже екран планів
  // (`totals.oneOff`), щоб число не зникло мовчки.
  const belongs = opts.includeActive ? inClientsScreen : inReactivationTab;
  return rows.filter((r) => belongs(factsFor(seg, r.client_key))).map((r) => {
    const tk = taskMap.get(r.client_key);
    const f = factsFor(seg, r.client_key);
    const days = Number(r.days_since);
    const revenue = Number(r.revenue);
    const returnedRevenue = Number(r.revenue_after_task ?? 0);
    return {
      clientKey: r.client_key,
      clientName: r.client_name ?? r.client_key,
      managerId: r.manager_id,
      managerName: r.manager_name,
      teamId: r.team_id ?? null,
      teamName: r.team_name ?? null,
      pinned: r.pinned_manager_id != null,
      orders: Number(r.orders),
      lifetimeRevenue: revenue,
      lastPaid: r.last_paid,
      daysSince: days,
      lastTalk: r.last_talk,
      lastTalkDays: r.last_talk_days == null ? null : Number(r.last_talk_days),
      lastTalkDirection: r.last_talk_type == null ? null
        : (r.last_talk_type === "out" || r.last_talk_type === "transitout" ? "out" : "in"),
      attempts: Number(r.attempts ?? 0),
      lastAttempt: r.last_attempt,
      lastAttemptDays: r.last_attempt_days == null ? null : Number(r.last_attempt_days),
      segment: f.segment,
      medianGapDays: f.medianGapDays,
      longLapsed: f.longLapsed,
      forcedRegular: f.forcedRegular,
      forceNote: f.forceNote,
      // 🔴 СТАН — ВІД ОПЛАТИ І ВІД СЕГМЕНТА. Дзвінки сюди не входять НАВМИСНО:
      // «дзвонили вчора» не означає «замовив». Рахує чиста функція `stateOf`
      // (єдина реалізація правила), не другий CASE у SQL — тримає #25f.
      state: f.state,
      value: valueScore(revenue, days),
      seasonal: r.seasonal ?? false,
      seasonalNote: r.seasonal_note,
      taskId: tk?.id ?? null,
      taskStatus: tk?.status ?? null,
      taskAssignee: tk?.assignee ?? null,
      taskDeadline: tk?.deadline ?? null,
      closeReason: tk?.closeReason ?? null,
      returned: returnedRevenue > 0,
      returnedRevenue,
    };
  });
}

export interface ReturnedAgg { clients: number; revenue: number }
/**
 * ПЛИТКА «Повернено за N днів». Метрика РЕЗУЛЬТАТУ, тому визначення жорстке:
 * клієнт, у якого була реактиваційна задача, і ПІСЛЯ дати її створення зʼявилась
 * оплата. Не «замовив у періоді» — інакше сюди потрапили б ті, хто й не йшов.
 */
export async function returnedAfterTask(days: number, s: ReactivationScope): Promise<ReturnedAgg> {
  const taskMap = await reactivationTasksByClient();
  const p: unknown[] = [GENERIC_CLIENT_KEYS, days];
  let cond = "";
  if (s.managerId != null) { p.push(s.managerId); cond = `AND mm.id = $${p.length}`; }
  else if (s.teamId != null) { p.push(s.teamId); cond = `AND mm.team_id = $${p.length}`; }
  const keys = [...taskMap.keys()];
  p.push(keys); const TK = `$${p.length}`;
  p.push(keys.map((k) => taskMap.get(k)!.createdAt)); const TC = `$${p.length}`;
  const r = (await pool.query<{ clients: string; revenue: string }>(
    `WITH paid AS (
       SELECT d.client_key, d.manager_id, d.price, d.closed_at_kommo
         FROM deals d
         JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
        WHERE psm.funnel_stage = 'paid' AND d.client_key IS NOT NULL AND NOT (d.client_key = ANY($1))
     ),
     task AS (
       SELECT * FROM (SELECT UNNEST(${TK}::text[]) AS client_key, UNNEST(${TC}::timestamptz[]) AS created_at) t
     )
     SELECT COUNT(DISTINCT p2.client_key) AS clients, COALESCE(SUM(p2.price),0) AS revenue
       FROM paid p2
       JOIN task tk ON tk.client_key = p2.client_key
       JOIN managers mm ON mm.id = p2.manager_id
      WHERE p2.closed_at_kommo > tk.created_at
        AND (p2.closed_at_kommo ${KYIV})::date >= CURRENT_DATE - ($2::int || ' days')::interval
        ${cond}`, p)).rows[0];
  return { clients: Number(r?.clients ?? 0), revenue: Number(r?.revenue ?? 0) };
}

/**
 * 🔁 АВТОЗАКРИТТЯ ЗАДАЧІ, КОЛИ КЛІЄНТ ПОВЕРНУВСЯ (рішення власника 04.09.2026:
 * «закрити, але щоб було видно, що вона була закрита»).
 *
 * 🔴 ПРИЧИНА НАВМИСНО ПОЗА ДОВІДНИКОМ `CLOSE_REASONS`. Людина обирає причину зі
 * списку — і «повернувся» там бути не сміє: це не пояснення, ЧОМУ клієнт не
 * повернувся, а протилежний факт. Якби ключ лежав у довіднику, менеджер міг би
 * закрити ним живу задачу руками, і ми втратили б різницю між «система побачила
 * оплату» і «людина натиснула кнопку». Тримає `#334`.
 *
 * ⚠️ Задача закривається лише тоді, коли оплата ПІЗНІША за її створення. Оплата
 * до створення нічого не доводить: саме тому задачу й ставили.
 */
/* Значення переїхало в чистий модуль правил (доккоментар там). Реекспорт уже дає
   `export * from "./reactivationRules.js"` вище, тож жоден наявний читач не змінився. */

export async function closeTasksForReturnedClients(): Promise<number> {
  const r = await pool.query(
    `UPDATE tasks t SET status = 'done', close_reason = $1, closed_at = now(), updated_at = now()
      WHERE t.task_type = 'reactivation_client' AND t.status <> 'done' AND t.client_key IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM deals d
            JOIN pipeline_stage_map psm ON psm.pipeline_id = d.pipeline_id AND psm.status_id = d.status_id
           WHERE d.client_key = t.client_key AND psm.funnel_stage = 'paid'
             AND d.closed_at_kommo IS NOT NULL AND d.closed_at_kommo > t.created_at)`,
    [RETURNED_CLOSE_REASON]);
  return r.rowCount ?? 0;
}
