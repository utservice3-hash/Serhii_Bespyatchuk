import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGzip } from "node:zlib";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { to as copyTo } from "pg-copy-streams";
import pg from "pg";
import { config } from "../config.js";
import { plannedDeletions, copyWithRetry, COPY_ATTEMPTS, type BackupStatus } from "./backupRotateRule.js";

// Independent, off-Neon logical backup: one gzipped CSV per table (COPY = native
// Postgres, so escaping/nulls/json are handled correctly). Neon's platform
// backups (PITR) remain the primary; this is a second, portable copy on our own
// server that can be restored into ANY Postgres.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.resolve(__dirname, "..", "..", "..", "backups");

/**
 * СТАН КОПІЇ ЧИТАЄТЬСЯ З МАНІФЕСТА, А НЕ З ЙОГО НАЯВНОСТІ.
 *
 * 🔴 Було: «є MANIFEST.txt → придатна». Тоді копія на 72 таблиці важила стільки ж,
 * скільки на 78 — артефакт є, придатність невідома. Тепер маніфест починається
 * рядком `status: complete|partial`, і саме він вирішує.
 */
function backupStatus(dir: string): BackupStatus {
  const f = path.join(BACKUP_DIR, dir, "MANIFEST.txt");
  if (!existsSync(f)) return "broken";
  try {
    return /^status:\s*complete\b/m.test(readFileSync(f, "utf8")) ? "complete" : "partial";
  } catch {
    return "broken";
  }
}

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
  const newClient = () => new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 60_000,
    statement_timeout: 0,          // COPY великої таблиці не має різатись таймаутом
  });
  let client = newClient();
  const ok: string[] = [];
  const retried: { table: string; attempt: number }[] = [];
  const failed: { table: string; error: string }[] = [];
  let expected = 0;
  try {
    await client.connect();
    const tables = (
      await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      )
    ).rows.map((r) => r.tablename);
    expected = tables.length;

    for (const t of tables) {
      try {
        const usedAttempt = await copyWithRetry(
          async () => {
            const src = client.query(copyTo(`COPY "${t}" TO STDOUT WITH (FORMAT csv, HEADER)`));
            await pipeline(src, createGzip(), createWriteStream(path.join(dir, `${t}.csv.gz`)));
          },
          async (n, err) => {
            // 🔴 СВІЖЕ З'ЄДНАННЯ — не косметика. Обірване з'єднання отруєне: повтор
            // по ньому впаде так само, і три спроби стали б трьома однаковими падіннями.
            console.warn(`backupDb: "${t}" спроба ${n} невдала (${err instanceof Error ? err.message : String(err)}) — перепідключаюсь`);
            await client.end().catch(() => {});
            client = newClient();
            await client.connect();
            await new Promise((r) => setTimeout(r, 1000 * n)); // бекоф 1с, 2с
          }
        );
        ok.push(t);
        if (usedAttempt > 1) retried.push({ table: t, attempt: usedAttempt });
      } catch (err) {
        failed.push({ table: t, error: err instanceof Error ? err.message : String(err) });
        console.error(`backupDb: таблиця "${t}" не збереглась після ${COPY_ATTEMPTS} спроб:`, err);
      }
    }
    if (ok.length === 0) throw new Error("backupDb: не збережено ЖОДНОЇ таблиці — це провал, а не порожня база");
    // 🔴 МАНІФЕСТ ПИШЕТЬСЯ ОСТАННІМ і НАЗИВАЄ СТАН ПРЯМО. Копія без ЖОДНОЇ невдалої
    // таблиці — `complete`; будь-яка інша — `partial`, навіть якщо бракує однієї.
    // «Придатна» більше не означає «щось вивантажилось».
    const status = failed.length === 0 ? "complete" : "partial";
    writeFileSync(
      path.join(dir, "MANIFEST.txt"),
      `UTS Dashboard backup\nstatus: ${status}\ncreated: ${new Date().toISOString()}\n`
      + `tables expected: ${expected}\ntables ok: ${ok.length}\ntables failed: ${failed.length}\n`
      + `tables retried: ${retried.length}\n`
      + `format: gzipped CSV (COPY ... WITH CSV HEADER)\n\n`
      + `=== OK ===\n${ok.join("\n")}\n`
      + (retried.length ? `\n=== RETRIED (вдались НЕ з першої спроби) ===\n${retried.map((r) => `${r.table}: спроба ${r.attempt}`).join("\n")}\n` : "")
      + (failed.length ? `\n=== FAILED ===\n${failed.map((f) => `${f.table}: ${f.error}`).join("\n")}\n` : "")
    );
    console.log(`DB backup ${status}: ${dir} — ${ok.length}/${expected} таблиць`
      + `${retried.length ? `, ${retried.length} з повтору` : ""}${failed.length ? `, ${failed.length} втрачено` : ""}.`);
    if (failed.length) throw new Error(`backupDb: копія ЧАСТКОВА — ${failed.length} із ${expected} таблиць не збереглись (${failed.map((f) => f.table).join(", ")})`);
  } finally {
    await client.end().catch(() => {});
    rotate();
  }
}




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
    const dirs = all.map((name) => ({ name, status: backupStatus(name) }));
    const complete = dirs.filter((d) => d.status === "complete").map((d) => d.name);
    const partial = dirs.filter((d) => d.status === "partial").map((d) => d.name);
    const broken = dirs.filter((d) => d.status === "broken").map((d) => d.name);
    if (partial.length) console.warn(`backupDb: ЧАСТКОВИХ копій ${partial.length}: ${partial.join(", ")}`);
    if (broken.length) console.warn(`backupDb: ОБІРВАНИХ копій ${broken.length} (без MANIFEST.txt): ${broken.join(", ")}`);
    console.log(`backupDb: ЦІЛИХ копій ${complete.length}${complete.length ? ` (найсвіжіша ${complete[complete.length - 1]})` : " — ЖОДНОЇ"}`);
    for (const name of plannedDeletions(dirs, Date.now())) {
      rmSync(path.join(BACKUP_DIR, name), { recursive: true, force: true });
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
