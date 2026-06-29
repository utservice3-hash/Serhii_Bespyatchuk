import express from "express";
import cors from "cors";
import cron from "node-cron";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { plansRouter } from "./routes/plans.js";
import { teamsRouter } from "./routes/teams.js";
import { tasksRouter } from "./routes/tasks.js";
import { settingsRouter } from "./routes/settings.js";
import { messagesRouter } from "./routes/messages.js";
import { newsRouter } from "./routes/news.js";
import { uploadsRouter, UPLOAD_DIR } from "./routes/uploads.js";
import { syncKommo } from "./jobs/syncKommo.js";
import { syncReceivables } from "./jobs/syncReceivables.js";
import { syncNews } from "./jobs/syncNews.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use("/api/files", express.static(UPLOAD_DIR));

app.use("/api/auth", authRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/plans", plansRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/news", newsRouter);
app.use("/api/uploads", uploadsRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Refresh CRM data every 5 minutes.
cron.schedule("*/5 * * * *", () => {
  syncKommo().catch((err) => console.error("Kommo sync failed:", err));
});

// Refresh receivables from the accounting Google Sheet every 30 minutes.
cron.schedule("*/30 * * * *", () => {
  syncReceivables().catch((err) => console.error("Receivables sync failed:", err));
});
syncReceivables().catch((err) => console.error("Receivables sync failed:", err));

// Fetch 3 fresh logistics-industry news items daily at 08:00.
cron.schedule("0 8 * * *", () => {
  syncNews().catch((err) => console.error("News sync failed:", err));
});

app.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});
