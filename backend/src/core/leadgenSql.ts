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

/** Чотири лічильники — ОДИН вираз на всі форми запиту. */
const STAGE_COUNTS =
  `COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = $4) AS leads,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = $5) AS opr,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = $8) AS quotes,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($6) AND e.status_id = $7) AS warming`;

/** Період за КИЇВСЬКОЮ датою, обидва кінці включно; лише чотири стадії, що рахуються. */
const STAGE_WHERE =
  `(e.changed_at ${K})::date BETWEEN $1 AND $2
        AND ((e.pipeline_id = ANY($3) AND e.status_id IN ($4, $5, $8))
          OR (e.pipeline_id = ANY($6) AND e.status_id = $7))`;

/**
 * Лічильники стадій по людях за період: ліди (вхід у «Взято в роботу»), ОПР, прорахунки
 * (вхід у «Кваліфіковано»), підігрів (Реактивація). Атрибуція — ПОТОЧНИЙ `deals.manager_id`,
 * `JOIN managers` внутрішній: угода без менеджера в ростер не потрапляє.
 *
 * Параметри: $1 from · $2 to · $3 воронки Продзвону · $4 «Взято в роботу» · $5 «ОПР» ·
 * $6 воронки Реактивації · $7 «Підігрівається» · $8 «Кваліфіковано».
 */
export function stageCountsQuery(from: string, to: string, ids: LeadgenStageIds): SqlQuery {
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
    values: [from, to, ids.pz, ids.taken, ids.opr, ids.react, ids.warming, ids.qualified],
  };
}
