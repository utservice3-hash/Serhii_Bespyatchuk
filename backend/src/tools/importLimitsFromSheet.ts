/**
 * 🧾 ОДНОРАЗОВИЙ ІМПОРТ ЛІМІТІВ ІЗ «ЛИСТ20» У `client_credit_limits` (Е4).
 *
 * Запускається РАЗ, під час викату Е4, щоб 58 узгоджених відстрочок не довелось
 * набивати руками. Далі джерело — редактор у дебіторці, і цей скрипт більше не
 * потрібен: разом із читанням аркуша його прибирають через два тижні.
 *
 * 🔴 ЗАПОБІЖНИК ВІД ПОВТОРНОГО ПРОГОНУ — ГОЛОВНЕ, ЩО ТУТ Є.
 *
 * Без нього другий запуск ЗАТЕР БИ ручні правки: аркуш застиг (заміряно —
 * «Макс дней» не збігався з нашими датами жодного разу з 29, найбільша група
 * рівно +47 днів), тож він переписав би свіже рішення КВП старим значенням, і
 * ніхто б цього не помітив — ліміт виглядає однаково правдоподібно з будь-яким
 * числом. Тому: якщо таблиця НЕ порожня, скрипт відмовляється працювати й
 * називає, скільки рядків там уже є.
 *
 * `--force` існує рівно для одного випадку: імпорт упав на середині й треба
 * дозаписати. Він НЕ затирає рядки з приміткою, відмінною від імпортної —
 * тобто все, чого торкнулась людина, лишається недоторканим.
 *
 * ⚠️ Це той самий клас, що «наявність артефакту ≠ придатність»: скрипт, який
 * бадьоро друкує «імпортовано 58», зробивши при цьому шкоду, виглядає рівно
 * так само, як скрипт, що зробив користь.
 *
 * Запуск:  node dist/tools/importLimitsFromSheet.js [--force] [--dry]
 */
import { pool } from "../db/pool.js";
import { fetchSheetLimitsForReconcile } from "../jobs/syncReceivables.js";
// Правило «чи можна переписати» живе в ЯДРІ, а не тут: цей файл тягне `pool`,
// тож гейт не зміг би імпортувати з нього навіть чисту функцію.
import { IMPORT_NOTE, mayOverwriteImported } from "../core/creditLimits.js";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const dry = process.argv.includes("--dry");

  const existing = await pool.query<{ client_key: string; note: string }>(
    `SELECT client_key, note FROM client_credit_limits`);
  const noteByKey = new Map(existing.rows.map((r) => [r.client_key, r.note]));

  if (existing.rowCount && !force) {
    console.error(
      `🔴 ВІДМОВА: у client_credit_limits вже ${existing.rowCount} рядків.\n`
      + `   Повторний імпорт затер би ручні правки старими значеннями з аркуша,\n`
      + `   який ніхто свідомо не веде. Якщо це справді потрібно — --force,\n`
      + `   він не чіпає рядки, яких торкалась людина.`);
    process.exit(1);
  }

  const sheet = await fetchSheetLimitsForReconcile();
  let written = 0, skippedManual = 0, skippedNoLimit = 0;
  for (const [clientKey, limit] of sheet) {
    if (limit.limitDays == null) { skippedNoLimit++; continue; }
    if (!mayOverwriteImported(noteByKey.get(clientKey))) { skippedManual++; continue; }
    if (dry) { written++; continue; }
    await pool.query(
      `INSERT INTO client_credit_limits (client_key, limit_days, note, set_by, set_at)
       VALUES ($1, $2, $3, NULL, now())
       ON CONFLICT (client_key) DO UPDATE SET
         limit_days = EXCLUDED.limit_days, note = EXCLUDED.note, set_at = now()`,
      [clientKey, limit.limitDays, IMPORT_NOTE]);
    written++;
  }

  console.log(`${dry ? "СУХИЙ ПРОГІН · " : ""}записано ${written} · `
    + `пропущено ручних ${skippedManual} · без ліміту в аркуші ${skippedNoLimit}`);

  // 🔴 ПОРОЖНІЙ РЕЗУЛЬТАТ — ПРОВАЛ, А НЕ УСПІХ. Аркуш віддав 58 клієнтів на
  // момент заміру; нуль означає, що читання зламалось, а не що імпортувати
  // нічого. Без цієї перевірки скрипт мовчки «успішно» не зробив би нічого.
  if (written === 0 && !force) {
    console.error("🔴 записано НУЛЬ рядків — імпортувати не було чого. Це збій читання аркуша, а не успіх.");
    process.exit(1);
  }
  await pool.end();
}

// 🔴 ЗАПУСКАЄМОСЬ ЛИШЕ ЯК СКРИПТ, не на імпорті.
//
// Гейт `#183` імпортує звідси чисту функцію `mayOverwrite` — і без цієї умови
// сам імпорт стартував би ІМПОРТ У БАЗУ. Тобто тест, що перевіряє запобіжник
// від затирання даних, спершу пішов би дані затирати. Спіймано першим же
// прогоном набору.
const runDirectly = process.argv[1]?.includes("importLimitsFromSheet");
if (runDirectly) main().catch((e) => { console.error(e); process.exit(1); });
