import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";
import { archiveListSql } from "../core/clientArchive.js";
import { OWNER_TEAM_CTE, ownerTeamClamp } from "../core/reactivationClose.js";

const db = async () => (await import("../db/pool.js")).pool;

/**
 * #350 — АРХІВНИЙ ЗАПИТ ВИКОНУЄТЬСЯ ЖИВОЮ БАЗОЮ В ОБОХ ФОРМАХ.
 *
 * 📐 Правило зони `db-sql.md`, куплене аварією: **SQL усередині шаблонного рядка не
 * типізується взагалі**. `tsc` зелений, увесь набір зелений — а запит падає на першому
 * ж кліку користувача (`d.id` замість `d.kommo_id` пройшло рівно так). Єдина перевірка,
 * яка тут щось означає, — виконати ТОЙ САМИЙ текст, який кличе роут.
 *
 * 🔴 ОБИДВІ ФОРМИ, бо вони РІЗНІ ТЕКСТИ: адмінська йде без клампа й без параметрів,
 * тімлідська — з умовою і `$1`. Перевірити одну означало б не перевірити другу; саме
 * на арності параметрів ламається `08P01`, і саме її не видно жодним типом.
 */
test("#350 запит архіву виконується живою БД і в адмінській, і в тімлідській формі",
  needsDb(), async () => {
  const pool = await db();
  await pool.query(archiveListSql(""));
  await pool.query(archiveListSql(ownerTeamClamp(1, "$1")), [1]);
});

/**
 * #350b — 🪞 ДЗЕРКАЛО: кламп СПРАВДІ звужує, а не просто дописується в текст.
 *
 * 🔴 ЧОМУ НЕ МІРЯЄМО НА САМОМУ АРХІВІ. Заміряно 07.09.2026: в архіві **нуль** клієнтів,
 * тож обидві форми запиту віддали б по нулю рядків — і гейт був би зелений при будь-якому
 * клампі, включно з відсутнім. Порожній результат нічого не доводить, доки не доведено,
 * що перевірці БУЛО що знаходити.
 *
 * ✅ Тому міряємо механізм на НЕпорожньому наборі: `owner_team` накриває всіх клієнтів
 * із оплатами, і звуження по команді має дати менше, ніж усього, але БІЛЬШЕ НУЛЯ.
 * Обидві межі потрібні: «менше» ловить кламп, що не працює, «більше нуля» — кламп, що
 * ріже все підряд (він теж дав би «менше» і теж виглядав би правильним).
 */
test("#350b 🪞 кламп звужує набір, але не обнуляє його", needsDb(), async () => {
  const pool = await db();
  const total = await pool.query<{ n: string }>(
    `WITH ${OWNER_TEAM_CTE} SELECT count(*) AS n FROM owner_team ot`);
  const all = Number(total.rows[0].n);
  assert.ok(all > 0,
    "🔴 набір власників порожній — вимір нічого не покаже, і зелене тут означало б порожнечу");

  const biggest = await pool.query<{ team_id: number; n: string }>(
    `WITH ${OWNER_TEAM_CTE}
     SELECT ot.team_id, count(*) AS n FROM owner_team ot
      WHERE ot.team_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
  assert.ok(biggest.rowCount, "🔴 жодна команда не має клієнтів — звужувати нема чого");
  const teamId = biggest.rows[0].team_id;

  const clamped = await pool.query<{ n: string }>(
    `WITH ${OWNER_TEAM_CTE}
     SELECT count(*) AS n FROM owner_team ot WHERE true ${ownerTeamClamp(teamId, "$1")}`, [teamId]);
  const some = Number(clamped.rows[0].n);
  assert.ok(some > 0,
    `🔴 кламп по команді ${teamId} дав НУЛЬ — він ріже все підряд, і тімлід не побачить нічого`);
  assert.ok(some < all,
    `🔴 кламп нічого не звузив (${some} із ${all}) — у видачу поїде чужа команда`);
});
