/**
 * Планувальник: одна функція tickSurveys(pool, now), яку викликає cron кожні 5 хвилин
 * (node-cron / systemd timer / Vercel cron — що є в дашборді). Ідемпотентна: повторний
 * виклик нічого не дублює (remind_sent, статуси).
 *
 * Робить три речі — рівно те, що в макеті симулює sweep():
 *  1) закриває активні опитування з минулим дедлайном (closed_by='auto') і шле адмінам підсумок;
 *     для повторюваних — створює наступний випуск зі статусом 'scheduled' і launch_at за розкладом;
 *  2) запускає 'scheduled' випуски, коли настав launch_at (адресати з audience, сповіщення «нове»);
 *  3) нагадування: «за N днів до дедлайну о HH:MM» і «в день дедлайну о HH:MM» тим, хто не відповів.
 *
 * Логіка обчислення моментів винесена в чисті функції (тестуються без БД).
 *
 * 🔧 Дашборд (30.09.2026): `Pool` → наш `Db`; id людей — числа; підсумки отримують носії права `manage_surveys`
 * (`surveyAdmins`), а не роль 'admin'. Кличе джоба `tickSurveys` раз на 5 хв (`index.ts`, :03/:08/…).
 */
import { closeSummary, type Question, type ResponseRow } from './surveyResults.js';
import { loadResponses, loadQuestions, resolveAudience, notify, surveyAdmins, type Db } from './surveyStore.js';

export interface Remind { on: boolean; days: number; time: string; dayOf: boolean }
export interface Recur { on: boolean; per?: 'week' | '2week' | 'month'; day?: number; time?: string; days?: number }

const atTime = (d: Date, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x; };

/** Моменти нагадувань для дедлайну: before = due − days днів о time; dayOf = у день дедлайну о time (лише якщо раніше за due). */
export function reminderMoments(due: Date, r: Remind): { before: Date | null; dayOf: Date | null } {
  if (!r.on) return { before: null, dayOf: null };
  const before = new Date(due); before.setDate(before.getDate() - (r.days || 1));
  const b = atTime(before, r.time || '10:00');
  const d = r.dayOf ? atTime(due, r.time || '10:00') : null;
  return { before: b < due ? b : null, dayOf: d && d < due && (!b || d > b) ? d : null };
}

/** Наступний запуск серії після closedAt: найближчий день тижня day (1=пн…5=пт) о time; для 2week/month — відповідно далі. */
export function nextLaunch(closedAt: Date, rc: Recur): Date {
  const day = rc.day || 1, time = rc.time || '09:00';
  const d = new Date(closedAt); d.setDate(d.getDate() + 1);
  while (d.getDay() !== day) d.setDate(d.getDate() + 1);           // getDay: 1..5 = пн..пт
  if (rc.per === '2week') d.setDate(d.getDate() + 7);
  if (rc.per === 'month') { d.setMonth(d.getMonth() + 1); while (d.getDay() !== day) d.setDate(d.getDate() - 1); }
  return atTime(d, time);
}

export async function tickSurveys(pool: Db, now = new Date()): Promise<{ closed: number; launched: number; reminded: number }> {
  let closed = 0, launched = 0, reminded = 0;
  const admins = await surveyAdmins(pool);

  /* 1) автозакриття */
  const due = await pool.query<any>(`UPDATE surveys SET status='closed', closed_at=$1, closed_by='auto'
     WHERE status='active' AND due <= $1 RETURNING ${SURVEY_COLS}`, [now]);
  for (const s of due.rows) {
    closed++;
    const qs = await loadQuestions(pool, s.id);
    const rs = await loadResponses(pool, s.id);
    const cnt = await pool.query<any>(`SELECT count(*)::int AS n, count(responded_at)::int AS r FROM survey_assignments WHERE survey_id=$1`, [s.id]);
    const text = closeSummary(s.title, qs, rs, cnt.rows[0].n, cnt.rows[0].r);
    for (const a of admins) await notify(pool, a, s.id, 'summary', text);
    if (s.recur && s.recur.on) await spawnNextIssue(pool, s, qs, now);
  }

  /* 2) запуск запланованих випусків */
  const sched = await pool.query<any>(`SELECT ${SURVEY_COLS} FROM surveys WHERE status='scheduled' AND launch_at <= $1`, [now]);
  for (const s of sched.rows) { await launchSurvey(pool, s, now); launched++; }

  /* 3) нагадування */
  const act = await pool.query<any>(`SELECT ${SURVEY_COLS} FROM surveys WHERE status='active' AND (remind->>'on')::boolean`);
  for (const s of act.rows) {
    const m = reminderMoments(new Date(s.due), s.remind as Remind);
    const sent = (s.remind_sent || {}) as { before?: boolean; dayOf?: boolean };
    const fire = async (key: 'before' | 'dayOf') => {
      const targets = await pool.query<any>(`SELECT user_id FROM survey_assignments WHERE survey_id=$1 AND responded_at IS NULL`, [s.id]);
      for (const t of targets.rows) { await notify(pool, t.user_id, s.id, 'reminder', `Нагадування: «${s.title}» чекає на вашу відповідь до ${fmtDue(s.due)}`); reminded++; }
      await pool.query(`UPDATE survey_assignments SET reminded_at=$2 WHERE survey_id=$1 AND responded_at IS NULL`, [s.id, now]);
      await pool.query(`UPDATE surveys SET remind_sent = remind_sent || $2::jsonb WHERE id=$1`, [s.id, JSON.stringify({ [key]: true })]);
    };
    if (m.before && m.before <= now && !sent.before) await fire('before');
    if (m.dayOf && m.dayOf <= now && !sent.dayOf) await fire('dayOf');
  }
  return { closed, launched, reminded };
}

/** Наступний випуск серії: копія питань, статус scheduled, launch_at за розкладом, due = launch_at + recur.days. */
export async function spawnNextIssue(pool: Db, s: { id: number; series_id: number; issue: number; title: string; description: string | null; anon: boolean; remind: Remind; allow_edit: boolean; recur: Recur; audience: unknown; created_by: number }, qs: Question[], now: Date) {
  const launchAt = nextLaunch(now, s.recur);
  const due = new Date(launchAt); due.setDate(due.getDate() + (s.recur.days || 2)); due.setHours(18, 0, 0, 0);
  const title = s.title.replace(/\s·\s№\d+$/, '') + ' · №' + (s.issue + 1);
  const ins = await pool.query<any>(`INSERT INTO surveys (series_id, issue, title, description, status, anon, due, launch_at, remind, allow_edit, recur, audience, created_by)
    VALUES ($1,$2,$3,$4,'scheduled',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [s.series_id, s.issue + 1, title, s.description, s.anon, due, launchAt, JSON.stringify(s.remind), s.allow_edit, JSON.stringify(s.recur), JSON.stringify(s.audience), s.created_by]);
  const nid = ins.rows[0].id;
  for (const [i, q] of qs.entries()) {
    await pool.query(`INSERT INTO survey_questions (survey_id, ord, type, text, hint, options, rows, min, max, required, image_url, series_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [nid, i, q.type, q.text, q.hint || null, JSON.stringify(q.options), JSON.stringify(q.rows), q.min, q.max, q.required, q.image || null, (q as Question & { series_key?: string }).series_key || String(q.id)]);
  }
  return nid;
}

/** Запуск: статус active, знімок адресатів, сповіщення «нове». Використовується і роутом POST /surveys/:id/launch. */
export async function launchSurvey(pool: Db, s: { id: number; title: string; due: string | Date; audience: unknown }, now: Date) {
  const users = await resolveAudience(pool, s.audience as Parameters<typeof resolveAudience>[1]);
  await pool.query(`UPDATE surveys SET status='active', launched_at=$2, launch_at=NULL WHERE id=$1`, [s.id, now]);
  for (const u of users) {
    await pool.query(`INSERT INTO survey_assignments (survey_id, user_id, notified_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [s.id, u.id, now]);
    await notify(pool, u.id, s.id, 'new', `Нове опитування «${s.title}» — до ${fmtDue(s.due)}`);
  }
  return users.length;
}

/** Колонки опитування — явним переліком (замість `*`): нове поле не поїде у відповідь саме. */
export const SURVEY_COLS = 'id, series_id, issue, title, description, status, anon, due, launch_at, remind, remind_sent, allow_edit, recur, audience, created_by, created_at, launched_at, closed_at, closed_by';

export function fmtDue(iso: string | Date) {
  const d = new Date(iso);
  // За Києвом явно: на сервері й так Київ, але повідомлення не мусить залежати від TZ процесу.
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' }) + ' ' + d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
}
export type { Question, ResponseRow };
