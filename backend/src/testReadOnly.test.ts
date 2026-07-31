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
