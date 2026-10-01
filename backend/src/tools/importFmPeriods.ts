/**
 * 💰 «БЕКФІЛ ПО ТАБЛИЦІ»: ФІНАЛЬНІ ЧИСЛА ОКРЕМИХ ПЕРІОДІВ З АРКУША «ФМ» (прохід 2б, 01.10.2026).
 *
 * Разове перенесення (`importFinanceKpiHistory`) повторити не можна (409), а тиждень 28.09 і вересень на момент
 * перенесення були ПРОМІЖНИМИ. Цей інструмент дотягує фінал лише названих періодів, коли Тетяна закрила їх у таблиці
 * (фінал тижня зʼявляється в наступному блоці). Правила — у ядрі `importFmPeriods`, тримає #990: лише до старту
 * автоматики (`FM_AUTO_FROM`), лише незакриті, лише фінальні; період після запису закривається.
 *
 * Файл — той самий JSON, що для разового перенесення (блоки вкладки «ФМ»). У репозиторій НЕ комітиться.
 *
 * Запуск:  node dist/tools/importFmPeriods.js <file.json> --period=week:2026-09-28 --period=month:2026-09-01 [--apply]
 */
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.js";
import { importFmPeriods, type FmFile, type PeriodKind } from "../core/financeKpi.js";
import type { Db } from "../core/finance.js";

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const targets = process.argv.filter((a) => a.startsWith("--period=")).map((a) => {
    const [kind, start] = a.slice(9).split(":");
    if ((kind !== "week" && kind !== "month") || !/^\d{4}-\d{2}-\d{2}$/.test(start ?? "")) throw new Error(`Не розібрано ${a}: очікую --period=week:YYYY-MM-DD`);
    return { kind: kind as PeriodKind, start };
  });
  if (!file || !targets.length) throw new Error("node dist/tools/importFmPeriods.js <file.json> --period=week:2026-09-28 [--period=month:2026-09-01] [--apply]");
  const apply = process.argv.includes("--apply");
  const data = JSON.parse(readFileSync(file, "utf8")) as FmFile;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of await importFmPeriods(client as unknown as Db, null, data, targets)) {
      console.log(`${p.kind} ${p.start}: змінено ${p.changed.length}, період закрито`);
      for (const c of p.changed) console.log(`  · ${c}`);
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

const runDirectly = process.argv[1]?.includes("importFmPeriods");
if (runDirectly) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
