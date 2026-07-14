import { pool } from "../db/pool.js";
import { forEachStatusChangeEventPage, type KommoStatusEvent } from "../kommo/client.js";

/** (pipeline_id:status_id) -> funnel_stage, so events are tagged at insert time. */
async function loadStageMap(): Promise<Map<string, string>> {
  const r = await pool.query<{ pipeline_id: string; status_id: string; funnel_stage: string }>(
    `SELECT pipeline_id, status_id, funnel_stage FROM pipeline_stage_map`
  );
  const m = new Map<string, string>();
  for (const row of r.rows) m.set(`${row.pipeline_id}:${row.status_id}`, row.funnel_stage);
  return m;
}

async function insertEvents(events: KommoStatusEvent[], stageMap: Map<string, string>): Promise<void> {
  if (events.length === 0) return;
  const values: unknown[] = [];
  const tuples = events
    .map((e, j) => {
      const b = j * 5;
      values.push(
        e.entityId,
        e.statusId,
        e.pipelineId,
        stageMap.get(`${e.pipelineId}:${e.statusId}`) ?? null,
        new Date(e.changedAt * 1000)
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
    })
    .join(",");
  await pool.query(
    `INSERT INTO deal_stage_events (kommo_id, status_id, pipeline_id, funnel_stage, changed_at)
     VALUES ${tuples}
     ON CONFLICT (kommo_id, status_id, changed_at) DO NOTHING`,
    values
  );
}

let eventsRunning = false;

// Максимальне вікно на ОДНУ під-порцію. Раніше вотермарк рухався ЛИШЕ після повного
// проходу всього вікна («все або нічого»): один збій за 51 сторінку (5 днів × newest-
// first) втрачав увесь прогрес, вікно росло щодня → само-підсилювана стагнація (вотермарк
// застряг на 09.07, гроші поточного місяця тихо недораховувались). Тепер обробляємо
// порціями ≤24 год і рухаємо вотермарк ПІСЛЯ КОЖНОЇ завершеної порції → збій втрачає
// лише порцію, а не весь прохід; велика діра затягується за кілька порцій.
const CHUNK_SECONDS = 24 * 60 * 60;

/** Пройти [sinceUnix, untilUnix] під-порціями ≤24 год. Вотермарк рухається на кінець
 *  КОЖНОЇ завершеної порції лише коли advanceWatermark=true (інкрементний шлях; бекфіл —
 *  ні). Повертає скільки подій оброблено. Порція, що кинула, лишає вотермарк на попередній
 *  (наступний прохід її повторить — ON CONFLICT ідемпотентний). */
async function processWindow(
  sinceUnix: number,
  untilUnix: number,
  stageMap: Map<string, string>,
  advanceWatermark: boolean
): Promise<number> {
  let cursor = sinceUnix;
  let total = 0;
  while (cursor < untilUnix) {
    const chunkUntil = Math.min(cursor + CHUNK_SECONDS, untilUnix);
    total += await forEachStatusChangeEventPage(cursor, chunkUntil, (events) =>
      insertEvents(events, stageMap)
    );
    if (advanceWatermark) {
      await pool.query(`UPDATE sync_state SET last_event_at = $1 WHERE id = 1`, [
        new Date(chunkUntil * 1000),
      ]);
    }
    cursor = chunkUntil;
  }
  return total;
}

/**
 * Pulls Kommo lead_status_changed events into deal_stage_events.
 * @param opts.sinceUnix  Start of the window. Omit for an incremental run from
 *   the stored watermark (with a small overlap). Pass an explicit value for a
 *   historical backfill — that path does NOT advance the watermark.
 */
export async function syncStageEvents(opts: { sinceUnix?: number; untilUnix?: number } = {}): Promise<void> {
  if (eventsRunning) {
    console.warn("syncStageEvents: previous run still in progress — skipping this tick.");
    return;
  }
  eventsRunning = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const isBackfill = opts.sinceUnix != null;
    let sinceUnix = opts.sinceUnix;
    if (sinceUnix == null) {
      const r = await pool.query<{ last_event_at: Date | null }>(
        `SELECT last_event_at FROM sync_state WHERE id = 1`
      );
      const last = r.rows[0]?.last_event_at;
      // Re-pull a 5-min overlap so an event landing mid-run is never skipped;
      // ON CONFLICT keeps it idempotent. First run looks back 30 min.
      sinceUnix = last ? Math.floor(last.getTime() / 1000) - 300 : now - 1800;
    }
    const untilUnix = opts.untilUnix ?? now;

    const stageMap = await loadStageMap();
    // Інкрементний шлях рухає вотермарк по порціях; бекфіл (--months / точковий) — ні.
    const total = await processWindow(sinceUnix, untilUnix, stageMap, !isBackfill);

    console.log(`Stage events synced: ${total} events (${sinceUnix}..${untilUnix}).`);
  } finally {
    eventsRunning = false;
  }
}

/**
 * Retention: drop stage events older than `retentionMonths` so the table can't
 * grow unbounded (~20k rows/month). Recent history is all the period metrics
 * ever need; old rows are only weight.
 */
export async function cleanupOldStageEvents(retentionMonths = 24): Promise<void> {
  const r = await pool.query(
    `DELETE FROM deal_stage_events WHERE changed_at < now() - make_interval(months => $1)`,
    [retentionMonths]
  );
  console.log(`Stage events cleanup: removed ${r.rowCount ?? 0} rows older than ${retentionMonths} months.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI: `node dist/jobs/syncStageEvents.js --months=6` backfills N months.
  const monthsArg = process.argv.find((a) => a.startsWith("--months="));
  const months = monthsArg ? Number(monthsArg.split("=")[1]) : null;
  const opts = months
    ? { sinceUnix: Math.floor(Date.now() / 1000) - months * 30 * 24 * 60 * 60 }
    : {};
  syncStageEvents(opts)
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
