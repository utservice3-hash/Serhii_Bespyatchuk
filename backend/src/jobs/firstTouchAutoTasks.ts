import { pool } from "../db/pool.js";
import { adDealSql } from "../core/metrics.js";
import { getSettings } from "../routes/settings.js";
import { aiCallsList } from "../core/callAiScreen.js";
import { clientDecision } from "../core/firstTouchTeamReport.js";
import { kommoLeadUrl } from "../core/kommoLinks.js";
import { AUTO_TASKS_FROM, planAutoTasks, syncFirstTouchAutoTasks, teamLeadUsers, type AutoTaskStats } from "../core/firstTouchAutoTasks.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";

/**
 * 📋 АВТОЗАДАЧІ «ПЕРШОГО ДОТИКУ» (задача 7238) — раз на 30 хв. Логіка — `core/firstTouchAutoTasks.ts`; тут лише рядки екрана
 * «Перший дотик · AI» (той самий `aiCallsList`, що й фільтр «Погодився, а в Kommo втрачено», без скоупу ролі) за вікно
 * `AUTO_TASKS_FROM` … сьогодні, не довше за `WINDOW_DAYS` (заміряно 04.11: 2 міс. — 2024 розмови, 6,9 с).
 */
export const WINDOW_DAYS = 120;
const guard = createRunGuard("firstTouchAutoTasks");
const kyivDate = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });

export async function firstTouchAutoTasks(): Promise<(AutoTaskStats & { rows: number; truncated: boolean }) | GuardSkip> {
  return guard(async () => {
    const now = new Date();
    const today = kyivDate(now);
    const back = kyivDate(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
    const from = back > AUTO_TASKS_FROM ? back : AUTO_TASKS_FROM;
    const { adSources } = await getSettings();
    const { rows, truncated } = await aiCallsList(pool, { predicate: adDealSql, adSources }, from, today, now, {});
    const src = rows.map((r) => ({
      uniqueid: r.uniqueid, calledAt: r.calledAt, kommoIds: r.kommoIds, managerName: r.managerName, teamId: r.teamId, teamName: r.teamName,
      state: r.state, failure: r.failure, inReport: r.inReport, typeOverride: r.typeOverride, decision: clientDecision(r), dealOutcome: r.dealOutcome,
    }));
    const plan = planAutoTasks(src, await teamLeadUsers(pool), now, kommoLeadUrl);
    const s = await syncFirstTouchAutoTasks(pool, plan, now);
    console.log(`firstTouchAutoTasks: розмов ${String(rows.length)}${truncated ? " (обрізано!)" : ""} · поставлено ${String(s.created)} · `
      + `уже були ${String(s.known)} · закрито ${String(s.closed)}${s.noLead ? ` · без тімліда ${String(s.noLead)}: ${plan.noLead.join(", ")}` : ""}`);
    return { ...s, rows: rows.length, truncated };
  });
}
