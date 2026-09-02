import test from "node:test";
import assert from "node:assert/strict";
import { needsBackendEnv } from "../testMode.js";
import { mergedLagGapExpr, mergedLagFirst, mergedNotExists, CALL_MERGE_WINDOW } from "./callMerge.js";

/**
 * 📞 #26l / #26m — ОДНЕ ОЗНАЧЕННЯ ДЗВІНКА НА ТРИ МІСЦЯ.
 *
 * 🔴 ЧОМУ СТАРІ ГЕЙТИ МОВЧАЛИ, І ЧОМУ ЦІ ЗРОБЛЕНІ ІНАКШЕ. `#63`/`#63b` переписують
 * LAG-SQL ІНЛАЙНОМ у власному тест-файлі (`routes/callMerge.test.ts`), тобто
 * доводять, що ПРАВИЛО працює на даних, — але не що ПРОДУКТ його вживає. Саботаж
 * вікна `${CALL_MERGE_WINDOW}` у `reportCuts.ts` лишив би їх зеленими; розбіжність
 * між двома склеєними формами вони не бачать у принципі, бо кожну звіряють лише з
 * СИРИМ числом, а меншими за сире чесно є обидві. Клас `#280b`/`#214c`: перевірка з
 * власною копією сліпа за побудовою.
 *
 * Тому обидва гейти нижче будують SQL **із тих самих експортів, що йдуть у прод**, і
 * стверджують те, чого не стверджує ніхто: дві форми одна проти одної, і період
 * проти суми денних комірок.
 *
 * ⚠️ ВІКНО ЗАМІРУ ВУЗЬКЕ І З НИЖНЬОЮ МЕЖЕЮ — свідомо. Широкий запит по
 * `ringostat_calls` уже входив у дедлок із джобою синку, що пише в ту саму таблицю;
 * нижня межа кладе запит на індекс за `calldate`.
 */

const K = "AT TIME ZONE 'Europe/Kyiv'";
/** Вузьке вікно: сім днів, що закінчились учора — уже не рухається синком «сьогодні». */
const FROM = "2026-08-18", TO = "2026-08-24";

test("#26l ТРИ МІСЦЯ — ОДНЕ ЧИСЛО: дві форми збігаються, період == Σ днів, обидві менші за сире",
  { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");

  /**
   * 🔴 ОДИН ВИКЛИК НА ВСІ ЧОТИРИ ЧИСЛА (правило 18). `ringostat_calls` поповнюється
   * синком щохвилини; узяті окремими запитами, «період» і «сума днів» розійшлися б
   * без жодного дефекту, і ми пішли б шукати його в коді.
   */
  const { rows } = await pool.query<Record<string, string>>(
    `WITH base AS (
       SELECT rc.* FROM ringostat_calls rc JOIN managers m ON m.id = rc.manager_id
        WHERE (rc.calldate ${K})::date BETWEEN $1 AND $2 AND rc.manager_id IS NOT NULL
     ), marked AS (
       SELECT b.*, ${mergedLagGapExpr("b")} AS gap FROM base b
     ), po_dnjah AS (
       SELECT to_char((calldate ${K})::date,'YYYY-MM-DD') AS d, COUNT(*) AS n
         FROM marked WHERE ${mergedLagFirst()} GROUP BY 1
     )
     SELECT (SELECT COUNT(*) FROM base)                                        AS syre,
            (SELECT COUNT(*) FROM marked WHERE ${mergedLagFirst()})            AS lag_forma,
            (SELECT COUNT(*) FROM base r WHERE ${mergedNotExists("r", "base")}) AS ne_forma,
            (SELECT COALESCE(SUM(n),0) FROM po_dnjah)                          AS suma_dniv,
            (SELECT COUNT(*) FROM po_dnjah)                                    AS dniv`,
    [FROM, TO]);

  const n = (k: string) => Number(rows[0][k]);

  // ⓪ Спершу доводимо, що перевірці Є ЩО ЗНАХОДИТИ. Порожнє вікно зробило б усі три
  //    рівності істинними тривіально — «порожньо = ПРОВАЛ».
  assert.ok(n("syre") > 1000 && n("dniv") >= 5,
    `🔴 у вікні ${FROM}…${TO} лише ${n("syre")} записів за ${n("dniv")} днів — вибірка вироджена`);

  // ① ДВІ СКЛЕЄНІ ФОРМИ — ОДНЕ ЧИСЛО. Саме цього не стверджував ніхто: до 02.09.2026
  //    вони розходились на нічиїх (заміряно 128 за 25.07-24.08), і обидві були чесно
  //    меншими за сире, тож `#63` мовчав.
  assert.equal(n("ne_forma"), n("lag_forma"),
    `🔴 форма розкриття дає ${n("ne_forma")}, форма агрегату — ${n("lag_forma")}. Розходяться вони `
    + "рівно на ОДНАКОВИХ позначках часу: Ringostat пише обидва плеча переведеного недодзвону з "
    + "ідентичним calldate. Найпевніша причина — зник розрив нічиєї за uniqueid");

  // ② ПЕРІОД == Σ ДЕННИХ КОМІРОК. Число над таблицею і числа в ній — одна величина.
  assert.equal(n("suma_dniv"), n("lag_forma"),
    `🔴 період ${n("lag_forma")} != сума днів ${n("suma_dniv")}: комірка й підсумок рахують різне`);

  // ③ І обидві СТРОГО менші за сире — інакше склейка не працює, а рівності вище
  //    трималися б на тому, що ніхто нічого не склеює.
  assert.ok(n("lag_forma") < n("syre"),
    `🔴 склейка не прибрала ЖОДНОГО запису (${n("syre")} -> ${n("lag_forma")}) — вона не працює, `
    + "а рівності вище стали б істинними ні про що");
  const прибрано = (1 - n("lag_forma") / n("syre")) * 100;
  assert.ok(прибрано > 1 && прибрано < 25,
    `🔴 склейка прибрала ${прибрано.toFixed(2)}% — поза коридором 1-25% (заміряно 02.09: 7.40% `
    + "разом, 6.19% розмови, 9.03% спроби). Або вікно зламалось, або дані змінили природу");
});

test("#26m ДЗЕРКАЛО НА НІЧИЇЙ: однакові позначки в даних Є, і обидві форми дають на них одне",
  { ...needsBackendEnv() }, async () => {
  /**
   * 🔴 БЕЗ ЦІЄЇ ПОЛОВИНИ `#26l` МОЖЕ СТАТИ ЗЕЛЕНИМ ЧЕРЕЗ ЗНИКНЕННЯ ПРЕДМЕТА. Нічия —
   * єдине місце, де дві форми колись розходились; якщо Ringostat перестане писати
   * плечі з ідентичним `calldate`, рівність у `#26l` триматиметься сама собою, і
   * зникнення розриву нічиєї пройде непоміченим.
   * 📐 Заміряно 02.09.2026: розбіжність двох форм була 128 записів за 25.07-24.08 і
   * 146 за серпень — тобто нічиї не рідкість, а постійний фон.
   */
  const { pool } = await import("../db/pool.js");
  const { rows } = await pool.query<Record<string, string>>(
    `WITH base AS (
       SELECT rc.* FROM ringostat_calls rc JOIN managers m ON m.id = rc.manager_id
        WHERE (rc.calldate ${K})::date BETWEEN $1 AND $2 AND rc.manager_id IS NOT NULL
     ), nichyi AS (
       SELECT b.* FROM base b
        WHERE EXISTS (SELECT 1 FROM base p
                       WHERE p.manager_id = b.manager_id
                         AND p.client_phone IS NOT DISTINCT FROM b.client_phone
                         AND (p.billsec > 0) = (b.billsec > 0)
                         AND p.calldate = b.calldate AND p.uniqueid <> b.uniqueid)
     ), marked AS (SELECT b.*, ${mergedLagGapExpr("b")} AS gap FROM base b)
     SELECT (SELECT COUNT(*) FROM nichyi)                                          AS zapysiv_u_nichyih,
            (SELECT COUNT(DISTINCT (manager_id, client_phone, calldate)) FROM nichyi) AS nichyih,
            (SELECT COUNT(*) FROM marked WHERE ${mergedLagFirst()}
               AND EXISTS (SELECT 1 FROM nichyi x WHERE x.uniqueid = marked.uniqueid)) AS lag_lyshyv,
            (SELECT COUNT(*) FROM nichyi r WHERE ${mergedNotExists("r", "base")})   AS ne_lyshyv`,
    [FROM, TO]);
  const n = (k: string) => Number(rows[0][k]);

  assert.ok(n("nichyih") > 0,
    `🔴 у вікні ${FROM}…${TO} немає ЖОДНОЇ пари з ідентичним calldate — предмет зник, і рівність `
    + "у #26l трималася б сама собою (заміряно 02.09: розбіжність форм була 128 записів)");

  // Обидві форми лишають РІВНО ПО ОДНОМУ запису на кожну нічию — і однаково.
  assert.equal(n("ne_lyshyv"), n("lag_lyshyv"),
    `🔴 на нічиїх форми розійшлись: розкриття лишило ${n("ne_lyshyv")}, агрегат ${n("lag_lyshyv")}`);
  assert.equal(n("ne_lyshyv"), n("nichyih"),
    `🔴 із ${n("zapysiv_u_nichyih")} записів у ${n("nichyih")} нічиїх лишилось ${n("ne_lyshyv")}, `
    + "а мусило рівно по одному на нічию: саме подвійний рахунок власник і побачив на екрані");
});
