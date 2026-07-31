import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi } from "./testMode.js";

/**
 * #13 — САМОПЕРЕВІРКА ЗАПОБІЖНИКА: харнес НЕ МОЖЕ писати в прод.
 *
 * Дзеркальна пара до всього набору: решта тестів доводить, що правильно поводиться
 * ПРОДУКТ; цей доводить, що САМ ХАРНЕС не має права зашкодити. Без нього
 * `--import ./dist/testReadOnly.js` міг би тихо не спрацювати (не той шлях, не той
 * режим), і ми б цього не помітили — рівно клас «мовчазно не виконалось», на якому
 * ми вже горіли тричі.
 */

const load = async () => (await import("./db/pool.js")).pool;

test("#13 ЗАПОБІЖНИК: харнес працює під test_readonly", needsApi(), async () => {
  const pool = await load();
  const who = await pool.query<{ r: string }>("SELECT current_user AS r");
  assert.equal(who.rows[0].r, "test_readonly",
    `🔴 харнес ходить як «${who.rows[0].r}» замість test_readonly — запобіжник НЕ ввімкнувся`);
});

test("#13b ЗАПОБІЖНИК: запис по РЕАЛЬНОМУ рядку падає на ПРАВАХ", needsApi(), async () => {
  const pool = await load();
  const client = await pool.connect();
  try {
    // Ціль — РЕАЛЬНИЙ існуючий id. Неіснуючий довів би менше: «0 рядків» не
    // відрізнити від «заборонено», і тест лишався б зеленим при повністю знятому
    // запобіжнику. Саме такий DELETE по id, що випадково не існував, ми колись і
    // виконали проти прода.
    //
    // Безпечно це рівно тому, що все всередині транзакції, яку ми ГАРАНТОВАНО
    // відкочуємо: навіть якби права раптом були, прод не змінюється. Права — перший
    // рубіж, транзакція — другий; жоден з них не єдиний.
    await client.query("BEGIN");
    const real = await client.query<{ id: number }>("SELECT id FROM monthly_goals ORDER BY id LIMIT 1");
    assert.ok(real.rows[0], "у monthly_goals немає жодного рядка — пробі нема по чому бити");
    const id = real.rows[0].id;

    const cases: [string, string][] = [
      ["DELETE", `DELETE FROM monthly_goals WHERE id = ${id}`],
      ["UPDATE", `UPDATE monthly_goals SET updated_at = updated_at WHERE id = ${id}`],
      ["INSERT", `INSERT INTO job_runs (name) VALUES ('__zzz_probe__')`],
      ["TRUNCATE", `TRUNCATE deals`],
    ];
    for (const [label, sql] of cases) {
      let err: string | null = null;
      await client.query("SAVEPOINT probe");
      try { await client.query(sql); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      await client.query("ROLLBACK TO SAVEPOINT probe");
      assert.ok(err, `🔴 ${label} по РЕАЛЬНІЙ цілі ВИКОНАВСЯ — харнес має право на запис у прод`);
      assert.match(err, /permission denied|read-only|доступ/i,
        `${label} впав, але НЕ на правах — це інша причина, запобіжник не доведено: ${err}`);
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});

test("#13c ДЗЕРКАЛО: читання під роллю ПРАЦЮЄ (інакше набір осліп)", needsApi(), async () => {
  const pool = await load();
  // Без цієї пари #13b зеленів би і тоді, коли ролі відібрали взагалі все: «жоден
  // запит не проходить» виглядало б як «запис надійно заборонено», а весь набір
  // мовчки перестав би щось перевіряти. Заборона доводиться лише разом із дозволом.
  const r = await pool.query<{ n: string }>("SELECT COUNT(*)::int AS n FROM deals");
  assert.ok(Number(r.rows[0].n) > 0,
    "🔴 під test_readonly не читаються навіть угоди — роль зарізана надто сильно, набір нічого не перевіряє");
});

/**
 * #14 — САМ ГЕЙТ У `db/pool.ts`. Це БОЙОВИЙ код, тож він має бути перевірений в
 * обидва боки: спрацьовує в тесті — і НЕ втручається в прод. Функція приймає env
 * параметром саме заради цього: інакше перевірити «а що буде в проді» можна було б
 * лише зупинивши прод.
 */
const guard = async () => (await import("./db/readOnlyGuard.js")).assertTestHarnessReadOnly;

test("#14 ГЕЙТ ІНЕРТНИЙ У ПРОДІ: без TEST_SCOPE не втручається", async () => {
  const assertGuard = await guard();
  // Найважливіше твердження файлу: бойовий процес не має ні падати, ні вимагати роль.
  assertGuard({ DATABASE_URL: "postgres://u@h/db" } as NodeJS.ProcessEnv);
  assertGuard({} as NodeJS.ProcessEnv);
  assertGuard({ TEST_SCOPE: "local", DATABASE_URL: "postgres://u@h/db" } as NodeJS.ProcessEnv);
});

test("#14b ГЕЙТ ЛОВИТЬ обхід `TEST_SCOPE=prod npm test`", async () => {
  const assertGuard = await guard();
  // Саме ця команда стояла в доках і обходила запобіжник: preload не виконується,
  // набір іде в бойову базу з повними правами.
  assert.throws(() => assertGuard({ TEST_SCOPE: "prod", DATABASE_URL: "postgres://u@h/db" } as NodeJS.ProcessEnv),
    /НЕ під роллю test_readonly/);
  assert.throws(() => assertGuard({ TEST_SCOPE: "prod", PGOPTIONS: "-c role=neondb_owner" } as NodeJS.ProcessEnv),
    /НЕ під роллю test_readonly/);
});

test("#14c ДЗЕРКАЛО: з правильним PGOPTIONS гейт пропускає", async () => {
  const assertGuard = await guard();
  // Без цієї пари гейт міг би кидати ЗАВЖДИ — і `test:prod` став би непрацездатним,
  // а ми б читали це як «запобіжник надійний».
  assertGuard({ TEST_SCOPE: "prod", PGOPTIONS: "-c role=test_readonly",
    DATABASE_URL: "postgres://u@h/db" } as NodeJS.ProcessEnv);
});

test("#14d ГЕЙТ ловить підміну через options= у DATABASE_URL", async () => {
  const assertGuard = await guard();
  // `options=` у рядку підключення має пріоритет над PGOPTIONS і мовчки скасував би роль.
  assert.throws(() => assertGuard({ TEST_SCOPE: "prod", PGOPTIONS: "-c role=test_readonly",
    DATABASE_URL: "postgres://u@h/db?sslmode=require&options=-c%20role%3Dneondb_owner" } as NodeJS.ProcessEnv),
    /options=/);
});
