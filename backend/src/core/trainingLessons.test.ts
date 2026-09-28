import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 📘 УРОК ІЗ ЧАСТИНАМИ, ЯК У SEREDA (27.09.2026) — гейти `#726`–`#730`.
 * Рішення Романа: «роби Б, щоб було гарно і все як в середі». Заміряно на проді: 157 уроків Sereda лежали
 * 289 рядками, курс «для менеджерів з продажу» мав 76 кроків там, де в Sereda 20 уроків.
 */
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const BE = path.join(ROOT, "backend", "src");
const FE = (rel: string): string => readFileSync(path.join(ROOT, "frontend", "src", rel), "utf8");
const SCHEMA = path.join(import.meta.dirname, "..", "db", "schema.sql");

/**
 * #726 — КОЖНЕ ЗАВАНТАЖЕННЯ СПИСКУ КРОКІВ БЕРЕ ЛИШЕ УРОКИ. Перелік — ВІД ПРЕДМЕТА (правило 12): кожен запит
 * `FROM training_materials WHERE status = 'published'` у бекенді — це саме «список кроків» (замок, курси, склад
 * курсу, прогрес кандидата в «Наймі»); бібліотека, вміст кроку й АІ мають інші умови й сюди не потрапляють.
 * Порожній перелік — провал (правило 15), а не зелене.
 * 🧨 Червоніє, якщо будь-який читач забуде умову уроку — і, скажімо, «Найм» почне рахувати частини.
 */
test("#726 УРОКИ: кожен список кроків у бекенді бере лише уроки, а не частини", () => {
  const hits: { file: string; sql: string }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/FROM training_materials\s+WHERE status = 'published'[^`]*/g)) hits.push({ file: path.relative(BE, p), sql: m[0] });
      }
    }
  };
  walk(BE);
  assert.ok(hits.length >= 4, `🔴 списків кроків знайдено ${hits.length} — перевірці нема що перевіряти`);
  const bad = hits.filter((h) => !/\$\{LESSON_ONLY\}/.test(h.sql));
  assert.deepEqual(bad.map((h) => h.file), [], "🔴 список кроків бере й частини уроків");
  // Хто саме — поіменно: зникнення будь-якого з них теж має бути видно.
  for (const f of ["core/trainingLock.ts", "core/hiringTraining.ts", "routes/training.ts"])
    assert.ok(hits.some((h) => h.file === f), `🔴 ${f} більше не завантажує список кроків — перевір, куди це переїхало`);
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
 * #727 — МІГРАЦІЯ ГРУПУЄ ПЕРЕНЕСЕНЕ З SEREDA І НІЧОГО БІЛЬШЕ, А ПОВТОРНИЙ ПРОГІН НЕ ЗМІНЮЄ НІЧОГО.
 * Урок із текстом — головний текст; урок без тексту — головний перший за порядком; вкладення — «attachment»,
 * решта — «main». Наш власний матеріал (без `external_id`) не чіпається.
 * 🧨 Червоніє на подвійному групуванні, загубленій частині, неправильній ролі чи зачепленому нашому матеріалі.
 */
test("#727 ЖИВИЙ SQL: міграція групує уроки Sereda, наше не чіпає, повторний прогін — без змін", async (t) => {
  const s = await cluster(t); if (!s) return;
  try {
    const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
    const f = (await s.c.query(`INSERT INTO training_folders (name, position) VALUES ('Тема', 1) RETURNING id`)).rows[0].id;
    const ins = async (title: string, kind: string, pos: number, ext: string | null) =>
      (await s.c.query(`INSERT INTO training_materials (folder_id, title, kind, position, external_id, content) VALUES ($1,$2,$3,$4,$5,'x') RETURNING id`,
        [f, title, kind, pos, ext])).rows[0].id as number;
    const aText = await ins("Welcome to UTS", "text", 1, `${A}:text`);
    const aPres = await ins("Welcome to UTS — презентація", "file", 2, `${A}:pres`);
    const aAtt1 = await ins("WELCOME TO UTS", "file", 3, `${A}:att:aaaaaaaa-0000-4000-8000-000000000001`);
    const aAtt2 = await ins("Структура", "file", 4, `${A}:att:aaaaaaaa-0000-4000-8000-000000000002`);
    const bPres = await ins("Логістика — презентація", "file", 5, `${B}:pres`);
    const bAtt = await ins("Логістика.pdf", "file", 6, `${B}:att:bbbbbbbb-0000-4000-8000-000000000001`);
    const ours = await ins("Наш крок", "text", 7, null);

    const snap = async () => (await s.c.query(`SELECT id, lesson_id, part_role FROM training_materials ORDER BY id`)).rows;
    await s.c.query(readFileSync(SCHEMA, "utf8"));
    const after1 = await snap();
    const row = (id: number) => after1.find((r) => r.id === id)!;

    assert.deepEqual([row(aText).lesson_id, row(aText).part_role], [null, null], "🔴 текст уроку перестав бути головним");
    assert.deepEqual([row(aPres).lesson_id, row(aPres).part_role], [aText, "main"], "🔴 презентація не стала частиною уроку в тілі");
    assert.deepEqual([row(aAtt1).lesson_id, row(aAtt1).part_role], [aText, "attachment"], "🔴 вкладення не стало вкладенням");
    assert.deepEqual([row(aAtt2).lesson_id, row(aAtt2).part_role], [aText, "attachment"]);
    assert.deepEqual([row(bPres).lesson_id, row(bPres).part_role], [null, null], "🔴 урок без тексту не взяв головним перший за порядком");
    assert.deepEqual([row(bAtt).lesson_id, row(bAtt).part_role], [bPres, "attachment"]);
    assert.deepEqual([row(ours).lesson_id, row(ours).part_role], [null, null], "🔴 міграція зачепила наш власний матеріал");

    await s.c.query(readFileSync(SCHEMA, "utf8"));
    assert.deepEqual(await snap(), after1, "🔴 повторний прогін схеми змінив групування — міграція не ідемпотентна");

    // Пара «урок + роль» — лише разом: частина без ролі не знала б, де стояти.
    await assert.rejects(s.c.query(`UPDATE training_materials SET lesson_id = $1 WHERE id = $2`, [aText, ours]), /part_pair|check/i,
      "🔴 база прийняла частину без ролі");
  } finally { await s.done(); }
});

/**
 * #731 — УРОКИ-ЧЕРНЕТКИ SEREDA ЛИШАЮТЬСЯ ЧЕРНЕТКАМИ, РАЗОМ ІЗ ЧАСТИНАМИ. Заміряно через API Sereda 27.09: 5 уроків
 * зі 157 — «draft», учням їх не видно, тож там «20 уроків», а в нас було 25. Опубліковане й наше не чіпається;
 * повторний прогін нічого не змінює.
 * 🧨 Червоніє, якщо чернетка лишиться опублікованою, її частина — ні, або зачепить опублікований урок.
 */
test("#731 ЖИВИЙ SQL: чернетки Sereda стають чернетками разом із частинами, решта — як була", async (t) => {
  const s = await cluster(t); if (!s) return;
  try {
    const DRAFT = "a864ad29-e881-43c5-8930-47bb3bd00edc", PUB = "33333333-3333-4333-8333-333333333333";
    const f = (await s.c.query(`INSERT INTO training_folders (name, position) VALUES ('Логістика', 1) RETURNING id`)).rows[0].id;
    const ins = async (pos: number, ext: string | null) =>
      (await s.c.query(`INSERT INTO training_materials (folder_id, title, kind, position, external_id, content) VALUES ($1,'x','text',$2,$3,'x') RETURNING id`,
        [f, pos, ext])).rows[0].id as number;
    const dHead = await ins(1, `${DRAFT}:text`), dAtt = await ins(2, `${DRAFT}:att:cccccccc-0000-4000-8000-000000000001`);
    const pHead = await ins(3, `${PUB}:text`), ours = await ins(4, null);
    const st = async () => Object.fromEntries((await s.c.query(`SELECT id, status FROM training_materials`)).rows.map((r) => [r.id, r.status]));

    await s.c.query(readFileSync(SCHEMA, "utf8"));
    const a = await st();
    assert.deepEqual([a[dHead], a[dAtt]], ["draft", "draft"], "🔴 чернетка Sereda або її частина лишилась опублікованою");
    assert.deepEqual([a[pHead], a[ours]], ["published", "published"], "🔴 правка зачепила опублікований урок або наш матеріал");
    await s.c.query(readFileSync(SCHEMA, "utf8"));
    assert.deepEqual(await st(), a, "🔴 повторний прогін змінив статуси");
  } finally { await s.done(); }
});

/**
 * #728 — ЗАМОК, СКЛАД КУРСУ Й ПРОГРЕС РАХУЮТЬ УРОКИ; ЧАСТИНА ЗАМКНЕНОГО УРОКУ ЗАМКНЕНА. Справжні обробники на
 * тимчасовій базі, а не читання тексту. Частини за замовчуванням «обовʼязкові» — отже, якби їх рахували
 * кроками, наступний урок тримала б презентація попереднього, а не сам урок.
 * 🧨 Червоніє, якщо частина стане кроком, тримає замок, віддає вміст замкненого уроку або приймає «опрацював».
 */
test("#728 ЖИВИЙ SQL: замок, склад курсу й прогрес — за уроками; частина замкненого уроку замкнена", async (t) => {
  const s = await cluster(t); if (!s) return;
  try {
    await s.c.query(`UPDATE training_courses SET published = false`);
    const course = (await s.c.query(`INSERT INTO training_courses (title, audience, published) VALUES ('Курс','candidate',true) RETURNING id`)).rows[0].id;
    const mod = (await s.c.query(`INSERT INTO training_folders (name, course_id, position) VALUES ('Модуль', $1, 1) RETURNING id`, [course])).rows[0].id;
    const add = async (title: string, pos: number, lessonId: number | null = null, role: string | null = null) =>
      (await s.c.query(`INSERT INTO training_materials (folder_id, title, kind, position, content, lesson_id, part_role) VALUES ($1,$2,$3,$4,'текст',$5,$6) RETURNING id`,
        [mod, title, lessonId ? "file" : "text", pos, lessonId, role])).rows[0].id as number;
    const l1 = await add("Урок 1", 1);
    const l2 = await add("Урок 2", 2);
    const l2pdf = await add("Урок 2 — презентація", 3, l2, "main");
    const l2att = await add("Урок 2.pdf", 4, l2, "attachment");
    const l3 = await add("Урок 3", 5);
    const uid = (await s.c.query(`INSERT INTO users (email, password_hash, role, role_override) VALUES ('c@x.ua','x','manager','candidate') RETURNING id`)).rows[0].id as number;

    const { stepLockedBy } = await import("./trainingLock.js");
    const db = s.c as unknown as import("./trainingLock.js").LockDb;
    assert.equal((await stepLockedBy(db, uid, l2pdf))?.materialId, l1, "🔴 частину замкненого уроку можна відкрити в обхід уроку");
    await s.c.query(`INSERT INTO training_progress (user_id, material_id, status, finished_at) VALUES ($1,$2,'done',now())`, [uid, l1]);
    assert.equal(await stepLockedBy(db, uid, l2pdf), null, "🔴 частина відкритого уроку лишилась замкненою");
    assert.equal((await stepLockedBy(db, uid, l3))?.materialId, l2, "🔴 наступний урок тримає не урок, а його частина");

    Object.assign(process.env, { DATABASE_URL: s.url, JWT_SECRET: "scratch-only", KOMMO_BASE_URL: "http://127.0.0.1:9", KOMMO_API_TOKEN: "scratch" });
    const { trainingRouter } = await import("../routes/training.js");
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (...a: unknown[]) => unknown }[] } };
    const call = async (method: string, p: string, params: Record<string, string>) => {
      const layer = (trainingRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === p && l.route.methods[method]);
      assert.ok(layer, `🔴 роуту ${method.toUpperCase()} ${p} немає`);
      const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
      const res = { status(c: number) { out.code = c; return res; }, json(b: Record<string, unknown>) { out.body = b; return res; } };
      await layer!.route!.stack.at(-1)!.handle({ auth: { userId: uid, roleKey: "candidate", role: "manager", managerId: -1, teamId: -1 }, params, body: {} }, res, () => undefined);
      return out;
    };
    try {
      const detail = await call("get", "/courses/:id", { id: String(course) });
      const steps = (detail.body.modules as { materials: { id: number }[] }[])[0].materials.map((m) => m.id);
      assert.deepEqual(steps, [l1, l2, l3], "🔴 у складі курсу частини йдуть окремими кроками");

      const lesson = await call("get", "/material/:id", { id: String(l2) });
      assert.equal(lesson.code, 200);
      const parts = lesson.body.parts as { id: number; role: string }[];
      assert.deepEqual(parts.map((p) => [p.id, p.role]), [[l2pdf, "main"], [l2att, "attachment"]], "🔴 урок прийшов без своїх частин або з неправильними ролями");

      const partDone = await call("post", "/progress/:materialId/done", { materialId: String(l2pdf) });
      assert.equal(partDone.code, 400, "🔴 «опрацював» поставлено частині, а не уроку");
      const lessonDone = await call("post", "/progress/:materialId/done", { materialId: String(l2) });
      assert.equal(lessonDone.code, 200, "🔴 сам урок не приймає «опрацював»");
    } finally { (await import("../db/pool.js")).pool.end().catch(() => undefined); }
  } finally { await s.done(); }
});

/**
 * #729 — ОБИДВА ЕКРАНИ ПОКАЗУЮТЬ УРОК ОДНИМ КОМПОНЕНТОМ. Досі кожен екран малював крок сам, і копії вже
 * розійшлись у дрібницях; урок із частинами зробив би з них дві різні програми. Екрани не тягнуть файли
 * самі — це робить `LessonBody`.
 * 🧨 Червоніє, якщо крок курсу чи екран кандидата знову малює урок власним кодом.
 */
test("#729 УРОК: крок курсу й екран кандидата — одним LessonBody, без власної відмальовки файлів", () => {
  for (const f of ["pages/dashboard/sections/TrainingCourses.tsx", "pages/dashboard/sections/CandidateTraining.tsx"]) {
    const src = FE(f);
    assert.match(src, /<LessonBody m=\{m\} \/>/, `🔴 ${f} не показує урок через LessonBody`);
    assert.ok(!/\bfetchTrainingFileBlobUrl\b/.test(src), `🔴 ${f} знову тягне файли уроку сам`);
    assert.ok(!/<PdfViewer\b/.test(src), `🔴 ${f} малює pdf повз урок`);
  }
  const body = FE("pages/dashboard/sections/LessonBody.tsx");
  assert.match(body, /lessonLayout\(m, m\.parts \?\? \[\]\)/, "🔴 LessonBody розкладає урок не спільним правилом");
});

/**
 * #730 — РОЗКЛАДКА УРОКУ ЯК У SEREDA, ВИКОНАНА. Зверху те, що дивляться; текст; «Вкладення». Вкладення-pdf
 * лишається ВКЛАДЕННЯМ (у Sereda це інший файл, ніж презентація в переглядачі). Непоказуваний файл — на
 * завантаження, а не в порожнє місце. Розмір — у КБ для малого («0.0 МБ» читалось як порожній файл).
 * 🧨 Червоніє, якщо вкладення потрапить у переглядач, текст загубиться або малий файл стане «0.0 МБ».
 */
test("#730 УРОК: розкладка як у Sereda — дивитись, текст, вкладення; малий файл у КБ", async () => {
  const ts = (await import("typescript")).default;
  const src = FE("pages/dashboard/lessonLayout.ts");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const L = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  const f = (id: number, kind: string, mime: string | null, extra: Record<string, unknown> = {}) =>
    ({ id, title: `m${id}`, kind, url: null, mime, sizeBytes: 1000, hasFile: kind === "file", content: null, ...extra });

  /* Розміри РІЗНІ, як у різних файлів: з 28.09 вкладення того самого розміру й типу, що й файл у вікні, вважається
     його дублем і ховається (`#735`), тож фікстура з однаковими розмірами перевіряла б уже інше правило. */
  const a = L.lessonLayout({ ...f(1, "text", null), content: "Текст уроку" }, [
    { ...f(2, "file", "application/pdf"), sizeBytes: 8_000_000, role: "main" },
    { ...f(3, "file", "application/pdf"), sizeBytes: 5_200_000, role: "attachment" },
    { ...f(4, "file", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), sizeBytes: 90_000, role: "main" },
  ]);
  assert.deepEqual(a.main.map((x: { id: number; show: string }) => [x.id, x.show]), [[2, "pdf"]], "🔴 у тілі уроку не рівно презентація");
  assert.equal(a.text, "Текст уроку", "🔴 текст уроку загубився");
  assert.deepEqual(a.attachments.map((x: { id: number }) => x.id), [3, 4], "🔴 вкладення-pdf або docx не у «Вкладеннях»");

  const b = L.lessonLayout({ ...f(5, "file", "application/pdf"), content: "Опис" }, []);
  assert.deepEqual([b.main.map((x: { id: number }) => x.id), b.text], [[5], "Опис"], "🔴 урок без тексту не показав головний pdf зверху");
  assert.equal(L.lessonLayout({ ...f(6, "text", null), content: "   " }, []).text, null, "🔴 порожній текст показано як текст");

  assert.equal(L.sizeLabel(1500), "1 КБ");
  assert.equal(L.sizeLabel(300), "1 КБ", "🔴 малий файл показано як 0");
  assert.equal(L.sizeLabel(5.2 * 1024 * 1024), "5.2 МБ");
  assert.equal(L.sizeLabel(null), "");
});

/**
 * #732 — «ПЕРЕГЛЯД» ОБОХ ЕКРАНІВ У БУДОВІ SEREDA. Роман, 28.09: «воно не як sereda ai». Заміряно: у Sereda курс і
 * урок — дві сторінки (шапка + «Програма курсу»; урок + бічна панель). Обидва екрани — викладача в «Перегляді» й
 * кандидата — будуються з тих самих компонентів `LearnLayout`, а стан уроку НЕ рахують самі: він із сервера (`#708`).
 * 🧨 Червоніє, якщо екран поверне стару склеєну сторінку або компоненти почнуть самі вирішувати, що замкнено.
 */
test("#732 УРОК: «Перегляд» викладача й екран кандидата — будова Sereda зі спільних компонентів", () => {
  for (const f of ["pages/dashboard/sections/TrainingCourses.tsx", "pages/dashboard/sections/CandidateTraining.tsx"]) {
    const src = FE(f);
    for (const c of ["<CourseHeader ", "<ProgramAccordion ", "<LessonPage "])
      assert.ok(src.includes(c), `🔴 ${f} не показує ${c.trim()} — сторінка знову не в будові Sereda`);
  }
  // Викладач: без вибраного уроку в «Перегляді» — сторінка курсу, а не перший крок.
  const tc = FE("pages/dashboard/sections/TrainingCourses.tsx");
  assert.match(tc, /if \(!edit\) \{[\s\S]*?\{reading \? \(\s*<ReadLesson /, "🔴 «Перегляд» не розводить сторінку курсу й сторінку уроку");
  // Компоненти лише показують стан із сервера — власної арифметики замка немає.
  const lay = FE("pages/dashboard/sections/LearnLayout.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/state\s*=\s*["']locked["']|blockedBy\s*=|findIndex\([^)]*done[^)]*\)\s*[<>]/.test(lay), "🔴 компонент сам вирішує, що замкнено");
  assert.match(lay, /l\.state === "locked"/, "🔴 замок уроку більше не читається зі стану сервера");
});

/**
 * #733 — ЛІЧИЛЬНИКИ ПРОГРАМИ, ВИКОНАНІ. Підписи як у Sereda: «1 з 1 уроку», «4 з 6 уроків», «20 з 20 уроків»;
 * у шапці — «1 урок / 2 уроки / 5 уроків». Наступний урок — перший доступний, а не перший незавершений (замкнений
 * відкрити не можна). Тема «завершена» за обовʼязковими — як і відсоток курсу.
 * 🧨 Червоніє на неправильній формі слова, «наступному» замкненому уроці чи незавершеній темі через необовʼязковий урок.
 */
test("#733 УРОК: лічильники програми — форми слова, наступний урок, завершена тема", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE("pages/dashboard/learnProgram.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const P = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  assert.deepEqual([1, 2, 5, 11, 20, 21].map(P.lessonsWord), ["уроку", "уроків", "уроків", "уроків", "уроків", "уроку"], "🔴 «з N уроку/уроків» не за правилом");
  assert.deepEqual([1, 2, 5, 12, 22].map(P.lessonsCount), ["1 урок", "2 уроки", "5 уроків", "12 уроків", "22 уроки"], "🔴 «N урок/уроки/уроків» не за правилом");

  const L = (id: number, state: string, required = true) => ({ id, title: `u${id}`, kind: "text", required, state, blockedBy: null });
  const mods = [
    { id: 1, name: "A", materials: [L(1, "done"), L(2, "done", false), L(3, "done")] },
    { id: 2, name: "B", materials: [L(4, "done"), L(5, "available"), L(6, "locked")] },
    { id: 3, name: "C", materials: [L(7, "locked"), L(8, "opened", false)] },
  ];
  const st = P.programStat(mods);
  assert.deepEqual([st.lessons, st.done, st.modules, st.next?.id], [8, 4, 3, 5], "🔴 лічильники курсу або наступний урок");
  assert.equal(P.moduleStat({ id: 9, name: "X", materials: [L(1, "done"), L(2, "available", false)] }).complete, true,
    "🔴 тема не завершена через НЕобовʼязковий урок");
  assert.equal(P.moduleStat(mods[1]).complete, false);
  assert.equal(P.lessonAfter(mods, 3)?.id, 4, "🔴 «Наступний» не переходить у наступну тему");
  assert.equal(P.lessonAfter(mods, 8), null, "🔴 після останнього уроку є «наступний»");
  assert.deepEqual([P.openModuleId(mods, 7), P.openModuleId(mods, null)], [3, 2], "🔴 розгорнуто не ту тему");
});

/**
 * #734 — НАЗВА УРОКУ БЕЗ ТЕХНІЧНОГО ХВОСТА. Уроки без тексту взяли назву своєї презентації «X — презентація», а в
 * Sereda той самий урок — «X» (заміряно 28.09: 8 уроків). Хвіст знімається лише в головних рядках уроків Sereda;
 * частини й наші матеріали — як були; повторний прогін нічого не змінює.
 * 🧨 Червоніє, якщо зачепить частину, наш матеріал або повторний прогін щось змінить.
 */
test("#734 ЖИВИЙ SQL: назва уроку Sereda без «— презентація», частини й наше — як були", async (t) => {
  const s = await cluster(t); if (!s) return;
  try {
    const K = "44444444-4444-4444-8444-444444444444", T = "55555555-5555-4555-8555-555555555555";
    const f = (await s.c.query(`INSERT INTO training_folders (name, position) VALUES ('Тема', 1) RETURNING id`)).rows[0].id;
    const ins = async (title: string, pos: number, ext: string | null, kind = "file") =>
      (await s.c.query(`INSERT INTO training_materials (folder_id, title, kind, position, external_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [f, title, kind, pos, ext])).rows[0].id as number;
    const head = await ins("Внутрішні перевезення — презентація", 1, `${K}:pres`);             // урок без тексту
    const textHead = await ins("Митниця", 2, `${T}:text`, "text");
    const part = await ins("Митниця — презентація", 3, `${T}:pres`);                           // частина уроку з текстом
    const ours = await ins("Наша — презентація", 4, null);
    const titles = async () => Object.fromEntries((await s.c.query(`SELECT id, title FROM training_materials`)).rows.map((r) => [r.id, r.title]));

    await s.c.query(readFileSync(SCHEMA, "utf8"));
    const a = await titles();
    assert.equal(a[head], "Внутрішні перевезення", "🔴 назва уроку лишилась із «— презентація»");
    assert.deepEqual([a[textHead], a[part], a[ours]], ["Митниця", "Митниця — презентація", "Наша — презентація"], "🔴 правка зачепила частину або наш матеріал");
    await s.c.query(readFileSync(SCHEMA, "utf8"));
    assert.deepEqual(await titles(), a, "🔴 повторний прогін змінив назви");
  } finally { await s.done(); }
});

/**
 * #735 — УРОК БЕЗ ТОГО, ЩО ДИВИТИСЬ, ПОКАЗУЄ PDF-ВКЛАДЕННЯ У ВІКНІ; ДУБЛЬ ПРЕЗЕНТАЦІЇ У «ВКЛАДЕННЯХ» НЕ ПОКАЗУЄТЬСЯ.
 * Роман, 28.09: «відкрив сторінку, а пдфа немає». Заміряно: 79 уроків — текст + pdf-вкладення без презентації;
 * в усіх 11 уроках із презентацією та сама презентація лежить ще й вкладенням (Sereda її зі списку ховає).
 * Обидва боки: де є що дивитись — вкладення НЕ лізе у вікно; де нема — лізе, але лишається й на завантаження.
 * 🧨 Червоніє, якщо pdf знову лише «на завантаження», якщо вкладення витіснить презентацію або дубль повернеться.
 */
test("#735 УРОК: pdf-вкладення у вікні, коли дивитись нічого; дубль презентації прибрано з «Вкладень»", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(FE("pages/dashboard/lessonLayout.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const L = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  const PDF = "application/pdf";
  const f = (id: number, kind: string, mime: string | null, size: number, extra: Record<string, unknown> = {}) =>
    ({ id, title: `m${id}`, kind, url: null, mime, sizeBytes: size, hasFile: kind === "file", content: null, ...extra });
  const text = { ...f(1, "text", null, 0), content: "Текст" };
  const ids = (xs: { id: number }[]) => xs.map((x) => x.id);

  // Урок зі скріншота: текст + pdf-вкладення, презентації немає → pdf у вікні І у «Вкладеннях».
  const a = L.lessonLayout(text, [{ ...f(2, "file", PDF, 4_500_000), role: "attachment" }]);
  assert.deepEqual([ids(a.main), ids(a.attachments)], [[2], [2]], "🔴 урок без презентації не показує pdf у вікні або прибрав його з завантаження");

  // Урок із презентацією: вкладення-дубль (той самий розмір і тип) зникає зі списку, інше вкладення лишається.
  const b = L.lessonLayout(text, [
    { ...f(3, "file", PDF, 8_000_000), role: "main" },
    { ...f(4, "file", PDF, 8_000_000), role: "attachment" },
    { ...f(5, "file", PDF, 5_200_000), role: "attachment" },
  ]);
  assert.deepEqual([ids(b.main), ids(b.attachments)], [[3], [5]], "🔴 дубль презентації у «Вкладеннях» або вкладення витіснило презентацію");

  // Є відео — вкладення-pdf у вікно НЕ лізе.
  const c = L.lessonLayout(text, [{ ...f(6, "video_embed", null, 0, { url: "https://youtu.be/x" }), role: "main" }, { ...f(7, "file", PDF, 1000), role: "attachment" }]);
  assert.deepEqual([ids(c.main), ids(c.attachments)], [[6], [7]], "🔴 pdf-вкладення витіснило відео");

  // Файлу немає — у вікно не лізе (показувати нічого).
  const d = L.lessonLayout(text, [{ ...f(8, "file", PDF, 1000, { hasFile: false }), role: "attachment" }]);
  assert.deepEqual(ids(d.main), [], "🔴 у вікно пішов pdf без файла");
});

/**
 * #736 — ТЕКСТ УРОКУ НАД ПРЕЗЕНТАЦІЄЮ, «ВКЛАДЕННЯ» — ВНИЗУ. Роман, 28.09: «у нас презентація зверху, а текст
 * знизу — мало б бути навпаки». Свідоме відхилення від Sereda (там переглядач над текстом). Порядок — це порядок
 * дітей ОДНОГО контейнера `.tr-lsn` у розмітці, тож межі — сам контейнер, а не «N символів поруч» (правило 9).
 * 🧨 Червоніє, якщо презентацію знову поставити над текстом або вкладення — вище за презентацію.
 */
test("#736 УРОК: спершу текст, потім презентація, внизу «Вкладення»", () => {
  const src = FE("pages/dashboard/sections/LessonBody.tsx");
  const from = src.indexOf('<div className="tr-lsn">');
  const to = src.indexOf("</div>\n  );", from);
  assert.ok(from >= 0 && to > from, "🔴 контейнера уроку не знайдено — перевірці нема що перевіряти");
  const body = src.slice(from, to).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const at = (needle: string) => { const i = body.indexOf(needle); assert.ok(i >= 0, `🔴 у тілі уроку немає «${needle}»`); return i; };
  const text = at("{layout.text &&"), main = at("{layout.main.map("), att = at("{layout.attachments.length > 0");
  assert.ok(text < main, "🔴 презентація знову над текстом");
  assert.ok(main < att, "🔴 «Вкладення» вище за презентацію");
});
