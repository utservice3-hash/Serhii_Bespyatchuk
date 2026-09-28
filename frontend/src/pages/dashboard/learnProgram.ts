/**
 * 🗂 ПРОГРАМА КУРСУ ЯК У SEREDA — ЧИСТІ ЛІЧИЛЬНИКИ (28.09.2026, «все як в середі»).
 *
 * Заміряно на курсі Sereda «для менеджерів з продажу»: під назвою теми — «1 з 1 уроку», праворуч кільце
 * «1/1»; у бічній панелі уроку — «20 з 20 уроків · 100%» і кнопка «Наступний». Тут лише ЧИСЛА для цих
 * підписів; стан кожного уроку (пройдено / доступно / замкнено) рахує СЕРВЕР (`core/trainingProgress.ts`),
 * і тут його не перераховують — друга копія правила замка розійшлася б із першою мовчки (`#708`).
 *
 * 🔴 БЕЗ ІМПОРТІВ, свідомо: гейт `#733` транспілює й ВИКОНУЄ цей файл.
 */

export type LessonState = "locked" | "available" | "opened" | "done";
export interface ProgramLesson { id: number; title: string; kind: string; required: boolean; state: LessonState; blockedBy: { materialId: number; title: string } | null }
export interface ProgramModule { id: number; name: string; materials: ProgramLesson[] }

/** «1 з 1 уроку» / «4 з 6 уроків» — українська форма за останньою цифрою, як у Sereda. */
export function lessonsWord(n: number): string {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return "уроку";
  return "уроків";
}
export function lessonsCount(n: number): string {
  const d = n % 10, dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} урок`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} уроки`;
  return `${n} уроків`;
}

export interface ModuleStat { done: number; total: number; complete: boolean }
/** Тема: скільки уроків пройдено з усіх. «Завершена» — коли пройдено всі обовʼязкові (як і відсоток курсу). */
export function moduleStat(m: ProgramModule): ModuleStat {
  const total = m.materials.length;
  const done = m.materials.filter((x) => x.state === "done").length;
  const req = m.materials.filter((x) => x.required);
  return { done, total, complete: req.length > 0 ? req.every((x) => x.state === "done") : total > 0 && done === total };
}

export interface ProgramStat { lessons: number; done: number; modules: number; next: ProgramLesson | null }
/** Весь курс: уроки, пройдені, теми й наступний урок — перший доступний або відкритий. */
export function programStat(mods: readonly ProgramModule[]): ProgramStat {
  const all = mods.flatMap((m) => m.materials);
  return {
    lessons: all.length,
    done: all.filter((x) => x.state === "done").length,
    modules: mods.length,
    next: all.find((x) => x.state === "available" || x.state === "opened") ?? null,
  };
}

/** Урок після поточного в порядку курсу — для «Наступний». `null`, якщо поточний останній. */
export function lessonAfter(mods: readonly ProgramModule[], id: number): ProgramLesson | null {
  const all = mods.flatMap((m) => m.materials);
  const i = all.findIndex((x) => x.id === id);
  return i >= 0 ? all[i + 1] ?? null : null;
}

/** Тема, яку розгорнути: де поточний урок, інакше де наступний, інакше перша. */
export function openModuleId(mods: readonly ProgramModule[], currentId: number | null): number | null {
  const has = (id: number | null | undefined) => (id == null ? null : mods.find((m) => m.materials.some((x) => x.id === id))?.id ?? null);
  return has(currentId) ?? has(programStat(mods).next?.id) ?? mods[0]?.id ?? null;
}
