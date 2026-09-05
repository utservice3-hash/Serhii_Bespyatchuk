/** ЛІНИВИЙ ПУЛ: модуль тримає перелік дій і текст запиту — чисті речі, які мусять
 *  імпортуватись без бази, інакше гейт на них не виконається в оточенні без
 *  `DATABASE_URL` (найчастіший `npm test`). Спіймано на собі 05.09.2026: гейт падав
 *  не на твердженні, а на імпорті — тобто доводив лише те, що модуль підвантажився. */
const db = async () => (await import("../db/pool.js")).pool;

/**
 * 🗒 СЛІД КЕРІВНИЦЬКОЇ ДІЇ ПО КЛІЄНТУ — хто, коли, з ким і чому.
 *
 * 🔴 ЖУРНАЛ, А НЕ СТАН. Обидві дії, які він накриває, сьогодні лишають по собі лише
 * ПОТОЧНИЙ стан, і одна з них свій слід ЗАТИРАЄ: повернення з архіву занулює
 * `archived_at`/`archive_reason`/`archived_by`, тож після нього неможливо сказати, що
 * клієнт узагалі був в архіві. Той самий клас, що «історії прогонів джоб немає»:
 * питання «хто це зробив» не має відповіді в принципі, а не «її важко дістати».
 *
 * ⚠️ Запис журналу НЕ в транзакції з дією — і це свідомо. Дія важливіша за слід:
 * якщо журнал упаде, клієнт однаково має поїхати в архів. Тому виклик не кидає
 * помилку назовні, а лишає її в лозі.
 */
export const CLIENT_ADMIN_ACTIONS = ["archive", "unarchive", "manager_change"] as const;
export type ClientAdminAction = (typeof CLIENT_ADMIN_ACTIONS)[number];

export const CLIENT_ADMIN_LOG_SQL =
  `INSERT INTO client_admin_log (client_key, action, actor_user_id, details) VALUES ($1,$2,$3,$4)`;

export async function logClientAdmin(
  action: ClientAdminAction, clientKey: string,
  actorUserId: number | null, details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await (await db()).query(CLIENT_ADMIN_LOG_SQL, [clientKey, action, actorUserId, JSON.stringify(details)]);
  } catch (e) {
    console.error("[client_admin_log] не записався:", (e as Error).message);
  }
}

/** Стрічка по клієнту — для картки. Ліміт названий, а не «останні». */
export const CLIENT_ADMIN_LOG_LIMIT = 20;
export async function clientAdminLog(clientKey: string): Promise<{
  at: string; action: string; actor: string | null; details: Record<string, unknown>;
}[]> {
  const r = await (await db()).query<{ at: string; action: string; actor: string | null; details: Record<string, unknown> }>(
    `SELECT to_char(l.at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD HH24:MI') AS at, l.action,
            COALESCE(m.name, u.email) AS actor, l.details
       FROM client_admin_log l
       LEFT JOIN users u ON u.id = l.actor_user_id
       LEFT JOIN managers m ON m.id = u.manager_id
      WHERE l.client_key = $1
      ORDER BY l.at DESC LIMIT ${CLIENT_ADMIN_LOG_LIMIT}`, [clientKey]);
  return r.rows;
}
