/**
 * 📋 ОПИТУВАННЯ КОМАНДИ — /api/surveys/* (30.09.2026).
 *
 * Код Сергія (`roman-package-opytuvannya/server/routes/surveys.ts`) перенесено з такими змінами — і лише ними:
 *  1. Вхід — наш `requireAuth` + вкладка `surveys` першим оператором; «адмін» пакета (`role === 'admin'`) — право
 *     `manage_surveys` (admin, ceo, opdir, hr — рішення Романа 30.09.2026), одне місце — `isAdmin`.
 *  2. Люди — наші (`surveys/surveyStore.ts`): числові id, імʼя з менеджера/картки/акаунта, роль і команда.
 *  3. 🔒 АНОНІМНІСТЬ — ДІРКУ ПАКЕТА ЗАКРИТО. У пакеті `survey_assignments.responded_at` (з іменем) і
 *     `survey_responses.submitted_at` (без імені) писались ОДНИМ `now()` — рівний до мілісекунди час звʼязував
 *     людину з відповіддю для будь-кого з доступом до бази. В анонімному опитуванні обидва часи тепер — з точністю
 *     до ДНЯ (README пакета §7 сам радив «округлювати»). Іменні — точний час, як було.
 *  4. Явні колонки замість `SELECT *` (гейт #17e); id з адреси — лише ціле число; Express 4 — обгортка `h()`.
 *  5. Нові: `GET /badge` (пункт меню показується лише тому, кому є що відповідати або хто керує) і `GET /people`
 *     (вибір адресатів «окремі люди» / «команда тім-ліда»).
 */
import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { roleHasTab, roleHasPerm } from "../auth/rbac.js";
import { parseSurveyText } from "../surveys/surveyParser.js";
import { aggregateQuestion, trend, csvFor, enpsOf, type Question, type ResponseRow } from "../surveys/surveyResults.js";
import { loadQuestions, loadResponses, resolveAudience, notify, people, person, type Audience } from "../surveys/surveyStore.js";
import { launchSurvey, spawnNextIssue, fmtDue, SURVEY_COLS } from "../surveys/surveyScheduler.js";
import { validateSurvey, hasValue, cleanImage, NAME_SQL, MIN_SLICE } from "../surveys/surveyRules.js";

export const surveysRouter = Router();
surveysRouter.use(requireAuth);

class HttpError extends Error { constructor(public status: number, msg: string, public extra?: Record<string, unknown>) { super(msg); } }

surveysRouter.use((req, res, next) => {
  if (!req.auth || !roleHasTab(req.auth.roleKey, "surveys")) return res.status(403).json({ error: "Опитування недоступні для вашої ролі" });
  next();
});

const isAdmin = (req: Request) => roleHasPerm(req.auth!.roleKey, "manage_surveys");
const me = (req: Request) => req.auth!.userId;
function adminOnly(req: Request): void { if (!isAdmin(req)) throw new HttpError(403, "Лише для тих, хто керує опитуваннями."); }

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => async (req: Request, res: Response) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message, ...(e.extra ?? {}) });
    console.error("[surveys]", e);
    if (!res.headersSent) res.status(500).json({ error: "Помилка сервера" });
  }
};
const ROLE_LBL: Record<string, string> = { lead: "тім-лід", manager: "менеджер", hr: "HR", kvp: "КВП", admin: "адмін", ceo: "СЕО", opdir: "ОД", financier: "фінансист" };

const idOf = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "Немає.");
  return id;
};
async function one(id: number): Promise<any> {
  return (await pool.query(`SELECT ${SURVEY_COLS} FROM surveys WHERE id=$1`, [id])).rows[0];
}
async function saveQuestions(surveyId: number, questions: Question[] = []) {
  for (const [i, q] of questions.entries()) {
    await pool.query(`INSERT INTO survey_questions (survey_id, ord, type, text, hint, options, rows, min, max, required, image_url, series_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [surveyId, i, q.type, q.text, q.hint || null, JSON.stringify(q.options || []), JSON.stringify(q.rows || []), q.min ?? 1, q.max ?? 10,
       q.required !== false, cleanImage(q.image), "k" + i]);
  }
}

/* ── Чи показувати пункт меню і скільки нового (для всіх) ── */
surveysRouter.get("/badge", h(async (req, res) => {
  const r = await pool.query<{ assigned: number; unread: number; fresh: number }>(
    `SELECT (SELECT count(*) FROM survey_assignments a JOIN surveys s ON s.id = a.survey_id
              WHERE a.user_id = $1 AND s.status IN ('active','closed'))::int AS assigned,
            (SELECT count(*) FROM survey_notifications WHERE user_id = $1 AND read_at IS NULL)::int AS unread,
            (SELECT count(*) FROM survey_assignments a JOIN surveys s ON s.id = a.survey_id
              WHERE a.user_id = $1 AND s.status = 'active' AND a.responded_at IS NULL)::int AS fresh`, [me(req)]);
  res.json({ canManage: isAdmin(req), ...r.rows[0] });
}));

/* ── Парсер вставки (без збереження) ── */
surveysRouter.post("/parse", h((req, res) => { adminOnly(req); res.json(parseSurveyText(String(req.body?.text || ""))); }));

/* ── Люди й команди для вибору адресатів ── */
surveysRouter.get("/people", h(async (req, res) => {
  adminOnly(req);
  const ps = await people(pool);
  const teams = [...new Map(ps.filter((p) => p.team_id != null).map((p) => [p.team_id, { id: p.team_id, name: p.team }])).values()];
  res.json({ people: ps.map((p) => ({ id: p.id, name: p.name, role: p.role, team: p.team, teamId: p.team_id, isAdmin: p.is_admin })), teams });
}));

/* ── Створити / оновити чернетку ── */
surveysRouter.post("/", h(async (req, res) => {
  adminOnly(req);
  const b = req.body || {};
  const err = validateSurvey(b); if (err) throw new HttpError(422, err);
  const anon = !!b.anon;
  const ins = await pool.query<{ id: number }>(`INSERT INTO surveys (title, description, status, anon, due, remind, allow_edit, recur, audience, created_by)
    VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.title, b.desc || null, anon, b.due || null, JSON.stringify(b.remind || {}), anon ? false : b.allowEdit !== false,
     JSON.stringify(b.recur || { on: false }), JSON.stringify(b.audience || { kind: "all" }), me(req)]);
  await saveQuestions(ins.rows[0].id, b.questions);
  res.json({ id: Number(ins.rows[0].id) });
}));
surveysRouter.put("/:id", h(async (req, res) => {
  adminOnly(req);
  const s = await one(idOf(req)); if (!s) throw new HttpError(404, "Немає.");
  if (s.status !== "draft") throw new HttpError(409, "Після запуску питання заморожені — дублюйте як нове.");
  const b = req.body || {}; const err = validateSurvey(b); if (err) throw new HttpError(422, err);
  const anon = !!b.anon;
  await pool.query(`UPDATE surveys SET title=$2, description=$3, anon=$4, due=$5, remind=$6, allow_edit=$7, recur=$8, audience=$9 WHERE id=$1`,
    [s.id, b.title, b.desc || null, anon, b.due || null, JSON.stringify(b.remind || {}), anon ? false : b.allowEdit !== false,
     JSON.stringify(b.recur || { on: false }), JSON.stringify(b.audience || { kind: "all" })]);
  await pool.query(`DELETE FROM survey_questions WHERE survey_id=$1`, [s.id]);
  await saveQuestions(s.id, b.questions);
  res.json({ id: Number(s.id) });
}));

/* ── Список: адмін — усі; інші — адресовані їм ── */
surveysRouter.get("/", h(async (req, res) => {
  if (isAdmin(req)) {
    const q = await pool.query(`SELECT ${SURVEY_COLS.split(", ").map((c) => "s." + c).join(", ")},
        (SELECT count(*) FROM survey_questions WHERE survey_id=s.id)::int AS q_count,
        (SELECT count(*) FROM survey_assignments WHERE survey_id=s.id)::int AS assigned,
        (SELECT count(responded_at) FROM survey_assignments WHERE survey_id=s.id)::int AS responded
      FROM surveys s ORDER BY (CASE status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END), created_at DESC`);
    return void res.json(q.rows);
  }
  const q = await pool.query(`SELECT s.id, s.title, s.description, s.status, s.anon, s.due, s.allow_edit, s.closed_at, a.responded_at,
      (SELECT count(*) FROM survey_questions WHERE survey_id=s.id)::int AS q_count
    FROM survey_assignments a JOIN surveys s ON s.id = a.survey_id
    WHERE a.user_id=$1 AND s.status IN ('active','closed') ORDER BY s.status, s.due`, [me(req)]);
  res.json(q.rows);
}));

/* ── Шаблони ── */
const TEMPLATE_COLS = "id, name, questions, anon, owner_id, created_at";
surveysRouter.get("/templates", h(async (req, res) => {
  adminOnly(req);
  res.json((await pool.query(`SELECT ${TEMPLATE_COLS} FROM survey_templates WHERE owner_id IS NULL OR owner_id=$1 ORDER BY created_at DESC`, [me(req)])).rows);
}));
surveysRouter.post("/templates", h(async (req, res) => {
  adminOnly(req);
  const b = req.body || {};
  if (!String(b.name || "").trim()) throw new HttpError(400, "Вкажіть назву шаблону.");
  const q = await pool.query(`INSERT INTO survey_templates (name, questions, anon, owner_id) VALUES ($1,$2,$3,$4) RETURNING ${TEMPLATE_COLS}`,
    [String(b.name).slice(0, 200), JSON.stringify((b.questions || []).map((x: Question) => ({ ...x, image: cleanImage(x.image) }))), !!b.anon, b.shared ? null : me(req)]);
  res.json(q.rows[0]);
}));
surveysRouter.delete("/templates/:id", h(async (req, res) => {
  adminOnly(req);
  await pool.query(`DELETE FROM survey_templates WHERE id=$1 AND (owner_id IS NULL OR owner_id=$2)`, [idOf(req), me(req)]);
  res.json({ ok: true });
}));

/* ── Сповіщення поточного користувача ── */
surveysRouter.get("/notifications", h(async (req, res) => {
  res.json((await pool.query(`SELECT id, survey_id, kind, text, created_at, read_at FROM survey_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [me(req)])).rows);
}));
surveysRouter.post("/notifications/:id/read", h(async (req, res) => {
  await pool.query(`UPDATE survey_notifications SET read_at=now() WHERE id=$1 AND user_id=$2`, [idOf(req), me(req)]);
  res.json({ ok: true });
}));

/* ── Одне опитування: адмін — усе; респондент — питання + власна відповідь (іменне), лише якщо адресоване ── */
surveysRouter.get("/:id", h(async (req, res) => {
  const s = await one(idOf(req)); if (!s) throw new HttpError(404, "Немає.");
  const qs = await loadQuestions(pool, s.id);
  if (isAdmin(req)) return void res.json({ ...s, questions: qs });
  const a = await pool.query<{ responded_at: string | null }>(`SELECT a.responded_at FROM survey_assignments a
      WHERE a.survey_id=$1 AND a.user_id=$2`, [s.id, me(req)]);
  if (!a.rows[0] || !["active", "closed"].includes(s.status)) throw new HttpError(403, "Це опитування вам не адресоване.");
  let mine: ResponseRow | null = null;
  if (!s.anon) mine = (await loadResponses(pool, s.id)).find((x) => x.userId === String(me(req))) || null;
  res.json({ id: s.id, title: s.title, description: s.description, status: s.status, anon: s.anon, due: s.due, allow_edit: s.allow_edit,
    closed_at: s.closed_at, questions: qs, responded_at: a.rows[0].responded_at, mine });
}));

/* ── Запустити / закрити / відкрити знову / нагадати ── */
surveysRouter.post("/:id/launch", h(async (req, res) => {
  adminOnly(req);
  const s = await one(idOf(req)); if (!s) throw new HttpError(404, "Немає.");
  if (s.status !== "draft") throw new HttpError(409, "Запускати можна лише чернетку.");
  const qs = await loadQuestions(pool, s.id);
  const err = validateSurvey({ ...s, desc: s.description, allowEdit: s.allow_edit, questions: qs }, true);
  if (err) throw new HttpError(422, err);
  const n = await launchSurvey(pool, s, new Date());
  if (!n) {   // нікому не пішло — повертаємо в чернетку, щоб не висіло «активне» на нуль людей
    await pool.query(`UPDATE surveys SET status='draft', launched_at=NULL WHERE id=$1`, [s.id]);
    throw new HttpError(422, "За цим вибором адресатів немає жодної активної людини.");
  }
  res.json({ ok: true, assigned: n });
}));
surveysRouter.post("/:id/close", h(async (req, res) => {
  adminOnly(req);
  const s = await one(idOf(req)); if (!s || s.status !== "active") throw new HttpError(409, "Закрити можна лише активне.");
  await pool.query(`UPDATE surveys SET status='closed', closed_at=now(), closed_by='manual' WHERE id=$1`, [s.id]);
  if (s.recur?.on) await spawnNextIssue(pool, s, await loadQuestions(pool, s.id), new Date());
  res.json({ ok: true });
}));
surveysRouter.post("/:id/reopen", h(async (req, res) => {
  adminOnly(req);
  const s = await one(idOf(req)); if (!s || s.status !== "closed") throw new HttpError(409, "Відкрити знову можна лише закрите.");
  const due = new Date(s.due) > new Date() ? s.due : new Date(Date.now() + 3 * 86400000);
  await pool.query(`UPDATE surveys SET status='active', closed_at=NULL, closed_by=NULL, due=$2, remind_sent='{}' WHERE id=$1`, [s.id, due]);
  res.json({ ok: true, due });
}));
surveysRouter.post("/:id/remind", h(async (req, res) => {
  adminOnly(req);
  const s = await one(idOf(req)); if (!s || s.status !== "active") throw new HttpError(409, "Нагадувати можна лише в активному.");
  const raw = req.body?.userIds;
  const ids = Array.isArray(raw) ? raw.map(Number).filter((x: number) => Number.isInteger(x) && x > 0) : null;
  const t = await pool.query<{ user_id: number }>(`SELECT user_id FROM survey_assignments WHERE survey_id=$1 AND responded_at IS NULL ${ids ? "AND user_id = ANY($2::int[])" : ""}`,
    ids ? [s.id, ids] : [s.id]);
  for (const row of t.rows) await notify(pool, row.user_id, s.id, "reminder", `Нагадування: «${s.title}» чекає на вашу відповідь до ${fmtDue(s.due)}`);
  await pool.query(`UPDATE survey_assignments SET reminded_at=now() WHERE survey_id=$1 AND responded_at IS NULL ${ids ? "AND user_id = ANY($2::int[])" : ""}`, ids ? [s.id, ids] : [s.id]);
  res.json({ sent: t.rows.length });
}));

/* ── Відповісти ── */
surveysRouter.post("/:id/respond", h(async (req, res) => {
  const s = await one(idOf(req)); if (!s) throw new HttpError(404, "Немає.");
  if (s.status !== "active") throw new HttpError(409, "Опитування вже закрите.");
  const a = await pool.query<{ responded_at: string | null }>(`SELECT responded_at FROM survey_assignments WHERE survey_id=$1 AND user_id=$2`, [s.id, me(req)]);
  if (!a.rows[0]) throw new HttpError(403, "Це опитування вам не адресоване.");
  const already = !!a.rows[0].responded_at;
  if (already && (s.anon || !s.allow_edit)) throw new HttpError(409, s.anon ? "В анонімному опитуванні відповідь змінити неможливо." : "Зміна відповіді в цьому опитуванні вимкнена.");
  const qs = await loadQuestions(pool, s.id);
  const answers = (req.body?.answers || {}) as Record<string, unknown>;
  const missing = qs.find((q) => q.required && !hasValue(q, answers[String(q.id)]));
  if (missing) throw new HttpError(422, "Відповідайте, будь ласка, на всі обов’язкові питання.", { questionId: missing.id });
  const who = await person(pool, me(req));
  // 🔒 Анонімне: жодного user_id і час — лише ДЕНЬ (див. шапку, п.3). Іменне — точний час.
  const at = s.anon ? "date_trunc('day', now())" : "now()";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let rid: number;
    if (already && !s.anon) {
      const ex = await client.query<{ id: number }>(`SELECT id FROM survey_responses WHERE survey_id=$1 AND user_id=$2`, [s.id, me(req)]);
      rid = ex.rows[0].id;
      await client.query(`UPDATE survey_responses SET updated_at=now() WHERE id=$1`, [rid]);
      await client.query(`DELETE FROM survey_answers WHERE response_id=$1`, [rid]);
    } else {
      const ins = await client.query<{ id: number }>(`INSERT INTO survey_responses (survey_id, user_id, role, team, submitted_at, updated_at)
          VALUES ($1,$2,$3,$4, ${at}, ${at}) RETURNING id`,
        [s.id, s.anon ? null : me(req), who?.role ?? null, who?.team ?? null]);
      rid = ins.rows[0].id;
    }
    for (const q of qs) {
      const v = answers[String(q.id)];
      if (hasValue(q, v)) await client.query(`INSERT INTO survey_answers (response_id, question_id, value) VALUES ($1,$2,$3)`, [rid, q.id, JSON.stringify(v)]);
    }
    await client.query(`UPDATE survey_assignments SET responded_at=${at} WHERE survey_id=$1 AND user_id=$2`, [s.id, me(req)]);
    await client.query(`UPDATE survey_notifications SET read_at=coalesce(read_at, now()) WHERE survey_id=$1 AND user_id=$2`, [s.id, me(req)]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; } finally { client.release(); }
  res.json({ ok: true });
}));

/* ── Результати (адмін): агрегації + розріз + тренд + участь ── */
surveysRouter.get("/:id/results", h(async (req, res) => {
  adminOnly(req);
  const s = await one(idOf(req)); if (!s) throw new HttpError(404, "Немає.");
  const qs = await loadQuestions(pool, s.id);
  const all = await loadResponses(pool, s.id);
  const slice = String(req.query.slice || "all");
  const inSlice = (x: ResponseRow) => slice === "all" || (slice === "managers" && x.role === "manager") || (slice === "leads" && x.role === "lead")
    || (slice.startsWith("team:") && x.team === slice.slice(5));
  const rs = all.filter(inSlice);
  if (s.anon && slice !== "all" && rs.length < MIN_SLICE) throw new HttpError(403, `Анонімне опитування: розріз показується лише для груп від ${MIN_SLICE} відповідей.`);
  const asg = await pool.query<{ user_id: number; responded_at: string | null; name: string | null }>(
    `SELECT a.user_id, a.responded_at, n.name FROM survey_assignments a LEFT JOIN (${NAME_SQL}) n ON n.id = a.user_id
      WHERE a.survey_id=$1 ORDER BY n.name`, [s.id]);
  const enpsQ = qs.find((q) => q.type === "enps");
  const ser = await pool.query<any>(`SELECT ${SURVEY_COLS} FROM surveys WHERE series_id=$1 AND status IN ('active','closed') ORDER BY issue`, [s.series_id]);
  const issues = [];
  for (const it of ser.rows) {
    const cnt = await pool.query<{ n: number; r: number }>(`SELECT count(*)::int AS n, count(responded_at)::int AS r FROM survey_assignments WHERE survey_id=$1`, [it.id]);
    issues.push({ issue: it.issue, status: it.status, closedAt: it.closed_at, assignedCount: cnt.rows[0].n, respondedCount: cnt.rows[0].r,
      questions: await loadQuestions(pool, it.id), responses: await loadResponses(pool, it.id) });
  }
  const teams = [...new Set(all.map((x) => x.team).filter((x): x is string => !!x))];
  res.json({
    survey: { ...s, questions: qs },
    slice, n: rs.length, teams,
    results: qs.map((q) => ({ questionId: q.id, ...aggregateQuestion(q, rs) })),
    enps: enpsQ ? enpsOf(rs.map((x) => x.answers[String(enpsQ.id)]).filter((v): v is number => typeof v === "number")) : null,
    participation: {
      assigned: asg.rows.length, responded: asg.rows.filter((x) => x.responded_at).length,
      // в анонімному — лише хто НЕ відповів (для нагадувань); хто відповів — тільки кількість
      respondedList: s.anon ? [] : asg.rows.filter((x) => x.responded_at).map((x) => ({ id: x.user_id, name: x.name, at: x.responded_at })),
      notResponded: asg.rows.filter((x) => !x.responded_at).map((x) => ({ id: x.user_id, name: x.name })),
    },
    trend: issues.length >= 2 ? trend(qs, issues) : null,
  });
}));

/* ── Експорт CSV ── */
surveysRouter.get("/:id/export.csv", h(async (req, res) => {
  adminOnly(req);
  const s = await one(idOf(req)); if (!s) throw new HttpError(404, "Немає.");
  const qs = await loadQuestions(pool, s.id); const rs = await loadResponses(pool, s.id);
  const names = new Map((await pool.query<{ id: number; name: string }>(NAME_SQL)).rows.map((u) => [String(u.id), u.name]));
  const csv = csvFor(s.anon, qs, rs, (id) => names.get(id || "") || "", (x) => ROLE_LBL[x || ""] || x || "", (iso) => fmtDue(iso));
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="survey-${s.id}.csv"` }).send("﻿" + csv);
}));
