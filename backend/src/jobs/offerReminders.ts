/**
 * 🔔 ПОВІДОМЛЕННЯ ПРО ОФЕР — РІВНО ОДИН РАЗ (рішення власника 15.09.2026, вечір: «одне
 * повідомлення без нагадування»). Джоба о 09:00 Києва — лише доставка тим, у кого в момент
 * викладання офера Telegram ще не був привʼязаний; `notifyOfferOnce` кличеться одразу при
 * викладанні або новій версії. Позначка `doc_files.reminded_at` = «повідомлено»; нова версія
 * її скидає. Правило «кому» — `notifyDue` (`#442d`).
 */
import { pool } from "../db/pool.js";
import { signBotConfigured, signBotSend } from "../bot/signBot.js";
import { notifyDue } from "../core/signCode.js";

const ROW_SQL = `
  SELECT f.id, f.name, f.version, f.archived_at, f.reminded_at, u.telegram_chat_id AS chat_id,
         EXISTS (SELECT 1 FROM doc_signatures s WHERE s.file_id = f.id AND s.version = f.version AND s.sha256 = f.sha256 AND s.rejected_at IS NULL) AS signed_current
    FROM doc_files f JOIN users u ON u.id = f.addressee_user_id
   WHERE f.section = 'offer' AND f.archived_at IS NULL AND f.deleted_at IS NULL AND u.is_active`;
type Row = { id: number; name: string; version: number; archived_at: string | null; reminded_at: string | null; chat_id: string | null; signed_current: boolean };

async function notifyRow(f: Row): Promise<"sent" | "skip" | "no_telegram" | "failed"> {
  if (!notifyDue({ section: "offer", archivedAt: f.archived_at, signedCurrent: f.signed_current, remindedAt: f.reminded_at })) return "skip";
  if (!f.chat_id) return "no_telegram";
  const ok = await signBotSend(f.chat_id, `🔏 Вам надіслано офер «${f.name}» (версія ${f.version}) на підпис. Відкрийте «Регламенти та документи» в дашборді → 🔒 Офери → «Підписати». Код для підпису прийде сюди.`);
  if (!ok) return "failed";
  await pool.query(`UPDATE doc_files SET reminded_at = now() WHERE id = $1`, [f.id]);
  return "sent";
}

/** Одразу після викладання / нової версії. Тихо, якщо бот не налаштований або Telegram не привʼязаний. */
export async function notifyOfferOnce(fileId: number): Promise<void> {
  if (!signBotConfigured()) return;
  try {
    const r = await pool.query<Row>(`${ROW_SQL} AND f.id = $1`, [fileId]);
    if (r.rows[0]) await notifyRow(r.rows[0]);
  } catch (e) { console.error("notifyOfferOnce:", e); }
}

/** Джоба 09:00: доставити тим, хто привʼязав Telegram після викладання офера. */
export async function sendOfferReminders(): Promise<{ sent: number; noTelegram: number }> {
  if (!signBotConfigured()) { console.warn("offerReminders: бот підпису не налаштований — пропускаю."); return { sent: 0, noTelegram: 0 }; }
  const r = await pool.query<Row>(ROW_SQL);
  let sent = 0, noTelegram = 0;
  for (const f of r.rows) { const out = await notifyRow(f); if (out === "sent") sent++; else if (out === "no_telegram") noTelegram++; }
  console.log(`offerReminders: повідомлено ${sent}, без Telegram ${noTelegram}, перевірено ${r.rowCount}.`);
  return { sent, noTelegram };
}
