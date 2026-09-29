import type { Db } from "./adCallFacts.js";

/**
 * 📣 СТЕЛЯ — ОДИН РАЗ НА МІСЯЦЬ (рішення Романа 29.09.2026). Рядок `(місяць, межа)` вставляється ДО
 * відправки: вставили — шлемо, конфлікт — уже слали. Невдала відправка не повторюється щоп'ять хвилин:
 * спам у Telegram гірший за одне загублене повідомлення, а стан «стеля» видно на екрані.
 */
export async function notifyCapOnce(db: Db, scope: string, detail: string, now: Date,
  send: (text: string) => Promise<void>): Promise<boolean> {
  const month = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" }).slice(0, 7);
  const r = await db.query(
    "INSERT INTO ai_cap_alerts (month, scope, detail, sent_at) VALUES ($1, $2, $3, $4) ON CONFLICT (month, scope) DO NOTHING",
    [month, scope, detail, now.toISOString()]);
  if ((r.rowCount ?? 0) === 0) return false;
  await send(`🧾 AI-аналіз дзвінків: ${detail}. Нові розмови стоять до кінця місяця або до підняття стелі.`).catch(() => {});
  return true;
}
