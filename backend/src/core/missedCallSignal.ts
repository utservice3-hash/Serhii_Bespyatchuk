import { CALL_MERGE_WINDOW, mergedLagGapExpr, mergedLagFirst } from "./callMerge.js";
import { INBOUND_TYPES, OUTBOUND_TYPES, missedDispSql, CALLBACK_MIN_TALK_SEC } from "./missedCallsRules.js";
import { dayBucketCase, dayBucketParts, type DayBucket } from "./dayBuckets.js";
import { carrierHistorySql, carrierTaskCloseReason } from "./carrierHistory.js";

/**
 * 📵 СИГНАЛ МЕНЕДЖЕРУ ПО ПРОПУЩЕНОМУ — ТЗ-1, прохід 3 (16.09.2026).
 *
 * Рішення власника (16.09.2026), не перевідкривати:
 *  · канал — ЗАДАЧА менеджеру, як у сусідніх джоб (`receivableDeadlineTasks`, `dutyReminders`);
 *  · поріг — 5 хв, як у листі, ЦІЛОДОБОВО (не лише робочий час);
 *  · «нічиї» (без `manager_id`, ~50%) — сигналу немає;
 *  · ОДНА задача на номер за день: менеджер + номер + київська дата; у тексті — скільки разів;
 *  · задача ЗАКРИВАЄТЬСЯ САМА, щойно на номер піде вихідний (від будь-кого) з РОЗМОВОЮ ВІД 10 С —
 *    уточнено ТЗ Юлії 17.09.2026 (задача 4373, рішення Романа 02.10.2026): вихідний без зʼєднання
 *    або коротший за 10 с — це спроба, а не передзвін; задачу він не закриває і сигнал не гасить;
 *  · клієнт, що передзвонив сам і з ним поговорили, задачу НЕ гасить — гасить лише
 *    вихідний, буквально як у ТЗ;
 *  · у тексті задачі — ПОВНИЙ номер.
 *
 * 🔴 МОДУЛЬ БЕЗ `pool`. Базу дає той, хто кличе (`Db`), тож поведінку джоби гейт `#457`
 * проганяє на порожньому кластері з керованим «зараз», а не читає з файла.
 *
 * 🔴 ПРОПУЩЕНИЙ — ТОЙ САМИЙ, ЩО НА ЕКРАНІ. Склейка плечей (`mergedLagGapExpr`), вердикт
 * по першому плечу (`missedDispSql`) і порядок «спершу вхідні, тоді склейка» — з
 * `callMerge`/`missedCallsRules`, а не переписані. Інакше менеджер отримав би задачу
 * на дзвінок, якого немає в блоці C, або навпаки.
 *
 * ⚠️ Персональні дані: таблиця-журнал несе номер і менеджера — рівно те, що вже лежить у
 * `ringostat_calls` (відкрита `ai_readonly`), а заголовок задачі з номером модель бачить
 * через `ai_tasks`. Нової експозиції немає; змісту особистих задач журнал не торкається —
 * задача сигналу ЗАВЖДИ має виконавця, тобто особистою не буває за побудовою.
 */

/** Поріг сигналу. Рішення власника 16.09.2026: 5 хв, як у листі. */
export const SIGNAL_DELAY = "5 minutes";

/**
 * Як далеко назад джоба шукає ще не оброблені пропущені. ТЕХНІЧНА межа, не бізнес-правило:
 * джоба ходить щопʼять хвилин, три години покривають і запізнення Ringostat, і простій
 * процесу під час викату. Пропущений, старший за цю межу, сигналу вже не отримає — і це
 * чесно: задача «передзвони» через пів доби після дзвінка — це вже не сигнал.
 */
export const SIGNAL_LOOKBACK = "3 hours";

/*
 * 🔴 МЕЖІ ДАВНОСТІ ДЛЯ АВТОЗАКРИТТЯ НЕМАЄ (було 7 днів до 02.10.2026). Критерій ТЗ — «висячих задач по
 * передзвонених 0», а межа лишала висіти рівно тих, кому передзвонили пізніше за тиждень (заміряно
 * 01.10: 4 задачі, найстаріша з 16.09). Відкритих задач — десятки, тож повний обхід дешевий.
 */

const inList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(",");
const KY = "AT TIME ZONE 'Europe/Kyiv'";

/** Мінімум від бази, якого потребує ядро: `pg.Client` і `PoolClient` підходять обидва. */
export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface SignalGroup {
  manager_id: number;
  client_phone: string;
  kday: string;
  missed_total: number;
  last_open_at: Date;
  day_label: string;
  last_hhmm: string;
  last_bucket: DayBucket;
  team_name: string | null;
  today: string;
  /** Угода номера, закрита як «Перевізник» (блок 1 ТЗ 4373); NULL — не перевізник або є угода замовника. */
  carrier_deal: string | null;
}

/**
 * Групи «менеджер + номер + київський день», у яких є хоча б один ВІДКРИТИЙ пропущений:
 * старший за поріг, молодший за межу пошуку, і після нього на номер не було вихідного
 * аж до «зараз».
 *
 * ⚠️ «Не було вихідного ДО ЗАРАЗ», а не «за 5 хв». Пропущений, на який передзвонили на
 * сьомій хвилині, до першого тіку після неї ще відкритий — і задача по ньому
 * народилась би закритою. Результат для менеджера той самий (задачі немає), без шуму.
 *
 * `missed_total` — УСІ пропущені цього дня від номера цьому менеджеру (і ті, на які вже
 * передзвонили): у задачі написано, скільки разів клієнт не додзвонився, а не скільки з
 * цих разів ще без відповіді.
 */
export function signalGroupsSql(now: Date): { sql: string; params: unknown[] } {
  const sql = `
    WITH bounds AS (
      SELECT $1::timestamptz AS now_at,
             (date_trunc('day', ($1::timestamptz - interval '${SIGNAL_LOOKBACK}') ${KY}) ${KY}) AS day_start
    ),
    base AS (
      SELECT rc.uniqueid, rc.manager_id, rc.client_phone, rc.calldate, rc.billsec, rc.disposition
        FROM ringostat_calls rc, bounds bd
       WHERE rc.calldate >= bd.day_start - interval '${CALL_MERGE_WINDOW}'
         AND rc.calldate <= bd.now_at
         AND rc.call_type IN (${inList(INBOUND_TYPES)})
         AND rc.billsec = 0
         AND rc.manager_id IS NOT NULL
         AND rc.client_phone IS NOT NULL
    ),
    marked AS (SELECT b.*, ${mergedLagGapExpr("b")} AS gap FROM base b),
    missed AS (
      SELECT m.manager_id, m.client_phone, m.calldate,
             (m.calldate ${KY})::date AS kday, ${dayBucketParts("m.calldate")}
        FROM marked m, bounds bd
       WHERE ${mergedLagFirst()} AND ${missedDispSql("m")} AND m.calldate >= bd.day_start
    ),
    flagged AS (
      SELECT x.*, (
               x.calldate >= bd.now_at - interval '${SIGNAL_LOOKBACK}'
           AND x.calldate <= bd.now_at - interval '${SIGNAL_DELAY}'
           AND NOT EXISTS (
                 SELECT 1 FROM ringostat_calls o
                  WHERE o.client_phone = x.client_phone
                    AND o.call_type IN (${inList(OUTBOUND_TYPES)})
                    AND o.billsec >= ${String(CALLBACK_MIN_TALK_SEC)}
                    AND o.calldate > x.calldate AND o.calldate <= bd.now_at)
             ) AS is_open
        FROM missed x, bounds bd
    )
    SELECT f.manager_id, f.client_phone, to_char(f.kday, 'YYYY-MM-DD') AS kday,
           COUNT(*)::int AS missed_total,
           MAX(f.calldate) FILTER (WHERE f.is_open) AS last_open_at,
           to_char(f.kday, 'DD.MM') AS day_label,
           to_char(MAX(f.calldate) ${KY}, 'HH24:MI') AS last_hhmm,
           (array_agg(${dayBucketCase("f.dow", "f.hr")} ORDER BY f.calldate DESC))[1] AS last_bucket,
           MAX(t.name) AS team_name,
           to_char((MAX(bd.now_at) ${KY})::date, 'YYYY-MM-DD') AS today,
           ${carrierHistorySql("f.client_phone")}::text AS carrier_deal
      FROM flagged f
      CROSS JOIN bounds bd
      JOIN managers mg ON mg.id = f.manager_id AND mg.is_active
      LEFT JOIN teams t ON t.id = mg.team_id
     GROUP BY f.manager_id, f.client_phone, f.kday
    HAVING bool_or(f.is_open)
     ORDER BY f.manager_id, f.client_phone, f.kday`;
  return { sql, params: [now] };
}

export interface CloseCandidate {
  manager_id: number;
  client_phone: string;
  kday: string;
  task_id: number;
  out_label: string;
  /** Хто передзвонив: наш менеджер за `manager_id`, інакше ПІБ із Ringostat; NULL — невідомо. */
  out_who: string | null;
  out_sec: number;
}

/**
 * Відкриті задачі сигналу, на номер яких після останнього сигналу пішов ПЕРШИЙ вихідний із розмовою
 * від 10 с. «Після сигналу», а не «після пропущеного»: передзвін до сигналу задачі не породив би.
 */
export function closeCandidatesSql(now: Date): { sql: string; params: unknown[] } {
  const sql = `
    SELECT l.manager_id, l.client_phone, to_char(l.kday, 'YYYY-MM-DD') AS kday, l.task_id,
           to_char(o.calldate ${KY}, 'DD.MM HH24:MI') AS out_label,
           COALESCE(om.name, NULLIF(btrim(o.employee_fio), '')) AS out_who,
           o.billsec AS out_sec
      FROM missed_call_tasks l
      CROSS JOIN LATERAL (
        SELECT oc.calldate, oc.billsec, oc.manager_id, oc.employee_fio
          FROM ringostat_calls oc
         WHERE oc.client_phone = l.client_phone
           AND oc.call_type IN (${inList(OUTBOUND_TYPES)})
           AND oc.billsec >= ${String(CALLBACK_MIN_TALK_SEC)}
           AND oc.calldate > l.last_signal_at AND oc.calldate <= $1::timestamptz
         ORDER BY oc.calldate, oc.uniqueid LIMIT 1) o
      LEFT JOIN managers om ON om.id = o.manager_id
     WHERE l.closed_at IS NULL AND l.task_id IS NOT NULL
     ORDER BY l.kday, l.manager_id, l.client_phone`;
  return { sql, params: [now] };
}

const BUCKET_LABEL: Record<DayBucket, string> = {
  work: "робочий час", evening: "вечір", weekend: "вихідні", night: "ніч",
};

/** 1 раз · 2–4 рази · 5+ разів · 11–14 разів. */
export function timesUk(n: number): string {
  const d10 = n % 10, d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return `${String(n)} раз`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${String(n)} рази`;
  return `${String(n)} разів`;
}

/**
 * Міжнародний номер (`380671234567`) показуємо з плюсом. Місцевий із нулем попереду (`0671234567`)
 * лишаємо як є: плюс перед ним дав би неіснуючий номер.
 */
export const phoneForTask = (p: string): string => (/^[1-9]\d{9,14}$/.test(p) ? `+${p}` : p);

export const SIGNAL_TITLE_PREFIX = "📵 Передзвонити клієнту";

export const signalTitle = (phone: string): string => `${SIGNAL_TITLE_PREFIX}: ${phoneForTask(phone)}`;

export function signalDescription(g: { missedTotal: number; dayLabel: string; lastHhmm: string; lastBucket: DayBucket }): string {
  return [
    `Клієнт не додзвонився до вас ${timesUk(g.missedTotal)} за ${g.dayLabel}, `
      + `останній раз о ${g.lastHhmm} (${BUCKET_LABEL[g.lastBucket]}).`,
    "Передзвону з розмовою від 10 с на цей номер не було щонайменше 5 хв після пропущеного.",
    "Задача закриється сама, щойно на цей номер буде вихідний дзвінок із розмовою від 10 с.",
    "Створено автоматично: «Пропущені дзвінки».",
  ].join("\n");
}

/**
 * Причина автозакриття: КОЛИ, ХТО і СКІЛЬКИ тривала розмова (ТЗ: «у картці — час передзвону і хто
 * передзвонив»). Префікс «Закрито автоматично:» — контракт із фронтом (`signalTaskNotify.AUTO_CLOSE_PREFIX`, `#462`).
 */
export const autoCloseReason = (outLabel: string, who: string | null = null, sec: number | null = null): string =>
  `Закрито автоматично: передзвонив${who ? ` ${who}` : "и з номера компанії"} ${outLabel}`
  + `${sec != null ? `, розмова ${String(sec)} с` : ""}.`;

export interface SignalStats {
  groups: number; created: number; reopened: number; updated: number; closed: number;
  /** Блок 1 ТЗ 4373: задачу не поставлено — номер перевізника за історією CRM (нові записи в `missed_call_skips`). */
  skippedCarrier: number;
  /** Блок 1: відкриту задачу закрито — номер перевізника за історією CRM. */
  closedCarrier: number;
}

/**
 * Відкриті задачі сигналу, номер яких — перевізник за історією CRM (блок 1 ТЗ 4373). Закриваємо з поясненням:
 * передзвонювати перевізнику не треба. Людина, яка вважає інакше, відкриває задачу знову — і тоді сигнал її не чіпає,
 * поки не прийде новий пропущений (а на новий пропущений від цього номера задача вже не ставиться).
 */
export function carrierCloseCandidatesSql(): string {
  return `
    SELECT l.manager_id, l.client_phone, to_char(l.kday, 'YYYY-MM-DD') AS kday, l.task_id, c.carrier_deal::text AS carrier_deal
      FROM missed_call_tasks l
      JOIN tasks t ON t.id = l.task_id
      CROSS JOIN LATERAL (SELECT ${carrierHistorySql("l.client_phone")} AS carrier_deal) c
     WHERE l.closed_at IS NULL AND t.status <> 'done' AND c.carrier_deal IS NOT NULL
     ORDER BY l.kday, l.manager_id, l.client_phone`;
}

/**
 * Один прохід сигналу: спершу групи (створити / перевідкрити / оновити лічильник), потім
 * автозакриття. Порядок не випадковий: закривши першим, ми б у тому ж тіку перевідкрили
 * задачу, по якій після вихідного прийшов новий пропущений, — зайвий рядок в історії.
 *
 * Кожна група — окрема транзакція з `FOR UPDATE` на рядку журналу: задача без рядка
 * журналу означала б дубль на наступному тіку.
 */
export async function applyMissedCallSignals(db: Db, now: Date): Promise<SignalStats> {
  const stats: SignalStats = { groups: 0, created: 0, reopened: 0, updated: 0, closed: 0, skippedCarrier: 0, closedCarrier: 0 };
  const g = signalGroupsSql(now);
  const groups = (await db.query<SignalGroup>(g.sql, g.params)).rows;
  stats.groups = groups.length;

  for (const r of groups) {
    if (r.carrier_deal != null) {
      // Перевізник за історією CRM — задачу не ставимо (ТЗ: «задача менеджеру не створюється»), лише слід для звіту.
      // Лише якщо задачі на цю групу НЕ БУЛО: поставлену раніше й закриту як перевізника рахує «закрито», а не
      // «не поставлено» — інакше звіт контролю рахував би один номер двічі (спіймав `#1309`).
      const ins = await db.query(
        `INSERT INTO missed_call_skips (manager_id, client_phone, kday, reason, carrier_deal)
         SELECT $1, $2, $3::date, 'carrier_history', $4::bigint
          WHERE NOT EXISTS (SELECT 1 FROM missed_call_tasks WHERE manager_id = $1 AND client_phone = $2 AND kday = $3::date)
         ON CONFLICT DO NOTHING`,
        [r.manager_id, r.client_phone, r.kday, r.carrier_deal]);
      stats.skippedCarrier += ins.rowCount ?? 0;
      continue;
    }
    const title = signalTitle(r.client_phone);
    const description = signalDescription({
      missedTotal: r.missed_total, dayLabel: r.day_label, lastHhmm: r.last_hhmm, lastBucket: r.last_bucket,
    });
    const createTask = async (): Promise<number> => (await db.query<{ id: number }>(
      `INSERT INTO tasks (title, description, status, deadline, assignee_id, priority, department, task_type)
       VALUES ($1, $2, 'not_started', $3::date, $4, 'high', $5, 'simple') RETURNING id`,
      [title, description, r.today, r.manager_id, r.team_name ?? "Пропущені дзвінки"])).rows[0].id;

    await db.query("BEGIN");
    try {
      const led = (await db.query<{ task_id: number | null; last_signal_at: Date; missed_count: number }>(
        `SELECT task_id, last_signal_at, missed_count FROM missed_call_tasks
          WHERE manager_id = $1 AND client_phone = $2 AND kday = $3::date FOR UPDATE`,
        [r.manager_id, r.client_phone, r.kday])).rows[0];

      if (!led) {
        const id = await createTask();
        await db.query(
          `INSERT INTO missed_call_tasks (manager_id, client_phone, kday, task_id, missed_count, last_signal_at)
           VALUES ($1, $2, $3::date, $4, $5, $6)`,
          [r.manager_id, r.client_phone, r.kday, id, r.missed_total, r.last_open_at]);
        stats.created++;
      } else if (r.last_open_at.getTime() > led.last_signal_at.getTime()) {
        // Новий пропущений без відповіді після останнього сигналу.
        let taskId = led.task_id;
        if (taskId === null) {
          // Задачу видалили руками, а клієнт дзвонить знову — сигнал потрібен, отже нова задача.
          taskId = await createTask();
          stats.created++;
        } else {
          const prev = (await db.query<{ status: string }>(
            "SELECT status FROM tasks WHERE id = $1 FOR UPDATE", [taskId])).rows[0];
          if (prev?.status === "done") {
            await db.query(
              `UPDATE tasks SET status = 'not_started', closed_at = NULL, close_reason = NULL, closed_by = NULL,
                                description = $2, updated_at = now() WHERE id = $1`, [taskId, description]);
            await db.query(
              "INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, 'done', 'not_started', NULL)",
              [taskId]);
            stats.reopened++;
          } else {
            await db.query("UPDATE tasks SET description = $2, updated_at = now() WHERE id = $1", [taskId, description]);
            stats.updated++;
          }
        }
        await db.query(
          `UPDATE missed_call_tasks SET task_id = $4, missed_count = $5, last_signal_at = $6, closed_at = NULL, updated_at = now()
            WHERE manager_id = $1 AND client_phone = $2 AND kday = $3::date`,
          [r.manager_id, r.client_phone, r.kday, taskId, r.missed_total, r.last_open_at]);
      } else if (r.missed_total !== led.missed_count && led.task_id !== null) {
        // Нового відкритого немає, але лічильник зріс (пропущений, молодший за поріг) — лише текст.
        await db.query("UPDATE tasks SET description = $2, updated_at = now() WHERE id = $1", [led.task_id, description]);
        await db.query(
          `UPDATE missed_call_tasks SET missed_count = $4, updated_at = now()
            WHERE manager_id = $1 AND client_phone = $2 AND kday = $3::date`,
          [r.manager_id, r.client_phone, r.kday, r.missed_total]);
        stats.updated++;
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }

  // Перевізники — ДО закриття передзвоном: задача на номер перевізника закривається з правильною причиною.
  for (const r of (await db.query<{ manager_id: number; client_phone: string; kday: string; task_id: number; carrier_deal: string }>(
    carrierCloseCandidatesSql())).rows) {
    await db.query("BEGIN");
    try {
      const prev = (await db.query<{ status: string }>("SELECT status FROM tasks WHERE id = $1 FOR UPDATE", [r.task_id])).rows[0];
      if (prev && prev.status !== "done") {
        await db.query(`UPDATE tasks SET status = 'done', closed_at = $2, close_reason = $3, updated_at = now() WHERE id = $1`,
          [r.task_id, now, carrierTaskCloseReason(r.carrier_deal)]);
        await db.query("INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, 'done', NULL)",
          [r.task_id, prev.status]);
        stats.closedCarrier++;
      }
      await db.query(`UPDATE missed_call_tasks SET closed_at = $4, updated_at = now()
                        WHERE manager_id = $1 AND client_phone = $2 AND kday = $3::date`, [r.manager_id, r.client_phone, r.kday, now]);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }

  const c = closeCandidatesSql(now);
  for (const r of (await db.query<CloseCandidate>(c.sql, c.params)).rows) {
    await db.query("BEGIN");
    try {
      const prev = (await db.query<{ status: string }>(
        "SELECT status FROM tasks WHERE id = $1 FOR UPDATE", [r.task_id])).rows[0];
      // Менеджер міг закрити сам — тоді задачу не чіпаємо, лише гасимо журнал.
      if (prev && prev.status !== "done") {
        await db.query(
          `UPDATE tasks SET status = 'done', closed_at = $2, close_reason = $3, updated_at = now() WHERE id = $1`,
          [r.task_id, now, autoCloseReason(r.out_label, r.out_who, r.out_sec)]);
        await db.query(
          "INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, 'done', NULL)",
          [r.task_id, prev.status]);
        stats.closed++;
      }
      await db.query(
        `UPDATE missed_call_tasks SET closed_at = $4, updated_at = now()
          WHERE manager_id = $1 AND client_phone = $2 AND kday = $3::date`,
        [r.manager_id, r.client_phone, r.kday, now]);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }
  return stats;
}

/**
 * 🔁 ПЕРЕРАХУНОК СТАРИХ ЗАДАЧ ЗА ПРАВИЛОМ «РОЗМОВА ВІД 10 С» (рішення Романа 02.10.2026: «переводимо всі
 * старі задачі туди ж»). З 16.09 до 02.10 задачу закривав БУДЬ-ЯКИЙ вихідний, тож частина задач закрита
 * спробою, а не передзвоном. Заміряно 02.10: таких 27 із 506.
 *
 * Перевідкриваємо РІВНО ті, що закрила ДЖОБА (причина з префіксом автозакриття) і після сигналу яких
 * досі немає жодного вихідного з розмовою від 10 с. Закриті людьми не чіпаємо (215 на 02.10) — рішення
 * людини сильніше за правило. Відкриті з уже наявним передзвоном закриє сама джоба на першому тіку:
 * межі давності в неї більше немає.
 *
 * Ідемпотентно: перевідкрита задача вже не «закрита джобою», тож другий прогін її не бачить.
 * `apply = false` — лише список (`--dry`), нічого не пише.
 */
export interface RecountRow { task_id: number; manager_id: number; client_phone: string; kday: string; close_reason: string }

export function recountCandidatesSql(): string {
  return `
    SELECT t.id AS task_id, l.manager_id, l.client_phone, to_char(l.kday, 'YYYY-MM-DD') AS kday, t.close_reason
      FROM missed_call_tasks l
      JOIN tasks t ON t.id = l.task_id
     WHERE t.status = 'done'
       AND t.close_reason LIKE '${AUTO_CLOSE_PREFIX_SQL}%'
       AND NOT EXISTS (
             SELECT 1 FROM ringostat_calls o
              WHERE o.client_phone = l.client_phone
                AND o.call_type IN (${inList(OUTBOUND_TYPES)})
                AND o.billsec >= ${String(CALLBACK_MIN_TALK_SEC)}
                AND o.calldate > l.last_signal_at)
       -- Номер перевізника за історією CRM не перевідкриваємо: блок 1 ТЗ однаково закрив би задачу (заміряно 02.10: 9 із 27).
       AND ${carrierHistorySql("l.client_phone")} IS NULL
     ORDER BY l.kday, l.manager_id, l.client_phone`;
}

/** Префікс автозакриття — той самий, що в `autoCloseReason` і на фронті (`#462`). */
const AUTO_CLOSE_PREFIX_SQL = "Закрито автоматично:";

export const RECOUNT_NOTE = "Перевідкрито 02.10.2026: задачу раніше закрив вихідний без розмови від 10 с — "
  + "це була спроба, а не передзвін (ТЗ «автозакриття пропущених»). Передзвоніть клієнту. "
  + "Увага: перевірка номерів на біржі Lardi-Trans не працює з 28.09.2026, тож це може бути й перевізник.";

export async function recountMissedTasks(db: Db, apply: boolean): Promise<{ rows: RecountRow[]; reopened: number }> {
  const rows = (await db.query<RecountRow>(recountCandidatesSql())).rows;
  if (!apply) return { rows, reopened: 0 };
  let reopened = 0;
  for (const r of rows) {
    await db.query("BEGIN");
    try {
      const prev = (await db.query<{ status: string; close_reason: string | null }>(
        "SELECT status, close_reason FROM tasks WHERE id = $1 FOR UPDATE", [r.task_id])).rows[0];
      // Між списком і записом людина могла сама відкрити чи закрити задачу — тоді не чіпаємо.
      if (prev?.status === "done" && (prev.close_reason ?? "").startsWith(AUTO_CLOSE_PREFIX_SQL)) {
        await db.query(
          `UPDATE tasks SET status = 'not_started', closed_at = NULL, close_reason = NULL, closed_by = NULL,
                            description = COALESCE(description || E'\\n', '') || $2, updated_at = now() WHERE id = $1`,
          [r.task_id, RECOUNT_NOTE]);
        await db.query(
          "INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, 'done', 'not_started', NULL)",
          [r.task_id]);
        await db.query(
          `UPDATE missed_call_tasks SET closed_at = NULL, updated_at = now()
            WHERE manager_id = $1 AND client_phone = $2 AND kday = $3::date`,
          [r.manager_id, r.client_phone, r.kday]);
        reopened++;
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  }
  return { rows, reopened };
}
