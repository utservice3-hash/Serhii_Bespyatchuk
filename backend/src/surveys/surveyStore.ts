/**
 * Доступ до БД для опитувань — пакет Сергія (`server/services/surveyStore.ts`), переписаний під наших людей.
 *
 * У пакеті `users(id text, name, role 'admin'|'lead'|'manager', team text)`. У нас інакше, і тут — єдине місце,
 * де це перекладається (`PEOPLE_SQL`):
 *  - id — `users.id` INTEGER;
 *  - імʼя — менеджер CRM, далі картка співробітника, далі ПІБ ручного акаунта, далі логін;
 *  - роль — ефективна (`role_override` або `role`): `team_lead` → 'lead', `manager` → 'manager', решта — ключ ролі
 *    (hr, kvp…), щоб розріз «менеджери / тім-ліди» лишився тим самим, що в пакеті;
 *  - команда — назва команди (менеджера CRM або акаунта); `team_id` — для вибору адресатів «команда тім-ліда»;
 *  - «адмін» опитувань — право `manage_surveys` у ролі (admin, ceo, opdir, hr), а не буквально роль 'admin'.
 * Кандидати й деактивовані (акаунт або менеджер CRM) — поза будь-якою аудиторією.
 */
import type { Question, ResponseRow } from './surveyResults.js';

/** Мінімальний інтерфейс БД: і `pool`, і клієнт транзакції. */
export interface Db { query: <R = any>(text: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number | null }> }

export interface Audience { kind: 'all' | 'leads' | 'managers' | 'team' | 'custom'; team?: string; ids?: Array<number | string> }
export interface UserRow { id: number; name: string; role: string; team: string | null; team_id: number | null; is_admin: boolean }

export const PEOPLE_SQL = `
  SELECT u.id,
         COALESCE(m.name, e.full_name, u.full_name, u.email) AS name,
         CASE COALESCE(u.role_override, u.role) WHEN 'team_lead' THEN 'lead' WHEN 'manager' THEN 'manager'
              ELSE COALESCE(u.role_override, u.role) END AS role,
         t.name AS team, COALESCE(m.team_id, u.team_id) AS team_id,
         COALESCE(rl.permissions ? 'manage_surveys', false) AS is_admin
    FROM users u
    LEFT JOIN managers m ON m.id = u.manager_id
    LEFT JOIN LATERAL (SELECT full_name FROM employees e WHERE e.user_id = u.id ORDER BY e.id DESC LIMIT 1) e ON true
    LEFT JOIN teams t ON t.id = COALESCE(m.team_id, u.team_id)
    LEFT JOIN roles rl ON rl.key = COALESCE(u.role_override, u.role)
   WHERE u.is_active AND COALESCE(u.role_override, u.role) <> 'candidate' AND (m.id IS NULL OR m.is_active)`;

/** Усі, кого можна адресувати (для вибору «окремі люди» й підсумку «Отримають N»). */
export async function people(db: Db): Promise<UserRow[]> {
  return (await db.query<UserRow>(`${PEOPLE_SQL} ORDER BY 2`)).rows;
}

/** Одна людина — для знімка ролі/команди у відповіді. */
export async function person(db: Db, userId: number): Promise<UserRow | null> {
  return (await db.query<UserRow>(`${PEOPLE_SQL} AND u.id = $1`, [userId])).rows[0] ?? null;
}

/**
 * Адресати за аудиторією. Групові («усі», тім-ліди, менеджери, команда) — без тих, хто сам керує опитуваннями:
 * адмін не відповідає на власне опитування (так у пакеті). «Окремі люди» — будь-хто активний, кого обрали явно.
 */
export async function resolveAudience(db: Db, a: Audience): Promise<UserRow[]> {
  const grp = `SELECT * FROM (${PEOPLE_SQL}) p WHERE NOT p.is_admin`;
  switch (a.kind) {
    case 'all':      return (await db.query<UserRow>(grp)).rows;
    case 'leads':    return (await db.query<UserRow>(`${grp} AND p.role = 'lead'`)).rows;
    case 'managers': return (await db.query<UserRow>(`${grp} AND p.role = 'manager'`)).rows;
    case 'team':     return (await db.query<UserRow>(`${grp} AND p.team_id = $1`, [Number(a.team)])).rows;
    case 'custom': {
      const ids = (a.ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
      return (await db.query<UserRow>(`SELECT * FROM (${PEOPLE_SQL}) p WHERE p.id = ANY($1::int[])`, [ids])).rows;
    }
  }
  return [];
}

/** Хто отримує підсумки автозакриття — носії права `manage_surveys`. */
export async function surveyAdmins(db: Db): Promise<number[]> {
  return (await db.query<{ id: number }>(`SELECT id FROM (${PEOPLE_SQL}) p WHERE p.is_admin`)).rows.map((r) => Number(r.id));
}

export const QUESTION_COLS = 'id, type, text, hint, options, rows, min, max, required, image_url, series_key';

export async function loadQuestions(db: Db, surveyId: number): Promise<Question[]> {
  const q = await db.query(`SELECT ${QUESTION_COLS} FROM survey_questions WHERE survey_id=$1 ORDER BY ord`, [surveyId]);
  return q.rows.map((r: any) => ({ id: r.id, type: r.type, text: r.text, hint: r.hint || '', options: r.options, rows: r.rows, min: r.min, max: r.max, required: r.required, image: r.image_url, series_key: r.series_key }));
}

/** Відповіді з answers у вигляді {questionId: value} — формат, який їдять агрегації. */
export async function loadResponses(db: Db, surveyId: number): Promise<ResponseRow[]> {
  const q = await db.query(`SELECT r.id, r.user_id, r.role, r.team, r.submitted_at,
      coalesce(jsonb_object_agg(a.question_id, a.value) FILTER (WHERE a.question_id IS NOT NULL), '{}') AS answers
    FROM survey_responses r LEFT JOIN survey_answers a ON a.response_id = r.id
    WHERE r.survey_id=$1 GROUP BY r.id ORDER BY r.submitted_at, r.id`, [surveyId]);
  return q.rows.map((r: any) => ({ id: r.id, userId: r.user_id == null ? null : String(r.user_id), role: r.role, team: r.team, at: r.submitted_at, answers: r.answers }));
}

/** Сповіщення — власна таблиця пакета: окремої системи сповіщень у дашборді немає. */
export async function notify(db: Db, userId: number, surveyId: number, kind: 'new' | 'reminder' | 'summary', text: string) {
  await db.query(`INSERT INTO survey_notifications (user_id, survey_id, kind, text) VALUES ($1,$2,$3,$4)`, [userId, surveyId, kind, text]);
}
