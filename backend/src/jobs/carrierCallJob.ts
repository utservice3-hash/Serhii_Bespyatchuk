import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { fetchLeadsOnStage } from "../kommo/client.js";
import { sendAdminAlert } from "../bot/notify.js";
import { runCarrierTick, type CarrierTickReport } from "../core/carrierCalls.js";
import { CARRIER_STAGE } from "../core/carrierCallRules.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * 🚚 ПЕРЕВІЗНИКИ ЗА РОЗМОВОЮ — джоба раз на 5 хв (рішення Романа 29.09.2026: «зразу після фільтра»).
 *
 * Уся логіка — у `core/carrierCalls.ts` (без пулу; гейти ганяють її на scratch-базі). Тут лише пул, Kommo,
 * ключі, ціни й охоронець від накладання. Kommo — ОДИН запит лише на читання (угоди на етапі), через
 * спільний тротл і запобіжник від бана. Без ключів AI — «не ввімкнено», джоба зелена.
 */
const guard = createRunGuard("carrierCallJob");

export async function carrierCallJob(): Promise<CarrierTickReport | GuardSkip> {
  return guard(async () => {
    const r = await runCarrierTick({
      db: pool,
      http: { fetch, sleep: (ms) => new Promise((res) => setTimeout(res, ms)), nowMs: () => Date.now() },
      keys: { elevenlabs: config.callAi.elevenlabsApiKey, gemini: config.callAi.geminiApiKey },
      prices: config.callAi.prices,
      now: () => new Date(),
      stageLeads: async () => (await fetchLeadsOnStage(CARRIER_STAGE.pipelineId, CARRIER_STAGE.statusId))
        .map((l) => ({ id: l.id, name: l.name, created_at: l.created_at, responsible_user_id: l.responsible_user_id ?? null })),
      alert: sendAdminAlert,
    });
    const d = r.recorded, v = r.resolved;
    const sum = (xs: CarrierTickReport["stt"], k: "done" | "failed" | "unavailable") => xs.reduce((s, x) => s + x[k], 0);
    console.log(`carrierCallJob: на етапі ${String(d.onStage)} (молодші за поріг ${String(d.tooYoung)}, без номера ${String(d.noPhone)}), нових ${String(d.inserted)} · `
      + `своя розмова ${String(v.own)}, повтор номера ${String(v.reused)}, без розмови ${String(v.noTalk)}, друга спроба ${String(v.secondTalk)} · `
      + `розпізнано ${String(sum(r.stt, "done"))}, проаналізовано ${String(sum(r.llm, "done"))}`
      + (r.purged ? ` · текст видалено за строком ${String(r.purged)}` : "")
      + (r.sttStoppedBy ? ` · розпізнавання: ${r.sttStoppedBy}` : "")
      + (r.llmStoppedBy ? ` · аналіз: ${r.llmStoppedBy}` : ""));
    return r;
  });
}
