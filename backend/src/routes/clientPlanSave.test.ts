import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

const load = async () => ({ pool: (await import("../db/pool.js")).pool });

/**
 * #279i — САМЕ ЦЕЙ ЗАПИТ ПРОТИ ЖИВОЇ БД, І НІЧОГО ІНШОГО.
 *
 * 📐 Куплено аварією, яка стояла пʼять тижнів. `POST /client-plan` віддавав 500 на
 * КОЖНОМУ збереженні від 29.07.2026 — дня, коли `LoyaltySection` переїхав із мертвої
 * сітки `RepeatPlanGrid` на `ClientPlansSection`. Причина: `inconsistent types deduced
 * for parameter $6` — помилка РОЗБОРУ, тобто запит падав завжди, за будь-яких значень
 * і будь-якої ролі. Наслідки в базі: за серпень і вересень НУЛЬ рядків, чернеток не
 * існує в принципі, «Подати» сіра назавжди.
 *
 * 🔴 ЧОМУ ГЕЙТ БʼЄ ПО БД, А НЕ ПО ФУНКЦІЇ. Помилку видно ЛИШЕ серверу Postgres на
 * розборі: жоден юніт-тест, жодна перевірка типів TypeScript і жодне читання коду її
 * не дають — обидві колонки `integer`, і текст запиту виглядає бездоганно. Той самий
 * клас, що `#279e`: контракт між кодом і живою схемою перевіряється лише на живому.
 *
 * ⚠️ Транзакція з `ROLLBACK`: гейт нічого не лишає в проді. Помилка розбору виникає
 * ДО виконання, тож для доказу запис і не потрібен.
 */
test("#279i UPSERT плану клієнта РОЗБИРАЄТЬСЯ живою БД (parse, не дані)", needsDb(), async () => {
  const { pool } = await load();
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await cl.query(
      `INSERT INTO repeat_client_plans (client_key, month, manager_id, plan, status, updated_by, updated_at,
                                        approved_by, approved_at, submitted_at, returned_at, review_note)
       VALUES ($1,$2,$3,$4,$5,$6::int, now(), CASE WHEN $5='approved' THEN $6::int END,
               CASE WHEN $5='approved' THEN now() END, NULL, NULL, NULL)
       ON CONFLICT (client_key, month) DO UPDATE SET
         plan = EXCLUDED.plan, status = EXCLUDED.status,
         updated_by = EXCLUDED.updated_by, updated_at = now(),
         approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
         submitted_at = NULL, returned_at = NULL, review_note = NULL`,
      ["гейт-279i-неіснуючий", "2099-01-01", null, 1, "draft", 1]);
  } catch (e) {
    assert.fail(`🔴 UPSERT плану не розібрався живою БД: ${(e as Error).message}. `
      + "Саме так екран «Клієнти та реактивація» мовчки не зберігав нічого пʼять тижнів.");
  } finally { await cl.query("ROLLBACK"); cl.release(); }
});

/**
 * #279j — ДЗЕРКАЛО: гейт вище ВМІЄ спрацювати.
 *
 * Без нього `#279i` зеленів би й тоді, коли перевіряти нема чого: будь-який синтаксично
 * правильний запит проходить. Тут навмисно ТОЙ САМИЙ вираз БЕЗ приведення — він мусить
 * упасти рівно з тим текстом, який ми ловимо. Це і є доказ, що зелене `#279i` означає
 * «приведення на місці», а не «БД приймає будь-що».
 */
test("#279j 🪞 ДЗЕРКАЛО: без ::int той самий запит НЕ розбирається", needsDb(), async () => {
  const { pool } = await load();
  const cl = await pool.connect();
  let msg = "";
  try {
    await cl.query("BEGIN");
    await cl.query(
      `INSERT INTO repeat_client_plans (client_key, month, manager_id, plan, status, updated_by, updated_at,
                                        approved_by, approved_at, submitted_at, returned_at, review_note)
       VALUES ($1,$2,$3,$4,$5,$6, now(), CASE WHEN $5='approved' THEN $6 END,
               CASE WHEN $5='approved' THEN now() END, NULL, NULL, NULL)`,
      ["гейт-279j-неіснуючий", "2099-01-01", null, 1, "draft", 1]);
  } catch (e) { msg = (e as Error).message; }
  finally { await cl.query("ROLLBACK"); cl.release(); }
  assert.match(msg, /inconsistent types|parameter \$6/i,
    `🔴 версія БЕЗ приведення пройшла (повідомлення: «${msg}») — отже #279i доводить не те, `
    + "що ми думаємо, і наступний такий дефект пройде повз нього");
});
