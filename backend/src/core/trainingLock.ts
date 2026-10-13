/**
 * 🔒 ЗАМОК КРОКУ НАВЧАННЯ НА ЖИВИХ ДАНИХ. Правило — `trainingProgress.ts` (чисте); тут лише
 * рядки для нього. Функція переїхала з `routes/training.ts` (прохід 2b, 18.09.2026) без зміни
 * поведінки: її кличуть «відкрив», «опрацював» і «вміст кроку», а гейт `#545` — на живій схемі.
 * Зʼєднання — параметром, `db/pool` не імпортуємо (гейт має свій клієнт).
 *
 * 📝 КУРС ДЛЯ КАНДИДАТІВ — ПОСЛІДОВНО ВЕСЬ КУРС, А НЕ ТЕМА (13.10.2026, Роман: «без проходження тесту наступний
 * модуль не відкривається»). Тест — останній обовʼязковий крок теми, тож у порядку «весь курс підряд» перший урок
 * наступної теми тримає саме несклалений тест. Екран курсу (`GET /courses/:id`) і «Найм» уже рахують стан саме
 * так — досі сервер перевіряв лише тему, і кандидат міг відкрити тему 2 запитом, хоча на екрані вона закрита.
 * Курси менеджерів (`manager`/`all`) — як і були, по темі (рішення Р6). Тримає гейт про послідовний курс.
 */
import { orderedMaterials, materialStates } from "./trainingProgress.js";
import { LESSON_ONLY, lessonOf } from "./trainingLesson.js";

export interface LockDb {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

export async function stepLockedBy(db: LockDb, uid: number, materialId: number): Promise<{ materialId: number; title: string } | null> {
  /* 📘 Частина уроку замкнена рівно тоді, коли замкнений її урок: питаємо про УРОК. Інакше вміст
     третього уроку діставався б запитом на id його презентації (`core/trainingLesson.ts`). */
  const self = await db.query<{ id: number; lesson_id: number | null }>(`SELECT id, lesson_id FROM training_materials WHERE id = $1`, [materialId]);
  if (!self.rows[0]) return null;             // немає матеріалу — про замок не йдеться
  const lessonId = lessonOf({ id: self.rows[0].id, lessonId: self.rows[0].lesson_id });
  // Послідовно, не Promise.all: на клієнті транзакції паралельні запити — черга pg із попередженням.
  const folders = await db.query<{ id: number; parent_id: number | null; position: number; course_id: number | null }>(`SELECT id, parent_id, position, course_id FROM training_folders`);
  // 🔴 Кроки — ЛИШЕ уроки: частина не тримає замок і не входить у порядок.
  const materials = await db.query<{ id: number; folder_id: number; title: string; position: number; required: boolean }>(
    `SELECT id, folder_id, title, position, required FROM training_materials WHERE status = 'published' AND ${LESSON_ONLY}`);
  const progress = await db.query<{ material_id: number; status: string }>(`SELECT material_id, status FROM training_progress WHERE user_id = $1`, [uid]);
  const me = materials.rows.find((m) => m.id === lessonId);
  if (!me) return null;                       // немає матеріалу — про замок не йдеться
  const fRows = folders.rows.map((f) => ({ id: f.id, parentId: f.parent_id, position: f.position }));
  const mRows = materials.rows.map((m) => ({ id: m.id, folderId: m.folder_id, position: m.position, required: m.required }));
  const done = new Map(progress.rows.map((p) => [p.material_id, p.status as "opened" | "done"]));

  // Модуль матеріалу: його папка, якщо коренева, інакше її батько.
  const own = folders.rows.find((f) => f.id === me.folder_id);
  const moduleId = own?.parent_id ?? own?.id;
  if (moduleId == null) return null;

  const root = folders.rows.find((f) => f.id === moduleId);
  const audience = root?.course_id != null
    ? (await db.query<{ audience: string }>(`SELECT audience FROM training_courses WHERE id = $1`, [root.course_id])).rows[0]?.audience
    : undefined;
  const ordered = audience === "candidate"
    ? folders.rows.filter((f) => f.course_id === root!.course_id && f.parent_id === null)
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .flatMap((m) => orderedMaterials(m.id, fRows, mRows))
    : orderedMaterials(moduleId, fRows, mRows);
  const st = materialStates(ordered, done).find((s) => s.id === lessonId);
  if (!st || st.state !== "locked" || !st.blockedBy) return null;
  const title = materials.rows.find((m) => m.id === st.blockedBy!.materialId)?.title ?? "";
  return { materialId: st.blockedBy.materialId, title };
}
