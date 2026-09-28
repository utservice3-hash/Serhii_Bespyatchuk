import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { htmlToText, lessonMaterials, coursePlan, totals, type SerediaCourse, type SerediaLesson } from "./serediaImport.js";

/**
 * 🎓 ОДНОРАЗОВИЙ ПЕРЕНОС АКАДЕМІЇ SEREDA (23.09.2026) — гейти `#700`–`#702`.
 * Номери з запасом над `#690` — борг 17: перед мержем перемірити перетин.
 */
const api = (p: string) => (p.startsWith("http") ? p : `https://utseducation.sereda.ai${p}`);
const P = "39d73c9a-41ab-4952-b65e-e51f89ee5622";

const LESSON: SerediaLesson = {
  id: "L1", title: "Автомобільна логістика", is_required: true,
  content: "<p>Перший абзац</p><p>Другий&nbsp;абзац</p>",
  video_url: "https://youtu.be/fxE0DhRQHF0", video_provider: "youtube",
  presentation_url: `/api/v1/projects/${P}/academy/files/pres-1`,
  attachments: [
    { id: "A1", name: "Пам'ятка.pdf", mime_type: "application/pdf", file_size_bytes: "1024" },
    { id: "A2", name: "Таблиця.docx", mime_type: "docx", file_size_bytes: 2048 },
  ],
};

/**
 * #700 — УРОК SEREDA → МАТЕРІАЛИ ДАШБОРДА: текст, відео, презентація й КОЖНЕ вкладення стають окремими
 * матеріалами в сталому порядку; YouTube лишається посиланням, завантажене відео — файлом; порожній урок не
 * зникає, а стає текстом із поясненням; HTML перетворюється на плаский текст без тегів.
 * 🧨 Червоніє, якщо урок згорнути в один матеріал, загубити вкладення або лишити теги в тексті.
 */
test("#700 ПЕРЕНОС: урок → текст + відео + презентація + кожне вкладення; порожній урок не губиться", () => {
  const ms = lessonMaterials(LESSON, 1, api, P);
  assert.deepEqual(ms.map((m) => m.kind), ["text", "video_embed", "file", "file", "file"], "🔴 не той склад: " + JSON.stringify(ms.map((m) => m.kind)));
  assert.deepEqual(ms.map((m) => m.position), [1, 2, 3, 4, 5], "🔴 позиції не поспіль");
  assert.equal(new Set(ms.map((m) => m.externalId)).size, 5, "🔴 ключі ідемпотентності повторюються");
  assert.equal(ms[0].kind === "text" && ms[0].content, "Перший абзац\nДругий абзац", "🔴 HTML не став пласким текстом");
  assert.ok(ms[1].kind === "video_embed" && ms[1].url.includes("youtu.be"), "🔴 YouTube не лишився посиланням");
  assert.ok(ms[2].kind === "file" && ms[2].file.resolve === false && ms[2].file.url.startsWith("https://"), "🔴 презентація не файлом з абсолютною адресою");
  assert.ok(ms[3].kind === "file" && ms[3].file.resolve === true && ms[3].file.sizeBytes === 1024, "🔴 вкладення не через redirect_url або без розміру");
  assert.equal(ms[4].kind === "file" && ms[4].file.mime, null, "🔴 «docx» замість mime поїхало як mime");
  // Завантажене відео (не YouTube) — файл, а не посилання.
  const up = lessonMaterials({ id: "L2", title: "Запис", video_url: "https://storage.googleapis.com/x/y.mp4", video_provider: "upload" }, 1, api, P);
  assert.deepEqual(up.map((m) => m.kind), ["file"], "🔴 завантажене відео не стало файлом");
  // Порожній урок → один текст, який ПРО ЦЕ КАЖЕ (у Sereda таких чотири).
  const empty = lessonMaterials({ id: "L3", title: "Порожній" }, 7, api, P);
  assert.equal(empty.length, 1);
  assert.ok(empty[0].kind === "text" && /перенесено з Sereda порожнім/i.test(empty[0].content), "🔴 порожній урок мовчки зник");
  assert.equal(empty[0].position, 7, "🔴 порожній урок не на своєму місці");
  assert.equal(htmlToText("<ul><li>раз</li><li>два</li></ul>"), "• раз\n• два", "🔴 список злипся");
});

/**
 * #701 — КУРС ЦІЛКОМ І ПОВТОРНИЙ ПРОГІН: теми в порядку, наскрізна нумерація матеріалів у межах теми,
 * ключі СТАЛІ між прогонами (інакше другий імпорт створив би дублі); підсумки рахують файли й байти.
 * 🧨 Червоніє, якщо ключ почне залежати від порядку виклику або нумерація зіб'ється.
 */
test("#701 ПЕРЕНОС: план курсу сталий між прогонами, нумерація наскрізна, підсумки рахують файли й байти", () => {
  const course: SerediaCourse = {
    id: "C1", title: "  Навчання   менеджера  ", short_description: "<p>Про курс</p>", estimated_duration: 48,
    modules: [
      { id: "M1", title: "Тема 1", sort_order: 1, lessons: [LESSON, { id: "L9", title: "Текстовий", content: "<p>Текст</p>" }] },
      { id: "M2", title: "Тема 2", sort_order: 2, lessons: [{ id: "L8", title: "Порожній" }] },
    ],
  };
  const a = coursePlan(course, api, P), b = coursePlan(course, api, P);
  assert.equal(a.title, "Навчання менеджера", "🔴 подвійні пробіли лишились у назві");
  assert.ok(a.description?.includes("48 год"), "🔴 тривалість не потрапила в опис");
  assert.deepEqual(a.folders.map((f) => f.title), ["Тема 1", "Тема 2"]);
  assert.deepEqual(a.folders[0].materials.map((m) => m.position), [1, 2, 3, 4, 5, 6], "🔴 нумерація в темі не наскрізна");
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b), "🔴 два прогони дали різний план — повтор створить дублі");
  const t = totals([a]);
  assert.deepEqual([t.courses, t.folders, t.materials, t.files, t.embeds, t.text], [1, 2, 7, 3, 1, 3], "🔴 підсумки: " + JSON.stringify(t));
  assert.equal(t.bytes, 3072, "🔴 байти вкладень порахувало неправильно");
});

/**
 * #702 — ЖИВИЙ SQL: запис плану в базу й ПОВТОРНИЙ запис — ті самі рядки, без дублів; курс приходить
 * ЧЕРНЕТКОЮ з аудиторією «менеджер» (інакше він одразу потрапив би в знаменник навчання кандидата);
 * файл, який уже лежить, удруге не качається.
 * 🧨 Червоніє, якщо прибрати ключ `external_id`, публікувати курс одразу або качати файли щоразу.
 */
test("#702 ЖИВИЙ SQL: імпорт ідемпотентний, курс — чернетка для менеджерів, наявні файли не перекачуються", async (t) => {
  const { provisionScratch, skipReason } = await import("../db/scratchDb.js");
  const s = provisionScratch();
  if ("unavailable" in s) { t.skip(skipReason(s)); return; }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: s.url });
  await c.connect();
  try {
    await c.query(readFileSync(path.join(import.meta.dirname, "..", "db", "schema.sql"), "utf8"));
    const { importCourses } = await import("./serediaImport.js");
    const db = c as unknown as import("./serediaImport.js").ImportDb;
    const plan = coursePlan({
      id: "C1", title: "Курс із Sereda", modules: [{ id: "M1", title: "Тема 1", lessons: [LESSON] }],
    }, api, P);
    const seen = new Set<string>();
    const save: import("./serediaImport.js").SaveFile = async (m) => {
      const first = !seen.has(m.externalId); seen.add(m.externalId);
      return { storedName: `f-${m.externalId}.pdf`, size: 10, skipped: !first };
    };
    const one = await importCourses(db, [plan], null, save);
    assert.deepEqual([one.courses, one.folders, one.materials, one.filesSaved, one.filesSkipped], [1, 1, 5, 3, 0]);
    const row = (await c.query(`SELECT published, audience, source FROM training_courses WHERE external_id = 'C1'`)).rows[0];
    assert.deepEqual(row, { published: false, audience: "manager", source: "sereda" }, "🔴 курс опубліковано або не для менеджерів");
    const count = async () => (await c.query(
      `SELECT (SELECT count(*) FROM training_courses)::int AS c, (SELECT count(*) FROM training_folders)::int AS f,
              (SELECT count(*) FROM training_materials)::int AS m`)).rows[0];
    const before = await count();
    const two = await importCourses(db, [plan], null, save);
    assert.deepEqual(await count(), before, "🔴 повторний імпорт створив дублі");
    assert.deepEqual([two.filesSaved, two.filesSkipped], [0, 3], "🔴 файли перекачано вдруге");
    assert.equal((await c.query(`SELECT count(*)::int n FROM training_materials WHERE external_id LIKE 'L1:%'`)).rows[0].n, 5);
    // Дзеркало: чужі матеріали (без ключа) імпорт не чіпає.
    await c.query(`INSERT INTO training_materials (title, kind, content) VALUES ('Свій матеріал', 'text', 'x')`);
    await importCourses(db, [plan], null, save);
    assert.equal((await c.query(`SELECT count(*)::int n FROM training_materials WHERE external_id IS NULL`)).rows[0].n, 1, "🔴 імпорт зачепив наші власні матеріали");
  } finally { await c.end(); s.dispose(); }
});
