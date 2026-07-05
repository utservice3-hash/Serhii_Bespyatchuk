import { pool } from "../db/pool.js";
import { forEachLeadNotePage, type KommoLeadNote } from "../kommo/client.js";

/**
 * Note types that count as real work in the deal. Calls and texts (in/out) and
 * manual notes are a manager engaging the client. We additionally require
 * created_by <> 0 so Salesbot / system-generated notes never count — that's the
 * whole point: "stuck" must not be reset by automation.
 */
const HUMAN_NOTE_TYPES = new Set([
  "call_in",
  "call_out",
  "common",
  "sms_in",
  "sms_out",
  "chat_message",
]);

function isHumanActivity(n: KommoLeadNote): boolean {
  if (n.createdBy === 0) return false; // Salesbot / system
  return HUMAN_NOTE_TYPES.has(n.noteType);
}

async function applyNotes(notes: KommoLeadNote[]): Promise<void> {
  // Collapse to the latest human-activity timestamp per lead in this page.
  const latest = new Map<number, number>();
  for (const n of notes) {
    if (!isHumanActivity(n)) continue;
    const cur = latest.get(n.entityId) ?? 0;
    if (n.createdAt > cur) latest.set(n.entityId, n.createdAt);
  }
  if (latest.size === 0) return;

  const ids: number[] = [];
  const ts: Date[] = [];
  for (const [id, unix] of latest) {
    ids.push(id);
    ts.push(new Date(unix * 1000));
  }
  // Only ever move last_activity_at forward (GREATEST); an out-of-order page
  // must not overwrite a newer timestamp. Update in place — a note always
  // belongs to a deal we already synced.
  await pool.query(
    `UPDATE deals d
        SET last_activity_at = GREATEST(COALESCE(d.last_activity_at, 'epoch'::timestamptz), v.ts)
       FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS ts) v
      WHERE d.kommo_id = v.kommo_id`,
    [ids, ts]
  );
}

let running = false;

/**
 * Pulls Kommo lead notes and records the latest human-made activity per deal in
 * deals.last_activity_at. Incremental from a watermark (with overlap); a
 * historical backfill is done with an explicit sinceUnix and does NOT advance
 * the watermark.
 */
export async function syncDealActivity(opts: { sinceUnix?: number; untilUnix?: number } = {}): Promise<void> {
  if (running) {
    console.warn("syncDealActivity: previous run still in progress — skipping this tick.");
    return;
  }
  running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const isBackfill = opts.sinceUnix != null;
    let sinceUnix = opts.sinceUnix;
    if (sinceUnix == null) {
      const r = await pool.query<{ last_activity_note_at: Date | null }>(
        `SELECT last_activity_note_at FROM sync_state WHERE id = 1`
      );
      const last = r.rows[0]?.last_activity_note_at;
      sinceUnix = last ? Math.floor(last.getTime() / 1000) - 300 : now - 1800;
    }
    const untilUnix = opts.untilUnix ?? now;

    const total = await forEachLeadNotePage(sinceUnix, untilUnix, applyNotes);

    if (!isBackfill) {
      await pool.query(`UPDATE sync_state SET last_activity_note_at = $1 WHERE id = 1`, [
        new Date(untilUnix * 1000),
      ]);
    }
    console.log(`Deal activity synced: ${total} notes scanned (${sinceUnix}..${untilUnix}).`);
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI: `node dist/jobs/syncDealActivity.js --months=6` backfills N months.
  const monthsArg = process.argv.find((a) => a.startsWith("--months="));
  const months = monthsArg ? Number(monthsArg.split("=")[1]) : null;
  const opts = months
    ? { sinceUnix: Math.floor(Date.now() / 1000) - months * 30 * 24 * 60 * 60 }
    : {};
  syncDealActivity(opts)
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
