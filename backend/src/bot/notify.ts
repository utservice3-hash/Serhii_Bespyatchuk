/**
 * Легкий Telegram-нотифікатор для алертів з ОСНОВНОГО процесу застосунку
 * (grammy-бот живе в окремому процесі `npm run bot`). Прямий виклик Bot API
 * через fetch — без залежності від grammy. Тихо no-op, якщо TG не налаштований.
 */
export async function sendAdminAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = (process.env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!token || ids.length === 0) {
    console.warn("sendAdminAlert: TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_IDS не налаштовані — пропускаю алерт.");
    return;
  }
  for (const id of ids) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true }),
      });
      if (!r.ok) console.error(`sendAdminAlert: TG ${r.status} для ${id}`);
    } catch (e) {
      console.error("sendAdminAlert failed:", e);
    }
  }
}
