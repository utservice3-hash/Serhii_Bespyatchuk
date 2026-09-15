/**
 * 🎓 ПРОГРЕС НАВЧАННЯ — ПОРЯДОК, ЗАМКИ, ВІДСОТОК. Чисте правило, без БД і без мережі.
 *
 * 🔴 ЧОМУ ОКРЕМИЙ МОДУЛЬ. Замок — це твердження про ПОРЯДОК, а порядок читають щонайменше
 * троє: список курсу (що показати закритим), роут відкриття (кого пустити) і відсоток
 * (що вважати зробленим). Три копії розійшлися б тихо — рівно клас «чип проти лічильника»,
 * який у цьому проєкті вже коштував 12.6% розбіжності. Тут правило одне, а роути його
 * кличуть.
 *
 * 🔴 МОДУЛЬ = КОРЕНЕВА ПАПКА (рішення власника 15.09.2026). Вкладені папки — це ГРУПИ
 * матеріалів усередині модуля, а не окремі модулі. Заміряно на проді: 16 папок, з них
 * 12 кореневих і 4 вкладені, тобто дерево дволике й порожнім це рішення не є.
 */

/** Папка: модуль (parentId = null) або група всередині модуля. */
export interface FolderRow { id: number; parentId: number | null; position: number }
/** Матеріал лежить у папці — кореневій або вкладеній. */
export interface MaterialRow { id: number; folderId: number; position: number; required: boolean }
/** Що людина вже зробила. Ключ — id матеріалу. */
export type ProgressMap = ReadonlyMap<number, "opened" | "done">;
export type MaterialState = "locked" | "available" | "opened" | "done";

export interface MaterialView {
  id: number;
  state: MaterialState;
  /** Хто саме тримає замок. `null` — не замкнено. */
  blockedBy: { materialId: number } | null;
}

/**
 * 🔴 ПОРЯДОК ТОТАЛЬНИЙ І ЯВНИЙ — `position` ОДНОГО НЕ ДОСИТЬ, І ЦЕ ЗАМІРЯНО.
 *
 * У базі НЕМАЄ `UNIQUE (folder_id, position)`, а `PATCH /material/:id` дозволяє виставити
 * довільний `position` без перетасовки сусідів — отже два матеріали з однаковим номером
 * цілком законні. Наявні роути ще й ламають тай-брейк по-різному: папки сортуються
 * `ORDER BY position, name`, матеріали — `ORDER BY position, created_at`.
 *
 * Наслідок, якби ми лишили саме так: при рівних `position` порядок між двома матеріалами
 * може відрізнятись від запиту до запиту — і замок то стоїть, то ні. Гейт при цьому
 * зеленів би, а людина ловила б плаваючий замок. Тому тай-брейк — `id`: він унікальний
 * за побудовою, не редагується й не залежить від назви чи часу створення.
 *
 * ⚠️ ПОРЯДОК ОБХОДУ: спершу матеріали САМОЇ кореневої папки, далі кожна вкладена
 * (за `position`, `id`) зі своїми матеріалами. Це рішення, а не наслідок: `position`
 * папок і матеріалів — незалежні шкали, тож «перемішати їх за номером» означало б
 * порівнювати різні одиниці.
 */
export function orderedMaterials(
  moduleId: number,
  folders: readonly FolderRow[],
  materials: readonly MaterialRow[],
): MaterialRow[] {
  const byKey = (a: { position: number; id: number }, b: { position: number; id: number }) =>
    a.position - b.position || a.id - b.id;

  const inFolder = (fid: number) => materials.filter((m) => m.folderId === fid).sort(byKey);
  const children = folders.filter((f) => f.parentId === moduleId).sort(byKey);

  return [...inFolder(moduleId), ...children.flatMap((c) => inFolder(c.id))];
}

/**
 * Стан кожного матеріалу модуля.
 *
 * 🔴 ЗАКРИТІ ВІДДАЮТЬСЯ, А НЕ ХОВАЮТЬСЯ (ТЗ, рішення власника). Людина мусить бачити, що
 * попереду ще є, і чому воно закрите. Сховати означало б, що курс на очах «коротшає», а
 * причини не видно — той самий клас, що «порожнє місце читається як нічого немає».
 *
 * ⚠️ НЕОБОВʼЯЗКОВИЙ МАТЕРІАЛ НЕ ТРИМАЄ ЗАМОК. Він не входить у 100%, отже й блокувати
 * наступний не може: інакше курс було б неможливо закінчити, не зробивши те, що ми самі
 * назвали необовʼязковим.
 */
export function materialStates(ordered: readonly MaterialRow[], progress: ProgressMap): MaterialView[] {
  let blocker: MaterialRow | null = null;
  return ordered.map((m) => {
    const done = progress.get(m.id);
    if (done === "done") return { id: m.id, state: "done", blockedBy: null };
    if (blocker) return { id: m.id, state: "locked", blockedBy: { materialId: blocker.id } };
    // Перший незроблений обовʼязковий закриває все, що за ним.
    if (m.required) blocker = m;
    return { id: m.id, state: done === "opened" ? "opened" : "available", blockedBy: null };
  });
}

/**
 * Відсоток курсу: `done ÷ усіх required × 100`, ціле.
 *
 * ⚠️ ПОРОЖНІЙ КУРС — 0, А НЕ 100. Спокуса віддати 100 («нічого робити не треба, отже все
 * зроблено») дала б «курс зараховано» там, де матеріалів ще не завели. Нуль тут чесний:
 * зроблено нічого, бо нічого й немає.
 */
export function coursePercent(ordered: readonly MaterialRow[], progress: ProgressMap): number {
  const required = ordered.filter((m) => m.required);
  if (required.length === 0) return 0;
  const done = required.filter((m) => progress.get(m.id) === "done").length;
  return Math.round((done / required.length) * 100);
}
