import express from "express";
import cors from "cors";
import cron from "node-cron";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { plansRouter } from "./routes/plans.js";
import { teamsRouter } from "./routes/teams.js";
import { tasksRouter } from "./routes/tasks.js";
import { goalsRouter } from "./routes/goals.js";
import { settingsRouter } from "./routes/settings.js";
import { messagesRouter } from "./routes/messages.js";
import { newsRouter } from "./routes/news.js";
import { uploadsRouter, UPLOAD_DIR } from "./routes/uploads.js";
import { feedbackRouter } from "./routes/feedback.js";
import { aiWorkRouter } from "./routes/aiWork.js";
import { reportsRouter } from "./routes/reports.js";
import { ratesRouter } from "./routes/rates.js";
import { documentsRouter } from "./routes/documents.js";
import { oneOnOnesRouter } from "./routes/oneOnOnes.js";
import { createOneOnOneReminders } from "./jobs/oneOnOneReminders.js";
import { dutyRouter } from "./routes/duty.js";
import { createDutyReminders } from "./jobs/dutyReminders.js";
import { createReceivableDeadlineTasks } from "./jobs/receivableDeadlineTasks.js";
import { syncKommo } from "./jobs/syncKommo.js";
import { kommoCircuitState } from "./kommo/client.js";
import { isKommoPaused } from "./kommo/pause.js";
import { syncStageEvents, cleanupOldStageEvents } from "./jobs/syncStageEvents.js";
import { snapshotCarryover } from "./jobs/snapshotCarryover.js";
import { syncTransfers } from "./jobs/syncTransfers.js";
import { syncDealActivity } from "./jobs/syncDealActivity.js";
import { syncAdBudget } from "./jobs/syncAdBudget.js";
import { syncReceivables } from "./jobs/syncReceivables.js";
import { syncLeadgenRegistry } from "./jobs/syncLeadgenRegistry.js";
import { collectLardi } from "./jobs/collectLardi.js";
import { syncCarriers } from "./jobs/syncCarriers.js";
import { syncNews } from "./jobs/syncNews.js";
import { evaluateKpiTasks } from "./jobs/evaluateKpiTasks.js";
import { backupDb } from "./jobs/backupDb.js";
import { catchUpAiChat } from "./ai/respond.js";
import { pool } from "./db/pool.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/api/files", express.static(UPLOAD_DIR));

app.use("/api/auth", authRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/plans", plansRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/goals", goalsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/news", newsRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/ai-work", aiWorkRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/rates", ratesRouter);
app.use("/api/documents", documentsRouter);
app.use("/api/one-on-ones", oneOnOnesRouter);
app.use("/api/duty", dutyRouter);

// Health check, enriched with Kommo-sync freshness so an external monitor (or
// a quick curl) can detect a stalled sync instead of trusting a bare "ok".
app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query<{
      last_success_at: Date | null;
      last_error: string | null;
      consecutive_failures: number;
    }>(
      `SELECT last_success_at, last_error, consecutive_failures FROM sync_state WHERE id = 1`
    );
    const row = r.rows[0];
    const lastSuccessAt = row?.last_success_at ?? null;
    const ageMinutes = lastSuccessAt
      ? Math.round((Date.now() - new Date(lastSuccessAt).getTime()) / 60000)
      : null;
    // The 5-min cron should keep this well under ~15 min; flag a stall beyond that.
    const stale = ageMinutes == null || ageMinutes > 15;
    res.json({
      ok: true,
      sync: {
        lastSuccessAt,
        ageMinutes,
        stale,
        consecutiveFailures: row?.consecutive_failures ?? 0,
        lastError: row?.last_error ?? null,
      },
      kommoCircuit: kommoCircuitState(),
    });
  } catch {
    res.json({ ok: true, sync: null });
  }
});

// ⚠️ НИЗЬКОНАВАНТАЖУВАЛЬНИЙ РЕЖИМ (умова власника після IP-бану 08.07.2026):
// тримати ОБСЯГ запитів до Kommo малим, щоб WAF не забанив знову. Тому рідший
// полінг, менше вікно реконсиляції, БЕЗ стартових сплесків. Свіжість даних
// свідомо принесена в жертву стабільності доступу. Радикальне рішення — вебхуки.

// CRM data (incremental, by watermark) — 30 хв. Інкремент дешевий (лише зміни
// за вікно). Startup-синк ЗАЛИШЕНО (треба відновитись після розбану), але темп
// повільний (800мс/запит), тож навіть бек­лог тече без сплеску.
cron.schedule("*/30 * * * *", () => {
  if (isKommoPaused()) return;
  syncKommo().catch((err) => console.error("Kommo sync failed:", err));
});
if (!isKommoPaused()) syncKommo().catch((err) => console.error("Kommo startup sync failed:", err));

// Nightly reconciliation: вікно 45→10 днів (кратно менше сторінок пагінації —
// це був найбільший разовий сплеск). Лікує гепи інкременту.
cron.schedule("0 4 * * *", () => {
  if (isKommoPaused()) return;
  syncKommo({ reconcileDays: 10 }).catch((err) =>
    console.error("Kommo reconciliation failed:", err)
  );
});

// Event feeds — рідко (кожні 3 год, staggered), БЕЗ стартових викликів (щоб
// рестарт не давав сплеск). Терплять лаг.
cron.schedule("10 */3 * * *", () => {
  if (isKommoPaused()) return;
  syncStageEvents().catch((err) => console.error("Stage events sync failed:", err));
});
cron.schedule("40 */3 * * *", () => {
  if (isKommoPaused()) return;
  syncDealActivity().catch((err) => console.error("Deal activity sync failed:", err));
});
// Lead-transfer events — раз на добу (резерв; «передані заявки» тепер із «Реєстру»).
cron.schedule("20 5 * * *", () => {
  if (isKommoPaused()) return;
  syncTransfers().catch((err) => console.error("Transfers sync failed:", err));
});

// Ad budget (Google Ads sheet) hourly + on startup — feeds the КВП report.
cron.schedule("15 * * * *", () => {
  syncAdBudget().catch((err) => console.error("Ad budget sync failed:", err));
});
syncAdBudget().catch((err) => console.error("Ad budget startup sync failed:", err));

// Prune stage events older than 24 months daily at 04:30 (bounded storage).
cron.schedule("30 4 * * *", () => {
  cleanupOldStageEvents(24).catch((err) => console.error("Stage events cleanup failed:", err));
});

// Snapshot carried-over (in-progress) deal value at the start of each month +
// on startup (seeds the current month if it hasn't been captured yet).
cron.schedule("0 0 1 * *", () => {
  snapshotCarryover().catch((err) => console.error("Carryover snapshot failed:", err));
});
snapshotCarryover().catch((err) => console.error("Carryover startup snapshot failed:", err));

// Ван-ту-ван нагадування: 1-го числа 06:00 + на старті (посіяти поточний місяць).
cron.schedule("0 6 1 * *", () => {
  createOneOnOneReminders().catch((err) => console.error("One-on-one reminders failed:", err));
});
createOneOnOneReminders().catch((err) => console.error("One-on-one reminders startup failed:", err));

// Чергування: щоранку 07:30 + на старті — задача «сьогодні ти черговий» тим,
// хто в графіку на сьогодні (ідемпотентно по даті).
cron.schedule("30 7 * * *", () => {
  createDutyReminders().catch((err) => console.error("Duty reminders failed:", err));
});
createDutyReminders().catch((err) => console.error("Duty reminders startup failed:", err));

// Прострочені дедлайни оплати дебіторки → задача менеджеру «отримати оплату».
// Щодня 08:20 + на старті (ідемпотентно через task_created_at).
cron.schedule("20 8 * * *", () => {
  createReceivableDeadlineTasks().catch((err) => console.error("Receivable deadline tasks failed:", err));
});
createReceivableDeadlineTasks().catch((err) => console.error("Receivable deadline tasks startup failed:", err));

// Refresh receivables from the accounting Google Sheet every 15 minutes so a
// paid invoice removed from the file drops off the dashboard promptly (a manual
// "🔄 Оновити з файлу" button in the UI forces it instantly).
cron.schedule("*/15 * * * *", () => {
  syncReceivables().catch((err) => console.error("Receivables sync failed:", err));
});

// «Реєстр» лідоген-бота (Google Sheet) — джерело правди для «переданих заявок».
// Кожні 30 хв + на старті. TRUNCATE+insert.
cron.schedule("*/30 * * * *", () => {
  syncLeadgenRegistry().catch((err) => console.error("Leadgen registry sync failed:", err));
});
syncLeadgenRegistry().catch((err) => console.error("Leadgen registry startup sync failed:", err));

// Збирач архіву цін Lardi (калькулятор ставок) — кожні 3 години.
cron.schedule("40 */3 * * *", () => {
  collectLardi().catch((err) => console.error("Lardi collect failed:", err));
});

// Перевізники з CRM (контакти успішних угод) — раз на добу, порціями
// (некритично для калькулятора; знижено з щогодини заради малого обсягу).
cron.schedule("0 5 * * *", () => {
  if (isKommoPaused()) return;
  syncCarriers().catch((err) => console.error("Carriers sync failed:", err));
});
syncReceivables().catch((err) => console.error("Receivables sync failed:", err));

// Fetch 3 fresh logistics-industry news items daily at 08:00.
cron.schedule("0 8 * * *", () => {
  syncNews().catch((err) => console.error("News sync failed:", err));
});

// Evaluate KPI plan tasks (auto-complete on target). Every 30 min so today's
// composite facts are live intraday, not just after the 07:00 daily pass.
cron.schedule("*/30 * * * *", () => {
  evaluateKpiTasks().catch((err) => console.error("KPI task eval failed:", err));
});

// Independent nightly DB backup (gzipped CSV per table) at 03:00, kept 14 days.
// Neon's own PITR is primary; this is a second, portable copy on our server.
cron.schedule("0 3 * * *", () => {
  backupDb().catch((err) => console.error("DB backup failed:", err));
});

// «Робота з АІ»: answer a user message that arrived while the server was down.
catchUpAiChat().catch((err) => console.error("AI chat catch-up failed:", err));

app.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});
