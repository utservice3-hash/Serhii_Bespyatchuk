/**
 * 💼 WORK.UA — ЗАПИС ВІДГУКІВ У «КАНДИДАТИ» (28.09.2026). Розбір і межі запитів — `core/workua.ts`.
 *
 * Правила:
 *  • той самий відгук удруге — нічого (памʼять `workua_responses`);
 *  • той самий ТЕЛЕФОН, що вже є в базі (Іван вносив руками, або людина відгукувалась раніше) — НЕ новий кандидат:
 *    подія «повторний відгук з work.ua» у наявній картці; статус, коментарі й історію Івана не чіпаємо;
 *  • новий телефон — кандидат «новий», джерело «work.ua», вакансія — якщо вакансію work.ua привʼязано;
 *  • відгук без телефону — новий кандидат (дублю за телефоном тут не буває), ПІБ приховане — так і пишемо.
 *  • файл резюме — у «Файли» картки, лише PDF/зображення до 5 МБ (той самий білий список, що в ручного
 *    завантаження); DOC/DOCX не зберігаємо, а кажемо про це в історії — невідоме лишається видимим.
 * Тримають #804–#807.
 */
import type { Db } from "./secrets.js";
import { normalizePhone, sniffFileMime, HIRING_FILE_MAX_BYTES, type HIRING_FILE_MIMES } from "./hiringRules.js";
import { responseComment, type WorkuaResponse } from "./workua.js";

export class WorkuaError extends Error { constructor(public status: number, message: string) { super(message); } }

export type FileStore = (buf: Buffer, mime: (typeof HIRING_FILE_MIMES)[number]) => Promise<string>;
export type FileFetch = (r: WorkuaResponse) => Promise<Buffer | null>;

const event = (db: Db, candidateId: number, kind: string, comment: string, to: string | null = null) =>
  db.query(`INSERT INTO hiring_events (candidate_id, kind, to_status, comment, actor_id) VALUES ($1, $2, $3, $4, NULL)`, [candidateId, kind, to, comment]);

/** Записати відгуки (від старих до нових). Повертає лічильники; повторний виклик на тих самих — нулі. */
export async function absorbResponses(db: Db, responses: WorkuaResponse[], files?: { fetch: FileFetch; store: FileStore }) {
  const out = { seen: responses.length, created: 0, repeat: 0, skipped: 0, files: 0 };
  const ids = responses.map((r) => r.id);
  const done = new Set((await db.query<{ id: string }>(`SELECT id::text AS id FROM workua_responses WHERE id = ANY($1::bigint[])`, [ids])).rows.map((r) => Number(r.id)));
  const vacByJob = new Map((await db.query<{ id: number; job: string; title: string }>(
    `SELECT id, workua_job_id::text AS job, title FROM hiring_vacancies WHERE workua_job_id IS NOT NULL`)).rows.map((v) => [Number(v.job), v]));
  for (const r of [...responses].sort((a, b) => a.id - b.id)) {
    if (done.has(r.id)) { out.skipped++; continue; }
    const vac = r.jobId != null ? vacByJob.get(r.jobId) ?? null : null;
    const norm = normalizePhone(r.phone);
    const same = norm ? (await db.query<{ id: number }>(`SELECT id FROM hiring_candidates WHERE phone_norm = $1 LIMIT 1`, [norm])).rows[0] : undefined;
    let candidateId: number, how: "created" | "repeat";
    if (same) {
      candidateId = same.id; how = "repeat"; out.repeat++;
      await event(db, candidateId, "repeat", `повторний відгук з work.ua${vac ? ` на «${vac.title}»` : ""}`);
    } else {
      const email = r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email) ? r.email : null;
      candidateId = (await db.query<{ id: number }>(
        `INSERT INTO hiring_candidates (full_name, phone, phone_norm, email, source, comment, status, created_by)
         VALUES ($1, $2, $3, $4, 'work.ua', $5, 'new', NULL) RETURNING id`,
        [r.fio ?? "ПІБ приховано кандидатом (work.ua)", r.phone, norm, email, responseComment(r)])).rows[0].id;
      how = "created"; out.created++;
      await event(db, candidateId, "created", `відгук з work.ua${vac ? ` на «${vac.title}»` : " (вакансію work.ua не привʼязано)"}`, "new");
    }
    if (vac) {
      const l = await db.query(`INSERT INTO hiring_candidate_vacancies (candidate_id, vacancy_id, created_by) VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING`, [candidateId, vac.id]);
      if (l.rowCount) await event(db, candidateId, "vacancy", `додано вакансію «${vac.title}» (з work.ua)`);
    }
    let fileNote: string | null = null;
    if (r.withFile && files) {
      const buf = await files.fetch(r).catch(() => null);
      const mime = buf ? sniffFileMime(buf) : null;
      if (!buf) fileNote = "файл не вдалося забрати";
      else if (!mime) fileNote = "файл не PDF і не зображення (напр. DOC) — відкрийте відгук на work.ua";
      else if (buf.length > HIRING_FILE_MAX_BYTES) fileNote = "файл більший за 5 МБ — відкрийте відгук на work.ua";
      else {
        const stored = await files.store(buf, mime);
        const name = `Резюме work.ua${r.fio ? ` — ${r.fio}` : ""}${mime === "application/pdf" ? ".pdf" : ""}`;
        await db.query(`INSERT INTO hiring_files (candidate_id, name, stored_name, mime, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, NULL)`,
          [candidateId, name, stored, mime, buf.length]);
        await event(db, candidateId, "file", `додано резюме з work.ua`);
        out.files++;
      }
      if (fileNote) await event(db, candidateId, "comment", `резюме з work.ua: ${fileNote}`);
    }
    await db.query(
      `INSERT INTO workua_responses (id, job_id, candidate_id, vacancy_id, responded_at, how, file_note) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [r.id, r.jobId, candidateId, vac?.id ?? null, r.date, how, fileNote]);
  }
  return out;
}

/** Найбільший оброблений id — звідки продовжувати; null — ще нічого не брали (тоді беремо 14 днів). */
export async function lastResponseId(db: Db): Promise<number | null> {
  const v = (await db.query<{ m: string | null }>(`SELECT max(id)::text AS m FROM workua_responses`)).rows[0]?.m;
  return v ? Number(v) : null;
}

/**
 * Привʼязати нашу вакансію до вакансії work.ua (null — відвʼязати). Одна вакансія work.ua — одна наша.
 *
 * 💼 ДОЗАПОВНЕННЯ (28.09.2026): відгуки, що прийшли ДО привʼязки, лягли «без вакансії» (перший забір — 91 відгук,
 * жодна вакансія ще не була привʼязана). Номер вакансії work.ua в кожного збережено (`workua_responses.job_id`),
 * тож при привʼязці ставимо вакансію їхнім кандидатам — але ЛИШЕ тим, у кого вакансії немає жодної: картку, якій
 * Іван уже поставив вакансію руками, не чіпаємо (`kept`). Відвʼязка вже поставлених вакансій не знімає. Тримає #808.
 */
export async function setVacancyWorkuaJob(db: Db, vacancyId: number, jobId: number | null) {
  if (jobId != null) {
    const other = (await db.query<{ id: number; title: string }>(`SELECT id, title FROM hiring_vacancies WHERE workua_job_id = $1 AND id <> $2`, [jobId, vacancyId])).rows[0];
    if (other) throw new WorkuaError(409, `Ця вакансія work.ua вже привʼязана до «${other.title}»`);
  }
  const v = (await db.query<{ title: string }>(`UPDATE hiring_vacancies SET workua_job_id = $2, updated_at = now() WHERE id = $1 RETURNING title`, [vacancyId, jobId])).rows[0];
  if (!v) throw new WorkuaError(404, "Вакансію не знайдено");
  const out = { attached: 0, kept: 0 };
  if (jobId == null) return out;
  const waiting = (await db.query<{ candidate_id: number; has_vac: boolean }>(
    `SELECT DISTINCT r.candidate_id, EXISTS (SELECT 1 FROM hiring_candidate_vacancies cv WHERE cv.candidate_id = r.candidate_id) AS has_vac
       FROM workua_responses r WHERE r.job_id = $1 AND r.vacancy_id IS NULL AND r.candidate_id IS NOT NULL`, [jobId])).rows;
  for (const w of waiting) {
    if (w.has_vac) { out.kept++; continue; }
    await db.query(`INSERT INTO hiring_candidate_vacancies (candidate_id, vacancy_id, created_by) VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING`, [w.candidate_id, vacancyId]);
    await event(db, w.candidate_id, "vacancy", `додано вакансію «${v.title}» (відгук з work.ua до привʼязки)`);
    out.attached++;
  }
  // Відгуки цієї вакансії work.ua більше не «без вакансії» — і для тих карток, що вже мали свою.
  await db.query(`UPDATE workua_responses SET vacancy_id = $2 WHERE job_id = $1 AND vacancy_id IS NULL`, [jobId, vacancyId]);
  return out;
}

/** Що показати в «Вакансіях»: скільки забрано, скільки лягло без вакансії, привʼязки. */
export async function workuaSummary(db: Db) {
  const c = (await db.query<{ total: number; created: number; repeat: number; novac: number; last: string | null }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE how = 'created')::int AS created, count(*) FILTER (WHERE how = 'repeat')::int AS repeat,
            count(*) FILTER (WHERE vacancy_id IS NULL)::int AS novac, max(responded_at)::text AS last FROM workua_responses`)).rows[0];
  const links = (await db.query<{ vacancy_id: number; job_id: string }>(
    `SELECT id AS vacancy_id, workua_job_id::text AS job_id FROM hiring_vacancies WHERE workua_job_id IS NOT NULL`)).rows;
  return { ...c, links: links.map((l) => ({ vacancyId: l.vacancy_id, jobId: Number(l.job_id) })) };
}
