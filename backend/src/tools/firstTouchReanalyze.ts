/**
 * 🔁 ПЕРЕАНАЛІЗ КАНДИДАТІВ «НЕЗРУЧНО ГОВОРИТИ» рубрикою v4 (рішення Романа 09.10.2026). Кандидати —
 * `core/callAiTick.callLaterCandidates`; черга — `enqueueAnalyses`, розбір — звичайний тік «Першого дотику»
 * (раз на 10 хв, у межах стелі витрат). Старий розбір v3 лишається в базі поруч, екран бере v4, щойно вона готова.
 *
 *   node dist/tools/firstTouchReanalyze.js            # список кандидатів, нічого не пише
 *   node dist/tools/firstTouchReanalyze.js --write    # поставити в чергу v4
 *
 * Повторний запуск нічого не дублює: черга — `ON CONFLICT DO NOTHING`, готові v4 кандидатами не вважаються.
 */
import { pool } from "../db/pool.js";
import { callLaterCandidates } from "../core/callAiTick.js";
import { enqueueAnalyses } from "../core/callAiPipeline.js";
import { LLM_PROVIDER, STT_PROVIDER } from "../core/callAiPilot.js";
import { ELEVENLABS_STT_MODEL, GEMINI_MODEL, RUBRIC_CURRENT } from "../core/callAiProviders.js";

const write = process.argv.includes("--write");
const client = await pool.connect();
try {
  const ids = await callLaterCandidates(client);
  for (const u of ids) console.log(u);
  if (write) {
    const n = await enqueueAnalyses(client, { provider: LLM_PROVIDER, model: GEMINI_MODEL, rubricVersion: RUBRIC_CURRENT,
      sttProvider: STT_PROVIDER, sttModel: ELEVENLABS_STT_MODEL, now: new Date() }, ids);
    console.log(`✅ у черзі ${RUBRIC_CURRENT}: ${String(n)} із ${String(ids.length)} кандидатів`);
  } else console.log(`ℹ️ кандидатів ${String(ids.length)} — це лише список; запис: --write`);
} finally {
  client.release();
  await pool.end();
}
