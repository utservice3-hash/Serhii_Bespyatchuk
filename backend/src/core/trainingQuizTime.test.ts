import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { answerTiming, countsAsNewViolation, defaultLimitSec, isViolationKind, limitVerdict, remainingSec, violationVerdict, QUIZ_GRACE_SEC } from "./trainingQuiz.js";
import { SALES_COURSE_QUIZZES } from "./quizSeedSalesCourse.js";

/**
 * ⏱ #3100–#3106 — ЛІМІТ ЧАСУ НА ПИТАННЯ ТЕСТУ (28.10.2026, Роман: «30 секунд — це мінімум на питання»; розрахунок — 60 с).
 * Головне твердження: час рахує СЕРВЕР, і питання видається по одному. Живі гейти кличуть функції ядра з явним
 * «зараз», тож запізнення перевіряється без справжнього очікування. Один тимчасовий кластер на файл.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");
const SRC = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("#3100 ТАЙМЕР: ліміт від 30 с, розрахунок 60 с, запізнення — понад ліміт і запас на мережу", () => {
  const t0 = new Date("2026-10-28T10:00:00Z"), at = (s: number) => new Date(t0.getTime() + s * 1000);
  // Межа запізнення — з обох боків (правило 11).
  assert.equal(answerTiming(t0, at(30 + QUIZ_GRACE_SEC), 30).late, false, "🔴 відповідь у межах запасу зарахована як запізніла");
  assert.equal(answerTiming(t0, at(30 + QUIZ_GRACE_SEC + 0.2), 30).late, true, "🔴 відповідь після ліміту прийнята вчасною");
  assert.equal(answerTiming(t0, at(12.34), 30).sec, 12.3);
  assert.equal(remainingSec(t0, at(10.2), 30), 20);
  assert.equal(remainingSec(t0, at(95), 30), 0, "🔴 залишок пішов у мінус");
  assert.equal(defaultLimitSec("number"), 60, "🔴 розрахунку не 60 с");
  assert.equal(defaultLimitSec("one"), 30);
  assert.equal(defaultLimitSec("multi"), 30);
  assert.equal(limitVerdict(29).ok, false, "🔴 редактор прийняв ліміт менше 30 с");
  assert.equal(limitVerdict(30).ok, true, "🔴 30 с — мінімум, а не заборона");
  assert.equal(limitVerdict("45").ok, true);
  assert.equal(limitVerdict(30.5).ok, false);
  assert.equal(limitVerdict(601).ok, false);
});

let shared: Promise<{ c: import("pg").Client; url: string } | { skip: string }> | null = null;
let dispose: (() => Promise<void>) | null = null;
async function cluster(t: { skip: (m: string) => void }) {
  shared ??= (async () => {
    const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
    const s = provisionScratch();
    if ("unavailable" in s) return { skip: skipReason(s) };
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: s.url });
    await c.connect();
    await c.query(readFileSync(SCHEMA, "utf8"));
    dispose = async () => { await c.end(); s.dispose(); };
    return { c, url: s.url };
  })();
  const r = await shared;
  if ("skip" in r) { t.skip(r.skip); return null; }
  return r;
}
after(async () => { if (dispose) await dispose(); });

/** Тест на 3 питання (30 / 30 / 60 с) і кандидат. Повертає id і хелпери ядра з цим зʼєднанням. */
async function fixture(c: import("pg").Client, tag: string) {
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  const course = (await q(`INSERT INTO training_courses (title, audience, published) VALUES ($1,'candidate',true) RETURNING id`, [`К ${tag}`]))[0].id;
  const f = (await q(`INSERT INTO training_folders (name, course_id, position) VALUES ($1,$2,1) RETURNING id`, [`Тема ${tag}`, course]))[0].id;
  const quiz = (await q(`INSERT INTO training_materials (folder_id, title, kind, position, content, status) VALUES ($1,$2,'quiz',1,'т','published') RETURNING id`, [f, `Тест ${tag}`]))[0].id as number;
  const ids: number[] = [];
  for (const [i, kind] of (["one", "one", "number"] as const).entries()) {
    ids.push((await q(
      `INSERT INTO training_quiz_questions (material_id, position, kind, text, options, correct, time_limit_sec) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [quiz, i + 1, kind, `Питання-${tag}-${i + 1}`, kind === "number" ? null : '["так","ні"]', kind === "number" ? '{"value":24000,"tol":0}' : "[0]", defaultLimitSec(kind)]))[0].id);
  }
  await q(`INSERT INTO training_quizzes (material_id, pass_pct, max_attempts) VALUES ($1, 80, 3)`, [quiz]);
  const user = (await q(`INSERT INTO users (email, password_hash, role, role_override) VALUES ($1,'x','manager','candidate') RETURNING id`, [`${tag}@x.ua`]))[0].id as number;
  const store = await import("./trainingQuizStore.js");
  const db = c as unknown as import("./trainingQuizStore.js").QuizDb;
  const right = (qid: number) => (qid === ids[2] ? "24 000" : 0);
  return { quiz, ids, user, store, db, right, q };
}
const T0 = new Date("2026-10-28T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
type Turn = Awaited<ReturnType<typeof import("./trainingQuizStore.js").startQuiz>>;
const step = (t: Turn) => { assert.equal(t.done, false, "🔴 спроба завершилась раніше, ніж чекали"); return t as Extract<Turn, { done: false }>; };

test("#3101 ЖИВИЙ SQL: старт видає ОДНЕ питання — решти тексту питань у відповіді немає", async (t) => {
  const s = await cluster(t); if (!s) return;
  const f = await fixture(s.c, "one");
  const st = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, T0));
  const raw = JSON.stringify(st);
  assert.equal(st.total, 3);
  assert.equal(st.index, 0);
  assert.ok(!("questions" in st), "🔴 старт віддав увесь список питань");
  const shown = [1, 2, 3].filter((n) => raw.includes(`Питання-one-${n}`));
  assert.equal(shown.length, 1, `🔴 у відповіді ${shown.length} питань замість одного`);
  assert.ok(!/"correct"|24000/.test(raw), "🔴 разом із питанням поїхала правильна відповідь");
});

test("#3102 ЖИВИЙ SQL: час рахує сервер — запізніла правильна відповідь неправильна, вчасна — правильна (дзеркало)", async (t) => {
  const s = await cluster(t); if (!s) return;
  const f = await fixture(s.c, "late");
  let cur = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, T0));
  const late = cur.question.id;
  // Перше питання — правильна відповідь, але на 10 с пізніше ліміту (і запасу).
  cur = step(await f.store.answerQuiz(f.db, f.user, f.quiz, cur.attemptId, late, f.right(late), at(cur.limitSec + QUIZ_GRACE_SEC + 10)));
  // Решта — правильно й вчасно (кожне питання стартує в мить попередньої відповіді).
  let now = at(cur.limitSec + QUIZ_GRACE_SEC + 10);
  let last: Turn = cur;
  while (!last.done) { now = new Date(now.getTime() + 5000); last = await f.store.answerQuiz(f.db, f.user, f.quiz, last.attemptId, last.question.id, f.right(last.question.id), now); }
  const r = last.result;
  const byId = new Map(r.results.map((x) => [x.id, x]));
  assert.equal(byId.get(late)!.ok, false, "🔴 запізніла відповідь зарахована");
  assert.equal(byId.get(late)!.late, true, "🔴 запізнення не позначене в результаті");
  assert.equal(r.right, 2, "🔴 вчасні правильні відповіді не зараховані (дзеркало)");
  assert.ok(r.results.filter((x) => x.id !== late).every((x) => x.ok && !x.late), "🔴 вчасну відповідь позначено запізнілою");
  const tm = (await f.q(`SELECT timings FROM training_quiz_attempts WHERE user_id = $1`, [f.user]))[0].timings as Record<string, { sec: number; late: boolean }>;
  assert.equal(Object.keys(tm).length, 3, "🔴 час відповіді збережено не для кожного питання");
  // Відповідь не на поточне питання (стара вкладка, подвійний клік) — 409, а не тихе зарахування.
  const st2 = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, at(500)));
  const other = f.ids.find((x) => x !== st2.question.id)!;
  await assert.rejects(f.store.answerQuiz(f.db, f.user, f.quiz, st2.attemptId, other, 0, at(501)), /вже закрите/, "🔴 прийнято відповідь не на поточне питання");
});

test("#3103 ЖИВИЙ SQL: оновлення сторінки не скидає таймер; час, що минув без людини, закриває питання", async (t) => {
  const s = await cluster(t); if (!s) return;
  const f = await fixture(s.c, "reload");
  const a = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, T0));
  const b = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, at(10)));
  assert.equal(b.question.id, a.question.id, "🔴 повторний старт видав інше питання");
  assert.equal(b.attemptId, a.attemptId, "🔴 повторний старт почав нову спробу");
  assert.equal(b.remainingSec, a.limitSec - 10, "🔴 таймер скинувся після оновлення сторінки");
  // Людина пішла й повернулась після ліміту — питання закрите як неправильне, видано наступне з повним часом.
  const back = at(a.limitSec + QUIZ_GRACE_SEC + 60);
  const c = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, back));
  assert.equal(c.index, 1, "🔴 прострочене питання не закрилось");
  assert.equal(c.remainingSec, c.limitSec, "🔴 наступне питання стартувало з урізаним часом");
  let last: Turn = c, now = back;
  while (!last.done) { now = new Date(now.getTime() + 2000); last = await f.store.answerQuiz(f.db, f.user, f.quiz, last.attemptId, last.question.id, f.right(last.question.id), now); }
  const skipped = last.result.results.find((x) => x.id === a.question.id)!;
  assert.deepEqual([skipped.ok, skipped.late], [false, true], "🔴 прострочене питання не зараховане неправильним");
  assert.equal(last.result.right, 2);
  // Дострокове завершення не приймає відповідей ззовні: нова спроба, нуль відповідей → нуль балів.
  const d = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, at(900)));
  const r = await f.store.submitQuiz(f.db, f.user, f.quiz, d.attemptId);
  assert.equal(r.right, 0, "🔴 завершення спроби зарахувало відповіді, яких сервер не приймав");
});

test("#3104 ЛІМІТ ≥ 30 с — тримає база, роут редактора й поле на екрані", async (t) => {
  const route = SRC("backend/src/routes/training.ts");
  const at = route.indexOf('trainingRouter.patch("/quiz/:id/questions/:qid"');
  assert.ok(at > 0, "🔴 роуту зміни ліміту немає");
  const body = route.slice(at, route.indexOf("\n});", at));
  assert.match(body, /canEditTraining/, "🔴 ліміт змінює не лише редактор навчання");
  assert.match(body, /limitVerdict\(/, "🔴 роут не перевіряє мінімум 30 с");
  assert.match(SRC("frontend/src/pages/dashboard/sections/QuizView.tsx"), /min=\{30\}/, "🔴 поле ліміту на екрані пускає менше 30");
  const s = await cluster(t); if (!s) return;
  const f = await fixture(s.c, "min");
  await assert.rejects(s.c.query(`UPDATE training_quiz_questions SET time_limit_sec = 20 WHERE id = $1`, [f.ids[0]]), /time_limit/, "🔴 база прийняла ліміт 20 с");
  await s.c.query(`UPDATE training_quiz_questions SET time_limit_sec = 30 WHERE id = $1`, [f.ids[0]]); // дзеркало: 30 — можна
});

test("#3105 ЖИВИЙ SQL: сід — розрахунок 60 с, решта 30 с; ні повторний імпорт, ні повторна схема не затирають ліміт редактора", async (t) => {
  const s = await cluster(t); if (!s) return;
  const { importQuizzes } = await import("./quizImport.js");
  const db = s.c as unknown as import("./trainingQuizStore.js").QuizDb;
  const cid = (await s.c.query(`INSERT INTO training_courses (title, audience, published) VALUES ($1, 'manager', false) RETURNING id`, [SALES_COURSE_QUIZZES.course])).rows[0].id;
  for (const [i, q] of SALES_COURSE_QUIZZES.quizzes.entries()) {
    const f = (await s.c.query(`INSERT INTO training_folders (name, course_id, position) VALUES ($1,$2,$3) RETURNING id`, [q.module, cid, i + 1])).rows[0].id;
    await s.c.query(`INSERT INTO training_materials (folder_id, title, kind, position) VALUES ($1,'Урок 1','text',5)`, [f]);
  }
  await importQuizzes(db, SALES_COURSE_QUIZZES, { write: true, courseId: cid });
  const lim = async () => Object.fromEntries((await s.c.query(`SELECT external_key, time_limit_sec FROM training_quiz_questions WHERE external_key LIKE 'sales-%'`)).rows.map((r) => [r.external_key, r.time_limit_sec]));
  const l1 = await lim();
  assert.equal(Object.keys(l1).length, 54);
  assert.deepEqual(Object.entries(l1).filter(([, v]) => v === 60).map(([k]) => k).sort(), ["sales-logistyka-12", "sales-prodazhi-12"], "🔴 60 с — не в питань із розрахунком");
  assert.equal(Object.values(l1).filter((v) => v === 30).length, 52, "🔴 решта питань не 30 с");
  // Редактор змінив ліміт → повторний імпорт і повторний прогін схеми його не чіпають.
  await s.c.query(`UPDATE training_quiz_questions SET time_limit_sec = 45 WHERE external_key = 'sales-prodazhi-12'`);
  await importQuizzes(db, SALES_COURSE_QUIZZES, { write: true, courseId: cid });
  await s.c.query(readFileSync(SCHEMA, "utf8"));
  assert.equal((await lim())["sales-prodazhi-12"], 45, "🔴 ліміт редактора затерто повторним імпортом чи схемою");
});

test("#3106 ЕКРАН ТЕСТУ: відповідь по одному питанню з таймером, без «Назад» і без відправки всіх відповідей разом", () => {
  const view = SRC("frontend/src/pages/dashboard/sections/QuizView.tsx");
  const learner = view.slice(0, view.indexOf("export function QuizEditorPanel"));
  assert.match(learner, /\banswerQuiz\(/, "🔴 екран не шле відповідь по одному питанню");
  assert.doesNotMatch(learner, /\bsubmitQuiz\(/, "🔴 екран шле всі відповіді разом — ліміт обходиться");
  assert.doesNotMatch(learner, /← Назад/, "🔴 до попереднього питання можна повернутись");
  assert.match(learner, /remainingSec/, "🔴 таймер не бере залишок із сервера");
  const api = SRC("frontend/src/api.ts");
  assert.doesNotMatch(api, /submitQuiz[^\n]*answers/, "🔴 API досі шле відповіді в «завершити»");
});

// ── 🖥 Повний екран і вихід із тесту (28.10.2026): два попередження, третій вихід — спроба не складена ──────────

test("#3107 ВИХІД ІЗ ТЕСТУ: два попередження, третій — не складено; відлуння одного виходу за < 2 с не рахується", () => {
  assert.deepEqual(violationVerdict(1), { fail: false, warningsLeft: 1 });
  assert.deepEqual(violationVerdict(2), { fail: false, warningsLeft: 0 }, "🔴 друге порушення вже завершує тест");
  assert.equal(violationVerdict(3).fail, true, "🔴 третє порушення не завершує тест");
  const t0 = new Date("2026-10-28T10:00:00Z");
  assert.equal(countsAsNewViolation(null, t0), true);
  assert.equal(countsAsNewViolation(t0, new Date(t0.getTime() + 1900)), false, "🔴 відлуння того самого виходу пораховане другим порушенням");
  assert.equal(countsAsNewViolation(t0, new Date(t0.getTime() + 2000)), true, "🔴 окремий вихід через 2 с не порахований");
  assert.equal(isViolationKind("tab_hidden"), true);
  assert.equal(isViolationKind("anything"), false);
});

/** Відповісти правильно на `k` питань поспіль (кожне — через 3 с після попереднього). */
async function answerRight(f: Awaited<ReturnType<typeof fixture>>, first: Turn, k: number, from: Date) {
  let cur: Turn = first, now = from;
  for (let i = 0; i < k && !cur.done; i++) {
    now = new Date(now.getTime() + 3000);
    cur = await f.store.answerQuiz(f.db, f.user, f.quiz, cur.attemptId, cur.question.id, f.right(cur.question.id), now);
  }
  return { cur, now };
}

test("#3108 ЖИВИЙ SQL: третій вихід — не складено навіть із правильними відповідями й спробу витрачено; два виходи — складено (дзеркало)", async (t) => {
  const s = await cluster(t); if (!s) return;
  // Дзеркало: два виходи, усі відповіді правильні → складено.
  const ok = await fixture(s.c, "warn2");
  const st = step(await ok.store.startQuiz(ok.db, ok.user, ok.quiz, Math.random, T0));
  for (const sec of [5, 15]) {
    const v = await ok.store.reportViolation(ok.db, ok.user, ok.quiz, st.attemptId, "tab_hidden", at(sec));
    assert.equal(v.done, false, "🔴 тест завершився після попередження");
  }
  const fin = await answerRight(ok, st, 3, at(20));
  assert.ok(fin.cur.done && fin.cur.result.passed, "🔴 два попередження зіпсували складений тест");
  assert.equal(fin.cur.done && fin.cur.result.endedBy, null);
  // Три виходи: дві правильні відповіді (поріг тут 50% — тобто бал уже ПРОХІДНИЙ), потім третій вихід → спробу
  // завершено як не складену. Без прохідного балу гейт доводив би лише «67% < 80%», а не «не складено через вихід».
  const bad = await fixture(s.c, "warn3");
  await bad.q(`UPDATE training_quizzes SET pass_pct = 50 WHERE material_id = $1`, [bad.quiz]);
  const b0 = step(await bad.store.startQuiz(bad.db, bad.user, bad.quiz, Math.random, T0));
  const part = await answerRight(bad, b0, 2, T0);
  let last: Awaited<ReturnType<typeof bad.store.reportViolation>> | null = null;
  for (const [i, kind] of (["fullscreen_exit", "tab_hidden", "window_blur"] as const).entries())
    last = await bad.store.reportViolation(bad.db, bad.user, bad.quiz, b0.attemptId, kind, new Date(part.now.getTime() + (i + 1) * 5000));
  assert.ok(last && last.done, "🔴 третій вихід не завершив спробу");
  const r = (last as { done: true; result: { passed: boolean; endedBy: string | null; right: number } }).result;
  assert.deepEqual([r.passed, r.endedBy, r.right], [false, "violations", 2], "🔴 третій вихід — не той результат");
  const me = await bad.store.myQuiz(bad.db, bad.user, bad.quiz);
  assert.deepEqual([me.used, me.left, me.attempts[0].endedBy], [1, 2, "violations"], "🔴 спробу через вихід не витрачено");
  const prog = (await bad.q(`SELECT status FROM training_progress WHERE user_id = $1 AND material_id = $2`, [bad.user, bad.quiz]))[0]?.status;
  assert.notEqual(prog, "done", "🔴 тест, завершений виходами, зараховано кроком");
});

test("#3109 ЖИВИЙ SQL: одне «виходження» — одне порушення; після завершення порушення не приймаються; «Найм» бачить причину й час", async (t) => {
  const s = await cluster(t); if (!s) return;
  const f = await fixture(s.c, "echo");
  const st = step(await f.store.startQuiz(f.db, f.user, f.quiz, Math.random, T0));
  const v1 = await f.store.reportViolation(f.db, f.user, f.quiz, st.attemptId, "tab_hidden", at(10));
  const v2 = await f.store.reportViolation(f.db, f.user, f.quiz, st.attemptId, "fullscreen_exit", at(10.5));
  assert.deepEqual([v1.done, v2.done], [false, false]);
  assert.equal(!v2.done && v2.counted, false, "🔴 відлуння (вкладка + повний екран за пів секунди) пораховано двічі");
  assert.equal(!v2.done && v2.violations, 1);
  await assert.rejects(f.store.reportViolation(f.db, f.user, f.quiz, st.attemptId, "hack", at(20)), /Невідомий вид/);
  await f.store.reportViolation(f.db, f.user, f.quiz, st.attemptId, "window_blur", at(30));
  const end = await f.store.reportViolation(f.db, f.user, f.quiz, st.attemptId, "tab_hidden", at(40));
  assert.equal(end.done, true);
  await assert.rejects(f.store.reportViolation(f.db, f.user, f.quiz, st.attemptId, "tab_hidden", at(50)), /завершено/, "🔴 порушення на завершеній спробі прийнято");
  const sum = (await f.store.quizSummaries(f.db, [f.user], [f.quiz])).get(f.user)![0];
  assert.equal(sum.endedByViolations, 1, "🔴 «Найм» не бачить спроби, не зарахованої через вихід");
  assert.equal(sum.lastViolations?.length, 3, "🔴 «Найм» не бачить часу кожного виходу");
});

test("#3110 ЕКРАН ТЕСТУ: повний екран на «Почати», ловить вкладку, повний екран і програму; «Найм» показує причину", () => {
  const view = SRC("frontend/src/pages/dashboard/sections/QuizView.tsx");
  const learner = view.slice(0, view.indexOf("export function QuizEditorPanel"));
  // Саме ПІДПИСКА, а не будь-яка згадка: назва події лишається й у знятті слухача.
  for (const ev of ["visibilitychange", "fullscreenchange", "blur"])
    assert.match(learner, new RegExp(`addEventListener\\("${ev}"`), `🔴 екран не ловить «${ev}»`);
  assert.match(learner, /reportQuizViolation\(/, "🔴 вихід не повідомляється серверу");
  const begin = learner.slice(learner.indexOf("const begin = async"), learner.indexOf("const send = async"));
  assert.match(begin, /enterFullscreen\(/, "🔴 «Почати тест» не розгортає на весь екран");
  assert.match(learner, /Повернутись до тесту/, "🔴 немає попередження з поверненням");
  assert.match(SRC("frontend/src/pages/dashboard/sections/HiringTraining.tsx"), /endedByViolations/, "🔴 «Найм» не показує незарахування через вихід");
});
