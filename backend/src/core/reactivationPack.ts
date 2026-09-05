import { normalizeClientName } from "../utils/clientName.js";

/** ЛІНИВИЙ ПУЛ: модуль тримає ЧИСТІ функції й тексти запитів, і вони мусять
 *  імпортуватись без бази — інакше гейт на них неможливо виконати в оточенні
 *  без `DATABASE_URL`, тобто в найчастішому `npm test`. Спіймано на собі 05.09.2026:
 *  обидва нові гейти падали не на твердженні, а на імпорті. */
const db = async () => (await import("../db/pool.js")).pool;


/** Факти про клієнта на момент постановки задачі — знімок, не жива цифра. */
export type PackClient = {
  clientKey: string; clientName: string;
  orders?: number; revenue?: number; lastPaid?: string | null;
  category?: string; paymentType?: string | null;
};

export const PACK_DEPARTMENT = "Реактивація";

/**
 * Рядок на КЛІЄНТА, а не згорток у чеклісті.
 *
 * 🔴 ЧОМУ ЦЕ НЕ КОСМЕТИКА. Пачка зберігала клієнтів усередині `checklist_json`, тож
 * `tasks.client_key` лишався порожнім — заміряно 05.09.2026: **347 елементів у 37 пачках,
 * `client_key` у нуля**. Наслідки, кожен заміряний:
 *   ① задачі по клієнту читаються ДВОМА різними запитами (`core/reactivation.ts`), і кожна
 *      нова функція мусить уміти обидва формати;
 *   ② автозакриття «клієнт повернувся» (#334) бачить лише рядки з `client_key` — для клієнта
 *      всередині пачки воно не спрацьовує взагалі;
 *   ③ «наскільки просунулась реактивація цього клієнта» відповіді не має: стан у чеклісті
 *      живе в JSON, і його не видно ні на картці клієнта, ні у звітах.
 *
 * ⚠️ Батько лишається ОДНИМ рядком у задачнику (рішення власника, ТЗ §3.4) — діти ховаються
 * під ним, як уже роблять дні `daily_kpi`. Виконавець у дітей той самий, що в батька:
 * пачка вже приходить ПО МЕНЕДЖЕРУ (`/reactivation-candidates` групує за
 * `COALESCE(закріплений, основний за оплатами)`), тож розкидати нема чого.
 */
export const PACK_PARENT_SQL = `
  INSERT INTO tasks (title, status, assignee_id, created_by, priority, department, task_type)
  VALUES ($1,'not_started',$2,$3,'high',$4,'reactivation') RETURNING id`;

/**
 * ⚠️ Статус — ПАРАМЕТР, а не літерал. Перенесення старих пачок ставить дітям стан із
 * прапорця `done` у чеклісті, і підміняти його текстовою правкою цього рядка означало б
 * тримати другу, невидиму редакцію запиту.
 */
export const PACK_CHILD_SQL = `
  INSERT INTO tasks (title, status, assignee_id, created_by, priority, department, task_type,
                     client_key, parent_id, metrics_json)
  VALUES ($1,$8,$2,$3,'high',$4,'reactivation_client',$5,$6,$7)`;

/**
 * Чиста частина: з переліку клієнтів — заголовок пачки й рядки дітей.
 * Винесена окремо саме щоб гейт міг перевірити її БЕЗ бази.
 */
export function packRows(managerName: string, clients: readonly PackClient[]): {
  title: string;
  children: { title: string; clientKey: string; facts: Record<string, unknown> }[];
} {
  return {
    title: `🔄 Реактивація клієнтів (${clients.length}) — ${managerName}`,
    children: clients.map((c) => ({
      // 🔴 Ключ нормалізується ТІЄЮ САМОЮ функцією, що нею користується синк. Регексп
      // «прибрати пробіли» дав би сьогодні той самий результат і розійшовся б із синком
      // через півроку — рівно та помилка, яку вже ловили в `reactivationTasksByClient`.
      clientKey: normalizeClientName(c.clientKey) ?? c.clientKey,
      title: c.clientName || c.clientKey,
      facts: { orders: c.orders ?? null, revenue: c.revenue ?? null, lastPaid: c.lastPaid ?? null,
               category: c.category ?? null, paymentType: c.paymentType ?? null },
    })),
  };
}

/** Батько + діти ОДНІЄЮ транзакцією: половина пачки гірша за жодної. */
export async function createReactivationPack(a: {
  assigneeId: number; managerName: string; createdBy: number | null; clients: readonly PackClient[];
}): Promise<{ id: number; clients: number }> {
  const { title, children } = packRows(a.managerName, a.clients);
  const cl = await (await db()).connect();
  try {
    await cl.query("BEGIN");
    const r = await cl.query<{ id: number }>(PACK_PARENT_SQL,
      [title, a.assigneeId, a.createdBy, PACK_DEPARTMENT]);
    const parentId = r.rows[0].id;
    for (const ch of children) {
      await cl.query(PACK_CHILD_SQL,
        [ch.title, a.assigneeId, a.createdBy, PACK_DEPARTMENT, ch.clientKey, parentId,
         JSON.stringify(ch.facts), "not_started"]);
    }
    await cl.query("COMMIT");
    return { id: parentId, clients: children.length };
  } catch (e) { await cl.query("ROLLBACK"); throw e; } finally { cl.release(); }
}

/**
 * СТАН ДИТИНИ — З ПРАПОРЦЯ ЕЛЕМЕНТА, А НЕ З БАТЬКА. Винесено окремою чистою функцією
 * саме тому, що вона вирішує долю 347 рядків ОДИН раз і незворотно.
 *
 * 🔴 ЗАКРИТА ПАЧКА ЗАКРИВАЄ ВСІХ СВОЇХ, навіть невідмічених. Інакше перенесення
 * ВОСКРЕСИЛО Б роботу: 11 закритих пачок дали б 59 живих задач у списках менеджерів —
 * тобто дія «прибрати технічний борг» створила б людям новий.
 *
 * 🔴 ВІДМІЧЕНИЙ ЕЛЕМЕНТ ЗАКРИТИЙ І В ЖИВІЙ ПАЧЦІ. Взяти статус батька на всіх означало б
 * переписати минуле: наполовину пройдена пачка виглядала б незайманою.
 */
export function packChildStatus(itemDone: boolean | undefined, parentStatus: string): string {
  return itemDone || parentStatus === "done" ? "done" : "not_started";
}
