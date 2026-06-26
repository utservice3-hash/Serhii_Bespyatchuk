import express from "express";
import cors from "cors";
import cron from "node-cron";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { plansRouter } from "./routes/plans.js";
import { teamsRouter } from "./routes/teams.js";
import { tasksRouter } from "./routes/tasks.js";
import { syncKommo } from "./jobs/syncKommo.js";
import { syncReceivables } from "./jobs/syncReceivables.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/plans", plansRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/tasks", tasksRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Refresh CRM data every 15 minutes.
cron.schedule("*/15 * * * *", () => {
  syncKommo().catch((err) => console.error("Kommo sync failed:", err));
});

// Refresh receivables from the accounting Google Sheet every 30 minutes.
cron.schedule("*/30 * * * *", () => {
  syncReceivables().catch((err) => console.error("Receivables sync failed:", err));
});
syncReceivables().catch((err) => console.error("Receivables sync failed:", err));

app.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});
