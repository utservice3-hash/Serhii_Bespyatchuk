/**
 * 💎 `buildLeadgenLtv` — перезбирає LTV клієнтів лідогенерації кожні 30 хв (о :12 і :42 — не :00/:30 синку Kommo, не
 * :05/:35 фінансових полів, не :15/:45 подій стадій). ТЗ п. 10: «за весь час» — важкий запит, тож рахується заздалегідь.
 * Звертається до Kommo лише по нові передачі (хто перевів у «Кваліфіковано»), по 10 угод за запит, лише читання.
 * Пропуск — `jobSkip`, не успіх; обсяг — у підсумку (джоба-імпортер: «відпрацювала» без «скільки» нічого не означає).
 * ⏱ Прапорець «уже працює» має СТЕЛЮ: завислий проміс не виконує `finally` (правило зони jobs-sync).
 */
import { pool } from "../db/pool.js";
import { buildLeadgenLtv as build } from "../core/leadgenLtv.js";
import { jobSkip } from "./jobRuns.js";

const CEILING_MS = 25 * 60_000;
let running: number | null = null;

export async function buildLeadgenLtv(): Promise<unknown> {
  if (running && Date.now() - running < CEILING_MS) return jobSkip("LTV лідогенерації: попереднє збирання ще йде");
  running = Date.now();
  try { return await build(); } finally { running = null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `--dry` — замір без запису (див. `core/leadgenLtv`); без нього — те саме, що крон.
  (process.argv.includes("--dry") ? build({ dry: true }) : buildLeadgenLtv()).then((r) => console.log("buildLeadgenLtv:", JSON.stringify(r)))
    .catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
}
