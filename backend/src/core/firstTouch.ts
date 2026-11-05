import { pool } from "../db/pool.js";
import { aiCallsList } from "./callAiScreen.js";
import type { AdPredicate } from "./callAiPilot.js";
import { FIRST_TOUCH_RULE } from "./callAiTick.js";
import { FIRST_TOUCH_SHOWN_RUBRICS } from "./callAiProviders.js";
import { adDealSql, REJECT_NONTARGET } from "./metrics.js";
import { firstTouchCountsFromCalls, type FirstTouchCounts } from "./firstTouchRules.js";

/**
 * 🎯 «ЦІНУ НАЗВАНО (1-Й ДОТИК)» У ЗВІТІ — ТІ САМІ РОЗМОВИ Й ТЕ САМЕ ПРАВИЛО, ЩО ПЛИТКА «ЦІНА ОЗВУЧЕНА»
 * НА ЕКРАНІ «ПЕРШИЙ ДОТИК · AI» (задача 7237, Роман 02.11.2026).
 *
 * До того Звіт читав лист зовнішнього uts-bot (`first_touch_analysis`), а бот замовк: остання оцінка
 * 25.09.2026, а з 24.08 — лише «немає запису». Заміряно 02.11: жовтень у Звіті 0 оцінок, на екрані AI
 * 294 з 579 (51 %). Синк листа живий — порожнє саме джерело, тож «полагодити передачу» не було чого.
 *
 * Розмови — `aiCallsList` (той самий виклик, що `/ai-calls`); відбір і ціна — `firstTouchCountsFromCalls`
 * (`firstTouchRules.ts`): вкладка «Звіт» без нецільових, ціна за `checklist().price`. Що ці числа == плитці, тримає `#3341` на фікстурі й `#3342` на живих даних.
 *
 * `noRecord` — розмови Звіту, яких AI ще не розібрав (черга, немає запису): поза відсотком, як було
 * «немає запису» в бота. До `FIRST_TOUCH_RULE.startDate` розбору не існувало — період, що закінчився
 * раніше, «не вимірювався», а не «0 з 0» (рішення Романа 02.11.2026: бота під тим самим підписом не
 * домішуємо).
 */
export interface FirstTouchReport {
  byManager: Map<number, FirstTouchCounts>;
  /** Ті самі лічильники з ПОТОЧНОЮ командою людини — для «поза ростером». */
  rows: { managerId: number; teamId: number | null; counts: FirstTouchCounts }[];
  /** Розмови без відомого менеджера. */
  unmapped: FirstTouchCounts;
  /** Чи розбирав AI хоч щось у цьому періоді за правилом (період не закінчився до старту розбору). */
  covered: boolean;
  lastAnalyzedAt: string | null;
}

/** Оцінки «перший дотик» за період для Звіту. Правила станів — `firstTouchRules.ts`. */
export async function firstTouchReport(from: string, to: string, adSources: AdPredicate["adSources"]): Promise<FirstTouchReport> {
  const last = pool.query<{ d: string | null }>(
    `SELECT to_char(MAX(updated_at AT TIME ZONE 'Europe/Kyiv'), 'YYYY-MM-DD') AS d
       FROM call_analyses WHERE status = 'done' AND rubric_version = ANY($1::text[])`, [[...FIRST_TOUCH_SHOWN_RUBRICS]]);
  const covered = to >= FIRST_TOUCH_RULE.startDate;
  if (!covered) {
    return { byManager: new Map(), rows: [], unmapped: { analyzed: 0, voiced: 0, noRecord: 0 }, covered, lastAnalyzedAt: (await last).rows[0]?.d ?? null };
  }
  // Розмови до старту розбору за правилом не розбираються, тож «не розібраними» не є — і лише сповільнюють
  // Звіт (заміряно 02.11.2026: серпень–жовтень 20,2 с при таймауті 20 с; із цією межею — частка того).
  const since = from > FIRST_TOUCH_RULE.startDate ? from : FIRST_TOUCH_RULE.startDate;
  const [list, lastRes] = await Promise.all([aiCallsList(pool, { predicate: adDealSql, adSources }, since, to, new Date(), {}), last]);
  // `nonTarget` — тим самим виразом, що рядок `/ai-calls` (`#3343` звіряє обидва місця).
  const calls = list.rows.map((r) => ({ ...r, nonTarget: r.rejectReason != null && REJECT_NONTARGET.includes(r.rejectReason) }));
  return { ...firstTouchCountsFromCalls(calls), covered, lastAnalyzedAt: lastRes.rows[0]?.d ?? null };
}
