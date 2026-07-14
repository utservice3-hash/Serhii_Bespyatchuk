import { pool } from "../db/pool.js";
import { forEachStatusChangeEventPage, type KommoStatusEvent } from "../kommo/client.js";
import { processInChunks } from "./chunkWindow.js";

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
    // Порції ≤24 год; вотермарк рухається ПІСЛЯ КОЖНОЇ (інкремент), бекфіл — ні (null).
    const total = await processInChunks(
      sinceUnix,
      untilUnix,
      (from, to) => forEachStatusChangeEventPage(from, to, (events) => insertEvents(events, stageMap)),
      isBackfill
        ? null
        : (chunkUntil) =>
            pool.query(`UPDATE sync_state SET last_event_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {})
    );

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
