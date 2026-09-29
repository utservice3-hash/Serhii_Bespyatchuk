import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { pilotVerdict, planCarrierPilot, runCarrierPilot } from "../core/carrierCallPilot.js";

/**
 * 🧪 CLI ПІЛОТУ «ПЕРЕВІЗНИКІВ ЗА РОЗМОВОЮ» (логіка — `core/carrierCallPilot.ts`).
 *
 * СУХИЙ ПРОГІН (за замовчуванням) — лише читання, у ролі `test_readonly`: скільки угод і хвилин піде в пілот.
 *   cd backend && set -a && . ./.env && set +a && TEST_SCOPE=prod \
 *     node --import ./dist/testReadOnly.js dist/tools/carrierCallPilot.js [--per-group=50]
 *
 * `--go` — ПИШЕ в чергу й ПЛАТИТЬ (≈ $2 за 100 розмов; ціни й стелі — з .env, плюс стеля мобільних $15).
 * Повтор тієї самої команди не платить удруге: розшифровки й аналізи вже є.
 *   … dist/tools/carrierCallPilot.js --go [--per-group=50]
 * Звіт — без номерів телефонів.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const go = process.argv.includes("--go");
    const n = Number(process.argv.find((a) => a.startsWith("--per-group="))?.split("=")[1] ?? 50);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error(`--per-group поза 1..200: ${String(n)}`);
    const role = (await pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
    if (!go && role !== "test_readonly")
      throw new Error(`сухий прогін у ролі «${String(role)}», а не test_readonly — запускати через --import ./dist/testReadOnly.js`);
    if (go && role === "test_readonly") throw new Error("--go: роль test_readonly не може писати чергу — запуск без preload.");

    const picks = await planCarrierPilot(pool, n);
    const min = (g: string) => Math.round(picks.filter((p) => p.group === g).reduce((s, p) => s + p.billsec, 0) / 60);
    console.log(JSON.stringify({ mode: go ? "go" : "dry-run",
      carriers: picks.filter((p) => p.group === "carrier").length, carrierMin: min("carrier"),
      clients: picks.filter((p) => p.group === "client").length, clientMin: min("client") }, null, 2));
    if (!go) return;

    const run = await runCarrierPilot({
      db: pool,
      http: { fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), nowMs: () => Date.now() },
      keys: { elevenlabs: config.callAi.elevenlabsApiKey, gemini: config.callAi.geminiApiKey },
      prices: config.callAi.prices,
      now: () => new Date(),
    }, picks);
    const v = await pilotVerdict(pool, picks);
    console.log(JSON.stringify({ ...run, ...v }, null, 2));
  })()
    .then(() => pool.end())
    .catch((err: Error) => { console.error(`carrierCallPilot: ${err.message}`); process.exit(1); });
}
