import { pool } from "../db/pool.js";
import { syncStageEvents } from "./syncStageEvents.js";

/**
 * Помісячний бекфіл deal_stage_events (MASTER_PLAN КРОК 1.1).
 *
 * Kommo events API капить пагінацію ~20 тис подій ЗА ОДИН прохід — це ліміт
 * проходу, не глибини історії. Тому ганяємо ПОМІСЯЧНО (один місяць ≈ 20 тис
 * подій = вміщується), послідовно, з перекриттям ±6 год на межах місяців;
 * ON CONFLICT у deal_stage_events робить повторні прогони ідемпотентними.
 * Watermark інкрементального синку НЕ рухається (syncStageEvents:isBackfill).
 *
 *   node dist/jobs/backfillStageEvents.js --from=2025-06 --to=2026-05
 *
 * ⚠️ НЕ запускати паралельно з прод-синком: `touch KOMMO_PAUSED` перед стартом.
 */
function monthStartUnix(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Bad month: ${ym} (want YYYY-MM)`);
  return Math.floor(Date.UTC(y, m - 1, 1) / 1000);
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 1-based → this IS next month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function backfillStageEvents(fromYm: string, toYm: string): Promise<void> {
  const OVERLAP_SEC = 6 * 3600; // Kyiv = UTC+2/+3; ±6 год покриває межі місяця з запасом
  let ym = fromYm;
  for (;;) {
    const since = monthStartUnix(ym) - OVERLAP_SEC;
    const until = monthStartUnix(nextMonth(ym)) + OVERLAP_SEC;
    const t0 = Date.now();
    console.log(`=== ${ym}: window ${since}..${until} ===`);
    await syncStageEvents({ sinceUnix: since, untilUnix: until });
    const r = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM deal_stage_events
        WHERE (changed_at AT TIME ZONE 'Europe/Kyiv')::date >= ($1 || '-01')::date
          AND (changed_at AT TIME ZONE 'Europe/Kyiv')::date < (($1 || '-01')::date + interval '1 month')`,
      [ym]
    );
    console.log(`=== ${ym} done in ${Math.round((Date.now() - t0) / 1000)}s; events in month now: ${r.rows[0].n} ===`);
    if (ym === toYm) break;
    ym = nextMonth(ym);
  }
  console.log(`backfillStageEvents complete: ${fromYm}..${toYm}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const from = arg("from");
  const to = arg("to");
  if (!from || !to) {
    console.error("Usage: node dist/jobs/backfillStageEvents.js --from=2025-06 --to=2026-05");
    process.exit(1);
  }
  backfillStageEvents(from, to)
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
