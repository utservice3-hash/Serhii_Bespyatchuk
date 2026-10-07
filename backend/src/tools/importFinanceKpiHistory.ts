/**
 * 💰 ОДНОРАЗОВЕ ПЕРЕНЕСЕННЯ АРКУША «ФМ» У «ФІНАНСИ → ТИЖДЕНЬ І МІСЯЦЬ» (прохід 2а, 01.10.2026).
 *
 * Бере JSON, зібраний із вкладки «ФМ» книги «UTS Щотижневі плани ROP HR CОО» (блоки по 11 колонок, рядки як у
 * CSV-вивантаженні), і переносить одним викликом ядра `importFm` в одній транзакції. Правила — у ядрі, тримає #946:
 * тиждень — фінальне значення з наступного блоку, інакше проміжне; місяці — за групами блоків; обчислювані рядки
 * лише звіряються, розбіжності друкуються й лягають у `fin_kpi_imports.detail`.
 *
 * 🔴 ЗАПОБІЖНИК ВІД ПОВТОРУ — у ядрі (409), тож повторний прогін не затре правок Тетяни.
 * Файл із цифрами в репозиторій НЕ комітиться — передається на сервер окремо й видаляється після.
 *
 * Запуск:  node dist/tools/importFinanceKpiHistory.js <file.json> [--from=2025-12-29] [--apply]
 */
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.js";
import { importFm, type FmFile } from "../core/financeKpi.js";
import type { Db } from "../core/finance.js";

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) throw new Error("Вкажіть файл: node dist/tools/importFinanceKpiHistory.js <file.json> [--from=2025-12-29] [--apply]");
  const apply = process.argv.includes("--apply");
  const from = (process.argv.find((a) => a.startsWith("--from=")) ?? "--from=2025-12-29").slice(7);
  const data = JSON.parse(readFileSync(file, "utf8")) as FmFile;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await importFm(client as unknown as Db, null, data, from);
    console.log(`тижнів: ${out.weeks} · місяців: ${out.months} · значень: ${out.values}`);
    console.log(`проміжні (не фінальні у файлі): тижні ${out.interim.week.join(", ") || "—"} · місяці ${out.interim.month.join(", ") || "—"}`);
    console.log(`розбіжностей файлу: ${out.mismatches.length}`);
    for (const m of out.mismatches) console.log(`  · ${m}`);
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

const runDirectly = process.argv[1]?.includes("importFinanceKpiHistory");
if (runDirectly) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
