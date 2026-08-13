import { pool } from "../db/pool.js";
import { forEachTaskPage, type KommoTask } from "../kommo/client.js";
import { processInChunks } from "./chunkWindow.js";

/**
 * СИНК ЗАДАЧ KOMMO — четверте джерело «активності» по угоді.
 *
 * 🔴 НАВІЩО (заміряно 11.08.2026 на проді, не оцінка):
 *   • **79%** активних FC-угод мають задачу за 14 днів;
 *   • **499** із них не мають БІЛЬШЕ НІЧОГО — ні нотатки, ні дзвінка, ні руху етапу;
 *   • без задач новий критерій дав би **383** угоди замість ~130, тобто помилкових
 *     було б більше, ніж справжніх.
 *
 * 🔴 ІНКРЕМЕНТ ПО `updated_at`, А НЕ `created_at`. Закриття задачі, створеної рік
 * тому, — це вчорашня дія. Заміряно: 76 задач за 14 днів створені раніше 180 днів
 * (макс вік 624 дні), і вони зачіпають 52 активні угоди. Вікно по `created_at` їх
 * не бачить у принципі.
 *
 * 🔴 ЗБЕРІГАЄМО ОБОХ АКТОРІВ. Salesbot створює 47% задач, але **4 739** ботових
 * задач за 14 днів закрила ЛЮДИНА, і у **325 угод (204 у скоупі)** це єдина людська
 * дія. Відсіювання за `created_by <> 0` наосліп викинуло б саме їх — рішення «що
 * вважати людською дією» ухвалюється в КРИТЕРІЇ, на повних даних, а не тут.
 *
 * ⚠️ ЦЕЙ ПРОХІД НІЧОГО НЕ МІНЯЄ НА ЕКРАНАХ. Критерій застрягання не чіпається:
 * таблиця наповнюється, підключення до годинника активності — окремий прохід.
 */

let running = false;
/** Скільки хвилин перекриття перечитуємо, щоб задача, оновлена посеред проходу, не зникла. */
const OVERLAP_SEC = 300;

async function upsert(tasks: KommoTask[]): Promise<void> {
  if (!tasks.length) return;
  const ts = (u: number | null) => (u == null || u <= 0 ? null : new Date(u * 1000));
  await pool.query(
    `INSERT INTO kommo_tasks (kommo_id, entity_id, entity_type, created_by, updated_by,
        responsible_user_id, task_type_id, is_completed, created_at, updated_at, complete_till, duration, synced_at)
     SELECT * FROM UNNEST(
        $1::bigint[], $2::bigint[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[],
        $8::boolean[], $9::timestamptz[], $10::timestamptz[], $11::timestamptz[], $12::int[]
     ) AS t(kommo_id, entity_id, entity_type, created_by, updated_by, responsible_user_id,
            task_type_id, is_completed, created_at, updated_at, complete_till, duration),
        LATERAL (SELECT now()) AS s(synced_at)
     ON CONFLICT (kommo_id) DO UPDATE SET
        entity_id = EXCLUDED.entity_id, entity_type = EXCLUDED.entity_type,
        updated_by = EXCLUDED.updated_by, responsible_user_id = EXCLUDED.responsible_user_id,
        task_type_id = EXCLUDED.task_type_id, is_completed = EXCLUDED.is_completed,
        updated_at = EXCLUDED.updated_at, complete_till = EXCLUDED.complete_till,
        duration = EXCLUDED.duration, synced_at = now()`,
    [
      tasks.map((t) => t.id), tasks.map((t) => t.entityId), tasks.map((t) => t.entityType),
      tasks.map((t) => t.createdBy), tasks.map((t) => t.updatedBy),
      tasks.map((t) => t.responsibleUserId), tasks.map((t) => t.taskTypeId),
      tasks.map((t) => t.isCompleted), tasks.map((t) => ts(t.createdAt)), tasks.map((t) => ts(t.updatedAt)),
      tasks.map((t) => ts(t.completeTill)), tasks.map((t) => t.duration),
    ]
  );
}

export async function syncKommoTasks(opts: { sinceUnix?: number; untilUnix?: number } = {}): Promise<number> {
  if (running) {
    console.warn("syncKommoTasks: попередній прохід ще йде — пропускаю тік.");
    return 0;
  }
  running = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    const isBackfill = opts.sinceUnix != null;
    let sinceUnix = opts.sinceUnix;
    if (sinceUnix == null) {
      const r = await pool.query<{ last_task_at: Date | null }>(
        `SELECT last_task_at FROM sync_state WHERE id = 1`);
      const last = r.rows[0]?.last_task_at;
      sinceUnix = last ? Math.floor(last.getTime() / 1000) - OVERLAP_SEC : now - 1800;
    }
    const untilUnix = opts.untilUnix ?? now;

    // Порції ≤24 год: збій втрачає лише порцію, а не весь прогрес (та сама пастка
    // «все або нічого», що заморозила три вотермарки на IP-бані 08.07).
    // Бекфіл вотермарк НЕ рухає — інакше він перестрибнув би невичитане свіже вікно.
    const total = await processInChunks(
      sinceUnix,
      untilUnix,
      (from, to) => forEachTaskPage(from, to, upsert),
      isBackfill
        ? null
        : (chunkUntil) =>
            pool.query(`UPDATE sync_state SET last_task_at = $1 WHERE id = 1`,
              [new Date(chunkUntil * 1000)]).then(() => {})
    );
    console.log(`Kommo tasks synced: ${total} задач (${sinceUnix}..${untilUnix})`
      + `${isBackfill ? " — БЕКФІЛ, вотермарк не рухався" : ""}.`);
    return total;
  } finally {
    running = false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI: `node dist/jobs/syncKommoTasks.js --months=6` → бекфіл за N місяців по updated_at.
  const arg = process.argv.find((a) => a.startsWith("--months="));
  const months = arg ? Number(arg.split("=")[1]) : null;
  const opts = months ? { sinceUnix: Math.floor(Date.now() / 1000) - months * 30 * 24 * 60 * 60 } : {};
  syncKommoTasks(opts)
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
