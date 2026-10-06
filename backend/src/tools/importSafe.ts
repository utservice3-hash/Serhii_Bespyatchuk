/**
 * 💰 ПЕРЕНЕСЕННЯ ТАБЛИЦІ «СЕЙФ» У «ВИПИСКУ» (рахунок `bank = 'manual'`, «Сейф»). Роман 05.10.2026: «роби, переносимо
 * як є» — з початку року, з категоріями й описами як у таблиці (там є зарплати з прізвищами: рахунок «лише фінанси»,
 * його бачать адмін і фінансист, не менеджери й не AI).
 *
 * Джерело — CSV вкладки «Сейф» книги «UTS Сделки Сводка». Правила розбору й запису — у ядрі (`parseSafeCsv`,
 * `importSafe`, тримає #1219): залишки пропускаються, гривня — зі стовпця таблиці зі знаком операції, повтор — 0 нових.
 * Файл у репозиторій НЕ комітиться — кладеться на сервер окремо й видаляється після.
 *
 * Запуск:  node dist/tools/importSafe.js <safe.csv> [--from=2026-01-01] [--apply]
 */
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.js";
import { parseCsv } from "../utils/csv.js";
import { parseSafeCsv, importSafe } from "../core/bankManual.js";
import { getRate } from "../bankSources/fx.js";
import type { Db } from "../core/finance.js";

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) throw new Error("node dist/tools/importSafe.js <safe.csv> [--from=2026-01-01] [--apply]");
  const from = (process.argv.find((a) => a.startsWith("--from=")) ?? "--from=2026-01-01").slice(7);
  const apply = process.argv.includes("--apply");
  const parsed = parseSafeCsv(parseCsv(readFileSync(file, "utf8")), from);
  const inUah = parsed.rows.filter((r) => r.uah != null);
  const sum = (d: 1 | -1) => Math.round(inUah.filter((r) => Math.sign(r.amount) === d).reduce((a, r) => a + Math.abs(r.uah!), 0) * 100) / 100;
  console.log(`рядків до перенесення: ${parsed.rows.length} (з ${from}) · пропущено: ${JSON.stringify(parsed.skipped)}`);
  console.log(`у гривні за таблицею: прийшло ${sum(1)} · пішло ${sum(-1)} · без гривні (курс НБУ при записі): ${parsed.rows.length - inUah.length}`);
  const acc = await pool.query<{ id: number }>(`SELECT id FROM bank_accounts WHERE bank = 'manual' AND label = 'Сейф' ORDER BY id LIMIT 1`);
  if (!acc.rows[0]) throw new Error("Рахунку «Сейф» немає");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await importSafe(client as unknown as Db, acc.rows[0].id, parsed.rows, (ccy, day) => getRate(ccy, new Date(`${day}T12:00:00Z`)));
    console.log(`нових: ${out.inserted} · уже були: ${out.existing}`);
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

const runDirectly = process.argv[1]?.includes("importSafe");
if (runDirectly) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
