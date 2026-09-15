/**
 * 🔔 НАГАДУВАННЯ ПРО НЕПІДПИСАНИЙ ОФЕР (розділ 9.4 ТЗ): щодня о 09:00 Києва бот пише адресату,
 * доки не підписано. Нічого не блокує (рішення ③). Правило «кому і чи пора» — `reminderDue`
 * (`#442c`); тут лише вибірка й відправка. Без привʼязаного Telegram нагадати нема куди —
 * такі офери рахуємо окремо в лозі, щоб керівництво бачило, кого просити привʼязатись.
 */
import { pool } from "../db/pool.js";
import { signBotConfigured, signBotSend } from "../bot/signBot.js";
import { reminderDue } from "../core/signCode.js";

export async function sendOfferReminders(): Promise<{ sent: number; noTelegram: number }> {
  if (!signBotConfigured()) { console.warn("offerReminders: бот підпису не налаштований — пропускаю."); return { sent: 0, noTelegram: 0 }; }
  const r = await pool.query<{ id: number; name: string; version: number; archived_at: string | null; reminded_at: string | null; chat_id: string | null; signed_current: boolean; sent_at: string }>(
    `SELECT f.id, f.name, f.version, f.archived_at, f.reminded_at, u.telegram_chat_id AS chat_id, f.created_at AS sent_at,
            EXISTS (SELECT 1 FROM doc_signatures s WHERE s.file_id = f.id AND s.version = f.version AND s.sha256 = f.sha256) AS signed_current
       FROM doc_files f JOIN users u ON u.id = f.addressee_user_id
      WHERE f.section = 'offer' AND f.archived_at IS NULL AND u.is_active`);
  const now = new Date();
  let sent = 0, noTelegram = 0;
  for (const f of r.rows) {
    if (!reminderDue({ section: "offer", archivedAt: f.archived_at, signedCurrent: f.signed_current, remindedAt: f.reminded_at }, now)) continue;
    if (!f.chat_id) { noTelegram++; continue; }
    const days = Math.floor((now.getTime() - new Date(f.sent_at).getTime()) / 864e5);
    const ok = await signBotSend(f.chat_id, `🔏 Нагадування: офер «${f.name}» (версія ${f.version}) чекає на ваш підпис${days > 0 ? ` уже ${days} дн.` : ""}. Відкрийте «Регламенти та документи» в дашборді → 🔒 Офери → «Підписати».`);
    if (ok) { await pool.query(`UPDATE doc_files SET reminded_at = now() WHERE id = $1`, [f.id]); sent++; }
  }
  console.log(`offerReminders: надіслано ${sent}, без Telegram ${noTelegram}, усього непідписаних перевірено ${r.rowCount}.`);
  return { sent, noTelegram };
}
