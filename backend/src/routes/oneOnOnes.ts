import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requirePerm } from "../auth/middleware.js";
import { roleHasPerm } from "../auth/rbac.js";
import { ONE_ON_ONE_TYPES, type OneOnOneType } from "../oneOnOne/catalog.js";
import { viewDenied } from "../oneOnOne/visibility.js";
import { parseEnpsRange, granularityFor, summarizeEnps, buildEnpsSeries } from "../oneOnOne/enps.js";
import * as signals from "../core/oneOnOneSignals.js";
import * as managerState from "../core/managerState.js";
import { activeManagerSql } from "../core/activeManager.js";

/**
 * Ван-ту-вани (1×1) — три типи (A: тімлід→менеджер, B: керівник→тімлід, V: HR→всі).
 * Доступ до РОЗДІЛУ гейтить екран `oneonone` (tab-гейт у requireAuth). Далі — ДВА скоупи:
 *  • conduct — кого можна ПРОВОДИТИ (за типом);
 *  • view    — чию історію/аналітику видно: conductor бачить ЛИШЕ свої проведені; наскрізний
 *              перегляд (усі типи/люди) — тільки право view_all_1x1 (HR/СЕО/ОД).
 * Питання — версіоновані форми в БД; історія рендериться проти form_version запису.
 */
export const oneOnOnesRouter = Router();
oneOnOnesRouter.use(requireAuth);

const isType = (t: unknown): t is OneOnOneType => ONE_ON_ONE_TYPES.includes(t as OneOnOneType);
const monthOf = (q: unknown) => (String(q || new Date().toISOString().slice(0, 7)).slice(0, 7)) + "-01";
/** Сьогодні по-київськи (YYYY-MM-DD) — дати завжди в київській зоні. */
const kyivToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
/** Дата зустрічі з запиту: строго YYYY-MM-DD, інакше null. */
const dateOf = (q: unknown): string | null => {
  const s = String(q ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};
const crossview = (auth: { roleKey: string }) => roleHasPerm(auth.roleKey, "view_all_1x1");

/** Чи може ця роль ПРОВОДИТИ тип. A: тімлід(своя команда) або наскрізний; B/V: лише наскрізний. */
function canConduct(auth: { role: string; roleKey: string }, type: OneOnOneType): boolean {
  if (crossview(auth)) return true;
  if (type === "A") return auth.role === "team_lead";
  return false;
}

/** WHERE для субʼєктів, яких дозволено проводити (за типом і скоупом). */
function conductSubjectScope(auth: { role: string; roleKey: string; teamId: number | null }, type: OneOnOneType) {
  if (type === "B") return { where: "m.is_team_lead AND m.is_active", params: [] as unknown[] };
  if (type === "V") return { where: "m.is_active", params: [] as unknown[] };
  // type A
  if (crossview(auth)) return { where: "m.is_active", params: [] as unknown[] };
  return { where: "m.team_id = $1 AND m.is_active", params: [auth.teamId] as unknown[] };
}

/** WHERE-фрагмент для VIEW-скоупу (історія/аналітика): наскрізний → усе; інакше лише свої проведені. */
function viewScope(auth: { userId: number; roleKey: string }, alias = "o") {
  if (crossview(auth)) return { frag: "TRUE", params: [] as unknown[] };
  return { frag: `${alias}.conducted_by = $P`, params: [auth.userId] as unknown[] };
}

const overallFrom = (type: OneOnOneType, answers: Record<string, { score?: number }>, enps: number | null) => {
  if (type === "V") return typeof enps === "number" ? enps : null;
  const s = Object.values(answers || {}).map((a) => a?.score).filter((x): x is number => typeof x === "number" && x > 0);
  return s.length ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 : null;
};

/** Які типи 1×1 цей користувач може ПРОВОДИТИ + прапорці — усе по ЖИВОМУ roleKey/правах,
 *  не по scope-clamped auth.role чи знімку токена. FE бере доступні типи ЗВІДСИ (працює за
 *  будь-якого data_scope і незалежно від свіжості токена). */
oneOnOnesRouter.get("/conduct-types", (req, res) => {
  const auth = req.auth!;
  res.json({
    types: ONE_ON_ONE_TYPES.filter((t) => canConduct(auth, t)),
    crossview: crossview(auth),
    canEdit: roleHasPerm(auth.roleKey, "edit_1x1_forms"),
  });
});

async function activeForm(type: OneOnOneType): Promise<{ version: number; questions: unknown } | null> {
  const r = await pool.query<{ version: number; questions: unknown }>(
    "SELECT version, questions FROM one_on_one_forms WHERE type=$1 AND is_active ORDER BY version DESC LIMIT 1", [type]);
  return r.rows[0] ?? null;
}

// ── Форми (питання) ──────────────────────────────────────────────────────────
/** Активна (або конкретна) версія форми типу — для рендеру та історії. */
oneOnOnesRouter.get("/forms/:type", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const ver = req.query.version ? Number(req.query.version) : null;
  const r = ver
    ? await pool.query("SELECT type, version, questions, is_active FROM one_on_one_forms WHERE type=$1 AND version=$2", [type, ver])
    : await pool.query("SELECT type, version, questions, is_active FROM one_on_one_forms WHERE type=$1 AND is_active ORDER BY version DESC LIMIT 1", [type]);
  if (!r.rows[0]) return res.status(404).json({ error: "Форма не знайдена" });
  res.json(r.rows[0]);
});

/** Список версій форми (для редактора/історії). */
oneOnOnesRouter.get("/forms/:type/versions", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const r = await pool.query(
    "SELECT version, is_active, created_at FROM one_on_one_forms WHERE type=$1 ORDER BY version DESC", [type]);
  res.json({ versions: r.rows });
});

/** Редагувати набір питань → нова версія (стара лишається для історії). Право edit_1x1_forms. */
oneOnOnesRouter.put("/forms/:type", requirePerm("edit_1x1_forms"), async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const questions = req.body?.questions;
  if (!questions || typeof questions !== "object" || !Array.isArray(questions.sections)) {
    return res.status(400).json({ error: "questions.sections обовʼязкові" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nv = await client.query<{ v: number }>("SELECT COALESCE(MAX(version),0)+1 AS v FROM one_on_one_forms WHERE type=$1", [type]);
    const version = nv.rows[0].v;
    await client.query("UPDATE one_on_one_forms SET is_active=false WHERE type=$1 AND is_active", [type]);
    await client.query(
      "INSERT INTO one_on_one_forms (type, version, questions, is_active, created_by) VALUES ($1,$2,$3,true,$4)",
      [type, version, JSON.stringify(questions), req.auth!.userId]);
    await client.query("COMMIT");
    res.json({ ok: true, type, version });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// ── Проведення ───────────────────────────────────────────────────────────────
/** Список субʼєктів, яких дозволено проводити (за типом) + зустрічі за МІСЯЦЬ.
 *  Зустрічей у місяці може бути КІЛЬКА: `meetings` — скільки, `overall`/`last_meeting_date` —
 *  по ОСТАННІЙ. `done` = чи була хоч одна (яку я маю право бачити). */
oneOnOnesRouter.get("/subjects", async (req, res) => {
  const type = String(req.query.type || "");
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  if (!canConduct(req.auth!, type)) return res.status(403).json({ error: "Немає доступу до проведення цього типу" });
  const month = monthOf(req.query.month);
  const { where, params } = conductSubjectScope(req.auth!, type);
  // conductSubjectScope для типу A використовує $1 → його параметри мають іти ПЕРШИМИ.
  const p: unknown[] = [...params];
  const push = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const typeP = push(type), monthP = push(month);
  // видимість запису: наскрізний → усі; інакше лише мною проведені (статус чесний).
  const vsFrag = crossview(req.auth!) ? "TRUE" : `x.conducted_by = ${push(req.auth!.userId)}`;
  const inMonth = `x.subject_manager_id = m.id AND x.type = ${typeP}
                   AND date_trunc('month', x.meeting_date) = ${monthP}::date AND (${vsFrag})`;
  const r = await pool.query(
    `SELECT m.id, m.name, m.team_id, m.is_team_lead, t.name AS team_name,
            last.overall, to_char(last.meeting_date,'YYYY-MM-DD') AS last_meeting_date,
            last.updated_at, agg.meetings, (agg.meetings > 0) AS done
       FROM managers m
       LEFT JOIN teams t ON t.id = m.team_id
       LEFT JOIN LATERAL (SELECT count(*)::int AS meetings FROM one_on_ones x WHERE ${inMonth}) agg ON TRUE
       LEFT JOIN LATERAL (SELECT x.overall, x.meeting_date, x.updated_at FROM one_on_ones x
                           WHERE ${inMonth} ORDER BY x.meeting_date DESC LIMIT 1) last ON TRUE
      WHERE ${where}
      ORDER BY t.name NULLS LAST, m.is_team_lead DESC, m.name`,
    p
  );
  res.json({ type, month, subjects: r.rows });
});

/** Журнал зустрічей одного субʼєкта за N місяців (view-скоуп). Кожна зустріч — окремий рядок. */
oneOnOnesRouter.get("/meetings/:type/:managerId", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const deny = viewDenied(crossview(req.auth!), canConduct(req.auth!, type));
  if (deny) return res.status(403).json({ error: deny });
  const managerId = Number(req.params.managerId);
  const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
  const p: unknown[] = [managerId, type];
  const push = (v: unknown) => { p.push(v); return `$${p.length}`; };
  const vsFrag = crossview(req.auth!) ? "TRUE" : `o.conducted_by = ${push(req.auth!.userId)}`;
  const monthsP = push(months - 1);
  const r = await pool.query(
    `SELECT to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date, o.overall, o.enps_score,
            o.satisfaction_score, o.form_version, o.conducted_by, o.updated_at,
            COALESCE(mm.name, u.email) AS conducted_by_name
       FROM one_on_ones o
       LEFT JOIN users u ON u.id = o.conducted_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE o.subject_manager_id=$1 AND o.type=$2 AND (${vsFrag})
        AND o.meeting_date >= (date_trunc('month', now()) - make_interval(months => ${monthsP}))
      ORDER BY o.meeting_date DESC`,
    p
  );
  res.json({ type, subject_manager_id: managerId, meetings: r.rows });
});

/** Один запис ЗУСТРІЧІ за датою (для проведення або перегляду). Дата — авторитетна:
 *  ?date=YYYY-MM-DD визначає КОНКРЕТНУ зустріч. Без дати — сьогоднішня (нова зустріч).
 *  Порожній шаблон — якщо на цю дату ще не проводили. */
oneOnOnesRouter.get("/record/:type/:managerId", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const managerId = Number(req.params.managerId);
  const meetingDate = dateOf(req.query.date) ?? kyivToday();
  const r = await pool.query(
    `SELECT o.subject_manager_id, o.type, to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date,
            o.form_version, o.answers, o.overall, o.satisfaction_score, o.task_reviews,
            o.enps_score, o.enps_reason, o.notes, o.conducted_by, o.updated_at,
            COALESCE(mm.name, u.email) AS conducted_by_name
       FROM one_on_ones o
       LEFT JOIN users u ON u.id = o.conducted_by
       LEFT JOIN managers mm ON mm.id = u.manager_id
      WHERE o.subject_manager_id=$1 AND o.type=$2 AND o.meeting_date=$3`,
    [managerId, type, meetingDate]);
  const rec = r.rows[0];
  if (rec) {
    if (!crossview(req.auth!) && rec.conducted_by !== req.auth!.userId) {
      return res.status(403).json({ error: "Цей запис проводив інший" });
    }
    return res.json(rec);
  }
  // немає запису → віддаємо порожній шаблон, лише якщо цей користувач може проводити цей тип
  if (!canConduct(req.auth!, type)) return res.status(403).json({ error: "Немає доступу" });
  const form = await activeForm(type);
  res.json({ subject_manager_id: managerId, type, meeting_date: meetingDate, form_version: form?.version ?? 1,
    answers: {}, overall: null, satisfaction_score: null, enps_score: null, enps_reason: null,
    notes: null, task_reviews: null, conducted_by: null });
});

/** Зберегти запис (upsert). Ставить conducted_by=я, form_version=активна. */
oneOnOnesRouter.post("/record", async (req, res) => {
  const auth = req.auth!;
  const type = String(req.body?.type || "");
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  if (!canConduct(auth, type)) return res.status(403).json({ error: "Немає доступу до проведення цього типу" });
  const managerId = Number(req.body?.subjectManagerId);
  // ДАТА ЗУСТРІЧІ — авторитетна: визначає, який саме запис створюється/оновлюється.
  const meetingDate = dateOf(req.body?.meetingDate) ?? kyivToday();
  const answers = (req.body?.answers ?? {}) as Record<string, { score?: number; text?: string }>;
  if (!managerId || typeof answers !== "object") return res.status(400).json({ error: "subjectManagerId та answers обовʼязкові" });
  // субʼєкт має бути в conduct-скоупі цього типу
  const { where, params } = conductSubjectScope(auth, type);
  const inScope = await pool.query(`SELECT 1 FROM managers m WHERE m.id=$${params.length + 1} AND (${where})`, [...params, managerId]);
  if (!inScope.rowCount) return res.status(403).json({ error: "Субʼєкт поза вашим скоупом" });
  // не можна перезаписувати чужий запис (лише свій або наскрізний)
  const ex = await pool.query<{ conducted_by: number | null }>(
    "SELECT conducted_by FROM one_on_ones WHERE subject_manager_id=$1 AND type=$2 AND meeting_date=$3",
    [managerId, type, meetingDate]);
  if (ex.rows[0] && !crossview(auth) && ex.rows[0].conducted_by !== auth.userId) {
    return res.status(403).json({ error: "Цей запис проводив інший" });
  }
  const enpsScore = type === "V" && Number.isInteger(req.body?.enpsScore) ? Number(req.body.enpsScore) : null;
  const enpsReason = type === "V" ? (req.body?.enpsReason ?? null) : null;
  const notes = type === "V" ? (req.body?.notes ?? null) : null;
  // ЗАДОВОЛЕНІСТЬ: для A/Б — власний структурний блок (1-10); для В — це і є eNPS-бал
  // (єдине джерело для історії). У `overall` НЕ входить — окремий показник.
  const rawSat = Number(req.body?.satisfactionScore);
  const satisfaction = type === "V"
    ? enpsScore
    : (Number.isInteger(rawSat) && rawSat >= 1 && rawSat <= 10 ? rawSat : null);
  const overall = overallFrom(type, answers, enpsScore);
  const form = await activeForm(type);
  await pool.query(
    `INSERT INTO one_on_ones (subject_manager_id, type, meeting_date, form_version, conducted_by, answers, overall, enps_score, enps_reason, notes, satisfaction_score, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (subject_manager_id, type, meeting_date) DO UPDATE SET
       answers=EXCLUDED.answers, overall=EXCLUDED.overall, enps_score=EXCLUDED.enps_score,
       enps_reason=EXCLUDED.enps_reason, notes=EXCLUDED.notes, conducted_by=EXCLUDED.conducted_by,
       satisfaction_score=EXCLUDED.satisfaction_score,
       form_version=EXCLUDED.form_version, updated_at=now()`,
    [managerId, type, meetingDate, form?.version ?? 1, auth.userId, JSON.stringify(answers), overall,
     enpsScore, enpsReason, notes ? JSON.stringify(notes) : null, satisfaction]);
  res.json({ ok: true, overall, satisfaction, meetingDate });
});

// ── Задачі з 1×1 ─────────────────────────────────────────────────────────────
/** Чи може цей користувач ставити/знімати задачі по цьому субʼєкту (ведучий типу або наскрізний). */
async function canManageTasks(auth: Express.Request["auth"] & object, type: OneOnOneType, managerId: number) {
  if (!canConduct(auth, type)) return false;
  const { where, params } = conductSubjectScope(auth, type);
  const r = await pool.query(`SELECT 1 FROM managers m WHERE m.id=$${params.length + 1} AND (${where})`,
    [...params, managerId]);
  return !!r.rowCount;
}

/** Поставити задачу субʼєкту внизу форми зустрічі. Закріплена, знімає лише ведучий. */
oneOnOnesRouter.post("/task", async (req, res) => {
  const auth = req.auth!;
  const type = String(req.body?.type || "");
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const managerId = Number(req.body?.subjectManagerId);
  const title = String(req.body?.title ?? "").trim();
  const deadline = dateOf(req.body?.deadline);
  const meetingDate = dateOf(req.body?.meetingDate) ?? kyivToday();
  if (!managerId || !title) return res.status(400).json({ error: "subjectManagerId і title обовʼязкові" });
  if (!(await canManageTasks(auth, type, managerId))) {
    return res.status(403).json({ error: "Немає доступу ставити задачі цьому субʼєкту" });
  }
  // департамент — з команди виконавця (як і в решті задачника)
  const dep = await pool.query<{ department: string | null }>(
    "SELECT t.name AS department FROM managers m LEFT JOIN teams t ON t.id=m.team_id WHERE m.id=$1", [managerId]);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO tasks (title, status, deadline, assignee_id, created_by, priority, department,
                        task_type, pinned, o2o_type, o2o_meeting_date)
     VALUES ($1,'not_started',$2,$3,$4,'high',$5,'oneonone',true,$6,$7) RETURNING id`,
    [title, deadline, managerId, auth.userId, dep.rows[0]?.department ?? null, type, meetingDate]);
  res.status(201).json({ id: r.rows[0].id });
});

/** ВІДКРИТІ задачі з МИНУЛИХ зустрічей цього субʼєкта/типу — блок рев'ю вгорі форми.
 *  Задачі, поставлені на ЦІЙ же зустрічі, у власне рев'ю не потрапляють (?before=дата). */
oneOnOnesRouter.get("/open-tasks/:type/:managerId", async (req, res) => {
  const type = req.params.type;
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const managerId = Number(req.params.managerId);
  if (!(await canManageTasks(req.auth!, type, managerId))) {
    return res.status(403).json({ error: "Немає доступу" });
  }
  const before = dateOf(req.query.before);
  const p: unknown[] = [managerId, type];
  if (before) p.push(before);
  const r = await pool.query(
    `SELECT t.id, t.title, to_char(t.deadline,'YYYY-MM-DD') AS deadline,
            to_char(t.o2o_meeting_date,'YYYY-MM-DD') AS "setAt", t.status, t.created_by AS "createdById",
            COALESCE(cm.name, cu.email) AS "createdByName",
            (SELECT count(*)::int FROM one_on_ones o
              WHERE o.subject_manager_id = t.assignee_id AND o.type = t.o2o_type
                AND o.task_reviews @> jsonb_build_array(jsonb_build_object('taskId', t.id))) AS "carriedTimes"
       FROM tasks t
       LEFT JOIN users cu ON cu.id = t.created_by
       LEFT JOIN managers cm ON cm.id = cu.manager_id
      WHERE t.task_type='oneonone' AND t.assignee_id=$1 AND t.o2o_type=$2
        AND t.o2o_resolution IS NULL AND t.status <> 'done'
        ${before ? "AND t.o2o_meeting_date < $3" : ""}
      ORDER BY t.o2o_meeting_date, t.id`, p);
  res.json({ tasks: r.rows });
});

const OUTCOMES = new Set(["done", "carried", "cancelled"]);
/** Рев'ю задачі на зустрічі: виконано / ні (переноситься) / знято. Лише ведучий або наскрізний.
 *  Результат пишеться І в задачу (хто/коли зняв), І в запис зустрічі (що обговорювали). */
oneOnOnesRouter.post("/task/:id/review", async (req, res) => {
  const auth = req.auth!;
  const id = Number(req.params.id);
  const outcome = String(req.body?.outcome || "");
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: "outcome: done | carried | cancelled" });
  const meetingDate = dateOf(req.body?.meetingDate) ?? kyivToday();
  const t = await pool.query<{ assignee_id: number; o2o_type: OneOnOneType; title: string; created_by: number | null }>(
    "SELECT assignee_id, o2o_type, title, created_by FROM tasks WHERE id=$1 AND task_type='oneonone'", [id]);
  const task = t.rows[0];
  if (!task) return res.status(404).json({ error: "Задачу з 1×1 не знайдено" });
  // позначати може ЛИШЕ ведучий цього типу (у чиєму скоупі субʼєкт) або наскрізний
  if (!(await canManageTasks(auth, task.o2o_type, task.assignee_id))) {
    return res.status(403).json({ error: "Позначати може лише ведучий цього типу" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (outcome === "carried") {
      // лишається відкритою і ЗАКРІПЛЕНОЮ — перенеслась на наступну зустріч
      await client.query("UPDATE tasks SET updated_at=now() WHERE id=$1", [id]);
    } else {
      // done — зарахована; cancelled — знята без зарахування. Обидва: закрити + відкріпити.
      await client.query(
        `UPDATE tasks SET status='done', pinned=false, o2o_resolution=$2,
                          o2o_resolved_at=now(), o2o_resolved_by=$3, updated_at=now() WHERE id=$1`,
        [id, outcome, auth.userId]);
    }
    const who = await client.query<{ name: string | null }>(
      "SELECT COALESCE(m.name, u.email) AS name FROM users u LEFT JOIN managers m ON m.id=u.manager_id WHERE u.id=$1",
      [auth.userId]);
    const entry = { taskId: id, title: task.title, outcome, at: new Date().toISOString(),
      byUserId: auth.userId, byName: who.rows[0]?.name ?? null };
    // запис зустрічі може ще не існувати (рев'ю до збереження анкети) — створюємо кістяк
    await client.query(
      `INSERT INTO one_on_ones (subject_manager_id, type, meeting_date, conducted_by, task_reviews)
       VALUES ($1,$2,$3,$4, jsonb_build_array($5::jsonb))
       ON CONFLICT (subject_manager_id, type, meeting_date) DO UPDATE
         SET task_reviews = COALESCE(one_on_ones.task_reviews,'[]'::jsonb) || jsonb_build_array($5::jsonb),
             updated_at = now()`,
      [task.assignee_id, task.o2o_type, meetingDate, auth.userId, JSON.stringify(entry)]);
    await client.query("COMMIT");
    res.json({ ok: true, outcome });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// ── Історія / аналітика (view-скоуп) ─────────────────────────────────────────
/** Історія оцінок субʼєктів за N місяців (під view-скоупом). */
oneOnOnesRouter.get("/stats/scores", async (req, res) => {
  const type = String(req.query.type || "A");
  if (!isType(type)) return res.status(400).json({ error: "Невідомий тип" });
  const deny = viewDenied(crossview(req.auth!), canConduct(req.auth!, type));
  if (deny) return res.status(403).json({ error: deny });
  /* 📅 ОДИН МІСЯЦЬ, А НЕ «ОСТАННІ N», — рішення власника 07.09.2026: «воно все йде в
     рядок, а зроби щоб тільки по місяцях було». На екрані вибір місяця БУВ, але вкладка
     «Історія» його не передавала взагалі — запит ішов із жорстким `months=6`, тож
     таблиця малювала колонку на КОЖНУ зустріч за півроку й виїжджала за екран.
     ⚠️ `months` лишається фолбеком для старого бандла, що ще крутиться у вкладках у
     мить викату, — той самий прийом, що вже застосований у сусідньому eNPS. */
  const month = String(req.query.month ?? "");
  const oneMonth = /^\d{4}-\d{2}$/.test(month);
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  const vs = viewScope(req.auth!, "o");
  const params: unknown[] = [type];
  let vsFrag = vs.frag;
  if (vs.params.length) { params.push(vs.params[0]); vsFrag = vs.frag.replace("$P", `$${params.length}`); }
  params.push(oneMonth ? `${month}-01` : months - 1);
  const r = await pool.query(
    `SELECT m.id, m.name, m.team_id, t.name AS team_name,
            to_char(o.meeting_date,'YYYY-MM-DD') AS meeting_date,
            to_char(date_trunc('month', o.meeting_date),'YYYY-MM') AS month,
            o.overall, o.enps_score, o.satisfaction_score, o.form_version, o.answers
       FROM one_on_ones o
       JOIN managers m ON m.id = o.subject_manager_id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE o.type=$1 AND (${vsFrag})
        AND ${oneMonth
              ? `date_trunc('month', o.meeting_date) = $${params.length}::date`
              : `o.meeting_date >= (date_trunc('month', now()) - make_interval(months => $${params.length}))`}
      ORDER BY t.name NULLS LAST, m.name, o.meeting_date`, params);
  res.json({ type, month: oneMonth ? month : null, rows: r.rows });
});

/**
 * 🚦 КОРОТКА АНАЛІТИКА за ОДИН місяць: `?month=YYYY-MM` (без нього — поточний).
 *
 * Задача власника 07.09.2026: «підсвічує, які є проблеми, з ким ті проблеми, що покращити».
 * Правило кожного сигналу й усі пороги — у `core/oneOnOneSignals.ts`; роут лише збирає
 * рядки з бази й віддає результат ядра, щоб пороги можна було довести фікстурою.
 *
 * 🔴 ДВЕРІ ВІДЧИНЯЮТЬСЯ, ЯКЩО ВИБІРКА МОЖЕ БУТИ НЕПОРОЖНЬОЮ ХОЧ ПО ОДНОМУ ТИПУ — той
 * самий вузький критерій, що в `visibility.ts`. Аналітика зводить типи A/Б (бали, задачі)
 * і В (eNPS), тож тімлід, який проводить лише A, проходить — і бачить свою частину.
 *
 * 🔴 ЧОГО НЕ БАЧИШ — НЕ «НУЛЬ», А «НЕДОСТУПНО». Відповідь несе `sources`: по кожному типу
 * прапорець, чи має цей користувач право його бачити. Без нього тімлід читав би «0
 * детракторів eNPS» як добру новину, хоча насправді він тип В не бачить у принципі —
 * рівно та підміна, від якої береже правило «порожній скоуп не виражається нулем».
 */
oneOnOnesRouter.get("/analytics", async (req, res) => {
  const auth = req.auth!;
  const cross = crossview(auth);
  const canAny = ONE_ON_ONE_TYPES.some((t) => canConduct(auth, t));
  const deny = viewDenied(cross, canAny);
  if (deny) return res.status(403).json({ error: deny });

  const monthStr = /^\d{4}-\d{2}$/.test(String(req.query.month ?? ""))
    ? String(req.query.month) : kyivToday().slice(0, 7);
  const month = `${monthStr}-01`;
  const prev = `${signals.prevMonthOf(monthStr)}-01`;

  /* 🔴 КОЖЕН ЗАПИТ НУМЕРУЄ СВОЇ ПАРАМЕТРИ САМ — і лише ті, які справді читає.
     📐 Куплено тут же, на першому прогоні проти прод-бази: редакція з ФІКСОВАНИМИ
     позиціями ($1 місяць, $2 попередній, $3 глядач, $4 команда) впала з `08P01`
     «bind message supplies 4 parameters, but prepared statement requires 2». Причина —
     у наскрізного глядача фрагмент скоупу стає `TRUE`, тож `$3`/`$4` у тексті не
     зʼявляються взагалі, а Postgres відкидає ЗАЙВІ параметри, а не ігнорує їх.
     Тому placeholder видає `add()` у мить використання: номер і значення не можуть
     розійтись за побудовою. `vs` теж будується всередині кожного запиту — він або
     споживає параметр, або ні, і тільки сам запит знає, який у того номер. */
  const mk = () => {
    const p: unknown[] = [];
    const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    /** Фрагмент скоупу перегляду: наскрізний — усе, інакше лише свої проведені. */
    const scope = () => (cross ? "TRUE" : `o.conducted_by = ${add(auth.userId)}`);
    return { p, add, scope };
  };

  const q0 = mk();
  const mP = q0.add(month), pP = q0.add(prev), vs0 = q0.scope();
  // Ростер: стан `active` (двопрапорцева активність + накладка «завершує»/«звільнений»)
  // І є команда. Тімлід бачить лише свою команду — той самий скоуп, що й у «Провести».
  const rosterConds = [managerState.hasPlanSql("m", activeManagerSql("m")), "m.team_id IS NOT NULL"];
  if (!cross) rosterConds.push(`m.team_id = ${q0.add(auth.teamId)}`);

  const roster = await pool.query<{
    id: number; name: string; team_id: number | null; team_name: string | null;
    is_team_lead: boolean; owed: OneOnOneType;
    met_this_month: boolean; met_ever: boolean;
    avg_this: string | null; avg_prev: string | null;
  }>(
    `WITH r AS (
       SELECT m.id, m.name, m.team_id, m.is_team_lead, t.name AS team_name,
              CASE WHEN m.is_team_lead THEN 'B' ELSE 'A' END AS owed
         FROM managers m
         LEFT JOIN teams t ON t.id = m.team_id
         ${managerState.stateJoinSql("m")}
        WHERE ${rosterConds.join(" AND ")}
     )
     SELECT r.id AS id, r.name AS name, r.team_id AS team_id, r.team_name AS team_name,
            r.is_team_lead AS is_team_lead, r.owed AS owed,
            EXISTS (SELECT 1 FROM one_on_ones o WHERE o.subject_manager_id = r.id AND o.type = r.owed
                      AND date_trunc('month', o.meeting_date) = ${mP}::date AND (${vs0})) AS met_this_month,
            EXISTS (SELECT 1 FROM one_on_ones o WHERE o.subject_manager_id = r.id AND o.type = r.owed
                      AND (${vs0})) AS met_ever,
            (SELECT avg(o.overall) FROM one_on_ones o WHERE o.subject_manager_id = r.id AND o.type = r.owed
               AND date_trunc('month', o.meeting_date) = ${mP}::date AND (${vs0})) AS avg_this,
            (SELECT avg(o.overall) FROM one_on_ones o WHERE o.subject_manager_id = r.id AND o.type = r.owed
               AND date_trunc('month', o.meeting_date) = ${pP}::date AND (${vs0})) AS avg_prev
       FROM r ORDER BY r.name`, q0.p);

  const ids = roster.rows.map((r) => r.id);
  const num = (x: string | null) => (x === null ? null : Number(x));

  // eNPS-детрактори (тип В) з причиною ДОСЛІВНО — вигадувати формулювання не можна.
  const q1 = mk();
  const m1 = q1.add(month), vs1 = q1.scope(), lo1 = q1.add(signals.SIGNAL_THRESHOLDS.enpsLow), id1 = q1.add(ids);
  const enps = await pool.query<{ manager_id: number; enps_score: number; enps_reason: string | null }>(
    `SELECT o.subject_manager_id AS manager_id, o.enps_score AS enps_score, o.enps_reason AS enps_reason
       FROM one_on_ones o
      WHERE o.type='V' AND date_trunc('month', o.meeting_date) = ${m1}::date AND (${vs1})
        AND o.enps_score IS NOT NULL AND o.enps_score <= ${lo1}
        AND o.subject_manager_id = ANY(${id1}::int[])
      ORDER BY o.enps_score`, q1.p);

  // Окремі низькі відповіді — середнє їх ховає, тому дивимось на кожну оцінку зустрічі.
  const q2 = mk();
  const m2 = q2.add(month), vs2 = q2.scope(), lo2 = q2.add(signals.SIGNAL_THRESHOLDS.answerLow), id2 = q2.add(ids);
  const lows = await pool.query<{ manager_id: number; qkey: string; score: string }>(
    `SELECT o.subject_manager_id AS manager_id, e.k AS qkey, (e.v->>'score') AS score
       FROM one_on_ones o, jsonb_each(o.answers) e(k, v)
      WHERE o.type IN ('A','B') AND date_trunc('month', o.meeting_date) = ${m2}::date AND (${vs2})
        AND (e.v->>'score') ~ '^[0-9.]+$' AND (e.v->>'score')::numeric > 0
        AND (e.v->>'score')::numeric <= ${lo2}
        AND o.subject_manager_id = ANY(${id2}::int[])`, q2.p);

  // Найслабші питання по відділу — без порогу, це відповідь на «що покращити».
  const q3 = mk();
  const m3 = q3.add(month), vs3 = q3.scope(), id3 = q3.add(ids);
  const weak = await pool.query<{ qkey: string; avg: string; answers: number }>(
    `SELECT e.k AS qkey, avg((e.v->>'score')::numeric) AS avg, count(*)::int AS answers
       FROM one_on_ones o, jsonb_each(o.answers) e(k, v)
      WHERE o.type='A' AND date_trunc('month', o.meeting_date) = ${m3}::date AND (${vs3})
        AND (e.v->>'score') ~ '^[0-9.]+$' AND (e.v->>'score')::numeric > 0
        AND o.subject_manager_id = ANY(${id3}::int[])
      GROUP BY 1`, q3.p);

  // Підписи питань — з АКТИВНОЇ форми типу A. qKey, якого там уже немає (питання зняли),
  // лишається без підпису, і фронт покаже сам ключ: невідоме має читатись як невідоме.
  const labels = await pool.query<{ qkey: string; label: string }>(
    `SELECT x->>'qKey' AS qkey, x->>'label' AS label
       FROM one_on_one_forms f,
            jsonb_array_elements(f.questions->'sections') s,
            jsonb_array_elements(s->'questions') x
      WHERE f.type='A' AND f.is_active`);
  const labelOf = new Map(labels.rows.map((r) => [r.qkey, r.label]));

  // Задачі скоупляться ВИКОНАВЦЕМ (ростер), а не автором: тімлід уже звужений своєю
  // командою вище, а задача, поставлена іншим ведучим, однаково лишається невиконаною.
  const tasks = await pool.query<{ id: number; manager_id: number; title: string; deadline: string | null; status: string }>(
    `SELECT t.id, t.assignee_id AS manager_id, t.title,
            to_char(t.deadline,'YYYY-MM-DD') AS deadline, t.status
       FROM tasks t
      WHERE t.task_type='oneonone' AND t.o2o_resolution IS NULL AND t.status <> 'done'
        AND t.deadline >= $1::date AND t.deadline < ($1::date + interval '1 month')
        AND t.assignee_id = ANY($2::int[])`, [month, ids]);

  /* ⚠️ ЗАДАЧА БЕЗ ДЕДЛАЙНУ НЕ НАЛЕЖИТЬ ЖОДНОМУ МІСЯЦЮ — і мовчки випала б із сигналу.
     Заміряно на проді 09.09.2026: таких відкритих задач 1×1 — 2. Тому їх кількість їде
     ОКРЕМИМ числом: «не потрапили у вибірку» має бути видимим, а не зникати. */
  const noDeadline = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks
      WHERE task_type='oneonone' AND o2o_resolution IS NULL AND status <> 'done'
        AND deadline IS NULL AND assignee_id = ANY($1::int[])`, [ids]);

  const byMgr = <T extends { manager_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) { const l = m.get(r.manager_id) ?? []; l.push(r); m.set(r.manager_id, l); }
    return m;
  };
  const enpsBy = byMgr(enps.rows), lowsBy = byMgr(lows.rows), tasksBy = byMgr(tasks.rows);

  const people: signals.PersonInput[] = roster.rows.map((r) => {
    // Зустрічей типу В у місяці може бути кілька — беремо НАЙНИЖЧИЙ бал: сигнал про
    // проблему, а середнє її б згладило.
    const e = (enpsBy.get(r.id) ?? []).slice().sort((a, b) => a.enps_score - b.enps_score)[0];
    return {
      managerId: r.id, name: r.name, teamId: r.team_id, teamName: r.team_name,
      isTeamLead: r.is_team_lead,
      metThisMonth: r.met_this_month, metEver: r.met_ever,
      avgThisMonth: num(r.avg_this), avgPrevMonth: num(r.avg_prev),
      enpsScore: e ? Number(e.enps_score) : null,
      enpsReason: e?.enps_reason ?? null,
      lowAnswers: (lowsBy.get(r.id) ?? []).map((a) => ({
        qKey: a.qkey, label: labelOf.get(a.qkey) ?? null, score: Number(a.score) })),
      openTasks: (tasksBy.get(r.id) ?? []).map((t) => ({
        id: t.id, title: t.title, deadline: t.deadline, status: t.status })),
    };
  });

  const findings = signals.findingsOf(people);
  res.json({
    month: monthStr,
    prevMonth: signals.prevMonthOf(monthStr),
    rosterSize: roster.rows.length,
    // Що саме цей користувач має право бачити — щоб порожнеча не читалась як «0 проблем».
    sources: Object.fromEntries(ONE_ON_ONE_TYPES.map((t) => [t, cross || canConduct(auth, t)])),
    thresholds: signals.SIGNAL_THRESHOLDS,
    labels: signals.SIGNAL_LABEL,
    notes: signals.SIGNAL_NOTE,
    counts: signals.countBySignal(findings),
    people: findings,
    teams: signals.rollUpByTeam(findings),
    weakQuestions: signals.weakestQuestions(
      weak.rows.map((w) => ({ qKey: w.qkey, label: labelOf.get(w.qkey) ?? null,
        avg: Number(w.avg), answers: Number(w.answers) }))),
    tasksWithoutDeadline: noDeadline.rows[0]?.n ?? 0,
  });
});

/**
 * eNPS (тип В) за ДОВІЛЬНИЙ період: `?from=YYYY-MM-DD&to=YYYY-MM-DD`, обидва кінці
 * ВКЛЮЧНО. `?months=N` лишається як фолбек для старого бандла, що ще крутиться в
 * браузерах у момент викату.
 *
 * 🔴 ЗАПИТ БІЛЬШЕ НЕ КЛАСИФІКУЄ. Він віддає ГІСТОГРАМУ (день × бал × кількість), а хто
 * промоутер, які відсотки, яка смуга й на які бакети різати тренд — вирішує
 * `oneOnOne/enps.ts`. Доти пороги «9-10/7-8/0-6» жили в чотирьох місцях (тут, у
 * `enpsColor`, у підписі під пікером і в мертвому `ENPS` каталогу) — і розійшлися б
 * тихо, бо кожне число окремо виглядало б правильним.
 */
oneOnOnesRouter.get("/enps", async (req, res) => {
  const range = parseEnpsRange(req.query, kyivToday());
  if ("error" in range) return res.status(400).json({ error: range.error });
  // eNPS рахується ЛИШЕ по типу V — тож і право питаємо саме про нього.
  const deny = viewDenied(crossview(req.auth!), canConduct(req.auth!, "V"));
  if (deny) return res.status(403).json({ error: deny });
  const vs = viewScope(req.auth!, "o");
  const params: unknown[] = [];
  let vsFrag = vs.frag;
  if (vs.params.length) { params.push(vs.params[0]); vsFrag = vs.frag.replace("$P", `$${params.length}`); }
  params.push(range.from, range.to);
  const fromP = `$${params.length - 1}`, toP = `$${params.length}`;
  const r = await pool.query<{ day: string; score: number; count: number }>(
    `SELECT to_char(o.meeting_date,'YYYY-MM-DD') AS day, o.enps_score AS score, count(*)::int AS count
       FROM one_on_ones o
      WHERE o.type='V' AND o.enps_score IS NOT NULL AND (${vsFrag})
        AND o.meeting_date >= ${fromP}::date AND o.meeting_date <= ${toP}::date
      GROUP BY 1, 2 ORDER BY 1`, params);
  const granularity = granularityFor(range.from, range.to);
  const rows = r.rows.map((x) => ({ day: x.day, score: Number(x.score), count: Number(x.count) }));
  res.json({
    from: range.from, to: range.to, granularity,
    summary: summarizeEnps(rows),
    series: buildEnpsSeries(rows, granularity),
  });
});
