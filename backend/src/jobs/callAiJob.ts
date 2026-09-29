import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { adDealSql } from "../core/metrics.js";
import { getSettings } from "../routes/settings.js";
import { sendAdminAlert } from "../bot/notify.js";
import { runCallAiTick, type TickReport } from "../core/callAiTick.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * ⏰ AI-АНАЛІЗ ДЗВІНКІВ ПЕРШОГО ДОТИКУ — щогодинна джоба (ТЗ «AI-аналіз», коміт ④).
 *
 * Уся логіка — у `core/callAiTick.ts` (без пулу; гейти ганяють її на scratch-базі). Тут лише
 * пул, налаштування (`adSources`), ключі й ціни з `.env` і охоронець від накладання тіків.
 *
 * Без ключів — «не ввімкнено», назовні нуль запитів, джоба зелена. З ключами, але без цін чи
 * стель — «не налаштовано» (вид `config`), жодної витрати. Помилка постачальника — вид `ai`.
 */
const guard = createRunGuard("callAiJob");

export async function callAiJob(): Promise<TickReport | GuardSkip> {
  return guard(async () => {
    const { adSources } = await getSettings();
    const r = await runCallAiTick({
      db: pool,
      http: { fetch, sleep: (ms) => new Promise((res) => setTimeout(res, ms)), nowMs: () => Date.now() },
      keys: { elevenlabs: config.callAi.elevenlabsApiKey, gemini: config.callAi.geminiApiKey },
      ad: { predicate: adDealSql, adSources },
      prices: config.callAi.prices,
      now: () => new Date(),
      alert: sendAdminAlert,
    });
    const sum = (xs: TickReport["stt"], k: "done" | "failed" | "unavailable") => xs.reduce((s, x) => s + x[k], 0);
    console.log(`callAiJob: відібрано ${String(r.selected)}, нових у черзі ${String(r.enqueued)}, прибрано з черги ${String(r.dequeued)} · `
      + `розпізнано ${String(sum(r.stt, "done"))} (без запису ${String(sum(r.stt, "unavailable"))}) · `
      + `проаналізовано ${String(sum(r.llm, "done"))}`
      + (r.sttStoppedBy ? ` · розпізнавання: ${r.sttStoppedBy}` : "")
      + (r.llmStoppedBy ? ` · аналіз: ${r.llmStoppedBy}` : ""));
    return r;
  });
}
