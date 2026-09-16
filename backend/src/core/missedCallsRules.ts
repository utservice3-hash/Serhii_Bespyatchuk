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
 * 🔒 КЛАМП СКОУПУ — ОДНЕ МІСЦЕ НА ВСІ РОУТИ ЕКРАНА. Доти він жив інлайном в одному роуті;
 * у проході 2 роутів стає чотири, і розмножити межу доступу копіями означало б, що
 * виправлення ляже в одну, а три тихо відстануть.
 *
 * Менеджер бачить лише себе, тімлід — свою команду, решта — те, що попросили в запиті.
 * ⚠️ Тімлідів кламп СВІДОМО ховає «без відповідального»: дзвінок, що не дійшов до людини,
 * не належить жодній команді, і приписати його команді означало б вигадати відповідального.
 */
export function missedScopeFor(
  auth: { role: string; managerId: number | null; teamId: number | null },
  query: { managerId?: unknown; teamId?: unknown },
): MissedScope {
  let managerId = query.managerId ? Number(query.managerId) : null;
  let teamId = query.teamId ? Number(query.teamId) : null;
  // 🔴 `?? -1`, а НЕ голий `auth.managerId`. Ядро фільтрує через `if (s.managerId)`, тобто
  // null і 0 для нього — «фільтра немає», а не «нікого». Менеджер без привʼязаного
  // manager_id бачив би дзвінки ВСІЄЇ компанії. Правило 7 з CLAUDE.md: порожній скоуп не
  // можна виражати нулем. -1 truthy, фільтр ставиться й не збігається ні з ким.
  // 📐 Заміряно 16.09.2026: сьогодні в цю діру не потрапляє жоден із 47 активних
  // акаунтів — вада прихована, а не діюча. Але в тімліда фолбек `?? -1` стояв від
  // початку, тобто асиметрія була випадковою, а не рішенням.
  if (auth.role === "manager") { managerId = auth.managerId ?? -1; teamId = null; }
  else if (auth.role === "team_lead") teamId = auth.teamId ?? -1;
  return { managerId, teamId };
}

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
      SELECT rc.uniqueid, rc.manager_id, rc.client_phone, rc.client_key, rc.calldate, rc.billsec, rc.disposition,
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


/* ═══════════════════════════ БЛОКИ C і D (прохід 2, 16.09.2026) ═══════════════════════════ */

/**
 * 🪟 ВІКНО «УГОДА ПОВʼЯЗАНА З ДЗВІНКОМ»: від доби ДО дзвінка до семи днів ПІСЛЯ.
 * Сім днів — рішення власника 15.09.2026 («так, хай буде 7 днів»). Доба до — з означення
 * в ТЗ (§1.4 D), на якому знято заміри 2 631 / 1 252 / 1 279: клієнт часто дзвонить по
 * заявці, яку завели за кілька годин перед тим, і вона не є «незаведеною».
 *
 * 🔴 ОДНЕ ВІКНО НА ДВА БЛОКИ. «Є угода» в списку дзвінків (C) і в розкладі станів (D)
 * мусять означати одне й те саме — тому обидва кличуть `dealInWindowLateral`, а не
 * пишуть кожен свій `LATERAL`. Друга копія розійшлась би з першою мовчки: рівно так на
 * екрані Звіту жили два правила «новий/постійний» (12.6% угод серпня розходились).
 */
export const DEAL_WINDOW_BEFORE = "1 day";
export const DEAL_WINDOW_AFTER = "7 days";

/**
 * Перша угода клієнта у вікні. Звичайна рівність по `client_key`: дзвінок із невідомим
 * клієнтом (NULL) угоди не має за побудовою — і це правильно, бо «не знаємо, хто
 * дзвонив» не може мати заведеної заявки.
 */
export const dealInWindowLateral = (a: string, out = "dl"): string => `
        LEFT JOIN LATERAL (
          SELECT d.kommo_id
            FROM deals d
           WHERE d.client_key = ${a}.client_key
             AND d.created_at_kommo >= ${a}.calldate - interval '${DEAL_WINDOW_BEFORE}'
             AND d.created_at_kommo <= ${a}.calldate + interval '${DEAL_WINDOW_AFTER}'
           ORDER BY d.created_at_kommo, d.kommo_id LIMIT 1) ${out} ON TRUE`;

/** Стеля списку: день — це сотні рядків, але екран не мусить падати від тисяч. */
export const MISSED_LIST_LIMIT = 1000;

/* ─────────────── Блок C · список пропущених за день ─────────────── */

/**
 * 🔴 СПИСОК РАХУЄТЬСЯ ТИМ САМИМ ВИРАЗОМ, ЩО Й ЧИСЛО. Правило екранів Звіту: розкриття
 * пояснює число, а не сперечається з ним. Тому тут `baseCte` + `missedDispSql` — рівно
 * те, чим `missedSummarySql` рахує «пропущено». Для одного дня кількість рядків
 * списку дорівнює `summary.missed` за той самий день — це й стереже `#450`.
 */
export function missedListSql(day: string, s: MissedScope, onlyNoCallback = false): { sql: string; params: unknown[] } {
  const { cte, params } = baseCte(day, day, s);
  const extra = onlyNoCallback ? " AND w.cb_at IS NULL" : "";
  const sql = `${cte}
    SELECT w.uniqueid,
           to_char(w.calldate AT TIME ZONE 'Europe/Kyiv', 'HH24:MI') AS at,
           w.client_phone, w.client_key, w.manager_id, mg.name AS manager_name, w.bucket,
           EXTRACT(EPOCH FROM (w.cb_at - w.calldate))/60.0 AS cb_min,
           (w.cb_billsec > 0) AS cb_talked,
           EXTRACT(EPOCH FROM (w.cs_at - w.calldate))/60.0 AS cs_min,
           dl.kommo_id AS deal_id
      FROM withNext w
      LEFT JOIN managers mg ON mg.id = w.manager_id
      ${dealInWindowLateral("w")}
     WHERE ${missedDispSql("w")}${extra}
     ORDER BY w.calldate DESC, w.uniqueid
     LIMIT ${MISSED_LIST_LIMIT}`;
  return { sql, params };
}

export type NextStep = "callback_talked" | "callback_no_answer" | "client_self" | "nothing";

/**
 * «Що сталось далі» — ОДНА подія, і це НАЙРАНІША з двох.
 *
 * ⚠️ Підсумок (блок A) рахує передзвін і «клієнт сам» НЕЗАЛЕЖНО: один дзвінок може бути
 * в обох числах. А рядок списку відповідає на інше питання — «що було наступним», —
 * тому бере те, що сталось раніше. Якщо клієнт передзвонив через 3 хв, а ми через 40,
 * то «наступним» був клієнт, і назвати це «ми передзвонили» означало б приписати
 * відділу чужу швидкість.
 */
export function nextStep(r: { cbMin: number | null; cbTalked: boolean | null; csMin: number | null }):
{ kind: NextStep; minutes: number | null } {
  const cb = r.cbMin, cs = r.csMin;
  if (cb != null && (cs == null || cb <= cs)) {
    return { kind: r.cbTalked ? "callback_talked" : "callback_no_answer", minutes: Math.round(cb) };
  }
  if (cs != null) return { kind: "client_self", minutes: Math.round(cs) };
  return { kind: "nothing", minutes: null };
}

/* ─────────────── Блок D · «дзвінок був, а угоди немає» ─────────────── */

export type NoDealState = "unknown" | "has_deal" | "no_deal";
export const NO_DEAL_STATES: readonly NoDealState[] = ["unknown", "has_deal", "no_deal"];

/**
 * 🔴 ТРИ СТАНИ, А НЕ ДВА, І НЕ ОДИН. Правило проєкту: стан, що стверджує причину, не може
 * бути смітником для кількох різних відмов.
 *  - `unknown`  — номер не впізнано серед контактів CRM. Це НЕ «заявку не завели», це
 *                 «ми не знаємо, хто дзвонив». Заміряно 14.09: 51% відповіданих вхідних.
 *  - `has_deal` — клієнт відомий, угода є у вікні.
 *  - `no_deal`  — клієнт відомий, угоди у вікні немає. Найближче до того, що просить лист.
 *
 * ⚠️ СЕНТИНЕЛ: порожній рядок у `client_key` — не ключ. Злити його з `no_deal` означало б
 * записати «ми не знаємо, хто це» у «клієнта знаємо, а заявки нема».
 */
export function noDealState(clientKey: string | null, hasDeal: boolean): NoDealState {
  if (clientKey == null || clientKey.trim() === "") return "unknown";
  return hasDeal ? "has_deal" : "no_deal";
}

/** Той самий вердикт у SQL — дзеркало `noDealState`, звіряється гейтом `#448`. */
const NO_DEAL_STATE_SQL = (a: string, deal: string): string =>
  `CASE WHEN ${a}.client_key IS NULL OR btrim(${a}.client_key) = '' THEN 'unknown'`
  + ` WHEN ${deal}.kommo_id IS NOT NULL THEN 'has_deal' ELSE 'no_deal' END`;

/**
 * Основа блоку D: ВІДПОВІДАНІ вхідні, склеєні.
 *
 * 🔴 Звуження до вхідних і до `billsec > 0` — ДО склейки, з тієї самої причини, що в
 * `baseCte`: `call_type` не входить у ключ склейки, і на незвуженому наборі вхідна
 * розмова злилась би з вихідною на той самий номер.
 */
function answeredCte(from: string, to: string, s: MissedScope): { cte: string; params: unknown[] } {
  const p: unknown[] = [from, to];
  const conds = [
    "(rc.calldate AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1 AND $2",
    `rc.call_type IN (${list(INBOUND_TYPES)})`,
    "rc.billsec > 0",
  ];
  if (s.managerId) { p.push(s.managerId); conds.push(`rc.manager_id = $${p.length}`); }
  if (s.teamId) { p.push(s.teamId); conds.push(`m.team_id = $${p.length}`); }
  const cte = `
    WITH base AS (
      SELECT rc.uniqueid, rc.manager_id, rc.client_phone, rc.client_key, rc.calldate, rc.billsec
        FROM ringostat_calls rc
        LEFT JOIN managers m ON m.id = rc.manager_id
       WHERE ${conds.join(" AND ")}
    ),
    marked AS (SELECT b.*, ${mergedLagGapExpr("b")} AS gap FROM base b),
    legs AS (SELECT * FROM marked WHERE ${mergedLagFirst()}),
    classed AS (
      SELECT a.*, dl.kommo_id AS deal_id, ${NO_DEAL_STATE_SQL("a", "dl")} AS state
        FROM legs a
        ${dealInWindowLateral("a")}
    )`;
  return { cte, params: p };
}

/** Три числа й ціле — ОДНИМ запитом, щоб частини й сума бралися в одну мить живої таблиці. */
export function noDealCountsSql(from: string, to: string, s: MissedScope): { sql: string; params: unknown[] } {
  const { cte, params } = answeredCte(from, to, s);
  const sql = `${cte}
    SELECT COUNT(*)::int AS answered,
           COUNT(*) FILTER (WHERE state = 'unknown')::int  AS unknown,
           COUNT(*) FILTER (WHERE state = 'has_deal')::int AS has_deal,
           COUNT(*) FILTER (WHERE state = 'no_deal')::int  AS no_deal
      FROM classed`;
  return { sql, params };
}

/** Розкриття одного стану — ТОЙ САМИЙ `classed`, що й числа (правило «розкриття = число»). */
export function noDealListSql(from: string, to: string, s: MissedScope, state: NoDealState): { sql: string; params: unknown[] } {
  const { cte, params } = answeredCte(from, to, s);
  params.push(state);
  const sql = `${cte}
    SELECT c.uniqueid,
           to_char(c.calldate AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD HH24:MI') AS at,
           c.client_phone, c.client_key, c.manager_id, mg.name AS manager_name,
           c.billsec, c.deal_id
      FROM classed c
      LEFT JOIN managers mg ON mg.id = c.manager_id
     WHERE c.state = $${params.length}
     ORDER BY c.calldate DESC, c.uniqueid
     LIMIT ${MISSED_LIST_LIMIT}`;
  return { sql, params };
}
