import { pool } from "../db/pool.js";
import { forEachLeadNoteEventPage } from "../kommo/client.js";
import { isKommoPaused } from "../kommo/pause.js";
import { processInChunks } from "./chunkWindow.js";
import { createRunGuard, type GuardSkip } from "./runGuard.js";
import { jobSkip, type JobSkip } from "./jobRuns.js";

/**
 * ✍️ НОТАТКИ МЕНЕДЖЕРІВ В УГОДАХ KOMMO → `kommo_note_events` (задача 7240). Двічі на годину (:12 і :42 за Києвом).
 *
 * Слід для обіцянок «напишу у Viber»: менеджер написав клієнту й лишив нотатку в угоді — обіцянка виконана. Беремо
 * лише факт (угода, автор, час). Вікна по 6 год від вотермарка (`sync_state.kommo_note_events_at`); перший прохід —
 * за останні `BACKFILL_DAYS` днів: давніші обіцянки вже не перевіряються заднім числом, і це чесно видно як «чекає».
 * Вотермарк рухається лише після записаного вікна, тож обрив посеред проходу нічого не губить.
 */
const guard = createRunGuard("syncKommoNoteEvents");
export const BACKFILL_DAYS = 21;
const WINDOW_SEC = 6 * 3600;
/** Перекриття: подія, записана Kommo із запізненням на межі вікна, не губиться; повтор — не новий рядок (ключ події). */
const OVERLAP_SEC = 600;

export interface NoteEventsReport { seen: number; inserted: number; byRobot: number; from: string; to: string }

export async function syncKommoNoteEvents(): Promise<NoteEventsReport | GuardSkip | JobSkip> {
  if (isKommoPaused()) return jobSkip("Kommo на паузі (KOMMO_PAUSED)");
  return guard(async () => {
    const now = Math.floor(Date.now() / 1000);
    const last = (await pool.query<{ at: Date | null }>(`SELECT kommo_note_events_at AS at FROM sync_state WHERE id = 1`)).rows[0]?.at;
    const since = last ? Math.floor(last.getTime() / 1000) - OVERLAP_SEC : now - BACKFILL_DAYS * 86_400;
    const rep: NoteEventsReport = { seen: 0, inserted: 0, byRobot: 0, from: new Date(since * 1000).toISOString(), to: new Date(now * 1000).toISOString() };
    await processInChunks(since, now, async (from, to) => forEachLeadNoteEventPage(from, to, async (events) => {
      rep.seen += events.length;
      rep.byRobot += events.filter((e) => e.createdBy === 0).length;
      const r = await pool.query(
        `INSERT INTO kommo_note_events (event_id, lead_id, created_by, created_at)
         SELECT * FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::timestamptz[])
         ON CONFLICT (event_id) DO NOTHING`,
        [events.map((e) => e.id), events.map((e) => e.leadId), events.map((e) => e.createdBy), events.map((e) => new Date(e.createdAt * 1000).toISOString())]);
      rep.inserted += r.rowCount ?? 0;
    }), (chunkUntil) => pool.query(`UPDATE sync_state SET kommo_note_events_at = $1 WHERE id = 1`, [new Date(chunkUntil * 1000)]).then(() => {}), WINDOW_SEC);
    console.log(`syncKommoNoteEvents: подій ${String(rep.seen)} (роботів ${String(rep.byRobot)}), нових ${String(rep.inserted)}, вікно ${rep.from} → ${rep.to}`);
    return rep;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncKommoNoteEvents()
    .then((r) => { console.log(JSON.stringify(r)); return pool.end(); })
    .catch((err) => { console.error(err); process.exit(1); });
}
