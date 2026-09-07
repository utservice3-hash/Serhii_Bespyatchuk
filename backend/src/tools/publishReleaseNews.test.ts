import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDb } from "../testMode.js";
import { PUBLISH_SQL } from "./publishReleaseNews.js";

const db = async () => (await import("../db/pool.js")).pool;

/**
 * #354 — ЗАПИТ ПУБЛІКАЦІЇ ДОХОДИТЬ ДО ВИКОНАННЯ НА ЖИВІЙ БАЗІ.
 *
 * 📐 Правило зони `db-sql`: SQL у шаблонному рядку не типізується взагалі — `tsc`
 * зелений, набір зелений, а запит падає на першому ж виконанні. Тут перевіряти є що
 * ДВІЧІ: назву нової колонки і **наявність арбітражного індексу** для `ON CONFLICT`.
 * Друге особливо тихе: без часткового унікального індексу Postgres відмовляє `42P10`
 * («no unique or exclusion constraint matching the ON CONFLICT specification»), і
 * ідемпотентність зникає саме тоді, коли на неї сподіваєшся — при повторному прогоні.
 *
 * ✅ Критерій той самий, що в `#279i`: `42501` (права) — ЗЕЛЕНЕ, бо розбір і планування
 * пройшли, і ми впершись у read-only роль набору. Будь-який інший код — червоне з
 * названим кодом.
 *
 * ⚠️ ДО ВИКАТУ ЦЕЙ ГЕЙТ ЧЕРВОНИЙ, і це правильно: заміряно 07.09.2026 — прод віддає
 * `42703 column "release_sha" does not exist`, бо міграція накочується кроком `migrate`
 * того самого викату. Зелений тут і є доказом, що міграція справді лягла, — а не
 * напис «Migration applied», який друкується й тоді, коли частина роботи відкотилась.
 */
test("#354 запит публікації новини розбирається й планується живою БД", needsDb(), async () => {
  const pool = await db();
  const cl = await pool.connect();
  let code = "", msg = "";
  try {
    await cl.query("BEGIN");
    await cl.query(PUBLISH_SQL, ["проба гейта", "тіло проби", "гейт-354-неіснуючий-sha"]);
  } catch (e) {
    code = String((e as { code?: unknown }).code ?? "");
    msg = (e as Error).message;
  } finally { await cl.query("ROLLBACK"); cl.release(); }

  assert.ok(code === "" || code === "42501",
    `🔴 запит публікації не дійшов до виконання: ${code} ${msg}. `
    + "42703 означає, що міграція не накотилась; 42P10 — що немає часткового унікального "
    + "індексу, і тоді повторний викат створив би ДРУГУ новину про той самий реліз.");
});
