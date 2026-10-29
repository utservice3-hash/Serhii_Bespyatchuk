import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  gradeAnswer, parseNumberAnswer, scoreAttempt, attemptsLeft, startVerdict, pickQuestions, publicQuestion, gradePlan,
  type QuizQuestion,
} from "./trainingQuiz.js";
import { seedProblems } from "./quizImport.js";
import { SALES_COURSE_QUIZZES, type QuizSeed } from "./quizSeedSalesCourse.js";

/**
 * 📝 #1650–#1657 — ТЕСТИ ПІСЛЯ ТЕМИ (13.10.2026, план «Тести в навчанні», рішення Романа Р1–Р6).
 * Чисті правила — з обох боків кожної межі (правило 11); живий шлях — обробниками роутера на тимчасовій базі.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const FE = (rel: string) => readFileSync(path.join(ROOT, "frontend", "src", rel), "utf8");
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

const one = (id: number, correct = 0): QuizQuestion => ({ id, kind: "one", text: `q${id}`, options: ["a", "b", "c"], correct: [correct], explanation: `why${id}`, sourceTitle: "Урок", timeLimitSec: 30 });

/** #1650 — перевірка відповіді: один варіант, «кілька» лише точним збігом, число з допуском і з тексту людини. */
test("#1650 ТЕСТ: перевірка відповіді — один, кілька (лише точно), число з допуском", () => {
  assert.equal(gradeAnswer(one(1, 2), 2), true);
  assert.equal(gradeAnswer(one(1, 2), 1), false, "🔴 неправильний варіант зараховано");
  assert.equal(gradeAnswer(one(1, 2), "2"), false, "🔴 рядок замість індексу зараховано");
  const multi: QuizQuestion = { ...one(2), kind: "multi", options: ["a", "b", "c", "d"], correct: [0, 1, 2] };
  assert.equal(gradeAnswer(multi, [2, 0, 1]), true, "🔴 правильна множина в іншому порядку не зарахована");
  assert.equal(gradeAnswer(multi, [0, 1]), false, "🔴 часткова відповідь зарахована як повна");
  assert.equal(gradeAnswer(multi, [0, 1, 2, 3]), false, "🔴 «позначити все» дало бал");
  assert.equal(gradeAnswer(multi, [0, 0, 1, 2]), false, "🔴 повтор індексу зараховано");
  const num: QuizQuestion = { ...one(3), kind: "number", options: null, correct: { value: 24000, tol: 0 } };
  for (const ok of ["24000", "24 000", "24 000 грн", 24000]) assert.equal(gradeAnswer(num, ok), true, `🔴 «${ok}» не визнано за 24 000`);
  assert.equal(gradeAnswer(num, "23999"), false, "🔴 число без допуску зараховано з похибкою");
  assert.equal(gradeAnswer({ ...num, correct: { value: 24000, tol: 5 } }, "23996"), true, "🔴 допуск не працює");
  assert.equal(parseNumberAnswer("двадцять"), null, "🔴 сміття стало числом");
  assert.equal(parseNumberAnswer("7,5"), 7.5, "🔴 десяткова кома не прочитана");
});

/** #1651 — поріг: ціле порівняння, без округленого відсотка; 0 питань не складаються. */
test("#1651 ТЕСТ: поріг 80% — 10 з 12 і 4 з 5 складено, 9 з 12 і 3 з 5 — ні", () => {
  const m = (r: number, t: number) => Array.from({ length: t }, (_, i) => i < r);
  assert.equal(scoreAttempt(m(10, 12), 80).passed, true, "🔴 10 з 12 не складено");
  assert.equal(scoreAttempt(m(9, 12), 80).passed, false, "🔴 9 з 12 складено");
  assert.equal(scoreAttempt(m(4, 5), 80).passed, true, "🔴 4 з 5 (рівно 80%) не складено");
  assert.equal(scoreAttempt(m(3, 5), 80).passed, false, "🔴 3 з 5 складено");
  assert.equal(scoreAttempt([], 80).passed, false, "🔴 порожній тест «складено»");
  assert.deepEqual(scoreAttempt(m(10, 12), 80), { right: 10, total: 12, pct: 83, passed: true });
});

/** #1652 — спроби: 3 власні, далі лише «ще спроба»; склав — більше не починає. */
test("#1652 ТЕСТ: спроби — 3 власні, «ще спроба» додає одну, склав — нова не починається", () => {
  assert.equal(attemptsLeft({ used: 3, max: 3, grants: 0 }), 0);
  assert.equal(attemptsLeft({ used: 3, max: 3, grants: 1 }), 1, "🔴 видана спроба не додалась");
  assert.equal(attemptsLeft({ used: 9, max: 3, grants: 0 }), 0, "🔴 спроб стало відʼємно");
  assert.equal(startVerdict({ passed: false, used: 3, max: 3, grants: 0 }).ok, false, "🔴 четверта спроба без дозволу");
  assert.equal(startVerdict({ passed: false, used: 3, max: 3, grants: 1 }).ok, true, "🔴 видана спроба не дає почати");
  assert.equal(startVerdict({ passed: true, used: 1, max: 3, grants: 0 }).ok, false, "🔴 складений тест починається знову");
  assert.equal(startVerdict({ passed: false, used: 0, max: 3, grants: 0 }).ok, true, "🔴 перша спроба заборонена");
});

/** #1653 — учневі не їде правильна відповідь і пояснення; індекс варіанта — оригінальний; набір — з пулу. */
test("#1653 ТЕСТ: питання для учня — без правильної відповіді й пояснення, перемішані, з пулу", () => {
  const pool = [one(1, 1), one(2, 2), one(3, 0), one(4, 1), one(5, 2)];
  let seed = 7; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const plan = pickQuestions(pool, 3, rng);
  assert.equal(plan.length, 3, "🔴 показано не стільки питань, скільки налаштовано");
  assert.equal(new Set(plan.map((p) => p.questionId)).size, 3, "🔴 питання повторилось у спробі");
  for (const p of plan) assert.deepEqual([...p.order!].sort(), [0, 1, 2], "🔴 порядок варіантів — не перестановка");
  const pub = publicQuestion(pool[0], [2, 0, 1]);
  assert.ok(!("correct" in pub) && !("explanation" in pub) && !("sourceTitle" in pub), "🔴 учневі поїхала правильна відповідь чи пояснення");
  assert.deepEqual(pub.options, [{ i: 2, text: "c" }, { i: 0, text: "a" }, { i: 1, text: "b" }], "🔴 варіанти втратили оригінальний індекс");
  assert.equal(pickQuestions(pool, null, rng).length, 5, "🔴 «усі питання» показало не всі");
  // Пояснення — лише на помилці (правильна відповідь не повторюється й там).
  const byId = new Map(pool.map((q) => [q.id, q]));
  const g = gradePlan([{ questionId: 1, order: null }, { questionId: 2, order: null }], byId, { 1: 1, 2: 0 });
  assert.deepEqual(g.marks, [true, false]);
  assert.equal(g.results[0].explanation, null, "🔴 пояснення на правильній відповіді");
  assert.equal(g.results[1].explanation, "why2", "🔴 на помилці немає пояснення");
});

/** #1654 — сід: 54 питання 5+12+12+15+10 без жодної вади; зламаний сід ловиться (дзеркало). */
test("#1654 ТЕСТ: сід курсу продажу — 54 питання без вад, і перевірка ловить зламаний сід", () => {
  assert.deepEqual(seedProblems(SALES_COURSE_QUIZZES), [], "🔴 у погодженому сіді є вади");
  assert.deepEqual(SALES_COURSE_QUIZZES.quizzes.map((q) => q.questions.length), [5, 12, 12, 15, 10], "🔴 склад тестів не той, що погоджено");
  assert.deepEqual(SALES_COURSE_QUIZZES.quizzes.map((q) => q.module),
    ["Знайомство з компанією", "Логістика", "Міжнародні перевезення", "Продажі", "Ознайомлення з програмами"]);
  const bad: QuizSeed = { course: "x", quizzes: [{ key: "k", module: "m", title: "t", passPct: 80, maxAttempts: 3, intro: "", questions: [
    { key: "a", kind: "one", text: "q", options: ["x", "y"], correct: [5], explanation: "", source: "" },
    { key: "a", kind: "one", text: "q", options: ["x", "y"], correct: [0, 1], explanation: "", source: "" },
  ] }] };
  const p = seedProblems(bad).join(" | ");
  for (const what of ["поза варіантами", "повтор ключа", "з 2 правильними"]) assert.match(p, new RegExp(what), `🔴 вада «${what}» не спіймана`);
});

/** Схема з нуля в тимчасовому кластері. `null` — кластер недоступний (пропуск із причиною). */
async function cluster(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(SCHEMA, "utf8"));
  return { c, url: s.url, done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #1655 — ЖИВИЙ ШЛЯХ КАНДИДАТА обробниками роутера (усе разом, один кластер на файл):
 *  Р1 тест закритий до уроків теми · Р2 тема 2 закрита до складеного тесту · Р5 відповіді не витікають ·
 *  ліміт спроб і «ще спроба» · «опрацював» на тесті 400 · складено = крок «пройдено» · повторне завершення 409 ·
 *  Р6 дзеркало: курс менеджерів — тема 2 відкрита без тесту · редактор бачить курс кандидатів і чернетку тесту.
 */
test("#1655 ЖИВИЙ SQL: тест теми — замки Р1/Р2, без витоку відповідей, спроби, зарахування; курс менеджерів як був", async (t) => {
  const s = await cluster(t); if (!s) return;
  try {
    await s.c.query(`UPDATE training_courses SET published = false`);
    const q = async (sql: string, p: unknown[] = []) => (await s.c.query(sql, p)).rows;
    const course = async (aud: string) => (await q(`INSERT INTO training_courses (title, audience, published) VALUES ($1,$2,true) RETURNING id`, [`К-${aud}`, aud]))[0].id as number;
    const mod = async (cid: number, pos: number) => (await q(`INSERT INTO training_folders (name, course_id, position) VALUES ($1,$2,$3) RETURNING id`, [`Тема ${pos}`, cid, pos]))[0].id as number;
    const mat = async (fid: number, title: string, kind: string, pos: number, status = "published") =>
      (await q(`INSERT INTO training_materials (folder_id, title, kind, position, content, status) VALUES ($1,$2,$3,$4,'т',$5) RETURNING id`, [fid, title, kind, pos, status]))[0].id as number;
    const cc = await course("candidate"), m1 = await mod(cc, 1), m2 = await mod(cc, 2);
    const a1 = await mat(m1, "Урок А", "text", 1);
    const quiz = await mat(m1, "Тест: Тема 1", "quiz", 2);
    const b1 = await mat(m2, "Урок Б", "text", 1);
    const draftQuiz = await mat(m2, "Тест: Тема 2", "quiz", 2, "draft");
    for (let i = 1; i <= 5; i++)
      await q(`INSERT INTO training_quiz_questions (material_id, position, kind, text, options, correct, explanation, source_title) VALUES ($1,$2,'one',$3,'["так","ні"]','[0]',$4,'Урок А')`, [quiz, i, `Питання ${i}`, `Пояснення ${i}`]);
    await q(`INSERT INTO training_quizzes (material_id, pass_pct, max_attempts) VALUES ($1, 80, 3)`, [quiz]);
    // Курс менеджерів для дзеркала Р6: тест не складено, а тема 2 — відкрита.
    const mc = await course("manager"), n1 = await mod(mc, 1), n2 = await mod(mc, 2);
    await mat(n1, "Тест менеджерів", "quiz", 1);
    const mb = await mat(n2, "Урок менеджерів", "text", 1);
    const cand = (await q(`INSERT INTO users (email, password_hash, role, role_override) VALUES ('c@x.ua','x','manager','candidate') RETURNING id`))[0].id as number;
    const mgr = (await q(`INSERT INTO users (email, password_hash, role) VALUES ('m@x.ua','x','manager') RETURNING id`))[0].id as number;
    const ed = (await q(`INSERT INTO users (email, password_hash, role) VALUES ('kvp@x.ua','x','admin') RETURNING id`))[0].id as number;

    Object.assign(process.env, { DATABASE_URL: s.url, JWT_SECRET: "scratch-only", KOMMO_BASE_URL: "http://127.0.0.1:9", KOMMO_API_TOKEN: "scratch" });
    const { trainingRouter } = await import("../routes/training.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();
    const store = await import("./trainingQuizStore.js");
    type H = (req: unknown, res: unknown, next: () => void) => unknown;
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: H }[] } };
    const AS = {
      cand: { userId: cand, roleKey: "candidate", role: "manager", managerId: -1, teamId: -1 },
      mgr: { userId: mgr, roleKey: "manager", role: "manager", managerId: -1, teamId: -1 },
      ed: { userId: ed, roleKey: "kvp", role: "admin", managerId: null, teamId: null },
    };
    const call = async (who: keyof typeof AS, method: string, p: string, params: Record<string, string> = {}, body: Record<string, unknown> = {}) => {
      const layer = (trainingRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === p && l.route.methods[method]);
      assert.ok(layer, `🔴 роуту ${method.toUpperCase()} ${p} немає`);
      const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
      let done = false;
      const res = { status(x: number) { out.code = x; return res; }, json(b: Record<string, unknown>) { out.body = b; done = true; return res; } };
      for (const h of layer!.route!.stack) { let next = false; await h.handle({ auth: AS[who], params, body }, res, () => { next = true; }); if (done || !next) break; }
      return out;
    };
    const id = (x: number) => ({ id: String(x) });
    /** Пройти відкриту спробу до кінця по одному питанню (⏱ 28.10.2026): перші `right` — правильно (варіант 0 = «так»). */
    const finish = async (step: { code: number; body: Record<string, unknown> }, right: number) => {
      let r = step, i = 0;
      while (r.code === 200 && r.body.done === false) {
        assert.ok(!/"correct"|Пояснення/.test(JSON.stringify(r.body)), "🔴 Р5: питання поїхало з правильною відповіддю чи поясненням");
        r = await call("cand", "post", "/quiz/:id/answer", id(quiz),
          { attemptId: r.body.attemptId, questionId: (r.body.question as { id: number }).id, answer: i++ < right ? 0 : 1 });
      }
      assert.equal(r.code, 200, `🔴 спроба не завершилась: ${JSON.stringify(r.body)}`);
      return r.body.result as Record<string, unknown>;
    };
    try {
      // Р1: тест закритий, доки урок теми не пройдено.
      assert.equal((await call("cand", "post", "/quiz/:id/start", id(quiz))).code, 423, "🔴 Р1: тест відкрився до уроків теми");
      // Р2: урок теми 2 закритий (сервер, а не лише екран).
      assert.equal((await call("cand", "get", "/material/:id", id(b1))).code, 423, "🔴 Р2: тема 2 відкрита без тесту теми 1");
      assert.equal((await call("cand", "post", "/progress/:materialId/done", { materialId: String(a1) })).code, 200);
      assert.equal((await call("cand", "post", "/progress/:materialId/done", { materialId: String(quiz) })).code, 400, "🔴 «Опрацював» зарахував тест");

      // Спроба 1: без витоку відповідей.
      const st1 = await call("cand", "post", "/quiz/:id/start", id(quiz));
      assert.equal(st1.code, 200, `🔴 тест не почався: ${JSON.stringify(st1.body)}`);
      const raw = JSON.stringify(st1.body);
      assert.ok(!/correct|explanation|Пояснення/.test(raw), "🔴 Р5: учневі поїхала правильна відповідь чи пояснення");
      const me = await call("cand", "get", "/quiz/:id/me", id(quiz));
      assert.ok(!/correct|Питання 1/.test(JSON.stringify(me.body)), "🔴 «мій стан» віддав питання");
      for (const p of ["/courses/:id", "/material/:id"]) {
        const r = await call("cand", "get", p, id(p === "/courses/:id" ? cc : quiz));
        assert.ok(!/"correct"|Пояснення 1/.test(JSON.stringify(r.body)), `🔴 ${p} віддав відповіді тесту`);
      }
      const r1 = await finish(st1, 3);
      assert.deepEqual([r1.right, r1.passed, r1.left], [3, false, 2], "🔴 3 з 5 — не той результат");
      assert.equal((await call("cand", "post", "/quiz/:id/submit", id(quiz), { attemptId: st1.body.attemptId, answers: {} })).code, 409, "🔴 ту саму спробу завершено двічі");
      assert.equal((await call("cand", "get", "/material/:id", id(b1))).code, 423, "🔴 несклалений тест відкрив тему 2");
      const prog = (await q(`SELECT status FROM training_progress WHERE user_id=$1 AND material_id=$2`, [cand, quiz]))[0]?.status;
      assert.notEqual(prog, "done", "🔴 несклалений тест зараховано кроком");

      // Ще 2 провали → спроби вичерпано → 409; «ще спроба» — одна.
      for (let k = 0; k < 2; k++) {
        await finish(await call("cand", "post", "/quiz/:id/start", id(quiz)), 1);
      }
      assert.equal((await call("cand", "post", "/quiz/:id/start", id(quiz))).code, 409, "🔴 четверта спроба без дозволу");
      await store.grantAttempt(s.c as unknown as import("./trainingQuizStore.js").QuizDb, ed, cand, quiz, "переглянули уроки");
      await assert.rejects(store.grantAttempt(s.c as unknown as import("./trainingQuizStore.js").QuizDb, ed, cand, quiz, null), /ще є спроби/, "🔴 «ще спроба» видана, коли спроби ще є");

      // Складено → крок «пройдено» → тема 2 відкрита; новий старт — 409.
      const st4 = await call("cand", "post", "/quiz/:id/start", id(quiz));
      assert.equal(st4.code, 200, "🔴 видана спроба не дала почати");
      const r4 = await finish(st4, 5);
      assert.deepEqual([r4.passed, r4.pct], [true, 100]);
      assert.equal((await q(`SELECT status FROM training_progress WHERE user_id=$1 AND material_id=$2`, [cand, quiz]))[0].status, "done", "🔴 складений тест не зарахований кроком");
      assert.equal((await call("cand", "get", "/material/:id", id(b1))).code, 200, "🔴 складений тест не відкрив тему 2");
      assert.equal((await call("cand", "post", "/quiz/:id/start", id(quiz))).code, 409, "🔴 складений тест починається знову");
      const sum = (await store.quizSummaries(s.c as unknown as import("./trainingQuizStore.js").QuizDb, [cand], [quiz])).get(cand)![0];
      assert.deepEqual([sum.used, sum.grants, sum.passed, sum.bestPct], [4, 1, true, 100], "🔴 «Найм» бачить не ті спроби");

      // Р6 дзеркало: курс менеджерів — тема 2 відкрита, хоч тест теми 1 не складено.
      assert.equal((await call("mgr", "get", "/material/:id", id(mb))).code, 200, "🔴 Р6: курс менеджерів став послідовним");
      // Редактор відкриває курс кандидатів і бачить чернетку тесту; кандидат — ні.
      const edc = await call("ed", "get", "/courses/:id", id(cc));
      assert.equal(edc.code, 200, "🔴 редактор не відкриває курс кандидатів");
      assert.ok(JSON.stringify(edc.body).includes(`"id":${draftQuiz}`), "🔴 редактор не бачить чернетки тесту в курсі");
      assert.ok(!JSON.stringify((await call("cand", "get", "/courses/:id", id(cc))).body).includes(`"id":${draftQuiz}`), "🔴 кандидат бачить чернетку");
      const edq = await call("ed", "get", "/quiz/:id/editor", id(quiz));
      assert.ok(JSON.stringify(edq.body).includes('"correct"'), "🔴 редактор не бачить правильних відповідей");
    } finally { (await import("../db/pool.js")).pool.end().catch(() => undefined); }
  } finally { await s.done(); }
});

/** #1656 — імпорт: 5 тестів і 54 питання чернетками, тест — останній крок теми; повтор нічого не дублює; --dry не пише. */
test("#1656 ЖИВИЙ SQL: імпорт тестів — чернетками, останнім кроком теми, повтор без дублів, --dry без запису", async (t) => {
  const s = await cluster(t); if (!s) return;
  try {
    const { importQuizzes } = await import("./quizImport.js");
    const db = s.c as unknown as import("./trainingQuizStore.js").QuizDb;
    const c = (await s.c.query(`INSERT INTO training_courses (title, audience, published) VALUES ($1, 'manager', false) RETURNING id`, [SALES_COURSE_QUIZZES.course])).rows[0].id;
    for (const [i, q] of SALES_COURSE_QUIZZES.quizzes.entries()) {
      const f = (await s.c.query(`INSERT INTO training_folders (name, course_id, position) VALUES ($1,$2,$3) RETURNING id`, [q.module, c, i + 1])).rows[0].id;
      await s.c.query(`INSERT INTO training_materials (folder_id, title, kind, position) VALUES ($1,'Урок 1','text',5),($1,'Урок 2','text',9)`, [f]);
    }
    const dry = await importQuizzes(db, SALES_COURSE_QUIZZES, { write: false });
    assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM training_quiz_questions`)).rows[0].n, 0, "🔴 --dry записав питання");
    assert.ok(dry.lines.every((l) => l.created && l.materialId == null));
    const w1 = await importQuizzes(db, SALES_COURSE_QUIZZES, { write: true });
    assert.deepEqual(w1.lines.map((l) => l.inserted), [5, 12, 12, 15, 10]);
    const quizzes = (await s.c.query(`SELECT m.id, m.status, m.position, m.folder_id FROM training_materials m WHERE m.kind = 'quiz' ORDER BY m.id`)).rows;
    assert.equal(quizzes.length, 5, "🔴 тестів не 5");
    assert.ok(quizzes.every((x) => x.status === "draft"), "🔴 тест опубліковано автоматично");
    assert.ok(quizzes.every((x) => x.position === 10), "🔴 тест не останній крок теми (після уроку з позицією 9)");
    assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM training_quiz_questions`)).rows[0].n, 54);
    const w2 = await importQuizzes(db, SALES_COURSE_QUIZZES, { write: true });
    assert.ok(w2.lines.every((l) => !l.created && l.inserted === 0), "🔴 повторний імпорт створив нове");
    assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM training_quiz_questions`)).rows[0].n, 54, "🔴 повторний імпорт задублював питання");
    assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM training_materials WHERE kind = 'quiz'`)).rows[0].n, 5, "🔴 повторний імпорт задублював тести");
  } finally { await s.done(); }
});

/** #1657 — екрани: тест відкривається екраном `QuizView` у кандидата й у перегляді курсу; заглушки «екзамену» немає. */
test("#1657 ТЕСТ: екрани — QuizView у кандидата й у курсі, «Найм» показує тести, заглушки екзамену немає", () => {
  const cand = FE("pages/dashboard/sections/CandidateTraining.tsx");
  const course = FE("pages/dashboard/sections/TrainingCourses.tsx");
  const hiring = FE("pages/dashboard/sections/HiringTraining.tsx");
  const view = FE("pages/dashboard/sections/QuizView.tsx");
  assert.match(cand, /<QuizView\b/, "🔴 кандидат не бачить екран тесту");
  assert.ok((course.match(/<QuizView\b/g) ?? []).length >= 2, "🔴 у перегляді курсу (урок і панель) тест не відкривається");
  assert.match(course, /<QuizEditorPanel\b/, "🔴 редактор не бачить питань тесту");
  for (const [n, src] of [["кандидат", cand], ["Найм", hiring]] as const)
    assert.doesNotMatch(src, /зʼявиться разом з екзаменом|в проході 2c\./, `🔴 у «${n}» лишилась заглушка екзамену`);
  assert.match(hiring, /Тести за темами/, "🔴 у таблиці «На навчанні» немає колонки тестів");
  // Учнівський екран не знає правильних відповідей: тип відповіді сервера їх не має.
  const learner = view.slice(0, view.indexOf("export function QuizEditorPanel"));
  assert.doesNotMatch(learner, /\.correct\b/, "🔴 екран учня читає правильну відповідь");
});
