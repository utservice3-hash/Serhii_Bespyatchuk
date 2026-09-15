import { mergedLagGapExpr, mergedLagFirst } from "./callMerge.js";
import { dayBucketCase, dayBucketParts } from "./dayBuckets.js";

/**
 * 📵 ПРОПУЩЕНІ ВХІДНІ — ОЗНАЧЕННЯ Й ФОРМА ЗАПИТУ. ТЗ-1 від 14.09.2026.
 *
 * 🔴 МОДУЛЬ ЧИСТИЙ: імпортує лише два таких самих чистих (`callMerge`, `dayBuckets`)
 * і НЕ тягне `db/pool.js`. Це умова того, щоб гейти нижче бігли у звичайному
 * `npm test`: `pool` кидає на відсутньому `DATABASE_URL` ще НА ІМПОРТІ, тобто
 * раніше, ніж встигне спрацювати `skip`, — і весь набір мовчки осліп би.
 *
 * ⚠️ ТУТ ЖОДНОГО SQL ПО ГРОШАХ. Рахуються штуки дзвінків і хвилини; виручку й далі
 * рахує лише `core/money.ts`.
 */

/** Вікно передзвону. Рішення власника 15.09.2026 (РІШЕННЯ 2 у ТЗ): рівно доба. */
export const CALLBACK_WINDOW = "24 hours";

/**
 * 🔴 BUSY — ЦЕ ПРОПУЩЕНИЙ (рішення власника 15.09.2026). Лінія зайнята означає, що
 * клієнт не додзвонився, а не що ми відповіли.
 */
export const MISSED_DISPOSITIONS = ["NO ANSWER", "BUSY"] as const;

/**
 * Вхідні плечі. Ringostat пише переведений дзвінок ДВОМА записами, тож `transitin`
 * тут не «службовий рядок», а друге плече того самого звернення клієнта.
 */
export const INBOUND_TYPES = ["in", "transitin"] as const;
export const OUTBOUND_TYPES = ["out", "transitout"] as const;

const list = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(",");

/** Вердикт по ОДНОМУ запису CDR. Чотири значення, бо їх справді чотири. */
export type CallVerdict = "missed" | "excluded" | "talk" | "outbound";

/**
 * 🔴 «НЕ ПРОПУЩЕНИЙ» — ЦЕ НЕ ОДНЕ ЗНАЧЕННЯ, А ТРИ, І САМЕ ТОМУ ТУТ `CallVerdict`,
 * А НЕ `boolean`. Правило проєкту: стан, що стверджує причину, не може бути
 * смітником для кількох різних відмов (CLAUDE.md, правило 3). Під одним підписом
 * «не пропущений» жили б розмова, вихідний і голосова пошта.
 *
 * `excluded` — це ЧЕСНЕ «не зараховуємо і називаємо себе»: VOICEMAIL (17),
 * CLIENT NO ANSWER (29, клієнт кинув слухавку до відповіді — рішення власника
 * НЕ рахувати) і ANSWERED із нульовою розмовою (39). Разом 85 за 30 днів. Вони
 * показуються виноскою «не враховано: N», щоб їх не шукали як зниклі.
 *
 * ⚠️ NULL-ПАСТКА, ЗАКРИТА ТУТ НАВМИСНО: у SQL `disposition IN (…)` при NULL дає
 * NULL, і рядок не потрапляє В ЖОДНУ гілку — зникає з підсумку, не з'явившись у
 * жодному числі. Той самий клас уже коштував 159 угод на `traf_type`. Тому
 * `excluded` означений як ДОПОВНЕННЯ (`IS NULL OR NOT IN`), а не другим переліком.
 */
export function classifyCall(c: { callType: string; billsec: number; disposition: string | null }): CallVerdict {
  if (!(INBOUND_TYPES as readonly string[]).includes(c.callType)) return "outbound";
  if (c.billsec > 0) return "talk";
  return c.disposition !== null && (MISSED_DISPOSITIONS as readonly string[]).includes(c.disposition)
    ? "missed" : "excluded";
}

export const isMissed = (c: { callType: string; billsec: number; disposition: string | null }): boolean =>
  classifyCall(c) === "missed";

/** Той самий вердикт у SQL. Псевдонім таблиці — аргумент, бо читачів уже двоє. */
export const missedDispSql = (a = ""): string => {
  const c = a ? `${a}.` : "";
  return `${c}disposition IN (${list(MISSED_DISPOSITIONS)})`;
};

/**
 * 🔗 СКЛЕЙКА — ТІЛЬКИ ФОРМОЮ З ВІКОННОЮ ФУНКЦІЄЮ, І ЦЕ НЕ СМАК.
 *
 * `callMerge` дає дві форми. Друга (`mergedNotExists`) тут була б ТИХО НЕПРАВИЛЬНОЮ:
 * вона звіряє плечі умовою `p.manager_id = a.manager_id`, а звичайна рівність при
 * NULL дає NULL → `NOT EXISTS` завжди істинний → жоден дзвінок БЕЗ ВІДПОВІДАЛЬНОГО
 * не склеюється взагалі. А таких **48.5%** усіх пропущених (3 629 із 7 476,
 * заміряно 15.09.2026). Тобто половина екрана була б завищена, і рівно та половина,
 * заради якої ТЗ і писалось.
 *
 * `PARTITION BY` натомість вважає NULL-и одним кошиком — саме те, що треба.
 *
 * 🔴 І ФІЛЬТР СТОЇТЬ ДО СКЛЕЙКИ, А НЕ ПІСЛЯ. `call_type` не входить у ключ склейки,
 * тож на несортованому наборі вхідний недодзвін і вихідний недодзвін на той самий
 * номер у межах 120 с злились би в один рядок. Спершу звужуємо до вхідних, і лише
 * тоді рахуємо `LAG` — інакше склейка з'їдає те, що склеювати не просили.
 */
export const MERGE_NOTE = "LAG over the already-filtered inbound set";

/** Хто передзвонив: сам відповідальний чи ні. Іменовано, бо читачів двоє. */
export const SELF_CALLBACK_SQL =
  "cb_manager IS NOT NULL AND manager_id IS NOT NULL AND cb_manager = manager_id";

export interface MissedScope { managerId?: number | null; teamId?: number | null }

/**
 * Спільна основа обох запитів: вхідні з нульовою розмовою за період, склеєні,
 * з бакетом доби і з двома LATERAL-сусідами (наш передзвін / клієнт сам).
 *
 * ⚠️ `LEFT JOIN managers`, а не `INNER` — і це не стиль. Сусідній `reportCuts`
 * джойнить `INNER`, бо там кожен дзвінок за побудовою має менеджера; тут INNER
 * зрізав би рівно ті 48.5%, що не мають відповідального.
 *
 * ⚠️ `scope.teamId` СВІДОМО ховає «без відповідального»: дзвінок, що не дійшов до
 * людини, не належить жодній команді. Це не втрата рядка, це чесна відповідь —
 * але на екрані команди підсумок буде меншим за загальний, і так і має бути.
 */
function baseCte(from: string, to: string, s: MissedScope): { cte: string; params: unknown[] } {
  const p: unknown[] = [from, to];
  const conds = [
    "(rc.calldate AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2",
    `rc.call_type IN (${list(INBOUND_TYPES)})`,
    "rc.billsec = 0",
  ];
  if (s.managerId) { p.push(s.managerId); conds.push(`rc.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const cte = `
    WITH base AS (
      SELECT rc.uniqueid, rc.manager_id, rc.client_phone, rc.calldate, rc.billsec, rc.disposition,
             ${dayBucketParts("rc.calldate")}
        FROM ringostat_calls rc
        LEFT JOIN managers m ON m.id = rc.manager_id
       WHERE ${conds.join(" AND ")}
    ),
    marked AS (SELECT b.*, ${mergedLagGapExpr("b")} AS gap FROM base b),
    legs AS (SELECT *, ${dayBucketCase()} AS bucket FROM marked WHERE ${mergedLagFirst()}),
    withNext AS (
      SELECT f.*, cb.calldate AS cb_at, cb.billsec AS cb_billsec, cb.manager_id AS cb_manager,
             cs.calldate AS cs_at
        FROM legs f
        LEFT JOIN LATERAL (
          SELECT o.calldate, o.billsec, o.manager_id
            FROM ringostat_calls o
           WHERE o.client_phone = f.client_phone
             AND o.call_type IN (${list(OUTBOUND_TYPES)})
             AND o.calldate >  f.calldate
             AND o.calldate <= f.calldate + interval '${CALLBACK_WINDOW}'
           ORDER BY o.calldate, o.uniqueid LIMIT 1) cb ON TRUE
        LEFT JOIN LATERAL (
          SELECT i.calldate
            FROM ringostat_calls i
           WHERE i.client_phone = f.client_phone
             AND i.call_type IN (${list(INBOUND_TYPES)})
             AND i.billsec > 0
             AND i.calldate >  f.calldate
             AND i.calldate <= f.calldate + interval '${CALLBACK_WINDOW}'
           ORDER BY i.calldate, i.uniqueid LIMIT 1) cs ON TRUE
    )`;
  return { cte, params: p };
}

/**
 * 🔴 МЕДІАНА, А НЕ СЕРЕДНЄ — І РІЗНИЦЯ НЕ КОСМЕТИЧНА. Заміряно 15.09.2026:
 * медіана **19 хв**, середнє **183 хв**, тобто майже вдесятеро. Розподіл хвостатий:
 * середнє тягнуть поодинокі «передзвонили наступного дня», і ціль «з 60% до 36%»,
 * поставлена на середньому, вимірювала б хвіст, а не роботу відділу.
 */
const MEDIAN_MIN_SQL =
  "PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (cb_at - calldate))/60.0)"
  + " FILTER (WHERE cb_at IS NOT NULL)";

/** Підсумок за період — блок A екрана. Обидва числа ОДНИМ запитом по одній основі. */
export function missedSummarySql(from: string, to: string, s: MissedScope): { sql: string; params: unknown[] } {
  const { cte, params } = baseCte(from, to, s);
  const m = missedDispSql();
  const sql = `${cte}
    SELECT COUNT(*) FILTER (WHERE ${m})::int AS missed,
           COUNT(*) FILTER (WHERE disposition IS NULL OR NOT (${m}))::int AS excluded,
           COUNT(*) FILTER (WHERE ${m} AND manager_id IS NULL)::int AS ownerless,
           COUNT(*) FILTER (WHERE ${m} AND cb_at IS NOT NULL)::int AS callback,
           COUNT(*) FILTER (WHERE ${m} AND cb_at IS NOT NULL AND cb_billsec > 0)::int AS callback_talked,
           COUNT(*) FILTER (WHERE ${m} AND cb_at IS NOT NULL AND (${SELF_CALLBACK_SQL}))::int AS callback_self,
           COUNT(*) FILTER (WHERE ${m} AND cb_at IS NOT NULL AND NOT (${SELF_CALLBACK_SQL}))::int AS callback_colleague,
           COUNT(*) FILTER (WHERE ${m} AND cs_at IS NOT NULL)::int AS client_self,
           COUNT(*) FILTER (WHERE ${m} AND bucket = 'work')::int    AS b_work,
           COUNT(*) FILTER (WHERE ${m} AND bucket = 'evening')::int AS b_evening,
           COUNT(*) FILTER (WHERE ${m} AND bucket = 'weekend')::int AS b_weekend,
           COUNT(*) FILTER (WHERE ${m} AND bucket = 'night')::int   AS b_night,
           ${MEDIAN_MIN_SQL} AS median_min
      FROM withNext`;
  return { sql, params };
}

/** Таблиця по менеджерах — блок B. Рядок без відповідального тут ЗВИЧАЙНИЙ рядок. */
export function missedByManagerSql(from: string, to: string, s: MissedScope): { sql: string; params: unknown[] } {
  const { cte, params } = baseCte(from, to, s);
  const m = missedDispSql();
  const sql = `${cte}
    SELECT w.manager_id, MAX(mg.name) AS name,
           COUNT(*)::int AS missed,
           COUNT(*) FILTER (WHERE cb_at IS NOT NULL AND (${SELF_CALLBACK_SQL}))::int AS callback_self,
           COUNT(*) FILTER (WHERE cb_at IS NOT NULL AND NOT (${SELF_CALLBACK_SQL}))::int AS callback_colleague,
           COUNT(*) FILTER (WHERE cs_at IS NOT NULL)::int AS client_self,
           ${MEDIAN_MIN_SQL} AS median_min
      FROM withNext w
      LEFT JOIN managers mg ON mg.id = w.manager_id
     WHERE ${m}
     GROUP BY w.manager_id`;
  return { sql, params };
}

/** Підпис рядка «нічиїх». Слово одне на продукт — див. коментар у `foldManagerRows`. */
export const OWNERLESS_LABEL = "Без відповідального";

export interface MissedManagerRaw {
  managerId: number | null; name: string | null; missed: number;
  callbackSelf: number; callbackColleague: number; clientSelf: number; medianMin: number | null;
}
export interface MissedManagerRow extends MissedManagerRaw { name: string; noCallback: number }

/**
 * 🔴 «БЕЗ ВІДПОВІДАЛЬНОГО» — ОКРЕМИЙ РЯДОК, А НЕ ФІЛЬТР І НЕ РОЗМАЗУВАННЯ.
 * Рішення власника 15.09.2026 (РІШЕННЯ 3): у першому проході — чесний рядок;
 * приписувати черговому з `duty_schedule` — другим проходом, ПІСЛЯ того як число
 * побачать на екрані. 48.5% пропущених не мають менеджера, тож будь-яке мовчазне
 * поводження з ними тут вирішувало б половину задачі за власника.
 *
 * ⚠️ СЛОВО «НІЧИЙ» ВЖИВАТИ ЗАБОРОНЕНО: у `core/orphanClients.ts` воно вже означає
 * клієнта без активного менеджера — інший предмет. Два різні предмети під одним
 * словом на сусідніх екранах — рівно та помилка, яку ми ловили на двох «очікуємо».
 *
 * 🔴 ПІДСУМКОВА МЕДІАНА ТУТ `null`, І ЦЕ НАВМИСНО: медіани не додаються й не
 * усереднюються. Справжня медіана періоду береться з `missedSummary` ОДНИМ
 * запитом по всьому набору. Поставити сюди середнє з медіан означало б показати
 * число, яке не є ні медіаною, ні середнім.
 */
export function foldManagerRows(raw: MissedManagerRaw[]): { rows: MissedManagerRow[]; total: MissedManagerRow } {
  const rows: MissedManagerRow[] = raw.map((r) => ({
    ...r,
    name: r.managerId === null ? OWNERLESS_LABEL : (r.name ?? `#${String(r.managerId)}`),
    noCallback: r.missed - r.callbackSelf - r.callbackColleague,
  }));
  rows.sort((a, b) =>
    (a.managerId === null ? 1 : 0) - (b.managerId === null ? 1 : 0)
    || b.missed - a.missed
    || a.name.localeCompare(b.name, "uk"));
  const sum = (f: (r: MissedManagerRow) => number): number => rows.reduce((n, r) => n + f(r), 0);
  return {
    rows,
    total: {
      managerId: null, name: "Всього", missed: sum((r) => r.missed),
      callbackSelf: sum((r) => r.callbackSelf), callbackColleague: sum((r) => r.callbackColleague),
      clientSelf: sum((r) => r.clientSelf), noCallback: sum((r) => r.noCallback), medianMin: null,
    },
  };
}

/** Глибина дефолтного вікна, якщо період не прийшов. */
export const MISSED_DEFAULT_DAYS = 30;

/**
 * 🔴 ПОРОЖНІЙ ПЕРІОД НЕ СМІЄ ДОЇХАТИ ДО SQL. `BETWEEN NULL AND NULL` не помилка —
 * він чесно віддає НУЛЬ РЯДКІВ, і екран показує «пропущених 0», що читається як
 * чудова новина. Це рівно «порожній результат = ПРОВАЛ, доки не доведено, що
 * перевірці було що знаходити» (CLAUDE.md), тільки на бойовому екрані.
 *
 * ⚠️ Швидкий період «Весь час» шле ПОРОЖНІ РЯДКИ (`?from=&to=`), а не відсутній
 * параметр, — тому перевірка на правдивість, а не `?? null`: та сама пастка, через
 * яку `dateParam` колись і завели.
 *
 * Роут ЗАВЖДИ повертає обраний період у відповіді, щоб на екрані було видно, за
 * що саме показані числа, а не за що їх попросили.
 */
export function missedPeriod(from: string | null, to: string | null, today: string): { from: string; to: string } {
  const end = to || today;
  if (from) return { from, to: end };
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (MISSED_DEFAULT_DAYS - 1));
  return { from: d.toISOString().slice(0, 10), to: end };
}
