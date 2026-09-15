import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import { pool } from "../db/pool.js";
import { createReactivationPack } from "../core/reactivationPack.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasPerm, isAdminScope } from "../auth/rbac.js";
import { UPLOAD_DIR } from "./uploads.js";
import {
  canSeeTask, canTouchTask as mayTouch, visibilityCondSql,
  isTaskOwner, ownerCondSql,
  TASK_OWNER_JOINS, ASSIGNEE_TEAM_SQL,
  type TaskViewer, type TaskOwnerRow,
} from "../core/taskVisibility.js";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

/**
 * 📎 ТЕКА ВКЛАДЕНЬ — ПОЗА `uploads/`, як і регламенти. Публічний static
 * `/api/files` віддає вміст `uploads/` за прямим URL без токена, тож вкладення
 * задач там лежати не можуть: задача буває особистою.
 */
const TASK_FILES_DIR = path.join(UPLOAD_DIR, "..", "task-files");
/** Ліміт файла — рішення Романа 14.09.2026. */
const FILE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Ліміт кількості на задачу — рішення Романа 14.09.2026: **два**.
 * 🔴 Дзеркалиться у фронті (`TASK_FILES_PER_TASK`), і цю пару звіряє гейт `#400i`:
 * дві копії числа розходяться мовчки, а розходження тут означає, що екран обіцяє
 * третій файл, а сервер відмовляє — тобто «нічого не сталось» без причини.
 */
const FILES_PER_TASK = 2;

/** Погляд на межу з токена: одне перетворення на весь файл. */
const viewerOf = (auth: {
  role: string; roleKey: string; userId: number; managerId: number | null; teamId: number | null;
}): TaskViewer => ({
  role: auth.role, userId: auth.userId, managerId: auth.managerId, teamId: auth.teamId,
  adminScope: isAdminScope(auth),
});

/** Ідентифікатор із шляху. `NaN` — це 400, а не падіння запиту в БД. */
function pathId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const STATUSES = [
  "todo_list",
  "to_realize",
  "planned",
  "not_started",
  "deferred",
  "in_progress",
  "ball_on_executor",
  "ready_for_approval",
  "done",
] as const;

const PRIORITIES = ["low", "medium", "high"] as const;

const upsertSchema = z.object({
  title: z.string().min(1),
  status: z.enum(STATUSES).optional(),
  deadline: z.string().nullable().optional(),
  assigneeId: z.number().nullable().optional(),
  // Одна задача на КІЛЬКОХ менеджерів (створюється копія кожному).
  assigneeIds: z.array(z.number()).optional(),
  /** Виконавець-АКАУНТ — для тих, кого немає в CRM (бухгалтерія, HR, рекрутер). */
  assigneeUserId: z.number().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  comments: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  /** Особиста група-папка автора. Доступу не змінює — лише розкладку. */
  groupId: z.number().nullable().optional(),
});

const checklistItem = z.object({
  clientKey: z.string(),
  clientName: z.string(),
  orders: z.number().optional(),
  revenue: z.number().optional(),
  lastPaid: z.string().nullable().optional(),
  category: z.string().optional(),
  paymentType: z.string().nullable().optional(),
  done: z.boolean().optional(),
  comment: z.string().nullable().optional(),
});

const subtaskItem = z.object({
  title: z.string(),
  done: z.boolean().optional(),
});

const patchSchema = upsertSchema.partial().extend({
  checklistJson: z.array(checklistItem).nullable().optional(),
  subtasksJson: z.array(subtaskItem).nullable().optional(),
});

tasksRouter.get("/", async (req, res) => {
  const auth = req.auth!;

  const params: unknown[] = [];
  const push = (v: unknown) => { params.push(v); return params.length; };

  // 🔴 ВЛАСНІСТЬ ЗАДАЧ — ПРАВИЛО ЖИВЕ В `core/taskVisibility.ts`, ОДНЕ НА ПРОЄКТ.
  // Тут лишається тільки підстановка параметрів. Доти умова стояла в цьому файлі
  // ДВІЧІ — тут і в `canTouchTask` — і копії розійшлись: автор-менеджер міг
  // ЗМІНИТИ задачу, яку створив колезі, але НЕ БАЧИВ її у списку. Інваріанту
  // «хто змінює — той бачить» тримає `#400`.
  const me = push(auth.userId);
  const where = `WHERE ${visibilityCondSql(viewerOf(auth), push)}`;

  const result = await pool.query(
    `SELECT t.id, t.title, t.status, to_char(t.deadline, 'YYYY-MM-DD') AS deadline, t.assignee_id AS "assigneeId",
            -- 👤 ОДНЕ ІМʼЯ ВИКОНАВЦЯ з двох можливих джерел: менеджер із CRM або
            -- акаунт (бухгалтерія/HR/рекрутер). Обидва поля разом неможливі —
            -- тримає CHECK tasks_one_assignee.
            COALESCE(m.name, au.full_name, au.email) AS "assigneeName",
            t.assignee_user_id AS "assigneeUserId",
            t.group_id AS "groupId",
            -- 📁 Назва групи — ЛИШЕ ВЛАСНОЇ. Група особиста (рішення Романа
            -- 14.09), тож чужа для цього глядача виглядає як «без групи»: інакше
            -- назва папки колеги протікала б через кожну спільну задачу.
            CASE WHEN g.owner_id = $${me} THEN g.name END AS "groupName",
            COALESCE(tc.n, 0) AS "commentCount",
            -- 📎 ЛІЧИЛЬНИК ВКЛАДЕНЬ ЗНАЄ МЕЖУ ВЛАСНИКА (рішення власника 14.09.2026:
            -- «файли тільки для власників цієї задачі»). Наглядач бачить задачу,
            -- але не її файли.
            -- 🔴 НЕ ВЛАСНИКУ — NULL, А НЕ НУЛЬ. Нуль означає «вкладень немає», і
            -- екран написав би «—» на задачі, у якої файл Є: наглядач, що зайшов
            -- перевірити, чи приклали акт, прочитав би пряму неправду. NULL —
            -- це «не знаю, бо не моє», і колонка малює замок. Правило проєкту:
            -- порожній скоуп НЕ виражається нулем (нуль falsy, і діра відтворюється
            -- під іншим числом).
            -- ⚠️ І БЕЗ БЕКТИКІВ: цей коментар живе ВСЕРЕДИНІ шаблонного літерала,
            -- тож бектик тут — синтаксична помилка, а не форматування.
            CASE WHEN ${ownerCondSql(viewerOf(auth), push)} THEN COALESCE(tf.n, 0) END AS "fileCount",
            -- 📎 Хто поклав файли — теж лише власнику, тією самою межею.
            CASE WHEN ${ownerCondSql(viewerOf(auth), push)} THEN tf.authors END AS "fileAuthors",
            -- 🔔 «Є НОВЕ» — це «зʼявилось ПІСЛЯ мого останнього перегляду і НЕ
            -- мною». Без task_views таке твердження було б здогадом, тому
            -- бейдж спирається на збережений момент перегляду, а не на
            -- updated_at (його рухає і власна правка).
            (EXISTS (SELECT 1 FROM task_comments c
                      WHERE c.task_id = t.id AND c.author_id <> $${me}
                        AND (tv.seen_at IS NULL OR c.created_at > tv.seen_at))
             OR EXISTS (SELECT 1 FROM task_status_log sl
                         WHERE sl.task_id = t.id AND sl.changed_by <> $${me}
                           AND (tv.seen_at IS NULL OR sl.changed_at > tv.seen_at))) AS "hasUnseen",
            t.priority, t.comments, t.department,
            t.task_type AS "taskType", t.metric, t.target_value AS "targetValue",
            t.actual_value AS "actualValue", to_char(t.plan_date, 'YYYY-MM-DD') AS "planDate",
            to_char(t.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(t.period_end, 'YYYY-MM-DD') AS "periodEnd",
            t.parent_id AS "parentId", t.auto, u.role AS "createdByRole",
            -- 👤 ІМʼЯ АВТОРА — доти віддавались лише id і роль, і на екрані «хто мені
            -- це поставив» не було ніде (відгук власника 15.09.2026 на «Спільних»).
            COALESCE(u.full_name, u.email) AS "createdByName",
            -- Команда виконавця — ОДИН вираз на проєкт (ASSIGNEE_TEAM_SQL), інакше
            -- фронт фільтрував би по m.team_id, а сервер міряв межу по COALESCE.
            t.created_by AS "createdById", ${ASSIGNEE_TEAM_SQL} AS "assigneeTeamId",
            t.metrics_json AS "metricsJson", t.checklist_json AS "checklistJson",
            t.subtasks_json AS "subtasksJson", t.pinned,
            t.o2o_type AS "o2oType", to_char(t.o2o_meeting_date, 'YYYY-MM-DD') AS "o2oMeetingDate",
            t.o2o_resolution AS "o2oResolution", t.o2o_resolved_at AS "o2oResolvedAt",
            COALESCE(rm.name, ru.email) AS "o2oResolvedByName",
            t.created_at AS "createdAt", t.updated_at AS "updatedAt",
            -- 🏷 ПРИЧИНА ЗАКРИТТЯ ЇХАЛА В БАЗУ Й НІКОЛИ НЕ ПОВЕРТАЛАСЬ. Поле заповнює
            -- POST /reactivation-task/close, а видача задач його не віддавала ЗОВСІМ —
            -- тобто людина обирала причину зі списку, і та зникала з очей назавжди.
            t.close_reason AS "closeReason",
            to_char(t.closed_at AT TIME ZONE 'Europe/Kyiv','YYYY-MM-DD') AS "closedAt",
            COALESCE(cu.full_name, cu.email) AS "closedByName"
     FROM tasks t${TASK_OWNER_JOINS}
     LEFT JOIN users u ON u.id = t.created_by
     LEFT JOIN users ru ON ru.id = t.o2o_resolved_by
     LEFT JOIN managers rm ON rm.id = ru.manager_id
     LEFT JOIN users cu ON cu.id = t.closed_by
     LEFT JOIN task_groups g ON g.id = t.group_id
     LEFT JOIN task_views tv ON tv.task_id = t.id AND tv.user_id = $${me}
     LEFT JOIN (SELECT task_id, count(*)::int AS n FROM task_comments GROUP BY task_id) tc
            ON tc.task_id = t.id
     LEFT JOIN (SELECT f.task_id, count(*)::int AS n,
                       string_agg(DISTINCT COALESCE(fu.full_name, fu.email), ', ') AS authors
                  FROM task_files f LEFT JOIN users fu ON fu.id = f.created_by
                 WHERE f.deleted_at IS NULL GROUP BY f.task_id) tf
            ON tf.task_id = t.id
     ${where}
     ORDER BY t.pinned DESC, t.created_at DESC`,
    params
  );

  res.json({ tasks: result.rows });
});

/**
 * 📁 ГРУПИ — ОСОБИСТІ. Оголошені ДО `/:id`-роутів навмисно: у Express виграє
 * перший збіг, і хоч `/groups` (один сегмент) із `/:id` тут не конфліктує
 * (`groups/5` — два сегменти), порядок робить це очевидним для наступного.
 *
 * 🔴 `owner_id = я` СТОЇТЬ У КОЖНОМУ ЗАПИТІ. Не «фільтр для зручності»: без
 * нього назви папок колег протікали б через будь-яку спільну задачу, а межа
 * групи — єдине, що їх ховає (саму задачу групи не приховують і не відкривають).
 */
tasksRouter.get("/groups", async (req, res) => {
  const r = await pool.query(
    `SELECT g.id, g.name, g.parent_id AS "parentId", g.created_at AS "createdAt",
            (SELECT count(*)::int FROM tasks t WHERE t.group_id = g.id) AS "taskCount"
       FROM task_groups g WHERE g.owner_id = $1 ORDER BY lower(g.name)`,
    [req.auth!.userId]
  );
  res.json({ groups: r.rows });
});

const groupSchema = z.object({ name: z.string().min(1).max(60) });

tasksRouter.post("/groups", async (req, res) => {
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Назва групи обовʼязкова (до 60 знаків)" });
  const name = parsed.data.name.trim();
  if (!name) return res.status(400).json({ error: "Назва групи обовʼязкова" });
  try {
    // Поля перелічені ЯВНО (а не спредом рядка) — вимога `#17e2`: спред віддав би
    // назовні будь-яку майбутню колонку сам, без правки коду.
    const r = await pool.query<{ id: number; name: string; parentId: number | null; createdAt: string }>(
      `INSERT INTO task_groups (owner_id, name) VALUES ($1, $2)
       RETURNING id, name, parent_id AS "parentId", created_at AS "createdAt"`,
      [req.auth!.userId, name]
    );
    const g = r.rows[0];
    res.status(201).json({ id: g.id, name: g.name, parentId: g.parentId, createdAt: g.createdAt, taskCount: 0 });
  } catch (e) {
    // Унікальний індекс по (owner_id, lower(name)) — повторна назва це помилка
    // кліку, і вона мусить сказати про себе, а не зникнути в 500.
    if ((e as { code?: string }).code === "23505") {
      return res.status(409).json({ error: `Група «${name}» у вас уже є` });
    }
    throw e;
  }
});

tasksRouter.patch("/groups/:id", async (req, res) => {
  const id = pathId(req.params.id);
  if (id == null) return res.status(400).json({ error: "Некоректний ідентифікатор групи" });
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Назва групи обовʼязкова (до 60 знаків)" });
  const r = await pool.query(
    `UPDATE task_groups SET name = $1 WHERE id = $2 AND owner_id = $3 RETURNING id`,
    [parsed.data.name.trim(), id, req.auth!.userId]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Групу не знайдено" });
  res.status(204).send();
});

/**
 * Видалення групи НЕ видаляє задачі: `tasks.group_id` має `ON DELETE SET NULL`,
 * тож вони повертаються в «Без групи». Прибирання на екрані не має права
 * втрачати роботу людини.
 */
tasksRouter.delete("/groups/:id", async (req, res) => {
  const id = pathId(req.params.id);
  if (id == null) return res.status(400).json({ error: "Некоректний ідентифікатор групи" });
  const r = await pool.query(
    `DELETE FROM task_groups WHERE id = $1 AND owner_id = $2 RETURNING id`,
    [id, req.auth!.userId]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Групу не знайдено" });
  res.status(204).send();
});

// --- Weekly/monthly KPI plan (team-lead / admin) ---

const planSchema = z.object({
  assigneeId: z.number(),
  period: z.enum(["week", "month"]),
  // ISO dates (YYYY-MM-DD) the team-lead picked as working days.
  days: z.array(z.string()).min(1),
  adsCount: z.number().nonnegative().optional(),
  leadgenCount: z.number().nonnegative().optional(),
  dispatchCount: z.number().nonnegative().optional(),
  avgCheck: z.number().nonnegative().optional(),
  conversion: z.number().min(0).max(100).optional(),
  // Сума, яку менеджер має принести за період (розкладається по днях). Якщо не
  // задано — береться з місячного плану виручки (plans.payment_amount).
  paymentAmount: z.number().nonnegative().optional(),
});

const METRIC_LABELS: Record<string, string> = {
  ads_count: "Кількість прийнятої реклами",
  leadgen_count: "Кількість прийнятих лідогенів",
  dispatch_count: "Поставлені авто (за подіями)",
  avg_check: "Середній чек",
  conversion: "Конверсія",
  payment_amount: "Сума до принесення, ₴",
};

tasksRouter.post("/plan", async (req, res) => {
  const auth = req.auth!;
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { period, days, adsCount, leadgenCount, dispatchCount, avgCheck, conversion, paymentAmount } = parsed.data;
  // Хто кому може ставити план на день:
  //  • менеджер — ЛИШЕ собі (assignee форсується на себе);
  //  • тімлід — лише своїй команді;
  //  • адмін — будь-кому.
  // 🔓 РІШЕННЯ ВЛАСНИКА 14.09.2026: «зніми обмеження і для планів та реактивації».
  // Доти менеджера форсували на себе, тімліда — на свою команду, решту — 403.
  // Тепер план ставить будь-хто будь-кому; без виконавця менеджер — собі (як було).
  let assigneeId = parsed.data.assigneeId ?? (auth.role === "manager" && auth.managerId ? auth.managerId : undefined);
  if (!assigneeId) return res.status(400).json({ error: "Оберіть менеджера" });
  const exists = await pool.query(`SELECT 1 FROM managers WHERE id = $1`, [assigneeId]);
  if (!exists.rowCount) return res.status(400).json({ error: "Менеджера не знайдено" });

  const sorted = [...days].sort();
  const periodStart = sorted[0];
  const periodEnd = sorted[sorted.length - 1];

  const mgr = await pool.query<{ name: string; team_name: string | null }>(
    `SELECT m.name, tm.name AS team_name FROM managers m LEFT JOIN teams tm ON tm.id = m.team_id WHERE m.id = $1`,
    [assigneeId]
  );
  const mgrName = mgr.rows[0]?.name ?? "";
  const deptName = mgr.rows[0]?.team_name ?? null;

  // Daily revenue target ("сума") from the manager's monthly payment plan
  // (plan ÷ working days of the plan's month), if such a plan exists.
  const monthAnchor = `${periodStart.slice(0, 7)}-01`;
  const payPlanRes = await pool.query<{ v: string }>(
    `SELECT planned_value v FROM plans WHERE manager_id = $1 AND metric = 'payment_amount' AND plan_date = $2`,
    [assigneeId, monthAnchor]
  );
  let dailyPayment = 0;
  if (paymentAmount && paymentAmount > 0) {
    // Явно задана сума за період → рівномірно по обраних днях плану.
    dailyPayment = Math.round(paymentAmount / sorted.length);
  } else if (payPlanRes.rows[0]) {
    const [y, mo] = monthAnchor.split("-").map(Number);
    const dim = new Date(y, mo, 0).getDate();
    let wd = 0;
    for (let d = 1; d <= dim; d++) { const dow = new Date(y, mo - 1, d).getDay(); if (dow !== 0 && dow !== 6) wd++; }
    dailyPayment = wd > 0 ? Math.round(Number(payPlanRes.rows[0].v) / wd) : 0;
  }

  // Build the per-day metric bundle. Count metrics split evenly across days;
  // avg_check / conversion / payment apply as a daily target each day.
  const dailyMetrics: { metric: string; target: number }[] = [];
  if (adsCount && adsCount > 0) dailyMetrics.push({ metric: "ads_count", target: Math.max(1, Math.round(adsCount / sorted.length)) });
  if (leadgenCount && leadgenCount > 0) dailyMetrics.push({ metric: "leadgen_count", target: Math.max(1, Math.round(leadgenCount / sorted.length)) });
  if (dispatchCount && dispatchCount > 0) dailyMetrics.push({ metric: "dispatch_count", target: Math.max(1, Math.round(dispatchCount / sorted.length)) });
  if (avgCheck && avgCheck > 0) dailyMetrics.push({ metric: "avg_check", target: avgCheck });
  if (conversion && conversion > 0) dailyMetrics.push({ metric: "conversion", target: conversion });
  if (dailyPayment > 0) dailyMetrics.push({ metric: "payment_amount", target: dailyPayment });

  if (dailyMetrics.length === 0) {
    return res.status(400).json({ error: "Вкажіть хоча б одну ціль (реклама, лідоген, авто, чек або конверсія), або задайте місячний план виручки для «суми»" });
  }

  // ОДНА задача на період (тиждень/місяць) — «парасолька». Дні НЕ стають окремими
  // задачами у списку: вони діти (parent_id), сховані в розкривному списку задачі,
  // де видно прогрес виконано/не виконано по кожному дню. Оцінює/ретаргетить їх
  // той самий движок (evaluateKpiTasks) — діти лишаються daily_kpi.
  const periodLabel = period === "week" ? "тиждень" : "місяць";
  // Підсумкові цілі періоду для згорнутого вигляду задачі.
  const periodTargets: { metric: string; target: number; actual: number | null; done: boolean }[] = [];
  if (adsCount && adsCount > 0) periodTargets.push({ metric: "ads_count", target: adsCount, actual: null, done: false });
  if (leadgenCount && leadgenCount > 0) periodTargets.push({ metric: "leadgen_count", target: leadgenCount, actual: null, done: false });
  if (dispatchCount && dispatchCount > 0) periodTargets.push({ metric: "dispatch_count", target: dispatchCount, actual: null, done: false });
  if (avgCheck && avgCheck > 0) periodTargets.push({ metric: "avg_check", target: avgCheck, actual: null, done: false });
  if (conversion && conversion > 0) periodTargets.push({ metric: "conversion", target: conversion, actual: null, done: false });
  if (dailyPayment > 0) periodTargets.push({ metric: "payment_amount", target: paymentAmount && paymentAmount > 0 ? paymentAmount : dailyPayment * sorted.length, actual: null, done: false });

  const parentRes = await pool.query<{ id: number }>(
    // 🔴 `period_kind` ПИШЕТЬСЯ ЯВНО. Доти тип періоду жив лише у слові всередині
    // `title`, і `effectiveWeekTargets` не мав за що зачепитись — місячна парасолька
    // покриває будь-який день місяця, отже проходила як «тижнева».
    `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, plan_date, period_start, period_end, deadline, auto, metrics_json, department, period_kind)
     VALUES ($1,'not_started',$2,$3,'kpi_period',$4,$4,$5,$5,true,$6,$7,$8) RETURNING id`,
    [`План на ${periodLabel} (${mgrName}) — ${dailyMetrics.length} показник(и), ${sorted.length} дн.`,
     assigneeId, auth.userId, periodStart, periodEnd, JSON.stringify(periodTargets), deptName,
     period === "week" ? "week" : "month"]
  );
  const parentId = parentRes.rows[0].id;

  for (const day of sorted) {
    const metrics = dailyMetrics.map((m) => ({ ...m, actual: null as number | null, done: false }));
    await pool.query(
      `INSERT INTO tasks (title, status, assignee_id, created_by, task_type, plan_date, period_start, period_end, deadline, auto, metrics_json, department, parent_id)
       VALUES ($1,'not_started',$2,$3,'daily_kpi',$4,$4,$4,$4,true,$5,$6,$7)`,
      [`День ${day} (${mgrName})`, assigneeId, auth.userId, day, JSON.stringify(metrics), deptName, parentId]
    );
  }
  res.status(201).json({ created: 1, parentId, days: sorted.length });
});

// One reactivation task per manager, bundling the picked clients as a checklist
// the manager ticks off. Team-lead → own team only; admin → anyone.
const reactivationSchema = z.object({
  /** Явний виконавець — лишається для сумісності й для клієнтів без закріпленого менеджера. */
  assigneeId: z.number().optional(),
  clients: z.array(checklistItem).min(1),
});
tasksRouter.post("/reactivation", async (req, res) => {
  const auth = req.auth!;
  // 🔓 Рішення власника 14.09.2026: реактиваційну задачу ставить будь-хто будь-кому
  // (доти — лише тімлід/адмін і лише своїй команді).
  const parsed = reactivationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { assigneeId, clients } = parsed.data;
  if (assigneeId == null) return res.status(400).json({ error: "Оберіть виконавця" });

  const mgr = await pool.query<{ name: string; team_id: number | null }>(
    `SELECT name, team_id FROM managers WHERE id = $1`, [assigneeId]
  );
  if (!mgr.rows[0]) return res.status(400).json({ error: "Менеджера не знайдено" });

  const created = await createReactivationPack({
    assigneeId, managerName: mgr.rows[0].name, createdBy: auth.userId, clients,
  });
  res.status(201).json(created);
});

tasksRouter.post("/", async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { title, status, deadline, priority, comments, department } = parsed.data;
  const auth = req.auth!;

  // 📁 Група — лише власна (та сама межа, що в PATCH).
  const groupId = parsed.data.groupId ?? null;
  if (groupId != null) {
    const g = await pool.query<{ id: number }>(
      `SELECT id FROM task_groups WHERE id = $1 AND owner_id = $2`, [groupId, auth.userId]);
    if (!g.rowCount) return res.status(403).json({ error: "Групу не знайдено серед ваших" });
  }

  // 👤 ВИКОНАВЕЦЬ-АКАУНТ — окрема гілка: задача одна, `assignee_id` лишається
  // NULL (CHECK `tasks_one_assignee`), і вона НЕ стає особистою, бо особиста —
  // це задача БЕЗ виконавця взагалі (`core/taskVisibility.ts`).
  const assigneeUserId = parsed.data.assigneeUserId ?? null;
  if (assigneeUserId != null) {
    /**
     * 🔓 РІШЕННЯ ВЛАСНИКА 14.09.2026, дослівно: «всі можуть ставити один одному
     * задачі». Доти менеджер отримував 403 «не може передавати задачі іншим», а
     * тімлід — «лише своїй команді». Обидві заборони зняті ЯВНО; лишається єдина
     * перевірка — що акаунт існує й активний, інакше FK впав би 500-ю.
     */
    const acc = await pool.query(`SELECT 1 FROM users WHERE id = $1 AND is_active`, [assigneeUserId]);
    if (!acc.rowCount) return res.status(400).json({ error: "Акаунт-виконавця не знайдено" });
    const one = await pool.query<{ id: number }>(
      `INSERT INTO tasks (title, status, deadline, assignee_user_id, priority, comments, department, created_by, group_id)
       VALUES ($1, COALESCE($2, 'not_started'), $3, $4, COALESCE($5, 'medium'), $6, $7, $8, $9)
       RETURNING id`,
      [title, status ?? null, deadline ?? null, assigneeUserId, priority ?? null,
       comments ?? null, department ?? null, auth.userId, groupId]
    );
    return res.status(201).json({ id: one.rows[0].id, ids: [one.rows[0].id] });
  }

  /**
   * Список виконавців: assigneeIds (кілька) або один assigneeId.
   *
   * 🔓 РІШЕННЯ ВЛАСНИКА 14.09.2026: «всі можуть ставити один одному задачі». Доти
   * менеджер ЗАВЖДИ був виконавцем сам (ідентифікатори з тіла ігнорувались), а тімлід
   * не міг вийти за свою команду. Тепер одна гілка на всі ролі. Дефолт БЕЗ виконавця
   * лишається старий: справжній менеджер (managerId>0) → собі, решта → особиста
   * задача (assignee NULL, created_by = я). Тримає `#400h`.
   */
  const wanted = parsed.data.assigneeIds?.length ? parsed.data.assigneeIds : (parsed.data.assigneeId != null ? [parsed.data.assigneeId] : []);
  let assignees: (number | null)[];
  if (wanted.length) {
    const chk = await pool.query<{ id: number }>(`SELECT id FROM managers WHERE id = ANY($1)`, [wanted]);
    const okIds = new Set(chk.rows.map((r) => r.id));
    if (wanted.some((id) => !okIds.has(id))) return res.status(400).json({ error: "Виконавця не знайдено" });
    assignees = wanted;
  } else {
    assignees = auth.role === "manager" && auth.managerId && auth.managerId > 0 ? [auth.managerId] : [null];
  }
  const uniqueAssignees = [...new Set(assignees)];

  // Департамент кожному — з його команди (якщо не заданий явно).
  const deptOf = async (assigneeId: number | null): Promise<string | null> => {
    if (department) return department;
    if (!assigneeId) return null;
    const t = await pool.query<{ name: string | null }>(
      `SELECT tm.name FROM managers m LEFT JOIN teams tm ON tm.id = m.team_id WHERE m.id = $1`, [assigneeId]);
    return t.rows[0]?.name ?? null;
  };

  const ids: number[] = [];
  for (const assigneeId of uniqueAssignees) {
    const dept = await deptOf(assigneeId);
    const result = await pool.query(
      `INSERT INTO tasks (title, status, deadline, assignee_id, priority, comments, department, created_by, group_id)
       VALUES ($1, COALESCE($2, 'not_started'), $3, $4, COALESCE($5, 'medium'), $6, $7, $8, $9)
       RETURNING id`,
      [title, status ?? null, deadline ?? null, assigneeId, priority ?? null, comments ?? null, dept, auth.userId, groupId]
    );
    ids.push(result.rows[0].id);
  }

  res.status(201).json({ id: ids[0], ids });
});

/**
 * Мета задачі, потрібна МЕЖІ й ЛОГУ статусу — одним запитом.
 *
 * 🔴 Доти межу рахували ДВА окремих запити (`canTouchTask` + `o2oMeta`), кожен
 * зі своїм `SELECT` і своїм переліком полів. Один запит означає, що обидві
 * перевірки міркують про ОДИН І ТОЙ САМИЙ рядок, а не про два зчитування, між
 * якими стан міг зрушити.
 */
interface TaskMeta extends TaskOwnerRow {
  status: string;
  taskType: string;
}
async function loadTaskMeta(taskId: number): Promise<TaskMeta | null> {
  const r = await pool.query<{
    assignee_id: number | null; assignee_user_id: number | null; created_by: number | null;
    assignee_team_id: number | null; status: string; task_type: string;
  }>(
    `SELECT t.assignee_id, t.assignee_user_id, t.created_by, t.status, t.task_type,
            ${ASSIGNEE_TEAM_SQL} AS assignee_team_id
       FROM tasks t${TASK_OWNER_JOINS}
      WHERE t.id = $1`,
    [taskId]
  );
  const t = r.rows[0];
  if (!t) return null;
  return {
    assigneeId: t.assignee_id, assigneeUserId: t.assignee_user_id, createdBy: t.created_by,
    assigneeTeamId: t.assignee_team_id, status: t.status, taskType: t.task_type,
  };
}

/**
 * Чи може цей акаунт ЗМІНИТИ задачу. Правило — у `core/taskVisibility.ts`
 * (`canTouchTask`), тут лише завантаження рядка.
 *
 * ⚠️ Дзеркальна функція `canSeeTask` там само, і вона ШИРША для ролі `company`
 * (HR, бухгалтерія: бачать усе призначене, змінюють лише своє). Тому «бачити»
 * й «змінювати» — дві функції, а не одна; інваріанту «touch ⊆ see» тримає `#400`.
 */
async function canTouchTask(
  auth: { role: string; roleKey: string; userId: number; managerId: number | null; teamId: number | null },
  taskId: number
): Promise<{ ok: boolean; found: boolean }> {
  const t = await loadTaskMeta(taskId);
  if (!t) return { ok: false, found: false };
  return { ok: mayTouch(viewerOf(auth), t), found: true };
}

/** Чи може цей акаунт БАЧИТИ задачу — для читання супутників (коментарі, файли, історія). */
async function canSeeTaskById(
  auth: { role: string; roleKey: string; userId: number; managerId: number | null; teamId: number | null },
  taskId: number
): Promise<{ ok: boolean; found: boolean; meta: TaskMeta | null }> {
  const t = await loadTaskMeta(taskId);
  if (!t) return { ok: false, found: false, meta: null };
  return { ok: canSeeTask(viewerOf(auth), t), found: true, meta: t };
}

/**
 * ЗАМОК ЗАДАЧІ З 1×1 (`task_type='oneonone'`). Сенс: домовленості зі зустрічі субʼєкт
 * не може позбутися сам — знімає лише ведучий через рев'ю на наступному 1×1.
 *
 * 🔴 Замок ОБОВʼЯЗКОВО двобічний. Сам по собі DELETE-гейт декоративний: субʼєкт міг би
 * так само її знешкодити через PATCH — поставити status='done', перейменувати, зняти
 * дедлайн або відвʼязати від себе (assigneeId=null → задача стає особистою і зникає
 * з-під нагляду). Тому субʼєкту лишаємо тільки коментарі та статуси КРІМ 'done'.
 *
 * Повний доступ (правка й зняття будь-коли) — автор задачі (ведучий) або наскрізний.
 */
// 📁 `groupId` доданий 14.09.2026 СВІДОМО: група особиста й доступу не змінює,
// тож розкладання своїх задач по папках не дає субʼєкту жодного способу вийти
// з-під нагляду — ведучий бачить задачу незалежно від папки. Заборона тут
// означала б «класифікуй свої 1×1 задачі — 403», тобто відмову на безпечній дії.
const O2O_SUBJECT_ALLOWED = new Set(["comments", "status", "groupId"]);
/** Повний доступ до задачі з 1×1 (обходить замок субʼєкта): автор (ведучий), адмін
 *  (тепер і СЕО/ОД — scopeCompatRole), або наскрізний 1×1 (HR за правом). Субʼєкту —
 *  лише коментарі й статус, крім 'done'. */
function o2oFullAccess(auth: { userId: number; role: string; roleKey: string }, createdBy: number | null): boolean {
  return createdBy === auth.userId || isAdminScope(auth) || roleHasPerm(auth.roleKey, "view_all_1x1");
}
/** Мета задачі + чи має цей користувач ПОВНИЙ доступ до неї як до задачі з 1×1. */
async function o2oMeta(auth: { userId: number; role: string; roleKey: string }, taskId: number) {
  const r = await pool.query<{ task_type: string; created_by: number | null }>(
    "SELECT task_type, created_by FROM tasks WHERE id=$1", [taskId]);
  const t = r.rows[0];
  if (!t) return { found: false, isO2O: false, full: false };
  const isO2O = t.task_type === "oneonone";
  return { found: true, isO2O, full: isO2O && o2oFullAccess(auth, t.created_by) };
}

/**
 * Колонка на кожен ключ патча. 🔴 Перелік ПОВНИЙ і перевіряється: ключ зі схеми
 * без рядка тут давав `undefined = $1`, тобто 500 замість відмови. Так уже
 * траплялось із `assigneeIds` (він є в схемі створення, а колонки не має).
 */
const PATCH_COLUMNS: Record<string, string> = {
  title: "title",
  status: "status",
  deadline: "deadline",
  assigneeId: "assignee_id",
  assigneeUserId: "assignee_user_id",
  priority: "priority",
  comments: "comments",
  department: "department",
  groupId: "group_id",
  checklistJson: "checklist_json",
  subtasksJson: "subtasks_json",
};

tasksRouter.patch("/:id", async (req, res) => {
  const id = pathId(req.params.id);
  if (id == null) return res.status(400).json({ error: "Некоректний ідентифікатор задачі" });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const auth = req.auth!;
  const before = await loadTaskMeta(id);
  if (!before) return res.status(404).json({ error: "Задачу не знайдено" });
  const isO2O = before.taskType === "oneonone";
  const o2oFull = isO2O && o2oFullAccess(auth, before.createdBy);
  if (!o2oFull) {
    if (!mayTouch(viewerOf(auth), before)) {
      return res.status(403).json({ error: "Немає доступу до цієї задачі" });
    }
    if (isO2O) {
      const forbidden = Object.keys(parsed.data).filter((k) => !O2O_SUBJECT_ALLOWED.has(k));
      if (forbidden.length) {
        return res.status(403).json({ error: `Задача з 1×1: змінювати «${forbidden.join(", ")}» може лише ведучий` });
      }
      if (parsed.data.status === "done") {
        return res.status(403).json({ error: "Задача з 1×1 закривається лише на наступному 1×1 — ведучим" });
      }
    }
  }
  // 🔓 Перепризначення — як і створення: рішення власника 14.09.2026 «всі можуть
  // ставити один одному задачі». Заборони «менеджер лише собі» і «тімлід лише своїй
  // команді» зняті явно; лишається перевірка, що менеджер існує (інакше FK → 500).
  if (parsed.data.assigneeId != null) {
    const chk = await pool.query(`SELECT 1 FROM managers WHERE id = $1`, [parsed.data.assigneeId]);
    if (!chk.rowCount) return res.status(400).json({ error: "Виконавця не знайдено" });
  }
  // 🔴 ОДИН ВИКОНАВЕЦЬ НА ЗАДАЧУ — 400 ТУТ, а не 500 від CHECK `tasks_one_assignee`.
  // Стан ПІСЛЯ патча: поле з тіла, якщо передане, інакше те, що в рядку.
  const nextMgr = parsed.data.assigneeId !== undefined ? parsed.data.assigneeId : before.assigneeId;
  const nextAcc = parsed.data.assigneeUserId !== undefined ? parsed.data.assigneeUserId : before.assigneeUserId;
  if (nextMgr != null && nextAcc != null) {
    return res.status(400).json({ error: "Один виконавець на задачу: спершу зніміть менеджера або акаунт" });
  }
  // 📁 Група — лише власна (та сама межа, що в POST): чужа папка означала б, що
  // задача зникає з екрана колеги незрозумілим чином.
  if (parsed.data.groupId != null) {
    const g = await pool.query(`SELECT 1 FROM task_groups WHERE id = $1 AND owner_id = $2`, [parsed.data.groupId, auth.userId]);
    if (!g.rowCount) return res.status(403).json({ error: "Групу не знайдено серед ваших" });
  }

  const fields: string[] = [];
  const params: unknown[] = [];
  const unknown: string[] = [];

  for (const [key, value] of Object.entries(parsed.data)) {
    const col = PATCH_COLUMNS[key];
    if (!col) { unknown.push(key); continue; }
    params.push(key === "checklistJson" || key === "subtasksJson" ? JSON.stringify(value) : value);
    fields.push(`${col} = $${params.length}`);
  }
  if (unknown.length) {
    return res.status(400).json({ error: `Полів не існує: ${unknown.join(", ")}` });
  }
  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }
  params.push(id);

  await pool.query(
    `UPDATE tasks SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
    params
  );

  // 📜 ІСТОРІЯ СТАТУСУ — ПІСЛЯ успішного запису і ЛИШЕ на справжній зміні.
  // Рядок «done → done» був би шумом, який знецінює історію; а порівняння йде з
  // тим самим рядком, який ми щойно перевіряли на межу, не з новим зчитуванням.
  if (parsed.data.status !== undefined && parsed.data.status !== before.status) {
    await pool.query(
      `INSERT INTO task_status_log (task_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)`,
      [id, before.status, parsed.data.status, auth.userId]
    );
  }

  res.status(204).send();
});

tasksRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const auth = req.auth!;
  const meta = await o2oMeta(auth, id);
  if (!meta.found) return res.status(404).json({ error: "Задачу не знайдено" });
  // Задачу з 1×1 знімає лише ведучий (автор) або наскрізний — субʼєкту 403.
  if (!meta.full) {
    const scope = await canTouchTask(auth, id);
    if (!scope.found) return res.status(404).json({ error: "Задачу не знайдено" });
    if (!scope.ok) return res.status(403).json({ error: "Немає доступу до цієї задачі" });
    if (meta.isO2O) return res.status(403).json({ error: "Задачу з 1×1 знімає лише ведучий" });
  }
  // 📎 БАЙТИ ЗБИРАЄМО ДО ВИДАЛЕННЯ, інакше вони стають сиротами НАЗАВЖДИ:
  // `task_files.task_id` має ON DELETE CASCADE, тож разом із задачею зникає
  // єдиний запис про те, який файл на диску їй належав. Знімок імен —
  // единий момент, коли цей звʼязок ще існує. Той самий прийом, що в
  // видаленні папки регламентів.
  const stored = await pool.query<{ stored_name: string }>(
    `SELECT stored_name FROM task_files WHERE task_id = $1`, [id]);
  await pool.query(`DELETE FROM tasks WHERE id = $1`, [id]);
  await Promise.all(
    stored.rows.map((r) => unlink(path.join(TASK_FILES_DIR, r.stored_name)).catch(() => {}))
  );
  res.status(204).send();
});

/**
 * 👥 КОГО МОЖНА ПОСТАВИТИ ВИКОНАВЦЕМ-АКАУНТОМ.
 *
 * 🔴 ВІДДАЄМО ЛИШЕ `id` + ІМʼЯ, БЕЗ EMAIL. Селект виконавця потребує рівно
 * цього, а email — це логін: список логінів усієї компанії будь-кому з вкладкою
 * «Задачник» був би розширенням доступу, зробленим заради форми. Спосіб
 * складання відповіді — з ЯВНОГО переліку полів, тож нова колонка в `users`
 * назовні сама не поїде (той самий принцип, що врятував `bank_accounts`).
 *
 * ⚠️ Імʼя без прізвища не вигадуємо: якщо `full_name` порожнє, показуємо
 * ЛОКАЛЬНУ частину email (до «@») і підписуємо це на екрані як «логін», а не
 * підсовуємо порожнє місце, яке читалось би як «немає людини».
 */
tasksRouter.get("/assignees", async (_req, res) => {
  const r = await pool.query(
    `SELECT u.id,
            COALESCE(NULLIF(btrim(u.full_name), ''), split_part(u.email, '@', 1)) AS name,
            (u.full_name IS NULL OR btrim(u.full_name) = '') AS "nameIsLogin",
            u.manager_id AS "managerId"
       FROM users u
      WHERE u.is_active
      ORDER BY 2`
  );
  res.json({ assignees: r.rows });
});

// ═════════════════════════════════════════════════════════════════════════════
// СПІЛЬНА ЗАДАЧА · стрічка доповнень · історія статусу · вкладення
//
// 🔴 МЕЖА СУПУТНИКІВ — ЦЕ МЕЖА САМОЇ ЗАДАЧІ, І ВОНА ЗАПИТУЄТЬСЯ ЗАВЖДИ.
// ТРИ режими, а не два:
//   «see»   — обговорення й історія: `canSeeTask`. Роль `company` (HR,
//             бухгалтерія — «тільки перегляд») читає, але не пише.
//   «touch» — доповнення: `canTouchTask`, тобто «учасник»: автор, виконавець,
//             тімлід виконавця, наскрізний.
//   «own»   — ВКЛАДЕННЯ, усі чотири роути: `isTaskOwner` — лише автор і
//             виконавець. Рішення власника 14.09.2026, дослівно: «файли мають
//             бути доступними тільки для власників цієї задачі». Отже вкладення
//             ВУЖЧІ за обговорення: назву задачі наглядач бачить, байти — ні.
// ⚠️ «own» накриває і читання, і запис СВІДОМО: звузивши лише читання, ми дали б
// тімліду право покласти файл і забрали право його відкрити.
// Без цих перевірок файл віддавався б за прямим `id` будь-кому автентифікованому
// — рівно те, від чого тека лежить поза публічним static.
// ═════════════════════════════════════════════════════════════════════════════

/** Спільний вхід для супутників: 400 на сміття в шляху, 404 на чужу/відсутню задачу. */
async function openTask(
  req: Request,
  res: Response,
  mode: "see" | "touch" | "own",
): Promise<{ id: number; meta: TaskMeta } | null> {
  const id = pathId(req.params.id);
  if (id == null) { res.status(400).json({ error: "Некоректний ідентифікатор задачі" }); return null; }
  const auth = req.auth!;
  const seen = await canSeeTaskById(auth, id);
  // 🔴 ЧУЖА ЗАДАЧА — 404, А НЕ 403. Особиста задача приватна, тож саме її
  // ІСНУВАННЯ не підтверджується: 403 казав би «така задача є, але не твоя».
  if (!seen.found || !seen.ok) { res.status(404).json({ error: "Задачу не знайдено" }); return null; }
  if (mode === "touch" && !mayTouch(viewerOf(auth), seen.meta!)) {
    res.status(403).json({ error: "Дописувати може автор, виконавець або керівник" });
    return null;
  }
  /**
   * 🔒 РЕЖИМ «own» — ВКЛАДЕННЯ. Рішення власника 14.09.2026: файли доступні лише
   * власникам задачі (автор + виконавець), а не всім, хто задачу бачить.
   *
   * 🔴 ТУТ 403, А НЕ 404 — І ЦЕ НЕ НЕДОГЛЯД. Вище 404 приховує САМЕ ІСНУВАННЯ
   * чужої особистої задачі, і це правильно. Але сюди глядач доходить лише тоді,
   * коли задачу він уже бачить — вона в його списку. Промовчати 404 означало б
   * «файла немає», тобто збрехати про дані; 403 називає причину, і людина
   * розуміє, що бачить не все. Мовчазна відмова тут була б рівно тим класом, що
   * «кнопка натиснута, нічого не сталось».
   */
  if (mode === "own" && !isTaskOwner(viewerOf(auth), seen.meta!)) {
    res.status(403).json({ error: "Вкладення доступні лише автору та виконавцю задачі" });
    return null;
  }
  return { id, meta: seen.meta! };
}

/** 💬 Стрічка доповнень — історія з автором і часом, її не затирає наступне збереження. */
tasksRouter.get("/:id/comments", async (req, res) => {
  const t = await openTask(req, res, "see");
  if (!t) return;
  const r = await pool.query(
    `SELECT c.id, c.body, c.created_at AS "createdAt", c.author_id AS "authorId",
            COALESCE(u.full_name, u.email) AS "authorName"
       FROM task_comments c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.task_id = $1 ORDER BY c.created_at`,
    [t.id]
  );
  res.json({ comments: r.rows });
});

const commentSchema = z.object({ body: z.string().min(1).max(4000) });

tasksRouter.post("/:id/comments", async (req, res) => {
  const t = await openTask(req, res, "touch");
  if (!t) return;
  const parsed = commentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Текст доповнення обовʼязковий (до 4000 знаків)" });
  const body = parsed.data.body.trim();
  if (!body) return res.status(400).json({ error: "Текст доповнення обовʼязковий" });
  const r = await pool.query(
    `INSERT INTO task_comments (task_id, author_id, body) VALUES ($1, $2, $3)
     RETURNING id, body, created_at AS "createdAt", author_id AS "authorId"`,
    [t.id, req.auth!.userId, body]
  );
  res.status(201).json(r.rows[0]);
});

/** 📜 Історія статусу — хто й коли рухав задачу. */
tasksRouter.get("/:id/history", async (req, res) => {
  const t = await openTask(req, res, "see");
  if (!t) return;
  const r = await pool.query(
    `SELECT l.id, l.from_status AS "fromStatus", l.to_status AS "toStatus",
            l.changed_at AS "changedAt", COALESCE(u.full_name, u.email) AS "changedByName"
       FROM task_status_log l LEFT JOIN users u ON u.id = l.changed_by
      WHERE l.task_id = $1 ORDER BY l.changed_at`,
    [t.id]
  );
  res.json({ history: r.rows });
});

/**
 * 👁 «Я це бачив» — момент перегляду для бейджа «є нове».
 *
 * ⚠️ Пишеться ЯВНИМ викликом з екрана (відкриття задачі), а не будь-яким GET:
 * інакше список задач гасив би бейджі, яких людина не читала.
 */
tasksRouter.post("/:id/seen", async (req, res) => {
  const t = await openTask(req, res, "see");
  if (!t) return;
  await pool.query(
    `INSERT INTO task_views (task_id, user_id, seen_at) VALUES ($1, $2, now())
     ON CONFLICT (task_id, user_id) DO UPDATE SET seen_at = now()`,
    [t.id, req.auth!.userId]
  );
  res.status(204).send();
});

/** 📎 Перелік вкладень задачі. */
tasksRouter.get("/:id/files", async (req, res) => {
  const t = await openTask(req, res, "own");
  if (!t) return;
  const r = await pool.query(
    `SELECT f.id, f.name, f.mime, f.size_bytes AS "sizeBytes", f.created_at AS "createdAt",
            f.created_by AS "createdById", COALESCE(u.full_name, u.email) AS "author"
       FROM task_files f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.task_id = $1 AND f.deleted_at IS NULL ORDER BY f.created_at`,
    [t.id]
  );
  res.json({ files: r.rows });
});

/**
 * Завантаження вкладення — base64 у тілі, як у регламентах (`routes/documents.ts`);
 * multipart у проєкті не використовується, і заводити другий механізм заради
 * однієї форми означало б дві культури завантаження.
 */
tasksRouter.post("/:id/files", async (req, res) => {
  const t = await openTask(req, res, "own");
  if (!t) return;
  const { filename, dataBase64 } = req.body ?? {};
  if (!dataBase64 || typeof dataBase64 !== "string") {
    return res.status(400).json({ error: "Файл відсутній" });
  }
  const cnt = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM task_files WHERE task_id = $1 AND deleted_at IS NULL`, [t.id]);
  if (Number(cnt.rows[0].n) >= FILES_PER_TASK) {
    return res.status(409).json({ error: `Більше ${FILES_PER_TASK} файлів на задачу не кладемо — приберіть зайвий` });
  }
  const base64 = dataBase64.includes(",") ? dataBase64.split(",")[1] : dataBase64;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) return res.status(400).json({ error: "Файл порожній" });
  if (buffer.length > FILE_MAX_BYTES) {
    return res.status(413).json({ error: "Файл завеликий (макс. 5 МБ)" });
  }
  const display = String(filename ?? "файл").trim() || "файл";
  const ext = path.extname(display).slice(0, 12).replace(/[^.\w]/g, "");
  const storedName = `${randomUUID()}${ext}`;
  await mkdir(TASK_FILES_DIR, { recursive: true });
  await writeFile(path.join(TASK_FILES_DIR, storedName), buffer);
  const r = await pool.query(
    `INSERT INTO task_files (task_id, name, stored_name, mime, size_bytes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, mime, size_bytes AS "sizeBytes", created_at AS "createdAt", created_by AS "createdById"`,
    [t.id, display, storedName, req.body?.mime ?? null, buffer.length, req.auth!.userId]
  );
  res.status(201).json(r.rows[0]);
});

/**
 * Віддача вкладення — авторизованим стрімом, із перевіркою доступу до ЗАДАЧІ.
 *
 * 🔴 Відсутній на диску файл каже про себе («файл відсутній на диску»), а не
 * віддає порожній 200. Це не формальність: нічний бекап бере ЛИШЕ базу
 * (заміряно 14.09.2026 — у теці бекапу нуль згадок файлових тек), тож рядок без
 * байтів — стан досяжний, і порожнеча, яка зійшла за відповідь, тут була б
 * найгіршим із можливих виходів.
 */
tasksRouter.get("/:id/files/:fileId", async (req, res) => {
  const t = await openTask(req, res, "own");
  if (!t) return;
  const fid = pathId(req.params.fileId);
  if (fid == null) return res.status(400).json({ error: "Некоректний ідентифікатор файла" });
  const r = await pool.query<{ name: string; stored_name: string; mime: string | null }>(
    `SELECT name, stored_name, mime FROM task_files
      WHERE id = $1 AND task_id = $2 AND deleted_at IS NULL`,
    [fid, t.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: "Файл не знайдено" });
  const f = r.rows[0];
  if (f.mime) res.type(f.mime);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.sendFile(path.join(TASK_FILES_DIR, f.stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Файл відсутній на диску" });
  });
});

/**
 * Прибрати вкладення — той, хто його поклав, або наскрізний.
 *
 * 🔴 МʼЯКЕ ВИДАЛЕННЯ, І ЦЕ РІШЕННЯ, А НЕ НЕДОРОБКА (ТЗ §3.4). Рядок лишається
 * зі штампом `deleted_at`, байти на диску теж: помилковий клік по вкладенню
 * відновлюється одним `UPDATE`, а не з бекапу, якого для ФАЙЛІВ у нас немає
 * (заміряно 14.09.2026: нічний бекап бере лише таблиці).
 *
 * ⚠️ ЦІНА НАЗВАНА ВГОЛОС: поки немає джоби прибирання, байти не звільняються
 * НІКОЛИ. При 5 МБ × 10 файлів і 2,6 ТБ вільного (замір 14.09) це роками не
 * питання, але саме тому написано тут, а не «колись почистимо».
 * 🔴 І звідси вимога до КОЖНОГО читача: `deleted_at IS NULL`. Забути її означає
 * повернути видалені вкладення на екран — тримає `#400h`.
 */
tasksRouter.delete("/:id/files/:fileId", async (req, res) => {
  const t = await openTask(req, res, "own");
  if (!t) return;
  const fid = pathId(req.params.fileId);
  if (fid == null) return res.status(400).json({ error: "Некоректний ідентифікатор файла" });
  const auth = req.auth!;
  const own = await pool.query<{ created_by: number | null }>(
    `SELECT created_by FROM task_files WHERE id = $1 AND task_id = $2 AND deleted_at IS NULL`,
    [fid, t.id]
  );
  if (!own.rowCount) return res.status(404).json({ error: "Файл не знайдено" });
  if (own.rows[0].created_by !== auth.userId && !isAdminScope(auth)) {
    return res.status(403).json({ error: "Прибрати вкладення може той, хто його поклав" });
  }
  await pool.query(`UPDATE task_files SET deleted_at = now() WHERE id = $1`, [fid]);
  res.status(204).send();
});
