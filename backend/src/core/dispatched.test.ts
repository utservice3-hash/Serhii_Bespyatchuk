import test from "node:test";
import assert from "node:assert/strict";
import { needsBackendEnv } from "../testMode.js";
import { dispatchedWhere, anchorTravelled, cohortMonth, DISPATCH_ANCHOR } from "./dispatched.js";

/**
 * 🚚 #26j — ЖИВИЙ ГЕЙТ НА ПРЕДИКАТ «ВІДПРАВЛЕНО».
 *
 * 🔴 ЧОМУ ЖИВИЙ, А НЕ НА ФІКСТУРІ. Предикат — це SQL, і єдина його реалізація теж SQL.
 * Друга копія правила в JS заради «чистого» тесту була б рівно тим, від чого ми
 * лікуємось: два означення, що розійдуться мовчки (у цьому проєкті класифікація вже
 * одного разу існувала тричі). Тому перевіряємо ту саму умову, що піде в прод.
 *
 * 🔴 ПРО РЕЄСТР ДОЗВОЛЕНИХ ПРОД-СКІПІВ (DoD 6c): запису НЕ ПОТРІБНО, і це не недогляд.
 * `needsBackendEnv()` скіпає лише там, де немає `DATABASE_URL` або `JWT_SECRET` —
 * тобто в оточенні без `.env`. Саме `JWT_SECRET`, а не лише БД: `db/pool` тягне
 * `config`, і той кидає ще на ІМПОРТІ, тож `needsDb()` тут давав би не скіп, а
 * падіння (спіймано одразу ж). У `test:prod` обидві змінні є завжди, отже
 * скіпнутись там гейт не може в принципі, і дозвіл накривав би стан, який не настає.
 *
 * ⚠️ ІНВАРІАНТ МІРЯЄТЬСЯ ОДНИМ ВИКЛИКОМ — правило 18, куплене на власному прийманні.
 * Знаменник живий: за одну добу серпень зрушив 249 → 250, бо угоди виходять через
 * оплату щогодини. Дві половини рівності, взяті двома запитами, розійшлись би без
 * жодного дефекту, і ми пішли б шукати його в коді.
 */
test("#26j ЖИВИЙ: предикат ріже рівно те, що обіцяє — інваріант одним викликом", { ...needsBackendEnv() }, async () => {
  const { pool } = await import("../db/pool.js");
  const { FC_PIPELINES, STAGE_RECEIVED } = await import("./money.js");
  const { STATUS_LOST } = await import("./moneyBuckets.js");

  const { rows } = await pool.query<Record<string, string>>(
    `WITH t AS (
       SELECT d.* FROM deals d
        WHERE d.pipeline_id = ANY($1)
          AND ${cohortMonth("d")} = date_trunc('month', $2::date)
     )
     SELECT COUNT(*)                                            AS kogorta,
            COUNT(*) FILTER (WHERE ${anchorTravelled("t")})     AS poihaly,
            COUNT(*) FILTER (WHERE ${dispatchedWhere("t", "$3")}) AS vidpravleno,
            COUNT(*) FILTER (WHERE (${anchorTravelled("t")}) AND t.status_id = ANY($3)) AS oplacheni,
            COUNT(*) FILTER (WHERE (${anchorTravelled("t")}) AND t.status_id = $4)      AS zakryti
       FROM t`,
    [FC_PIPELINES, "2026-08-01", STAGE_RECEIVED, STATUS_LOST]);

  const n = (k: string) => Number(rows[0][k]);

  // ⓪ Спершу доводимо, що перевірці Є ЩО ЗНАХОДИТИ: порожня когорта зробила б
  //    рівність істинною тривіально (0 == 0 + 0 + 0) — «порожньо = ПРОВАЛ».
  assert.ok(n("kogorta") > 500 && n("poihaly") > 100,
    `🔴 когорта ${n("kogorta")}, поїхавших ${n("poihaly")} — вибірка вироджена, `
    + "рівність нижче стала б істинною ні про що (заміряно 02.09: 2 768 і 922)");

  // ① ІНВАРІАНТ: «поїхали» розкладаються рівно на три множини без перетину.
  assert.equal(n("vidpravleno") + n("oplacheni") + n("zakryti"), n("poihaly"),
    `🔴 ${n("vidpravleno")} + ${n("oplacheni")} + ${n("zakryti")} != ${n("poihaly")}: множини `
    + "перетинаються або якась угода не потрапила в жодну — предикат ріже не те, що обіцяє");

  // ② Кожен різак СПРАВДІ ріже. Без цього рівність трималась би на нулях, і
  //    прибрана умова лишила б гейт зеленим.
  assert.ok(n("oplacheni") > 0, "🔴 умова «оплата не зайшла» нічого не відкидає — вона мертва");
  assert.ok(n("zakryti") > 0, "🔴 умова «не 143» нічого не відкидає — заміряно 48 таких за серпень");
  assert.ok(n("vidpravleno") > 0, "🔴 після всіх умов не лишилось нічого — предикат ріже все підряд");

  // ③ Межа якоря по ДРУГИЙ бік: дата в майбутньому в даних Є і в «поїхали» не входить.
  //    Без цієї половини зникнення межі пройшло б непоміченим.
  const { rows: f } = await pool.query<{ maybutni: string; z_nyh_poihaly: string }>(
    `WITH t AS (SELECT d.* FROM deals d WHERE d.pipeline_id = ANY($1))
     SELECT COUNT(*) FILTER (WHERE (t.${DISPATCH_ANCHOR} AT TIME ZONE 'Europe/Kyiv')::date
                                   > (now() AT TIME ZONE 'Europe/Kyiv')::date) AS maybutni,
            COUNT(*) FILTER (WHERE (t.${DISPATCH_ANCHOR} AT TIME ZONE 'Europe/Kyiv')::date
                                   > (now() AT TIME ZONE 'Europe/Kyiv')::date
                             AND (${anchorTravelled("t")}))                    AS z_nyh_poihaly
       FROM t`, [FC_PIPELINES]);
  assert.ok(Number(f[0].maybutni) > 0,
    "🔴 у даних немає ЖОДНОЇ дати завантаження в майбутньому — межу «не пізніше сьогодні» "
    + "перевіряти нема на чому (заміряно 02.09: 9 таких угод у поточних етапах)");
  assert.equal(Number(f[0].z_nyh_poihaly), 0,
    `🔴 ${f[0].z_nyh_poihaly} угод із датою завантаження В МАЙБУТНЬОМУ порахувались як поїхавші. `
    + "Машина не могла поїхати датою, яка ще не настала — це уточнення власника від 02.09.2026");
});
