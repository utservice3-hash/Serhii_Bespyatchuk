import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RECOMPUTE_SQL, CANONICAL_KEY_EXPR } from "./clientKeySql.js";
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
