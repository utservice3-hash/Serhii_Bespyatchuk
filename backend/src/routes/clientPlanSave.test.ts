import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

const load = async () => ({ pool: (await import("../db/pool.js")).pool });

/**
 * Текст UPSERT-а плану клієнта — рівно той, що в `POST /client-plan`. Приведення
 * підставляється параметром, щоб дзеркало `#279j` перевіряло ТОЙ САМИЙ вираз, а не
 * схожий: розбіжність між копіями зробила б обидва гейти доказом про різні запити.
 */
const upsertSql = (cast: string): string =>
  `INSERT INTO repeat_client_plans (client_key, month, manager_id, plan, status, updated_by, updated_at,
                                    approved_by, approved_at, submitted_at, returned_at, review_note)
   VALUES ($1,$2,$3,$4,$5,$6${cast}, now(), CASE WHEN $5='approved' THEN $6${cast} END,
           CASE WHEN $5='approved' THEN now() END, NULL, NULL, NULL)
   ON CONFLICT (client_key, month) DO UPDATE SET
     plan = EXCLUDED.plan, status = EXCLUDED.status,
     updated_by = EXCLUDED.updated_by, updated_at = now(),
     approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
     submitted_at = NULL, returned_at = NULL, review_note = NULL`;

/**
 * 🔴 РОЗБІР, А НЕ ВИКОНАННЯ — І ЦЕ КУПЛЕНО ВЛАСНИМ ПРОГОНОМ 04.09.2026.
 *
 * Перша редакція цих гейтів ВИКОНУВАЛА `INSERT` у транзакції з `ROLLBACK`. Проти
 * дев-бази вона зелена, а проти бойової — ні: харнес там ходить під роллю
 * `test_readonly` (`testReadOnly.ts` ставить `PGOPTIONS=-c role=test_readonly`), і
 * виконання впирається в `permission denied for table repeat_client_plans`. Тобто
 * гейт червонів би на КОЖНОМУ прод-прийманні, і не через дефект, а через права.
 *
 * 📐 Асиметрія, яка це виявила: дзеркало було ЗЕЛЕНЕ, а основний гейт ЧЕРВОНИЙ.
 * Пояснення просте, щойно його побачиш: зламаний текст помирає на РОЗБОРІ (`42P08`)
 * ще до перевірки прав, а виправлений розбір проходить і впирається вже в права.
 * Один і той самий запит, дві різні стадії — і два протилежні кольори.
 *
 * ✅ `PREPARE` знімає це за побудовою: сервер робить розбір і вивід типів, але нічого
 * не виконує, тож права на запис не потрібні. Заміряно на проді під `test_readonly`:
 * без приведення → `42P08`, з приведенням → розбір проходить. Це рівно те розрізнення,
 * заради якого гейт існує.
 *
 * ⚠️ ЧОГО `PREPARE` НЕ ДОВОДИТЬ, і це записано навмисно: усього, що трапляється на
 * ВИКОНАННІ — обмежень, тригерів, прав. Гейт про вивід типу параметра, і його назва
 * каже саме це. Ловити виконанням тут нічого: помилка була на розборі.
 */

/**
 * 📐 `DEALLOCATE` ОБОВʼЯЗКОВИЙ І ЯВНИЙ — заміряно 04.09.2026 на проді (PostgreSQL 18.6):
 * підготовлений запит **переживає `ROLLBACK`**. Зʼєднання повертається в пул живим, тож
 * лишений слід дав би на наступному прогоні `42P05 prepared statement already exists` —
 * хибне червоне, яке списали б на будь-що, крім справжньої причини. Знімаємо і ПЕРЕД
 * (сесія могла прийти з пулу забрудненою), і в `finally`.
 */
const clean = async (cl: { query: (q: string) => Promise<unknown> }, name: string): Promise<void> => {
  try { await cl.query(`DEALLOCATE ${name}`); } catch { /* не існує — саме те, чого й хочемо */ }
};

test("#279i UPSERT плану клієнта РОЗБИРАЄТЬСЯ живою БД (parse, не дані)", needsDb(), async () => {
  const { pool } = await load();
  const cl = await pool.connect();
  await clean(cl, "gate_279i");
  try {
    await cl.query(`PREPARE gate_279i AS ${upsertSql("::int")}`);
  } catch (e) {
    assert.fail(`🔴 UPSERT плану не розібрався живою БД: ${(e as Error).message}. `
      + "Саме так екран «Клієнти та реактивація» мовчки не зберігав нічого пʼять тижнів.");
  } finally { await clean(cl, "gate_279i"); cl.release(); }
});

/**
 * #279j — ДЗЕРКАЛО: гейт вище ВМІЄ спрацювати.
 *
 * Без нього `#279i` зеленів би й тоді, коли перевіряти нема чого: будь-який синтаксично
 * правильний запит розбирається. Тут навмисно ТОЙ САМИЙ вираз БЕЗ приведення — він мусить
 * упасти рівно з тим текстом, який ми ловимо.
 *
 * 🔴 Твердження подвійне — КОД і ТЕКСТ. Код `42P08` — це змістова межа: «параметру не
 * вивелись узгоджені типи». Сама лише перевірка тексту зеленіла б на БУДЬ-ЯКІЙ відмові —
 * і саме так дзеркало було зеленим тоді, коли основний гейт падав через права.
 */
test("#279j 🪞 ДЗЕРКАЛО: без ::int той самий запит НЕ розбирається", needsDb(), async () => {
  const { pool } = await load();
  const cl = await pool.connect();
  await clean(cl, "gate_279j");
  let msg = "";
  let code = "";
  try {
    await cl.query(`PREPARE gate_279j AS ${upsertSql("")}`);
  } catch (e) {
    msg = (e as Error).message;
    code = String((e as { code?: unknown }).code ?? "");
  } finally { await clean(cl, "gate_279j"); cl.release(); }
  assert.equal(code, "42P08",
    `🔴 версія БЕЗ приведення впала не на виводі типів, а з кодом «${code}» («${msg}») — `
    + "дзеркало зеленіло б на будь-якій відмові, зокрема на правах, і нічого не доводило б");
  assert.match(msg, /inconsistent types|parameter \$6/i,
    `🔴 версія БЕЗ приведення пройшла (повідомлення: «${msg}») — отже #279i доводить не те, `
    + "що ми думаємо, і наступний такий дефект пройде повз нього");
});
