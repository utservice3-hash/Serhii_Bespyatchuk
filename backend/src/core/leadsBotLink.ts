import type { Db } from "./adCallFacts.js";
import { generateSignCode, LINK_TOKEN_TTL_MS } from "./signCode.js";
import { workedMonth } from "./linkedinQueue.js";

/**
 * 🤖 Підключення бота «UTS Заявки» (черга LinkedIn, задача 7361): та сама схема, що в бота підпису — 6 цифр на 10 хв,
 * deep-link `t.me/<бот>?start=<код>` або код повідомленням. Без підключеного бота менеджеру черга нічого не дає.
 */

export async function createLeadsLinkCode(db: Db, userId: number, now = new Date()): Promise<string> {
  let code = generateSignCode();
  for (let i = 0; i < 5; i++) {
    const clash = await db.query(`SELECT 1 FROM leads_bot_link_codes WHERE code = $1 AND used_at IS NULL AND expires_at > $2`, [code, now]);
    if (!clash.rowCount) break;
    code = generateSignCode();
  }
  await db.query(`INSERT INTO leads_bot_link_codes (user_id, code, expires_at) VALUES ($1, $2, $3)`,
    [userId, code, new Date(now.getTime() + LINK_TOKEN_TTL_MS)]);
  return code;
}

const HELP = "Це бот заявок LinkedIn дашборда UTS. Щоб підключити: у дашборді натисніть «Підключити бот заявок» і надішліть сюди код із 6 цифр.";

/** Текст від людини → відповідь бота. Прив'язує чат до акаунта за живим кодом; код одноразовий. */
export async function linkLeadsChat(db: Db, text: string, chatId: number | string, now = new Date()): Promise<string> {
  const m = /^\/start(?:@\w+)?\s+(\d{6})$/.exec(text.trim()) ?? /^(\d{6})$/.exec(text.trim());
  if (!m) return HELP;
  const row = (await db.query<{ id: number; user_id: number; name: string }>(
    `SELECT c.id, c.user_id, COALESCE(mg.name, u.email) AS name FROM leads_bot_link_codes c
       JOIN users u ON u.id = c.user_id LEFT JOIN managers mg ON mg.id = u.manager_id
      WHERE c.code = $1 AND c.used_at IS NULL AND c.expires_at > $2 ORDER BY c.created_at DESC LIMIT 1`, [m[1], now])).rows[0];
  if (!row) return "Код не знайдено або він застарів. Натисніть «Підключити бот заявок» у дашборді ще раз.";
  await db.query(`UPDATE leads_bot_link_codes SET used_at = $2 WHERE id = $1`, [row.id, now]);
  // Один чат — один акаунт: якщо цей Telegram уже був привʼязаний до іншого користувача, там його знімаємо.
  await db.query(`UPDATE users SET leads_bot_chat_id = NULL, leads_bot_linked_at = NULL WHERE leads_bot_chat_id = $1 AND id <> $2`, [String(chatId), row.user_id]);
  await db.query(`UPDATE users SET leads_bot_chat_id = $2, leads_bot_linked_at = $3 WHERE id = $1`, [row.user_id, String(chatId), now]);
  return `✅ Готово, ${row.name}. Сюди приходитимуть заявки з LinkedIn — з кнопкою «Взяти».`;
}

/**
 * Кому показувати «Підключіть бот заявок» (Роман 04.11.2026): менеджерам і тімлідам зі стажем від 1 місяця (як у ТЗ:
 * «беруть менеджери, які відпрацювали від 1 місяця»), а також будь-кому, кого Юля вже внесла в коло.
 */
export async function leadsBotStatus(db: Db, userId: number, now = new Date()): Promise<{ linked: boolean; inQueue: boolean; eligible: boolean }> {
  const r = (await db.query<{ linked: boolean; in_queue: boolean; role: string; hired_at: string | null }>(
    `SELECT u.leads_bot_chat_id IS NOT NULL AS linked, COALESCE(u.role_override, u.role) AS role,
            EXISTS (SELECT 1 FROM linkedin_queue_members q WHERE q.manager_id = u.manager_id) AS in_queue,
            (SELECT e.hired_at::text FROM employees e WHERE e.manager_id = u.manager_id AND u.manager_id IS NOT NULL LIMIT 1) AS hired_at
       FROM users u WHERE u.id = $1 AND u.is_active`, [userId])).rows[0];
  if (!r) return { linked: false, inQueue: false, eligible: false };
  const today = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
  const eligible = r.in_queue || ((r.role === "manager" || r.role === "team_lead") && workedMonth(r.hired_at, today));
  return { linked: r.linked, inQueue: r.in_queue, eligible };
}
