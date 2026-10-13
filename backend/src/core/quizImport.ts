/**
 * 📝 ІМПОРТ ТЕСТІВ У КУРС (13.10.2026). Правило запису; консольна обгортка — `tools/importQuiz.ts`.
 * Зʼєднання — параметром: гейт ганяє саме цю функцію на тимчасовій базі.
 *
 * 🔴 ЩО ГАРАНТУЄТЬСЯ:
 *  • тест стає ОСТАННІМ кроком своєї теми — після всіх уроків, тож відкривається, коли їх пройдено (Р1);
 *  • усе приходить ЧЕРНЕТКОЮ (`status = 'draft'`) — кандидати не бачать, доки людина не опублікує;
 *  • повторний запуск не дублює: тест — за `external_id = quiz:<key>`, питання — за `external_key`;
 *  • питання повторного запуску ОНОВЛЮЮТЬСЯ з сіду (правка документа → `--write`); налаштування тесту, що вже
 *    є (поріг, спроби), — ні: їх міг змінити редактор;
 *  • `--dry` не пише нічого.
 * ⚠️ Питання, яке ПРИБРАЛИ з сіду, з бази НЕ видаляється — це окрема дія людини (спроби на нього посилаються).
 */
import { orderedMaterials } from "./trainingProgress.js";
import type { QuizDb } from "./trainingQuizStore.js";
import type { QuizSeed, SeedQuestion } from "./quizSeedSalesCourse.js";

/** Перевірка сіду ДО запису: порожні тексти, індекси поза варіантами, повтори ключів. Порожній масив — усе гаразд. */
export function seedProblems(seed: QuizSeed): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  const seen = (k: string) => { if (keys.has(k)) out.push(`повтор ключа ${k}`); keys.add(k); };
  if (!seed.quizzes.length) out.push("у сіді немає жодного тесту");
  for (const q of seed.quizzes) {
    seen(q.key);
    if (!q.questions.length) out.push(`${q.key}: немає питань`);
    if (!(q.passPct >= 1 && q.passPct <= 100)) out.push(`${q.key}: поріг ${q.passPct} поза 1–100`);
    for (const x of q.questions) {
      seen(x.key);
      if (!x.text.trim()) out.push(`${x.key}: порожній текст`);
      if (x.kind === "number") {
        const c = x.correct as { value: number; tol: number };
        if (Array.isArray(x.correct) || typeof c.value !== "number" || !(c.tol >= 0)) out.push(`${x.key}: число без значення чи допуску`);
      } else {
        const opts = x.options ?? [];
        const c = x.correct as number[];
        if (opts.length < 2) out.push(`${x.key}: менше двох варіантів`);
        if (!Array.isArray(c) || !c.length || c.some((i) => !Number.isInteger(i) || i < 0 || i >= opts.length)) out.push(`${x.key}: правильний індекс поза варіантами`);
        if (x.kind === "one" && Array.isArray(c) && c.length !== 1) out.push(`${x.key}: «один варіант» з ${c.length} правильними`);
        if (new Set(c).size !== c.length) out.push(`${x.key}: повтор правильного індексу`);
      }
    }
  }
  return out;
}

export interface ImportLine { key: string; module: string; materialId: number | null; created: boolean; questions: number; inserted: number; updated: number }
export interface ImportReport { courseId: number; courseTitle: string; lines: ImportLine[] }

/** Імпорт. `courseId` — явно або курс із назвою `seed.course` (рівно один, інакше відмова). */
export async function importQuizzes(db: QuizDb, seed: QuizSeed, opts: { write: boolean; courseId?: number }): Promise<ImportReport> {
  const problems = seedProblems(seed);
  if (problems.length) throw new Error(`сід зламаний: ${problems.join("; ")}`);
  const courses = (await db.query<{ id: number; title: string }>(
    opts.courseId ? `SELECT id, title FROM training_courses WHERE id = $1` : `SELECT id, title FROM training_courses WHERE title = $1`,
    [opts.courseId ?? seed.course])).rows;
  if (courses.length !== 1) throw new Error(`курс «${opts.courseId ?? seed.course}»: знайдено ${courses.length}, треба рівно один — передайте --course-id`);
  const course = courses[0];
  const folders = (await db.query<{ id: number; parent_id: number | null; position: number; course_id: number | null; name: string }>(
    `SELECT id, parent_id, position, course_id, name FROM training_folders`)).rows;
  const fRows = folders.map((f) => ({ id: f.id, parentId: f.parent_id, position: f.position }));
  const lines: ImportLine[] = [];

  for (const q of seed.quizzes) {
    const mods = folders.filter((f) => f.course_id === course.id && f.parent_id === null && f.name.trim() === q.module.trim());
    if (mods.length !== 1) throw new Error(`тема «${q.module}» у курсі ${course.id}: знайдено ${mods.length}, треба рівно одну`);
    const mod = mods[0];
    const ext = `quiz:${q.key}`;
    let materialId = (await db.query<{ id: number }>(`SELECT id FROM training_materials WHERE external_id = $1`, [ext])).rows[0]?.id ?? null;
    const created = materialId == null;
    if (created && opts.write) {
      // Останній крок теми: у тій папці, де лежить останній урок теми (або в самій темі, якщо уроків немає).
      const mats = (await db.query<{ id: number; folder_id: number; position: number }>(
        `SELECT id, folder_id, position FROM training_materials WHERE lesson_id IS NULL AND folder_id IS NOT NULL`)).rows;
      const ordered = orderedMaterials(mod.id, fRows, mats.map((m) => ({ id: m.id, folderId: m.folder_id, position: m.position, required: true })));
      const target = ordered.length ? ordered[ordered.length - 1].folderId : mod.id;
      const pos = Math.max(0, ...mats.filter((m) => m.folder_id === target).map((m) => m.position)) + 1;
      materialId = (await db.query<{ id: number }>(
        `INSERT INTO training_materials (folder_id, title, kind, content, position, status, required, external_id)
         VALUES ($1, $2, 'quiz', $3, $4, 'draft', true, $5) RETURNING id`, [target, q.title, q.intro, pos, ext])).rows[0].id;
      await db.query(`INSERT INTO training_quizzes (material_id, pass_pct, max_attempts) VALUES ($1, $2, $3) ON CONFLICT (material_id) DO NOTHING`,
        [materialId, q.passPct, q.maxAttempts]);
    }
    let inserted = 0, updated = 0;
    const existing = new Set(materialId ? (await db.query<{ external_key: string }>(
      `SELECT external_key FROM training_quiz_questions WHERE material_id = $1 AND external_key IS NOT NULL`, [materialId])).rows.map((r) => r.external_key) : []);
    for (const [i, x] of q.questions.entries()) {
      if (existing.has(x.key)) updated++; else inserted++;
      if (!opts.write || materialId == null) continue;
      await upsertQuestion(db, materialId, i + 1, x);
    }
    lines.push({ key: q.key, module: mod.name, materialId, created, questions: q.questions.length, inserted, updated });
  }
  return { courseId: course.id, courseTitle: course.title, lines };
}

async function upsertQuestion(db: QuizDb, materialId: number, position: number, x: SeedQuestion) {
  await db.query(
    `INSERT INTO training_quiz_questions (material_id, position, kind, text, options, correct, explanation, source_title, external_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (external_key) DO UPDATE SET
       material_id = EXCLUDED.material_id, position = EXCLUDED.position, kind = EXCLUDED.kind, text = EXCLUDED.text,
       options = EXCLUDED.options, correct = EXCLUDED.correct, explanation = EXCLUDED.explanation, source_title = EXCLUDED.source_title`,
    [materialId, position, x.kind, x.text, x.options ? JSON.stringify(x.options) : null, JSON.stringify(x.correct), x.explanation, x.source, x.key]);
}
