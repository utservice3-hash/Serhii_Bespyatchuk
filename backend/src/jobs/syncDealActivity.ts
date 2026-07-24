import { pool } from "../db/pool.js";
import { forEachLeadNotePage, type KommoLeadNote } from "../kommo/client.js";
import { processInChunks } from "./chunkWindow.js";

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

// Дзвінок клієнту = лише call_in/call_out (людські). Окремо від last_activity_at,
// бо той змішує дзвінки з нотатками/sms/чатом — а нам треба саме РОЗМОВУ.
function isHumanCall(n: KommoLeadNote): boolean {
  if (n.createdBy === 0) return false;
  return n.noteType === "call_in" || n.noteType === "call_out";
}

async function applyNotes(notes: KommoLeadNote[]): Promise<void> {
  // Collapse to the EARLIEST and LATEST human-activity timestamp per lead in this
  // page. last_activity_at → «застряглі» (остання активність); first_activity_at
  // → «час опрацювання» (перший контакт менеджера з лідом).
  const earliest = new Map<number, number>();
  const latest = new Map<number, number>();
  const latestCall = new Map<number, number>(); // останній ДЗВІНОК (call_in/call_out) per lead
  for (const n of notes) {
    if (isHumanCall(n)) {
      const c = latestCall.get(n.entityId) ?? 0;
      if (n.createdAt > c) latestCall.set(n.entityId, n.createdAt);
    }
    if (!isHumanActivity(n)) continue;
    const lo = earliest.get(n.entityId);
    if (lo == null || n.createdAt < lo) earliest.set(n.entityId, n.createdAt);
    const hi = latest.get(n.entityId) ?? 0;
    if (n.createdAt > hi) latest.set(n.entityId, n.createdAt);
  }
  if (latest.size === 0 && latestCall.size === 0) return;

  // Об'єднуємо ключі: угода може мати дзвінок без іншої активності (і навпаки лишень
  // теоретично — дзвінок сам по собі вже activity). NULL у відсутньому анкері не чіпає
  // колонку (GREATEST з COALESCE-нейтралем).
  const allIds = new Set<number>([...latest.keys(), ...latestCall.keys()]);
  const ids: number[] = [];
  const tsHi: (Date | null)[] = [];
  const tsLo: (Date | null)[] = [];
  const tsCall: (Date | null)[] = [];
  for (const id of allIds) {
    ids.push(id);
    const hi = latest.get(id);
    tsHi.push(hi != null ? new Date(hi * 1000) : null);
    tsLo.push(hi != null ? new Date((earliest.get(id) ?? hi) * 1000) : null);
    const call = latestCall.get(id);
    tsCall.push(call != null ? new Date(call * 1000) : null);
  }
  // Postgres GREATEST/LEAST ІГНОРУЮТЬ NULL (результат NULL лише коли всі NULL). Тож:
  // last_activity_at рухається лише вперед, first_activity_at лише назад, last_call_at —
  // окремий анкер лише вперед. NULL у порції (напр. нотатка без дзвінка → v.call=NULL)
  // лишає збережене значення недоторканим, а угода без ЖОДНОГО дзвінка тримає last_call_at=NULL
  // («дзвінка не було»). Це коректніше за COALESCE(...,'epoch'), який засмітив би 1970-м.
  await pool.query(
    `UPDATE deals d
        SET last_activity_at  = GREATEST(d.last_activity_at, v.hi),
            first_activity_at = LEAST(d.first_activity_at, v.lo),
            last_call_at      = GREATEST(d.last_call_at, v.call)
       FROM (SELECT UNNEST($1::bigint[]) AS kommo_id, UNNEST($2::timestamptz[]) AS hi, UNNEST($3::timestamptz[]) AS lo, UNNEST($4::timestamptz[]) AS call) v
      WHERE d.kommo_id = v.kommo_id`,
    [ids, tsHi, tsLo, tsCall]
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

    // Порції ≤24 год + інкрементальний вотермарк (той самий фікс, що syncStageEvents):
    // раніше «все або нічого» → last_activity_note_at застряг з IP-бану 08.07.
    const total = await processInChunks(
      sinceUnix,
      untilUnix,
      (from, to) => forEachLeadNotePage(from, to, applyNotes),
      isBackfill
        ? null
        : (chunkUntil) =>
            pool.query(`UPDATE sync_state SET last_activity_note_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {})
    );
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
