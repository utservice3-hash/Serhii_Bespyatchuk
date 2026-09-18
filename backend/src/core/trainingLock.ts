/**
 * 🔒 ЗАМОК КРОКУ НАВЧАННЯ НА ЖИВИХ ДАНИХ. Правило — `trainingProgress.ts` (чисте); тут лише
 * рядки для нього. Функція переїхала з `routes/training.ts` (прохід 2b, 18.09.2026) без зміни
 * поведінки: її кличуть «відкрив», «опрацював» і «вміст кроку», а гейт `#545` — на живій схемі.
 * Зʼєднання — параметром, `db/pool` не імпортуємо (гейт має свій клієнт).
 */
import { orderedMaterials, materialStates } from "./trainingProgress.js";

export interface LockDb {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

export async function stepLockedBy(db: LockDb, uid: number, materialId: number): Promise<{ materialId: number; title: string } | null> {
  // Послідовно, не Promise.all: на клієнті транзакції паралельні запити — черга pg із попередженням.
  const folders = await db.query<{ id: number; parent_id: number | null; position: number }>(`SELECT id, parent_id, position, course_id FROM training_folders`);
  const materials = await db.query<{ id: number; folder_id: number; title: string; position: number; required: boolean }>(
    `SELECT id, folder_id, title, position, required FROM training_materials WHERE status = 'published'`);
  const progress = await db.query<{ material_id: number; status: string }>(`SELECT material_id, status FROM training_progress WHERE user_id = $1`, [uid]);
  const me = materials.rows.find((m) => m.id === materialId);
  if (!me) return null;                       // немає матеріалу — про замок не йдеться
  const fRows = folders.rows.map((f) => ({ id: f.id, parentId: f.parent_id, position: f.position }));
  const mRows = materials.rows.map((m) => ({ id: m.id, folderId: m.folder_id, position: m.position, required: m.required }));
  const done = new Map(progress.rows.map((p) => [p.material_id, p.status as "opened" | "done"]));

  // Модуль матеріалу: його папка, якщо коренева, інакше її батько.
  const own = folders.rows.find((f) => f.id === me.folder_id);
  const moduleId = own?.parent_id ?? own?.id;
  if (moduleId == null) return null;

  const st = materialStates(orderedMaterials(moduleId, fRows, mRows), done).find((s) => s.id === materialId);
  if (!st || st.state !== "locked" || !st.blockedBy) return null;
  const title = materials.rows.find((m) => m.id === st.blockedBy!.materialId)?.title ?? "";
  return { materialId: st.blockedBy.materialId, title };
}
