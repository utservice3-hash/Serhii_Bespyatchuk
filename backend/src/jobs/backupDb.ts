import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGzip } from "node:zlib";
import { createWriteStream, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { to as copyTo } from "pg-copy-streams";
import { pool } from "../db/pool.js";

// Independent, off-Neon logical backup: one gzipped CSV per table (COPY = native
// Postgres, so escaping/nulls/json are handled correctly). Neon's platform
// backups (PITR) remain the primary; this is a second, portable copy on our own
// server that can be restored into ANY Postgres.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.resolve(__dirname, "..", "..", "..", "backups");
const KEEP = 14; // keep the newest 14 daily backups

export async function backupDb(): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  const dir = path.join(BACKUP_DIR, `uts_${stamp}`);
  mkdirSync(dir, { recursive: true });

  const client = await pool.connect();
  try {
    const tables = (
      await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
      )
    ).rows.map((r) => r.tablename);

    for (const t of tables) {
      const src = client.query(copyTo(`COPY "${t}" TO STDOUT WITH (FORMAT csv, HEADER)`));
      await pipeline(src, createGzip(), createWriteStream(path.join(dir, `${t}.csv.gz`)));
    }
    writeFileSync(
      path.join(dir, "MANIFEST.txt"),
      `UTS Dashboard backup\ncreated: ${new Date().toISOString()}\ntables: ${tables.length}\nformat: gzipped CSV (COPY ... WITH CSV HEADER)\n\n${tables.join("\n")}\n`
    );
    console.log(`DB backup complete: ${dir} (${tables.length} tables).`);
  } finally {
    client.release();
  }

  // Rotate — keep only the newest KEEP backup folders.
  try {
    const all = readdirSync(BACKUP_DIR).filter((n) => n.startsWith("uts_")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
      rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Backup rotation failed:", err);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backupDb()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
