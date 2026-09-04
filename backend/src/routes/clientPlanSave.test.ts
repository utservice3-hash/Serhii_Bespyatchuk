import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";

const load = async () => ({ pool: (await import("../db/pool.js")).pool });

/**
 * Текст UPSERT-а плану клієнта — рівно той, що в `POST /client-plan`. Приведення
 * підставляється параметром, щоб дзеркало `#279j` перевіряло ТОЙ САМИЙ вираз, а не
 * схожий: розбіжність між копіями зробила б обидва гейти доказом про різні запити.
 *
 * 🧾 БОРГ, НАЗВАНИЙ ВГОЛОС: це ВЛАСНА КОПІЯ, а не джерело роута. Отже саботаж у
 * `dashboard.ts` цих гейтів НЕ почервонить — вони стережуть текст, а не роут. Копія
 * вже одного разу розійшлась (у роуті `DO UPDATE` мав `manager_id = COALESCE(...)`,
 * тут його не було). Лікується це не пильністю, а винесенням SQL в іменовану
 * константу поруч із `SUBMIT_SQL`/`RETURN_SQL` у `clientPlanRules.ts` — урок `#21c`:
 * доказ на переписаному вручну тексті є доказом ні про що. Окремий прохід, окремий коміт.
 */
const upsertSql = (cast: string): string =>
  `INSERT INTO repeat_client_plans (client_key, month, manager_id, plan, status, updated_by, updated_at,
                                    approved_by, approved_at, submitted_at, returned_at, review_note)
   VALUES ($1,$2,$3,$4,$5,$6${cast}, now(), CASE WHEN $5='approved' THEN $6${cast} END,
           CASE WHEN $5='approved' THEN now() END, NULL, NULL, NULL)
   ON CONFLICT (client_key, month) DO UPDATE SET
     plan = EXCLUDED.plan, status = EXCLUDED.status,
     manager_id = COALESCE(repeat_client_plans.manager_id, EXCLUDED.manager_id),
     updated_by = EXCLUDED.updated_by, updated_at = now(),
     approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
     submitted_at = NULL, returned_at = NULL, review_note = NULL`;

const VALUES = ["гейт-279-неіснуючий", "2099-01-01", null, 1, "draft", 1];

/**
 * 🔴 ЛІКУЄМО `catch`, А НЕ ПРОБУ — І ЦЕ КУПЛЕНО ВЛАСНОЮ ПОМИЛКОЮ 04.09.2026.
 *
 * Гейт виконує справжній запит у транзакції з `ROLLBACK`. Проти бойової бази харнес
 * ходить під роллю `test_readonly`, тож виконання впирається в `permission denied`, і
 * перша редакція трактувала це як провал продукту — тобто гейт червонів би на КОЖНОМУ
 * `npm run test:prod`, і не через дефект, а через права.
 *
 * ⚠️ Першою спробою я замінив виконання на `PREPARE` — і це було ГІРШЕ за хворобу.
 * `PREPARE` робить розбір і вивід типів, але НЕ планує; а арбітражний індекс для
 * `ON CONFLICT` добирає саме планувальник. Тобто перехід мовчки зняв покриття, яке в
 * гейта БУЛО, — рівно той клас «зелений завдяки дірці», від якого ми йдемо.
 *
 * 📐 ЗАМІРЯНО на проді (PG 18.6, роль `test_readonly`), і саме ці три рядки визначають
 * правило нижче:
 *   здоровий UPSERT              → 42501  (дійшло до ПРАВ, тобто розбір і план пройшли)
 *   зниклий арбітражний індекс   → 42P10  (ПЛАНУВАЛЬНИК спрацював раніше за права)
 *   розбіжна арність значень     → 08P01  (BIND спрацював раніше за права)
 *
 * ✅ Звідси межа: `42501` — це «дійшли до кінця перевіряного», тобто ЗЕЛЕНЕ. Будь-який
 * інший код — ЧЕРВОНЕ з названим кодом. Так гейт тримає всі три класи (тип параметра,
 * арбітражний індекс, арність) і водночас не червоніє від власної ролі.
 *
 * ⚠️ Чого гейт не доводить і ніколи не доводив: що запис СПРАВДІ відбувається. Під
 * read-only він спиняється на правах — це названо, а не замовчано.
 */
test("#279i UPSERT плану клієнта РОЗБИРАЄТЬСЯ живою БД (parse, не дані)", needsDb(), async () => {
  const { pool } = await load();
  const cl = await pool.connect();
  let code = "";
  let msg = "";
  try {
    await cl.query("BEGIN");
    await cl.query(upsertSql("::int"), VALUES);
  } catch (e) {
    code = String((e as { code?: unknown }).code ?? "");
    msg = (e as Error).message;
  } finally { await cl.query("ROLLBACK"); cl.release(); }
  assert.ok(code === "" || code === "42501",
    `🔴 UPSERT плану не дійшов до виконання: ${code} ${msg}. `
    + "Саме так екран «Клієнти та реактивація» мовчки не зберігав нічого пʼять тижнів. "
    + "(42501 — це НЕ дефект: під роллю test_readonly ми спиняємось на правах, "
    + "дійшовши через розбір, вивід типів і планування.)");
});

/**
 * #279j — ДЗЕРКАЛО: гейт вище ВМІЄ спрацювати.
 *
 * Без нього `#279i` зеленів би й тоді, коли перевіряти нема чого: будь-який справний
 * запит доходить до прав. Тут навмисно ТОЙ САМИЙ вираз БЕЗ приведення — він мусить
 * упасти рівно тим, що ми ловимо.
 *
 * 🔴 Твердження ПОДВІЙНЕ — код і текст, і жодне з них не зайве. Код `42P08` — змістова
 * межа («параметру не вивелись узгоджені типи»); без нього дзеркало зеленіло б на
 * БУДЬ-ЯКІЙ відмові, зокрема на правах — саме так воно й було зеленим тоді, коли
 * основний гейт падав через 42501. Текст `$6` — бо `42P08` сам по собі не розрізняє,
 * ЯКИЙ параметр неоднозначний: після чужого рефакторингу він прилетів би від `$3`, а
 * ми прочитали б це як доказ про `$6`.
 */
test("#279j 🪞 ДЗЕРКАЛО: без ::int той самий запит НЕ розбирається", needsDb(), async () => {
  const { pool } = await load();
  const cl = await pool.connect();
  let msg = "";
  let code = "";
  try {
    await cl.query("BEGIN");
    await cl.query(upsertSql(""), VALUES);
  } catch (e) {
    msg = (e as Error).message;
    code = String((e as { code?: unknown }).code ?? "");
  } finally { await cl.query("ROLLBACK"); cl.release(); }
  assert.equal(code, "42P08",
    `🔴 версія БЕЗ приведення впала не на виводі типів, а з кодом «${code}» («${msg}») — `
    + "дзеркало зеленіло б на будь-якій відмові, зокрема на правах, і не доводило б нічого");
  assert.match(msg, /inconsistent types|parameter \$6/i,
    `🔴 версія БЕЗ приведення пройшла (повідомлення: «${msg}») — отже #279i доводить не те, `
    + "що ми думаємо, і наступний такий дефект пройде повз нього");
});
