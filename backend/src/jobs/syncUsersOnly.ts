import { pool } from "../db/pool.js";
import { syncManagers } from "./syncKommo.js";

async function main() {
  const count = await syncManagers();
  console.log(`Synced ${count} managers (users only, no deals).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
