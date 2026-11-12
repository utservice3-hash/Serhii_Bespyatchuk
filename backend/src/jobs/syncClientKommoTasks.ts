import { pool } from "../db/pool.js";
import { fetchLeadsByIds, kommoGet, kommoWrite } from "../kommo/client.js";
import { isKommoPaused } from "../kommo/pause.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";
import { jobSkip, type JobSkip } from "./jobRuns.js";
import { syncClientTasks, pushStep, type KommoTaskDeps, type KommoTasksReport, type PushResult } from "../core/clientKommoTask.js";

/**
 * 📌 ЗАДАЧІ КЛІЄНТАМ ↔ KOMMO (задача 8345). Кожні 10 хв за Києвом; нову задачу роут штовхає одразу, джоба — страховка
 * й повтор. Вимикач без викату: `CLIENT_KOMMO_TASKS=off` у `.env` + рестарт — задачі лишаються в дашборді й чекають.
 *
 * Лог — обсяг: скільки перенесено, скільки угод створено, скільки чекає і скільки не вдалося.
 */
const guard = createRunGuard("syncClientKommoTasks");
export const clientKommoTasksOn = (): boolean => (process.env.CLIENT_KOMMO_TASKS ?? "on").trim().toLowerCase() !== "off";

type Created<K extends string> = { _embedded?: Partial<Record<K, { id: number }[]>> };
const firstId = <K extends string>(r: Created<K>, key: K): number => {
  const id = r._embedded?.[key]?.[0]?.id;
  if (id == null) throw new Error(`Kommo не повернула id (${key})`);
  return id;
};

export const kommoTaskDeps: KommoTaskDeps = {
  fetchLeads: async (ids) => (await fetchLeadsByIds(ids)).map((l) => ({ id: l.id, status_id: l.status_id, created_at: l.created_at, _embedded: l._embedded })),
  createLead: async (body) => firstId(await kommoWrite<Created<"leads">>("/api/v4/leads", body), "leads"),
  createTask: async (body) => firstId(await kommoWrite<Created<"tasks">>("/api/v4/tasks", body), "tasks"),
  closeTasks: async (body) => { await kommoWrite("/api/v4/tasks", body, "PATCH"); },
  fetchTasks: async (ids) => {
    if (!ids.length) return [];
    const r = await kommoGet<{ _embedded?: { tasks?: { id: number; is_completed: boolean }[] } } | null>(
      `/api/v4/tasks?limit=250&${ids.map((id) => `filter[id][]=${String(id)}`).join("&")}`);
    return r?._embedded?.tasks ?? [];
  },
};

/** Нову задачу — одразу, не чекаючи джоби. Помилка тут не валить відповідь роута: рядок лишається в черзі з причиною. */
export async function pushStepNow(stepId: number): Promise<PushResult | null> {
  if (!clientKommoTasksOn() || isKommoPaused()) return null;
  return pushStep(pool, kommoTaskDeps, stepId, new Date());
}

export async function syncClientKommoTasks(): Promise<KommoTasksReport | GuardSkip | JobSkip> {
  if (!clientKommoTasksOn()) return jobSkip("вимкнено (CLIENT_KOMMO_TASKS=off)");
  if (isKommoPaused()) return jobSkip("Kommo на паузі (KOMMO_PAUSED)");
  return guard(async () => {
    const r = await syncClientTasks(pool, kommoTaskDeps, new Date());
    console.log(`syncClientKommoTasks: у Kommo ${String(r.pushed)} (нових угод ${String(r.createdLeads)}), не вдалося ${String(r.failed)}, `
      + `закрито в Kommo ${String(r.closedInKommo)}, виконано з Kommo ${String(r.doneFromKommo)}, чекає ${String(r.waiting)}`);
    return r;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncClientKommoTasks()
    .then((r) => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}
