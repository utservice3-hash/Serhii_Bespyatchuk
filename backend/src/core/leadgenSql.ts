/**
 * 🧾 SQL ЛІДОГЕНУ — ЧИСТІ ЗБИРАЧІ ТЕКСТУ, БЕЗ ЖОДНОГО ІМПОРТУ.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ МОДУЛЬ. Ядро (`leadgenStats.ts`) тягне `db/pool.js` → `config.js`, який
 * кидає без `DATABASE_URL` ще НА ІМПОРТІ. Тож гейт, що хоче прогнати ТОЙ САМИЙ запит на
 * тимчасовому кластері (`provisionScratch`), дістати його з ядра не може — і писав би свою
 * копію SQL у тесті. Гейт, що порівнює дві копії, написані поруч, не доводить нічого
 * (урок `#214c`). Тому текст запиту живе тут, ядро його виконує пулом, гейт — клієнтом
 * тимчасової бази, і обидва женуть рівно той самий рядок.
 *
 * ⚠️ Нульовий список імпортів тримає `#407`. Id стадій сюди не імпортуються — їх передає
 * викличник обʼєктом `LEADGEN_STAGE_IDS` із `leadgenStages.ts` (теж без імпортів).
 */

const K = "AT TIME ZONE 'Europe/Kyiv'";

/** Id, з яких складено запит стадій. Форма — `LEADGEN_STAGE_IDS` у `leadgenStages.ts`. */
export interface LeadgenStageIds {
  pz: readonly number[]; taken: number; opr: number; qualified: number;
  react: readonly number[]; warming: number;
}

export interface SqlQuery { text: string; values: unknown[] }

/**
 * 🧲 ЛІД ЛІДГЕНА — угода Продзвону, що увійшла у «Взято в роботу» АБО в «Отримано контакти ОПР».
 *
 * Правило Ярослава (розмова 10.09.2026, підтверджено 30.09 у задачі 4668): «вважається лідом все,
 * що потрапило у взято в роботу і отримала ОПР». Закинута тімлідом угода ще НЕ лід — лише
 * опрацьована. Угоди, які лідген отримує вже з розмовою (реактивація, повернуте менеджером),
 * він ставить одразу на ОПР, минаючи «Взято»; до 30.09 ми рахували лише «Взято» і недораховували
 * їх (Сердюк 21–27.09: 19 замість 63, конверсія «ліди → ОПР» 236 %). Угода, що пройшла обидва
 * етапи в періоді, — один лід (`COUNT DISTINCT`), тож лідів за період завжди ≥ ОПР.
 *
 * ОДИН вираз на всі лічильники лідів — рядки людей і одиниці (тут), тижні й розріз за джерелом
 * (`leadgenStats.ts`). Друга копія розійшлась би мовчки; `#1090b` жене всі три на тимчасовій базі.
 */
export function leadStatusPred(col: string, taken: string, opr: string): string {
  return `${col} IN (${taken}, ${opr})`;
}

/** Чотири лічильники — ОДИН вираз на всі форми запиту. */
const STAGE_COUNTS =
  `COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND ${leadStatusPred("e.status_id", "$4", "$5")}) AS leads,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = $5) AS opr,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = $8) AS quotes,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($6) AND e.status_id = $7) AS warming`;

/** Чотири стадії, що рахуються, — з місцями параметрів, щоб той самий предикат ставав у різні запити. */
function stagePred(p: { pz: string; taken: string; opr: string; qualified: string; react: string; warming: string }): string {
  return `((e.pipeline_id = ANY(${p.pz}) AND e.status_id IN (${p.taken}, ${p.opr}, ${p.qualified}))
          OR (e.pipeline_id = ANY(${p.react}) AND e.status_id = ${p.warming}))`;
}

/** Період за КИЇВСЬКОЮ датою, обидва кінці включно; лише чотири стадії, що рахуються. */
const STAGE_WHERE =
  `(e.changed_at ${K})::date BETWEEN $1 AND $2
        AND ${stagePred({ pz: "$3", taken: "$4", opr: "$5", qualified: "$8", react: "$6", warming: "$7" })}`;

/** Одиниця розбивки: день, тиждень (Пн–Нд) або календарний місяць — усе за КИЇВСЬКИМ календарем. */
export type LeadgenBucketGrain = "day" | "week" | "month";

/**
 * 🗓 КЛЮЧ ОДИНИЦІ — 'YYYY-MM-DD' за КИЇВСЬКИМ календарем: день — сама дата; тиждень —
 * ПОНЕДІЛОК київського тижня (може лежати ДО початку періоду — події все одно лише з
 * періоду); місяць — перше число.
 *
 * 🔴 `AT TIME ZONE` ДО `date_trunc`, не після. Сесія Neon живе в UTC: без переводу вхід о
 * 00:30 понеділка за Києвом (21:30 неділі UTC) ліг би в МИНУЛИЙ тиждень, а 00:30 першого
 * числа — у минулий місяць. Тримає `#676` на тимчасовій базі з UTC-сесією.
 */
export function bucketKeySql(grain: LeadgenBucketGrain, col: string): string {
  const local = `(${col} ${K})`;
  return grain === "day"
    ? `to_char(${local}, 'YYYY-MM-DD')`
    : `to_char(date_trunc('${grain}', ${local}), 'YYYY-MM-DD')`;
}

/**
 * Лічильники стадій по людях за період: ліди (вхід у «Взято в роботу» АБО «ОПР» — `leadStatusPred`), ОПР, прорахунки
 * (вхід у «Кваліфіковано»), підігрів (Реактивація). Атрибуція — ПОТОЧНИЙ `deals.manager_id`,
 * `JOIN managers` внутрішній: угода без менеджера в ростер не потрапляє.
 *
 * `bucket = null` — рядки людей за період (форма `leadgenStats`); інакше — ті самі лічильники
 * по (одиниця, людина). Предикат і лічильники в обох формах — ОДНІ й ті самі рядки тексту,
 * тож місячний кошик тренду не може розійтись із `/leadgen-stats` того місяця (`#676b`).
 * ⚠️ Лічильник — `COUNT(DISTINCT)` У МЕЖАХ ОДИНИЦІ: угода, що заходила в етап у два різні
 * тижні, рахується в кожному з них, а за період — раз. Σ тижнів ≥ періоду, і це правда.
 *
 * Параметри: $1 from · $2 to · $3 воронки Продзвону · $4 «Взято в роботу» · $5 «ОПР» ·
 * $6 воронки Реактивації · $7 «Підігрівається» · $8 «Кваліфіковано».
 */
export function stageCountsQuery(
  from: string, to: string, ids: LeadgenStageIds, bucket: LeadgenBucketGrain | null = null,
): SqlQuery {
  const values = [from, to, ids.pz, ids.taken, ids.opr, ids.react, ids.warming, ids.qualified];
  if (bucket) {
    return {
      text: `SELECT ${bucketKeySql(bucket, "e.changed_at")} AS bucket, m.id AS manager_id, m.team_id,
            ${STAGE_COUNTS}
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
       JOIN managers m ON m.id = d.manager_id
      WHERE ${STAGE_WHERE}
      GROUP BY 1, 2, 3
      ORDER BY 1, 2`,
      values,
    };
  }
  return {
    text: `SELECT m.id AS manager_id, m.name, m.team_id, t.name AS team_name, m.is_active,
            ${STAGE_COUNTS}
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
       JOIN managers m ON m.id = d.manager_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE ${STAGE_WHERE}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY leads DESC, opr DESC, m.name`,
    values,
  };
}

/** Id для запиту передач: воронки Продзвону, «Кваліфіковано» і воронки угод менеджера. */
export interface HandoffLinkIds { pz: readonly number[]; qualified: number; managerPipelines: readonly number[] }

/**
 * 🔗 ПЕРЕДАЧІ ПЕРІОДУ Й УГОДА МЕНЕДЖЕРА ДЛЯ КОЖНОГО ВХОДУ (правила 1–2 власника).
 *
 * 🔗 УГОДА МЕНЕДЖЕРА — ДВА ШЛЯХИ, У ПОРЯДКУ ДОВІРИ (30.09.2026):
 *   0) примітка Kommo `lead_auto_created` (`lead_child_links`): CRM сама записала, що цю угоду створено
 *      з цієї угоди Продзвону. Точний звʼязок, не залежить від заповненості клієнта;
 *   1) здогад, як до 30.09: той самий НЕпорожній `client_key` — лише коли примітки немає.
 * Обидва — у тому самому вікні −`beforeSec`…+`afterSec` від входу: примітка звʼязує угоди, а вікно
 * вирішує, ЯКИЙ вхід у 142 цю угоду породив (угода Продзвону буває кваліфікована кілька разів).
 * `link_prio` — яким шляхом знайдено (0 — примітка, 1 — здогад), для перевірки й розбору.
 *
 * Вхід = подія 142 угоди Продзвону в київську дату періоду; предикат і `JOIN managers` —
 * ТІ САМІ, що в «Прорахунків» (`stageCountsQuery`, лічильник `quotes`), тож передачі людини
 * дорівнюють її прорахункам ЗАВЖДИ (`#675b`). Угода менеджера — НАЙРАНІША угода того самого
 * НЕпорожнього `client_key` у воронках Кваліфікації або повного циклу, створена від
 * −`beforeSec` до +`afterSec` секунд від входу. Автоугоди НЕ ховаються (правило 5).
 * Грошей тут немає: бюджет і клас угоди читає лише `money.ts`.
 *
 * Параметри: $1 from · $2 to · $3 воронки Продзвону · $4 «Кваліфіковано» · $5 воронки угод менеджера.
 */
export function handoffLinkQuery(
  from: string, to: string, ids: HandoffLinkIds, win: { beforeSec: number; afterSec: number },
): SqlQuery {
  const before = Math.trunc(win.beforeSec), after = Math.trunc(win.afterSec);
  return {
    text: `SELECT e.kommo_id AS pz_id, d.manager_id AS lg_id, m.team_id AS lg_team_id,
            e.changed_at AS at, to_char((e.changed_at ${K}), 'YYYY-MM-DD') AS day,
            d.name AS pz_name, d.client_name AS pz_client, COALESCE(x.client_key, d.client_key) AS client_key,
            x.prio AS link_prio,
            x.kommo_id AS deal_id, x.name AS deal_name, x.client_name AS deal_client,
            sm.name AS sales_manager, x.reject_reason AS deal_reason,
            to_char((x.closed_at_kommo ${K}), 'YYYY-MM-DD') AS closed_day,
            to_char((x.planned_payment_at ${K}), 'YYYY-MM-DD') AS plan_pay_day
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
       JOIN managers m ON m.id = d.manager_id
       LEFT JOIN LATERAL (
         SELECT z.* FROM (
           SELECT 0 AS prio, q.kommo_id, q.name, q.client_name, q.client_key, q.manager_id, q.reject_reason,
                  q.closed_at_kommo, q.planned_payment_at, q.created_at_kommo
             FROM lead_child_links l
             JOIN deals q ON q.kommo_id = l.child_id
            WHERE l.parent_id = d.kommo_id
              AND q.pipeline_id = ANY($5)
              AND q.created_at_kommo BETWEEN e.changed_at - INTERVAL '${before} seconds'
                                         AND e.changed_at + INTERVAL '${after} seconds'
           UNION ALL
           SELECT 1 AS prio, q.kommo_id, q.name, q.client_name, q.client_key, q.manager_id, q.reject_reason,
                  q.closed_at_kommo, q.planned_payment_at, q.created_at_kommo
             FROM deals q
            WHERE d.client_key IS NOT NULL AND q.client_key = d.client_key
              AND q.pipeline_id = ANY($5)
              AND q.created_at_kommo BETWEEN e.changed_at - INTERVAL '${before} seconds'
                                         AND e.changed_at + INTERVAL '${after} seconds'
         ) z
          ORDER BY z.prio, z.created_at_kommo, z.kommo_id
          LIMIT 1) x ON TRUE
       LEFT JOIN managers sm ON sm.id = x.manager_id
      WHERE e.pipeline_id = ANY($3) AND e.status_id = $4
        AND (e.changed_at ${K})::date BETWEEN $1 AND $2
      ORDER BY e.changed_at, e.kommo_id`,
    values: [from, to, ids.pz, ids.qualified, ids.managerPipelines],
  };
}

/**
 * 📜 ГЛИБИНА ПАМʼЯТІ ПОДІЙ: найраніша київська дата, коли журнал подій бачив будь-яку з
 * чотирьох стадій (♾ правило 17 — «знімок не має історії»: спершу спитай, чи база памʼятає
 * той день). Місяць тренду, що цілком лежить РАНІШЕ, — не «нуль», а «даних немає», і
 * відповідь його не звітує. Предикат — ТОЙ САМИЙ `stagePred`, що в лічильниках.
 */
export function firstStageEventQuery(ids: LeadgenStageIds): SqlQuery {
  return {
    text: `SELECT to_char(MIN(e.changed_at ${K}), 'YYYY-MM-DD') AS day
       FROM deal_stage_events e
      WHERE ${stagePred({ pz: "$1", taken: "$2", opr: "$3", qualified: "$6", react: "$4", warming: "$5" })}`,
    values: [ids.pz, ids.taken, ids.opr, ids.react, ids.warming, ids.qualified],
  };
}
