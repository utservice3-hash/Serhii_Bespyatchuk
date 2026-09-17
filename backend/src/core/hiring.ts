/**
 * 🧑‍💼 НАЙМ — ЗАПИТИ (прохід 1, 17.09.2026). Правила — `hiringRules.ts`.
 *
 * Кожна функція приймає зʼєднання параметром і НЕ імпортує `db/pool`: гейт `#503` ганяє
 * цей самий SQL на схемі з нуля через власний `pg.Client` (синглтон пулу в чужому
 * `finally` поклав би сусідні тести). Роут передає клієнт транзакції.
 *
 * 📅 Усі дати — за Києвом, обидва кінці включно (`… AT TIME ZONE 'Europe/Kyiv')::date`).
 */
import {
  type HiringAccess, type HiringStatus, type DailyRow,
  canTransition, isHiringStatus, isIsoDate, isTime, normalizePhone, cleanUrl, NEEDS_TEAM, STATUS_LABEL,
} from "./hiringRules.js";

export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

export class HiringError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

const KYIV_DAY = (col: string) => `(${col} AT TIME ZONE 'Europe/Kyiv')::date`;

const CANDIDATE_COLS = `c.id, c.full_name, c.phone, c.telegram, c.source, c.position, c.status, c.team_id,
  t.name AS team_name, c.resume_url, c.comment,
  to_char(c.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS created_on`;

export interface ScheduleRow {
  id: number; candidate_id: number | null; responsible: string | null;
  assigned_on: string; interview_date: string; interview_time: string | null;
  attended: boolean | null; record_url: string | null; comment: string | null;
  full_name: string | null; phone: string | null; telegram: string | null; source: string | null;
  position: string | null; status: HiringStatus | null; team_id: number | null;
}

/** Графік за період (включно). Видалені рядки не показуються; `?deleted` — лише для «Відновити». */
export async function scheduleRows(db: Db, from: string, to: string): Promise<ScheduleRow[]> {
  const r = await db.query<ScheduleRow>(
    `SELECT i.id, i.candidate_id, i.responsible,
            to_char(i.assigned_on, 'YYYY-MM-DD') AS assigned_on,
            to_char(i.interview_date, 'YYYY-MM-DD') AS interview_date,
            to_char(i.interview_time, 'HH24:MI') AS interview_time,
            i.attended, i.record_url, i.comment,
            c.full_name, c.phone, c.telegram, c.source, c.position, c.status, c.team_id
       FROM hiring_interviews i
       LEFT JOIN hiring_candidates c ON c.id = i.candidate_id
      WHERE i.deleted_at IS NULL AND i.interview_date BETWEEN $1::date AND $2::date
      ORDER BY i.interview_date, i.interview_time NULLS LAST, i.id`,
    [from, to],
  );
  return r.rows;
}

export async function createInterview(
  db: Db, actorId: number | null, p: { interviewDate: unknown; interviewTime?: unknown; responsible?: unknown },
): Promise<number> {
  if (!isIsoDate(p.interviewDate)) throw new HiringError(400, "Потрібна дата співбесіди");
  const time = p.interviewTime == null || p.interviewTime === "" ? null : p.interviewTime;
  if (time != null && !isTime(time)) throw new HiringError(400, "Час у форматі ГГ:ХХ");
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_interviews (interview_date, interview_time, responsible, created_by)
     VALUES ($1::date, $2::time, $3, $4) RETURNING id`,
    [p.interviewDate, time, typeof p.responsible === "string" && p.responsible.trim() ? p.responsible.trim() : null, actorId],
  );
  return r.rows[0].id;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

async function logEvent(db: Db, e: {
  candidateId: number; interviewId?: number | null; kind: string; from?: string | null; to?: string | null;
  comment?: string | null; actorId: number | null;
}) {
  await db.query(
    `INSERT INTO hiring_events (candidate_id, interview_id, kind, from_status, to_status, comment, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.candidateId, e.interviewId ?? null, e.kind, e.from ?? null, e.to ?? null, e.comment ?? null, e.actorId],
  );
}

/** Кандидат із таким номером — для повідомлення «цей номер уже в базі». */
async function byPhone(db: Db, norm: string, exceptId?: number) {
  const r = await db.query<{ id: number; full_name: string; status: HiringStatus }>(
    `SELECT id, full_name, status FROM hiring_candidates WHERE phone_norm = $1 AND ($2::int IS NULL OR id <> $2) LIMIT 1`,
    [norm, exceptId ?? null],
  );
  return r.rows[0] ?? null;
}

const CAND_FIELDS: Record<string, string> = {
  fullName: "full_name", phone: "phone", telegram: "telegram", source: "source", position: "position",
  resumeUrl: "resume_url", comment: "comment",
};

/**
 * Оновлення полів кандидата. Зміна телефону на номер ІНШОГО кандидата — 409 з його іменем:
 * зливати картки мовчки не можна (у кожної своя історія), а плодити дубль — саме те, від
 * чого захищає ключ.
 */
export async function updateCandidateFields(
  db: Db, actorId: number | null, id: number, patch: Record<string, unknown>,
): Promise<void> {
  const sets: string[] = []; const params: unknown[] = [];
  for (const [k, col] of Object.entries(CAND_FIELDS)) {
    if (!(k in patch)) continue;
    let v: unknown;
    if (k === "resumeUrl") {
      v = cleanUrl(patch[k]);
      if (v === undefined) throw new HiringError(400, "Посилання на резюме має починатися з http:// або https://");
    } else if (k === "fullName") {
      v = typeof patch[k] === "string" ? (patch[k] as string).trim() : "";
    } else v = str(patch[k]);
    params.push(v); sets.push(`${col} = $${params.length}`);
    if (k === "phone") {
      const norm = normalizePhone(v);
      if (norm) {
        const other = await byPhone(db, norm, id);
        if (other) throw new HiringError(409, `Цей номер уже в базі: ${other.full_name || "без імені"} (${STATUS_LABEL[other.status]})`, { existing: other });
      }
      params.push(norm); sets.push(`phone_norm = $${params.length}`);
    }
  }
  if (!sets.length) return;
  params.push(id);
  await db.query(`UPDATE hiring_candidates SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  await logEvent(db, { candidateId: id, kind: "edit", comment: Object.keys(patch).filter((k) => k in CAND_FIELDS).join(", "), actorId });
}

export interface InterviewPatchResult { candidateId: number | null; repeat?: { id: number; full_name: string; status: HiringStatus } }

/**
 * Зміна рядка графіка — одна клітинка або кілька. Поля кандидата пишуться в картку кандидата.
 *
 * • Рядок без кандидата + введено ПІБ або телефон → створюємо кандидата «заплановано»; якщо
 *   номер уже є в базі — привʼязуємо ІСНУЮЧОГО (подія «повторний відгук»), не створюючи дубля.
 * • «Прийшов» / «не прийшов» ставить `attended_at = now()` — за ним рахується звіт — і
 *   зсуває статус лише ВПЕРЕД із ранніх етапів (заплановано → проведено / не прийшов).
 *   Пізніші статуси позначка не чіпає: кандидат на навчанні не стає «проведено».
 */
export async function updateInterview(
  db: Db, actorId: number | null, id: number, patch: Record<string, unknown>,
): Promise<InterviewPatchResult> {
  const cur = (await db.query<{ id: number; candidate_id: number | null; attended: boolean | null }>(
    `SELECT id, candidate_id, attended FROM hiring_interviews WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id],
  )).rows[0];
  if (!cur) throw new HiringError(404, "Рядок графіка не знайдено");
  let candidateId = cur.candidate_id;
  const out: InterviewPatchResult = { candidateId };

  const candPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => k in CAND_FIELDS && k !== "comment" && k !== "resumeUrl"));
  if (Object.keys(candPatch).length) {
    if (candidateId) {
      await updateCandidateFields(db, actorId, candidateId, candPatch);
    } else if (str(candPatch.fullName) || normalizePhone(candPatch.phone)) {
      const norm = normalizePhone(candPatch.phone);
      const existing = norm ? await byPhone(db, norm) : null;
      if (existing) {
        candidateId = existing.id; out.repeat = existing;
        await logEvent(db, { candidateId, interviewId: id, kind: "repeat", comment: "повторний запис у графік за тим самим номером", actorId });
        if (existing.status === "new") await setStatus(db, actorId, candidateId, "new", "planned", "записано в графік", id);
      } else {
        const ins = await db.query<{ id: number }>(
          `INSERT INTO hiring_candidates (full_name, phone, phone_norm, telegram, source, position, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'planned', $7) RETURNING id`,
          [str(candPatch.fullName) ?? "", str(candPatch.phone), norm, str(candPatch.telegram), str(candPatch.source), str(candPatch.position), actorId],
        );
        candidateId = ins.rows[0].id;
        await logEvent(db, { candidateId, interviewId: id, kind: "created", to: "planned", comment: "створено з графіка", actorId });
      }
      await db.query(`UPDATE hiring_interviews SET candidate_id = $1 WHERE id = $2`, [candidateId, id]);
      out.candidateId = candidateId;
    }
  }

  const sets: string[] = []; const params: unknown[] = [];
  const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if ("interviewDate" in patch) {
    if (!isIsoDate(patch.interviewDate)) throw new HiringError(400, "Дата співбесіди некоректна");
    put("interview_date", patch.interviewDate);
  }
  if ("assignedOn" in patch) {
    if (!isIsoDate(patch.assignedOn)) throw new HiringError(400, "Дата призначення некоректна");
    put("assigned_on", patch.assignedOn);
  }
  if ("interviewTime" in patch) {
    const t = patch.interviewTime === "" || patch.interviewTime == null ? null : patch.interviewTime;
    if (t != null && !isTime(t)) throw new HiringError(400, "Час у форматі ГГ:ХХ");
    put("interview_time", t);
  }
  if ("responsible" in patch) put("responsible", str(patch.responsible));
  if ("comment" in patch) put("comment", str(patch.comment));
  if ("recordUrl" in patch) {
    const u = cleanUrl(patch.recordUrl);
    if (u === undefined) throw new HiringError(400, "Посилання на запис має починатися з http:// або https://");
    put("record_url", u);
  }
  if ("attended" in patch) {
    const a = patch.attended;
    if (a !== true && a !== false && a !== null) throw new HiringError(400, "«Прийшов» — так, ні або не відмічено");
    if (a !== cur.attended) {
      put("attended", a);
      sets.push(a === null ? "attended_at = NULL" : "attended_at = now()");
      if (candidateId) {
        await logEvent(db, { candidateId, interviewId: id, kind: "attended",
          comment: a === true ? "прийшов на співбесіду" : a === false ? "не прийшов на співбесіду" : "позначку явки знято", actorId });
        const st = (await db.query<{ status: HiringStatus }>(`SELECT status FROM hiring_candidates WHERE id = $1 FOR UPDATE`, [candidateId])).rows[0]?.status;
        if (a === true && st && ["new", "planned", "noshow", "noanswer"].includes(st))
          await setStatus(db, actorId, candidateId, st, "done", "позначка «прийшов» у графіку", id);
        if (a === false && st && ["new", "planned"].includes(st))
          await setStatus(db, actorId, candidateId, st, "noshow", "позначка «не прийшов» у графіку", id);
      }
    }
  }
  if (sets.length) {
    params.push(id);
    await db.query(`UPDATE hiring_interviews SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  return out;
}

async function setStatus(db: Db, actorId: number | null, candidateId: number, from: HiringStatus, to: HiringStatus, comment: string, interviewId?: number) {
  await db.query(`UPDATE hiring_candidates SET status = $1, updated_at = now() WHERE id = $2`, [to, candidateId]);
  await logEvent(db, { candidateId, interviewId, kind: "status", from, to, comment, actorId });
}

/** Мʼяке видалення і відновлення — пара, що повертає рядок до байта (#502). */
export async function setInterviewDeleted(db: Db, actorId: number | null, id: number, deleted: boolean): Promise<void> {
  const r = await db.query(
    deleted
      ? `UPDATE hiring_interviews SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`
      : `UPDATE hiring_interviews SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL`,
    deleted ? [id, actorId] : [id],
  );
  if (!r.rowCount) throw new HiringError(404, deleted ? "Рядок не знайдено або вже видалено" : "Видаленого рядка не знайдено");
}

/**
 * Межа тімліда в SQL: кандидат його команди, який УЖЕ доходив до співбесіди з тімлідом.
 * Подія, а не поточний статус: відмова після розмови з тімлідом лишається в нього видимою.
 */
export const LEAD_VISIBLE_SQL = (teamParam: string) =>
  `(c.team_id = ${teamParam} AND EXISTS (SELECT 1 FROM hiring_events e
      WHERE e.candidate_id = c.id AND e.kind = 'status' AND e.to_status = 'lead'))`;

export interface CandidateFilters { q?: string; status?: string; source?: string; position?: string; teamId?: number | null; limit?: number; offset?: number }

export async function listCandidates(db: Db, f: CandidateFilters, access: HiringAccess, leadTeamId: number | null) {
  const where: string[] = []; const params: unknown[] = [];
  if (access === "lead") { params.push(leadTeamId ?? -1); where.push(LEAD_VISIBLE_SQL(`$${params.length}`)); }
  else if (access !== "edit") where.push("false");
  if (f.q) {
    params.push(`%${f.q.toLowerCase()}%`);
    const digits = f.q.replace(/\D/g, "");
    let cond = `(lower(c.full_name) LIKE $${params.length} OR lower(COALESCE(c.telegram,'')) LIKE $${params.length}`;
    if (digits.length >= 4) { params.push(`%${digits}%`); cond += ` OR c.phone_norm LIKE $${params.length}`; }
    where.push(cond + ")");
  }
  if (f.status && isHiringStatus(f.status)) { params.push(f.status); where.push(`c.status = $${params.length}`); }
  if (f.source) { params.push(f.source); where.push(`c.source = $${params.length}`); }
  if (f.position) { params.push(f.position); where.push(`c.position = $${params.length}`); }
  if (f.teamId) { params.push(f.teamId); where.push(`c.team_id = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM hiring_candidates c ${w}`, params)).rows[0].n;
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500), offset = Math.max(f.offset ?? 0, 0);
  const rows = (await db.query(
    `SELECT ${CANDIDATE_COLS},
            (SELECT to_char(max(i.interview_date), 'YYYY-MM-DD') FROM hiring_interviews i
              WHERE i.candidate_id = c.id AND i.deleted_at IS NULL) AS last_interview,
            (SELECT count(*)::int FROM hiring_events e WHERE e.candidate_id = c.id AND e.kind = 'repeat') AS repeats
       FROM hiring_candidates c LEFT JOIN teams t ON t.id = c.team_id
       ${w}
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ${limit} OFFSET ${offset}`, params)).rows;
  return { total, rows };
}

export async function candidateCard(db: Db, id: number, access: HiringAccess, leadTeamId: number | null) {
  const params: unknown[] = [id];
  let vis = "";
  if (access === "lead") { params.push(leadTeamId ?? -1); vis = ` AND ${LEAD_VISIBLE_SQL("$2")}`; }
  else if (access !== "edit") vis = " AND false";
  const c = (await db.query(`SELECT ${CANDIDATE_COLS} FROM hiring_candidates c LEFT JOIN teams t ON t.id = c.team_id WHERE c.id = $1${vis}`, params)).rows[0];
  if (!c) throw new HiringError(404, "Кандидата не знайдено");
  const interviews = (await db.query(
    `SELECT id, to_char(interview_date, 'YYYY-MM-DD') AS interview_date, to_char(interview_time, 'HH24:MI') AS interview_time,
            responsible, attended, record_url, comment
       FROM hiring_interviews WHERE candidate_id = $1 AND deleted_at IS NULL ORDER BY interview_date DESC, id DESC`, [id])).rows;
  const events = (await db.query(
    `SELECT e.id, e.kind, e.from_status, e.to_status, e.comment,
            to_char(e.at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD HH24:MI') AS at,
            COALESCE(u.full_name, m.name, u.email) AS actor
       FROM hiring_events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN managers m ON m.id = u.manager_id
      WHERE e.candidate_id = $1 ORDER BY e.at DESC, e.id DESC`, [id])).rows;
  const lastFrom = (await db.query<{ from_status: HiringStatus | null }>(
    `SELECT from_status FROM hiring_events WHERE candidate_id = $1 AND kind = 'status' ORDER BY at DESC, id DESC LIMIT 1`, [id])).rows[0]?.from_status ?? null;
  return { candidate: c, interviews, events, lastFrom };
}

export async function createCandidate(db: Db, actorId: number | null, p: Record<string, unknown>): Promise<number> {
  const name = str(p.fullName);
  if (!name) throw new HiringError(400, "Потрібне ПІБ");
  const norm = normalizePhone(p.phone);
  if (norm) {
    const other = await byPhone(db, norm);
    if (other) throw new HiringError(409, `Цей номер уже в базі: ${other.full_name || "без імені"} (${STATUS_LABEL[other.status]})`, { existing: other });
  }
  const resume = cleanUrl(p.resumeUrl);
  if (resume === undefined) throw new HiringError(400, "Посилання на резюме має починатися з http:// або https://");
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_candidates (full_name, phone, phone_norm, telegram, source, position, resume_url, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [name, str(p.phone), norm, str(p.telegram), str(p.source), str(p.position), resume, str(p.comment), actorId],
  );
  await logEvent(db, { candidateId: r.rows[0].id, kind: "created", to: "new", comment: "додано в базу", actorId });
  return r.rows[0].id;
}

/** Зміна статусу з картки чи графіка. Коментар обовʼязковий (затверджений макет). */
export async function changeStatus(
  db: Db, actorId: number | null, id: number,
  p: { to: unknown; comment: unknown; teamId?: unknown },
  access: HiringAccess, leadTeamId: number | null,
): Promise<void> {
  if (!isHiringStatus(p.to)) throw new HiringError(400, "Невідомий статус");
  const comment = str(p.comment);
  if (!comment) throw new HiringError(400, "Коментар обовʼязковий");
  const params: unknown[] = [id];
  let vis = "";
  if (access === "lead") { params.push(leadTeamId ?? -1); vis = ` AND ${LEAD_VISIBLE_SQL("$2")}`; }
  else if (access !== "edit") vis = " AND false";
  const c = (await db.query<{ status: HiringStatus; team_id: number | null }>(
    `SELECT c.status, c.team_id FROM hiring_candidates c WHERE c.id = $1${vis} FOR UPDATE`, params)).rows[0];
  if (!c) throw new HiringError(404, "Кандидата не знайдено");
  const lastFrom = (await db.query<{ from_status: HiringStatus | null }>(
    `SELECT from_status FROM hiring_events WHERE candidate_id = $1 AND kind = 'status' ORDER BY at DESC, id DESC LIMIT 1`, [id])).rows[0]?.from_status ?? null;
  const v = canTransition(c.status, p.to, access, lastFrom);
  if (!v.ok) throw new HiringError(403, v.reason);

  let teamId = c.team_id;
  if (p.teamId !== undefined && p.teamId !== null && p.teamId !== "") {
    const t = Number(p.teamId);
    if (!Number.isInteger(t) || t <= 0) throw new HiringError(400, "Некоректна команда");
    if (access === "lead" && t !== leadTeamId) throw new HiringError(403, "Тімлід не передає кандидата в іншу команду");
    teamId = t;
  }
  if (NEEDS_TEAM.includes(p.to) && !teamId) throw new HiringError(400, "Оберіть команду, до якої йде кандидат");
  await db.query(`UPDATE hiring_candidates SET status = $1, team_id = $2, updated_at = now() WHERE id = $3`, [p.to, teamId, id]);
  await logEvent(db, { candidateId: id, kind: "status", from: c.status, to: p.to, comment, actorId });
}

export async function addComment(db: Db, actorId: number | null, id: number, comment: unknown, access: HiringAccess, leadTeamId: number | null) {
  const text = str(comment);
  if (!text) throw new HiringError(400, "Порожній коментар");
  await candidateCard(db, id, access, leadTeamId); // межа видимості та сама, що в картки
  await logEvent(db, { candidateId: id, kind: "comment", comment: text, actorId });
}

/**
 * Щоденний звіт за період — рядок на КОЖЕН день, включно з порожніми.
 * • planned  — співбесіди, заплановані НА цей день (дата співбесіди);
 * • booked   — рядки графіка з датою призначення цього дня;
 * • done / noshow — позначки, ПОСТАВЛЕНІ цього дня (`attended_at` за Києвом), рішення 17.09;
 * • toX      — переходи статусу, зроблені цього дня (з історії, не з поточного статусу:
 *              кандидат, що потім відмовився, лишається в «на навчання» того дня).
 */
export async function dailyReport(db: Db, from: string, to: string): Promise<DailyRow[]> {
  const r = await db.query<DailyRow>(
    `WITH days AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day),
     iv AS (SELECT interview_date, assigned_on, attended, ${KYIV_DAY("attended_at")} AS mark_day
              FROM hiring_interviews WHERE deleted_at IS NULL),
     ev AS (SELECT to_status, ${KYIV_DAY("at")} AS day FROM hiring_events WHERE kind = 'status')
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM iv WHERE iv.interview_date = d.day)::int AS planned,
            (SELECT count(*) FROM iv WHERE iv.assigned_on = d.day)::int AS booked,
            (SELECT count(*) FROM iv WHERE iv.attended IS TRUE AND iv.mark_day = d.day)::int AS done,
            (SELECT count(*) FROM iv WHERE iv.attended IS FALSE AND iv.mark_day = d.day)::int AS noshow,
            (SELECT count(*) FROM ev WHERE ev.to_status = 'lead' AND ev.day = d.day)::int AS "toLead",
            (SELECT count(*) FROM ev WHERE ev.to_status = 'candidate' AND ev.day = d.day)::int AS "toCandidate",
            (SELECT count(*) FROM ev WHERE ev.to_status = 'training' AND ev.day = d.day)::int AS "toTraining",
            (SELECT count(*) FROM ev WHERE ev.to_status = 'manager' AND ev.day = d.day)::int AS "toManager",
            COALESCE(m.resumes, 0) AS resumes,
            COALESCE(m.cold_search, 0) AS "coldSearch"
       FROM days d LEFT JOIN hiring_daily_manual m ON m.day = d.day
      ORDER BY d.day`,
    [from, to],
  );
  return r.rows;
}

export async function setDailyManual(db: Db, actorId: number | null, day: unknown, p: { resumes?: unknown; coldSearch?: unknown }) {
  if (!isIsoDate(day)) throw new HiringError(400, "Некоректна дата");
  const n = (v: unknown) => (v === undefined ? undefined : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 100000 ? Number(v) : NaN);
  const res = n(p.resumes), cold = n(p.coldSearch);
  if (Number.isNaN(res) || Number.isNaN(cold)) throw new HiringError(400, "Кількість — ціле число від 0");
  if (res === undefined && cold === undefined) throw new HiringError(400, "Немає що зберігати");
  // Одним запитом і те, і те: частковий upsert не затирає друге поле (COALESCE з наявним).
  await db.query(
    `INSERT INTO hiring_daily_manual (day, resumes, cold_search, updated_by) VALUES ($1::date, COALESCE($2, 0), COALESCE($3, 0), $4)
     ON CONFLICT (day) DO UPDATE SET
       resumes = COALESCE($2, hiring_daily_manual.resumes),
       cold_search = COALESCE($3, hiring_daily_manual.cold_search),
       updated_by = $4, updated_at = now()`,
    [day, res ?? null, cold ?? null, actorId],
  );
}

/** Довідники для випадних списків: наявні значення + базовий набір із таблиці Івана. */
export async function hiringMeta(db: Db) {
  const distinct = async (col: string, table: string) =>
    (await db.query<{ v: string }>(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY 1 LIMIT 100`)).rows.map((r) => r.v);
  const merge = (base: string[], extra: string[]) => [...new Set([...base, ...extra])];
  const teams = (await db.query<{ id: number; name: string }>(`SELECT id, name FROM teams ORDER BY name`)).rows;
  return {
    sources: merge(["work.ua", "robota.ua", "Telegram-канали", "Instagram", "LinkedIn", "OLX", "рекомендація співробітника", "рекомендація колишніх", "самостійний пошук", "університет", "агенція"], await distinct("source", "hiring_candidates")),
    positions: merge(["Менеджер з продажу (РНК)", "Менеджер з продажу (РПК)", "Бухгалтер", "Менеджер по тендерах", "Юрист", "Брокер", "Менеджер з організації вантажоперевезень"], await distinct("position", "hiring_candidates")),
    responsibles: await distinct("responsible", "hiring_interviews"),
    teams,
  };
}
