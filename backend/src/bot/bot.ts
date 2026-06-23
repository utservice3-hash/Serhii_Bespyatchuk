import "dotenv/config";
import { Bot } from "grammy";
import { createOrUpdateUser, listTeams, listUsers, type Role } from "../db/userService.js";
import { syncKommo } from "../jobs/syncKommo.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN env var");

const adminIds = new Set(
  (process.env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
if (adminIds.size === 0) {
  throw new Error("Missing TELEGRAM_ADMIN_IDS env var (comma-separated Telegram user IDs)");
}

export const bot = new Bot(token);

bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id ?? "");
  if (!adminIds.has(userId)) {
    await ctx.reply("⛔ У вас немає доступу до цього бота.");
    return;
  }
  await next();
});

bot.command("start", (ctx) =>
  ctx.reply(
    [
      "Дешборд UTS — бот керування.",
      "",
      "/adduser email role [team] — створити користувача",
      "  role: admin | team_lead | manager",
      "  team — обов'язково для team_lead, напр. Тендери",
      "/users — список користувачів",
      "/teams — список команд",
      "/sync — запустити синхронізацію з Kommo CRM",
    ].join("\n")
  )
);

bot.command("teams", async (ctx) => {
  const teams = await listTeams();
  await ctx.reply(teams.map((t) => `${t.id}: ${t.name}`).join("\n") || "Команд немає");
});

bot.command("users", async (ctx) => {
  const users = await listUsers();
  await ctx.reply(
    users.map((u) => `${u.email} — ${u.role}${u.team_name ? ` (${u.team_name})` : ""}`).join("\n") ||
      "Користувачів немає"
  );
});

bot.command("adduser", async (ctx) => {
  const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
  const [email, role, ...teamParts] = args;
  const team = teamParts.join(" ") || undefined;

  if (!email || !role) {
    await ctx.reply("Формат: /adduser email role [team]\nНаприклад: /adduser yatsyk@uts.dashboard team_lead Тендери");
    return;
  }
  if (!["admin", "team_lead", "manager"].includes(role)) {
    await ctx.reply("Роль має бути: admin | team_lead | manager");
    return;
  }

  try {
    const result = await createOrUpdateUser({ email, role: role as Role, teamName: team });
    await ctx.reply(
      [
        "✅ Користувача створено:",
        `Логін: ${result.email}`,
        `Пароль: ${result.password}`,
        `Роль: ${role}${team ? ` (${team})` : ""}`,
      ].join("\n")
    );
  } catch (err) {
    await ctx.reply(`❌ Помилка: ${(err as Error).message}`);
  }
});

bot.command("sync", async (ctx) => {
  await ctx.reply("⏳ Синхронізація з Kommo CRM почалась...");
  try {
    await syncKommo();
    await ctx.reply("✅ Синхронізація завершена.");
  } catch (err) {
    await ctx.reply(`❌ Помилка синхронізації: ${(err as Error).message}`);
  }
});
