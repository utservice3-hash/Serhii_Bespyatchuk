import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb, needsDbWritable } from "../testMode.js";

/**
 * #52 — ДІЯ, ДОСТУПНА В ІНТЕРФЕЙСІ, МУСИТЬ БУТИ СКАСОВНОЮ ТИМ САМИМ ІНТЕРФЕЙСОМ.
 *
 * 🔴 ПРИВІД. `POST /settings/users/:id/reactivate` відмовляв CRM-менеджерам із
 * текстом «CRM-менеджер відновлюється поверненням у CRM (синк активує
 * автоматично)». Текст був НЕПРАВДИВИЙ: `syncKommo` таблицю `users` не чіпає
 * взагалі (слово `users` там означає користувачів Kommo, і пишуться вони в
 * `managers`). Фронт дзеркалив ту саму помилку — замість кнопки показував напис
 * «через CRM». Тобто деактивація CRM-менеджера була **незворотною через
 * інтерфейс**: «вимкнути» працювало, «увімкнути» — ні, а обіцяного автоматичного
 * механізму не існувало. Повертати Шевчука Назара 06.08.2026 довелось SQL-ом.
 *
 * **Незворотна кнопка — це пастка, навіть коли вона працює правильно.**
 *
 * Перевіряємо ЦИКЛ, а не окремий виклик: деактивація → реактивація має повернути
 * стан ДО БАЙТА, включно з `deactivated_at = NULL` і `deactivated_reason = NULL`.
 * Залишений `deactivated_at` при `is_active = true` — це «наче увімкнули», і саме
 * такі напівстани потім читаються як «людина звільнялась» у списках.
 *
 * 🔒 Усе в транзакції з гарантованим ROLLBACK: гейт проти живої бази не має права
 * лишити по собі слід.
 */
test("#52 цикл деактивація → реактивація повертає CRM-менеджера у вихідний стан", needsDbWritable(), async () => {
  const { pool } = await import("../db/pool.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = (await client.query<{ id: number; manager_id: number | null }>(
      `SELECT id, manager_id FROM users
        WHERE manager_id IS NOT NULL AND is_active ORDER BY id LIMIT 1`)).rows[0];
    assert.ok(u, "🔴 нема жодного активного CRM-менеджера з логіном — перевіряти нічого");

    const read = async () => (await client.query<{ is_active: boolean; da: string | null; dr: string | null }>(
      `SELECT is_active, deactivated_at::text da, deactivated_reason dr FROM users WHERE id=$1`, [u.id])).rows[0];

    const before = await read();
    assert.equal(before.is_active, true);

    // ── деактивація (те, що робить PATCH /settings/users/:id з {isActive:false})
    await client.query(
      `UPDATE users SET is_active=false, deactivated_reason=$2, deactivated_at=now() WHERE id=$1`,
      [u.id, "гейт #52"]);
    const off = await read();
    assert.equal(off.is_active, false, "🔴 деактивація не спрацювала — цикл перевіряти нема сенсу");
    assert.ok(off.da, "🔴 дата деактивації не проставилась");

    // ── реактивація (рівно те, що робить POST /users/:id/reactivate ПІСЛЯ зняття guard-а)
    await client.query(`UPDATE users SET is_active=true, deactivated_at=NULL, deactivated_reason=NULL WHERE id=$1`, [u.id]);
    const after = await read();
    assert.deepEqual(after, before,
      "🔴 стан після реактивації НЕ дорівнює вихідному — лишився напівстан "
      + "(is_active=true при заповненому deactivated_at читається як «людина звільнялась»)");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

/**
 * #52b — 🧨 САБОТАЖ: ПОВЕРНЕННЯ GUARD-А РОБИТЬ ЦИКЛ НЕЗАМКНЕНИМ.
 *
 * Перевіряємо ДЖЕРЕЛО, а не поведінку БД: guard жив у роуті, тож саботаж — це
 * повернення рядка, що відхиляє CRM-менеджера. Читаємо файл роута й вимагаємо,
 * щоб відмови саме за ознакою `manager_id` там не було.
 *
 * 🔴 Чому саме так, а не HTTP-пробою: щоб упіймати guard пробою, треба живий
 * сервер, деактивований CRM-менеджер і право `manage_users` — три умови, кожна з
 * яких дала б `skip`, тобто гейт мовчки не виконувався б. А він має триматись
 * у звичайному `npm test`, бо стереже РІШЕННЯ власника, а не рідкісний сценарій.
 */
test("#52b саботаж: у роуті реактивації немає відмови CRM-менеджерам", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("./settings.js", import.meta.url));
  const src = await readFile(path, "utf8");

  const i = src.indexOf("/users/:id/reactivate");
  assert.ok(i > 0, "🔴 роут реактивації не знайдено — маніфест бреше про склад набору");
  // тіло роута до наступного оголошення роута
  const rest = src.slice(i);
  const end = rest.indexOf("settingsRouter.", 40);
  const body = end > 0 ? rest.slice(0, end) : rest;

  assert.ok(!/manager_id\s*!==\s*null/.test(body),
    "🔴 GUARD ПОВЕРНУВСЯ: реактивація знову відмовляє CRM-менеджерам — "
    + "дія стала незворотною через інтерфейс");
  assert.ok(!/відновлюється поверненням у CRM/.test(body),
    "🔴 повернулось неправдиве повідомлення «синк активує автоматично» — "
    + "syncKommo таблицю users не чіпає взагалі");
  // дзеркало: сам UPDATE на місці, тобто ми не «прибрали guard» разом із дією
  assert.ok(/is_active=true/.test(body) && /deactivated_at=NULL/.test(body),
    "🔴 у роуті немає власне реактивації — перевірка на guard стала б порожньою");
});
