import { test } from "node:test";
import assert from "node:assert/strict";
import { needsApi, needsDb } from "./testMode.js";

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

/**
 * 🔒 #232e–#232g — ДРУГИЙ РУБІЖ: ПРОД-ХОСТ ПІД `node --test`.
 *
 * `#14*` вище стережуть режим `TEST_SCOPE=prod`. Ці троє — випадок, коли його НЕ
 * виставлено взагалі: саме так `npm test` у контейнері ходить у бойову Neon-базу, і
 * сьогодні його спиняє лише те, що в рядку підключення випадково стоїть `kk_ro`.
 * Безпека на «випадково» — це везіння, а не механізм.
 */
const NT = { NODE_TEST_CONTEXT: "child-v8" };
const PROD = "postgres://neondb_owner:x@ep-plain-rice-asm5535t-pooler.c-4.eu-central-1.aws.neon.tech/neondb";
const SCRATCH = "postgresql://scratch@/utsscratch?host=/tmp/scratch-abc";

test("#232e ПРОД-ХОСТ під `node --test` із НЕназваною роллю — відмова", async () => {
  const assertGuard = await guard();
  assert.throws(() => assertGuard({ ...NT, DATABASE_URL: PROD } as NodeJS.ProcessEnv),
    /neondb_owner/, "🔴 набір пішов би в бойову базу під write-роллю, і ніщо б не спинило");
  // Повідомлення мусить НАЗВАТИ роль: «щось не так із доступом» відправить читача не туди.
  try { assertGuard({ ...NT, DATABASE_URL: PROD } as NodeJS.ProcessEnv); assert.fail("не кинув"); }
  catch (e) { assert.match(String((e as Error).message), /read-only/, "🔴 не сказано, ЧОГО бракує"); }
});

test("#232f ДЗЕРКАЛО: scratch-кластер і бойовий процес гейт НЕ чіпає", async () => {
  const assertGuard = await guard();
  // 🔴 Головна межа правки. Одноразовий кластер (#8, #231f) ходить через unix-сокет:
  // хоста немає ВЗАГАЛІ. Ознака «є DATABASE_URL» накрила б і його — тобто зламала б
  // чужі гейти заради свого.
  assertGuard({ ...NT, DATABASE_URL: SCRATCH } as NodeJS.ProcessEnv);
  const { isProdDbHost } = await import("./db/readOnlyGuard.js");
  assert.equal(isProdDbHost(SCRATCH), false, "🔴 unix-сокет прийнято за прод-хост");
  assert.equal(isProdDbHost(PROD), true, "🔴 прод-хост не впізнано — гейт мовчав би завжди");
  // Бойовий процес: прод-хост є, `node --test` немає → жодного втручання.
  assertGuard({ DATABASE_URL: PROD } as NodeJS.ProcessEnv);
});

test("#232g РЕЄСТР READ-ONLY РОЛЕЙ: названа проходить, чужа — ні", async () => {
  const assertGuard = await guard();
  const { READONLY_DB_ROLES, urlRole } = await import("./db/readOnlyGuard.js");
  // `kk_ro` — те, що стоїть у контейнері сьогодні. Гейт не сміє його ламати, інакше
  // ми полагодили б безпеку ціною робочого прогону.
  assertGuard({ ...NT, DATABASE_URL: PROD.replace("neondb_owner", "kk_ro") } as NodeJS.ProcessEnv);
  // …але саме ТОМУ, що вона НАЗВАНА, а не тому, що «виглядає безпечно».
  assert.ok(READONLY_DB_ROLES.includes("kk_ro"), "🔴 роль контейнера не названа в реєстрі");
  assert.equal(urlRole(PROD), "neondb_owner", "🔴 роль із рядка не читається");
  // ⚠️ Для сокетного рядка `URL` віддає порожній username (заміряно: "" замість
  // "scratch") — і це не має значення НІ ДЛЯ ЧОГО: перевірка ролі туди не доходить,
  // бо `isProdDbHost` уже сказав «не прод». Записано, щоб наступний не полагодив
  // розбір ролі, вирішивши, що тут баг.
  assert.equal(urlRole(SCRATCH), "", "🔴 поведінка розбору сокетного рядка змінилась — перечитай межу");
  // Реєстр не ковдра: вигадана роль не проходить.
  assert.throws(() => assertGuard({ ...NT, DATABASE_URL: PROD.replace("neondb_owner", "kk_rw") } as NodeJS.ProcessEnv),
    /kk_rw/, "🔴 реєстр пропускає будь-що, схоже на назву");
  // І PGOPTIONS із правильною роллю теж проходить — це шлях `test:prod`.
  assertGuard({ ...NT, DATABASE_URL: PROD, PGOPTIONS: "-c role=test_readonly" } as NodeJS.ProcessEnv);
});

test("#232h РОЛЬ РЕЄСТРУ СПРАВДІ НЕ ПИШЕ — заміряно, а не оголошено", needsDb(), async (t) => {
  const { isProdDbHost, READONLY_DB_ROLES } = await import("./db/readOnlyGuard.js");
  if (!isProdDbHost(process.env.DATABASE_URL)) {
    t.skip("рядок підключення не бойовий (scratch або локальна БД) — права прода перевіряти нема на чому");
    return;
  }
  /**
   * 🔴 ІМʼЯ — ЦЕ НЕ ПРАВО. `READONLY_DB_ROLES` перелічує НАЗВИ; якщо комусь у Neon
   * видадуть `kk_ro` право запису, реєстр і далі казатиме «можна». Реєстр, якому ми
   * просто віримо, — це та сама «папка бекапу є, копії немає».
   */
  /**
   * ⚠️ ІМПОРТ ПУЛУ — ЧЕРЕЗ try/catch. `config.js` кидає ще НА ІМПОРТІ на БУДЬ-ЯКІЙ
   * відсутній змінній, не лише на `DATABASE_URL` (заміряно тут: `KOMMO_BASE_URL`),
   * тобто раніше, ніж спрацював би `needsDb()`. Без цього гейт ПАДАЄ там, де мав би
   * чесно скіпнутись, і псує базову лінію контейнера чужою причиною.
   */
  let pool;
  try { pool = await load(); }
  catch (e) { t.skip(`оточення неповне: ${String((e as Error).message).slice(0, 80)}`); return; }
  const who = await pool.query<{ r: string }>("SELECT current_user AS r");
  const role = who.rows[0].r;
  const priv = await pool.query<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }>(
    `SELECT has_table_privilege(current_user,'receivables','INSERT') AS ins,
            has_table_privilege(current_user,'receivables','UPDATE') AS upd,
            has_table_privilege(current_user,'deals','DELETE')       AS del,
            has_table_privilege(current_user,'deals','SELECT')       AS sel`);
  const p = priv.rows[0];
  assert.equal(p.ins, false, `🔴 роль «${role}» МАЄ право INSERT у бойовій базі — реєстр read-only ролей бреше`);
  assert.equal(p.upd, false, `🔴 роль «${role}» МАЄ право UPDATE`);
  assert.equal(p.del, false, `🔴 роль «${role}» МАЄ право DELETE`);
  // 🪞 Дзеркало: «жодних прав» виглядало б як «надійно read-only», а насправді
  // означало б, що набір осліп. Той самий урок, що #13c.
  assert.equal(p.sel, true, `🔴 роль «${role}» не читає навіть deals — набір нічого не перевіряє`);
  // І сама роль мусить бути НАЗВАНОЮ: інакше «права зійшлись» тільки цього разу.
  assert.ok(READONLY_DB_ROLES.includes(role) || role === "test_readonly",
    `🔴 ходимо в прод під незареєстрованою роллю «${role}» — додай її в READONLY_DB_ROLES з причиною`);
});

test("#232i ПРИПУЩЕННЯ ПРО ПРОД-ХОСТ ЩЕ ІСТИННЕ — інакше сторож мовчки помер", needsDb(), async (t) => {
  const { dbHost, isProdDbHost, LOCAL_DB_HOSTS, PROD_DB_HOST_RE } = await import("./db/readOnlyGuard.js");
  const host = dbHost(process.env.DATABASE_URL);
  if (LOCAL_DB_HOSTS.includes(host)) {
    t.skip(`хост «${host || "(unix-сокет)"}» локальний — це не бойовий рядок, звіряти припущення нема з чим`);
    return;
  }
  /**
   * 🔴 УМОВА ПРО СЬОГОДНІШНІЙ СВІТ. Переїде прод із Neon — `isProdDbHost` почне
   * повертати `false` на бойовому рядку, і сторож перестане сторожити, НЕ ЗМІНИВШИСЬ
   * ЖОДНИМ СИМВОЛОМ. Це не гіпотетика: того ж дня чинна умова почала брехати від
   * того, що поруч завели ДРУГЕ дерево — ніхто нічого не прибирав.
   */
  assert.equal(isProdDbHost(process.env.DATABASE_URL), true,
    `🔴 ЖИВИЙ рядок підключення веде на «${host}», якого ${PROD_DB_HOST_RE} НЕ впізнає як бойовий.\n`
    + "   Отже другий рубіж readOnlyGuard зараз НЕ спрацьовує ні на чому — він живий на вигляд і мертвий по суті.\n"
    + "   Онови PROD_DB_HOST_RE під новий хост (і перечитай, що ще спиралось на Neon).");
});
