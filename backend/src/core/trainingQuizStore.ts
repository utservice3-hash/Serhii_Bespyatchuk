/**
 * 📝 ТЕСТ ПІСЛЯ ТЕМИ — СПРОБИ НА ЖИВИХ ДАНИХ (13.10.2026). Правила — `trainingQuiz.ts` (чисті); тут лише рядки.
 * Зʼєднання — параметром (як `trainingLock.ts`): гейт ганяє саме ці функції на тимчасовій базі, а не копію.
 *
 * 🔴 ЗАМОК ТУТ НЕ ПЕРЕВІРЯЄТЬСЯ — це робить роут ДО виклику (`stepLockedBy`), тим самим шляхом, що «відкрив» і
 * «опрацював». Друга перевірка тут розійшлася б із першою.
 */
import {
  QUIZ_MIN_LIMIT_SEC, QUIZ_VIOLATION_LIMIT, answerTiming, attemptsLeft, countsAsNewViolation, gradePlan, isViolationKind, pickQuestions,
  publicQuestion, remainingSec, scoreAttempt, startVerdict, violationVerdict,
  type AttemptPlan, type QuizViolationKind, type PublicQuestion, type QuestionResult, type QuizAnswer, type QuizQuestion, type Rng,
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
  const qs = (await db.query<{ id: number; kind: QuizQuestion["kind"]; text: string; options: string[] | null; correct: QuizQuestion["correct"]; explanation: string | null; source_title: string | null; time_limit_sec: number | null }>(
    `SELECT id, kind, text, options, correct, explanation, source_title, time_limit_sec
       FROM training_quiz_questions WHERE material_id = $1 ORDER BY position, id`, [materialId])).rows;
  return {
    settings: { materialId: m.id, title: m.title, status: m.status, passPct: m.pass_pct ?? 80, showCount: m.show_count, maxAttempts: m.max_attempts ?? 3 },
    questions: qs.map((q) => ({ id: q.id, kind: q.kind, text: q.text, options: q.options, correct: q.correct, explanation: q.explanation, sourceTitle: q.source_title,
      timeLimitSec: Math.max(QUIZ_MIN_LIMIT_SEC, q.time_limit_sec ?? QUIZ_MIN_LIMIT_SEC) })),
  };
}

type Timings = Record<string, { sec: number; late: boolean }>;
export type ViolationLog = { kind: QuizViolationKind; at: string }[];
/** Чим завершилась спроба, якщо не відповідями: `violations` — три виходи з тесту, спроба не складена. */
export type EndedBy = "violations" | null;
interface AttemptRow {
  id: number; plan: AttemptPlan[]; answers: Record<string, QuizAnswer> | null; timings: Timings | null;
  cur_index: number; cur_shown_at: Date | string | null;
  violations: number; violation_log: ViolationLog | null; ended_reason: EndedBy;
  right_count: number | null; total: number | null; pct: number | null; passed: boolean | null; started_at: string; submitted_at: string | null;
}
const ATTEMPT_COLS = `id, plan, answers, timings, cur_index, cur_shown_at, violations, violation_log, ended_reason,
  right_count, total, pct, passed, started_at, submitted_at`;

async function attemptsOf(db: QuizDb, uid: number, materialId: number) {
  const rows = (await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLS} FROM training_quiz_attempts WHERE user_id = $1 AND material_id = $2 ORDER BY id`, [uid, materialId])).rows;
  const grants = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM training_quiz_grants WHERE user_id = $1 AND material_id = $2`, [uid, materialId])).rows[0]?.n ?? 0;
  const done = rows.filter((r) => r.submitted_at);
  return { done, open: rows.find((r) => !r.submitted_at) ?? null, grants, passed: done.some((r) => r.passed), bestPct: done.length ? Math.max(...done.map((r) => r.pct ?? 0)) : null };
}

export interface MyQuiz {
  materialId: number; title: string; passPct: number; questionCount: number; poolSize: number; maxAttempts: number;
  used: number; grants: number; left: number; passed: boolean; bestPct: number | null; hasOpenAttempt: boolean;
  /** Ліміт часу на питання в цьому тесті: найменший і найбільший (секунди). */
  limitMinSec: number; limitMaxSec: number;
  attempts: { right: number; total: number; pct: number; passed: boolean; submittedAt: string; endedBy: EndedBy }[];
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
    limitMinSec: quiz.questions.length ? Math.min(...quiz.questions.map((q) => q.timeLimitSec)) : QUIZ_MIN_LIMIT_SEC,
    limitMaxSec: quiz.questions.length ? Math.max(...quiz.questions.map((q) => q.timeLimitSec)) : QUIZ_MIN_LIMIT_SEC,
    attempts: st.done.map((r) => ({ right: r.right_count ?? 0, total: r.total ?? 0, pct: r.pct ?? 0, passed: !!r.passed, submittedAt: r.submitted_at!, endedBy: r.ended_reason })),
  };
}

/**
 * Хід тесту: або поточне питання з лімітом і залишком часу, або (питань більше немає) результат спроби.
 * 🔴 ПИТАННЯ ВИДАЄТЬСЯ ПО ОДНОМУ (28.10.2026): наступне сервер показує лише після відповіді на поточне чи після
 * того, як його час вийшов. Інакше ліміт обходився б тим, що всі питання вже лежать на екрані.
 */
export interface QuizStep {
  attemptId: number; passPct: number; total: number; index: number;
  question: PublicQuestion; limitSec: number; remainingSec: number;
}
export type QuizTurn = ({ done: false } & QuizStep) | { done: true; result: SubmitResult };

async function openAttemptForUpdate(db: QuizDb, uid: number, materialId: number, attemptId?: number) {
  return (await db.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLS} FROM training_quiz_attempts
      WHERE user_id = $1 AND material_id = $2 AND submitted_at IS NULL ${attemptId ? "AND id = $3" : ""}
      ORDER BY id LIMIT 1 FOR UPDATE`, attemptId ? [uid, materialId, attemptId] : [uid, materialId])).rows[0] ?? null;
}

/**
 * Поточний хід відкритої спроби. Якщо час поточного питання вийшов, поки людини не було (закрила вкладку,
 * пропало звʼязок), — воно зараховується як неправильне, і показується наступне. Наступне питання отримує
 * свій повний час від моменту показу: людина його ще не бачила.
 */
async function turnOf(db: QuizDb, uid: number, materialId: number, quiz: NonNullable<Awaited<ReturnType<typeof loadQuiz>>>, a: AttemptRow, now: Date): Promise<QuizTurn> {
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const timings: Timings = { ...(a.timings ?? {}) };
  let idx = a.cur_index;
  let shownAt = a.cur_shown_at ? new Date(a.cur_shown_at) : null;
  if (shownAt && idx < a.plan.length) {
    const qid = a.plan[idx].questionId;
    const t = answerTiming(shownAt, now, byId.get(qid)?.timeLimitSec ?? QUIZ_MIN_LIMIT_SEC);
    if (t.late) { timings[String(qid)] = { sec: t.sec, late: true }; idx++; shownAt = null; }
  }
  while (idx < a.plan.length && !byId.has(a.plan[idx].questionId)) idx++; // питання прибрали з тесту
  if (idx >= a.plan.length) {
    return { done: true, result: await finishAttempt(db, uid, materialId, quiz, a.id, a.plan, a.answers ?? {}, timings) };
  }
  if (!shownAt) shownAt = now;
  await db.query(`UPDATE training_quiz_attempts SET cur_index = $2, cur_shown_at = $3, timings = $4 WHERE id = $1`,
    [a.id, idx, shownAt, JSON.stringify(timings)]);
  const p = a.plan[idx], q = byId.get(p.questionId)!;
  return { done: false, attemptId: a.id, passPct: quiz.settings.passPct, total: a.plan.length, index: idx,
    question: publicQuestion(q, p.order), limitSec: q.timeLimitSec, remainingSec: remainingSec(shownAt, now, q.timeLimitSec) };
}

/**
 * Почати спробу. Відкрита спроба ПРОДОВЖУЄТЬСЯ з того самого питання з тим самим годинником — оновлення
 * сторінки не скидає таймер і не перемішує питання. Питання — без правильних відповідей (`publicQuestion`).
 */
export async function startQuiz(db: QuizDb, uid: number, materialId: number, rng: Rng = Math.random, now: Date = new Date()): Promise<QuizTurn> {
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  if (!quiz.questions.length) throw new QuizError(409, "У тесті ще немає питань");
  const st = await attemptsOf(db, uid, materialId);
  const open = st.passed ? null : await openAttemptForUpdate(db, uid, materialId);
  if (open) return turnOf(db, uid, materialId, quiz, open, now);
  const v = startVerdict({ passed: st.passed, used: st.done.length, max: quiz.settings.maxAttempts, grants: st.grants });
  if (!v.ok) throw new QuizError(v.status, v.reason);
  const plan = pickQuestions(quiz.questions, quiz.settings.showCount, rng);
  const r = await db.query<AttemptRow>(
    `INSERT INTO training_quiz_attempts (user_id, material_id, plan) VALUES ($1, $2, $3) RETURNING ${ATTEMPT_COLS}`,
    [uid, materialId, JSON.stringify(plan)]);
  await db.query(`INSERT INTO training_progress (user_id, material_id, status) VALUES ($1, $2, 'opened') ON CONFLICT (user_id, material_id) DO NOTHING`, [uid, materialId]);
  return turnOf(db, uid, materialId, quiz, r.rows[0], now);
}

/**
 * Відповідь на ПОТОЧНЕ питання. Час — від моменту, коли сервер його видав; запізніла відповідь зберігається, але
 * зараховується як неправильна (`late`). Відповідь не на поточне питання (подвійний клік, стара вкладка) — 409.
 */
export async function answerQuiz(db: QuizDb, uid: number, materialId: number, attemptId: number, questionId: number,
  answer: QuizAnswer, now: Date = new Date()): Promise<QuizTurn> {
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  const a = await openAttemptForUpdate(db, uid, materialId, attemptId);
  if (!a) throw new QuizError(409, "Спробу вже завершено або її не існує — почніть нову");
  const cur = a.plan[a.cur_index];
  if (!cur || cur.questionId !== questionId || !a.cur_shown_at)
    throw new QuizError(409, "Це питання вже закрите — оновіть сторінку");
  const q = quiz.questions.find((x) => x.id === questionId);
  const t = answerTiming(new Date(a.cur_shown_at), now, q?.timeLimitSec ?? QUIZ_MIN_LIMIT_SEC);
  const answers = { ...(a.answers ?? {}), [String(questionId)]: answer ?? null };
  const timings: Timings = { ...(a.timings ?? {}), [String(questionId)]: t };
  await db.query(`UPDATE training_quiz_attempts SET answers = $2, timings = $3, cur_index = $4, cur_shown_at = NULL WHERE id = $1`,
    [a.id, JSON.stringify(answers), JSON.stringify(timings), a.cur_index + 1]);
  return turnOf(db, uid, materialId, quiz, { ...a, answers, timings, cur_index: a.cur_index + 1, cur_shown_at: null }, now);
}

export interface SubmitResult { right: number; total: number; pct: number; passed: boolean; left: number; results: QuestionResult[]; endedBy: EndedBy }

/**
 * 🖥 Порушення: вийшов із повного екрана / вкладки / програми. Перші два — попередження, третє завершує спробу як
 * НЕ складену (і спроба витрачається). Подія ближче ніж за 2 с до попередньої — відлуння того самого виходу.
 */
export type ViolationTurn = { done: false; violations: number; limit: number; counted: boolean } | { done: true; result: SubmitResult };
export async function reportViolation(db: QuizDb, uid: number, materialId: number, attemptId: number, kind: unknown,
  now: Date = new Date()): Promise<ViolationTurn> {
  if (!isViolationKind(kind)) throw new QuizError(400, "Невідомий вид порушення");
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  const a = await openAttemptForUpdate(db, uid, materialId, attemptId);
  if (!a) throw new QuizError(409, "Спробу вже завершено або її не існує");
  const log: ViolationLog = [...(a.violation_log ?? [])];
  const last = log.length ? new Date(log[log.length - 1].at) : null;
  if (!countsAsNewViolation(last, now)) return { done: false, violations: a.violations, limit: QUIZ_VIOLATION_LIMIT, counted: false };
  log.push({ kind, at: now.toISOString() });
  const n = a.violations + 1;
  await db.query(`UPDATE training_quiz_attempts SET violations = $2, violation_log = $3 WHERE id = $1`, [a.id, n, JSON.stringify(log)]);
  if (violationVerdict(n).fail)
    return { done: true, result: await finishAttempt(db, uid, materialId, quiz, a.id, a.plan, a.answers ?? {}, a.timings ?? {}, "violations") };
  return { done: false, violations: n, limit: QUIZ_VIOLATION_LIMIT, counted: true };
}

/**
 * Завершити спробу ДОСТРОКОВО — відповідями, які вже прийняв сервер; решта питань — неправильні. Відповіді з
 * тіла запиту НЕ приймаються: інакше вся перевірка часу обходилась би одним запитом. Повторне завершення — 409.
 */
export async function submitQuiz(db: QuizDb, uid: number, materialId: number, attemptId: number): Promise<SubmitResult> {
  const quiz = await loadQuiz(db, materialId);
  if (!quiz) throw new QuizError(404, "Тест не знайдено");
  const a = await openAttemptForUpdate(db, uid, materialId, attemptId);
  if (!a) throw new QuizError(409, "Спробу вже завершено або її не існує — почніть нову");
  return finishAttempt(db, uid, materialId, quiz, a.id, a.plan, a.answers ?? {}, a.timings ?? {});
}

/** Підсумок спроби: перевірка на сервері, запис балу, і — ЛИШЕ якщо складено — крок «пройдено». */
async function finishAttempt(db: QuizDb, uid: number, materialId: number, quiz: NonNullable<Awaited<ReturnType<typeof loadQuiz>>>,
  attemptId: number, plan: AttemptPlan[], answers: Record<string, QuizAnswer>, timings: Timings, endedBy: EndedBy = null): Promise<SubmitResult> {
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const late = new Set(Object.entries(timings).filter(([, t]) => t.late).map(([k]) => Number(k)));
  const { marks, results } = gradePlan(plan, byId, answers, late);
  const scored = scoreAttempt(marks, quiz.settings.passPct);
  // Три виходи з тесту — не складено, хоч би якими були відповіді; бал лишається видимим як є.
  const sc = endedBy ? { ...scored, passed: false } : scored;
  const upd = await db.query(
    `UPDATE training_quiz_attempts SET answers = $2, timings = $3, right_count = $4, total = $5, pct = $6, passed = $7,
            cur_index = $8, cur_shown_at = NULL, ended_reason = $9, submitted_at = now()
      WHERE id = $1 AND submitted_at IS NULL RETURNING id`,
    [attemptId, JSON.stringify(answers), JSON.stringify(timings), sc.right, sc.total, sc.pct, sc.passed, plan.length, endedBy]);
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
    [uid, materialId, JSON.stringify({ attemptId, right: sc.right, total: sc.total, pct: sc.pct, passed: sc.passed, endedBy })]);
  return { ...sc, left: attemptsLeft({ used: st.done.length, max: quiz.settings.maxAttempts, grants: st.grants }), results, endedBy };
}

export interface QuizSummary {
  materialId: number; title: string; used: number; grants: number; maxAttempts: number; left: number; passed: boolean; bestPct: number | null; lastPct: number | null;
  /** 🖥 Скільки спроб не зараховано через вихід із тесту, і коли саме виходили в останній спробі з виходами. */
  endedByViolations: number; lastViolations: ViolationLog | null;
}

/** Підсумок тестів для дошки «Найму»: по кожному тесту курсу — спроби й найкращий бал кожного користувача. */
export async function quizSummaries(db: QuizDb, userIds: readonly number[], quizIds: readonly number[]): Promise<Map<number, QuizSummary[]>> {
  const out = new Map<number, QuizSummary[]>();
  if (!userIds.length || !quizIds.length) return out;
  const meta = (await db.query<{ id: number; title: string; max_attempts: number | null }>(
    `SELECT m.id, m.title, q.max_attempts FROM training_materials m LEFT JOIN training_quizzes q ON q.material_id = m.id WHERE m.id = ANY($1::int[])`,
    [quizIds])).rows;
  const att = (await db.query<{ user_id: number; material_id: number; pct: number | null; passed: boolean | null; submitted_at: string; ended_reason: EndedBy; violation_log: ViolationLog | null }>(
    `SELECT user_id, material_id, pct, passed, submitted_at, ended_reason, violation_log FROM training_quiz_attempts
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
        bestPct: mine.length ? Math.max(...mine.map((x) => x.pct ?? 0)) : null, lastPct: mine.length ? mine[mine.length - 1].pct : null,
        endedByViolations: mine.filter((x) => x.ended_reason === "violations").length,
        lastViolations: [...mine].reverse().find((x) => x.violation_log?.length)?.violation_log ?? null };
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
