import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGzip } from "node:zlib";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { to as copyTo } from "pg-copy-streams";
import pg from "pg";
import { config } from "../config.js";

// Independent, off-Neon logical backup: one gzipped CSV per table (COPY = native
// Postgres, so escaping/nulls/json are handled correctly). Neon's platform
// backups (PITR) remain the primary; this is a second, portable copy on our own
// server that can be restored into ANY Postgres.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.resolve(__dirname, "..", "..", "..", "backups");
const KEEP = 14; // keep the newest 14 COMPLETE daily backups

/** Копія вважається придатною ТІЛЬКИ з маніфестом — він пишеться останнім. */
const isComplete = (dir: string): boolean => existsSync(path.join(BACKUP_DIR, dir, "MANIFEST.txt"));

/**
 * 🔴 РОЗБІР 10.08.2026: З 26 КОПІЙ ПРИДАТНИМИ БУЛИ ТРИ.
 *
 * Каталог виглядав здоровим — 26 щоденних папок, 143 МБ. Насправді `MANIFEST.txt`
 * мали лише 20.07, 25.07 і 29.07; останній ПОВНИЙ бекап був за 12 днів до розбору,
 * а три з останніх чотирьох папок були ПОРОЖНІ (0 файлів). Тобто «бекапи є»
 * підтверджувалось наявністю папок, а не вмістом.
 *
 * Чотири причини, усі усунуті тут:
 *  1. **Спільний пул застосунку** (`max: 6`, `connectionTimeoutMillis: 10_000`).
 *     Бекап тримає одне з шести з'єднань годинами, а о 03:00 за Києвом поруч
 *     працюють інші джоби. Падало на `pool.connect()`: «Connection terminated due
 *     to connection timeout». Тепер — ВЛАСНЕ з'єднання, повз пул.
 *  2. **Одна помилка вбивала весь прогін.** Тепер кожна таблиця у своєму
 *     try/catch: збій однієї не позбавляє нас інших сімдесяти семи.
 *  3. **Ротація стояла ПІСЛЯ циклу й поза `finally`** — тож на кожному падінні не
 *     виконувалась. Звідси 26 папок при `KEEP = 14`. Тепер у `finally`.
 *  4. **Ротація рахувала ПАПКИ, а не придатні копії.** Найнебезпечніше: полагодивши
 *     решту, вона видалила б три ЄДИНІ повні копії як «старі», лишивши чотирнадцять
 *     порожніх. Тепер `KEEP` рахується лише серед повних, а неповні прибираються
 *     окремо і завжди.
 *
 * ⚠️ Порожній результат — ПРОВАЛ: якщо не збереглась жодна таблиця, кидаємо, щоб
 * `runJob` записав помилку, а не тихий успіх.
 */
export async function backupDb(): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  const dir = path.join(BACKUP_DIR, `uts_${stamp}`);
  mkdirSync(dir, { recursive: true });

  // Власне з'єднання, а НЕ `pool`: бекап довгий, і забирати в застосунку одне з
  // шести з'єднань на весь час — саме те, через що він і падав.
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 60_000,
    statement_timeout: 0,          // COPY великої таблиці не має різатись таймаутом
  });
  const ok: string[] = [];
  const failed: { table: string; error: string }[] = [];
  try {
    await client.connect();
    const tables = (
      await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      )
    ).rows.map((r) => r.tablename);

    for (const t of tables) {
      try {
        const src = client.query(copyTo(`COPY "${t}" TO STDOUT WITH (FORMAT csv, HEADER)`));
        await pipeline(src, createGzip(), createWriteStream(path.join(dir, `${t}.csv.gz`)));
        ok.push(t);
      } catch (err) {
        failed.push({ table: t, error: err instanceof Error ? err.message : String(err) });
        console.error(`backupDb: таблиця "${t}" не збереглась:`, err);
      }
    }
    if (ok.length === 0) throw new Error("backupDb: не збережено ЖОДНОЇ таблиці — це провал, а не порожня база");
    // МАНІФЕСТ ПИШЕТЬСЯ ОСТАННІМ і є єдиною ознакою придатності копії. Він же
    // чесно перелічує невдалі таблиці — «повна копія з дірками» гірша за видиму дірку.
    writeFileSync(
      path.join(dir, "MANIFEST.txt"),
      `UTS Dashboard backup\ncreated: ${new Date().toISOString()}\n`
      + `tables ok: ${ok.length}\ntables failed: ${failed.length}\n`
      + `format: gzipped CSV (COPY ... WITH CSV HEADER)\n\n`
      + `=== OK ===\n${ok.join("\n")}\n`
      + (failed.length ? `\n=== FAILED ===\n${failed.map((f) => `${f.table}: ${f.error}`).join("\n")}\n` : "")
    );
    console.log(`DB backup complete: ${dir} (${ok.length} таблиць${failed.length ? `, ${failed.length} з помилкою` : ""}).`);
    if (failed.length) throw new Error(`backupDb: ${failed.length} таблиць не збереглись (${failed.map((f) => f.table).join(", ")})`);
  } finally {
    await client.end().catch(() => {});
    rotate();
  }
}

/** Скільки днів тримаємо НЕПОВНІ копії, перш ніж прибрати (див. коментар у `rotate`). */
const KEEP_BROKEN_DAYS = 14;

/**
 * Ротація — у `finally`, і рахує ЛИШЕ придатні копії (причини 3 і 4 вище).
 *
 * 🔴 НЕПОВНІ НЕ ЗНОСИМО ОДРАЗУ — свідоме рішення. Перша редакція цієї функції
 * видаляла всі копії без маніфесту, і на момент розбору це були б 23 каталоги
 * (частина з них — 12-17 МБ реальних даних). Знести без нагляду 23 каталоги в
 * системі, де бекапи ЩОЙНО виявились ненадійними, — гірше за проблему, яку це
 * лікує: неповна копія все ж містить частину таблиць, а місця на диску вдосталь
 * (143 МБ проти 2.7 ТБ вільних). Тому вони: (а) НЕ рахуються в `KEEP`, бо копією
 * не є; (б) прибираються лише коли старші за `KEEP_BROKEN_DAYS`, тобто місце
 * обмежене, але слідів для розбору ми себе не позбавляємо.
 */
function rotate(): void {
  try {
    const all = readdirSync(BACKUP_DIR).filter((n) => n.startsWith("uts_")).sort();
    const complete = all.filter(isComplete);
    const broken = all.filter((n) => !isComplete(n));
    if (broken.length) {
      console.warn(`backupDb: НЕПОВНИХ копій ${broken.length} (без MANIFEST.txt): ${broken.join(", ")}`);
    }
    const cutoff = Date.now() - KEEP_BROKEN_DAYS * 86_400_000;
    for (const bad of broken) {
      // Дата — з імені каталогу `uts_YYYY-MM-DD_HH-MM-SS`; нерозбірне ім'я лишаємо.
      const ts = Date.parse(bad.slice(4, 14));
      if (Number.isFinite(ts) && ts < cutoff) rmSync(path.join(BACKUP_DIR, bad), { recursive: true, force: true });
    }
    for (const old of complete.slice(0, Math.max(0, complete.length - KEEP))) {
      rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Backup rotation failed:", err);
  }
}

// CLI-режим. Пул застосунку більше не задіяний (бекап тримає власне з'єднання і
// закриває його сам), тож закривати тут нічого — процес виходить одразу.
if (import.meta.url === `file://${process.argv[1]}`) {
  backupDb()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
