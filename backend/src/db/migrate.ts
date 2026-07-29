import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { pool } from "./pool.js";
import { seedOneOnOneForms } from "../oneOnOne/catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  await pool.query(sql);
  console.log("Migration applied.");

  await seedOneOnOneForms(pool);
  console.log("1×1 forms seeded (v1 A/B/V if absent).");

  if (process.argv.includes("--with-kommo-mapping")) {
    const mappingSql = readFileSync(
      path.join(__dirname, "seedKommoMapping.sql"),
      "utf-8"
    );
    await pool.query(mappingSql);
    console.log("Kommo team/pipeline mapping applied.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
