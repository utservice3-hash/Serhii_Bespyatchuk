/**
 * 🔑 ВИРАЗ КАНОНІЧНОГО КЛЮЧА — одне джерело для джоби, синку й тестів. БЕЗ імпортів.
 *
 * 🔴 НАВІЩО ОКРЕМИЙ ФАЙЛ. Саботаж зворотності я спершу прогнав, вписавши SQL у
 * скрипт РУКАМИ — бо джоба тягне `db/pool.js` → `config.js`, який кидає без
 * `DATABASE_URL` ще на імпорті. Доказ вийшов на тексті, який СХОЖИЙ на робочий, а
 * не на ньому самому. Це рівно «A = B, де B — те, чим ти щойно означив A»: якби
 * джоба розійшлася з перевіреним виразом, тест лишався б зеленим.
 *
 * Тепер обидва беруть один рядок звідси, і розійтись їм нема як.
 */

/** Канонічний ключ для угоди `d`: активний псевдонім або сам сирий ключ. */
export const CANONICAL_KEY_EXPR = `COALESCE(
       (SELECT a.canonical_key FROM client_key_alias a
         WHERE a.alias_key = d.client_key_raw AND a.revoked_at IS NULL),
       d.client_key_raw)`;

/**
 * Повний UPDATE перерахунку. Застосовує НОВІ псевдоніми і ВІДКОЧУЄ скасовані одним
 * запитом: для скасованого `canonical_key` більше не знайдеться, і значення
 * повернеться до `client_key_raw`, який аліаси не чіпають ніколи.
 *
 * `IS DISTINCT FROM` робить його ідемпотентним: прогін без змін у реєстрі не
 * торкається жодного рядка, тож джобу безпечно ганяти за розкладом.
 */
export const RECOMPUTE_SQL = `
  UPDATE deals d
     SET client_key = ${CANONICAL_KEY_EXPR}
   WHERE d.client_key_raw IS NOT NULL
     AND d.client_key IS DISTINCT FROM ${CANONICAL_KEY_EXPR}`;
