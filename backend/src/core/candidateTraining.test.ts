import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🎓 НАВЧАННЯ ОЧИМА КАНДИДАТА (найм, прохід 2b, 18.09.2026) — гейти `#545`–`#547`.
 * Номери з запасом над `#543` (редактор навчання) — борг 17: перед мержем перемірити перетин.
 */

const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const SRC = (rel: string): string => readFileSync(path.join(ROOT, "backend", "src", rel), "utf8");
const FE = (rel: string): string => readFileSync(path.join(ROOT, "frontend", "src", rel), "utf8");

/** Схема з нуля, курс кандидата з модулем і трьома кроками, кандидат і сторонній користувач. */
async function scratch(t: { skip: (m: string) => void }) {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return null; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
  await c.query("INSERT INTO teams(id,name) VALUES (1,'РПК · Дмитрук') ON CONFLICT DO NOTHING");
  await c.query(`UPDATE training_courses SET published = false`);
  const course = (await c.query(`INSERT INTO training_courses (title, audience, published) VALUES ('Старт кандидата','candidate',true) RETURNING id`)).rows[0].id;
  const mod = (await c.query(`INSERT INTO training_folders (name, course_id, position) VALUES ('День 1', $1, 1) RETURNING id`, [course])).rows[0].id;
  const [m1, m2, m3] = (await c.query(`INSERT INTO training_materials (folder_id, title, kind, position, content) VALUES
    ($1,'Хто такі UTS','text',1,'Текст про компанію'), ($1,'Скрипт першого дзвінка','text',2,'Текст скрипту'),
    ($1,'Заперечення про ціну','text',3,'Текст про ціну') RETURNING id`, [mod])).rows.map((r) => r.id as number);
  return { c, url: s.url, db: c as unknown as import("./hiring.js").Db, m1, m2, m3, done: async () => { await c.end(); s.dispose(); } };
}

/**
 * #545 — ВМІСТ ЗАМКНЕНОГО КРОКУ НЕ ВІДДАЄТЬСЯ. Замок рахує `stepLockedBy` — та сама функція, що в
 * «відкрив» і «опрацював»; роут вмісту кличе її ДО відповіді й відповідає 423 з назвою кроку, що
 * тримає замок. Дзеркало: відкритий крок віддається, а пройдений перший відмикає другий.
 * 🧨 Червоніє, якщо віддати вміст замкненого кроку, не назвати, що тримає, або прибрати перевірку з роуту.
 */
test("#545 ЗАМОК: вміст замкненого кроку не віддається, відкритого — віддається", async (t) => {
  const s = await scratch(t); if (!s) return;
  const { stepLockedBy } = await import("./trainingLock.js");
  try {
    const uid = (await s.c.query(`INSERT INTO users (email, password_hash, role, role_override) VALUES ('k@x.ua','x','manager','candidate') RETURNING id`)).rows[0].id;
    assert.equal(await stepLockedBy(s.db, uid, s.m1), null, "🔴 перший крок замкнено");
    assert.deepEqual(await stepLockedBy(s.db, uid, s.m2), { materialId: s.m1, title: "Хто такі UTS" }, "🔴 другий крок відкритий без першого або не названо, що тримає");
    await s.c.query(`INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())`, [uid, s.m1]);
    assert.equal(await stepLockedBy(s.db, uid, s.m2), null, "🔴 пройдений перший крок не відімкнув другий");
    assert.deepEqual(await stepLockedBy(s.db, uid, s.m3), { materialId: s.m2, title: "Скрипт першого дзвінка" });

    // 🔴 РОУТ — ВИКЛИКОМ СПРАВЖНЬОГО ОБРОБНИКА, а не читанням тексту: перевірка на присутність
    // рядка пропустила б «423 під умовою, що ніколи не виконується». Пул — на цьому ж scratch-кластері
    // (окремий процес тест-файла, до цього імпорту пул тут не створювався).
    Object.assign(process.env, { DATABASE_URL: s.url, JWT_SECRET: "scratch-only", KOMMO_BASE_URL: "http://127.0.0.1:9", KOMMO_API_TOKEN: "scratch" });
    const { trainingRouter } = await import("../routes/training.js");
    const layer = (trainingRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] } }[] })
      .stack.find((l) => l.route?.path === "/material/:id" && l.route.methods.get);
    assert.ok(layer, "🔴 роуту вмісту кроку немає");
    const call = async (materialId: number) => {
      const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
      const res = { status(c: number) { out.code = c; return res; }, json(b: Record<string, unknown>) { out.body = b; return res; } };
      await layer.route!.stack.at(-1)!.handle({ auth: { userId: uid, roleKey: "candidate", role: "manager", managerId: -1, teamId: -1 }, params: { id: String(materialId) } }, res, () => undefined);
      return out;
    };
    try {
      const locked = await call(s.m3);
      assert.equal(locked.code, 423, "🔴 вміст замкненого кроку віддано");
      assert.equal((locked.body.blockedBy as { title?: string } | undefined)?.title, "Скрипт першого дзвінка", "🔴 не названо крок, що тримає замок");
      assert.equal(locked.body.content, undefined, "🔴 у відповіді 423 є текст кроку");
      const open = await call(s.m2);
      assert.deepEqual([open.code, open.body.content], [200, "Текст скрипту"], "🔴 відкритий крок не віддається");
    } finally { (await import("../db/pool.js")).pool.end().catch(() => undefined); }

    // і роут не має власної копії замка
    const src = SRC("routes/training.ts");
    assert.match(src, /const lockedReason = \(uid: number, materialId: number\) => stepLockedBy\(/, "🔴 роут має власну копію замка");
  } finally { await s.done(); }
});

/**
 * #546 — «МОЄ НАВЧАННЯ» == РЯДОК ДОШКИ. День, строк і прогрес кандидата рахує та сама функція, що
 * бачить рекрутер на «На навчанні»; ключ — користувач токена, чужого не видно; не-кандидат — null.
 * 🧨 Червоніє, якщо рахувати строк другою копією формули, віддати чужого або брати «чий» із запиту.
 */
test("#546 ЖИВИЙ SQL: «моє навчання» кандидата == рядок дошки; чужого не видно", async (t) => {
  const s = await scratch(t); if (!s) return;
  const h = await import("./hiring.js");
  const tr = await import("./hiringTraining.js");
  try {
    const vac = await h.createVacancy(s.db, null, { title: "Сейлз РПК" });
    const id = await h.createCandidate(s.db, null, { fullName: "Білик Яна", phone: "0970000301", vacancyId: vac });
    for (const to of ["planned", "done"]) await h.changeStatus(s.db, null, id, { to, comment: "так" }, "edit", null);
    await h.changeStatus(s.db, null, id, { to: "lead", comment: "до тімліда", teamId: 1 }, "edit", null);
    await h.changeStatus(s.db, null, id, { to: "candidate", comment: "беремо" }, "lead", 1);
    const uid = (await s.c.query(`SELECT user_id FROM hiring_candidates WHERE id=$1`, [id])).rows[0].user_id as number;
    await tr.noteCandidateLogin(s.db, uid);
    await s.c.query(`INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())`, [uid, s.m1]);
    await s.c.query(`INSERT INTO users (email, password_hash, role, team_id, full_name) VALUES ('lead@x.ua','x','team_lead',1,'Дмитрук Василь')`);

    const now = new Date();
    const self = await tr.candidateSelf(s.db, uid, now);
    const row = (await tr.trainingBoard(s.db, "edit", null, now, id))[0];
    assert.ok(self, "🔴 кандидат не бачить свого навчання");
    assert.deepEqual([self.day, self.days, self.deadline, self.done, self.total, self.percent],
      [row.day, row.days, row.deadline, row.done, row.total, row.percent], "🔴 кандидат і дошка бачать різні числа");
    assert.deepEqual([self.done, self.total], [1, 3]);
    assert.equal(self.leadName, "Дмитрук Василь", "🔴 не знайдено тімліда команди");

    const stranger = (await s.c.query(`INSERT INTO users (email, password_hash, role) VALUES ('m@x.ua','x','manager') RETURNING id`)).rows[0].id;
    assert.equal(await tr.candidateSelf(s.db, stranger, now), null, "🔴 не-кандидат отримав чуже навчання");

    const route = SRC("routes/candidateTraining.ts");
    assert.match(route, /candidateSelf\(pool as unknown as Db, req\.auth!\.userId\)/, "🔴 «чиє навчання» береться не з токена");
    assert.doesNotMatch(route, /req\.(params|query|body)/, "🔴 роут читає «чий» із запиту");
  } finally { await s.done(); }
});

/**
 * #547 — ВИБІР ЕКРАНА «НАВЧАННЯ»: кандидат — курс по кроках, будь-яка інша роль — бібліотека.
 * Правило фронту ВИКОНУЄТЬСЯ (transpile), а не читається очима; плюс «Навчання» справді на ньому гілкується.
 * 🧨 Червоніє, якщо показати курсовий вигляд менеджерам чи лишити кандидата з деревом.
 */
test("#547 ЕКРАН: кандидат бачить курс, решта ролей — бібліотеку", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE("pages/dashboard/trainingView.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { trainingViewFor } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  assert.equal(trainingViewFor("candidate"), "candidate", "🔴 кандидат лишився з деревом бібліотеки");
  for (const r of ["admin", "ceo", "opdir", "kvp", "financier", "hr", "team_lead", "manager", "____________", "", undefined])
    assert.equal(trainingViewFor(r), "library", `🔴 роль ${String(r)} отримала екран кандидата`);

  const sec = FE("pages/dashboard/sections/TrainingSection.tsx");
  assert.match(sec, /if \(trainingViewFor\(roleKey\) === "candidate"\) return <CandidateTraining \/>;/, "🔴 «Навчання» не гілкується за правилом");
  assert.match(FE("pages/Dashboard.tsx"), /<TrainingSection isAdmin=\{[^}]+\} roleKey=\{auth\?\.roleKey\} \/>/, "🔴 роль не передається в «Навчання»");
});
