import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { fetchLeadsOnStage, kommoGet, kommoWrite } from "../kommo/client.js";
import { closeTasksBody, HISTORY_GUARD, openTasksPath } from "../core/carrierHistory.js";
import { closeModeOf } from "../core/carrierClose.js";
import { sendAdminAlert } from "../bot/notify.js";
import { runCarrierTick, type CarrierTickReport } from "../core/carrierCalls.js";
import { CARRIER_STAGE } from "../core/carrierCallRules.js";
import { minutesSetting, NO_TALK_GUARD } from "../core/carrierNoTalkGuard.js";
import { TASK_SWEEP } from "../core/carrierTaskSweep.js";
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
      launchAt: new Date(config.callAi.carrierLaunchAt),
      reviewTasks: true,
      noTalkAfterMin: config.callAi.carrierNoTalkCloseMin,
      noTalkSyncMaxMin: minutesSetting(config.callAi.carrierNoTalkSyncMaxMin, NO_TALK_GUARD.defaultMaxAgeMin),
      historySyncMaxMin: minutesSetting(config.callAi.carrierHistorySyncMaxMin, HISTORY_GUARD.defaultMaxAgeMin),
      close: {
        mode: closeModeOf(config.callAi.carrierAutoClose),
        otherMode: closeModeOf(config.callAi.carrierAutoCloseOther),
        historyMode: closeModeOf(config.callAi.carrierHistoryClose),
        kommo: {
          patchLeads: (body) => kommoWrite("/api/v4/leads", body, "PATCH"),
          addNotes: (body) => kommoWrite("/api/v4/leads/notes", body, "POST"),
          openTaskIds: async (leadIds) => {
            const r = await kommoGet<{ _embedded?: { tasks?: { id: number; is_completed: boolean }[] } }>(openTasksPath(leadIds));
            return (r._embedded?.tasks ?? []).filter((t) => !t.is_completed).map((t) => t.id);
          },
          closeTasks: (taskIds, text) => kommoWrite("/api/v4/tasks", closeTasksBody(taskIds, text), "PATCH"),
        },
      },
      // 🧽 Задачі робота на закритих угодах етапу (Роман 05.10.2026) — хто б угоду не закрив: фільтр CRM, дашборд, людина.
      taskSweep: {
        mode: closeModeOf(config.callAi.carrierTaskSweep),
        kommo: {
          leadStatuses: async (ids) => {
            const q = ids.map((id) => `filter[id][]=${String(id)}`).join("&");
            const r = await kommoGet<{ _embedded?: { leads?: { id: number; status_id: number }[] } }>(`/api/v4/leads?${q}&limit=${String(TASK_SWEEP.batch)}`);
            return (r._embedded?.leads ?? []).map((l) => ({ id: l.id, statusId: l.status_id }));
          },
          openTasks: async (leadIds) => {
            const r = await kommoGet<{ _embedded?: { tasks?: { id: number; entity_id: number; created_by: number; is_completed: boolean }[] } }>(openTasksPath(leadIds));
            return (r._embedded?.tasks ?? []).map((t) => ({ id: t.id, leadId: t.entity_id, createdBy: t.created_by, completed: t.is_completed }));
          },
          closeTasks: (taskIds, text) => kommoWrite("/api/v4/tasks", closeTasksBody(taskIds, text), "PATCH"),
        },
      },
    });
    const d = r.recorded, v = r.resolved;
    const sum = (xs: CarrierTickReport["stt"], k: "done" | "failed" | "unavailable") => xs.reduce((s, x) => s + x[k], 0);
    console.log(`carrierCallJob: на етапі ${String(d.onStage)} (молодші за поріг ${String(d.tooYoung)}, без номера ${String(d.noPhone)}), нових ${String(d.inserted)} · `
      + `своя розмова ${String(v.own)}, повтор номера ${String(v.reused)}, без розмови ${String(v.noTalk)}, друга спроба ${String(v.secondTalk)} · `
      + (v.noTalkGate.open ? "" : `«без розмови» НА ПАУЗІ: синк дзвінків ${v.noTalkGate.syncAgeMin == null ? "невідомо коли" : `${String(v.noTalkGate.syncAgeMin)} хв тому`} (поріг ${String(v.noTalkGate.maxAgeMin)} хв) · `)
      + (v.noTalkNoCreatingCall ? `без дзвінка-творця в базі (не закриваємо) ${String(v.noTalkNoCreatingCall)} · ` : "")
      + (d.beforeLaunch ? `, до старту ${String(d.beforeLaunch)}` : "") + ` · розпізнано ${String(sum(r.stt, "done"))}, проаналізовано ${String(sum(r.llm, "done"))}`
      + (r.purged ? ` · текст видалено за строком ${String(r.purged)}` : "")
      + (v.history ? ` · історія CRM ${String(v.history)}` : "")
      + (v.historyGate.open ? "" : ` · «історія CRM» НА ПАУЗІ: синк угод ${v.historyGate.syncAgeMin == null ? "невідомо коли" : `${String(v.historyGate.syncAgeMin)} хв тому`} (поріг ${String(v.historyGate.maxAgeMin)} хв)`)
      + (r.closed ? ` · закриття (${r.closed.mode}, «інше» ${r.closed.otherMode}, історія ${r.closed.historyMode}): кандидатів ${String(r.closed.candidates)}, у журнал ${String(r.closed.logged)}, закрито ${String(r.closed.closed)}, задач Kommo ${String(r.closed.tasksClosed)}${r.closed.historyPaused ? `, історія чекає синку ${String(r.closed.historyPaused)}` : ""}${r.closed.historyRevoked ? `, історію знято (зʼявився клієнт) ${String(r.closed.historyRevoked)}` : ""}${r.closed.failed ? `, помилок ${String(r.closed.failed)}` : ""}` : "")
      + (r.reviewTasks && (r.reviewTasks.created || r.reviewTasks.closed) ? ` · задачі: нових ${String(r.reviewTasks.created)}, закрито ${String(r.reviewTasks.closed)}` : "")
      + (r.taskSweep && r.taskSweep.candidates ? ` · задачі на закритих угодах (${r.taskSweep.mode}): угод ${String(r.taskSweep.candidates)}, досі закриті ${String(r.taskSweep.stillClosed)}, задач робота ${String(r.taskSweep.robotTasks)}, закрито ${String(r.taskSweep.closedTasks)}${r.taskSweep.peopleTasks ? `, задач людей лишили ${String(r.taskSweep.peopleTasks)}` : ""}` : "")
      + (r.sttStoppedBy ? ` · розпізнавання: ${r.sttStoppedBy}` : "")
      + (r.llmStoppedBy ? ` · аналіз: ${r.llmStoppedBy}` : ""));
    return r;
  });
}
