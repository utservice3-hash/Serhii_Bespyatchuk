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
  refusalVerdict, messengerLinks, vacancyCloseStatus, VACANCY_STATUSES, REFUSAL_SIDES, type RefusalSide, type VacancyStatus,
} from "./hiringRules.js";
import { ensureCandidateAccount, closeCandidateAccess, undoPromotion, hasAccount } from "./hiringTraining.js";
import { ensureEmployeeFromCandidate, undoEmployeeFromCandidate } from "./employeeAdd.js";

export interface Db {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }>;
}

export class HiringError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

const KYIV_DAY = (col: string) => `(${col} AT TIME ZONE 'Europe/Kyiv')::date`;

/** Вакансії кандидата одним JSON-масивом — список і картка беруть той самий вираз. */
const VACANCIES_JSON = `(SELECT COALESCE(json_agg(json_build_object('id', v.id, 'title', v.title, 'status', v.status) ORDER BY cv.created_at, v.id), '[]'::json)
     FROM hiring_candidate_vacancies cv JOIN hiring_vacancies v ON v.id = cv.vacancy_id WHERE cv.candidate_id = c.id)`;

const CANDIDATE_COLS = `c.id, c.full_name, c.phone, c.telegram, c.email, c.source, c.position, c.status, c.team_id,
  t.name AS team_name, c.resume_url, c.comment,
  to_char(c.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS created_on,
  c.refusal_side, c.refusal_reason_id,
  (SELECT rr.label FROM hiring_refusal_reasons rr WHERE rr.id = c.refusal_reason_id) AS refusal_reason,
  c.refusal_note, to_char(c.refused_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS refused_on,
  to_char(c.reserved_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS reserved_on, c.reserve_note,
  ${VACANCIES_JSON} AS vacancies,
  (SELECT count(*)::int FROM hiring_files hf WHERE hf.candidate_id = c.id AND hf.deleted_at IS NULL) AS files_count`;

export interface ScheduleRow {
  id: number; candidate_id: number | null; responsible: string | null;
  assigned_on: string; interview_date: string; interview_time: string | null;
  attended: boolean | null; record_url: string | null; comment: string | null;
  full_name: string | null; phone: string | null; telegram: string | null; source: string | null;
  position: string | null; status: HiringStatus | null; team_id: number | null;
  vacancies: { id: number; title: string; status: VacancyStatus }[] | null; refusal_reason: string | null;
}

/** Графік за період (включно). Видалені рядки не показуються; `?deleted` — лише для «Відновити». */
export async function scheduleRows(db: Db, from: string, to: string): Promise<ScheduleRow[]> {
  const r = await db.query<ScheduleRow>(
    `SELECT i.id, i.candidate_id, i.responsible,
            to_char(i.assigned_on, 'YYYY-MM-DD') AS assigned_on,
            to_char(i.interview_date, 'YYYY-MM-DD') AS interview_date,
            to_char(i.interview_time, 'HH24:MI') AS interview_time,
            i.attended, i.record_url, i.comment,
            c.full_name, c.phone, c.telegram, c.source, c.position, c.status, c.team_id,
            CASE WHEN c.id IS NULL THEN NULL ELSE ${VACANCIES_JSON} END AS vacancies,
            (SELECT rr.label FROM hiring_refusal_reasons rr WHERE rr.id = c.refusal_reason_id) AS refusal_reason
       FROM hiring_interviews i
       LEFT JOIN hiring_candidates c ON c.id = i.candidate_id
      WHERE i.deleted_at IS NULL AND i.interview_date BETWEEN $1::date AND $2::date
      ORDER BY i.interview_date, i.interview_time NULLS LAST, i.id`,
    [from, to],
  );
  return r.rows;
}

/** Статуси, з яких призначена співбесіда переводить кандидата в «заплановано» (за ланцюжком `TRANSITIONS`). */
const TO_PLANNED: readonly HiringStatus[] = ["new", "contacted", "noanswer", "noshow", "refused"];

export interface CreatedInterview { id: number; candidateId: number | null; moved: boolean; repeat: boolean; status: HiringStatus | null }

/**
 * Нова співбесіда (рядок графіка). Три шляхи (18.09.2026, «Графік — розклад і + Співбесіда»):
 *  • порожній рядок — як і раніше, кандидата створить перше введене ПІБ чи телефон (`updateInterview`);
 *  • `candidateId` — наявний кандидат із бази: рядок привʼязується до нього, а статус зсувається в
 *    «заплановано» ЛИШЕ з ранніх етапів і повернення з відмови. Кандидат далі по ланцюжку (напр. на
 *    навчанні) лишається, де був: співбесіда фіксується, статус — ні;
 *  • `newCandidate` — ПІБ, телефон і вакансія обовʼязкові; якщо номер уже в базі — береться ІСНУЮЧИЙ
 *    (подія «повторний відгук»), дубля немає. Тримає #580/#581.
 */
export async function createInterviewFor(
  db: Db, actorId: number | null,
  p: { interviewDate: unknown; interviewTime?: unknown; responsible?: unknown; candidateId?: unknown; newCandidate?: unknown },
): Promise<CreatedInterview> {
  if (!isIsoDate(p.interviewDate)) throw new HiringError(400, "Потрібна дата співбесіди");
  const time = p.interviewTime == null || p.interviewTime === "" ? null : p.interviewTime;
  if (time != null && !isTime(time)) throw new HiringError(400, "Час у форматі ГГ:ХХ");
  const out: CreatedInterview = { id: 0, candidateId: null, moved: false, repeat: false, status: null };
  let cand: { id: number; full_name: string; status: HiringStatus } | null = null;
  if (p.candidateId != null && p.candidateId !== "") {
    const cid = posInt(p.candidateId, "id кандидата");
    cand = (await db.query<{ id: number; full_name: string; status: HiringStatus }>(
      `SELECT id, full_name, status FROM hiring_candidates WHERE id = $1 FOR UPDATE`, [cid])).rows[0] ?? null;
    if (!cand) throw new HiringError(404, "Кандидата не знайдено");
  } else if (p.newCandidate && typeof p.newCandidate === "object") {
    const n = p.newCandidate as Record<string, unknown>;
    const fullName = str(n.fullName), norm = normalizePhone(n.phone);
    if (!fullName) throw new HiringError(400, "Вкажіть ПІБ кандидата");
    if (!norm) throw new HiringError(400, "Вкажіть телефон кандидата");
    if (n.vacancyId == null || n.vacancyId === "") throw new HiringError(400, "Оберіть вакансію");
    const existing = await byPhone(db, norm);
    if (existing) { cand = existing; out.repeat = true; }
    else {
      const ins = await db.query<{ id: number }>(
        `INSERT INTO hiring_candidates (full_name, phone, phone_norm, telegram, source, status, created_by)
         VALUES ($1, $2, $3, $4, $5, 'planned', $6) RETURNING id`,
        [fullName, str(n.phone), norm, str(n.telegram), str(n.source), actorId]);
      cand = { id: ins.rows[0].id, full_name: fullName, status: "planned" };
      await logEvent(db, { candidateId: cand.id, kind: "created", to: "planned", comment: "створено з графіка («+ Співбесіда»)", actorId });
    }
    await linkVacancy(db, actorId, cand.id, n.vacancyId);
  }
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_interviews (interview_date, interview_time, responsible, candidate_id, created_by)
     VALUES ($1::date, $2::time, $3, $4, $5) RETURNING id`,
    [p.interviewDate, time, typeof p.responsible === "string" && p.responsible.trim() ? p.responsible.trim() : null, cand?.id ?? null, actorId],
  );
  out.id = r.rows[0].id;
  if (cand) {
    out.candidateId = cand.id;
    const when = `${String(p.interviewDate).slice(8, 10)}.${String(p.interviewDate).slice(5, 7)}${time ? ` ${time}` : ""}`;
    if (out.repeat) await logEvent(db, { candidateId: cand.id, interviewId: out.id, kind: "repeat", comment: `повторний запис у графік за тим самим номером · ${when}`, actorId });
    if (TO_PLANNED.includes(cand.status) && cand.status !== "planned") {
      await setStatus(db, actorId, cand.id, cand.status, "planned", `призначено співбесіду ${when}`, out.id);
      out.moved = true; out.status = "planned";
    } else {
      out.status = cand.status;
      if (!out.repeat) await logEvent(db, { candidateId: cand.id, interviewId: out.id, kind: "edit", comment: `призначено співбесіду ${when}`, actorId });
    }
  }
  return out;
}

/** Порожній рядок графіка (як до 18.09.2026) — номер рядка. */
export async function createInterview(db: Db, actorId: number | null, p: { interviewDate: unknown; interviewTime?: unknown; responsible?: unknown }): Promise<number> {
  return (await createInterviewFor(db, actorId, { interviewDate: p.interviewDate, interviewTime: p.interviewTime, responsible: p.responsible })).id;
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
  fullName: "full_name", phone: "phone", telegram: "telegram", email: "email", source: "source", position: "position",
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
    } else if (k === "email") {
      v = str(patch[k]);
      if (v !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v as string)) throw new HiringError(400, "Пошта у форматі name@gmail.com");
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

  const candPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => k in CAND_FIELDS && k !== "comment" && k !== "resumeUrl" && k !== "email"));
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

  if ("vacancyId" in patch && patch.vacancyId != null && patch.vacancyId !== "") {
    if (!candidateId) throw new HiringError(400, "Спершу введіть ПІБ або телефон кандидата");
    await linkVacancy(db, actorId, candidateId, patch.vacancyId);
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
        if (a === true && st && ["new", "contacted", "planned", "noshow", "noanswer"].includes(st))
          await setStatus(db, actorId, candidateId, st, "done", "позначка «прийшов» у графіку", id);
        if (a === false && st && ["new", "contacted", "planned"].includes(st))
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

export interface CandidateFilters {
  q?: string; status?: string; source?: string; position?: string; teamId?: number | null; limit?: number; offset?: number;
  vacancyId?: number | null; reserve?: "yes" | "no" | null; refusalSide?: string | null; noVacancy?: boolean;
}

export async function listCandidates(db: Db, f: CandidateFilters, access: HiringAccess, leadTeamId: number | null) {
  const where: string[] = []; const params: unknown[] = [];
  if (access === "lead") { params.push(leadTeamId ?? -1); where.push(LEAD_VISIBLE_SQL(`$${params.length}`)); }
  else if (access !== "edit") where.push("false");
  if (f.q) {
    params.push(`%${f.q.toLowerCase()}%`);
    const digits = f.q.replace(/\D/g, "");
    let cond = `(lower(c.full_name) LIKE $${params.length} OR lower(COALESCE(c.telegram,'')) LIKE $${params.length} OR lower(COALESCE(c.email,'')) LIKE $${params.length}`;
    if (digits.length >= 4) { params.push(`%${digits}%`); cond += ` OR c.phone_norm LIKE $${params.length}`; }
    where.push(cond + ")");
  }
  if (f.status && isHiringStatus(f.status)) { params.push(f.status); where.push(`c.status = $${params.length}`); }
  if (f.source) { params.push(f.source); where.push(`c.source = $${params.length}`); }
  if (f.position) { params.push(f.position); where.push(`c.position = $${params.length}`); }
  if (f.teamId) { params.push(f.teamId); where.push(`c.team_id = $${params.length}`); }
  // Лічильники шапки — над ВИДИМИМ набором без фільтрів користувача (межа тімліда та сама).
  const visWhere = where.length ? where[0] : "true";
  const visParams = access === "lead" ? [params[0]] : [];
  const heads = (await db.query<{ no_vacancy: number; in_reserve: number }>(
    `SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM hiring_candidate_vacancies cv WHERE cv.candidate_id = c.id))::int AS no_vacancy,
            count(*) FILTER (WHERE c.reserved_at IS NOT NULL)::int AS in_reserve
       FROM hiring_candidates c WHERE ${access === "lead" || access !== "edit" ? visWhere : "true"}`, visParams)).rows[0];
  if (f.vacancyId) { params.push(f.vacancyId); where.push(`EXISTS (SELECT 1 FROM hiring_candidate_vacancies cv WHERE cv.candidate_id = c.id AND cv.vacancy_id = $${params.length})`); }
  if (f.noVacancy) where.push(`NOT EXISTS (SELECT 1 FROM hiring_candidate_vacancies cv WHERE cv.candidate_id = c.id)`);
  if (f.reserve === "yes") where.push(`c.reserved_at IS NOT NULL`);
  if (f.reserve === "no") where.push(`c.reserved_at IS NULL`);
  if (f.refusalSide && (REFUSAL_SIDES as readonly string[]).includes(f.refusalSide)) {
    params.push(f.refusalSide); where.push(`c.status IN ('refused','black') AND c.refusal_side = $${params.length}`);
  }
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
  return { total, rows, noVacancy: heads.no_vacancy, inReserve: heads.in_reserve };
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
  const files = (await db.query(
    `SELECT f.id, f.name, f.mime, f.size_bytes, to_char(f.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD HH24:MI') AS created,
            COALESCE(u.full_name, m.name, u.email) AS author
       FROM hiring_files f LEFT JOIN users u ON u.id = f.created_by LEFT JOIN managers m ON m.id = u.manager_id
      WHERE f.candidate_id = $1 AND f.deleted_at IS NULL ORDER BY f.created_at DESC, f.id DESC`, [id])).rows;
  const cc = c as { phone: string | null; telegram: string | null };
  return { candidate: c, interviews, events, lastFrom, files, messengers: messengerLinks(cc.phone, cc.telegram) };
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
  const vacancyIds = Array.isArray(p.vacancyIds) ? p.vacancyIds : p.vacancyId != null && p.vacancyId !== "" ? [p.vacancyId] : [];
  if (!vacancyIds.length) throw new HiringError(400, "Оберіть вакансію — без неї кандидат не потрапить у лічильник вакансії");
  const status = p.status === "contacted" ? "contacted" : "new";
  const email = str(p.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HiringError(400, "Пошта у форматі name@gmail.com");
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_candidates (full_name, phone, phone_norm, telegram, email, source, position, resume_url, comment, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [name, str(p.phone), norm, str(p.telegram), email, str(p.source), str(p.position), resume, str(p.comment), status, actorId],
  );
  await logEvent(db, { candidateId: r.rows[0].id, kind: "created", to: status, comment: "додано в базу", actorId });
  for (const v of vacancyIds) await linkVacancy(db, actorId, r.rows[0].id, v);
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
  // Акаунт кандидата (прохід 2a): «менеджер» міняє роль акаунта, тож веде туди лише дія з умовою навчання.
  if (p.to === "manager" && await hasAccount(db, id))
    throw new HiringError(409, "У кандидата є акаунт навчання — «Перевести в менеджери» на вкладці «На навчанні»");
  // Повернення з відмови знімає поточну відмову з картки; причина лишається в історії.
  const leavingRefusal = (c.status === "refused" || c.status === "black") && p.to !== "refused" && p.to !== "black";
  await db.query(
    `UPDATE hiring_candidates SET status = $1, team_id = $2, updated_at = now()
       ${leavingRefusal ? ", refusal_side = NULL, refusal_reason_id = NULL, refusal_note = NULL, refused_at = NULL" : ""}
     WHERE id = $3`, [p.to, teamId, id]);
  await logEvent(db, { candidateId: id, kind: "status", from: c.status, to: p.to, comment, actorId });
  if (p.to === "candidate") await ensureCandidateAccount(db, actorId, id);
  if (c.status === "manager") await undoPromotion(db, id, actorId);
  // 👤 «Менеджер» = людина в реєстрі співробітників (22.09.2026); повернення прибирає лише щойно створений запис (#647).
  if (p.to === "manager") await ensureEmployeeFromCandidate(db, actorId, id);
  if (c.status === "manager") await undoEmployeeFromCandidate(db, actorId, id);
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
    vacancies: (await db.query(`SELECT id, title, status FROM hiring_vacancies ORDER BY status IN ('closed','cancelled'), title`)).rows,
    refusalReasons: (await db.query(`SELECT id, side, label FROM hiring_refusal_reasons WHERE is_active ORDER BY side, sort, label`)).rows,
  };
}

/* ═════════ ПРОХІД 1a: вакансії, відмова з причиною, резерв, файли ═════════ */

/** Видимість картки для запису: та сама межа, що й для читання (тімлід — свої після етапу «з тімлідом»). */
async function lockCandidate(db: Db, id: number, access: HiringAccess, leadTeamId: number | null) {
  const params: unknown[] = [id];
  let vis = "";
  if (access === "lead") { params.push(leadTeamId ?? -1); vis = ` AND ${LEAD_VISIBLE_SQL("$2")}`; }
  else if (access !== "edit") vis = " AND false";
  const c = (await db.query<{ id: number; status: HiringStatus; team_id: number | null; reserved_at: string | null }>(
    `SELECT c.id, c.status, c.team_id, c.reserved_at FROM hiring_candidates c WHERE c.id = $1${vis} FOR UPDATE`, params)).rows[0];
  if (!c) throw new HiringError(404, "Кандидата не знайдено");
  return c;
}

const posInt = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HiringError(400, `Некоректний ${what}`);
  return n;
};

/** Список вакансій з кількістю РІЗНИХ кандидатів у повʼязках (#523). */
export async function listVacancies(db: Db, scope: "active" | "closed" | "all") {
  const w = scope === "active" ? "WHERE v.status NOT IN ('closed','cancelled')" : scope === "closed" ? "WHERE v.status IN ('closed','cancelled')" : "";
  return (await db.query(
    `SELECT v.id, v.title, v.position, v.opened_by, v.responsible, v.need, v.status, v.close_result, v.comment,
            to_char(v.opened_on, 'YYYY-MM-DD') AS opened_on, to_char(v.closed_on, 'YYYY-MM-DD') AS closed_on,
            (SELECT count(DISTINCT cv.candidate_id)::int FROM hiring_candidate_vacancies cv WHERE cv.vacancy_id = v.id) AS candidates,
            ((COALESCE(v.closed_on, (now() AT TIME ZONE 'Europe/Kyiv')::date) - v.opened_on))::int AS days_open
       FROM hiring_vacancies v ${w}
      ORDER BY v.status IN ('closed','cancelled'), v.opened_on, v.id`)).rows;
}

export async function createVacancy(db: Db, actorId: number | null, p: Record<string, unknown>): Promise<number> {
  const title = str(p.title);
  if (!title) throw new HiringError(400, "Потрібна назва вакансії");
  const need = p.need == null || p.need === "" ? 1 : Number(p.need);
  if (!Number.isInteger(need) || need < 0 || need > 1000) throw new HiringError(400, "Скільки людей — ціле число від 0");
  const status = p.status == null || p.status === "" ? "open" : p.status;
  if (!["open", "in_work", "paused"].includes(status as string)) throw new HiringError(400, "Нова вакансія — відкрита, в роботі або на паузі");
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_vacancies (title, position, opened_by, responsible, need, status, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [title, str(p.position), str(p.openedBy), str(p.responsible), need, status, str(p.comment), actorId]);
  return r.rows[0].id;
}

/**
 * Зміна вакансії. Закриття (`closed` / `cancelled`) — лише з результатом, і статус визначає
 * результат, а не клієнт (#523). Повернення в роботу знімає результат і дату закриття.
 */
export async function updateVacancy(db: Db, id: number, p: Record<string, unknown>): Promise<void> {
  const cur = (await db.query<{ status: VacancyStatus }>(`SELECT status FROM hiring_vacancies WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new HiringError(404, "Вакансію не знайдено");
  const sets: string[] = []; const params: unknown[] = [];
  const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if ("title" in p) { const t = str(p.title); if (!t) throw new HiringError(400, "Потрібна назва вакансії"); put("title", t); }
  if ("responsible" in p) put("responsible", str(p.responsible));
  if ("comment" in p) put("comment", str(p.comment));
  if ("need" in p) {
    const n = Number(p.need);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HiringError(400, "Скільки людей — ціле число від 0");
    put("need", n);
  }
  if ("closeResult" in p) {
    const st = vacancyCloseStatus(p.closeResult);
    if (!st) throw new HiringError(400, "Оберіть результат закриття");
    const day = p.closedOn == null || p.closedOn === "" ? null : p.closedOn;
    if (day != null && !isIsoDate(day)) throw new HiringError(400, "Некоректна дата закриття");
    put("status", st); put("close_result", p.closeResult);
    params.push(day); sets.push(`closed_on = COALESCE($${params.length}::date, (now() AT TIME ZONE 'Europe/Kyiv')::date)`);
  } else if ("status" in p) {
    if (!(VACANCY_STATUSES as readonly string[]).includes(p.status as string)) throw new HiringError(400, "Невідомий статус вакансії");
    if (p.status === "closed" || p.status === "cancelled") throw new HiringError(400, "Закриття — з результатом, через «Закрити»");
    put("status", p.status);
    if (cur.status === "closed" || cur.status === "cancelled") sets.push("close_result = NULL", "closed_on = NULL");
  }
  if (!sets.length) return;
  params.push(id);
  await db.query(`UPDATE hiring_vacancies SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
}

async function linkVacancy(db: Db, actorId: number | null, candidateId: number, vacancyId: unknown) {
  const vid = posInt(vacancyId, "id вакансії");
  const v = (await db.query<{ title: string; status: VacancyStatus }>(`SELECT title, status FROM hiring_vacancies WHERE id = $1`, [vid])).rows[0];
  if (!v) throw new HiringError(404, "Вакансію не знайдено");
  const r = await db.query(
    `INSERT INTO hiring_candidate_vacancies (candidate_id, vacancy_id, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [candidateId, vid, actorId]);
  if (r.rowCount) await logEvent(db, { candidateId, kind: "vacancy", comment: `додано вакансію «${v.title}»`, actorId });
}

/** Повний набір вакансій кандидата: додає відсутні, прибирає зайві, кожну зміну пише в історію. */
export async function setCandidateVacancies(db: Db, actorId: number | null, id: number, vacancyIds: unknown): Promise<void> {
  if (!Array.isArray(vacancyIds)) throw new HiringError(400, "Очікується список вакансій");
  await lockCandidate(db, id, "edit", null);
  const want = [...new Set(vacancyIds.map((v) => posInt(v, "id вакансії")))];
  const have = (await db.query<{ vacancy_id: number; title: string }>(
    `SELECT cv.vacancy_id, v.title FROM hiring_candidate_vacancies cv JOIN hiring_vacancies v ON v.id = cv.vacancy_id WHERE cv.candidate_id = $1`, [id])).rows;
  for (const h of have) if (!want.includes(h.vacancy_id)) {
    await db.query(`DELETE FROM hiring_candidate_vacancies WHERE candidate_id = $1 AND vacancy_id = $2`, [id, h.vacancy_id]);
    await logEvent(db, { candidateId: id, kind: "vacancy", comment: `прибрано вакансію «${h.title}»`, actorId });
  }
  for (const v of want) if (!have.some((h) => h.vacancy_id === v)) await linkVacancy(db, actorId, id, v);
}

export async function addRefusalReason(db: Db, actorId: number | null, p: Record<string, unknown>): Promise<number> {
  if (!(REFUSAL_SIDES as readonly string[]).includes(p.side as string)) throw new HiringError(400, "Сторона відмови — кандидат або компанія");
  const label = str(p.label);
  if (!label) throw new HiringError(400, "Потрібна назва причини");
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_refusal_reasons (side, label, created_by) VALUES ($1,$2,$3) ON CONFLICT (side, lower(label)) DO NOTHING RETURNING id`,
    [p.side, label, actorId]);
  if (!r.rows[0]) throw new HiringError(409, "Така причина вже є");
  return r.rows[0].id;
}

/**
 * Відмова як дія (#520). Причина обовʼязкова й задає сторону; «чорний список» — лише відмова компанії;
 * «Додати в резерв» ставиться тією самою транзакцією.
 */
export async function refuseCandidate(
  db: Db, actorId: number | null, id: number,
  p: { reasonId?: unknown; note?: unknown; reserve?: unknown; blacklist?: unknown },
  access: HiringAccess, leadTeamId: number | null,
): Promise<void> {
  const c = await lockCandidate(db, id, access, leadTeamId);
  let reason: { id: number; side: RefusalSide; label: string } | undefined;
  if (p.reasonId != null && p.reasonId !== "") {
    reason = (await db.query<{ id: number; side: RefusalSide; label: string }>(
      `SELECT id, side, label FROM hiring_refusal_reasons WHERE id = $1 AND is_active`, [posInt(p.reasonId, "id причини")])).rows[0];
    if (!reason) throw new HiringError(400, "Такої причини немає в довіднику");
  }
  const blacklist = p.blacklist === true;
  const v = refusalVerdict({ from: c.status, access, reasonSide: reason?.side ?? null, blacklist });
  if (!v.ok) throw new HiringError(reason ? 403 : 400, v.reason);
  const note = str(p.note);
  const reserve = p.reserve === true;
  if (reserve && access !== "edit") throw new HiringError(403, "Резерв веде рекрутер");
  await db.query(
    `UPDATE hiring_candidates SET status = $1, refusal_side = $2, refusal_reason_id = $3, refusal_note = $4, refused_at = now(),
            ${reserve ? "reserved_at = COALESCE(reserved_at, now()), reserve_note = COALESCE($5, reserve_note)," : ""} updated_at = now()
      WHERE id = $${reserve ? 6 : 5}`,
    reserve ? [v.status, reason!.side, reason!.id, note, note, id] : [v.status, reason!.side, reason!.id, note, id]);
  await logEvent(db, { candidateId: id, kind: "status", from: c.status, to: v.status,
    comment: `${reason!.side === "company" ? "відмова компанії" : "відмова кандидата"} · ${reason!.label}${note ? ` · ${note}` : ""}${blacklist ? " · чорний список" : ""}`, actorId });
  if (reserve && !c.reserved_at) await logEvent(db, { candidateId: id, kind: "reserve", comment: "додано в резерв", actorId });
  await closeCandidateAccess(db, id, "refused", actorId); // є акаунт навчання — доступ закривається тією самою транзакцією
}

/** Резерв: увімкнути з нотаткою або прибрати. Пара повертає рядок до байта, крім `updated_at` (#524). */
export async function setReserve(db: Db, actorId: number | null, id: number, p: { on?: unknown; note?: unknown }): Promise<void> {
  const c = await lockCandidate(db, id, "edit", null);
  if (p.on === true) {
    if (c.reserved_at) throw new HiringError(409, "Кандидат уже в резерві");
    await db.query(`UPDATE hiring_candidates SET reserved_at = now(), reserve_note = $1 WHERE id = $2`, [str(p.note), id]);
    await logEvent(db, { candidateId: id, kind: "reserve", comment: `додано в резерв${str(p.note) ? ` · ${str(p.note)}` : ""}`, actorId });
  } else if (p.on === false) {
    if (!c.reserved_at) throw new HiringError(409, "Кандидата немає в резерві");
    await db.query(`UPDATE hiring_candidates SET reserved_at = NULL, reserve_note = NULL WHERE id = $1`, [id]);
    await logEvent(db, { candidateId: id, kind: "reserve", comment: "прибрано з резерву", actorId });
  } else throw new HiringError(400, "Очікується on: true або false");
}

/** Метадані файлу (байти пише роут у теку під бекапом). Ліміти перевіряє роут до запису на диск. */
export async function insertFile(db: Db, actorId: number | null, candidateId: number, f: { name: string; storedName: string; mime: string; size: number }) {
  await lockCandidate(db, candidateId, "edit", null);
  const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM hiring_files WHERE candidate_id = $1 AND deleted_at IS NULL`, [candidateId])).rows[0].n;
  if (n >= 20) throw new HiringError(409, "У картці вже 20 файлів — видаліть зайві");
  const r = await db.query<{ id: number }>(
    `INSERT INTO hiring_files (candidate_id, name, stored_name, mime, size_bytes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [candidateId, f.name, f.storedName, f.mime, f.size, actorId]);
  await logEvent(db, { candidateId, kind: "file", comment: `додано файл «${f.name}»`, actorId });
  return r.rows[0].id;
}

/** Файл для видачі: лише невидалений і лише з видимої картки. */
export async function fileForDownload(db: Db, candidateId: number, fileId: number, access: HiringAccess, leadTeamId: number | null) {
  await candidateCard(db, candidateId, access, leadTeamId);
  const f = (await db.query<{ name: string; stored_name: string; mime: string }>(
    `SELECT name, stored_name, mime FROM hiring_files WHERE id = $1 AND candidate_id = $2 AND deleted_at IS NULL`, [fileId, candidateId])).rows[0];
  if (!f) throw new HiringError(404, "Файл не знайдено");
  return f;
}

export async function setFileDeleted(db: Db, actorId: number | null, candidateId: number, fileId: number, deleted: boolean) {
  await lockCandidate(db, candidateId, "edit", null);
  const r = await db.query<{ name: string }>(
    deleted
      ? `UPDATE hiring_files SET deleted_at = now(), deleted_by = $3 WHERE id = $1 AND candidate_id = $2 AND deleted_at IS NULL RETURNING name`
      : `UPDATE hiring_files SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND candidate_id = $2 AND deleted_at IS NOT NULL RETURNING name`,
    deleted ? [fileId, candidateId, actorId] : [fileId, candidateId]);
  if (!r.rows[0]) throw new HiringError(404, deleted ? "Файл не знайдено або вже видалено" : "Видаленого файлу не знайдено");
  await logEvent(db, { candidateId, kind: "file", comment: `${deleted ? "видалено" : "відновлено"} файл «${r.rows[0].name}»`, actorId });
}
