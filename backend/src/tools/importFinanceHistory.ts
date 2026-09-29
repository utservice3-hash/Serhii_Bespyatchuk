/**
 * 💰 ОДНОРАЗОВЕ ПЕРЕНЕСЕННЯ «ВИТРАТИ ПЛАН/ФАКТ 2026» У РОЗДІЛ «ФІНАНСИ» (29.09.2026).
 *
 * Бере JSON-вивантаження таблиці (рядки «відповідальний → група → стаття», у статті [план, факт]
 * по місяцях від січня; `tot` — підсумки, як вони стоять у файлі) і переносить одним викликом ядра
 * `importHistory` в одній транзакції. Правила перенесення — у ядрі, і їх тримає гейт #935:
 * підсумок місяця = СУМА РЯДКІВ; файловий підсумок лише зберігається поруч (лютий і вересень у файлі
 * розходяться з сумою статей — екран покаже обидва числа).
 *
 * 🔴 ЗАПОБІЖНИК ВІД ПОВТОРУ — у ядрі: якщо в розділі вже є хоч один відповідальний або позначка
 * перенесення, виклик відмовляє (409). Повторний прогін НЕ затре правок Тетяни.
 *
 * Файл із цифрами в репозиторій НЕ комітиться — передається на сервер окремо й видаляється після.
 *
 * Запуск:  node dist/tools/importFinanceHistory.js <file.json> [--year=2026] [--apply]
 * Без `--apply` — лише показує, що перенесе (транзакція відкочується).
 */
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.js";
import { importHistory, type Db, type ImportFile } from "../core/finance.js";

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Вкажіть файл: node dist/tools/importFinanceHistory.js <file.json> [--year=2026] [--apply]");
  const apply = process.argv.includes("--apply");
  const year = Number((process.argv.find((a) => a.startsWith("--year=")) ?? "--year=2026").slice(7));
  const data = JSON.parse(readFileSync(file, "utf8")) as ImportFile;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await importHistory(client as unknown as Db, null, data, year, "Витрати План/Факт 2026");
    console.log(`статей: ${out.items}`);
    for (const m of out.months) {
      const dp = m.filePlan == null ? "" : Math.abs(m.filePlan - m.rowsPlan) >= 0.01 ? `  ⚠ у файлі ${m.filePlan}` : "";
      const df = m.fileFact == null ? "" : Math.abs(m.fileFact - m.rowsFact) >= 0.01 ? `  ⚠ у файлі ${m.fileFact}` : "";
      console.log(`${m.month}  план ${m.rowsPlan}${dp}  факт ${m.rowsFact}${df}`);
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(apply ? "✅ ЗАПИСАНО" : "↩︎ перевірка без запису (додайте --apply)");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

const runDirectly = process.argv[1]?.includes("importFinanceHistory");
if (runDirectly) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
