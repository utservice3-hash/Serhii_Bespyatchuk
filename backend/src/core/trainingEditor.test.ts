import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { attachVerdict, requiredValue, moduleStats, courseModules, freeModules, type EditorFolder } from "./trainingEditor.js";
import { orderedMaterials, materialStates, coursePercent } from "./trainingProgress.js";

/**
 * 🧩 РЕДАКТОР НАВЧАННЯ (17.09.2026) — гейти `#540`–`#543`.
 * Номери з запасом над `#537` (найвищий у гілках найму) — борг 17: перед мержем перемірити перетин.
 */

const SRC = (rel: string): string =>
  readFileSync(path.join(import.meta.dirname, "..", "..", "..", "backend", "src", rel), "utf8");

const F = (id: number, parentId: number | null, courseId: number | null, name = `f${id}`, position = id): EditorFolder =>
  ({ id, parentId, courseId, name, position });
const M = (id: number, folderId: number, position: number, required = true) => ({ id, folderId, position, required });

/**
 * #540 — МОДУЛЕМ КУРСУ МОЖЕ БУТИ ЛИШЕ КОРЕНЕВА ПАПКА, А «ПРИБРАТИ З КУРСУ» ≠ «ВИДАЛИТИ».
 * Вкладена папка — група всередині модуля: якби вона теж ставала модулем, той самий матеріал
 * потрапив би в курс двічі й двічі порахувався б у відсотку.
 * Переїзд модуля з чужого курсу — лише явним підтвердженням: інакше той курс мовчки худне.
 * 🧨 Червоніє, якщо дозволити вкладену папку, мовчазний переїзд або зникнення неіснуючого курсу.
 */
test("#540 МОДУЛЬ: лише коренева папка, чужий курс — з підтвердженням, відчепити можна завжди", () => {
  const root = F(1, null, null, "День 1"), sub = F(2, 1, null, "Відео"), other = F(3, null, 7, "День 2");
  assert.equal(attachVerdict({ folder: root, courseId: 5, courseExists: true }).ok, true);
  const nested = attachVerdict({ folder: sub, courseId: 5, courseExists: true });
  assert.equal(nested.ok, false, "🔴 вкладена папка стала модулем курсу");
  assert.match((nested as { reason: string }).reason, /верхнього рівня/);
  assert.equal(attachVerdict({ folder: null, courseId: 5, courseExists: true }).ok, false, "🔴 неіснуюча папка привʼязалась");
  assert.equal((attachVerdict({ folder: root, courseId: 5, courseExists: false }) as { status: number }).status, 404, "🔴 привʼязка до неіснуючого курсу");
  const move = attachVerdict({ folder: other, courseId: 5, courseExists: true, currentCourseName: "Старт кандидата" });
  assert.equal(move.ok, false, "🔴 модуль переїхав з чужого курсу мовчки");
  assert.equal((move as { status: number }).status, 409);
  assert.match((move as { reason: string }).reason, /Старт кандидата/, "🔴 не названо курс, який залишиться без модуля");
  assert.equal(attachVerdict({ folder: other, courseId: 5, courseExists: true, force: true }).ok, true, "🔴 підтверджений переїзд не проходить");
  // відчепити можна завжди, навіть вкладену чи ту, що в чужому курсі
  for (const f of [root, sub, other])
    assert.equal(attachVerdict({ folder: f, courseId: null, courseExists: false }).ok, true, "🔴 «прибрати з курсу» заблоковано");

  // 🔴 ФІКСТУРА МУСИТЬ МАТИ ВКЛАДЕНУ ПАПКУ З ТИМ САМИМ `course_id` — інакше «лише коренева»
  // нічого не перевіряє (правило 11). Спіймано саботажем: без цього рядка зняття фільтра
  // `parentId === null` у `courseModules` лишалось зеленим.
  const group = F(5, 4, 5, "Група відео");
  const folders = [root, other, F(4, null, 5, "День 3"), sub, group];
  assert.deepEqual(courseModules(folders, 5).map((f) => f.id), [4], "🔴 у модулі курсу потрапила не та папка");
  assert.deepEqual(freeModules(folders).map((f) => f.id), [1], "🔴 вільні модулі рахуються неправильно");
});

/**
 * #541 — НЕОБОВʼЯЗКОВИЙ КРОК НЕ ТРИМАЄ ЗАМОК І НЕ ВХОДИТЬ У ЗНАМЕННИК; перемикач приймає
 * ЛИШЕ булеве (рядок «false» із форми не має стати правдою — правило 7 у CLAUDE.md).
 * Дзеркало: той самий крок обовʼязковим — замок стоїть і знаменник росте.
 * 🧨 Червоніє, якщо зрівняти обовʼязкові з рештою або приймати «false» рядком.
 */
test("#541 ОБОВʼЯЗКОВІСТЬ: необовʼязковий не замикає й не рахується; перемикач лише булевий", () => {
  const folders = [F(1, null, 9, "День 1")];
  const opt = [M(10, 1, 1, true), M(11, 1, 2, false), M(12, 1, 3, true)];
  const all = [M(10, 1, 1, true), M(11, 1, 2, true), M(12, 1, 3, true)];
  const done = new Map<number, "opened" | "done">([[10, "done"]]);

  const st = materialStates(orderedMaterials(1, folders.map((f) => ({ id: f.id, parentId: f.parentId, position: f.position })), opt), done);
  assert.deepEqual(st.map((s) => s.state), ["done", "available", "available"], "🔴 необовʼязковий крок тримає замок");
  assert.equal(coursePercent(orderedMaterials(1, folders.map((f) => ({ id: f.id, parentId: f.parentId, position: f.position })), opt), done), 50);

  const st2 = materialStates(orderedMaterials(1, folders.map((f) => ({ id: f.id, parentId: f.parentId, position: f.position })), all), done);
  assert.deepEqual(st2.map((s) => s.state), ["done", "available", "locked"], "🔴 обовʼязковий крок перестав тримати замок");
  assert.equal(coursePercent(orderedMaterials(1, folders.map((f) => ({ id: f.id, parentId: f.parentId, position: f.position })), all), done), 33);

  assert.deepEqual(moduleStats(1, folders, opt), { steps: 3, required: 2 }, "🔴 лічильник кроків модуля не збігається з курсом");
  assert.equal(requiredValue(true), true);
  assert.equal(requiredValue(false), false);
  for (const bad of ["false", "true", 0, 1, null, undefined, {}])
    assert.equal(requiredValue(bad), null, `🔴 ${JSON.stringify(bad)} прийнято як перемикач`);
});

/**
 * #542 — ЖИВИЙ SQL: курс для кандидата з редактора доїжджає до кандидата ЦІЛИМ.
 * Схема з нуля → курс «кандидат» + модуль + 2 обовʼязкові й 1 необовʼязковий крок → кандидат
 * бачить рівно ці кроки, знаменник 2, а неопублікований курс не показується взагалі.
 * 🧨 Червоніє, якщо показати чернетку курсу, загубити привʼязку модуля або збити знаменник.
 */
test("#542 ЖИВИЙ SQL: курс для кандидата з модулем і необовʼязковим кроком доїжджає до кандидата", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const scratch = provisionScratch();
  if ("unavailable" in scratch) return t.skip(skipReason(scratch));
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: scratch.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    await c.query(`UPDATE training_courses SET published = false`); // лишаємо лише свій курс
    const course = (await c.query<{ id: number }>(
      `INSERT INTO training_courses (title, audience, published, position) VALUES ('Старт кандидата','candidate',true,1) RETURNING id`)).rows[0].id;
    const draft = (await c.query<{ id: number }>(
      `INSERT INTO training_courses (title, audience, published, position) VALUES ('Чернетка','candidate',false,2) RETURNING id`)).rows[0].id;
    const mod = (await c.query<{ id: number }>(`INSERT INTO training_folders (name, position) VALUES ('День 1', 1) RETURNING id`)).rows[0].id;
    const group = (await c.query<{ id: number }>(`INSERT INTO training_folders (name, parent_id, position) VALUES ('Відео', $1, 1) RETURNING id`, [mod])).rows[0].id;
    await c.query(`INSERT INTO training_materials (folder_id, title, kind, position, required) VALUES
      ($1,'Хто такі UTS','text',1,true), ($1,'Необовʼязкове читання','text',2,false)`, [mod]);
    // 🔴 БЕЗ `required` — перевіряємо ЗАМОВЧУВАННЯ схеми. Якби воно було `false`, кожен новий
    // матеріал ставав би необовʼязковим, курс «завершувався» б на нулі кроків, і помітили б це
    // вже на живому кандидаті. Спіймано саботажем: явні значення в кожному рядку це ховали.
    await c.query(`INSERT INTO training_materials (folder_id, title, kind, position) VALUES ($1,'Скрипт дзвінка','text',1)`, [group]);
    // модуль кладемо в курс рівно так, як це робить роут
    await c.query(`UPDATE training_folders SET course_id = $1 WHERE id = $2`, [course, mod]);

    const folders = (await c.query<{ id: number; parent_id: number | null; name: string; position: number; course_id: number | null }>(
      `SELECT id, parent_id, name, position, course_id FROM training_folders`)).rows;
    const materials = (await c.query<{ id: number; folder_id: number; position: number; required: boolean }>(
      `SELECT id, folder_id, position, required FROM training_materials WHERE status = 'published'`)).rows;
    const eF = folders.map((f) => ({ id: f.id, parentId: f.parent_id, courseId: f.course_id, name: f.name, position: f.position }));
    const mRows = materials.map((m) => ({ id: m.id, folderId: m.folder_id, position: m.position, required: m.required }));

    assert.deepEqual(courseModules(eF, course).map((f) => f.id), [mod], "🔴 модуль не привʼязався до курсу");
    assert.deepEqual(moduleStats(mod, eF, mRows), { steps: 3, required: 2 }, "🔴 склад модуля порахований неправильно");
    assert.deepEqual(freeModules(eF).map((f) => f.id), [], "🔴 привʼязаний модуль лишився у «вільних»");
    assert.deepEqual(courseModules(eF, draft).map((f) => f.id), [], "🔴 чернетка курсу забрала чужий модуль");

    // очима кандидата: ті самі рядки, що бере роут
    const visible = (await c.query<{ id: number; title: string }>(
      `SELECT id, title FROM training_courses WHERE audience = ANY($1) AND published ORDER BY position, id`,
      [["candidate", "all"]])).rows;
    assert.deepEqual(visible.map((x) => x.title), ["Старт кандидата"], "🔴 кандидат бачить не той набір курсів (чернетка або курс менеджера)");
    const ordered = orderedMaterials(mod, eF.map((f) => ({ id: f.id, parentId: f.parentId, position: f.position })), mRows);
    assert.equal(ordered.length, 3, "🔴 матеріали групи всередині модуля загубились");
    const doneAll = new Map<number, "opened" | "done">(ordered.filter((m) => m.required).map((m) => [m.id, "done"]));
    assert.equal(coursePercent(ordered, doneAll), 100, "🔴 необовʼязковий крок не дає завершити курс");
  } finally { await c.end(); scratch.dispose(); }
});

/**
 * #543 — РЕДАГУВАННЯ НАВЧАННЯ — ПРАВО, А НЕ РІВЕНЬ. Курс, модуль і обовʼязковість змінює лише
 * `manage_training`; рекрутер, тімлід і менеджер — ні, КВП — так (рішення власника 14.09.2026).
 * 🧨 Червоніє, якщо зняти гейт із нового запису або розсипати право іншим ролям.
 */
test("#543 ПРАВО: курс, модуль і обовʼязковість змінює лише manage_training", () => {
  const src = SRC("routes/training.ts");
  for (const [method, route] of [["post", "/courses"], ["patch", "/courses/:id"], ["patch", "/folder/:id"], ["patch", "/material/:id"]])
    assert.match(src, new RegExp(`trainingRouter\\.${method}\\("${route.replace(/[/:]/g, (m) => "\\" + m)}", canEditTraining`),
      `🔴 ${method.toUpperCase()} ${route} без перевірки права manage_training`);
  assert.match(src, /const canEditTraining = requirePerm\("manage_training"\)/, "🔴 право редагування підмінено роллю");

  const sql = SRC("db/schema.sql");
  const give = /UPDATE roles SET permissions = permissions \|\| '\{"manage_training": true\}'::jsonb\s*\n\s*WHERE key IN \(([^)]*)\)/.exec(sql);
  assert.ok(give, "🔴 у схемі немає видачі manage_training");
  const roles = give[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(roles, ["admin", "ceo", "kvp", "opdir"], `🔴 склад ролей із правом змінився: ${roles.join(", ")}`);
  assert.match(sql, /UPDATE roles SET permissions = permissions - 'manage_training'\s*\n\s*WHERE key NOT IN/, "🔴 зняття права в решти ролей прибрано");
});
