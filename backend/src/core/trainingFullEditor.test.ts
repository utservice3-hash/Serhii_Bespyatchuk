import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ✏️ ПОВНИЙ РЕДАКТОР УРОКІВ (28.09.2026) — гейти `#737`–`#739`.
 * Роман: «хочеться повне редагування уроків, зміна пдф, та зміна інших файлів, зміна порядку, текст файл і тд,
 * повний редактор». Досі урок можна було лише перейменувати: файл не замінювався, частину до уроку не додати,
 * порядок міняли числом у полі, а замкнений урок редактор не міг навіть відкрити.
 *
 * Один scratch-кластер на весь файл (правило «тест, що піднімає власний кластер…»): живі гейти — підтестами.
 */
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

/**
 * #737 — ЧАСТИНА ДОДАЄТЬСЯ ЛИШЕ ДО УРОКУ, У ЙОГО ТЕМУ, З РОЛЛЮ З ПЕРЕЛІКУ. Приклади по обидва боки межі (правило 11).
 * 🧨 Червоніє, якщо дозволити частину частини, чужу тему чи довільну роль.
 */
test("#737 ЧАСТИНА УРОКУ: лише до уроку, у його тему, роль main або attachment", async () => {
  const { partVerdict } = await import("./trainingLesson.js");
  const ok = partVerdict({ id: 5, folderId: 9, lessonId: null }, "attachment");
  assert.deepEqual(ok, { ok: true, folderId: 9, role: "attachment" }, "🔴 урок не приймає частину або кладе її не в свою тему");
  assert.equal(partVerdict({ id: 5, folderId: 9, lessonId: null }, "main").ok, true);
  const nested = partVerdict({ id: 6, folderId: 9, lessonId: 5 }, "main");
  assert.equal(nested.ok, false, "🔴 частину додано до частини — урок отримав другий рівень");
  assert.equal(partVerdict({ id: 5, folderId: 9, lessonId: null }, "cover").ok, false, "🔴 прийнято роль поза переліком");
  assert.equal(partVerdict(null, "main").ok, false, "🔴 частину додано до неіснуючого уроку");
});

/**
 * #739 — ПОРЯДОК ПРИЙМАЄТЬСЯ ЛИШЕ ПОВНИМ ПЕРЕЛІКОМ СУСІДІВ. Частковий переставив би названих і лишив би решту з тими
 * самими номерами — порядок тоді вирішував би `id`, а не людина.
 * 🧨 Червоніє, якщо прийняти неповний, зайвий чи з повторами перелік — або відмовити повному.
 */
test("#739 ПОРЯДОК: лише повний перелік сусідів, без повторів і чужих", async () => {
  const { reorderVerdict } = await import("./trainingEditor.js");
  assert.deepEqual(reorderVerdict([1, 2, 3], [3, 1, 2]), { ok: true, ids: [3, 1, 2] }, "🔴 повний перелік відхилено");
  assert.equal(reorderVerdict([1, 2, 3], [3, 1]).ok, false, "🔴 прийнято неповний перелік");
  assert.equal(reorderVerdict([1, 2, 3], [3, 1, 2, 4]).ok, false, "🔴 прийнято чужий id");
  assert.equal(reorderVerdict([1, 2, 3], [3, 3, 1]).ok, false, "🔴 прийнято повтор");
  assert.equal(reorderVerdict([1, 2, 3], "3,1,2").ok, false, "🔴 прийнято не масив");
});

/**
 * #739b — ↑/↓ МІНЯЄ МІСЦЯМИ РІВНО ДВОХ СУСІДІВ; за край не виходить; чужий id — відмова.
 * 🧨 Червоніє, якщо рух переставить не того, вийде за край чи прийме довільний крок.
 */
test("#739b ПОРЯДОК: ↑/↓ міняє рівно двох сусідів і не виходить за край", async () => {
  const { moveInOrder } = await import("./trainingEditor.js");
  assert.deepEqual(moveInOrder([1, 2, 3], 2, -1), [2, 1, 3], "🔴 ↑ переставив не тих");
  assert.deepEqual(moveInOrder([1, 2, 3], 2, 1), [1, 3, 2], "🔴 ↓ переставив не тих");
  assert.equal(moveInOrder([1, 2, 3], 1, -1), null, "🔴 перший пішов вище за край");
  assert.equal(moveInOrder([1, 2, 3], 3, 1), null, "🔴 останній пішов нижче за край");
  assert.equal(moveInOrder([1, 2, 3], 9, 1), null, "🔴 рух чужого id");
  assert.equal(moveInOrder([1, 2, 3], 2, 2), null, "🔴 прийнято крок не на одне місце");
});

/**
 * #737c — ЕКРАН РЕДАКТОРА КЛИЧЕ САМЕ ЦІ МОЖЛИВОСТІ: порядок — рухом на сервері (а не номером з екрана), файл —
 * заміною в уроці Й у частині, частина — через «+ Частина», а редагування уроку не ставить йому «відкрито».
 * 🧨 Червоніє, якщо повернути `position` з екрана, прибрати заміну файлу з частин чи «відкривати» урок у редагуванні.
 */
test("#737c РЕДАКТОР: порядок рухом, заміна файлу в уроці й частинах, редагування не «відкриває» урок", () => {
  const src = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "frontend", "src", "pages", "dashboard", "sections", "TrainingCourses.tsx"), "utf8");
  assert.doesNotMatch(src, /updateTrainingMaterial\([^)]*\{\s*position\s*:/, "🔴 порядок знову ставиться номером з екрана");
  for (const t of ["materials", "folders"])
    assert.match(src, new RegExp(`moveTraining\\("${t}"`), `🔴 немає ↑/↓ для ${t}`);
  const uses = src.match(/<ReplaceFile\b/g)?.length ?? 0;
  assert.ok(uses >= 2, `🔴 «Замінити файл» є в ${uses} місцях — треба і в уроці, і в частині`);
  assert.match(src, /replaceTrainingFile\(/, "🔴 заміна файлу не кличе сервер");
  assert.match(src, /lesson:\s*\{\s*id:\s*step\.id/, "🔴 «+ Частина» не передає урок");
  assert.match(src, /if \(!edit && x\.status == null\) void openTrainingMaterial/, "🔴 редагування уроку ставить йому «відкрито»");
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
 * #738 — РЕДАКТОР НА ЖИВІЙ СХЕМІ, обробниками роутера:
 *  • #737b редактор відкриває замкнений урок, кандидат — ні (дзеркало: зняття замка не для всіх);
 *  • частина лягає в тему УРОКУ, хоч би що прийшло у формі; частину частини — 400;
 *  • заміна файлу: той самий id і прогрес, старий файл стерто, новий на диску; заборонений тип — рядок як був;
 *  • перенос уроку забирає частини, окремо частину не переносять; роль міняється лише в частини;
 *  • порядок 1..n одним запитом, неповний перелік — 400 і номери як були.
 * 🧨 Червоніє на будь-якому з цих пунктів — поіменно в повідомленні.
 */
test("#738 ЖИВИЙ SQL: заміна файлу, частини уроку, перенос і порядок — обробниками роутера", async (t) => {
  const s = await cluster(t); if (!s) return;
  const dir = mkdtempSync(path.join(tmpdir(), "train-files-"));
  try {
    await s.c.query(`UPDATE training_courses SET published = false`);
    const course = (await s.c.query(`INSERT INTO training_courses (title, audience, published) VALUES ('Курс','candidate',true) RETURNING id`)).rows[0].id;
    const modA = (await s.c.query(`INSERT INTO training_folders (name, course_id, position) VALUES ('Тема А', $1, 1) RETURNING id`, [course])).rows[0].id as number;
    const modB = (await s.c.query(`INSERT INTO training_folders (name, course_id, position) VALUES ('Тема Б', $1, 2) RETURNING id`, [course])).rows[0].id as number;
    const add = async (title: string, pos: number, kind = "text", stored: string | null = null) =>
      (await s.c.query(`INSERT INTO training_materials (folder_id, title, kind, position, content, stored_name, mime) VALUES ($1,$2,$3,$4,'текст',$5,$6) RETURNING id`,
        [modA, title, kind, pos, stored, stored ? "application/pdf" : null])).rows[0].id as number;
    writeFileSync(path.join(dir, "old.pdf"), "%PDF-1.4 old");
    const l1 = await add("Урок 1", 1);
    const l2 = await add("Урок 2", 2, "file", "old.pdf");
    const l3 = await add("Урок 3", 3);
    const cand = (await s.c.query(`INSERT INTO users (email, password_hash, role, role_override) VALUES ('c@x.ua','x','manager','candidate') RETURNING id`)).rows[0].id as number;
    const editor = (await s.c.query(`INSERT INTO users (email, password_hash, role) VALUES ('kvp@x.ua','x','admin') RETURNING id`)).rows[0].id as number;
    await s.c.query(`INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())`, [cand, l2]);

    Object.assign(process.env, { DATABASE_URL: s.url, JWT_SECRET: "scratch-only", KOMMO_BASE_URL: "http://127.0.0.1:9", KOMMO_API_TOKEN: "scratch", TRAINING_DIR: dir });
    const { trainingRouter } = await import("../routes/training.js");
    const { refreshRoles } = await import("../auth/rbac.js");
    await refreshRoles();   // без кешу ролей `roleHasPerm` fail-closed — редактор став би кандидатом
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] } };
    const AS = {
      editor: { userId: editor, roleKey: "kvp", role: "admin", managerId: null, teamId: null },
      cand: { userId: cand, roleKey: "candidate", role: "manager", managerId: -1, teamId: -1 },
    };
    const call = async (who: keyof typeof AS, method: string, p: string, params: Record<string, string>, body: Record<string, unknown> = {}) => {
      const layer = (trainingRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === p && l.route.methods[method]);
      assert.ok(layer, `🔴 роуту ${method.toUpperCase()} ${p} немає`);
      const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
      const res = { status(c: number) { out.code = c; return res; }, json(b: Record<string, unknown>) { out.body = b; return res; } };
      await layer!.route!.stack.at(-1)!.handle({ auth: AS[who], params, body }, res, () => undefined);
      return out;
    };
    const row = async (id: number) => (await s.c.query(`SELECT folder_id, lesson_id, part_role, stored_name, mime, size_bytes::int AS size, position FROM training_materials WHERE id = $1`, [id])).rows[0];
    const b64 = (x: string) => Buffer.from(x).toString("base64");
    try {
      // #737b — замок: редактор відкриває третій урок, кандидат без першого — ні.
      assert.equal((await call("cand", "get", "/material/:id", { id: String(l3) })).code, 423, "🔴 кандидату зняли замок разом із редактором");
      assert.equal((await call("editor", "get", "/material/:id", { id: String(l3) })).code, 200, "🔴 #737b редактор не може відкрити замкнений урок");

      // Частина: тема — уроку, навіть коли форма прислала іншу.
      const part = await call("editor", "post", "/material", {}, { kind: "file", title: "Додаток.pdf", folderId: modB, lessonId: l1, role: "attachment",
        filename: "Додаток.pdf", mime: "application/pdf", dataBase64: b64("%PDF-1.4 att") });
      assert.equal(part.code, 200, `🔴 частину не створено: ${JSON.stringify(part.body)}`);
      const partId = part.body.id as number;
      const pr = await row(partId);
      assert.deepEqual([pr.folder_id, pr.lesson_id, pr.part_role], [modA, l1, "attachment"], "🔴 частина лягла не в тему свого уроку");
      const nested = await call("editor", "post", "/material", {}, { kind: "text", title: "x", content: "y", lessonId: partId, role: "main" });
      assert.equal(nested.code, 400, "🔴 частину додано до частини");

      // Заміна файлу: id і прогрес ті самі, байти нові, старий файл стерто.
      const bad = await call("editor", "put", "/material/:id/file", { id: String(l2) }, { filename: "x.exe", mime: "application/x-msdownload", dataBase64: b64("MZ") });
      assert.ok(bad.code >= 400, "🔴 заміна прийняла заборонений тип");
      assert.equal((await row(l2)).stored_name, "old.pdf", "🔴 відмовлена заміна все одно зачепила рядок");
      assert.ok(existsSync(path.join(dir, "old.pdf")), "🔴 відмовлена заміна стерла старий файл");
      const rep = await call("editor", "put", "/material/:id/file", { id: String(l2) }, { filename: "new.pdf", mime: "application/pdf", dataBase64: b64("%PDF-1.4 новий") });
      assert.equal(rep.code, 200, `🔴 заміну не прийнято: ${JSON.stringify(rep.body)}`);
      const r2 = await row(l2);
      assert.notEqual(r2.stored_name, "old.pdf", "🔴 файл не замінено");
      assert.equal(r2.size, Buffer.byteLength("%PDF-1.4 новий"), "🔴 розмір лишився старий");
      assert.equal(readFileSync(path.join(dir, r2.stored_name), "utf8"), "%PDF-1.4 новий", "🔴 на диску не той файл");
      assert.ok(!existsSync(path.join(dir, "old.pdf")), "🔴 старий файл лишився сиротою на диску");
      const kept = await s.c.query(`SELECT status FROM training_progress WHERE user_id = $1 AND material_id = $2`, [cand, l2]);
      assert.equal(kept.rows[0]?.status, "done", "🔴 заміна файлу стерла прогрес людей");
      assert.equal((await call("editor", "put", "/material/:id/file", { id: String(l1) }, { filename: "a.pdf", mime: "application/pdf", dataBase64: b64("%PDF") })).code, 400,
        "🔴 текстовому уроку «замінили файл»");

      // Перенос: урок забирає частини; окрему частину не переносять; роль — лише в частини.
      assert.equal((await call("editor", "patch", "/material/:id", { id: String(partId) }, { folderId: modB })).code, 400, "🔴 частину перенесли окремо від уроку");
      assert.equal((await call("editor", "patch", "/material/:id", { id: String(l1) }, { role: "main" })).code, 400, "🔴 урокові виставили роль частини");
      assert.equal((await call("editor", "patch", "/material/:id", { id: String(partId) }, { role: "main" })).code, 200);
      assert.equal((await row(partId)).part_role, "main", "🔴 роль частини не змінилась");
      assert.equal((await call("editor", "patch", "/material/:id", { id: String(l1) }, { folderId: modB })).code, 200);
      assert.deepEqual([(await row(l1)).folder_id, (await row(partId)).folder_id], [modB, modB], "🔴 урок переїхав без своїх частин");

      // Порядок: повний перелік — 1..n; неповний — 400 і номери як були.
      const ro = await call("editor", "post", "/reorder", {}, { table: "materials", ids: [l3, l2] });
      assert.equal(ro.code, 200, `🔴 порядок не прийнято: ${JSON.stringify(ro.body)}`);
      assert.deepEqual([(await row(l3)).position, (await row(l2)).position], [1, 2], "🔴 порядок не записався");
      const partial = await call("editor", "post", "/reorder", {}, { table: "materials", ids: [l2] });
      assert.equal(partial.code, 400, "🔴 прийнято неповний порядок");
      assert.deepEqual([(await row(l3)).position, (await row(l2)).position], [1, 2], "🔴 відмовлений порядок зачепив номери");
      // ↑ з чернеткою серед сусідів: чернетка лишається на своєму місці, міняються рівно двоє.
      const draft = await add("Чернетка", 9);
      await s.c.query(`UPDATE training_materials SET status = 'draft' WHERE id = $1`, [draft]);
      assert.equal((await call("editor", "post", "/reorder", {}, { table: "materials", id: l2, dir: -1 })).code, 200);
      const order = (await s.c.query(`SELECT id FROM training_materials WHERE folder_id = $1 AND lesson_id IS NULL ORDER BY position, id`, [modA])).rows.map((x) => x.id);
      assert.deepEqual(order, [l2, l3, draft], "🔴 ↑ переставив не тих або загубив чернетку");
      assert.equal((await call("editor", "post", "/reorder", {}, { table: "materials", id: l2, dir: -1 })).code, 400, "🔴 перший пішов вище за край");
      const fo = await call("editor", "post", "/reorder", {}, { table: "folders", ids: [modB, modA] });
      assert.equal(fo.code, 200, `🔴 порядок тем не прийнято: ${JSON.stringify(fo.body)}`);
      const fp = (await s.c.query(`SELECT id, position FROM training_folders WHERE id = ANY($1) ORDER BY position`, [[modA, modB]])).rows.map((x) => x.id);
      assert.deepEqual(fp, [modB, modA], "🔴 теми не переставились");
    } finally { (await import("../db/pool.js")).pool.end().catch(() => undefined); }
  } finally { await s.done(); rmSync(dir, { recursive: true, force: true }); }
});
