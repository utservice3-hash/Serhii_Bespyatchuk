import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { fetchLeadsOnStage, kommoGet } from "../kommo/client.js";
import { kommoLeadUrl } from "../core/kommoLinks.js";
import { leadsBotConfigured, leadsBotEdit, leadsBotSend } from "../bot/leadsBot.js";
import { closeModeOf } from "../core/carrierClose.js";
import { clientOwnersFor } from "../core/clientOwner.js";
import { kyivMonth } from "../core/finance.js";
import { LINKEDIN_STAGE, runLinkedinQueueTick, type QueueReport } from "../core/linkedinQueue.js";
import { sweepLinkedinStageHistory } from "./linkedinStageJob.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * ⛔ НЕ ЗАПУСКАЄТЬСЯ з задачі 10743 (бот черги вимкнено, TOP Weekly 19.11.2026): у `index.ts` її немає, етап «LinkedIn»
 * пише `linkedinStageJob`. Файл лишено, щоб бота можна було повернути одним revert. Повертати — лише рішенням.
 *
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
      // Бойовий режим — лише з токеном бота; без нього «live» поводиться як пробний (лише журнал).
      live: leadsBotConfigured() ? {
        send: (chat, html, buttons) => leadsBotSend(chat, html, buttons),
        edit: (chat, msgId, html) => leadsBotEdit(chat, msgId, html),
        leadUrl: (id) => kommoLeadUrl(id),
        leadCard: async (id) => {
          const lead = await kommoGet<{ _embedded?: { contacts?: { id: number; is_main?: boolean }[] } }>(`/api/v4/leads/${String(id)}?with=contacts`);
          const cs = lead._embedded?.contacts ?? [];
          const cid = (cs.find((c) => c.is_main) ?? cs[0])?.id;
          if (!cid) return { contact: null, phone: null };
          const c = await kommoGet<{ name?: string; custom_fields_values?: { field_code?: string; values?: { value?: string }[] }[] | null }>(`/api/v4/contacts/${String(cid)}`);
          const phone = c.custom_fields_values?.find((f) => f.field_code === "PHONE")?.values?.[0]?.value ?? null;
          return { contact: c.name ?? null, phone };
        },
      } : undefined,
      now: () => new Date(),
      stageLeads: async () => (await fetchLeadsOnStage(LINKEDIN_STAGE.pipelineId, LINKEDIN_STAGE.statusId))
        .map((l) => ({ id: l.id, name: l.name, createdAt: l.created_at * 1000, responsibleUserId: l.responsible_user_id ?? null })),
      ownerOf: async (key) => {
        const o = (await clientOwnersFor([key], kyivMonth())).get(key);
        return o?.managerId != null ? { managerId: o.managerId, managerName: o.managerName } : null;
      },
    });
    // 📅 Раз на добу — угоди, що з етапу вже пішли (для «створено з початку етапу»). Збій тут черги не зупиняє.
    if (r.mode !== "off") await sweepLinkedinStageHistory().catch((e: unknown) => { console.error("linkedinQueueJob: історія етапу —", e); });
    if (r.mode !== "off" && (r.seen || r.offered || r.ignored || r.dispatcher || r.gone)) {
      console.log(`linkedinQueueJob (${r.mode}): на етапі ${String(r.onStage)}, нових ${String(r.seen)}, запропоновано ${String(r.offered)}, `
        + `не взяли ${String(r.ignored)}, відповідальній ${String(r.dispatcher)}, пішли ${String(r.gone)}, чекають синку ${String(r.waitingSync)}`);
    }
    return r;
  });
}
