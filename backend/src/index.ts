// ⚠️ ПЕРШИМ: патч express.Router, щоб async-throw у будь-якому роуті йшов у error-middleware
// (швидкий 500), а не лишав запит висіти. Має стояти до імпортів роутерів. Див. lib/asyncRoutes.
import "./lib/asyncRoutes.js";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";
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
import { trainingRouter } from "./routes/training.js";
import { statisticsRouter } from "./routes/statistics.js";
import { statsSeriesRouter } from "./routes/statisticsSeries.js";
import { runDataReconciliation } from "./jobs/dataReconciliation.js";
import { reconcileNightly } from "./jobs/reconcileNightly.js";
import { freshnessWatch, abandonedStagesWatch } from "./jobs/freshnessWatch.js";
import { createReceivableDeadlineTasks } from "./jobs/receivableDeadlineTasks.js";
import { syncKommo } from "./jobs/syncKommo.js";
import { kommoCircuitState } from "./kommo/client.js";
import { checkFreshness, checkAbandonedStages } from "./core/reconcile.js";
import { isKommoPaused } from "./kommo/pause.js";
import { syncStageEvents, cleanupOldStageEvents } from "./jobs/syncStageEvents.js";
import { syncTransfers } from "./jobs/syncTransfers.js";
import { syncDealActivity } from "./jobs/syncDealActivity.js";
import { syncAdBudget } from "./jobs/syncAdBudget.js";
import { syncReceivables } from "./jobs/syncReceivables.js";
import { syncLeadgenRegistry } from "./jobs/syncLeadgenRegistry.js";
import { syncFirstTouch } from "./jobs/syncFirstTouch.js";
import { recomputeStatistics, getStatisticsStatus } from "./jobs/recomputeStatistics.js";
import { syncRingostatCalls, getRingostatStatus } from "./jobs/syncRingostatCalls.js";
import { syncCashIncome, getCashIncomeStatus } from "./jobs/syncCashIncome.js";
import { collectLardi } from "./jobs/collectLardi.js";
import { syncCarriers } from "./jobs/syncCarriers.js";
import { syncNews } from "./jobs/syncNews.js";
import { evaluateKpiTasks } from "./jobs/evaluateKpiTasks.js";
import { backupDb } from "./jobs/backupDb.js";
import { catchUpAiChat } from "./ai/respond.js";
import { pool } from "./db/pool.js";

// dist/index.js → ../.. = корінь сайту (dashboard/), де лежить зібраний фронт
// (index.html + assets/), який деплоїться поряд із backend/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.join(__dirname, "..", "..");

const app = express();
app.use(cors());
app.use(express.json({ limit: "60mb" }));

// 🛡 Backstop проти «зависань»: Express 4 НЕ ловить кинуті проміси в async-хендлерах —
// вони летять у process.on("unhandledRejection") (нижче), і відповідь НІКОЛИ не
// надсилається → запит висить вічно → воркер PHP-FPM тримається до таймауту → ранковий
// herd вичерпує пул → edge 503. (Саме так /overview поклав сайт 27.07.) Цей вартовий
// гарантує, що будь-який запит завершиться за ≤REQ_TIMEOUT_MS швидким 503, звільнивши
// воркер, навіть якщо майбутній баг знову лишить проміс необробленим. НЕ заміна фіксу
// логіки — це страхувальна сітка, щоб один баг більше не клав увесь дашборд.
const REQ_TIMEOUT_MS = 20_000; // > найповільнішого легіт-ендпоінта (/report ~7с) із запасом
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    console.error(`REQUEST TIMEOUT (${REQ_TIMEOUT_MS}ms) — ${req.method} ${req.originalUrl} не відповів; віддаю 503, звільняю воркер`);
    res.status(503).json({ error: "request timeout" });
  }, REQ_TIMEOUT_MS);
  res.on("finish", () => clearTimeout(timer));
  res.on("close", () => clearTimeout(timer));
  next();
});

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
app.use("/api/training", trainingRouter);
app.use("/api/statistics", statisticsRouter);
app.use("/api/statistics", statsSeriesRouter); // /series, /series/manual — падають повз депстат-роут

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
    const dc = await pool.query<{ ran_at: Date; warnings: number }>(
      `SELECT ran_at, warnings FROM data_check_state WHERE id = 1`
    ).catch(() => ({ rows: [] as { ran_at: Date; warnings: number }[] }));
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
      dataCheck: dc.rows[0] ? { ranAt: dc.rows[0].ran_at, warnings: Number(dc.rows[0].warnings) } : null,
      statistics: getStatisticsStatus(),
      ringostat: getRingostatStatus(),
      cashIncome: getCashIncomeStatus(),
    });
  } catch {
    res.json({ ok: true, sync: null });
  }
});

// КРОК 4 (Звірка): стан останньої нічної реконсиляції наше↔Kommo + цілісності.
app.get("/api/health/reconciliation", async (_req, res) => {
  try {
    const r = await pool.query<{
      ran_at: Date; ok: boolean; rows_checked: number; rows_over_threshold: number;
      max_delta_pct: string | null; integrity_orphans: number; worst_json: unknown; error: string | null;
      dashboard_over: number; dashboard_max_delta: string | null; healed_count: number;
    }>(
      `SELECT ran_at, ok, rows_checked, rows_over_threshold, max_delta_pct, integrity_orphans, worst_json, error,
              dashboard_over, dashboard_max_delta, healed_count
       FROM reconciliation_runs ORDER BY ran_at DESC LIMIT 1`
    );
    const row = r.rows[0];
    // Свіжість — ЖИВА (не з останнього нічного прогону): дешевий чек sync_state,
    // саме він ловить застряглий вотермарк між нічними звірками.
    const freshness = await checkFreshness();
    // Ч.4 — «покинуті стадії» (КРОК 6.6): стадію перестали проставляти → метрика тихо ~0.
    const abandonedStages = await checkAbandonedStages();
    if (!row) return res.json({ ok: true, reconciliation: null, freshness, abandonedStages });
    const ageHours = Math.round((Date.now() - new Date(row.ran_at).getTime()) / 3600000);
    res.json({
      ok: true,
      reconciliation: {
        ranAt: row.ran_at,
        ageHours,
        passed: row.ok,
        stale: ageHours > 30, // мала б бути свіжою після 05:00
        // три рівні
        integrityOrphans: row.integrity_orphans,
        syncOverThreshold: row.rows_over_threshold,
        syncMaxDeltaPct: row.max_delta_pct != null ? Number(row.max_delta_pct) : null,
        dashboardOverThreshold: row.dashboard_over,
        dashboardMaxDeltaPct: row.dashboard_max_delta != null ? Number(row.dashboard_max_delta) : null,
        healedCount: row.healed_count ?? 0,
        rowsChecked: row.rows_checked,
        worst: row.worst_json ?? [],
        error: row.error,
      },
      // Ч.2 — жива свіжість вотермарків (4-та перевірка).
      freshness,
      // Ч.4 — покинуті стадії (КРОК 6.6): раптове падіння обсягу подій ключової стадії.
      abandonedStages,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e).slice(0, 200) });
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
// (startup-виклик syncKommo → відкладено, див. блок «СТАРТ БЕЗ СПЛЕСКУ» наприкінці)

// Nightly reconciliation: вікно 45→10 днів (кратно менше сторінок пагінації —
// це був найбільший разовий сплеск). Лікує гепи інкременту.
cron.schedule("0 4 * * *", () => {
  if (isKommoPaused()) return;
  syncKommo({ reconcileDays: 10 }).catch((err) =>
    console.error("Kommo reconciliation failed:", err)
  );
});

// КРОК 4 (Звірка) + AUTO-HEAL. ЩОНОЧІ 03:35 — лише ОСТАННІ 2 МІСЯЦІ: швидко/дешево,
// ловить свіжу дормантність (угода не встигає застаріти непоміченою). Читає Kommo API.
// ⏰ 03:35 (не 05:00) — о 05:00 сходились syncCarriers + syncKommo(*/30) + звірка, разом
// били Kommo. О 03:35 сусід лише syncKommo(:30-тіка вже пройшла); а поки звірка тримає
// job_locks-замок — syncKommo взагалі пропускає тіки (див. jobLock.ts). Хвилина :35 (не
// :00/:30) обрана свідомо — щоб СТАРТ звірки не збігся з тіком syncKommo (*/30).
cron.schedule("35 3 * * *", () => {
  if (isKommoPaused()) return;
  reconcileNightly(2).catch((err) => console.error("reconcileNightly(2) failed:", err));
});
// РАЗ НА МІСЯЦЬ (1-го, 02:35) — ПОВНІ 12 МІСЯЦІВ: страховка на випадок, якщо нічна
// кілька разів не спрацювала. Дірка 35к була разовим артефактом (1 дормантна/12 міс),
// не течею → 12-міс скан щоночі надлишковий. ⚠️ Перед важким бекфілом — правило
// Neon-квоти в CLAUDE.md; тут навантаження на Neon мале (SELECT-и; важкі upsert-и лише
// при дормантних, а їх сплеск >10 сам алертиться). Замок job_locks тримає synKommo осторонь.
cron.schedule("35 2 1 * *", () => {
  if (isKommoPaused()) return;
  reconcileNightly(12).catch((err) => console.error("reconcileNightly(12) monthly failed:", err));
});
// Ч.2: щогодинний вартовий СВІЖОСТІ вотермарків (:50). Дешево (лише читання sync_state,
// БЕЗ Kommo) → можна часто. Будить, коли last_event_at/last_success_at/last_activity_note_at/
// last_transfer_at відстають >2× частоти джоби. Нічна звірка цього не ловила (поточний
// місяць виключено), а застряглий вотермарк тихо ламає гроші. + на старті (одразу після рестарту).
cron.schedule("50 * * * *", () => {
  freshnessWatch().catch((err) => console.error("freshnessWatch failed:", err));
});
// Ч.4 (КРОК 6.6): вартовий ПОКИНУТИХ СТАДІЙ — раз на добу (07:55). Гранулярність
// місячна (порівнює останній ПОВНИЙ місяць з медіаною 3 попередніх), тож щогодини
// не треба. Ловить зламаний CRM-процес (стадію перестали проставляти → метрика тихо
// ~0) — той самий клас, що застряглий вотермарк. Дешево: лише deal_stage_events, БЕЗ Kommo.
cron.schedule("55 7 * * *", () => {
  abandonedStagesWatch().catch((err) => console.error("abandonedStagesWatch failed:", err));
});

// syncStageEvents — КОЖНІ 30 ХВ (:15/:45). 🔴 КРИТИЧНО ДЛЯ СВІЖОСТІ ГРОШЕЙ:
// core/money.ts анкериться на deal_stage_events, тож актуальність «Отриманих коштів»
// = частота ЦІЄЇ джоби. Було 3 год → «за сьогодні» відставало до 3 год (менеджер
// закрив об 11:00 — у дашборді о 14:00). Тепер лаг ≤30 хв, збігається з syncKommo.
// Вартість +~30 req/добу (у 30-хв вікні майже завжди <100 подій → 1 сторінка) —
// тротл (1.25 req/с) цього не помічає. Зсув :15/:45 — щоб не пікувати з syncKommo(:00/:30).
// БЕЗ стартового виклику (щоб рестарт не давав сплеск).
cron.schedule("15,45 * * * *", () => {
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

// 🔴 BAG 1 (carryover): джобу snapshotCarryover ВИМКНЕНО. «Перенесені» тепер рахуються
// детерміновано з deal_stage_events на 00:00 дня-1 місяця (core/metrics.carryoverByScope,
// зона EXPECT_ZONE) — БЕЗ фріз-таблиць. Стара джоба була ДЖЕРЕЛОМ КОРУПЦІЇ: startup-виклик
// на кожному рестарті + per-manager ON CONFLICT → monthly_carryover_mgr ріс рестартами
// (Огляд 520к vs Звіт 2.0 694к). Таблиці monthly_carryover(_mgr) — легасі (дані не чіпаємо,
// просто не пишемо/не читаємо). Крон і startup-виклик прибрано.

// Ван-ту-ван нагадування: 1-го числа 06:00 + на старті (посіяти поточний місяць).
cron.schedule("0 6 1 * *", () => {
  createOneOnOneReminders().catch((err) => console.error("One-on-one reminders failed:", err));
});

// Чергування: щоранку 07:30 + на старті — задача «сьогодні ти черговий» тим,
// хто в графіку на сьогодні (ідемпотентно по даті).
cron.schedule("30 7 * * *", () => {
  createDutyReminders().catch((err) => console.error("Duty reminders failed:", err));
});

// Нічна авто-звірка даних із CRM: щодня 03:30 + на старті. Ловить «тихі» баги
// (незамаплені статуси, дублі менеджерів, застій синку) і сигналить КВП задачею.
cron.schedule("30 3 * * *", () => {
  runDataReconciliation().catch((err) => console.error("Data reconciliation failed:", err));
});

// Прострочені дедлайни оплати дебіторки → задача менеджеру «отримати оплату».
// Щодня 08:20 + на старті (ідемпотентно через task_created_at).
cron.schedule("20 8 * * *", () => {
  createReceivableDeadlineTasks().catch((err) => console.error("Receivable deadline tasks failed:", err));
});

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

// «Перший дотик» (AI-транскрибація дзвінка) — джерело правди для показника
// «озвучення ціни в перший дотик». Кожні 30 хв + на старті. TRUNCATE+insert.
cron.schedule("*/30 * * * *", () => {
  syncFirstTouch().catch((err) => console.error("First-touch sync failed:", err));
});

// Розділ «Статистики» — живий перерахунок auto-метрик (поточний місяць+тиждень).
// Щогодини + на старті. Метрики агрегатні, частіше не потрібно. UPSERT.
cron.schedule("25 * * * *", () => {
  recomputeStatistics().catch((err) => console.error("Statistics recompute failed:", err));
});

// «Кількість дзвінків» із Ringostat API (відділ «Менеджери з продажу» → sales.calls).
// Щогодини (:35) + старт. Порожній Auth-key → джоба сама себе пропускає.
cron.schedule("35 * * * *", () => {
  syncRingostatCalls().catch((err) => console.error("Ringostat calls sync failed:", err));
});

// Готівка = приход (не бюджет). Легкий фетч приходу по готівкових 142-угодах
// поточного міс+тижня. Раз на 3 год + старт (готівка змінюється повільно, тримаємо
// навантаження на Kommo низьким).
cron.schedule("50 */3 * * *", () => {
  syncCashIncome().catch((err) => console.error("Cash-income sync failed:", err));
});

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

// Backstop: a rejected query inside an un-try/catched async route handler used to
// take the WHOLE backend down (Node exits on unhandledRejection). Log and keep the
// server alive so one bad request can't blank the dashboard for everyone. The
// offending request still fails, but the process survives.
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION (kept alive):", err);
});

// Мʼяке завершення: закрити пул до Neon перед виходом (SIGTERM від хостингу перед
// SIGKILL) — щоб рестарт не лишав відкритих конекшенів. SIGKILL не перехопити, але
// якщо ліміт бʼє через SIGTERM — цей шлях відпускає конекшени чисто.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    console.log(`${sig} received — closing DB pool and exiting.`);
    pool.end().finally(() => process.exit(0));
  });
}

// 🔴 NODE.JS-РЕЖИМ (adm.tools): nginx проксує ВЕСЬ домен на цей застосунок, а Apache/
// .htaccess більше не віддає фронт. Тому Express сам віддає зібраний фронт (Vite build у
// корені сайту) + SPA-fallback. Реєструється ПІСЛЯ всіх /api-роутів. Whitelist статики —
// щоб НЕ виставити backend/, .env, docs/, .git, *.php (relay!). У старому режимі цей блок
// нешкідливий (Apache віддає статику першим, node отримує лише /api через proxy).
app.use("/assets", express.static(path.join(SITE_ROOT, "assets"), { immutable: true, maxAge: "1y" }));
app.get(["/favicon.svg", "/icons.svg"], (req, res) => res.sendFile(path.join(SITE_ROOT, req.path)));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(SITE_ROOT, "index.html")));

// 🛡 Error-middleware (ОСТАННІМ, arity 4). Async-throw з будь-якого роуту (завдяки
// lib/asyncRoutes) приходить сюди → швидкий 500 + лог, замість вічного зависання. Якщо
// заголовки вже надіслані — делегуємо стандартному обробнику Express (розрив зʼєднання).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`ROUTE ERROR ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal error" });
});

const onListen = () => console.log(`Backend listening on ${config.host ?? "0.0.0.0"}:${config.port}`);
if (config.host) app.listen(config.port, config.host, onListen);
else app.listen(config.port, onListen);

// 🔴 СТАРТ БЕЗ СПЛЕСКУ ПАМʼЯТІ (2 ГБ shared-акаунт adm.tools, crash-loop 15.07.2026).
// Раніше вся батарея синків стартувала СИНХРОННО на буті → пік памʼяті → хостинг
// убивав процес (SIGKILL, без стеку) → Supervisor рестартив → crash-loop (вотермарк
// last_event_at застрягав, бо syncStageEvents не доживав до onChunkDone). Тепер на
// буті процес ЛИШЕ піднімає Express і слухає порт; синки — ВІДКЛАДЕНО й СХОДАМИ
// (перший через 2.5 хв, далі +45с), щоб дожити до стабільного idle на мінімумі памʼяті.
// Cron-розклади незмінні — це лише разові стартові виклики. Порядок: легкі → важкі,
// syncKommo (найважчий) останнім.
const deferredStartup: Array<[string, () => Promise<unknown>]> = [
  ["freshnessWatch", () => freshnessWatch()],
  ["catchUpAiChat", () => catchUpAiChat()],
  ["createOneOnOneReminders", () => createOneOnOneReminders()],
  ["createDutyReminders", () => createDutyReminders()],
  ["createReceivableDeadlineTasks", () => createReceivableDeadlineTasks()],
  ["recomputeStatistics", () => recomputeStatistics()],
  ["syncReceivables", () => syncReceivables()],
  ["syncLeadgenRegistry", () => syncLeadgenRegistry()],
  ["syncFirstTouch", () => syncFirstTouch()],
  ["syncRingostatCalls", () => syncRingostatCalls()],
  ["syncCashIncome", () => syncCashIncome()],
  ["runDataReconciliation", () => runDataReconciliation()],
  ["syncKommo", () => (isKommoPaused() ? Promise.resolve() : syncKommo())],
];
let startupDelayMs = 150_000; // перший синк через 2.5 хв — процес встигає стати idle
for (const [name, fn] of deferredStartup) {
  setTimeout(() => {
    fn().catch((err) => console.error(`${name} startup failed:`, err));
  }, startupDelayMs);
  startupDelayMs += 45_000; // сходинки по 45с
}
