/**
 * 🌱 РАЗОВИЙ ЗАСІВ ОБЛІКУ `data_sheet_exports` — операції, перенесені в «Data» вручну 18.11.2026 (рядки 13853–25101,
 * вивантаження бази 17.11.2026 22:01, 10 788 id). Без засіву перший прогін `exportDataSheet` записав би їх у Data вдруге.
 *
 *   node dist/tools/seedDataSheetExports.js <файл з id через кому>            # перевірка: скільки нових, нічого не пише
 *   node dist/tools/seedDataSheetExports.js <файл з id через кому> --write    # засіяти (status done, source manual-2026-11-18)
 *
 * Повторний запуск нічого не змінює (ON CONFLICT DO NOTHING). Після запису — окремий підрахунок по таблиці, а не віра
 * виводу INSERT. Відкат: `DELETE FROM data_sheet_exports WHERE source = 'manual-2026-11-18'`.
 */
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.js";

const SOURCE = "manual-2026-11-18";
const file = process.argv[2];
const write = process.argv.includes("--write");
if (!file || file.startsWith("--")) { console.error("Потрібен файл з id через кому"); process.exit(2); }
const ids = [...new Set(readFileSync(file, "utf8").split(/[\s,]+/).filter(Boolean).map(Number))];
if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) { console.error("У файлі не лише додатні цілі id"); process.exit(2); }

try {
  const known = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM bank_transactions WHERE id = ANY($1::int[])`, [ids])).rows[0].n;
  const fresh = (await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM unnest($1::int[]) AS v(id) WHERE NOT EXISTS (SELECT 1 FROM data_sheet_exports x WHERE x.tx_id = v.id)`, [ids])).rows[0].n;
  console.log(`id у файлі: ${ids.length}; із них є в bank_transactions: ${known}; ще не в обліку: ${fresh}`);
  if (write) {
    await pool.query(`INSERT INTO data_sheet_exports (tx_id, status, run_at, source)
      SELECT v.id, 'done', '2026-11-18 14:30:00+02', $2 FROM unnest($1::int[]) AS v(id) ON CONFLICT (tx_id) DO NOTHING`, [ids, SOURCE]);
    const after = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM data_sheet_exports WHERE source = $1`, [SOURCE])).rows[0].n;
    console.log(`✅ у обліку з позначкою ${SOURCE}: ${after} (очікувано ${ids.length})`);
    if (Number(after) !== ids.length) process.exitCode = 1;
  } else {
    console.log("ℹ️ перевірка, нічого не записано; запис: --write");
  }
} finally {
  await pool.end();
}
