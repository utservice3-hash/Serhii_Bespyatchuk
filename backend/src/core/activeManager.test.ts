import { test } from "node:test";
import assert from "node:assert/strict";
import { isActiveManager, activeManagerSql } from "./activeManager.js";
import { needsDb } from "../testMode.js";

/**
 * #51 — АКТИВНІСТЬ МЕНЕДЖЕРА МАЄ ДВА ДЖЕРЕЛА, І ОБИДВА МУСЯТЬ РАХУВАТИСЬ.
 *
 * 🔴 Привід — реальний випадок 06.08.2026. Власник деактивував Шевчука Назара в
 * НАЛАШТУВАННЯХ дашборду (`users.is_active = false`), а Kommo далі вважала його
 * активним (`managers.is_active = true`). Я будував рядок «звільнені» на
 * Kommo-прапорці — тобто на реальних звільненнях він би НІКОЛИ не спрацював.
 *
 * ⚠️ І пастка виявилась дзеркальною до очікуваної: `users.is_active` не згадується
 * в ЖОДНОМУ аналітичному запиті, тож деактивація в дашборді не прибирала людину зі
 * Звіту взагалі — вона стояла з планом, відсотком і світлофором. Дія власника
 * просто не мала наслідків там, де він їх очікував.
 */
test("#51 звільненим вважається той, у кого знято БУДЬ-ЯКИЙ із двох прапорців", () => {
  // Kommo активний + логін активний → працює
  assert.equal(isActiveManager({ kommoActive: true, loginStates: [true] }), true);
  // 🔴 САМЕ ВИПАДОК ШЕВЧУКА: Kommo каже «активний», дашборд — «деактивовано»
  assert.equal(isActiveManager({ kommoActive: true, loginStates: [false] }), false,
    "🔴 деактивація в НАЛАШТУВАННЯХ не врахована — рядок «звільнені» ніколи не спрацює на реальних звільненнях");
  // Зворотний бік: звільнений у Kommo, логін ще не прибрали
  assert.equal(isActiveManager({ kommoActive: false, loginStates: [true] }), false);
  // 🔴 ЛОГІНА НЕМАЄ ВЗАГАЛІ — це НЕ звільнення. Інакше з ростера випали б усі,
  // кому просто не заводили доступ, і Звіт схуд би вдвічі без жодного звільнення.
  assert.equal(isActiveManager({ kommoActive: true, loginStates: [] }), true,
    "🔴 менеджер без логіна вважається звільненим — це вирізало б півростера");
  // Кілька логінів (дублі users): активний хоч один → людина працює.
  assert.equal(isActiveManager({ kommoActive: true, loginStates: [false, true] }), true);
  assert.equal(isActiveManager({ kommoActive: true, loginStates: [false, false] }), false);
});

/**
 * #51b — ПРЕДИКАТ SQL РОБИТЬ ТЕ САМЕ, ЩО ЧИСТА ФУНКЦІЯ, НА ЖИВИХ ДАНИХ.
 * Без цього #51 перевіряв би лише арифметику в голові: реальний ростер будується
 * SQL-ем, і саме він може розійтись із наміром (той самий клас, що `CHECK` на NULL).
 */
test("#51b SQL-предикат == чиста функція на реальних менеджерах", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const sqlActive = new Set((await pool.query<{ id: number }>(
    `SELECT m.id FROM managers m WHERE ${activeManagerSql("m")}`)).rows.map((r) => r.id));

  const raw = (await pool.query<{ id: number; kommo: boolean; logins: boolean[] | null }>(
    `SELECT m.id, m.is_active AS kommo,
            array_agg(u.is_active) FILTER (WHERE u.id IS NOT NULL) AS logins
       FROM managers m LEFT JOIN users u ON u.manager_id = m.id
      GROUP BY m.id, m.is_active`)).rows;
  assert.ok(raw.length > 50, `🔴 менеджерів у базі ${raw.length} — замало, щоб щось довести`);

  const mismatch = raw
    .filter((r) => isActiveManager({ kommoActive: r.kommo, loginStates: r.logins ?? [] }) !== sqlActive.has(r.id))
    .map((r) => `mgr ${r.id}: SQL=${sqlActive.has(r.id)} fn=${isActiveManager({ kommoActive: r.kommo, loginStates: r.logins ?? [] })}`);
  assert.deepEqual(mismatch, [], "🔴 SQL-предикат розійшовся з чистою функцією");

  // Дзеркало: предикат не вироджений — він когось таки виключає І когось лишає.
  assert.ok(sqlActive.size > 0 && sqlActive.size < raw.length,
    `🔴 предикат вироджений: активними вважає ${sqlActive.size} із ${raw.length}`);
});

/**
 * #51c — 🧨 САБОТАЖ ДЕАКТИВАЦІЄЮ В ДАШБОРДІ (як просив власник — саме в дашборді,
 * а не в Kommo). Знімаємо `users.is_active` живому менеджеру З ГРІШМИ і вимагаємо,
 * щоб він ВИПАВ із ростера. Якби предикат лишився на самому Kommo-прапорці, він
 * лишився б у ростері, і саботаж нічого б не показав.
 *
 * 🔒 Усе в транзакції з гарантованим ROLLBACK: тест проти живої бази не має права
 * лишити по собі слід. Права — другий рубіж, транзакція — перший.
 */
test("#51c саботаж: деактивація в НАЛАШТУВАННЯХ виводить менеджера з ростера", needsDb(), async () => {
  const { pool } = await import("../db/pool.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const victim = (await client.query<{ id: number; uid: number }>(
      `SELECT m.id, u.id AS uid FROM managers m JOIN users u ON u.manager_id = m.id
        WHERE m.is_active AND u.is_active ORDER BY m.id LIMIT 1`)).rows[0];
    assert.ok(victim, "🔴 нема жодного менеджера з активним логіном — саботувати нічого");

    const inRoster = async (): Promise<boolean> => (await client.query<{ n: string }>(
      `SELECT COUNT(*) n FROM managers m WHERE m.id = $1 AND ${activeManagerSql("m")}`, [victim.id])).rows[0].n === "1";

    assert.equal(await inRoster(), true, "🔴 менеджер не в ростері ще ДО саботажу");
    await client.query(`UPDATE users SET is_active = false WHERE id = $1`, [victim.uid]);
    assert.equal(await inRoster(), false,
      "🔴 деактивація в НАЛАШТУВАННЯХ не вивела менеджера з ростера — предикат дивиться лише на Kommo, "
      + "тобто рядок «звільнені» не спрацює на реальних звільненнях");
  } finally {
    await client.query("ROLLBACK");   // 🔒 живу базу не чіпаємо НІ ЗА ЯКИХ УМОВ
    client.release();
  }
});
