// ⚠️ ПЕРШИМ: патч express.Router, щоб async-throw у будь-якому роуті йшов у error-middleware
// (швидкий 500), а не лишав запит висіти. Має стояти до імпортів роутерів. Див. lib/asyncRoutes.
import "./lib/asyncRoutes.js";
import { collectAlerts } from "./health/alerts.js";
import { requireAuth } from "./auth/middleware.js";
import { runJob } from "./jobs/jobRuns.js";
import { buildVersion } from "./version.js";
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
import { refreshRoles, rolesCacheSize } from "./auth/rbac.js";
import { seedOneOnOneForms } from "./oneOnOne/catalog.js";
import { bankRouter } from "./routes/bank.js";
import { trackerRouter } from "./routes/tracker.js";
import { syncBank } from "./jobs/syncBank.js";
import { kommoCircuitState } from "./kommo/client.js";
import { checkFreshness, checkAbandonedStages } from "./core/reconcile.js";
import { isKommoPaused } from "./kommo/pause.js";
import { syncStageEvents, cleanupOldStageEvents } from "./jobs/syncStageEvents.js";
import { syncTransfers } from "./jobs/syncTransfers.js";
import { syncDealActivity, healDealActivity, syncContactActivity, healContactActivity } from "./jobs/syncDealActivity.js";
import { syncAdBudget } from "./jobs/syncAdBudget.js";
import { syncReceivables } from "./jobs/syncReceivables.js";
import { syncLeadgenRegistry } from "./jobs/syncLeadgenRegistry.js";
import { syncFirstTouch } from "./jobs/syncFirstTouch.js";
import { recomputeStatistics, getStatisticsStatus } from "./jobs/recomputeStatistics.js";
import { recomputeClientKeys } from "./jobs/recomputeClientKeys.js";
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
app.use("/api/bank", bankRouter); // Виписка — банк-API (окремо від CRM)
app.use("/api/tracker", trackerRouter); // Трекер часу — власна авторизація (БЕЗ requireAuth), окрема підсистема

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
      // ТЕСТ #1: яку саме збірку крутить процес. Health із самим лише ok:true
      // одного разу 11 годин підтверджував «усе добре», поки прод крутив старий код
      // (рестарт убив не той PID). Тепер версію видно, і приймання після деплою
      // може її звірити з тим, що ми викотили.
      version: buildVersion(),
      statistics: getStatisticsStatus(),
      ringostat: getRingostatStatus(),
      cashIncome: getCashIncomeStatus(),
    });
  } catch {
    res.json({ ok: true, sync: null, version: buildVersion() });
  }
});

// КРОК 4 (Звірка): стан останньої нічної реконсиляції наше↔Kommo + цілісності.
/**
 * 🚨 Тривоги для банера в дашборді. Бачать лише керівництво (admin/ceo/opdir/kvp) —
 * менеджерам це шум. Кешу тут НЕМАЄ навмисно: перевірки дешеві (кілька SELECT +
 * один синтетичний SELECT 1), а кеш зробив би «застарілу тишу» можливою.
 */
app.get("/api/health/alerts", requireAuth, async (req, res) => {
  const roleKey = req.auth!.roleKey;
  if (!["admin", "ceo", "opdir", "kvp"].includes(roleKey)) {
    return res.status(403).json({ error: "Немає доступу" });
  }
  try {
    res.json(await collectAlerts());
  } catch (err) {
    // Навіть повний провал збірки — це ТРИВОГА, а не порожній список: інакше фронт
    // намалював би «все чисто» рівно тоді, коли нічого не перевірено.
    res.json({
      alerts: [{
        id: "check_failed:collect", severity: "critical",
        title: "Сигналізація не працює",
        detail: `Збірка тривог впала: ${err instanceof Error ? err.message : String(err)}`,
        action: "Подивитись лог сервера. Поки це так, поломки не буде видно взагалі.",
        since: null,
      }],
      checkedAt: new Date().toISOString(), checksDeclared: 0, checksRan: 0,
    });
  }
});

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
  void runJob("syncKommo", () => syncKommo());
});
// (startup-виклик syncKommo → відкладено, див. блок «СТАРТ БЕЗ СПЛЕСКУ» наприкінці)

// Nightly reconciliation: вікно 45→10 днів (кратно менше сторінок пагінації —
// це був найбільший разовий сплеск). Лікує гепи інкременту.
cron.schedule("0 4 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("syncKommo", () => syncKommo({ reconcileDays: 10 }));
});

// КРОК 4 (Звірка) + AUTO-HEAL. ЩОНОЧІ 03:35 — лише ОСТАННІ 2 МІСЯЦІ: швидко/дешево,
// ловить свіжу дормантність (угода не встигає застаріти непоміченою). Читає Kommo API.
// ⏰ 03:35 (не 05:00) — о 05:00 сходились syncCarriers + syncKommo(*/30) + звірка, разом
// били Kommo. О 03:35 сусід лише syncKommo(:30-тіка вже пройшла); а поки звірка тримає
// job_locks-замок — syncKommo взагалі пропускає тіки (див. jobLock.ts). Хвилина :35 (не
// :00/:30) обрана свідомо — щоб СТАРТ звірки не збігся з тіком syncKommo (*/30).
cron.schedule("35 3 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("reconcileNightly", () => reconcileNightly(2));
});
// РАЗ НА МІСЯЦЬ (1-го, 02:35) — ПОВНІ 12 МІСЯЦІВ: страховка на випадок, якщо нічна
// кілька разів не спрацювала. Дірка 35к була разовим артефактом (1 дормантна/12 міс),
// не течею → 12-міс скан щоночі надлишковий. ⚠️ Перед важким бекфілом — правило
// Neon-квоти в CLAUDE.md; тут навантаження на Neon мале (SELECT-и; важкі upsert-и лише
// при дормантних, а їх сплеск >10 сам алертиться). Замок job_locks тримає synKommo осторонь.
cron.schedule("35 2 1 * *", () => {
  if (isKommoPaused()) return;
  void runJob("reconcileNightly", () => reconcileNightly(12));
});
// Ч.2: щогодинний вартовий СВІЖОСТІ вотермарків (:50). Дешево (лише читання sync_state,
// БЕЗ Kommo) → можна часто. Будить, коли last_event_at/last_success_at/last_activity_note_at/
// last_transfer_at відстають >2× частоти джоби. Нічна звірка цього не ловила (поточний
// місяць виключено), а застряглий вотермарк тихо ламає гроші. + на старті (одразу після рестарту).
cron.schedule("50 * * * *", () => {
  void runJob("freshnessWatch", () => freshnessWatch());
});
// Ч.4 (КРОК 6.6): вартовий ПОКИНУТИХ СТАДІЙ — раз на добу (07:55). Гранулярність
// місячна (порівнює останній ПОВНИЙ місяць з медіаною 3 попередніх), тож щогодини
// не треба. Ловить зламаний CRM-процес (стадію перестали проставляти → метрика тихо
// ~0) — той самий клас, що застряглий вотермарк. Дешево: лише deal_stage_events, БЕЗ Kommo.
cron.schedule("55 7 * * *", () => {
  void runJob("abandonedStagesWatch", () => abandonedStagesWatch());
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
  void runJob("syncStageEvents", () => syncStageEvents());
});
cron.schedule("40 */3 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("syncDealActivity", () => syncDealActivity());
});
// ФАЗА 2 — нотатки КОНТАКТІВ (дзвінки Ringostat живуть саме там). 🔴 :10, а НЕ :40 —
// навмисно рознесено з лідовим проходом, щоб дві пагінації не били Kommo одночасно
// (памʼять про IP-бан 08.07). Заміряно: 3-год вікно = 2 запити проти 8 лідових.
cron.schedule("10 */3 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("syncContactActivity", () => syncContactActivity());
});
// 🩺 Самолікування контактної активності — щодня 05:40 (після 05:00-піку й syncTransfers 05:20).
cron.schedule("40 5 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("healContactActivity", () => healContactActivity());
});
// 🩺 Самолікування активності — щодня 04:40. Інкремент вище йде лише ВПЕРЕД від вотермарка,
// тож пропущене вікно (бан/падіння/зсув) не повертається ніколи. Цей прохід звіряє по
// СУТНОСТЯХ (нотатки лише активних FC-угод по id) і монотонно підтягує анкери. ~24 запити
// на добу — на тлі лімітів Kommo непомітно. 04:40: після нічної звірки (03:35) і до 05:00-піку.
cron.schedule("40 4 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("healDealActivity", () => healDealActivity());
});
// Lead-transfer events — раз на добу (резерв; «передані заявки» тепер із «Реєстру»).
cron.schedule("20 5 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("syncTransfers", () => syncTransfers());
});

// Ad budget (Google Ads sheet) hourly + on startup — feeds the КВП report.
cron.schedule("15 * * * *", () => {
  void runJob("syncAdBudget", () => syncAdBudget());
});
void runJob("syncAdBudget", () => syncAdBudget());

// Prune stage events older than 24 months daily at 04:30 (bounded storage).
cron.schedule("30 4 * * *", () => {
  void runJob("cleanupOldStageEvents", () => cleanupOldStageEvents(24));
});

// 🔴 BAG 1 (carryover): джобу snapshotCarryover ВИМКНЕНО. «Перенесені» тепер рахуються
// детерміновано з deal_stage_events на 00:00 дня-1 місяця (core/metrics.carryoverByScope,
// зона EXPECT_ZONE) — БЕЗ фріз-таблиць. Стара джоба була ДЖЕРЕЛОМ КОРУПЦІЇ: startup-виклик
// на кожному рестарті + per-manager ON CONFLICT → monthly_carryover_mgr ріс рестартами
// (Огляд 520к vs Звіт 2.0 694к). Таблиці monthly_carryover(_mgr) — легасі (дані не чіпаємо,
// просто не пишемо/не читаємо). Крон і startup-виклик прибрано.

// Ван-ту-ван нагадування: 1-го числа 06:00 + на старті (посіяти поточний місяць).
cron.schedule("0 6 1 * *", () => {
  void runJob("createOneOnOneReminders", () => createOneOnOneReminders());
});

// Чергування: щоранку 07:30 + на старті — задача «сьогодні ти черговий» тим,
// хто в графіку на сьогодні (ідемпотентно по даті).
cron.schedule("30 7 * * *", () => {
  void runJob("createDutyReminders", () => createDutyReminders());
});

// Нічна авто-звірка даних із CRM: щодня 03:30 + на старті. Ловить «тихі» баги
// (незамаплені статуси, дублі менеджерів, застій синку) і сигналить КВП задачею.
cron.schedule("30 3 * * *", () => {
  void runJob("runDataReconciliation", () => runDataReconciliation());
});

// Прострочені дедлайни оплати дебіторки → задача менеджеру «отримати оплату».
// Щодня 08:20 + на старті (ідемпотентно через task_created_at).
cron.schedule("20 8 * * *", () => {
  void runJob("createReceivableDeadlineTasks", () => createReceivableDeadlineTasks());
});

// Refresh receivables from the accounting Google Sheet every 15 minutes so a
// paid invoice removed from the file drops off the dashboard promptly (a manual
// "🔄 Оновити з файлу" button in the UI forces it instantly).
cron.schedule("*/15 * * * *", () => {
  void runJob("syncReceivables", () => syncReceivables());
});
// Банк-виписки — що 15 хв (окремо від CRM). Upsert по external_tx_id.
cron.schedule("*/15 * * * *", () => {
  void runJob("syncBank", () => syncBank());
});

// «Реєстр» лідоген-бота (Google Sheet) — джерело правди для «переданих заявок».
// Кожні 30 хв + на старті. TRUNCATE+insert.
cron.schedule("*/30 * * * *", () => {
  void runJob("syncLeadgenRegistry", () => syncLeadgenRegistry());
});

// «Перший дотик» (AI-транскрибація дзвінка) — джерело правди для показника
// «озвучення ціни в перший дотик». Кожні 30 хв + на старті. TRUNCATE+insert.
cron.schedule("*/30 * * * *", () => {
  void runJob("syncFirstTouch", () => syncFirstTouch());
});

// Розділ «Статистики» — живий перерахунок auto-метрик (поточний місяць+тиждень).
// Щогодини + на старті. Метрики агрегатні, частіше не потрібно. UPSERT.
cron.schedule("25 * * * *", () => {
  void runJob("recomputeStatistics", () => recomputeStatistics());
});

// 🔑 Канонічний client_key = raw + активні псевдоніми. Щогодини (:05) + старт.
// Ідемпотентна: без змін у реєстрі не чіпає жодного рядка. Під наглядом свідомо —
// джоба, що мовчки не відпрацювала, лишає аліаси застосованими НАПОЛОВИНУ, і
// «постійний клієнт» знову розколюється при цілком зеленому вигляді.
cron.schedule("5 * * * *", () => {
  void runJob("recomputeClientKeys", () => recomputeClientKeys());
});

// «Кількість дзвінків» із Ringostat API (відділ «Менеджери з продажу» → sales.calls).
// Щогодини (:35) + старт. Порожній Auth-key → джоба сама себе пропускає.
cron.schedule("35 * * * *", () => {
  void runJob("syncRingostatCalls", () => syncRingostatCalls());
});

// Готівка = приход (не бюджет). Легкий фетч приходу по готівкових 142-угодах
// поточного міс+тижня. Раз на 3 год + старт (готівка змінюється повільно, тримаємо
// навантаження на Kommo низьким).
cron.schedule("50 */3 * * *", () => {
  void runJob("syncCashIncome", () => syncCashIncome());
});

// Збирач архіву цін Lardi (калькулятор ставок) — кожні 3 години.
cron.schedule("40 */3 * * *", () => {
  void runJob("collectLardi", () => collectLardi());
});

// Перевізники з CRM (контакти успішних угод) — раз на добу, порціями
// (некритично для калькулятора; знижено з щогодини заради малого обсягу).
cron.schedule("0 5 * * *", () => {
  if (isKommoPaused()) return;
  void runJob("syncCarriers", () => syncCarriers());
});

// Fetch 3 fresh logistics-industry news items daily at 08:00.
cron.schedule("0 8 * * *", () => {
  void runJob("syncNews", () => syncNews());
});

// Evaluate KPI plan tasks (auto-complete on target). Every 30 min so today's
// composite facts are live intraday, not just after the 07:00 daily pass.
cron.schedule("*/30 * * * *", () => {
  void runJob("evaluateKpiTasks", () => evaluateKpiTasks());
});

// Independent nightly DB backup (gzipped CSV per table) at 03:00, kept 14 days.
// Neon's own PITR is primary; this is a second, portable copy on our server.
cron.schedule("0 3 * * *", () => {
  void runJob("backupDb", () => backupDb());
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

/**
 * 🔴 СТАРТ ЗА УМОВОЮ: сервер приймає запити ЛИШЕ з завантаженим роль-кешем.
 *
 * Було `.finally(listen)` — тобто при збої `refreshRoles` процес усе одно починав
 * слухати з ПОРОЖНІМ кешем. А `roleHasTab`/`roleHasPerm` тоді fail-open віддавали
 * `true` всім: у цьому стані менеджерський токен проходив `requirePerm("reset_passwords")`,
 * `view_balances`, `manage_users`. Само це не лікувалось: `refreshRoles` викликається
 * лише на старті й при записі ролі, тож кеш лишався порожнім БЕЗСТРОКОВО.
 *
 * Тепер: краще недоступний сервіс, ніж сервіс без прав доступу.
 *
 * ⏳ Ретрай — бо Neon має холодний старт (3-5 с) і `connectionTimeoutMillis: 10_000`.
 * Разова спроба зробила б рестарти крихкими саме тоді, коли БД прокидається.
 * Зростаючі паузи ~1+2+4+8+16 с ≈ 31 с сумарно, плюс до 10 с на кожен конект.
 */
const ROLE_CACHE_RETRIES = 5;
async function loadRolesOrDie(): Promise<void> {
  for (let attempt = 1; attempt <= ROLE_CACHE_RETRIES; attempt++) {
    try {
      await refreshRoles();
      if (rolesCacheSize() > 0) return;
      throw new Error("refreshRoles відпрацював, але кеш порожній (у таблиці roles нема рядків)");
    } catch (e) {
      const last = attempt === ROLE_CACHE_RETRIES;
      console.error(`refreshRoles спроба ${attempt}/${ROLE_CACHE_RETRIES} не вдалася`
        + `${last ? "" : ", повтор"}:`, e instanceof Error ? e.message : e);
      if (last) {
        console.error("🔴 РОЛЬ-КЕШ НЕ ЗАВАНТАЖЕНО — НЕ приймаю запити. Сервер із порожнім "
          + "кешем віддавав би доступ усім ролям. Перевір доступність БД і таблицю roles.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

loadRolesOrDie().then(() => {
  // 1×1 форми: гарантуємо наявність version 1 (A/Б/В) — ідемпотентно, не блокує старт.
  seedOneOnOneForms(pool).catch((e) => console.error("seedOneOnOneForms at boot failed:", e));
  if (config.host) app.listen(config.port, config.host, onListen);
  else app.listen(config.port, onListen);
});

// (в) ПЕРІОДИЧНЕ ОНОВЛЕННЯ роль-кешу. Раніше `refreshRoles` кликали лише на старті й
// при записі ролі — тож будь-яке спорожнення кешу було вічним. Раз на 10 хв дешево
// (один SELECT по 8 рядках) і робить стан самовідновним.
cron.schedule("*/10 * * * *", () => {
  refreshRoles().catch((e) => console.error("periodic refreshRoles failed:", e));
});

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
  ["recomputeClientKeys", () => recomputeClientKeys()],
  ["syncReceivables", () => syncReceivables()],
  ["syncLeadgenRegistry", () => syncLeadgenRegistry()],
  ["syncFirstTouch", () => syncFirstTouch()],
  ["syncRingostatCalls", () => syncRingostatCalls()],
  ["syncCashIncome", () => syncCashIncome()],
  ["runDataReconciliation", () => runDataReconciliation()],
  ["syncKommo", () => (isKommoPaused() ? Promise.resolve() : syncKommo())],
];
let startupDelayMs = 150_000; // перший синк через 2.5 хв — процес встигає стати idle
// 🔴 СТАРТОВІ ПРОГОНИ ТЕЖ ЧЕРЕЗ `runJob` (02.08.2026). Тут стояв голий `fn()`, тож
// жоден стартовий прогін не потрапляв у `job_runs`. Для решти джоб це маскував їхній
// власний cron-тік — але після рестарту, до першого тіку, нагляд бачив джобу як
// «мовчить», хоч вона щойно відпрацювала. І навпаки: джоба, що ВПАЛА на старті,
// не лишала сліду взагалі. Виявилось на `recomputeClientKeys`, чий перший тік аж
// о :05, — у неї вікно мовчання доходило до години.
//
// Це рівно клас «працює, але мовчить», який ми закривали весь спринт, тож стартові
// прогони тепер обліковуються нарівні з плановими: успіх рухає `last_success_at`,
// помилка пише `last_error` і НЕ стирає останній успіх.
for (const [name, fn] of deferredStartup) {
  setTimeout(() => {
    void runJob(name, fn);
  }, startupDelayMs);
  startupDelayMs += 45_000; // сходинки по 45с
}
