import { PRODZVIN_PIPELINES, PZ_TAKEN, PZ_OPR, REACTIVATION_PIPELINES, REACT_WARMING } from "./metrics.js";
import { kommoLeadUrl } from "./kommoLinks.js";

/**
 * 🔴 ЛІНИВИЙ ПУЛ — НЕ ОХАЙНІСТЬ, А УМОВА ВИКОНУВАНОСТІ ГЕЙТІВ.
 * Верхній `import { pool }` тягне `config.js`, який кидає на відсутньому `DATABASE_URL`
 * ще НА ЗАВАНТАЖЕННІ МОДУЛЯ — тобто раніше за будь-яке твердження. Через це `#364`…`#365b`,
 * яким база не потрібна взагалі (константи й текст джерела), гинули цілим файлом у
 * worktree без `.env` — саме там, де крок `test` знімає базу для порівняння.
 * 📐 Заміряно 08.09.2026: «база: падінь 1, виконано 660 / дерево: падінь 0, виконано 668»,
 * причина — `Missing required env var: DATABASE_URL` при імпорті. Той самий патерн уже
 * стоїть у `publishReleaseNews.ts`, `reactivationPack.ts`, `clientAdminLog.ts`.
 */
const db = async () => (await import("../db/pool.js")).pool;

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
export const LEADGEN_CALL_MIN_SEC = 20;

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
 * Ростер визначається ПОДІЯМИ, а не списком команди. Причина заміряна: у серпні
 * лідгенівські дії робила ще й Ковтонюк Тетяна, яка числиться в команді РНК, а
 * Єресько зі списку ТЗ деактивований. Список protікає, події — ні.
 */
export async function leadgenStats(from: string, to: string): Promise<LeadgenStats> {
  const stages = await (await db()).query<{
    manager_id: number; name: string; team_id: number | null; team_name: string | null;
    is_active: boolean; leads: string; opr: string; quotes: string; warming: string;
  }>(
    `SELECT m.id AS manager_id, m.name, m.team_id, t.name AS team_name, m.is_active,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = $4) AS leads,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = $5) AS opr,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($3) AND e.status_id = 142) AS quotes,
            COUNT(DISTINCT e.kommo_id) FILTER (WHERE e.pipeline_id = ANY($6) AND e.status_id = $7) AS warming
       FROM deal_stage_events e
       JOIN deals d ON d.kommo_id = e.kommo_id
       JOIN managers m ON m.id = d.manager_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE (e.changed_at ${K})::date BETWEEN $1 AND $2
        AND ((e.pipeline_id = ANY($3) AND e.status_id IN ($4, $5, 142))
          OR (e.pipeline_id = ANY($6) AND e.status_id = $7))
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY leads DESC, opr DESC, m.name`,
    [from, to, PRODZVIN_PIPELINES, PZ_TAKEN, PZ_OPR, REACTIVATION_PIPELINES, REACT_WARMING]
  );

  const ids = stages.rows.map((r) => r.manager_id);
  const callsByMgr = new Map<number, number>();
  if (ids.length) {
    const calls = await (await db()).query<{ manager_id: number; n: string }>(
      `SELECT c.manager_id, COUNT(*) AS n
         FROM ringostat_calls c
        WHERE c.manager_id = ANY($1)
          AND (c.calldate ${K})::date BETWEEN $2 AND $3
          AND c.call_type = 'out' AND c.billsec >= $4
        GROUP BY 1`,
      [ids, from, to, LEADGEN_CALL_MIN_SEC]
    );
    for (const c of calls.rows) callsByMgr.set(c.manager_id, Number(c.n));
  }

  /**
   * Розріз за джерелом клієнта — Холодна база проти Реактивації, як просить ТЗ.
   * ⚠️ Порожнє джерело НЕ ховаємо: у серпні таких 17. Невідоме має читатись як невідоме.
   */
  const src = await (await db()).query<{ source: string; leads: string }>(
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
export const LEADGEN_CONVERSION_TARGETS = { oprOfLeads: 40, quotesOfOpr: 50, machinesOfQuotes: 10 } as const;

/** Конверсія у відсотках; `null`, коли знаменник нульовий — «—» на екрані, а не «0 %». */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

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
  const r = await (await db()).query<{ reason: string; n: string }>(
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
  const r = await (await db()).query<{ kommo_id: string; day: string; name: string | null; manager: string | null }>(
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
  const r = await (await db()).query<{ n: string }>(
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
  const r = await (await db()).query<{ week: string; leads: string; opr: string; quotes: string }>(
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
