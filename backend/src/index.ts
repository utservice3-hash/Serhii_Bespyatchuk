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
import { ratesRouter } from "./routes/rates.js";
import { syncKommo } from "./jobs/syncKommo.js";
import { syncStageEvents, cleanupOldStageEvents } from "./jobs/syncStageEvents.js";
import { snapshotCarryover } from "./jobs/snapshotCarryover.js";
import { syncTransfers } from "./jobs/syncTransfers.js";
import { syncDealActivity } from "./jobs/syncDealActivity.js";
import { syncAdBudget } from "./jobs/syncAdBudget.js";
import { syncReceivables } from "./jobs/syncReceivables.js";
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
app.use("/api/rates", ratesRouter);

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
    });
  } catch {
    res.json({ ok: true, sync: null });
  }
});

// Refresh CRM data every 5 minutes (incremental, by watermark).
cron.schedule("*/5 * * * *", () => {
  syncKommo().catch((err) => console.error("Kommo sync failed:", err));
});

// Pull immediately on startup so a restart recovers stale data at once instead
// of waiting up to 5 minutes for the first cron tick.
syncKommo().catch((err) => console.error("Kommo startup sync failed:", err));

// Nightly reconciliation: re-pull the last 45 days ignoring the watermark, to
// heal gaps the incremental sync can't (a deal whose status changed during a
// past outage is never re-fetched, since its updated_at predates the mark).
cron.schedule("0 4 * * *", () => {
  syncKommo({ reconcileDays: 45 }).catch((err) =>
    console.error("Kommo reconciliation failed:", err)
  );
});

// Stage-transition events (for entry-date metrics) every 10 minutes + on startup.
cron.schedule("*/10 * * * *", () => {
  syncStageEvents().catch((err) => console.error("Stage events sync failed:", err));
});

// Lead-transfer events ("передані заявки") every 10 minutes + on startup.
cron.schedule("*/10 * * * *", () => {
  syncTransfers().catch((err) => console.error("Transfers sync failed:", err));
});

// Real (human) deal activity from lead notes every 10 minutes + on startup —
// feeds "stuck deals" so Salesbot activity никогда не скидає таймер.
cron.schedule("*/10 * * * *", () => {
  syncDealActivity().catch((err) => console.error("Deal activity sync failed:", err));
});

// Startup catch-up for the Kommo event feeds — STAGGERED, not simultaneous.
// Firing deals+events+transfers+notes at once right after a restart is exactly
// the burst that trips Kommo's WAF (the 08.07.2026 IP ban); spreading them a
// couple of minutes apart keeps the recovery behaviour without the spike.
setTimeout(() => {
  syncStageEvents().catch((err) => console.error("Stage events startup sync failed:", err));
}, 2 * 60 * 1000);
setTimeout(() => {
  syncTransfers().catch((err) => console.error("Transfers startup sync failed:", err));
}, 4 * 60 * 1000);
setTimeout(() => {
  syncDealActivity().catch((err) => console.error("Deal activity startup sync failed:", err));
}, 6 * 60 * 1000);

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

// Refresh receivables from the accounting Google Sheet every 15 minutes so a
// paid invoice removed from the file drops off the dashboard promptly (a manual
// "🔄 Оновити з файлу" button in the UI forces it instantly).
cron.schedule("*/15 * * * *", () => {
  syncReceivables().catch((err) => console.error("Receivables sync failed:", err));
});

// Збирач архіву цін Lardi (калькулятор ставок) — кожні 3 години.
cron.schedule("40 */3 * * *", () => {
  collectLardi().catch((err) => console.error("Lardi collect failed:", err));
});

// Перевізники з CRM (контакти успішних угод) — щогодини, порціями.
cron.schedule("50 * * * *", () => {
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
