/**
 * 📝 ІМПОРТ ТЕСТІВ У КУРС «Навчання для менеджерів з продажу логістичних послуг» (13.10.2026).
 * Правило — `core/quizImport.ts`, питання — `core/quizSeedSalesCourse.ts` (погоджений документ, 54 питання).
 *
 * Запуск (на сервері, у теці `backend`, у свіжому shell):
 *   set -a && . ./.env && set +a && node dist/tools/importQuiz.js --dry                 # лише показати, що буде
 *   set -a && . ./.env && set +a && node dist/tools/importQuiz.js --write               # записати чернетками
 *   … --course-id=3     # якщо курсів із такою назвою кілька або назву змінили
 *
 * 🔴 Усе приходить ЧЕРНЕТКОЮ: публікує людина в редакторі курсу. Повторний `--write` дублів не створює.
 */
import { pool } from "../db/pool.js";
import { importQuizzes } from "../core/quizImport.js";
import { SALES_COURSE_QUIZZES } from "../core/quizSeedSalesCourse.js";
import type { QuizDb } from "../core/trainingQuizStore.js";

const WRITE = process.argv.includes("--write");
const courseArg = process.argv.find((a) => a.startsWith("--course-id="));
const courseId = courseArg ? Number(courseArg.slice("--course-id=".length)) : undefined;

async function main() {
  if (courseArg && !Number.isInteger(courseId)) throw new Error("--course-id має бути числом");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await importQuizzes(c as unknown as QuizDb, SALES_COURSE_QUIZZES, { write: WRITE, courseId });
    console.log(`Курс ${r.courseId}: ${r.courseTitle}`);
    for (const l of r.lines) {
      console.log(`  ${l.created ? (WRITE ? "+ створено" : "+ буде створено") : "= вже є    "} ${l.module.padEnd(28)} тест id=${l.materialId ?? "—"} · питань ${l.questions} (нових ${l.inserted}, оновлених ${l.updated})`);
    }
    const total = r.lines.reduce((s, l) => s + l.questions, 0);
    console.log(`Разом: ${r.lines.length} тестів, ${total} питань.`);
    if (WRITE) { await c.query("COMMIT"); console.log("✅ Записано чернетками. Опублікуйте тести в редакторі курсу."); }
    else { await c.query("ROLLBACK"); console.log("— це `--dry`: у базу НЕ записано нічого. Запис: --write"); }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  await pool.end();
}

main().catch(async (e) => { console.error("🔴", (e as Error).message); await pool.end().catch(() => undefined); process.exit(1); });
