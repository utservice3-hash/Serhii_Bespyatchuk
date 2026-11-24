import { pool } from "../db/pool.js";
import { fetchLeadsByIdsLean, fetchLeadsOnStage, kommoGet } from "../kommo/client.js";
import { LINKEDIN_STAGE } from "../core/linkedinQueue.js";
import { recordStageDeals, sweepStageHistory } from "../core/linkedinStageDeals.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * 📅 ЕТАП «LINKEDIN» БЕЗ БОТА — джоба раз на 30 хв (задача 10743, рішення Романа 23.11.2026: плитку «Нових на етапі
 * LinkedIn» лишити, рахувати без бота). Бот черги «UTS Заявки» вимкнено (TOP Weekly 19.11.2026); раніше ці угоди
 * дописував його тік кожні 2 хв (`linkedinQueueJob`), тепер — лише це: хто ЗАРАЗ на етапі → `linkedin_stage_deals`,
 * і раз на добу — ті, хто з етапу вже пішов (події Kommo). Жодних пропозицій, журналу черги й Telegram.
 *
 * Kommo — лише читання: один запит (угоди на етапі) кожні 30 хв і раз на добу події етапу. Хвилини :11/:41 не
 * збігаються з :00/:30 `syncKommo` і :15/:45 `syncStageEvents`. Під наглядом (`monitoredJobs.ts`), everyMin == крону.
 */
const guard = createRunGuard("linkedinStageJob");

const toStageLead = (l: { id: number; name: string; created_at: number; responsible_user_id?: number | null }) =>
  ({ id: l.id, name: l.name, createdAt: l.created_at * 1000, responsibleUserId: l.responsible_user_id ?? null });

export interface StageReport { onStage: number; added: number; swept: { left: number; movedIn: number } | null }

export async function linkedinStageJob(): Promise<StageReport | GuardSkip> {
  return guard(async () => {
    const now = new Date();
    const leads = (await fetchLeadsOnStage(LINKEDIN_STAGE.pipelineId, LINKEDIN_STAGE.statusId)).map(toStageLead);
    const added = await recordStageDeals(pool, leads, now);
    const swept = await sweepLinkedinStageHistory(now);
    if (added || swept) console.log(`linkedinStageJob: на етапі ${String(leads.length)}, дописано ${String(added)}`
      + (swept ? `, добір історії: пішли ${String(swept.left)}, перенесені ${String(swept.movedIn)}` : ""));
    return { onStage: leads.length, added, swept };
  });
}

/** Події Kommo по етапу «LinkedIn» (усі сторінки) → id угод. `side` — статус «до» (пішли з етапу) чи «після» (прийшли). */
async function stageEventIds(side: "value_before" | "value_after"): Promise<number[]> {
  const { pipelineId, statusId } = LINKEDIN_STAGE;
  const ids: number[] = [];
  for (let page = 1; page <= 50; page++) {
    const j = await kommoGet<{ _embedded?: { events?: { entity_id: number }[] } }>(`/api/v4/events?limit=100&page=${String(page)}`
      + `&filter[type]=lead_status_changed&filter[${side}][leads_statuses][0][pipeline_id]=${String(pipelineId)}`
      + `&filter[${side}][leads_statuses][0][status_id]=${String(statusId)}`);
    const ev = j._embedded?.events ?? [];
    ids.push(...ev.map((e) => e.entity_id));
    if (ev.length < 100) break;
  }
  return ids;
}

/** Раз на добу (`history_swept_at`): угоди, що з етапу вже пішли, і перенесені з інших етапів. `null` — ще рано. */
export async function sweepLinkedinStageHistory(now = new Date()) {
  return sweepStageHistory(pool, {
    leftIds: () => stageEventIds("value_before"),
    movedInIds: () => stageEventIds("value_after"),
    leads: async (ids) => (await fetchLeadsByIdsLean(ids)).map(toStageLead),
  }, now);
}
