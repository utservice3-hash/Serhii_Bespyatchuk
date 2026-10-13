/**
 * 📝 ТЕСТ ПІСЛЯ ТЕМИ — СПРОБИ НА ЖИВИХ ДАНИХ (13.10.2026). Правила — `trainingQuiz.ts` (чисті); тут лише рядки.
 * Зʼєднання — параметром (як `trainingLock.ts`): гейт ганяє саме ці функції на тимчасовій базі, а не копію.
 *
 * 🔴 ЗАМОК ТУТ НЕ ПЕРЕВІРЯЄТЬСЯ — це робить роут ДО виклику (`stepLockedBy`), тим самим шляхом, що «відкрив» і
 * «опрацював». Друга перевірка тут розійшлася б із першою.
 */
import {
  attemptsLeft, gradePlan, pickQuestions, publicQuestion, scoreAttempt, startVerdict,
  type AttemptPlan, type PublicQuestion, type QuestionResult, type QuizAnswer, type QuizQuestion, type Rng,
} from "./trainingQuiz.js";

export interface QuizDb {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount?: number | null }>;
}

export class QuizError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface QuizSettings { materialId: number; title: string; status: string; passPct: number; showCount: number | null; maxAttempts: number }

/** Тест на уроці: налаштування (за замовчуванням 80% / усі / 3) і питання. `null` — урок не тест. */
export async function loadQuiz(db: QuizDb, materialId: number): Promise<{ settings: QuizSettings; questions: QuizQuestion[] } | null> {
  const m = (await db.query<{ id: number; title: string; kind: string; status: string; pass_pct: number | null; show_count: number | null; max_attempts: number | null }>(
    `SELECT m.id, m.title, m.kind, m.status, q.pass_pct, q.show_count, q.max_attempts
       FROM training_materials m LEFT JOIN training_quizzes q ON q.material_id = m.id WHERE m.id = $1`, [materialId])).rows[0];
  if (!m || m.kind !== "quiz") return null;
  const qs = (await db.query<{ id: number; kind: QuizQuestion["kind"]; text: string; options: string[] | null; correct: QuizQuestion["correct"]; explanation: string | null; source_title: string | null }>(
    `SELECT id, kind, text, options, correct, explanation, source_title
       FROM training_quiz_questions WHERE material_id = $1 ORDER BY position, id`, [materialId])).rows;
  return {
    settings: { materialId: m.id, title: m.title, status: m.status, passPct: m.pass_pct ?? 80, showCount: m.show_count, maxAttempts: m.max_attempts ?? 3 },
    questions: qs.map((q) => ({ id: q.id, kind: q.kind, text: q.text, options: q.options, correct: q.correct, explanation: q.explanation, sourceTitle: q.source_title })),
  };
}

interface AttemptRow { id: number; plan: AttemptPlan[]; right_count: number | null; total: number | null; pct: number | null; passed: boolean | null; started_at: string; submitted_at: string | null }

async function attemptsOf(db: QuizDb, uid: number, materialId: number) {
  const rows = (await db.query<AttemptRow>(
    `SELECT id, plan, right_count, total, pct, passed, started_at, submitted_at
       FROM training_quiz_attempts WHERE user_id = $1 AND material_id = $2 ORDER BY id`, [uid, materialId])).rows;
  const grants = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM training_quiz_grants WHERE user_id = $1 AND material_id = $2`, [uid, materialId])).rows[0]?.n ?? 0;
  const done = rows.filter((r) => r.submitted_at);
  return { done, open: rows.find((r) => !r.submitted_at) ?? null, grants, passed: done.some((r) => r.passed), bestPct: done.length ? Math.max(...done.map((r) => r.pct ?? 0)) : null };
}

export interface MyQuiz {
  materialId: number; title: string; passPct: number; questionCount: number; poolSize: number; maxAttempts: number;
  used: number; grants: number; left: number; passed: boolean; bestPct: number | null; hasOpenAttempt: boolean;
  attempts: { right: number; total: number; pct: number; passed: boolean; submittedAt: string }[];
}

/** Стан тесту для людини: поріг, скільки питань, спроби, найкращий бал. Без питань. */
export async function myQuiz(db: QuizDb, uid: number, materialId: number): Promise<MyQuiz> {
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  const st = await attemptsOf(db, uid, materialId);
  const s = quiz.settings;
  const size = s.showCount && s.showCount < quiz.questions.length ? s.showCount : quiz.questions.length;
  return {
    materialId, title: s.title, passPct: s.passPct, questionCount: size, poolSize: quiz.questions.length, maxAttempts: s.maxAttempts,
    used: st.done.length, grants: st.grants, left: attemptsLeft({ used: st.done.length, max: s.maxAttempts, grants: st.grants }),
    passed: st.passed, bestPct: st.bestPct, hasOpenAttempt: st.open != null,
    attempts: st.done.map((r) => ({ right: r.right_count ?? 0, total: r.total ?? 0, pct: r.pct ?? 0, passed: !!r.passed, submittedAt: r.submitted_at! })),
  };
}

/**
 * Почати спробу. Відкрита спроба ПРОДОВЖУЄТЬСЯ тим самим набором — інакше «почати знову» перемішувало б
 * питання без ліку й не витрачало спроб. Питання віддаються БЕЗ правильних відповідей (`publicQuestion`).
 */
export async function startQuiz(db: QuizDb, uid: number, materialId: number, rng: Rng = Math.random):
  Promise<{ attemptId: number; passPct: number; questions: PublicQuestion[] }> {
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  if (!quiz.questions.length) throw new QuizError(409, "У тесті ще немає питань");
  const st = await attemptsOf(db, uid, materialId);
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  if (st.open && !st.passed) {
    return { attemptId: st.open.id, passPct: quiz.settings.passPct,
      questions: st.open.plan.filter((p) => byId.has(p.questionId)).map((p) => publicQuestion(byId.get(p.questionId)!, p.order)) };
  }
  const v = startVerdict({ passed: st.passed, used: st.done.length, max: quiz.settings.maxAttempts, grants: st.grants });
  if (!v.ok) throw new QuizError(v.status, v.reason);
  const plan = pickQuestions(quiz.questions, quiz.settings.showCount, rng);
  const r = await db.query<{ id: number }>(
    `INSERT INTO training_quiz_attempts (user_id, material_id, plan) VALUES ($1, $2, $3) RETURNING id`, [uid, materialId, JSON.stringify(plan)]);
  await db.query(`INSERT INTO training_progress (user_id, material_id, status) VALUES ($1, $2, 'opened') ON CONFLICT (user_id, material_id) DO NOTHING`, [uid, materialId]);
  return { attemptId: r.rows[0].id, passPct: quiz.settings.passPct,
    questions: plan.map((p) => publicQuestion(byId.get(p.questionId)!, p.order)) };
}

export interface SubmitResult { right: number; total: number; pct: number; passed: boolean; left: number; results: QuestionResult[] }

/**
 * Завершити спробу: перевірка на сервері, запис балу, і — ЛИШЕ якщо складено — крок «пройдено».
 * Повторне завершення тієї самої спроби — 409 (оновлення з умовою `submitted_at IS NULL`).
 */
export async function submitQuiz(db: QuizDb, uid: number, materialId: number, attemptId: number,
  answers: Readonly<Record<string, QuizAnswer>>): Promise<SubmitResult> {
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  const a = (await db.query<{ id: number; plan: AttemptPlan[] }>(
    `SELECT id, plan FROM training_quiz_attempts WHERE id = $1 AND user_id = $2 AND material_id = $3 AND submitted_at IS NULL`,
    [attemptId, uid, materialId])).rows[0];
  if (!a) throw new QuizError(409, "Спробу вже завершено або її не існує — почніть нову");
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const { marks, results } = gradePlan(a.plan, byId, answers ?? {});
  const sc = scoreAttempt(marks, quiz.settings.passPct);
  const upd = await db.query(
    `UPDATE training_quiz_attempts SET answers = $2, right_count = $3, total = $4, pct = $5, passed = $6, submitted_at = now()
      WHERE id = $1 AND submitted_at IS NULL RETURNING id`,
    [attemptId, JSON.stringify(answers ?? {}), sc.right, sc.total, sc.pct, sc.passed]);
  if (!upd.rows.length) throw new QuizError(409, "Спробу вже завершено");
  const st = await attemptsOf(db, uid, materialId);
  await db.query(
    `INSERT INTO training_progress (user_id, material_id, status, score, passed, attempts, finished_at)
     VALUES ($1, $2, CASE WHEN $3::boolean THEN 'done' ELSE 'opened' END, $4, $3, $5, CASE WHEN $3::boolean THEN now() END)
     ON CONFLICT (user_id, material_id) DO UPDATE SET
       status = CASE WHEN $3::boolean THEN 'done' ELSE training_progress.status END,
       score = GREATEST(COALESCE(training_progress.score, 0), $4),
       passed = (training_progress.passed IS TRUE) OR $3::boolean,
       attempts = $5,
       finished_at = CASE WHEN $3::boolean AND training_progress.finished_at IS NULL THEN now() ELSE training_progress.finished_at END`,
    [uid, materialId, sc.passed, sc.pct, st.done.length]);
  await db.query(
    `INSERT INTO training_events (user_id, material_id, kind, payload_json) VALUES ($1, $2, 'quiz_attempt', $3)`,
    [uid, materialId, JSON.stringify({ attemptId, right: sc.right, total: sc.total, pct: sc.pct, passed: sc.passed })]);
  return { ...sc, left: attemptsLeft({ used: st.done.length, max: quiz.settings.maxAttempts, grants: st.grants }), results };
}

export interface QuizSummary { materialId: number; title: string; used: number; grants: number; maxAttempts: number; left: number; passed: boolean; bestPct: number | null; lastPct: number | null }

/** Підсумок тестів для дошки «Найму»: по кожному тесту курсу — спроби й найкращий бал кожного користувача. */
export async function quizSummaries(db: QuizDb, userIds: readonly number[], quizIds: readonly number[]): Promise<Map<number, QuizSummary[]>> {
  const out = new Map<number, QuizSummary[]>();
  if (!userIds.length || !quizIds.length) return out;
  const meta = (await db.query<{ id: number; title: string; max_attempts: number | null }>(
    `SELECT m.id, m.title, q.max_attempts FROM training_materials m LEFT JOIN training_quizzes q ON q.material_id = m.id WHERE m.id = ANY($1::int[])`,
    [quizIds])).rows;
  const att = (await db.query<{ user_id: number; material_id: number; pct: number | null; passed: boolean | null; submitted_at: string }>(
    `SELECT user_id, material_id, pct, passed, submitted_at FROM training_quiz_attempts
      WHERE user_id = ANY($1::int[]) AND material_id = ANY($2::int[]) AND submitted_at IS NOT NULL ORDER BY submitted_at, id`,
    [userIds, quizIds])).rows;
  const gr = (await db.query<{ user_id: number; material_id: number; n: number }>(
    `SELECT user_id, material_id, count(*)::int AS n FROM training_quiz_grants
      WHERE user_id = ANY($1::int[]) AND material_id = ANY($2::int[]) GROUP BY 1, 2`, [userIds, quizIds])).rows;
  for (const u of userIds) {
    out.set(u, quizIds.map((qid) => {
      const m = meta.find((x) => x.id === qid);
      const mine = att.filter((x) => x.user_id === u && x.material_id === qid);
      const grants = gr.find((x) => x.user_id === u && x.material_id === qid)?.n ?? 0;
      const max = m?.max_attempts ?? 3;
      return { materialId: qid, title: m?.title ?? "", used: mine.length, grants, maxAttempts: max,
        left: attemptsLeft({ used: mine.length, max, grants }), passed: mine.some((x) => x.passed),
        bestPct: mine.length ? Math.max(...mine.map((x) => x.pct ?? 0)) : null, lastPct: mine.length ? mine[mine.length - 1].pct : null };
    }));
  }
  return out;
}

/** «Ще одна спроба» — окремим рядком з автором. Лише якщо тест не складено й власні спроби вичерпано. */
export async function grantAttempt(db: QuizDb, actorId: number | null, uid: number, materialId: number, comment: string | null): Promise<void> {
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  const st = await attemptsOf(db, uid, materialId);
  if (st.passed) throw new QuizError(409, "Тест уже складено — додаткова спроба не потрібна");
  if (attemptsLeft({ used: st.done.length, max: quiz.settings.maxAttempts, grants: st.grants }) > 0)
    throw new QuizError(409, "У кандидата ще є спроби");
  await db.query(`INSERT INTO training_quiz_grants (user_id, material_id, granted_by, comment) VALUES ($1, $2, $3, $4)`,
    [uid, materialId, actorId, comment]);
}
