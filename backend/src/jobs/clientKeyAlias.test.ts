import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RECOMPUTE_SQL, CANONICAL_KEY_EXPR, REVOKE_ALIAS_SQL } from "./clientKeySql.js";
import { provisionScratch, skipReason, type Unavailable } from "../db/scratchDb.js";

/**
 * #21 — ЗВОРОТНІСТЬ ЗЛИТТЯ КЛІЄНТСЬКИХ КЛЮЧІВ.
 *
 * 🔴 НАВІЩО. Модель: `client_key_raw` — те, що порахував синк (аліаси його не чіпають
 * НІКОЛИ); `client_key` — похідна. Уся зворотність тримається рівно на цьому: якщо
 * `raw` колись загубиться або перерахунок виявиться однобічним, скасувати злиття
 * стане неможливо інакше, ніж відновленням із бекапу.
 *
 * Тому перевіряємо ОБИДВА напрямки на справжній базі: злиття → відкіт → стан
 * байт-у-байт як був.
 *
 * ⚙️ Прогін через одноразовий кластер (`provisionScratch`). На прод-сервері бінарів
 * PostgreSQL немає — там тест чесно пропускається з причиною, що НАЗИВАЄ причину.
 */

const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

test("#21 ЗВОРОТНІСТЬ: злиття застосовується і ВІДКОЧУЄТЬСЯ байт-у-байт", async (t) => {
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO managers (id,name,is_active) VALUES (1,'М',true) ON CONFLICT DO NOTHING`);
    for (const [id, key, price] of [[1, "вкавтострада", 1000], [2, "вкавтострада", 2000], [3, "0977086747", 500]] as const) {
      await c.query(
        `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw)
         VALUES ($1,'d',1,8921932,142,$3,$2,$2)`, [id, key, price]);
    }
    const snap = async () => (await c.query(
      `SELECT kommo_id, client_key, client_key_raw FROM deals ORDER BY kommo_id`)).rows;
    const byKey = async (k: string) => (await c.query<{ rev: string; n: string }>(
      `SELECT COALESCE(SUM(price),0) rev, COUNT(*) n FROM deals WHERE client_key=$1`, [k])).rows[0];
    const total = async () => (await c.query<{ rev: string; n: string }>(
      `SELECT COALESCE(SUM(price),0) rev, COUNT(*) n FROM deals`)).rows[0];

    const before = await snap();
    const totalBefore = await total();

    // ── ЗЛИТТЯ
    await c.query(
      `INSERT INTO client_key_alias (alias_key,canonical_key,reason,evidence)
       VALUES ('0977086747','вкавтострада','shared_contact:92334323','{"contactId":92334323}')`);
    await c.query(RECOMPUTE_SQL);
    assert.equal(Number((await byKey("вкавтострада")).n), 3, "після злиття всі три угоди мають бути під канонічним ключем");
    assert.equal(Number((await byKey("0977086747")).n), 0, "під псевдонімом не має лишитись жодної угоди");
    const totalAfter = await total();
    assert.deepEqual(totalAfter, totalBefore,
      "🔴 Σ ПО КОМПАНІЇ ЗМІНИЛАСЬ. Злиття ключів переносить угоди між клієнтами, але "
      + "НЕ створює і не знищує грошей — інакше це не злиття, а псування даних");

    // ── ВІДКІТ
    await c.query(`UPDATE client_key_alias SET revoked_at = now() WHERE alias_key='0977086747'`);
    await c.query(RECOMPUTE_SQL);
    assert.deepEqual(await snap(), before,
      "🔴 стан НЕ відновився. Уся зворотність тримається на `client_key_raw`; якщо він "
      + "не повертає вихідне значення, скасувати злиття можна лише з бекапу");

    // ── ІДЕМПОТЕНТНІСТЬ: повторний прогін не чіпає жодного рядка
    const again = await c.query(RECOMPUTE_SQL);
    assert.equal(again.rowCount, 0,
      "🔴 перерахунок без змін у реєстрі зачепив рядки — джобу не можна ганяти за розкладом");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

test("#21b ЗАБОРОНА ЛАНЦЮЖКІВ живе в БД, а не в дисципліні", async (t) => {
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    const add = (a: string, b: string) => c.query(
      `INSERT INTO client_key_alias (alias_key,canonical_key,reason) VALUES ($1,$2,'test')`, [a, b]);
    await add("телефон", "фірма");
    // 🔴 Замір показав, навіщо: один телефон веде до ДВОХ фірм, і транзитивне
    // замикання склеїло б «Укрпошту» з «боскокомпані». Ланцюжок має бути неможливим,
    // а не небажаним.
    await assert.rejects(() => add("фірма", "інша"), /ланцюжок заборонено/,
      "🔴 A→B і B→C співіснують: канонічний ключ сам став псевдонімом");
    await assert.rejects(() => add("щось", "телефон"), /ланцюжок заборонено/,
      "🔴 псевдонім став канонічним для третього — той самий ланцюжок з іншого боку");
    // ДЗЕРКАЛО: незалежна пара має проходити, інакше тригер просто забороняє все.
    await add("другий", "інша-фірма");
    const n = (await c.query<{ n: string }>(`SELECT COUNT(*) n FROM client_key_alias`)).rows[0];
    assert.equal(Number(n.n), 2, "🔴 тригер відкидає й законні пари — реєстр став би непридатним");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

test("#21c ДЖОБА І ТЕСТ БЕРУТЬ ОДИН SQL, а не схожий", () => {
  // 🔴 Саботаж я спершу прогнав, вписавши запит у скрипт руками — і доказ вийшов на
  // тексті, СХОЖОМУ на робочий. Якби джоба розійшлася з перевіреним виразом, тест
  // лишався б зеленим. Тепер обидва беруть одну константу; перевіряємо, що вона
  // справді та, і що джоба не обходить її власним запитом.
  assert.ok(RECOMPUTE_SQL.includes(CANONICAL_KEY_EXPR), "UPDATE не використовує канонічний вираз");
  assert.match(RECOMPUTE_SQL, /IS DISTINCT FROM/, "без цього перерахунок не був би ідемпотентним");
  assert.match(RECOMPUTE_SQL, /revoked_at IS NULL/, "скасовані псевдоніми мають ігноруватись");
  const job = readFileSync(path.join(import.meta.dirname, "recomputeClientKeys.js"), "utf8");
  assert.match(job, /RECOMPUTE_SQL/, "джоба не використовує спільну константу");
  assert.ok(!/UPDATE\s+deals\s+d\s+SET\s+client_key\s*=/i.test(job),
    "🔴 у джобі лишився ВЛАСНИЙ UPDATE — саме те розходження, від якого ця константа й рятує");
});

/**
 * #422 — РОЗʼЄДНАННЯ ЗВІЛЬНЯЄ ПСЕВДОНІМ, А ІСТОРІЯ ЛИШАЄТЬСЯ ЦІЛОЮ.
 *
 * 🔴 ЩО БУЛО ЗЛАМАНО (заміряно на проді 15.09.2026). `alias_key` був PRIMARY KEY
 * безумовно, а відкіт лише проставляє `revoked_at` — рядки тут не видаляються
 * ніколи. Тож скасований рядок тримав ключ зайнятим НАЗАВЖДИ: повторне злиття
 * падало на `duplicate key`, і роут віддавав 409. Спалених ключів було три, під
 * ними 358 угод, і приєднати їх назад було неможливо жодним інтерфейсом.
 *
 * Гейт проходить ПОВНИЙ цикл на справжній схемі й перевіряє три речі, які разом
 * і означають «полагоджено»: (1) третій крок узагалі проходить; (2) резолвер не
 * захлинається, коли на псевдонім лежить два рядки — саме тут виліз би
 * «more than one row returned by a subquery» на КОЖНОМУ синку, якби часткова
 * унікальність не тримала рівно один активний; (3) `evidence` першого злиття не
 * затерте — воно несе право на відкіт і невідновлюваний знімок лімітів.
 *
 * Червоніє, якщо повернути безумовний PK або оживляти рядок через UPDATE.
 */
test("#422 РОЗʼЄДНАННЯ ЗВІЛЬНЯЄ ПСЕВДОНІМ: злити → розʼєднати → злити знову, історія ціла", async (t) => {
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(`INSERT INTO managers (id,name,is_active) VALUES (1,'М',true) ON CONFLICT DO NOTHING`);
    await c.query(
      `INSERT INTO deals (kommo_id,name,manager_id,pipeline_id,status_id,price,client_key,client_key_raw)
       VALUES (1,'d',1,8921932,142,100,'смар','смар')`);

    const merge = (canon: string, reason: string, ev: string) => c.query(
      `INSERT INTO client_key_alias (alias_key,canonical_key,reason,evidence)
       VALUES ('смар',$1,$2,$3::jsonb)`, [canon, reason, ev]);

    // ── 1. злили
    await merge("смартекс", "перше злиття", '{"source":"ui","limitsBefore":[{"clientKey":"смар"}]}');
    await c.query(RECOMPUTE_SQL);
    // ── 2. розʼєднали (рядок ЛИШАЄТЬСЯ — так задумано)
    await c.query(`UPDATE client_key_alias SET revoked_at = now() WHERE alias_key='смар' AND revoked_at IS NULL`);
    await c.query(RECOMPUTE_SQL);

    // ── 3. ГОЛОВНЕ: злили ТОЙ САМИЙ ключ знову. До фікса тут був duplicate key.
    await merge("смартекс", "друге злиття", '{"source":"ui"}');

    const rows = (await c.query<{ reason: string; revoked: boolean; evidence: Record<string, unknown> }>(
      `SELECT reason, (revoked_at IS NOT NULL) AS revoked, evidence
         FROM client_key_alias WHERE alias_key='смар' ORDER BY created_at, id`)).rows;
    assert.equal(rows.length, 2, "🔴 повторне злиття не створило власного рядка — історію оживили перезаписом");
    assert.equal(rows.filter((r) => !r.revoked).length, 1, "🔴 активним мусить лишатись рівно один рядок");
    assert.equal(rows[0].reason, "перше злиття", "🔴 причину першого злиття затерто — зник доказ, чому колись злили");
    assert.ok(rows[0].evidence.limitsBefore,
      "🔴 `limitsBefore` першого злиття зник. Це ЄДИНИЙ і невідновлюваний знімок лімітів до злиття "
      + "(core/mergeLimits.ts) — заради нього писали #262/#264");

    // Резолвер не захлинається на двох рядках і застосовує саме активний.
    await c.query(RECOMPUTE_SQL);
    const d = (await c.query<{ client_key: string; client_key_raw: string }>(
      `SELECT client_key, client_key_raw FROM deals WHERE kommo_id=1`)).rows[0];
    assert.equal(d.client_key, "смартекс", "🔴 повторне злиття не застосувалось до угод");
    assert.equal(d.client_key_raw, "смар", "🔴 сирий ключ зрушив — зворотність тримається саме на ньому");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #422b 🪞 — АКТИВНИЙ ПСЕВДОНІМ І ДАЛІ КОНФЛІКТУЄ.
 *
 * Дзеркало до `#422`, і без нього «виправлення» можна було б виконати, просто
 * знявши унікальність: тоді на один ключ лягло б двоє АКТИВНИХ рядків, і резолвер
 * почав би падати «more than one row returned by a subquery» на кожному синку.
 * Тобто цей гейт стереже не зручність, а те, що фікс не перетворився на зняту
 * перевірку. Червоніє, якщо зробити індекс повним замість часткового.
 */
test("#422b 🪞 АКТИВНИЙ ПСЕВДОНІМ І ДАЛІ КОНФЛІКТУЄ — унікальність звузили, а не зняли", async (t) => {
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    const add = (canon: string) => c.query(
      `INSERT INTO client_key_alias (alias_key,canonical_key,reason) VALUES ('смар',$1,'test')`, [canon]);
    await add("смартекс");
    await assert.rejects(() => add("смартекс"), /duplicate key|unique/i,
      "🔴 той самий АКТИВНИЙ псевдонім вставився вдруге — унікальність зняли, а не звузили");
    await assert.rejects(() => add("іншафірма"), /duplicate key|unique/i,
      "🔴 активний псевдонім перецілився на іншого клієнта мовчки, без відмови");
    const n = (await c.query<{ n: string }>(
      `SELECT COUNT(*) n FROM client_key_alias WHERE alias_key='смар' AND revoked_at IS NULL`)).rows[0];
    assert.equal(Number(n.n), 1, "🔴 активних рядків на один псевдонім більше ніж один");
  } finally {
    await c.end();
    scratch.dispose();
  }
});

/**
 * #422e — ВІДКІТ ЗНІМАЄ САМЕ ТУ ПАРУ, ПРО ЯКУ ПИТАЛИ.
 *
 * 🔴 ЗНАЙДЕНО РЕЦЕНЗІЄЮ ВЛАСНОЇ ЗМІНИ, а не тестом: часткова унікальність (#422)
 * прибрала інваріанту, на яку мовчки спирався `revoke`. Доки `alias_key` був
 * PRIMARY KEY, пара (псевдонім → канонічний) була унікальною Й НЕЗМІННОЮ назавжди
 * — жодного `DELETE`, жодного `UPDATE … SET canonical_key` у продакшн-коді немає.
 * Тому «зняти активний за ключем» було однозначним ЗА ПОБУДОВОЮ.
 *
 * Після зміни на ключ лягає кілька рядків із РІЗНИМИ канонічними, і той самий
 * запит почав означати «зняти той, що активний ЗАРАЗ». Сценарій: у журналі
 * відкрито «смар → максимсмартекс», інший адмін тим часом перезливає «смар →
 * автострада». Клік по застарілому рядку питав про одне, а відкочував інше —
 * 342 угоди виходили з групи, якої ніхто не чіпав, і сервер віддавав 200.
 *
 * Це рівно клас «ПРИБИРАЄШ ІНВАРІАНТУ — ЗНАЙДИ ВСІХ, ХТО НА НЕЇ СПИРАВСЯ».
 * Гейт виконує САМ `REVOKE_ALIAS_SQL` із роуту, а не свою копію поруч — інакше він
 * доводив би рівність двох рядків, написаних поруч, і мовчав би про продакшн.
 *
 * Червоніє, якщо прибрати `AND canonical_key = $2`.
 */
test("#422e ВІДКІТ АДРЕСНИЙ: знімає названу пару, а чужу не чіпає", async (t) => {
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const { revokeMismatchText } = await import("../core/mergeConflict.js");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(SCHEMA, "utf8"));
    await c.query(
      `INSERT INTO client_key_alias (alias_key,canonical_key,reason)
       VALUES ('смар','автострада','перезлито іншим адміном')`);

    // Людина бачила застарілий журнал і просить зняти пару, якої вже немає.
    const stale = await c.query(REVOKE_ALIAS_SQL, ["смар", "максимсмартекс"]);
    assert.equal(stale.rowCount, 0,
      "🔴 ВІДКІТ ЗНЯВ ЧУЖУ ПАРУ. Людина підтвердила «розʼєднати смар від максимсмартекс», "
      + "а зняли «смар → автострада» — клієнт вийшов із групи, якої ніхто не чіпав");
    const still = (await c.query<{ n: string }>(
      `SELECT COUNT(*) n FROM client_key_alias WHERE alias_key='смар' AND revoked_at IS NULL`)).rows[0];
    assert.equal(Number(still.n), 1, "🔴 активний рядок усе-таки зачепило");

    // 🪞 ДЗЕРКАЛО: із правильним канонічним відкіт працює. Без нього гейт зеленів би
    // і тоді, якби `revoke` зрізали повністю.
    const ok = await c.query(REVOKE_ALIAS_SQL, ["смар", "автострада"]);
    assert.equal(ok.rowCount, 1, "🔴 відкіт названої пари не спрацював — зрізали саму дію");

    // Причина відмови мусить назвати ОБИДВІ сторони, інакше людина не зрозуміє,
    // що саме застаріло на її екрані.
    const why = revokeMismatchText({ aliasKey: "смар", canonicalKey: "автострада" }, "максимсмартекс");
    assert.match(why, /автострада/, "🔴 відмова не каже, куди псевдонім веде НАСПРАВДІ");
    assert.match(why, /максимсмартекс/, "🔴 відмова не каже, про що питала людина");
    assert.notEqual(why, revokeMismatchText(null, "максимсмартекс"),
      "🔴 «веде до іншого» і «активного немає» дали один текст — смітник повернувся");
  } finally {
    await c.end();
    scratch.dispose();
  }
});
