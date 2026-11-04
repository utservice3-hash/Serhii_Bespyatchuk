/**
 * 🔔 Центр сповіщень дашборда (ТЗ §6) — спільний; «Зарплата» — перший модуль. Тексти й адресати будує рушій пакета
 * (`engine/notify.mjs`, байт у байт), тут — лише запис, «прочитано», автозакриття «потрібна дія» і канали.
 *  - одна подія → одне сповіщення (`notifications`) → кілька адресатів (`notification_recipients`);
 *  - «потрібна дія» закривається сама: після кожної дії бекенд переобчислює правило `done_rule` рушієм
 *    (`notificationDoneAt`) на свіжому знімку й ставить `done_at` (`closeDone`);
 *  - Telegram — бот «UTS Підпис» (`signBotSend`) на `users.telegram_chat_id`, якщо в правилі типу є канал telegram.
 * Тексти — простий текст; фронт екранує при виведенні (React).
 */
import type { Pool, PoolClient } from "pg";
import { mailConfig, mailReady, sendMail } from "./mailer.js";

type Db = Pool | PoolClient;
export interface EngineNotification { type: string; at?: string | null; to: string[]; act: boolean; cta?: string; title: string; text: string; go?: unknown; done?: unknown; empId?: string }

const toTs = (at?: string | null): string | null => (at ? (at.length > 10 ? `${at}:00` : `${at}T00:00:00`) : null);

/** Записати сповіщення рушія. Порожніх адресатів і вимкнені типи пропускаємо; повертає id створених. */
export async function emitAll(db: Db, list: EngineNotification[], opts: { telegram?: boolean } = {}): Promise<number[]> {
  const ids: number[] = [];
  if (!list.length) return ids;
  const rules = new Map((await db.query<{ type: string; enabled: boolean; channels: string[] }>(`SELECT type, enabled, channels FROM notify_rules`)).rows.map((r) => [r.type, r]));
  for (const n of list) {
    const rule = rules.get(n.type);
    if (!rule || !rule.enabled) continue;
    const to = [...new Set(n.to.map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    if (!to.length) continue;
    const act = !!n.act;
    const q = await db.query<{ id: string }>(
      `INSERT INTO notifications (type, subject_user, title, body, link, act, cta, action_key, done_rule, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE(($10::timestamp AT TIME ZONE 'Europe/Kyiv'), now())) RETURNING id::text`,
      [n.type, n.empId ? Number(n.empId) : null, n.title, n.text, n.go ? JSON.stringify(n.go) : null, act, n.cta ?? null,
        act && n.done ? JSON.stringify(n.done) : null, act && n.done ? JSON.stringify(n.done) : null, toTs(n.at)]);
    const id = Number(q.rows[0].id); ids.push(id);
    await db.query(`INSERT INTO notification_recipients (notification_id, user_id)
                    SELECT $1, u.id FROM users u WHERE u.id = ANY($2::int[]) ON CONFLICT DO NOTHING`, [id, to]);
    if (opts.telegram !== false && rule.channels.includes("telegram")) void sendTelegram(db, id, to, `${n.title}\n${n.text}`);
    if (opts.telegram !== false && rule.channels.includes("email")) void sendEmail(db, id, to, n.title, n.text);
  }
  return ids;
}

async function sendTelegram(db: Db, id: number, to: number[], text: string): Promise<void> {
  try {
    const { signBotSend } = await import("../bot/signBot.js");
    const users = (await db.query<{ id: number; chat: string }>(`SELECT id, telegram_chat_id::text AS chat FROM users WHERE id = ANY($1::int[]) AND telegram_chat_id IS NOT NULL`, [to])).rows;
    for (const u of users) if (await signBotSend(u.chat, text)) await db.query(`UPDATE notification_recipients SET telegram_sent_at = now() WHERE notification_id = $1 AND user_id = $2`, [id, u.id]);
  } catch (e) { console.error("[notify] telegram:", (e as Error).message); }
}

/** Лист кожному адресатові з поштою в акаунті. Без `SMTP_URL` — нічого (канал у налаштуваннях позначено «не налаштовано»). */
async function sendEmail(db: Db, id: number, to: number[], title: string, text: string): Promise<void> {
  const cfg = mailConfig(); if (!cfg) return;
  try {
    const users = (await db.query<{ id: number; email: string }>(`SELECT id, email FROM users WHERE id = ANY($1::int[]) AND is_active AND email LIKE '%@%'`, [to])).rows;
    for (const u of users) {
      try {
        await sendMail(cfg, u.email, title, `${text}\n\n— UTS Dashboard: https://dashboard.uts.ua`);
        await db.query(`UPDATE notification_recipients SET email_sent_at = now() WHERE notification_id = $1 AND user_id = $2`, [id, u.id]);
      } catch (e) { console.error("[notify] email:", (e as Error).message); }
    }
  } catch (e) { console.error("[notify] email:", (e as Error).message); }
}

/** Автозакриття «потрібна дія»: правило рушія на свіжому знімку. doneAt — notifier.notificationDoneAt. */
export async function closeDone(db: Db, doneAt: (n: { act: boolean; done: unknown }) => string | true | null): Promise<number> {
  const open = await db.query<{ id: string; done_rule: unknown }>(`SELECT id::text, done_rule FROM notifications WHERE act AND done_at IS NULL AND done_rule IS NOT NULL`);
  let n = 0;
  for (const r of open.rows) {
    let d: string | true | null = null;
    try { d = doneAt({ act: true, done: r.done_rule }); } catch { d = null; }
    if (!d) continue;
    await db.query(`UPDATE notifications SET done_at = CASE WHEN $2::text IS NULL THEN now() ELSE ($2::timestamp AT TIME ZONE 'Europe/Kyiv') END WHERE id = $1 AND done_at IS NULL`,
      [Number(r.id), d === true ? null : toTs(d)]);
    n++;
  }
  return n;
}

export interface NotificationView { id: number; type: string; module: string; title: string; text: string; createdAt: string; act: boolean; cta: string | null; doneAt: string | null; readAt: string | null; waitingDays: number; link: unknown }

export async function listFor(db: Db, userId: number, filter: "all" | "act" | "unread", before: number | null, limit: number): Promise<NotificationView[]> {
  const cond = filter === "act" ? "AND n.act AND n.done_at IS NULL" : filter === "unread" ? "AND r.read_at IS NULL" : "";
  const q = await db.query<{ id: string; type: string; module: string; title: string; body: string; created_at: Date; act: boolean; cta: string | null; done_at: Date | null; read_at: Date | null; link: unknown; days: number }>(
    `SELECT n.id::text, n.type, nr.module, n.title, n.body, n.created_at, n.act, n.cta, n.done_at, r.read_at, n.link,
            GREATEST(0, (now() AT TIME ZONE 'Europe/Kyiv')::date - (n.created_at AT TIME ZONE 'Europe/Kyiv')::date) AS days
       FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id JOIN notify_rules nr ON nr.type = n.type
      WHERE r.user_id = $1 ${cond} ${before ? "AND n.id < $3" : ""}
      ORDER BY n.id DESC LIMIT $2`, before ? [userId, limit, before] : [userId, limit]);
  return q.rows.map((r) => ({ id: Number(r.id), type: r.type, module: r.module, title: r.title, text: r.body, createdAt: r.created_at.toISOString(), act: r.act, cta: r.cta,
    doneAt: r.done_at ? r.done_at.toISOString() : null, readAt: r.read_at ? r.read_at.toISOString() : null, waitingDays: r.act && !r.done_at ? Number(r.days) : 0, link: r.link }));
}
export async function badgeFor(db: Db, userId: number): Promise<{ unread: number; needAction: number }> {
  const q = await db.query<{ unread: string; act: string }>(
    `SELECT count(*) FILTER (WHERE r.read_at IS NULL) AS unread, count(*) FILTER (WHERE n.act AND n.done_at IS NULL) AS act
       FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id WHERE r.user_id = $1`, [userId]);
  return { unread: Number(q.rows[0]?.unread ?? 0), needAction: Number(q.rows[0]?.act ?? 0) };
}
export async function markRead(db: Db, userId: number, ids: number[] | null): Promise<void> {
  if (ids === null) await db.query(`UPDATE notification_recipients SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  else if (ids.length) await db.query(`UPDATE notification_recipients SET read_at = now() WHERE user_id = $1 AND notification_id = ANY($2::bigint[]) AND read_at IS NULL`, [userId, ids]);
}
export async function listRules(db: Db) {
  // emailReady — чи налаштовано SMTP: галочка «email» без нього нічого не надсилає, і екран має це казати
  const emailReady = mailReady();
  return (await db.query(`SELECT type, module, act, event, recipients, channels, enabled FROM notify_rules ORDER BY module, type`)).rows.map((r) => ({ ...r, emailReady }));
}
export async function setRule(db: Db, type: string, channels: string[] | undefined, enabled: boolean | undefined): Promise<boolean> {
  const ok = ["dashboard", "telegram", "email"];
  const ch = channels ? [...new Set(channels.filter((c) => ok.includes(c)))] : null;
  if (ch && !ch.includes("dashboard")) ch.unshift("dashboard");   // дзвіночок — завжди
  const r = await db.query(`UPDATE notify_rules SET channels = COALESCE($2::text[], channels), enabled = COALESCE($3, enabled) WHERE type = $1`,
    [type, ch, typeof enabled === "boolean" ? enabled : null]);
  return (r.rowCount ?? 0) > 0;
}
