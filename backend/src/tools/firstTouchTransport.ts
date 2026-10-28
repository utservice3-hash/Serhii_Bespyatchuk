/**
 * 🚛 ВИД ПЕРЕВЕЗЕННЯ ДЛЯ ВЖЕ РОЗІБРАНИХ РОЗМОВ (задача 7183). Звичайний тік бере на цю рубрику 20 с за 10 хв — розмови
 * з 20.09 він доганяв би годинами. Тут — разово, у межах тієї самої стелі витрат місяця, без повторного розпізнавання.
 *
 *   node dist/tools/firstTouchTransport.js              # скільки кандидатів, нічого не пише
 *   node dist/tools/firstTouchTransport.js --drain=15   # поставити в чергу і розбирати до 15 хв
 *
 * Повторний запуск нічого не дублює: черга — `ON CONFLICT DO NOTHING`, розібрані вдруге не платяться.
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { drainWithBudget, objectionCandidates, TICK_MAX_ATTEMPTS, TICK_PORTION, TRANSPORT_MAX_OUTPUT_TOKENS } from "../core/callAiTick.js";
import { enqueueAnalyses, runAnalysisPortion, type PortionReport } from "../core/callAiPipeline.js";
import { LLM_POLICY, LLM_PROVIDER, STT_PROVIDER, STUCK_AFTER_MIN } from "../core/callAiPilot.js";
import { ELEVENLABS_STT_MODEL, GEMINI_MODEL, geminiGenerate } from "../core/callAiProviders.js";
import { RUBRIC_TRANSPORT_V1, TRANSPORT_FROM, TRANSPORT_KIT } from "../core/firstTouchTransport.js";

const drainArg = process.argv.find((a) => a.startsWith("--drain="));
const minutes = drainArg ? Number(drainArg.slice("--drain=".length)) : 0;
if (drainArg && !(minutes > 0 && minutes <= 60)) throw new Error("--drain=N: хвилин від 1 до 60");

const http = { fetch, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), nowMs: () => Date.now() };
const op = { provider: LLM_PROVIDER, model: GEMINI_MODEL, rubricVersion: RUBRIC_TRANSPORT_V1, sttProvider: STT_PROVIDER, sttModel: ELEVENLABS_STT_MODEL };
try {
  const ids = await objectionCandidates(pool, TRANSPORT_FROM);
  const done = Number((await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM call_analyses WHERE rubric_version = $1 AND status = 'done'`, [RUBRIC_TRANSPORT_V1])).rows[0].n);
  console.log(`кандидатів (розібрані розмови з ${TRANSPORT_FROM}): ${String(ids.length)} · уже розібрано видом перевезення: ${String(done)}`);
  if (!drainArg) console.log("ℹ️ це лише підрахунок; розібрати: --drain=15");
  else {
    const n = await enqueueAnalyses(pool, { ...op, now: new Date() }, ids);
    console.log(`у черзі нових: ${String(n)}`);
    const p = config.callAi.prices;
    const reports: PortionReport[] = [];
    const r = await drainWithBudget(() => runAnalysisPortion(pool, {
      apiKey: config.callAi.geminiApiKey ?? "", kit: TRANSPORT_KIT,
      generate: (key, model, body) => geminiGenerate(http, key, model, body, LLM_POLICY),
    }, {
      ...op, now: new Date(), operation: "analysis", limit: TICK_PORTION, maxAttempts: TICK_MAX_ATTEMPTS, stuckAfterMin: STUCK_AFTER_MIN,
      monthCapUsd: p.llmMonthCapUsd, maxOutputTokens: TRANSPORT_MAX_OUTPUT_TOKENS,
      usdPerInputToken: p.llmUsdPerMtokIn == null ? null : p.llmUsdPerMtokIn / 1e6,
      usdPerOutputToken: p.llmUsdPerMtokOut == null ? null : p.llmUsdPerMtokOut / 1e6,
    }), minutes * 60_000, http.nowMs, reports);
    const sum = (k: "done" | "failed") => reports.reduce((s, x) => s + (x[k] ?? 0), 0);
    console.log(`✅ розібрано ${String(sum("done"))}, з помилкою ${String(sum("failed"))}${r.stoppedBy ? ` · зупинка: ${r.stoppedBy}` : ""}${r.error ? ` · ${r.error.message}` : ""}`);
  }
} finally {
  await pool.end();
}
