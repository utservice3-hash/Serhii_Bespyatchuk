/**
 * 🎥 tl;dv — РОБОТА З БАЗОЮ: запамʼятати зустрічі, привʼязати запис до рядка графіка, показати те, що
 * чекає рішення людини (23.09.2026, прохід 7). Правила зіставлення — `core/tldv.ts`, тут лише записи.
 *
 * 🔴 ПОСИЛАННЯ НА ЗАПИС НЕ ЗАТИРАЄМО. Якщо Іван уже вставив своє посилання руками, воно лишається: наше
 * йде лише в порожнє поле. Інакше автоматика мовчки викидала б ручну роботу.
 * Тримають #732–#733.
 */
import type { Db } from "./secrets.js";
import { matchMeetings, type SlotRow, type TldvMeeting, type MatchHow } from "./tldv.js";

export class TldvError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Рядки графіка, серед яких шукаємо: останні дні, не видалені, з поштою кандидата. */
export async function slotRows(db: Db, fromDay: string, toDay: string): Promise<SlotRow[]> {
  return (await db.query<SlotRow>(
    `SELECT i.id, i.interview_date::text AS interview_date, i.interview_time::text AS interview_time,
            c.full_name, NULLIF(btrim(c.email), '') AS email, i.tldv_meeting_id
       FROM hiring_interviews i LEFT JOIN hiring_candidates c ON c.id = i.candidate_id
      WHERE i.deleted_at IS NULL AND i.interview_date BETWEEN $1::date AND $2::date`, [fromDay, toDay])).rows;
}

/** Привʼязати зустріч до рядка: посилання в порожнє поле, подія в історію кандидата, стан «linked». */
export async function linkMeeting(db: Db, actorId: number | null, meetingId: string, interviewId: number, how: MatchHow | "manual") {
  const iv = (await db.query<{ id: number; candidate_id: number | null; record_url: string | null }>(
    `SELECT id, candidate_id, record_url FROM hiring_interviews WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [interviewId])).rows[0];
  if (!iv) throw new TldvError(404, "Рядок графіка не знайдено");
  const m = (await db.query<{ url: string | null }>(`SELECT url FROM tldv_meetings WHERE id = $1`, [meetingId])).rows[0];
  if (!m) throw new TldvError(404, "Зустріч не знайдено");
  await db.query(
    `UPDATE hiring_interviews SET tldv_meeting_id = $2, record_url = COALESCE(NULLIF(btrim(record_url), ''), $3), updated_at = now() WHERE id = $1`,
    [interviewId, meetingId, m.url]);
  await db.query(
    `UPDATE tldv_meetings SET state = 'linked', interview_id = $2, how = $3, decided_by = $4, decided_at = now() WHERE id = $1`,
    [meetingId, interviewId, how, actorId]);
  if (iv.candidate_id) {
    await db.query(
      `INSERT INTO hiring_events (candidate_id, interview_id, kind, comment, actor_id) VALUES ($1, $2, 'record', $3, $4)`,
      [iv.candidate_id, interviewId, how === "email" ? "запис співбесіди з tl;dv (за поштою учасника)" : "запис співбесіди з tl;dv", actorId]);
  }
  return { ok: true as const };
}

/** «Не співбесіда» — більше не показувати. Скасовно: `state` повертається в `pending`. */
export async function setIgnored(db: Db, actorId: number | null, meetingId: string, ignored: boolean) {
  const r = await db.query(
    `UPDATE tldv_meetings SET state = $2, decided_by = $3, decided_at = now(), interview_id = NULL WHERE id = $1 AND state <> 'linked'`,
    [meetingId, ignored ? "ignored" : "pending", actorId]);
  if (!r.rowCount) throw new TldvError(404, "Зустріч не знайдено або вже привʼязана");
}

/** Запамʼятати зустрічі й привʼязати певні збіги. Повторний прогін нічого не дублює. */
export async function absorb(db: Db, meetings: TldvMeeting[], rows: SlotRow[]) {
  const out = { seen: meetings.length, linked: 0, pending: 0 };
  const known = new Map((await db.query<{ id: string; state: string }>(
    `SELECT id, state FROM tldv_meetings WHERE id = ANY($1::text[])`, [meetings.map((m) => m.id)])).rows.map((r) => [r.id, r.state]));
  for (const m of matchMeetings(meetings, rows)) {
    const st = known.get(m.meeting.id);
    await db.query(
      `INSERT INTO tldv_meetings (id, name, happened_at, duration_min, url, organizer, invitees, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, happened_at = EXCLUDED.happened_at,
         duration_min = EXCLUDED.duration_min, url = EXCLUDED.url, organizer = EXCLUDED.organizer,
         invitees = EXCLUDED.invitees, seen_at = now()`,
      [m.meeting.id, m.meeting.name, m.meeting.happenedAt, m.meeting.duration, m.meeting.url, m.meeting.organizer, JSON.stringify(m.meeting.invitees)]);
    if (st === "linked" || st === "ignored") continue;
    if (m.how === "email" && m.interviewId) { await linkMeeting(db, null, m.meeting.id, m.interviewId, "email"); out.linked++; }
    else out.pending++;
  }
  return out;
}

/** Що показати в «Графіку»: зустрічі, які чекають рішення, з підказкою, на який рядок вони схожі. */
export async function pendingList(db: Db, fromDay: string, toDay: string) {
  const rows = await slotRows(db, fromDay, toDay);
  const meets = (await db.query<{ id: string; name: string | null; happened_at: string | null; duration_min: number | null; url: string | null; organizer: string | null; invitees: string[] }>(
    `SELECT id, name, happened_at::text AS happened_at, duration_min, url, organizer, invitees
       FROM tldv_meetings WHERE state = 'pending' ORDER BY happened_at DESC NULLS LAST LIMIT 50`)).rows;
  const matched = matchMeetings(meets.map((m) => ({
    id: m.id, name: m.name, happenedAt: m.happened_at, duration: m.duration_min, url: m.url, organizer: m.organizer, invitees: m.invitees ?? [],
  })), rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return matched.map((x) => ({
    id: x.meeting.id, name: x.meeting.name, happenedAt: x.meeting.happenedAt, durationMin: x.meeting.duration,
    url: x.meeting.url, organizer: x.meeting.organizer, invitees: x.meeting.invitees.length, how: x.how,
    suggestions: x.nearIds.map((id) => {
      const r = byId.get(id)!;
      return { interviewId: id, label: `${r.interview_date.slice(8, 10)}.${r.interview_date.slice(5, 7)} ${r.interview_time ?? "—"} · ${r.full_name || "без імені"}` };
    }),
  }));
}
