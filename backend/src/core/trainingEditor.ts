/**
 * 🧩 РЕДАКТОР НАВЧАННЯ — ЧИСТІ ПРАВИЛА (17.09.2026). Без БД і без `config`.
 *
 * Навіщо окремо. Сервер уміє курси з першого дня (`routes/training.ts`), але покласти модуль
 * у курс було нічим: `course_id` виставлявся лише запитом до бази. Тут — правило, ЯКА папка
 * може стати модулем і що означає «прибрати з курсу», щоб роут і тест читали його з одного місця.
 *
 * 🔴 МОДУЛЬ = КОРЕНЕВА ПАПКА (рішення власника 15.09.2026, те саме, що в `trainingProgress.ts`).
 * Вкладена папка лишається ГРУПОЮ всередині модуля: якби вона теж ставала модулем, той самий
 * матеріал потрапив би в курс двічі — і в модулі, і в його групі, — а відсоток порахував би його
 * двічі. Тому перевірка стоїть тут, а не в думці того, хто натискає кнопку.
 */
import { orderedMaterials, type FolderRow as OrderFolder, type MaterialRow } from "./trainingProgress.js";

export interface EditorFolder { id: number; parentId: number | null; courseId: number | null; name: string; position: number }

export type EditorVerdict = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Чи можна привʼязати папку до курсу (`courseId`) або відчепити (`courseId = null`).
 *
 * ⚠️ ПЕРЕЇЗД МІЖ КУРСАМИ — ТІЛЬКИ ЯВНО. Папка, що вже лежить в іншому курсі, не переїжджає
 * мовчки: той курс схудне на цілий модуль, і людина, яка тисне «додати», цього не побачить.
 * Тому 409 з назвою курсу, і лише `force` це перекриває.
 */
export function attachVerdict(p: {
  folder: EditorFolder | null;
  courseId: number | null;
  courseExists: boolean;
  force?: boolean;
  currentCourseName?: string | null;
}): EditorVerdict {
  if (!p.folder) return { ok: false, status: 404, reason: "Папку не знайдено" };
  if (p.courseId === null) return { ok: true }; // прибрати з курсу можна завжди: матеріали лишаються в папці
  if (!p.courseExists) return { ok: false, status: 404, reason: "Курс не знайдено" };
  if (p.folder.parentId !== null)
    return { ok: false, status: 400, reason: `«${p.folder.name}» лежить усередині іншої папки. Модулем курсу може бути лише папка верхнього рівня — вкладені лишаються групами всередині модуля` };
  if (p.folder.courseId != null && p.folder.courseId !== p.courseId && !p.force)
    return { ok: false, status: 409, reason: `«${p.folder.name}» уже є модулем курсу «${p.currentCourseName ?? "інший курс"}». Підтвердіть перенесення — той курс залишиться без цього модуля` };
  return { ok: true };
}

/**
 * Значення перемикача «обовʼязковий». Строго булеве: рядок «false» чи 0 з форми не має тихо
 * стати правдою — це той самий клас, що «порожній скоуп нулем» (правило 7 у CLAUDE.md).
 */
export function requiredValue(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Скільки кроків у модулі й скільки з них обовʼязкові.
 * Рахуємо ТИМ САМИМ `orderedMaterials`, яким кандидат проходить курс: друга копія обходу
 * розійшлася б із першою мовчки, і редактор показував би не те число, що екран навчання.
 */
export function moduleStats(
  moduleId: number, folders: readonly EditorFolder[], materials: readonly MaterialRow[],
): { steps: number; required: number } {
  const ordered = orderedMaterials(moduleId, folders.map(toOrder), materials);
  return { steps: ordered.length, required: ordered.filter((m) => m.required).length };
}

const toOrder = (f: EditorFolder): OrderFolder => ({ id: f.id, parentId: f.parentId, position: f.position });

/** Модулі курсу — кореневі папки з цим `course_id`, у порядку показу. */
export function courseModules(folders: readonly EditorFolder[], courseId: number): EditorFolder[] {
  return folders.filter((f) => f.courseId === courseId && f.parentId === null)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}

/** Кореневі папки без курсу — те, що редактор пропонує додати модулем. */
export function freeModules(folders: readonly EditorFolder[]): EditorFolder[] {
  return folders.filter((f) => f.parentId === null && f.courseId == null)
    .sort((a, b) => a.position - b.position || a.id - b.id);
}
