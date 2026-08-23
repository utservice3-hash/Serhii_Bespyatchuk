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

/**
 * Канонічний ключ для таблиці з псевдонімом `alias`: активний псевдонім або сам
 * сирий ключ.
 *
 * 🔴 ПАРАМЕТРИЗОВАНО, А НЕ СКОПІЙОВАНО. Той самий реєстр застосовується до ДВОХ
 * таблиць — `deals` (угоди) і `receivable_invoices` (рахунки дебіторки). Друга
 * копія виразу поруч розійшлася б із першою рівно тоді, коли хтось поправить
 * умову `revoked_at` в одній із них, — і склейка почала б означати різне в
 * клієнтах і в боргах. Тут вона одна на обидві.
 */
export function canonicalKeyExpr(alias: string): string {
  return `COALESCE(
       (SELECT a.canonical_key FROM client_key_alias a
         WHERE a.alias_key = ${alias}.client_key_raw AND a.revoked_at IS NULL),
       ${alias}.client_key_raw)`;
}

/** Канонічний ключ для угоди `d` — історична назва, лишена для читабельності. */
export const CANONICAL_KEY_EXPR = canonicalKeyExpr("d");

/**
 * Перерахунок ключа в рахунках дебіторки. Ідемпотентний так само, як для угод:
 * `IS DISTINCT FROM` не чіпає рядків, коли реєстр не змінювався, а скасований
 * псевдонім сам повертає значення до `client_key_raw`.
 */
export const RECOMPUTE_RECEIVABLES_SQL = `
  UPDATE receivable_invoices ri
     SET client_key = ${canonicalKeyExpr("ri")}
   WHERE ri.client_key_raw IS NOT NULL
     AND ri.client_key IS DISTINCT FROM ${canonicalKeyExpr("ri")}`;

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
