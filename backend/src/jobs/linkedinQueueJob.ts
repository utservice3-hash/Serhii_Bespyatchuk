import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { fetchLeadsOnStage } from "../kommo/client.js";
import { closeModeOf } from "../core/carrierClose.js";
import { clientOwnersFor } from "../core/clientOwner.js";
import { kyivMonth } from "../core/finance.js";
import { LINKEDIN_STAGE, runLinkedinQueueTick, type QueueReport } from "../core/linkedinQueue.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * 🔗 ЧЕРГА LINKEDIN — джоба раз на 2 хв (задача 7361). Логіка — у `core/linkedinQueue.ts` (без пулу, гейти ганяють
 * її на scratch-базі). Тут лише пул, Kommo (ОДИН запит на читання — угоди на етапі) і режим. Синк угод іде раз на
 * 30 хв, а вікно на «Взяти» — 15 хв, тому черга дивиться на етап сама, а не чекає синку.
 */
const guard = createRunGuard("linkedinQueueJob");

export async function linkedinQueueJob(): Promise<QueueReport | GuardSkip> {
  return guard(async () => {
    const r = await runLinkedinQueueTick({
      db: pool,
      mode: closeModeOf(config.linkedinQueue.mode),
      now: () => new Date(),
      stageLeads: async () => (await fetchLeadsOnStage(LINKEDIN_STAGE.pipelineId, LINKEDIN_STAGE.statusId))
        .map((l) => ({ id: l.id, name: l.name, createdAt: l.created_at * 1000, responsibleUserId: l.responsible_user_id ?? null })),
      ownerOf: async (key) => {
        const o = (await clientOwnersFor([key], kyivMonth())).get(key);
        return o?.managerId != null ? { managerId: o.managerId, managerName: o.managerName } : null;
      },
    });
    if (r.mode !== "off" && (r.seen || r.offered || r.ignored || r.dispatcher || r.gone)) {
      console.log(`linkedinQueueJob (${r.mode}): на етапі ${String(r.onStage)}, нових ${String(r.seen)}, запропоновано ${String(r.offered)}, `
        + `не взяли ${String(r.ignored)}, відповідальній ${String(r.dispatcher)}, пішли ${String(r.gone)}, чекають синку ${String(r.waitingSync)}`);
    }
    return r;
  });
}
