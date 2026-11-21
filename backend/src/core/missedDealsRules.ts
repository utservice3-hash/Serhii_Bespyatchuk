import { missedScopeConds, OUTBOUND_TYPES, INBOUND_TYPES, CALLBACK_MIN_TALK_SEC, OWNERLESS_LABEL, type MissedScope } from "./missedCallsRules.js";
import { MISSED_LEG_GAP } from "./missedCallUnits.js";
import { carrierCallSql } from "./carrierPhones.js";
import { NOT_CLIENT_PIPELINES } from "./carrierHistory.js";
import { teamAtSql } from "./teamAt.js";

/**
 * 📄 ПРОПУЩЕНІ УГОДИ — окрема вкладка екрана «Пропущені дзвінки» (рішення Романа 20.11.2026, «правильні пропущені» п.5:
 * «через 5 хвилин, якщо не було нового дзвінка, була угода»). Правило в словнику — §11a.
 *
 * ПРАВИЛО (Роман 20.11.2026 погодився з рекомендаціями плану `plans/missed-calls-plan.md`, питання 2-5):
 *  · ОДИНИЦЯ — угода Kommo, яку створив вхідний дзвінок: на номер угоди (цифри назви або телефон контакту угоди) є
 *    вхідне плече за `TRIGGER_BEFORE` до створення … `TRIGGER_AFTER` після. Заміряно 13-19.11.2026: Kommo створює угоду
 *    на вхідний дзвінок одразу (252 з 253 — за хвилину), тож «5 хвилин» — не очікування угоди, а вікно «чи хтось встиг».
 *  · ПРОПУЩЕНА — за `MISSED_DEAL_WINDOW` від першого плеча (t0) з номером не було ЖОДНОЇ розмови (плече з `billsec > 0`)
 *    і ЖОДНОГО нового дзвінка: ні нашого вихідного (будь-якого, навіть без відповіді), ні нового вхідного пізніше за
 *    склейку плечей одного дзвінка (`MISSED_LEG_GAP`, 1 хв — інакше паралельні плечі того самого дзвінка читались би
 *    «новим дзвінком»).
 *  · ПЕРЕВІЗНИКИ — поза підрахунком, той самий довідник, що для пропущених дзвінків (`carrier_phones`); число — підписом.
 *  · ВІДПОВІДАЛЬНИЙ — відповідальний за угоду в Kommo (`deals.manager_id`); команда — на день створення угоди.
 *  · Угода, якій ще не минуло 5 хв, — «ще рахується», а не «пропущена» і не «встигли».
 *  · Воронки перевізника (`NOT_CLIENT_PIPELINES`) — не угоди замовника, їх тут немає.
 *
 * Модуль чистий (без `pool`): гейти ганяють SQL на своєму кластері.
 */

export const MISSED_DEAL_WINDOW = "5 minutes";
export const TRIGGER_BEFORE = "2 minutes";
export const TRIGGER_AFTER = "1 minute";
export const MISSED_DEALS_LIST_LIMIT = 1000;

const list = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(",");

/**
 * Основа: по рядку на угоду, створену вхідним дзвінком за київські дні [$1, $2]. `$3` — «зараз» (для «ще не минуло 5 хв»).
 * Колонки: kommo_id, manager_id, team_at, phone, t0, calldate (= створення угоди, по ній кламп команди), is_carrier,
 * pending, reached, talk_at (перша розмова від 10 с після t0), out_at (перший наш вихідний після t0).
 *
 * 🔴 СКОУП — ТОЙ САМИЙ `missedScopeConds`, що в пропущених дзвінках (аліаси `rc` і `m` навмисно ті самі): менеджер бачить
 * свої угоди, тімлід — команди на день створення, «Без відповідального» — угоди без менеджера.
 */
export function missedDealsCte(from: string, to: string, s: MissedScope, nowIso: string): { cte: string; params: unknown[] } {
  const p: unknown[] = [from, to, nowIso];
  const conds = missedScopeConds(s, p);
  const cte = `
    WITH dd AS (
      SELECT d.kommo_id, d.manager_id, d.created_at_kommo, d.name
        FROM deals d
       WHERE (d.created_at_kommo AT TIME ZONE 'Europe/Kyiv')::date BETWEEN $1::date AND $2::date
         AND (d.pipeline_id IS NULL OR d.pipeline_id <> ALL (ARRAY[${NOT_CLIENT_PIPELINES.join(",")}]::bigint[]))
    ),
    ph AS (
      SELECT dd.kommo_id, regexp_replace(dd.name, '\\D', '', 'g') AS phone FROM dd
       WHERE regexp_replace(dd.name, '\\D', '', 'g') ~ '^380[0-9]{9}$'
      UNION
      SELECT dd.kommo_id, cp.phone FROM dd
        JOIN deal_contacts dc ON dc.deal_kommo_id = dd.kommo_id
        JOIN contact_phones cp ON cp.contact_id = dc.contact_id
    ),
    trig AS (
      SELECT DISTINCT ON (dd.kommo_id) dd.kommo_id, dd.manager_id, dd.created_at_kommo AS calldate,
             c.client_phone AS phone, c.calldate AS t0
        FROM dd JOIN ph ON ph.kommo_id = dd.kommo_id
        JOIN ringostat_calls c ON c.client_phone = ph.phone AND c.call_type IN (${list(INBOUND_TYPES)})
         AND c.calldate >= dd.created_at_kommo - interval '${TRIGGER_BEFORE}'
         AND c.calldate <= dd.created_at_kommo + interval '${TRIGGER_AFTER}'
       ORDER BY dd.kommo_id, c.calldate, c.uniqueid
    ),
    md AS (
      SELECT rc.kommo_id, rc.manager_id, rc.phone, rc.t0, rc.calldate,
             ${teamAtSql("m", "(rc.calldate AT TIME ZONE 'Europe/Kyiv')::date")} AS team_at,
             (${carrierCallSql("x")}) AS is_carrier,
             (rc.t0 + interval '${MISSED_DEAL_WINDOW}' > $3::timestamptz) AS pending,
             EXISTS (SELECT 1 FROM ringostat_calls o
                      WHERE o.client_phone = rc.phone
                        AND o.calldate >= rc.t0 AND o.calldate <= rc.t0 + interval '${MISSED_DEAL_WINDOW}'
                        AND (o.billsec > 0 OR o.call_type IN (${list(OUTBOUND_TYPES)})
                             OR o.calldate > rc.t0 + interval '${MISSED_LEG_GAP}')) AS reached,
             (SELECT MIN(o.calldate) FROM ringostat_calls o
               WHERE o.client_phone = rc.phone AND o.billsec >= ${String(CALLBACK_MIN_TALK_SEC)} AND o.calldate > rc.t0) AS talk_at,
             (SELECT MIN(o.calldate) FROM ringostat_calls o
               WHERE o.client_phone = rc.phone AND o.call_type IN (${list(OUTBOUND_TYPES)}) AND o.calldate > rc.t0) AS out_at
        FROM trig rc
        CROSS JOIN LATERAL (SELECT rc.phone AS client_phone) x
        LEFT JOIN managers m ON m.id = rc.manager_id
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
    )`;
  return { cte, params: p };
}

/** Умова «пропущена угода» над `md` — одна на підсумок, таблицю і список. */
export const MISSED_DEAL_SQL = "NOT is_carrier AND NOT pending AND NOT reached";
/** Угода, що рахується в знаменнику: не перевізник і 5 хв уже минуло. */
export const COUNTED_DEAL_SQL = "NOT is_carrier AND NOT pending";

/** Підсумок вкладки — усе одним оператором (правило 18: ціле й частини в одну мить). */
export function missedDealsSummarySql(from: string, to: string, s: MissedScope, nowIso: string): { sql: string; params: unknown[] } {
  const { cte, params } = missedDealsCte(from, to, s, nowIso);
  const sql = `${cte}
    SELECT COUNT(*) FILTER (WHERE ${COUNTED_DEAL_SQL})::int AS deals,
           COUNT(*) FILTER (WHERE ${MISSED_DEAL_SQL})::int AS missed,
           COUNT(*) FILTER (WHERE ${MISSED_DEAL_SQL} AND talk_at IS NOT NULL)::int AS talked_later,
           COUNT(*) FILTER (WHERE ${MISSED_DEAL_SQL} AND manager_id IS NULL)::int AS ownerless,
           COUNT(*) FILTER (WHERE is_carrier)::int AS carriers,
           COUNT(*) FILTER (WHERE NOT is_carrier AND pending)::int AS pending
      FROM md`;
  return { sql, params };
}

/** По менеджерах: угоди з дзвінка і пропущені. Рядок без відповідального — звичайний рядок із `null`. */
export function missedDealsByManagerSql(from: string, to: string, s: MissedScope, nowIso: string): { sql: string; params: unknown[] } {
  const { cte, params } = missedDealsCte(from, to, s, nowIso);
  const sql = `${cte}
    SELECT md.manager_id, MAX(mg.name) AS name, MAX(md.team_at) AS team_id, MAX(t.name) AS team_name,
           COUNT(*) FILTER (WHERE ${COUNTED_DEAL_SQL})::int AS deals,
           COUNT(*) FILTER (WHERE ${MISSED_DEAL_SQL})::int AS missed,
           COUNT(*) FILTER (WHERE ${MISSED_DEAL_SQL} AND talk_at IS NOT NULL)::int AS talked_later
      FROM md
      LEFT JOIN managers mg ON mg.id = md.manager_id
      LEFT JOIN teams t ON t.id = md.team_at
     WHERE ${COUNTED_DEAL_SQL}
     GROUP BY md.manager_id`;
  return { sql, params };
}

/** Список пропущених угод — тим самим виразом, що число (розкриття пояснює число, а не сперечається з ним). */
export function missedDealsListSql(from: string, to: string, s: MissedScope, nowIso: string): { sql: string; params: unknown[] } {
  const { cte, params } = missedDealsCte(from, to, s, nowIso);
  const sql = `${cte}
    SELECT md.kommo_id, to_char(md.t0 AT TIME ZONE 'Europe/Kyiv', 'DD.MM HH24:MI') AS at, md.phone, md.manager_id,
           mg.name AS manager_name, t.name AS team_name,
           EXTRACT(EPOCH FROM (md.talk_at - md.t0))/60.0 AS talk_min,
           EXTRACT(EPOCH FROM (md.out_at - md.t0))/60.0 AS out_min
      FROM md
      LEFT JOIN managers mg ON mg.id = md.manager_id
      LEFT JOIN teams t ON t.id = md.team_at
     WHERE ${MISSED_DEAL_SQL}
     ORDER BY md.t0 DESC, md.kommo_id
     LIMIT ${String(MISSED_DEALS_LIST_LIMIT + 1)}`;
  return { sql, params };
}

export type MissedDealNext = "talked" | "attempt" | "nothing";
/** «Що далі» в рядку: розмова від 10 с (коли), лише наш набір без розмови, або нічого досі. */
export function missedDealNext(talkMin: number | null, outMin: number | null): { kind: MissedDealNext; minutes: number | null } {
  if (talkMin != null) return { kind: "talked", minutes: Math.round(talkMin) };
  if (outMin != null) return { kind: "attempt", minutes: Math.round(outMin) };
  return { kind: "nothing", minutes: null };
}

export const missedDealManagerName = (managerId: number | null, name: string | null): string =>
  managerId == null ? OWNERLESS_LABEL : (name ?? `#${String(managerId)}`);
