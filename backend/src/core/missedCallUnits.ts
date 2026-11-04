import { INBOUND_TYPES, MISSED_DISPOSITIONS } from "./missedCallsRules.js";

/**
 * 📞 ОДИН ДЗВІНОК КЛІЄНТА = ОДИН ПРОПУЩЕНИЙ (задача 7368, звірка Юлі «дашборд vs Ringostat» 26-28.10.2026).
 *
 * Ringostat пише дзвінок на схему кількома записами: вхідне плече на номер схеми (часто без менеджера) і по
 * `transitin` на кожного, кому схема дзвонила. Поля «id дзвінка» в API немає (перевірено всі 20 колонок, `callMerge`).
 * Досі пропущені склеювались лише В МЕЖАХ ОДНОГО МЕНЕДЖЕРА, тож дзвінок на «Чергування» давав ТРИ пропущені:
 * Михальчевська, Безпамʼятний і «без відповідального». Заміряно 27.10: 180 рядків проти 136 дзвінків.
 *
 * Правило (Юля, звірка: «однаковий номер, різниця до 1 хв, одна схема»):
 *  · ДЗВІНОК — усі вхідні плечі того самого номера, між сусідніми не більше `MISSED_LEG_GAP`;
 *  · РОЗМОВА в будь-якому плечі — дзвінок УЗЯЛИ, він не пропущений. Плече «не відповів» поруч — це інший менеджер,
 *    якому схема дзвонила паралельно (так 03.11 Федькевич отримала 38 задач по чужих, уже взятих дзвінках);
 *  · ВІДПОВІДАЛЬНИЙ — черговий за календарем, якщо дзвінок ішов черговому; двоє чергових, яким дзвонило, —
 *    по черзі в межах дня (Роман 04.11.2026: «рівномірно розподіляти»); інакше перший менеджер, якому дзвонило;
 *    нікому — «без відповідального». Чергового НЕ ставимо на дзвінок, який до нього не йшов: у звірці «без
 *    відповідального» — це питання до тімлідів, а не дашборда, і на такі дзвінки задач не ставимо (рішення 16.09).
 *
 * Повторні наберання тим самим номером (задача, п.2) тут НЕ склеюються: вікно 10 хв проти звірки (1-2 хв) чекає Юлі.
 *
 * 🔴 МОДУЛЬ ЧИСТИЙ (без `pool`): його кличуть і екран (`missedCallsRules`), і задачі (`missedCallSignal`) — одне
 * правило на обидва, щоб число на екрані й задачі «Передзвонити» не розійшлися.
 */

/** Найбільший розрив між сусідніми плечима одного дзвінка. Звірка Юлі: «різниця до 1 хв». */
export const MISSED_LEG_GAP = "60 seconds";

/** Вечірня зміна чергування — «Вечір 18–21» (так підписано в календарі, `routes/duty.ts`). Решта змін — увесь день. */
export const EVENING_DUTY_FROM = "18:00";
export const EVENING_DUTY_UNTIL = "21:00";

const list = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(",");
const KY = "AT TIME ZONE 'Europe/Kyiv'";

/**
 * CTE-фрагменти (без `WITH`): `mcu_legs` → … → `call_units`. `legsWhere` — умова на `rc` (таблиця `ringostat_calls`),
 * що обмежує плечі за часом. Вона мусить брати ЦІЛІ київські доби (з хвилиною запасу з обох боків): черга двох
 * чергових рахується від початку доби, а дзвінок на межі доби — один, а не два.
 *
 * `call_units`: `uniqueid` (перше плече), `calldate` (старт), `client_phone`, `client_key`, `disposition`
 * (`ANSWERED`, якщо говорили; інакше `NO ANSWER` / `BUSY` / вердикт першого плеча), `answered`, `legs`,
 * `manager_id` (відповідальний за правилом вище).
 *
 * ⚠️ Плече без номера клієнта — окремий дзвінок: `PARTITION BY` вважає NULL-и одним кошиком і склеїв би чужих людей.
 */
export function callUnitsCte(legsWhere: string): string {
  const kday = `(g.calldate ${KY})::date`;
  return `
    mcu_legs AS (
      SELECT rc.uniqueid, rc.manager_id, rc.client_phone, rc.client_key, rc.calldate, rc.billsec, rc.disposition,
             COALESCE(rc.client_phone, 'u:' || rc.uniqueid) AS ckey
        FROM ringostat_calls rc
       WHERE rc.call_type IN (${list(INBOUND_TYPES)}) AND ${legsWhere}
    ),
    mcu_brk AS (
      SELECT l.*, CASE WHEN l.calldate - LAG(l.calldate) OVER (PARTITION BY l.ckey ORDER BY l.calldate, l.uniqueid)
                            <= interval '${MISSED_LEG_GAP}' THEN 0 ELSE 1 END AS brk
        FROM mcu_legs l
    ),
    mcu_grp AS (
      SELECT ckey, cid,
             (array_agg(uniqueid ORDER BY calldate, uniqueid))[1] AS uniqueid,
             MIN(calldate) AS calldate, MAX(client_phone) AS client_phone, MAX(client_key) AS client_key,
             bool_or(billsec > 0) AS answered, COUNT(*)::int AS legs,
             CASE WHEN bool_or(billsec > 0) THEN 'ANSWERED'
                  WHEN bool_or(disposition = '${MISSED_DISPOSITIONS[0]}') THEN '${MISSED_DISPOSITIONS[0]}'
                  WHEN bool_or(disposition = '${MISSED_DISPOSITIONS[1]}') THEN '${MISSED_DISPOSITIONS[1]}'
                  ELSE (array_agg(disposition ORDER BY calldate, uniqueid))[1] END AS disposition,
             COALESCE(array_agg(manager_id ORDER BY calldate, uniqueid) FILTER (WHERE manager_id IS NOT NULL), '{}') AS mids
        FROM (SELECT b.*, SUM(b.brk) OVER (PARTITION BY b.ckey ORDER BY b.calldate, b.uniqueid) AS cid FROM mcu_brk b) x
       GROUP BY ckey, cid
    ),
    mcu_pool AS (
      SELECT g.*, ARRAY(
               SELECT ds.manager_id FROM duty_schedule ds
                WHERE ds.duty_date = ${kday} AND ds.manager_id = ANY(g.mids)
                  AND (ds.shift <> 'evening' OR ((g.calldate ${KY})::time >= '${EVENING_DUTY_FROM}' AND (g.calldate ${KY})::time < '${EVENING_DUTY_UNTIL}'))
                GROUP BY ds.manager_id ORDER BY MIN(ds.id)) AS pool
        FROM mcu_grp g
    ),
    call_units AS (
      SELECT p.uniqueid, p.calldate, p.client_phone, p.client_key, p.disposition, p.answered, p.legs,
             CASE WHEN cardinality(p.pool) = 1 THEN p.pool[1]
                  WHEN cardinality(p.pool) > 1 THEN p.pool[1 + ((ROW_NUMBER() OVER (
                         PARTITION BY (p.calldate ${KY})::date, (NOT p.answered AND cardinality(p.pool) > 1)
                         ORDER BY p.calldate, p.uniqueid) - 1) % cardinality(p.pool))::int]
                  ELSE p.mids[1] END AS manager_id
        FROM mcu_pool p
    )`;
}

/** Плечі за київські доби [from, to] з хвилиною запасу з обох боків (див. `callUnitsCte`). `from`/`to` — SQL дати. */
export const legsForDays = (from: string, to: string): string =>
  `rc.calldate >= ((${from})::timestamp ${KY}) - interval '${MISSED_LEG_GAP}'`
  + ` AND rc.calldate < (((${to}) + 1)::timestamp ${KY}) + interval '${MISSED_LEG_GAP}'`;
