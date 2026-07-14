import { pool } from "../db/pool.js";
import { forEachResponsibleChangeEventPage, type KommoResponsibleEvent } from "../kommo/client.js";
import { processInChunks } from "./chunkWindow.js";

// Кваліфікація pipelines — the "нова заявка від лідогенератора" duplicates live
// here; a responsible change on one of these = a lead-gen lead handed to sales.
const QUALIFICATION_PIPELINES = [8921928, 7336928];

async function insertTransfers(events: KommoResponsibleEvent[]): Promise<void> {
  if (events.length === 0) return;
  // Keep only events whose lead is in a Кваліфікація pipeline.
  const ids = [...new Set(events.map((e) => e.entityId))];
  const rows = await pool.query<{ kommo_id: string }>(
    `SELECT kommo_id FROM deals WHERE kommo_id = ANY($1) AND pipeline_id = ANY($2)`,
    [ids, QUALIFICATION_PIPELINES]
  );
  const kept = new Set(rows.rows.map((r) => Number(r.kommo_id)));
  const relevant = events.filter((e) => kept.has(e.entityId));
  if (relevant.length === 0) return;

  const values: unknown[] = [];
  const tuples = relevant
    .map((e, j) => {
      const b = j * 3;
      values.push(e.entityId, new Date(e.changedAt * 1000), e.toUserId);
      return `($${b + 1},$${b + 2},$${b + 3})`;
    })
    .join(",");
  await pool.query(
    `INSERT INTO lead_transfer_events (kommo_id, changed_at, to_user_id)
     VALUES ${tuples}
     ON CONFLICT (kommo_id, changed_at) DO NOTHING`,
    values
  );
}

let running = false;

/**
 * Pulls entity_responsible_changed events and records the ones that land on a
 * Кваліфікація-pipeline lead as "передані заявки".
 * @param opts.sinceUnix  Explicit start for a historical backfill (does not
 *   advance the watermark). Omit for an incremental run from the watermark.
 */
export async function syncTransfers(opts: { sinceUnix?: number; untilUnix?: number } = {}): Promise<void> {
  if (running) {
    console.warn("syncTransfers: previous run still in progress — skipping this tick.");
    return;
  }
  running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const isBackfill = opts.sinceUnix != null;
    let sinceUnix = opts.sinceUnix;
    if (sinceUnix == null) {
      const r = await pool.query<{ last_transfer_at: Date | null }>(
        `SELECT last_transfer_at FROM sync_state WHERE id = 1`
      );
      const last = r.rows[0]?.last_transfer_at;
      sinceUnix = last ? Math.floor(last.getTime() / 1000) - 300 : now - 1800;
    }
    const untilUnix = opts.untilUnix ?? now;

    // Порції ≤24 год + інкрементальний вотермарк (той самий фікс, що syncStageEvents):
    // раніше «все або нічого» → last_transfer_at застряг з IP-бану 08.07.
    const total = await processInChunks(
      sinceUnix,
      untilUnix,
      (from, to) => forEachResponsibleChangeEventPage(from, to, insertTransfers),
      isBackfill
        ? null
        : (chunkUntil) =>
            pool.query(`UPDATE sync_state SET last_transfer_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {})
    );
    console.log(`Transfers synced: scanned ${total} responsible-change events (${sinceUnix}..${untilUnix}).`);
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const monthsArg = process.argv.find((a) => a.startsWith("--months="));
  const months = monthsArg ? Number(monthsArg.split("=")[1]) : null;
  const opts = months
    ? { sinceUnix: Math.floor(Date.now() / 1000) - months * 30 * 24 * 60 * 60 }
    : {};
  syncTransfers(opts)
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
