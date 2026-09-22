import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { adDealSql } from "../core/metrics.js";
import { getSettings } from "../routes/settings.js";
import { parsePilotArgs, planPilot, planToJsonl, runPilot } from "../core/callAiPilot.js";

/**
 * 🧪 CLI ПІЛОТА AI-АНАЛІЗУ ДЗВІНКІВ (логіка — `core/callAiPilot.ts`).
 *
 * СУХИЙ ПРОГІН (за замовчуванням) — лише читання, у ролі `test_readonly`:
 *   cd backend && set -a && . ./.env && set +a && TEST_SCOPE=prod \
 *     node --import ./dist/testReadOnly.js dist/tools/callAiPilot.js \
 *       --from=2026-09-01 --to=2026-09-21 --limit=30 \
 *       --talk-min-sec=<поріг> --window-before="<N days>" --flag=<lead_channel|ad_deal_sql|either>
 *
 * ПРОГІН `--go` — ПИШЕ в базу (черга, розшифровки, журнал витрат) і ПЛАТИТЬ постачальникам.
 * Запускати лише за словом власника, після юридичного питання про записи (П22–П23):
 *   … dist/tools/callAiPilot.js <ті самі аргументи> --go \
 *       --stt-usd-per-hour=<тариф> --stt-cap-usd=<стеля> \
 *       --llm-usd-per-mtok-in=<тариф> --llm-usd-per-mtok-out=<тариф> --llm-cap-usd=<стеля> \
 *       --max-output-tokens=<стеля виходу>
 * Хост убиває другий Node-процес за 1–2 хв — повторити ту саму команду, вона продовжить.
 *
 * План пишеться у файл JSONL (шлях друкується): ідентифікатори й тривалості, БЕЗ номерів клієнтів
 * і БЕЗ URL записів — URL запису Ringostat відкривається без логіна.
 */

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const a = parsePilotArgs(process.argv.slice(2),
      (from, to) => path.join(tmpdir(), "ai-pilot", `plan-${from}_${to}.jsonl`));
    const role = (await pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
    if (!a.go && role !== "test_readonly")
      throw new Error(`callAiPilot: сухий прогін у ролі «${String(role)}», а не test_readonly. `
        + "Запускати через `TEST_SCOPE=prod node --import ./dist/testReadOnly.js`.");
    if (a.go && role === "test_readonly")
      throw new Error("callAiPilot --go: роль test_readonly не може писати чергу — запуск без preload.");

    const { adSources } = await getSettings();
    const now = new Date();
    const plan = await planPilot(pool, a, { predicate: adDealSql, adSources }, now);
    mkdirSync(path.dirname(a.out), { recursive: true });
    writeFileSync(a.out, planToJsonl(plan), { mode: 0o600 });
    console.log(JSON.stringify({
      mode: a.go ? "go" : "dry-run", period: `${a.from}…${a.to}`, flag: a.flag, talkMinSec: a.talkMinSec,
      windowBefore: a.windowBefore, calls: plan.calls, withRecording: plan.withRecording,
      talkMin: Math.round(plan.talkSec / 60), audioMin: Math.round(plan.audioSec / 60),
      estSttUsd: plan.estSttUsd == null ? "ціну не названо (--stt-usd-per-hour)" : Number(plan.estSttUsd.toFixed(3)),
      plan: a.out,
    }, null, 2));
    if (!a.go) return;

    const summary = await runPilot({
      db: pool,
      http: { fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), nowMs: () => Date.now() },
      keys: { elevenlabs: config.callAi.elevenlabsApiKey, gemini: config.callAi.geminiApiKey },
      now: () => new Date(),
      log: (l) => console.log(l),
    }, plan, a);
    console.log(JSON.stringify({ transcripts: summary.transcripts, analyses: summary.analyses,
      spendUsdThisMonth: summary.spendUsd, stoppedBy: summary.stoppedBy }, null, 2));
  })()
    .then(() => pool.end())
    .catch((err: Error) => { console.error(`callAiPilot: ${err.message}`); process.exit(1); });
}
